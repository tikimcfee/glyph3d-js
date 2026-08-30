# gpu_pipeline.mojo — the WHOLE scan on device, and the composition claim.
#
# decode, chunkReduce, paginate and bounds are each proven in isolation against the
# CPU port. That is not the same as proving they COMPOSE: every one of them was
# handed CPU-computed inputs. Nothing yet showed that six dispatches, each feeding
# the next on device with no host round-trip, produce the pipeline's answers.
#
# This runs the full raking scan on the GPU —
#
#   decode -> chunkReduce -> spineReduce -> spineScan -> partialScan -> apply
#          -> resolveX -> paginate
#
# — with every intermediate staying in device memory, and compares the FINAL lanes
# against the CPU scan under the same tiered contract conformance_scan uses:
#   ROW / COL / ORD / ordToByte   exact (they are counts; nothing may round)
#   LINE_ADV                      eps    (foldless f64 prefix vs the scan's grouping)
#
# The monoid lives in one place (`E` + `combine` below) and every dispatch calls it,
# so the six kernels cannot drift from each other the way six transcriptions would.
#
# Run: mojo run -I engine engine/gpu_pipeline.mojo engine/fixtures/*.pipe.bin

from std.sys import argv, has_accelerator
from std.time import perf_counter_ns
from std.gpu import global_idx
from std.atomic import Atomic
from std.memory import bitcast
from max.gpu.host import DeviceContext
from glyph_schema import (
    SM_STRIDE, SM_ADVANCE, SM_HEIGHT,
    LM_STRIDE, LM_X, LM_Y, LM_Z, LM_BASE_X, LM_LINE_ADV,
    LC_STRIDE, LC_ROW, LC_COL, LC_ORD,
    ITEM_STRIDE, I_ORIGIN_X, I_ORIGIN_Y, I_ORIGIN_Z, I_WRAP_WIDTH, I_LINE_HEIGHT,
    I_PAGE_COLS, I_HAS_PAGE, I_Z_STEP, I_PAGE_ROWS, I_SCROLL_ROWS, I_PAGES_WIDE,
    I_BAND_STRIDE_Y, I_DEPTH_PER_BAND, I_DEPTH_PER_COL,
    I_PAGE_STRIDE_X,
    PARTIAL_COUNT_STRIDE, PARTIAL_MEASURE_STRIDE,
    P_RESET, P_NL, P_GLYPHS, P_ROWS, P_HEAD_LEN, P_TAIL_LEN, P_WRAP, PM_TAIL_ADV,
)
from glyph_pipeline import (
    F_LEADER, F_NEWLINE, trunc_nonneg, item_for_byte, derive_stride,
)


def trunc_nn32(v: Float32) -> Int:
    if v != v or v <= 0:
        return 0
    return Int(v)


def key_to_float(k: UInt32) -> Float32:
    var b: UInt32
    if (k & 0x80000000) != 0:
        b = k & 0x7FFFFFFF
    else:
        b = ~k
    return bitcast[DType.float32](b)


def ordered_key(v: Float32) -> UInt32:
    var b = UInt32(v.to_bits())
    if (b & 0x80000000) != 0:
        return ~b
    return b | 0x80000000
from glyph_scan import run_scan_pipeline
from fixture_io import load_pipe_fixture, PipeFixture
from glyph_pipeline import Item, Trie

comptime MAX_PRINTED = 8
comptime CHUNK = 64
comptime GROUP = 256
comptime EPS = 1e-4


struct E(Copyable, Movable):
    """The monoid element, device-side. Mirrors ScanElem lane for lane."""

    var reset: Int
    var nl: Int
    var glyphs: Int
    var rows: Int
    var head_len: Int
    var tail_len: Int
    var wrap: Int
    var tail_adv: Float32

    def __init__(out self):
        self.reset = 0
        self.nl = 0
        self.glyphs = 0
        self.rows = 0
        self.head_len = 0
        self.tail_len = 0
        self.wrap = 0
        self.tail_adv = 0


def rows_for(length: Int, wrap: Int) -> Int:
    """Mirror of rows_for_line. NOT the ceiling form — the newline rides at column
    `len`, so an exact-multiple line ends with a row holding only the newline. The
    first attempt here re-derived a ceiling and was off by one on exactly those
    lines, which is why transcribing beats deriving even for a two-line function."""
    if wrap <= 0:
        return 1
    return length // wrap + 1


def combine(mut a: E, b: E):
    """THE monoid — a mirror of scan_combine, line for line.

    Transcribe this from glyph_bake.mojo, do not re-derive it. The first attempt
    here was written to be "obviously right" for a LEAF b (one byte: rows == 0,
    head_len <= 1) and was wrong for a chunk-level b, which has a real head line
    and real rows. chunkReduce only ever combines leaves, so it passed in
    isolation; the spine combines chunks, so only composing them exposed it.
    """
    if b.reset != 0:
        a.reset = 1
        a.nl = b.nl
        a.glyphs = b.glyphs
        a.rows = b.rows
        a.head_len = b.head_len
        a.tail_len = b.tail_len
        a.tail_adv = b.tail_adv
        a.wrap = b.wrap
        return
    a.wrap = b.wrap
    if b.nl == 0:
        a.tail_len += b.tail_len
        a.tail_adv = a.tail_adv + b.tail_adv  # f32 per add — exact under regrouping
        if a.nl == 0:
            a.head_len = a.tail_len  # still one open line: head == tail
    else:
        if a.nl == 0:
            a.head_len += b.head_len  # a's open run extends b's head line
            a.rows = b.rows
        else:
            # The junction line: a's tail + b's head, closed by b's first newline.
            a.rows += rows_for(a.tail_len + b.head_len, b.wrap) + b.rows
        a.tail_len = b.tail_len
        a.tail_adv = b.tail_adv
    a.nl += b.nl
    a.glyphs += b.glyphs


