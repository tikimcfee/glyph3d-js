# gpu_paginate.mojo — pagination on device, and where the bit-exact tier ENDS.
#
# decode and chunkReduce are bit-exact on device. paginate cannot be, and the
# reason is structural rather than a shortfall:
#
#   The CPU kernel does its positional math in f64 — `origin_y - Float64(row) * lh`,
#   `Float64(y_page % wide) * page_stride_x`. It does that because the JS oracle
#   uses JS numbers, which ARE f64, and the port's job is to reproduce the oracle.
#   Metal has no double precision at all, so that arithmetic cannot run on an Apple
#   GPU in any form. The device must compute positions in f32.
#
# So this dispatch is an EPS-tier comparison, exactly like the foldless float lanes
# in conformance_scan — and for the same underlying reason, now confirmed as a
# hardware fact rather than a numerical preference.
#
# What stays exact, and this is the part worth noticing: every page DECISION is an
# integer gate on the count lanes — y_page, x_page, band, seg, screen_row are all
# integer arithmetic on ROW/COL. Only the final positions differ, and only in the
# last bits. The pagination never picks a different page on device; it places the
# same glyph on the same page a few ULP away.
#
# Run: mojo run -I engine engine/gpu_paginate.mojo engine/fixtures/*.pipe.bin

from std.sys import argv, has_accelerator
from std.gpu import global_idx
from max.gpu.host import DeviceContext
from glyph_schema import (
    LM_STRIDE, LM_X, LM_Y, LM_Z, LM_BASE_X, LC_STRIDE, LC_ROW, LC_COL,
    IM_STRIDE, IM_ORIGIN_Y, IM_ORIGIN_Z, IM_LINE_HEIGHT, IM_Z_STEP,
    IM_BAND_STRIDE_Y, IM_DEPTH_PER_BAND, IM_DEPTH_PER_COL, IM_PAGE_STRIDE_X,
    IE_STRIDE, IE_PAGE_ROWS, IE_PAGE_COLS, IE_SCROLL_ROWS,
    IE_PAGES_WIDE, IE_WRAP_WIDTH, IE_HAS_PAGE,
)
from glyph_pipeline import (
    run_pipeline, F_LEADER, trunc_nonneg, derive_stride, Item, Trie,
    item_for_byte, page_active,
)
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8
comptime EPS = 1e-4


comptime BINARY_SEARCH_STEPS = 32


def item_search(
    starts: MutPointer[UInt32, MutAnyOrigin], item_count: Int, id: Int
) -> Int:
    """Largest item whose byteStart <= id — the item resolution EVERY thread does.

    This is glyph_pipeline.item_for_byte, run per thread on device instead of
    precomputed per byte on the host. It is also glyphPipelineKernels'
    _buildItemSearch line for line: same (lo + hi + 1) >> 1, same branch, same
    bounded 32-step loop with an early break (a GPU wants a static trip count).

    NO OWNERSHIP CHECK IN THE SEARCH, deliberately — item_for_byte has none
    either. `lo` is returned even for a byte in a gap between items. Ownership is
    the APPLY stage's job: its gap guard (see _apply_shard, mirroring the TSL's)
    keeps gap bytes out of item state; here F_LEADER gates, and decode sets that
    for gap bytes too — which is fine, because a wrong-but-unused item read for a
    byte the comparison ignores changes nothing.

    Why this replaced a host-computed table: the old form staged one UInt32 PER
    SOURCE BYTE (4 B/byte, an N-element buffer) to answer a question that is a
    function of itemCount, not of n. The search buffer is now itemCount entries.
    It also means this suite exercises the search itself rather than assuming it.
    """
    var lo = 0
    var hi = item_count - 1
    for _ in range(BINARY_SEARCH_STEPS):
        if lo >= hi:
            break
        var mid = (lo + hi + 1) >> 1
        if Int(starts[unsafe_offset=mid]) <= id:
            lo = mid
        else:
            hi = mid - 1
    return lo