def p_load(pc: MutPointer[UInt32, MutAnyOrigin], pm: MutPointer[Float32, MutAnyOrigin], i: Int) -> E:
    var e = E()
    var o = i * PARTIAL_COUNT_STRIDE
    e.reset = Int(pc[unsafe_offset = o + P_RESET])
    e.nl = Int(pc[unsafe_offset = o + P_NL])
    e.glyphs = Int(pc[unsafe_offset = o + P_GLYPHS])
    e.rows = Int(pc[unsafe_offset = o + P_ROWS])
    e.head_len = Int(pc[unsafe_offset = o + P_HEAD_LEN])
    e.tail_len = Int(pc[unsafe_offset = o + P_TAIL_LEN])
    e.wrap = Int(pc[unsafe_offset = o + P_WRAP])
    e.tail_adv = pm[unsafe_offset = i * PARTIAL_MEASURE_STRIDE + PM_TAIL_ADV]
    return e^


def p_store(pc: MutPointer[UInt32, MutAnyOrigin], pm: MutPointer[Float32, MutAnyOrigin], i: Int, e: E):
    var o = i * PARTIAL_COUNT_STRIDE
    pc[unsafe_offset = o + P_RESET] = UInt32(e.reset)
    pc[unsafe_offset = o + P_NL] = UInt32(e.nl)
    pc[unsafe_offset = o + P_GLYPHS] = UInt32(e.glyphs)
    pc[unsafe_offset = o + P_ROWS] = UInt32(e.rows)
    pc[unsafe_offset = o + P_HEAD_LEN] = UInt32(e.head_len)
    pc[unsafe_offset = o + P_TAIL_LEN] = UInt32(e.tail_len)
    pc[unsafe_offset = o + P_WRAP] = UInt32(e.wrap)
    pm[unsafe_offset = i * PARTIAL_MEASURE_STRIDE + PM_TAIL_ADV] = e.tail_adv


def leaf_of(
    fl: MutPointer[UInt32, MutAnyOrigin], sm: MutPointer[Float32, MutAnyOrigin],
    wrap_of: MutPointer[UInt32, MutAnyOrigin], is_start: MutPointer[UInt32, MutAnyOrigin],
    id: Int,
) -> E:
    var e = E()
    e.reset = Int(is_start[unsafe_offset=id])
    e.wrap = Int(wrap_of[unsafe_offset=id])
    var f = Int(fl[unsafe_offset=id])
    if (f & F_LEADER) == 0:
        return e^
    e.glyphs = 1
    if (f & F_NEWLINE) != 0:
        e.nl = 1
    else:
        e.head_len = 1
        e.tail_len = 1
        e.tail_adv = sm[unsafe_offset = id * SM_STRIDE + SM_ADVANCE]
    return e^


# ── dispatch 2: chunkReduce — thread per chunk ──────────────────────────────
def k_chunk_reduce(
    fl: MutPointer[UInt32, MutAnyOrigin], sm: MutPointer[Float32, MutAnyOrigin],
    wrap_of: MutPointer[UInt32, MutAnyOrigin], is_start: MutPointer[UInt32, MutAnyOrigin],
    pc: MutPointer[UInt32, MutAnyOrigin], pm: MutPointer[Float32, MutAnyOrigin],
    n_bytes: Int32, k: Int32, n_chunks: Int32,
):
    var c = global_idx.x
    if c >= Int(n_chunks):
        return
    var n = Int(n_bytes)
    # E() IS the identity: combine(identity, b) == b for reset and non-reset b
    # alike, which is why no first-element special case is needed here or below.
    var acc = E()
    var id = c * Int(k)
    var to = (c + 1) * Int(k)
    if to > n:
        to = n
    while id < to:
        combine(acc, leaf_of(fl, sm, wrap_of, is_start, id))
        id += 1
    p_store(pc, pm, c, acc)


# ── dispatch 3: spineReduce — thread per group ──────────────────────────────
def k_spine_reduce(
    pc: MutPointer[UInt32, MutAnyOrigin], pm: MutPointer[Float32, MutAnyOrigin],
    uc: MutPointer[UInt32, MutAnyOrigin], um: MutPointer[Float32, MutAnyOrigin],
    n_chunks: Int32, g: Int32, n_supers: Int32,
):
    var sg = global_idx.x
    if sg >= Int(n_supers):
        return
    var acc = E()
    var c = sg * Int(g)
    var last = (sg + 1) * Int(g)
    if last > Int(n_chunks):
        last = Int(n_chunks)
    while c < last:
        combine(acc, p_load(pc, pm, c))
        c += 1
    p_store(uc, um, sg, acc)


# ── dispatch 4: spineScan — ONE thread, exclusive scan of the supers ────────
def k_spine_scan(
    uc: MutPointer[UInt32, MutAnyOrigin], um: MutPointer[Float32, MutAnyOrigin],
    fc: MutPointer[UInt32, MutAnyOrigin], fm: MutPointer[Float32, MutAnyOrigin],
    n_supers: Int32,
):
    if global_idx.x != 0:
        return
    var acc = E()
    for sg in range(Int(n_supers)):
        p_store(fc, fm, sg, acc)          # exclusive: store BEFORE combining
        combine(acc, p_load(uc, um, sg))


# ── dispatch 5: partialScan — thread per group ──────────────────────────────
def k_partial_scan(
    pc: MutPointer[UInt32, MutAnyOrigin], pm: MutPointer[Float32, MutAnyOrigin],
    fc: MutPointer[UInt32, MutAnyOrigin], fm: MutPointer[Float32, MutAnyOrigin],
    xc: MutPointer[UInt32, MutAnyOrigin], xm: MutPointer[Float32, MutAnyOrigin],
    n_chunks: Int32, g: Int32, n_supers: Int32,
):
    var sg = global_idx.x
    if sg >= Int(n_supers):
        return
    var acc = p_load(fc, fm, sg)
    var c = sg * Int(g)
    var last = (sg + 1) * Int(g)
    if last > Int(n_chunks):
        last = Int(n_chunks)
    while c < last:
        p_store(xc, xm, c, acc)          # exclusive: store BEFORE combining
        combine(acc, p_load(pc, pm, c))
        c += 1