def paginate_kernel(
    lm: MutPointer[Float32, MutAnyOrigin],
    fl: MutPointer[UInt32, MutAnyOrigin],
    lc: MutPointer[UInt32, MutAnyOrigin],
    items: MutPointer[Float32, MutAnyOrigin],
    items_e: MutPointer[UInt32, MutAnyOrigin],
    item_starts: MutPointer[UInt32, MutAnyOrigin],
    n_bytes: Int32,
    item_count: Int32,
):
    """Thread per byte. Integer gates on the count lanes; f32 for positions only."""
    var id = global_idx.x
    if id >= Int(n_bytes):
        return
    if (Int(fl[unsafe_offset=id]) & F_LEADER) == 0:
        return
    var it = item_search(item_starts, Int(item_count), id)
    var io = it * IM_STRIDE
    var ie = it * IE_STRIDE
    # Exact page geometry reads NATIVE u32 since the kind correction — no
    # truncation, no float proxy for a boolean.
    var has_page = items_e[unsafe_offset = ie + IE_HAS_PAGE] != 0

    var rows = Int(items_e[unsafe_offset = ie + IE_PAGE_ROWS]) if has_page else 0
    var cols = Int(items_e[unsafe_offset = ie + IE_PAGE_COLS]) if has_page else 0
    var scroll = Int(items_e[unsafe_offset = ie + IE_SCROLL_ROWS]) if has_page else 0
    if rows == 0 and cols == 0 and scroll == 0:
        return

    # ── every page decision is an INTEGER gate on the count lanes ────────────
    var row = Int(lc[unsafe_offset = id * LC_STRIDE + LC_ROW])
    var col = Int(lc[unsafe_offset = id * LC_STRIDE + LC_COL])
    var screen_row = row - scroll
    var y_page = 0
    if rows > 0 and screen_row >= rows:
        y_page = screen_row // rows
    var x_page = 0
    if cols > 0:
        x_page = col // cols
    var wide_raw = Int(items_e[unsafe_offset = ie + IE_PAGES_WIDE])
    var wide = wide_raw if wide_raw > 1 else 1
    var band = y_page // wide
    var wrap = Int(items_e[unsafe_offset = ie + IE_WRAP_WIDTH])
    var seg = (col // wrap) if wrap > 0 else 0

    # The page's own lineHeight is NOT consulted — mirrors 4697e3b. The fallback
    # could only fire on an item with a NaN lineHeight, which the oracle now
    # refuses, so it was reachable solely through malformed input. Proven, not
    # argued: poisoning this branch left all twelve suites green, while poisoning
    # the TAKEN read below failed both GPU suites — so they do exercise this line.
    var lh = items[unsafe_offset = io + IM_LINE_HEIGHT]

    # ── only the POSITIONS are float, and only here ─────────────────────────
    var mo = id * LM_STRIDE
    lm[unsafe_offset = mo + LM_X] = (
        lm[unsafe_offset = mo + LM_BASE_X]
        + Float32(y_page % wide) * items[unsafe_offset = io + IM_PAGE_STRIDE_X]
    )
    lm[unsafe_offset = mo + LM_Y] = (
        items[unsafe_offset = io + IM_ORIGIN_Y]
        - Float32(screen_row - y_page * rows) * lh
        - Float32(band) * items[unsafe_offset = io + IM_BAND_STRIDE_Y]
    )
    lm[unsafe_offset = mo + LM_Z] = (
        items[unsafe_offset = io + IM_ORIGIN_Z]
        - Float32(seg) * items[unsafe_offset = io + IM_Z_STEP]
        + Float32(band) * items[unsafe_offset = io + IM_DEPTH_PER_BAND]
        + Float32(x_page) * items[unsafe_offset = io + IM_DEPTH_PER_COL]
    )


def rel_close(a: Float32, b: Float32) -> Bool:
    if a != a and b != b:
        return True  # NaN lanes agree
    var d = Float64(a) - Float64(b)
    if d < 0:
        d = -d
    var m = Float64(a) if a > 0 else -Float64(a)
    var mb = Float64(b) if b > 0 else -Float64(b)
    if mb > m:
        m = mb
    if m < 1.0:
        m = 1.0
    return d / m <= EPS


def check_case(path: String, ctx: DeviceContext) raises -> Int:
    var fx = load_pipe_fixture(path)
    return check_items(fx.bytes, fx.trie, fx.items, ctx)


def check_items(
    bytes: List[UInt8], trie: Trie, items: List[Item], ctx: DeviceContext
) raises -> Int:
    """Stage an arena and compare device paginate against the CPU port.

    Takes the item list rather than reading it off a fixture so a MULTI-ITEM
    topology can be built in code — the conformance_gaps pattern. Every
    .pipe.bin carries exactly one item, which is not enough to exercise
    item_search at all (see main)."""
    var n = len(bytes)
    if n == 0:
        return 0
    var whole = run_pipeline(bytes, trie, items)

    # THE DEVICE INPUT MUST NOT ALREADY CONTAIN THE ANSWER.
    #
    # This suite used to upload `whole.measures` — the POST-paginate CPU result —
    # run the kernel on it, and compare against `whole.measures`. paginate is
    # idempotent (X comes from BASE_X, never from X), so that looked fine and was
    # VACUOUS: replacing the kernel body with a bare `return` passed every
    # fixture. Found by mutation, not by reading.
    #
    # It also explains why `return 0` in item_search passed. Every byte then reads
    # item 0's params; item 0 of multi-item.pipe.bin is unpaged; every thread
    # early-returns; nothing is written; the vacuity absorbs it. The suite could
    # see "wrote the WRONG values" and never "wrote NOTHING".
    #
    # Re-running the CPU with pages disabled does NOT give the fold state, which
    # was the first attempt: page_cols is the FOLD UNIT when wrap is off, so
    # zeroing it changes col/row/segAdv and every position with them.
    #
    # So poison exactly the lanes the kernel is OBLIGED to write — X/Y/Z of every
    # leader byte owned by a page-active item — and leave every other byte's
    # values alone. A kernel that writes nothing leaves the sentinel where a
    # position belongs and the comparison fails. Ownership here comes from the CPU
    # reference (item_for_byte), which is input data rather than kernel output, so
    # this is not circular; the device search is separately checked against CPU
    # results by check_multi_item.
    var poisoned = List[Float32](unsafe_uninit_length = n * LM_STRIDE)
    for i in range(n * LM_STRIDE):
        poisoned[i] = whole.lm[i]
    var poison_n = 0
    for id in range(n):
        if (Int(whole.fl[id]) & F_LEADER) == 0:
            continue
        var owner = item_for_byte(items, id)
        if owner < 0 or owner >= len(items):
            continue
        if not page_active(items[owner]):
            continue
        var mo = id * LM_STRIDE
        poisoned[mo + LM_X] = 1.0e30
        poisoned[mo + LM_Y] = 1.0e30
        poisoned[mo + LM_Z] = 1.0e30
        poison_n += 1

    # Item table, narrowed f64 -> f32 at the device boundary (see the header).
    var ni = len(items) if len(items) > 0 else 1
    var tbl = List[Float32](unsafe_uninit_length=ni * IM_STRIDE)
    var tbe = List[UInt32](unsafe_uninit_length=ni * IE_STRIDE)
    for i in range(len(tbl)):
        tbl[i] = 0
    for i in range(len(items)):
        var o = i * IM_STRIDE
        var oe = i * IE_STRIDE
        var t = items[i].copy()
        tbl[o + IM_ORIGIN_Y] = Float32(t.origin_y)
        tbl[o + IM_ORIGIN_Z] = Float32(t.origin_z)
        tbe[oe + IE_PAGE_ROWS] = UInt32(t.page_rows)
        tbe[oe + IE_PAGE_COLS] = UInt32(t.page_cols)
        tbe[oe + IE_SCROLL_ROWS] = UInt32(t.scroll_rows)
        tbe[oe + IE_PAGES_WIDE] = UInt32(t.pages_wide)
        tbe[oe + IE_WRAP_WIDTH] = UInt32(t.wrap_width)
        tbl[o + IM_LINE_HEIGHT] = Float32(t.line_height)
        tbl[o + IM_Z_STEP] = Float32(t.z_step)
        tbl[o + IM_BAND_STRIDE_Y] = Float32(t.band_stride_y)
        tbl[o + IM_DEPTH_PER_BAND] = Float32(t.depth_per_band)
        tbl[o + IM_DEPTH_PER_COL] = Float32(t.depth_per_col)
        # The fan stride is DERIVED from the item's max row extent (a fold
        # scalar), which is why the JS side carries it in its own buffer rather
        # than as an item param. Computed on the host in f64 and narrowed, like
        # every other lane here.
        tbl[o + IM_PAGE_STRIDE_X] = Float32(derive_stride(whole.item_bounds[i * 8 + 7], t))
        tbe[oe + IE_HAS_PAGE] = UInt32(1) if t.has_page else UInt32(0)

    var starts = List[UInt32](unsafe_uninit_length=len(items) if len(items) > 0 else 1)
    for i in range(len(items)):
        starts[i] = UInt32(items[i].byte_start)

    var h_m = ctx.enqueue_create_host_buffer[DType.float32](n * LM_STRIDE)
    var h_f = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_c = ctx.enqueue_create_host_buffer[DType.uint32](n * LC_STRIDE)
    var h_t = ctx.enqueue_create_host_buffer[DType.float32](len(tbl))
    var h_te = ctx.enqueue_create_host_buffer[DType.uint32](len(tbe))
    var h_i = ctx.enqueue_create_host_buffer[DType.uint32](len(starts))
    ctx.synchronize()
    for i in range(n * LM_STRIDE):
        h_m[i] = poisoned[i]            # the answer is NOT in the input
    for i in range(n):
        h_f[i] = whole.fl[i]
    for i in range(n * LC_STRIDE):
        h_c[i] = whole.lc[i]
    for i in range(len(tbl)):
        h_t[i] = tbl[i]
    for i in range(len(tbe)):
        h_te[i] = tbe[i]
    for i in range(len(starts)):
        h_i[i] = starts[i]

    var d_m = ctx.enqueue_create_buffer[DType.float32](n * LM_STRIDE)
    var d_f = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_c = ctx.enqueue_create_buffer[DType.uint32](n * LC_STRIDE)
    var d_t = ctx.enqueue_create_buffer[DType.float32](len(tbl))
    var d_te = ctx.enqueue_create_buffer[DType.uint32](len(tbe))
    var d_i = ctx.enqueue_create_buffer[DType.uint32](len(starts))
    ctx.enqueue_copy(dst_buf=d_m, src_buf=h_m)
    ctx.enqueue_copy(dst_buf=d_f, src_buf=h_f)
    ctx.enqueue_copy(dst_buf=d_c, src_buf=h_c)
    ctx.enqueue_copy(dst_buf=d_t, src_buf=h_t)
    ctx.enqueue_copy(dst_buf=d_te, src_buf=h_te)
    ctx.enqueue_copy(dst_buf=d_i, src_buf=h_i)

    comptime BLOCK = 256
    ctx.enqueue_function[paginate_kernel](
        d_m.unsafe_ptr(), d_f.unsafe_ptr(), d_c.unsafe_ptr(),
        d_t.unsafe_ptr(), d_te.unsafe_ptr(), d_i.unsafe_ptr(),
        Int32(n), Int32(len(items)),
        grid_dim=(n + BLOCK - 1) // BLOCK, block_dim=BLOCK,
    )
    ctx.enqueue_copy(dst_buf=h_m, src_buf=d_m)
    ctx.synchronize()

    var bad = 0
    var printed = 0
    for id in range(n):
        if (Int(whole.fl[id]) & F_LEADER) == 0:
            continue
        var mo = id * LM_STRIDE
        for lane in range(3):  # X, Y, Z — the only lanes paginate writes
            var g = h_m[mo + LM_X + lane]
            var e = whole.lm[mo + LM_X + lane]
            if not rel_close(g, e):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  byte", id, "lane", LM_X + lane, "gpu", g, "cpu", e)
                    printed += 1
    return bad


def check_multi_item(path: String, ctx: DeviceContext) raises -> Int:
    """THE CASE THAT MAKES item_search MEAN ANYTHING.

    Every .pipe.bin fixture carries exactly ONE item. With item_count == 1 the
    search sets lo = hi = 0, breaks on step one, and returns 0 no matter what the
    body does — so `return 0` in place of the whole search passed this suite, and
    so did an off-by-one on the comparison. Both mutations were run; both passed.
    Item resolution had never been exercised anywhere in the four-layer contract:
    not here, not in gpu_pipeline/gpu_scan/gpu_bounds (same single-item staging),
    and not on the CPU, where run_pipeline iterates items instead of searching.

    So build the topology in code, the way conformance_gaps does. Five items
    tiling the arena with DISTINCT origins — distinct is the whole point, since a
    wrong item index has to move a position for the comparison to see it."""
    var fx = load_pipe_fixture(path)
    var n = len(fx.bytes)
    if n < 40:
        print("  multi-item  : fixture too small, skipped")
        return 0
    var k = 5
    var per = n // k
    var items = List[Item]()
    for i in range(k):
        var it = Item()
        it.byte_start = i * per
        it.byte_count = per if i < k - 1 else n - i * per
        it.line_height = 1
        # DISTINCT per item: if the search returns the wrong index, Y and Z move.
        it.origin_x = Float64(i) * 13.0
        it.origin_y = Float64(i) * 100.0
        it.origin_z = Float64(i) * 7.0
        it.has_page = True
        it.page_rows = 4
        it.page_cols = 8
        it.pages_wide = 2
        it.page_gap_x = 1
        it.z_step = 0.5
        items.append(it^)
    var bad = check_items(fx.bytes, fx.trie, items, ctx)
    print("  multi-item  :", k, "items over", n, "bytes,", bad, "defects")
    return bad


def main() raises:
    comptime assert has_accelerator(), "gpu_paginate requires a GPU"
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/gpu_paginate.mojo <fixture.pipe.bin> ...")
        return
    var ctx = DeviceContext()
    print("device:", ctx.name())
    var total_bad = 0
    total_bad += check_multi_item(String(args[1]), ctx)
    for i in range(1, len(args)):
        var path = String(args[i])
        var bad = check_case(path, ctx)
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "lanes past eps")
        total_bad += bad
    if total_bad == 0:
        print("gpu paginate: every page decision identical, positions within 1e-4")
    else:
        raise Error("gpu paginate diverged past the eps tier")