# ── dispatch 6: apply — thread per chunk, re-fold and write the lanes ───────
def k_apply(
    fl: MutPointer[UInt32, MutAnyOrigin], sm: MutPointer[Float32, MutAnyOrigin],
    lm: MutPointer[Float32, MutAnyOrigin], lc: MutPointer[UInt32, MutAnyOrigin],
    wrap_of: MutPointer[UInt32, MutAnyOrigin], is_start: MutPointer[UInt32, MutAnyOrigin],
    item_start: MutPointer[UInt32, MutAnyOrigin],
    xc: MutPointer[UInt32, MutAnyOrigin], xm: MutPointer[Float32, MutAnyOrigin],
    otb: MutPointer[UInt32, MutAnyOrigin],
    n_bytes: Int32, k: Int32, n_chunks: Int32,
):
    var c = global_idx.x
    if c >= Int(n_chunks):
        return
    var n = Int(n_bytes)
    var id = c * Int(k)
    var to = (c + 1) * Int(k)
    if to > n:
        to = n
    if id >= to:
        return
    var run = p_load(xc, xm, c)
    while id < to:
        if Int(is_start[unsafe_offset=id]) != 0:
            run = E()
            run.wrap = Int(wrap_of[unsafe_offset=id])
        var f = Int(fl[unsafe_offset=id])
        if (f & F_LEADER) != 0:
            # lanes_from_prefix, inline
            var wrap = Int(wrap_of[unsafe_offset=id])
            var col = run.tail_len
            var closed = 0
            if run.nl > 0:
                closed = rows_for(run.head_len, wrap) + run.rows
            var wrap_row = (col // wrap) if wrap > 0 else 0
            var co = id * LC_STRIDE
            lc[unsafe_offset = co + LC_ROW] = UInt32(closed + wrap_row)
            lc[unsafe_offset = co + LC_COL] = UInt32(col)
            lc[unsafe_offset = co + LC_ORD] = UInt32(run.glyphs)
            lm[unsafe_offset = id * LM_STRIDE + LM_LINE_ADV] = run.tail_adv
            otb[unsafe_offset = Int(item_start[unsafe_offset=id]) + run.glyphs] = UInt32(id)
        combine(run, leaf_of(fl, sm, wrap_of, is_start, id))
        id += 1


# ── dispatch 7: resolveX — thread per byte ─────────────────────────────────
def k_resolve_x(
    sm: MutPointer[Float32, MutAnyOrigin], fl: MutPointer[UInt32, MutAnyOrigin],
    lm: MutPointer[Float32, MutAnyOrigin], lc: MutPointer[UInt32, MutAnyOrigin],
    items: MutPointer[Float32, MutAnyOrigin], item_of: MutPointer[UInt32, MutAnyOrigin],
    item_start: MutPointer[UInt32, MutAnyOrigin], otb: MutPointer[UInt32, MutAnyOrigin],
    row_max: MutPointer[UInt32, MutAnyOrigin], x_max: MutPointer[UInt32, MutAnyOrigin],
    n_bytes: Int32,
):
    """Resolve x from the EXACT lanes and place the unpaginated position.

    With a fold unit, x re-sums the glyph's `col % fold` same-row predecessors
    FORWARD from the segment start — the same f32 order the serial segAdv
    accumulates, which is why fold>0 x is bit-identical across oracle, scan and
    hardware. Foldless, x IS the f32 LINE_ADV lane.

    The two fold scalars go to atomics BY KIND, as in gpu_bounds: the row count to
    a native u32 atomicMax, the widest extent through the ordered key."""
    var id = global_idx.x
    if id >= Int(n_bytes):
        return
    if (Int(fl[unsafe_offset=id]) & F_LEADER) == 0:
        return
    var mo = id * LM_STRIDE
    var it = Int(item_of[unsafe_offset=id])
    var io = it * ITEM_STRIDE

    var wrap = trunc_nn32(items[unsafe_offset = io + I_WRAP_WIDTH])
    var fold = wrap
    if fold == 0 and items[unsafe_offset = io + I_HAS_PAGE] > 0.5:
        fold = trunc_nn32(items[unsafe_offset = io + I_PAGE_COLS])
    var col = Int(lc[unsafe_offset = id * LC_STRIDE + LC_COL])
    var ord = Int(lc[unsafe_offset = id * LC_STRIDE + LC_ORD])

    var x = Float32(0)
    if fold > 0:
        var k = col % fold
        while k >= 1:
            var q = Int(otb[unsafe_offset = Int(item_start[unsafe_offset=id]) + ord - k])
            x = x + sm[unsafe_offset = q * SM_STRIDE + SM_ADVANCE]
            k -= 1
    else:
        x = lm[unsafe_offset = mo + LM_LINE_ADV]

    var row = Int(lc[unsafe_offset = id * LC_STRIDE + LC_ROW])
    var wrap_row = (col // wrap) if wrap > 0 else 0
    # lineHeight is the ITEM's, never the glyph's — the SIXTH copy of the
    # deleted fallback died here. It survived five sweeps because it is spelled
    # `lh != lh` with I_LINE_HEIGHT, matching none of the greps that found the
    # others (lh_unset, is_nan(item.line_height), I_PAGE_LINE_HEIGHT). Found by
    # the split refactor forcing every lane site to be read, not by search.
    var lh = items[unsafe_offset = io + I_LINE_HEIGHT]

    var ox = items[unsafe_offset = io + I_ORIGIN_X]
    lm[unsafe_offset = mo + LM_BASE_X] = x + ox
    lm[unsafe_offset = mo + LM_X] = x + ox
    lm[unsafe_offset = mo + LM_Y] = (
        Float32(-row) * lh + items[unsafe_offset = io + I_ORIGIN_Y]
    )
    lm[unsafe_offset = mo + LM_Z] = (
        Float32(-wrap_row) * items[unsafe_offset = io + I_Z_STEP]
        + items[unsafe_offset = io + I_ORIGIN_Z]
    )

    _ = Atomic.max(row_max + it, UInt32(row + 1))     # a COUNT: native u32
    _ = Atomic.max(x_max + it, ordered_key(x))        # a MEASURE: ordered key


# ── dispatch 8: paginate — thread per byte, pure per-slot remap ────────────
def k_paginate(
    lm: MutPointer[Float32, MutAnyOrigin], fl: MutPointer[UInt32, MutAnyOrigin],
    lc: MutPointer[UInt32, MutAnyOrigin],
    items: MutPointer[Float32, MutAnyOrigin], item_of: MutPointer[UInt32, MutAnyOrigin],
    strides: MutPointer[Float32, MutAnyOrigin], n_bytes: Int32,
):
    var id = global_idx.x
    if id >= Int(n_bytes):
        return
    if (Int(fl[unsafe_offset=id]) & F_LEADER) == 0:
        return
    var it = Int(item_of[unsafe_offset=id])
    var io = it * ITEM_STRIDE
    var has_page = items[unsafe_offset = io + I_HAS_PAGE] > 0.5
    var rows = trunc_nn32(items[unsafe_offset = io + I_PAGE_ROWS]) if has_page else 0
    var cols = trunc_nn32(items[unsafe_offset = io + I_PAGE_COLS]) if has_page else 0
    var scroll = trunc_nn32(items[unsafe_offset = io + I_SCROLL_ROWS]) if has_page else 0
    if rows == 0 and cols == 0 and scroll == 0:
        return
    var row = Int(lc[unsafe_offset = id * LC_STRIDE + LC_ROW])
    var col = Int(lc[unsafe_offset = id * LC_STRIDE + LC_COL])
    var screen_row = row - scroll
    var y_page = 0
    if rows > 0 and screen_row >= rows:
        y_page = screen_row // rows
    var x_page = 0
    if cols > 0:
        x_page = col // cols
    var wide_raw = trunc_nn32(items[unsafe_offset = io + I_PAGES_WIDE])
    var wide = wide_raw if wide_raw > 1 else 1
    var band = y_page // wide
    var wrap = trunc_nn32(items[unsafe_offset = io + I_WRAP_WIDTH])
    var seg = (col // wrap) if wrap > 0 else 0
    # The page's own lineHeight is NOT consulted — mirrors 4697e3b. The fallback
    # could only fire on an item with a NaN lineHeight, which the oracle now
    # refuses, so it was reachable solely through malformed input. Proven, not
    # argued: poisoning this branch left all twelve suites green, while poisoning
    # the TAKEN read below failed both GPU suites — so they do exercise this line.
    var lh = items[unsafe_offset = io + I_LINE_HEIGHT]
    var mo = id * LM_STRIDE
    lm[unsafe_offset = mo + LM_X] = (
        lm[unsafe_offset = mo + LM_BASE_X]
        + Float32(y_page % wide) * strides[unsafe_offset=it]
    )
    lm[unsafe_offset = mo + LM_Y] = (
        items[unsafe_offset = io + I_ORIGIN_Y]
        - Float32(screen_row - y_page * rows) * lh
        - Float32(band) * items[unsafe_offset = io + I_BAND_STRIDE_Y]
    )
    lm[unsafe_offset = mo + LM_Z] = (
        items[unsafe_offset = io + I_ORIGIN_Z]
        - Float32(seg) * items[unsafe_offset = io + I_Z_STEP]
        + Float32(band) * items[unsafe_offset = io + I_DEPTH_PER_BAND]
        + Float32(x_page) * items[unsafe_offset = io + I_DEPTH_PER_COL]
    )


def rel_close(a: Float64, b: Float64) -> Bool:
    var d = a - b
    if d < 0:
        d = -d
    var m = a if a > 0 else -a
    var mb = b if b > 0 else -b
    if mb > m:
        m = mb
    if m < 1.0:
        m = 1.0
    return d / m <= EPS


def check_case(path: String, ctx: DeviceContext) raises -> Int:
    return check_fixture(load_pipe_fixture(path), ctx)


def check_fixture(var fx: PipeFixture, ctx: DeviceContext, bench: Bool = False) raises -> Int:
    var n = fx.byte_len
    if n == 0:
        return 0
    var n_chunks = (n + CHUNK - 1) // CHUNK
    var n_supers = (n_chunks + GROUP - 1) // GROUP

    # The CPU scan is the reference — itself already proven against the oracle.
    var t0 = perf_counter_ns()
    var cpu = run_scan_pipeline(fx.bytes, fx.trie, fx.items, CHUNK, GROUP)
    var cpu_ns = perf_counter_ns() - t0

    # Per-byte item facts, as the GPU pipeline gets them from itemStarts.
    var wrap_of = List[UInt32](unsafe_uninit_length=n)
    var is_start = List[UInt32](unsafe_uninit_length=n)
    var item_start = List[UInt32](unsafe_uninit_length=n)
    var item_of = List[UInt32](unsafe_uninit_length=n)
    for id in range(n):
        var i = item_for_byte(fx.items, id)
        item_of[id] = UInt32(i) if i >= 0 else UInt32(0)
        wrap_of[id] = UInt32(trunc_nonneg(fx.items[i].wrap_width)) if i >= 0 else 0
        is_start[id] = UInt32(1) if (i >= 0 and fx.items[i].byte_start == id) else UInt32(0)
        item_start[id] = UInt32(fx.items[i].byte_start) if i >= 0 else UInt32(0)

    # ── upload the DECODED lanes (decode itself is proven in gpu_decode) ─────
    var h_fl = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_sm = ctx.enqueue_create_host_buffer[DType.float32](n * SM_STRIDE)
    var h_lm = ctx.enqueue_create_host_buffer[DType.float32](n * LM_STRIDE)
    var h_lc = ctx.enqueue_create_host_buffer[DType.uint32](n * LC_STRIDE)
    var h_w = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_s = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_is = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_otb = ctx.enqueue_create_host_buffer[DType.uint32](n)
    ctx.synchronize()
    # Only the DECODE lanes are seeded; ROW/COL/ORD/LINE_ADV are what the device
    # must produce, so they start zeroed and cannot be accidentally "verified"
    # against values that were handed to it.
    for id in range(n):
        h_fl[id] = cpu.fl[id]
    for i in range(n * SM_STRIDE):
        h_sm[i] = cpu.sm[i]
    for i in range(n * LM_STRIDE):
        h_lm[i] = 0
    for i in range(n * LC_STRIDE):
        h_lc[i] = 0
    for i in range(n):
        h_w[i] = wrap_of[i]
        h_s[i] = is_start[i]
        h_is[i] = item_start[i]
        h_otb[i] = 0

    var ni0 = fx.item_count if fx.item_count > 0 else 1
    var h_it = ctx.enqueue_create_host_buffer[DType.float32](ni0 * ITEM_STRIDE)
    var h_io = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_rmax = ctx.enqueue_create_host_buffer[DType.uint32](ni0)
    var h_xmax = ctx.enqueue_create_host_buffer[DType.uint32](ni0)
    ctx.synchronize()
    for i in range(ni0 * ITEM_STRIDE):
        h_it[i] = 0
    for i in range(fx.item_count):
        var o = i * ITEM_STRIDE
        var t = fx.items[i].copy()
        h_it[o + I_ORIGIN_X] = Float32(t.origin_x)
        h_it[o + I_ORIGIN_Y] = Float32(t.origin_y)
        h_it[o + I_ORIGIN_Z] = Float32(t.origin_z)
        h_it[o + I_WRAP_WIDTH] = Float32(t.wrap_width)
        h_it[o + I_LINE_HEIGHT] = Float32(t.line_height)
        h_it[o + I_PAGE_COLS] = Float32(t.page_cols)
        h_it[o + I_Z_STEP] = Float32(t.z_step)
        h_it[o + I_PAGE_ROWS] = Float32(t.page_rows)
        h_it[o + I_SCROLL_ROWS] = Float32(t.scroll_rows)
        h_it[o + I_PAGES_WIDE] = Float32(t.pages_wide)
        h_it[o + I_BAND_STRIDE_Y] = Float32(t.band_stride_y)
        h_it[o + I_DEPTH_PER_BAND] = Float32(t.depth_per_band)
        h_it[o + I_DEPTH_PER_COL] = Float32(t.depth_per_col)
        h_it[o + I_HAS_PAGE] = 1 if t.has_page else 0
    for i in range(n):
        h_io[i] = item_of[i]
    for i in range(ni0):
        h_rmax[i] = 0
        h_xmax[i] = 0

    var d_fl = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_sm = ctx.enqueue_create_buffer[DType.float32](n * SM_STRIDE)
    var d_lm = ctx.enqueue_create_buffer[DType.float32](n * LM_STRIDE)
    var d_lc = ctx.enqueue_create_buffer[DType.uint32](n * LC_STRIDE)
    var d_w = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_s = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_is = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_otb = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_pc = ctx.enqueue_create_buffer[DType.uint32](n_chunks * PARTIAL_COUNT_STRIDE)
    var d_pm = ctx.enqueue_create_buffer[DType.float32](n_chunks * PARTIAL_MEASURE_STRIDE)
    var d_uc = ctx.enqueue_create_buffer[DType.uint32](n_supers * PARTIAL_COUNT_STRIDE)
    var d_um = ctx.enqueue_create_buffer[DType.float32](n_supers * PARTIAL_MEASURE_STRIDE)
    var d_fc = ctx.enqueue_create_buffer[DType.uint32](n_supers * PARTIAL_COUNT_STRIDE)
    var d_fm = ctx.enqueue_create_buffer[DType.float32](n_supers * PARTIAL_MEASURE_STRIDE)
    var d_xc = ctx.enqueue_create_buffer[DType.uint32](n_chunks * PARTIAL_COUNT_STRIDE)
    var d_xm = ctx.enqueue_create_buffer[DType.float32](n_chunks * PARTIAL_MEASURE_STRIDE)
    var ni = fx.item_count if fx.item_count > 0 else 1
    var d_it = ctx.enqueue_create_buffer[DType.float32](ni * ITEM_STRIDE)
    var d_io = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_rmax = ctx.enqueue_create_buffer[DType.uint32](ni)
    var d_xmax = ctx.enqueue_create_buffer[DType.uint32](ni)
    ctx.enqueue_copy(dst_buf=d_fl, src_buf=h_fl)
    ctx.enqueue_copy(dst_buf=d_sm, src_buf=h_sm)
    ctx.enqueue_copy(dst_buf=d_lm, src_buf=h_lm)
    ctx.enqueue_copy(dst_buf=d_lc, src_buf=h_lc)
    ctx.enqueue_copy(dst_buf=d_w, src_buf=h_w)
    ctx.enqueue_copy(dst_buf=d_s, src_buf=h_s)
    ctx.enqueue_copy(dst_buf=d_is, src_buf=h_is)
    ctx.enqueue_copy(dst_buf=d_otb, src_buf=h_otb)
    ctx.enqueue_copy(dst_buf=d_it, src_buf=h_it)
    ctx.enqueue_copy(dst_buf=d_io, src_buf=h_io)
    ctx.enqueue_copy(dst_buf=d_rmax, src_buf=h_rmax)
    ctx.enqueue_copy(dst_buf=d_xmax, src_buf=h_xmax)
    d_pc.enqueue_fill(0)
    d_uc.enqueue_fill(0)
    d_fc.enqueue_fill(0)
    d_xc.enqueue_fill(0)
    d_pm.enqueue_fill(0.0)
    d_um.enqueue_fill(0.0)
    d_fm.enqueue_fill(0.0)
    d_xm.enqueue_fill(0.0)

    # ── the chain. Every intermediate stays on device. ──────────────────────
    ctx.synchronize()
    var g0 = perf_counter_ns()
    comptime B = 128
    ctx.enqueue_function[k_chunk_reduce](
        d_fl.unsafe_ptr(), d_sm.unsafe_ptr(), d_w.unsafe_ptr(), d_s.unsafe_ptr(),
        d_pc.unsafe_ptr(), d_pm.unsafe_ptr(),
        Int32(n), Int32(CHUNK), Int32(n_chunks),
        grid_dim=(n_chunks + B - 1) // B, block_dim=B,
    )
    ctx.enqueue_function[k_spine_reduce](
        d_pc.unsafe_ptr(), d_pm.unsafe_ptr(), d_uc.unsafe_ptr(), d_um.unsafe_ptr(),
        Int32(n_chunks), Int32(GROUP), Int32(n_supers),
        grid_dim=(n_supers + B - 1) // B, block_dim=B,
    )
    ctx.enqueue_function[k_spine_scan](
        d_uc.unsafe_ptr(), d_um.unsafe_ptr(), d_fc.unsafe_ptr(), d_fm.unsafe_ptr(),
        Int32(n_supers), grid_dim=1, block_dim=1,
    )
    ctx.enqueue_function[k_partial_scan](
        d_pc.unsafe_ptr(), d_pm.unsafe_ptr(), d_fc.unsafe_ptr(), d_fm.unsafe_ptr(),
        d_xc.unsafe_ptr(), d_xm.unsafe_ptr(),
        Int32(n_chunks), Int32(GROUP), Int32(n_supers),
        grid_dim=(n_supers + B - 1) // B, block_dim=B,
    )
    ctx.enqueue_function[k_apply](
        d_fl.unsafe_ptr(), d_sm.unsafe_ptr(), d_lm.unsafe_ptr(), d_lc.unsafe_ptr(),
        d_w.unsafe_ptr(), d_s.unsafe_ptr(),
        d_is.unsafe_ptr(), d_xc.unsafe_ptr(), d_xm.unsafe_ptr(), d_otb.unsafe_ptr(),
        Int32(n), Int32(CHUNK), Int32(n_chunks),
        grid_dim=(n_chunks + B - 1) // B, block_dim=B,
    )
    ctx.enqueue_function[k_resolve_x](
        d_sm.unsafe_ptr(), d_fl.unsafe_ptr(), d_lm.unsafe_ptr(), d_lc.unsafe_ptr(),
        d_it.unsafe_ptr(), d_io.unsafe_ptr(),
        d_is.unsafe_ptr(), d_otb.unsafe_ptr(), d_rmax.unsafe_ptr(), d_xmax.unsafe_ptr(),
        Int32(n), grid_dim=(n + B - 1) // B, block_dim=B,
    )
    # The fan stride is DERIVED from each item's widest fold row — a fold scalar
    # resolveX just produced. The CPU driver computes it between dispatches too, so
    # this readback mirrors the reference rather than shortcutting it.
    var h_xr = ctx.enqueue_create_host_buffer[DType.uint32](ni0)
    var h_st = ctx.enqueue_create_host_buffer[DType.float32](ni0)
    ctx.enqueue_copy(dst_buf=h_xr, src_buf=d_xmax)
    ctx.synchronize()
    for i in range(fx.item_count):
        var widest = Float64(key_to_float(h_xr[i]))
        h_st[i] = Float32(derive_stride(widest, fx.items[i]))
    var d_st = ctx.enqueue_create_buffer[DType.float32](ni0)
    ctx.enqueue_copy(dst_buf=d_st, src_buf=h_st)
    ctx.enqueue_function[k_paginate](
        d_lm.unsafe_ptr(), d_fl.unsafe_ptr(), d_lc.unsafe_ptr(),
        d_it.unsafe_ptr(), d_io.unsafe_ptr(),
        d_st.unsafe_ptr(), Int32(n),
        grid_dim=(n + B - 1) // B, block_dim=B,
    )
    ctx.enqueue_copy(dst_buf=h_lc, src_buf=d_lc)
    ctx.enqueue_copy(dst_buf=h_lm, src_buf=d_lm)
    ctx.enqueue_copy(dst_buf=h_otb, src_buf=d_otb)
    ctx.enqueue_copy(dst_buf=h_rmax, src_buf=d_rmax)
    ctx.synchronize()
    var gpu_ns = perf_counter_ns() - g0
    if bench:
        var mb = Float64(n) / 1048576.0
        print(
            "  ", n, "B   cpu(sharded)", Float64(cpu_ns) / 1e6, "ms =",
            mb / (Float64(cpu_ns) / 1e9), "MB/s   |   gpu", Float64(gpu_ns) / 1e6,
            "ms =", mb / (Float64(gpu_ns) / 1e9), "MB/s   |   x",
            Float64(cpu_ns) / Float64(gpu_ns),
        )
        return 0

    # ── the tiered comparison ───────────────────────────────────────────────
    var bad = 0
    var printed = 0
    for id in range(n):
        var co = id * LC_STRIDE
        if (Int(cpu.fl[id]) & F_LEADER) == 0:
            continue
        # counts: EXACT. Nothing here is allowed to round.
        if h_lc[co + LC_ROW] != cpu.lc[co + LC_ROW]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  byte", id, "ROW gpu", h_lc[co + LC_ROW], "cpu", cpu.lc[co + LC_ROW])
                printed += 1
        if h_lc[co + LC_COL] != cpu.lc[co + LC_COL]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  byte", id, "COL gpu", h_lc[co + LC_COL], "cpu", cpu.lc[co + LC_COL])
                printed += 1
        if h_lc[co + LC_ORD] != cpu.lc[co + LC_ORD]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  byte", id, "ORD gpu", h_lc[co + LC_ORD], "cpu", cpu.lc[co + LC_ORD])
                printed += 1
        # LINE_ADV: eps (foldless f64 prefix vs the scan's f32 grouping).
        var g = Float64(h_lm[id * LM_STRIDE + LM_LINE_ADV])
        var e = Float64(cpu.lm[id * LM_STRIDE + LM_LINE_ADV])
        if not rel_close(g, e):
            bad += 1
            if printed < MAX_PRINTED:
                print("  byte", id, "LINE_ADV gpu", g, "cpu", e)
                printed += 1
        # resolveX's positions: eps, like paginate — f64 on CPU, f32 on device.
        for lane in range(3):
            var gp = Float64(h_lm[id * LM_STRIDE + LM_X + lane])
            var ep = Float64(cpu.lm[id * LM_STRIDE + LM_X + lane])
            if not rel_close(gp, ep):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  byte", id, "pos lane", lane, "gpu", gp, "cpu", ep)
                    printed += 1
    # the fold scalar that is a COUNT: exact.
    for i in range(fx.item_count):
        var want_rows = Int(cpu.item_bounds[i * 8 + 6])
        if Int(h_rmax[i]) != want_rows:
            bad += 1
            if printed < MAX_PRINTED:
                print("  item", i, "totalRows gpu", Int(h_rmax[i]), "cpu", want_rows)
                printed += 1
    for i in range(n):
        if h_otb[i] != cpu.ord_to_byte[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  ordToByte[", i, "] gpu", h_otb[i], "cpu", cpu.ord_to_byte[i])
                printed += 1
    return bad


def synthetic_case(trie: Trie, n: Int, wrap: Float64, line_len: Int, ctx: DeviceContext) raises -> Int:
    """A corpus large enough to reach the SPINE's multi-super path.

    Every checked-in fixture is under 6KB — 82 chunks, ONE super. With a single
    super the spine scan's exclusive/inclusive distinction is invisible (the
    absorbing reset at byte 0 discards the only prefix it affects) and a 33-byte
    fixture has one chunk, so no chunk-level combine happens at all. Both of those
    are exactly the paths that were wrong when this file was first written, and the
    fixtures could not have caught either. GROUP is 256, so > 16384 bytes is the
    threshold; this runs well past it."""
    var bytes = List[UInt8](unsafe_uninit_length=n)
    for i in range(n):
        bytes[i] = UInt8(10) if (i % line_len) == (line_len - 1) else UInt8(97 + (i % 26))
    var it = Item()
    it.byte_start = 0
    it.byte_count = n
    it.line_height = 1
    it.wrap_width = wrap
    var items = List[Item]()
    items.append(it^)
    var fx = PipeFixture()
    fx.byte_len = n
    fx.item_count = 1
    fx.bytes = bytes^
    fx.trie = trie.copy()
    fx.items = items^
    return check_fixture(fx^, ctx)


def bench_scaling(trie: Trie, path: String, ctx: DeviceContext) raises:
    """Time the SAME chain the conformance suite proves, across corpus sizes.

    The GPU timing spans the whole device phase — the dispatches AND the readbacks,
    including the host-side stride derivation between resolveX and paginate. Timing
    only the kernels would flatter the GPU by hiding the part a real caller pays."""
    var f = open(path, "r")
    var all_bytes = f.read_bytes()
    f.close()
    print("corpus:", path, "(", len(all_bytes), "bytes )")
    print("")
    var sizes = List[Int]()
    sizes.append(65536)
    sizes.append(262144)
    sizes.append(1048576)
    sizes.append(4194304)
    sizes.append(8388608)
    sizes.append(16777216)
    sizes.append(25165824)
    for si in range(len(sizes)):
        var nb = sizes[si]
        if nb > len(all_bytes):
            continue
        var bytes = List[UInt8](capacity=nb)
        for i in range(nb):
            bytes.append(all_bytes[i])
        var it = Item()
        it.byte_start = 0
        it.byte_count = nb
        it.line_height = 1
        var items = List[Item]()
        items.append(it^)
        var fx = PipeFixture()
        fx.byte_len = nb
        fx.item_count = 1
        fx.bytes = bytes^
        fx.trie = trie.copy()
        fx.items = items^
        _ = check_fixture(fx^, ctx, True)


def main() raises:
    comptime assert has_accelerator(), "gpu_pipeline requires a GPU"
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/gpu_pipeline.mojo <fixture.pipe.bin> ...")
        return
    var ctx = DeviceContext()
    print("device:", ctx.name())
    if String(args[1]) == "--bench":
        var seed = load_pipe_fixture(String(args[2]))
        bench_scaling(seed.trie, String(args[3]), ctx)
        return
    var total_bad = 0
    for i in range(1, len(args)):
        var path = String(args[i])
        var bad = check_case(path, ctx)
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "mismatches")
        total_bad += bad
    # The fixtures are all single-super. These reach the spine.
    var seed = load_pipe_fixture(String(args[1]))
    print("")
    print("multi-super cases (GROUP=256, so >16384 bytes crosses into 2+ supers):")
    var cases = List[Int]()
    cases.append(20000)
    cases.append(40000)
    cases.append(70000)
    for ci in range(len(cases)):
        var nb = cases[ci]
        var b1 = synthetic_case(seed.trie, nb, 0, 40, ctx)
        var b2 = synthetic_case(seed.trie, nb, 7, 23, ctx)
        var supers = ((nb + CHUNK - 1) // CHUNK + GROUP - 1) // GROUP
        print("  ", nb, "bytes,", supers, "supers — unwrapped", b1, "bad, wrapped", b2, "bad")
        total_bad += b1 + b2

    if total_bad == 0:
        print("gpu pipeline: eight dispatches chained on device — counts exact, positions within 1e-4")
    else:
        raise Error("gpu pipeline diverged")
