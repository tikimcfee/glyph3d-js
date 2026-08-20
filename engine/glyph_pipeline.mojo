# glyph_pipeline.mojo — the byte-in glyph pipeline, ported to Mojo.
#
# The FOURTH layer of the pipeline contract (oracle → scan spec → TSL → this):
# a native transcription of glyphPipelineReference.js, the semantic oracle. It is
# required to reproduce the oracle's answers BIT-FOR-BIT — including its float
# discipline, which is the whole point of the exercise:
#
#   - slot lanes are f32: every store rounds once, round-to-nearest-even
#   - lineAdv accumulates in f64 (the truth layer's prefix), stored f32
#   - segAdv accumulates in f32 per add — the fold>0 x, bit-identical to the GPU's
#     forward re-sum (an f32 add IS round(exact sum), so Float32 + Float32 here
#     equals the oracle's Math.fround(f64 add of two f32-exact values))
#   - every discrete decision (rows, cols, pages, bands, segments) reads exact
#     integers, never a float position
#   - bounds boxes ride f64
#
# KERNELS TAKE POINTERS, DRIVERS SHARD THEM ACROSS CORES. The per-slot kernels
# (decode_and_resolve, resolve_x, paginate, bounds_reduce) are thread-shaped —
# `id` is the thread id, buffers are raw pointers, exactly the GPU's calling
# convention — and the drivers run them over TaskGroup shards. Every parallel
# reduction here is EXACT under regrouping: min/max merges and disjoint writes
# only; anything order-sensitive (the fold, miss order) stays serial. There is
# one code path — small inputs just get small shards.
#
# Mirrors (never diverge): packages/glyph3d-core/src/compute/glyphPipelineReference.js
#                          packages/glyph3d-core/src/compute/GlyphTrie.js (trie_lookup)

from std.math import inf
from std.memory import unsafe_memset_zero
from std.runtime.asyncrt import TaskGroup, parallelism_level

# ── Slot lanes (glyphPipelineReference.js) ──────────────────────────────────
comptime SLOT_STRIDE = 12
comptime S_GLYPH_ID = 0
comptime S_ADVANCE = 1
comptime S_HEIGHT = 2
comptime S_X = 3
comptime S_Y = 4
comptime S_Z = 5
comptime S_ROW = 6
comptime S_COL = 7
comptime S_FLAGS = 8
comptime S_BASE_X = 9
comptime S_LINE_ADV = 10
comptime S_ORD = 11

comptime F_LEADER = 1
comptime F_RENDERED = 2
comptime F_NEWLINE = 4
comptime F_MISSING = 8

comptime NEWLINE = 0x0A

# ── Trie (GlyphTrie.js) ─────────────────────────────────────────────────────
comptime BLOCK_SHIFT = 8
comptime BLOCK_MASK = 255
comptime ENTRY_STRIDE = 4
comptime LANE_GLYPH_ID = 0
comptime LANE_ADVANCE = 1
comptime LANE_HEIGHT = 2
comptime LANE_FLAGS = 3
comptime FLAG_MISSING = 1

comptime F64_INF = inf[DType.float64]()


struct Trie(Copyable, Movable):
    var block_index: List[UInt32]
    var blocks: List[Float32]

    def __init__(out self, var block_index: List[UInt32], var blocks: List[Float32]):
        self.block_index = block_index^
        self.blocks = blocks^


struct Item(Copyable, Movable):
    """One file in the arena: byte range + layout params. NaN line heights mean
    'unset' (the oracle's `??` fallback to the glyph's own height)."""
    var byte_start: Int
    var byte_count: Int
    var origin_x: Float64
    var origin_y: Float64
    var origin_z: Float64
    var wrap_width: Float64
    var z_step: Float64
    var line_height: Float64
    var has_page: Bool
    var page_rows: Float64
    var page_cols: Float64
    var scroll_rows: Float64
    var pages_wide: Float64
    var page_gap_x: Float64
    var band_stride_y: Float64
    var depth_per_band: Float64
    var depth_per_col: Float64
    var page_line_height: Float64

    def __init__(out self):
        self.byte_start = 0
        self.byte_count = 0
        self.origin_x = 0
        self.origin_y = 0
        self.origin_z = 0
        self.wrap_width = 0
        self.z_step = 0
        self.line_height = 0
        self.has_page = False
        self.page_rows = 0
        self.page_cols = 0
        self.scroll_rows = 0
        self.pages_wide = 0
        self.page_gap_x = 0
        self.band_stride_y = 0
        self.depth_per_band = 0
        self.depth_per_col = 0
        self.page_line_height = 0


struct PipelineResult(Copyable, Movable):
    var slots: List[Float32]
    var ord_to_byte: List[UInt32]
    var misses: List[UInt32]
    var leaders: Int
    var item_bounds: List[Float64]  # item_count × 8 lanes
    var batch_bounds: List[Float64]  # 8 lanes

    def __init__(out self):
        self.slots = List[Float32]()
        self.ord_to_byte = List[UInt32]()
        self.misses = List[UInt32]()
        self.leaders = 0
        self.item_bounds = List[Float64]()
        self.batch_bounds = List[Float64]()


def is_nan(v: Float64) -> Bool:
    return v != v


def trunc_nonneg(v: Float64) -> Int:
    """max(0, Math.trunc(v || 0)) — params arrive as f64, decisions are ints."""
    if is_nan(v) or v <= 0:
        return 0
    return Int(v)  # toward zero for non-negatives


def sequence_length(bytes: List[UInt8], i: Int) -> Int:
    """Bytes the sequence starting at `i` occupies — 0 for a continuation byte
    (or invalid), which is exactly the 'am I a leader' test."""
    if i < 0 or i >= len(bytes):
        return 0
    var b = Int(bytes[i])
    if (b & 0x80) == 0x00:
        return 1
    if (b & 0xE0) == 0xC0:
        return 2
    if (b & 0xF0) == 0xE0:
        return 3
    if (b & 0xF8) == 0xF0:
        return 4
    return 0


def byte_at(bytes: List[UInt8], i: Int) -> Int:
    """Byte at `i`, or 0 past the end — the shader's bounds-checked read."""
    if i >= 0 and i < len(bytes):
        return Int(bytes[i])
    return 0


def decode_codepoint_at(bytes: List[UInt8], id: Int, n: Int) -> Int:
    """Decode the codepoint whose sequence starts at `id` (caller established
    n = sequence_length > 0) — shared by decode, the miss rebuild, and the bake."""
    var b0 = Int(bytes[id])
    if n == 1:
        return b0  # ASCII fast path: no further loads
    var b1: Int
    var b2: Int
    var b3: Int
    if id + 3 < len(bytes):
        b1 = Int(bytes[id + 1])
        b2 = Int(bytes[id + 2])
        b3 = Int(bytes[id + 3])
    else:
        # Bounds-checked reads only near the buffer's end (reads 0 past it).
        b1 = byte_at(bytes, id + 1)
        b2 = byte_at(bytes, id + 2)
        b3 = byte_at(bytes, id + 3)
    if n == 2:
        return ((b0 & 0x1F) << 6) | (b1 & 0x3F)
    if n == 3:
        return ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F)
    return ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)


def trie_lookup_base(trie: Trie, cp: Int) -> Int:
    """The exact two-load sequence the shader runs; returns the entry's float base."""
    var block = Int(trie.block_index[cp >> BLOCK_SHIFT])
    return ((block << BLOCK_SHIFT) | (cp & BLOCK_MASK)) * ENTRY_STRIDE


def decode_and_resolve[so: Origin[mut=True]](
    bytes: List[UInt8],
    slots: Pointer[Float32, so],
    trie: Trie,
    id: Int,
):
    """KERNEL 1 — thread per byte: decode the codepoint, resolve through the trie.
    Misses are NOT collected here: F_MISSING rides the flags lane and the driver
    rebuilds the ordered miss list in one serial pass (the GPU's atomic append,
    made deterministic)."""
    if id >= len(bytes):
        return
    var b0 = Int(bytes[id])
    var n: Int
    if (b0 & 0x80) == 0x00:
        n = 1
    elif (b0 & 0xE0) == 0xC0:
        n = 2
    elif (b0 & 0xF0) == 0xE0:
        n = 3
    elif (b0 & 0xF8) == 0xF0:
        n = 4
    else:
        n = 0
    var o = id * SLOT_STRIDE
    if n == 0:
        # Non-leader: size zeroed EXPLICITLY (rewritten ranges held a real glyph).
        slots[unsafe_offset = o + S_ADVANCE] = 0
        slots[unsafe_offset = o + S_HEIGHT] = 0
        return

    var cp = decode_codepoint_at(bytes, id, n)
    var tb = trie_lookup_base(trie, cp)
    var missing = (Int(trie.blocks[tb + LANE_FLAGS]) & FLAG_MISSING) != 0
    slots[unsafe_offset = o + S_GLYPH_ID] = trie.blocks[tb + LANE_GLYPH_ID]
    slots[unsafe_offset = o + S_ADVANCE] = trie.blocks[tb + LANE_ADVANCE]
    slots[unsafe_offset = o + S_HEIGHT] = trie.blocks[tb + LANE_HEIGHT]
    var flags = F_LEADER
    if cp == NEWLINE:
        flags |= F_NEWLINE
    if missing:
        flags |= F_MISSING
    slots[unsafe_offset = o + S_FLAGS] = Float32(flags)


def item_for_byte(items: List[Item], id: Int) -> Int:
    """Which item owns byte `id`: largest item whose byteStart ≤ id (binary search)."""
    var lo = 0
    var hi = len(items) - 1
    while lo < hi:
        var mid = (lo + hi + 1) >> 1
        if items[mid].byte_start <= id:
            lo = mid
        else:
            hi = mid - 1
    return lo


def rows_for_line(length: Int, wrap: Int) -> Int:
    """Visual rows a line occupies under `wrap`; the newline rides at column `len`,
    so an exact-multiple line ends with a row holding only the newline."""
    if wrap <= 0:
        return 1
    return length // wrap + 1


def layout_item[so: Origin[mut=True], oo: Origin[mut=True], ko: Origin[mut=True]](
    slots: Pointer[Float32, so],
    item: Item,
    ord_to_byte: Pointer[UInt32, oo],
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
):
    """THE FOLD — one item, one forward pass, every lane (layoutItem in the oracle).
    Inherently serial per item (it IS the serial semantics); items run in parallel
    because their slot ranges, ordinal ranges, and scalar rows are disjoint.

    Float discipline, matched to the oracle exactly:
      lineAdv: f64 accumulation (stored f32 per slot) — the truth-layer prefix
      segAdv:  f32 accumulation per add — the fold>0 x, bit-identical to the GPU
      scalars: f64 reduce, fed the f64 x (NOT the rounded lane)
    """
    var wrap = trunc_nonneg(item.wrap_width)
    var fold: Int
    if wrap > 0:
        fold = wrap
    else:
        fold = trunc_nonneg(item.page_cols) if item.has_page else 0
    var ox = item.origin_x
    var oy = item.origin_y
    var oz = item.origin_z
    var z_step = item.z_step
    var lh_unset = is_nan(item.line_height)

    var base_row = 0
    var col = 0
    var line_adv: Float64 = 0
    var seg_adv: Float32 = 0
    var ord = 0
    var id = item.byte_start
    var stop = item.byte_start + item.byte_count
    while id < stop:
        var o = id * SLOT_STRIDE
        var flags = Int(slots[unsafe_offset = o + S_FLAGS])
        if (flags & F_LEADER) == 0:
            id += 1
            continue
        var advance = slots[unsafe_offset = o + S_ADVANCE]
        var wrap_row = (col // wrap) if wrap > 0 else 0
        var row = base_row + wrap_row
        var x: Float64 = Float64(seg_adv) if fold > 0 else line_adv
        var lh: Float64
        if lh_unset:
            lh = Float64(slots[unsafe_offset = o + S_HEIGHT])
        else:
            lh = item.line_height
        slots[unsafe_offset = o + S_ROW] = Float32(row)
        slots[unsafe_offset = o + S_COL] = Float32(col)
        slots[unsafe_offset = o + S_LINE_ADV] = Float32(line_adv)
        slots[unsafe_offset = o + S_ORD] = Float32(ord)
        slots[unsafe_offset = o + S_BASE_X] = Float32(x + ox)
        slots[unsafe_offset = o + S_X] = Float32(x + ox)
        slots[unsafe_offset = o + S_Y] = Float32(-Float64(row) * lh + oy)
        slots[unsafe_offset = o + S_Z] = Float32(-Float64(wrap_row) * z_step + oz)
        slots[unsafe_offset = o + S_FLAGS] = Float32(flags | F_RENDERED)
        ord_to_byte[unsafe_offset = item.byte_start + ord] = UInt32(id)
        if Float64(row + 1) > scalars[unsafe_offset = scalar_base + 6]:
            scalars[unsafe_offset = scalar_base + 6] = Float64(row + 1)
        if x > scalars[unsafe_offset = scalar_base + 7]:
            scalars[unsafe_offset = scalar_base + 7] = x  # widest row, ITEM-RELATIVE
        ord += 1
        if (flags & F_NEWLINE) != 0:
            base_row += rows_for_line(col, wrap)
            col = 0
            line_adv = 0
            seg_adv = 0
        else:
            col += 1
            line_adv += Float64(advance)
            if fold > 0 and col % fold == 0:
                seg_adv = 0
            else:
                seg_adv = seg_adv + advance
        id += 1


def resolve_x[so: Origin[mut=True], oo: Origin[mut=True], ko: Origin[mut=True]](
    slots: Pointer[Float32, so],
    id: Int,
    item: Item,
    ord_to_byte: Pointer[UInt32, oo],
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
):
    """KERNEL — RESOLVE X from the exact lanes and place the unpaginated position
    (resolveX in the oracle). With a fold unit, x re-sums the glyph's `col % fold`
    same-row predecessors FORWARD from the segment start — the same f32 order the
    serial segAdv accumulates, so fold>0 x is bit-identical across oracle, scan,
    and hardware. Foldless, x IS the line prefix (the f32 S_LINE_ADV lane — one
    rounding wider than the serial fold's f64 prefix, which is why foldless float
    lanes compare at eps, never bit-exact, between the two forms)."""
    var o = id * SLOT_STRIDE
    if (Int(slots[unsafe_offset = o + S_FLAGS]) & F_LEADER) == 0:
        return
    var wrap = trunc_nonneg(item.wrap_width)
    var fold: Int
    if wrap > 0:
        fold = wrap
    else:
        fold = trunc_nonneg(item.page_cols) if item.has_page else 0
    var col = Int(slots[unsafe_offset = o + S_COL])
    var ord = Int(slots[unsafe_offset = o + S_ORD])

    var x: Float64
    if fold > 0:
        var x32: Float32 = 0
        var k = col % fold
        while k >= 1:
            var q = Int(ord_to_byte[unsafe_offset = item.byte_start + ord - k])
            x32 = x32 + slots[unsafe_offset = q * SLOT_STRIDE + S_ADVANCE]
            k -= 1
        x = Float64(x32)
    else:
        x = Float64(slots[unsafe_offset = o + S_LINE_ADV])

    var row = Int(slots[unsafe_offset = o + S_ROW])
    var wrap_row = (col // wrap) if wrap > 0 else 0
    var lh: Float64
    if is_nan(item.line_height):  # NaN = unset: the glyph's own height
        lh = Float64(slots[unsafe_offset = o + S_HEIGHT])
    else:
        lh = item.line_height
    slots[unsafe_offset = o + S_BASE_X] = Float32(x + item.origin_x)
    slots[unsafe_offset = o + S_X] = Float32(x + item.origin_x)
    slots[unsafe_offset = o + S_Y] = Float32(-Float64(row) * lh + item.origin_y)
    slots[unsafe_offset = o + S_Z] = Float32(
        -Float64(wrap_row) * item.z_step + item.origin_z
    )

    if Float64(row + 1) > scalars[unsafe_offset = scalar_base + 6]:
        scalars[unsafe_offset = scalar_base + 6] = Float64(row + 1)
    if x > scalars[unsafe_offset = scalar_base + 7]:
        scalars[unsafe_offset = scalar_base + 7] = x


def derive_stride(max_row_extent: Float64, item: Item) -> Float64:
    """THE stride formula: a row-paged item fans page columns at
    (widest item-relative row + pageGapX); pageRows 0 derives 0."""
    if not item.has_page or trunc_nonneg(item.page_rows) <= 0:
        return 0
    return max_row_extent + item.page_gap_x


def page_active(item: Item) -> Bool:
    """Whether paginate does anything for this item — an all-zero page is an
    identity remap the kernel early-returns from, so the driver may skip it."""
    if not item.has_page:
        return False
    return (
        trunc_nonneg(item.page_rows) != 0
        or trunc_nonneg(item.page_cols) != 0
        or trunc_nonneg(item.scroll_rows) != 0
    )


def paginate[so: Origin[mut=True]](
    slots: Pointer[Float32, so],
    id: Int,
    item: Item,
    page_stride_x: Float64,
):
    """KERNEL — pagination as a PURE per-slot remap of the base position. Every
    page decision reads the INTEGER row/col lanes, never the float position."""
    var o = id * SLOT_STRIDE
    if (Int(slots[unsafe_offset = o + S_FLAGS]) & F_LEADER) == 0:
        return

    var rows = trunc_nonneg(item.page_rows) if item.has_page else 0
    var cols = trunc_nonneg(item.page_cols) if item.has_page else 0
    var scroll = trunc_nonneg(item.scroll_rows) if item.has_page else 0
    if rows == 0 and cols == 0 and scroll == 0:
        return

    var row = Int(slots[unsafe_offset = o + S_ROW])
    var col = Int(slots[unsafe_offset = o + S_COL])
    var screen_row = row - scroll  # the conveyor; negative rows stay in flow

    var y_page = 0
    if rows > 0 and screen_row >= rows:
        y_page = screen_row // rows  # exact, integer gate
    var x_page = 0
    if cols > 0:
        x_page = col // cols  # exact

    var wide_raw = trunc_nonneg(item.pages_wide)
    var wide = wide_raw if wide_raw > 1 else 1
    var band = y_page // wide

    var wrap = trunc_nonneg(item.wrap_width)
    var seg = (col // wrap) if wrap > 0 else 0
    var lh = item.line_height
    if is_nan(lh):
        lh = item.page_line_height  # resolved ?? page fallback (may stay NaN)
    slots[unsafe_offset = o + S_X] = Float32(
        Float64(slots[unsafe_offset = o + S_BASE_X])
        + Float64(y_page % wide) * page_stride_x
    )
    slots[unsafe_offset = o + S_Y] = Float32(
        item.origin_y
        - Float64(screen_row - y_page * rows) * lh
        - Float64(band) * item.band_stride_y
    )
    slots[unsafe_offset = o + S_Z] = Float32(
        item.origin_z
        - Float64(seg) * item.z_step
        + Float64(band) * item.depth_per_band
        + Float64(x_page) * item.depth_per_col
    )


def bounds_reduce[so: Origin[mut=True], bo: Origin[mut=True]](
    slots: Pointer[Float32, so],
    id: Int,
    box: Pointer[Float64, bo],
    base: Int,
):
    """KERNEL — fold this slot's quad into the running min/max box (lanes 0-5,
    FINAL positions). Lanes 6/7 are the fold scalars, untouched here. Min/max is
    exact under any regrouping, which is what makes the sharded reduce safe."""
    var o = id * SLOT_STRIDE
    if (Int(slots[unsafe_offset = o + S_FLAGS]) & F_LEADER) == 0:
        return
    var x = Float64(slots[unsafe_offset = o + S_X])
    var y = Float64(slots[unsafe_offset = o + S_Y])
    var z = Float64(slots[unsafe_offset = o + S_Z])
    var w = Float64(slots[unsafe_offset = o + S_ADVANCE])
    var h = Float64(slots[unsafe_offset = o + S_HEIGHT])
    if x < box[unsafe_offset = base + 0]:
        box[unsafe_offset = base + 0] = x
    if y < box[unsafe_offset = base + 1]:
        box[unsafe_offset = base + 1] = y
    if z < box[unsafe_offset = base + 2]:
        box[unsafe_offset = base + 2] = z
    if x + w > box[unsafe_offset = base + 3]:
        box[unsafe_offset = base + 3] = x + w
    if y + h > box[unsafe_offset = base + 4]:
        box[unsafe_offset = base + 4] = y + h
    if z > box[unsafe_offset = base + 5]:
        box[unsafe_offset = base + 5] = z


# ── Parallel shard workers (the TaskGroup bodies) ────────────────────────────


async def _decode_shard[so: Origin[mut=True]](
    bytes: List[UInt8],
    slots: Pointer[Float32, so],
    trie: Trie,
    start: Int,
    stop: Int,
):
    for id in range(start, stop):
        decode_and_resolve(bytes, slots, trie, id)


async def _fold_item[so: Origin[mut=True], oo: Origin[mut=True], ko: Origin[mut=True]](
    slots: Pointer[Float32, so],
    item: Item,
    ord_to_byte: Pointer[UInt32, oo],
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
):
    layout_item(slots, item, ord_to_byte, scalars, scalar_base)


async def _paginate_shard[so: Origin[mut=True]](
    slots: Pointer[Float32, so],
    item: Item,
    stride: Float64,
    start: Int,
    stop: Int,
):
    for id in range(start, stop):
        paginate(slots, id, item, stride)


async def _bounds_shard[so: Origin[mut=True], bo: Origin[mut=True]](
    slots: Pointer[Float32, so],
    box: Pointer[Float64, bo],
    base: Int,
    start: Int,
    stop: Int,
):
    for id in range(start, stop):
        bounds_reduce(slots, id, box, base)


def shard_lo(start: Int, stop: Int, workers: Int, w: Int) -> Int:
    """Start of contiguous shard w of [start, stop) split across `workers`."""
    var per = (stop - start + workers - 1) // workers
    var a = start + w * per
    return a if a < stop else stop


def run_pipeline(bytes: List[UInt8], trie: Trie, items: List[Item]) -> PipelineResult:
    """The whole pipeline — the oracle's runPipeline, natively, sharded across
    cores. decode → ordered miss rebuild + leader count → fold per item (items in
    parallel) → paginate with the DERIVED fan stride (inactive items skipped, one
    item's shards in parallel) → per-item boxes via exact sharded min/max merge →
    batch union."""
    var byte_len = len(bytes)
    var workers = parallelism_level()
    if workers < 1:
        workers = 1
    var slots = List[Float32](unsafe_uninit_length=byte_len * SLOT_STRIDE)
    unsafe_memset_zero(slots.unsafe_ptr(), len(slots))
    var ord_to_byte = List[UInt32](unsafe_uninit_length=byte_len)
    unsafe_memset_zero(ord_to_byte.unsafe_ptr(), len(ord_to_byte))
    var sp = slots.unsafe_ptr()
    var op = ord_to_byte.unsafe_ptr()

    # ── decode: shards write disjoint slot ranges ────────────────────────────
    var tg = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, byte_len, workers, w)
        var b = shard_lo(0, byte_len, workers, w + 1)
        tg.create_task(_decode_shard(bytes, sp, trie, a, b))
    tg.wait()

    # ── ordered miss rebuild + leader count: one serial flags pass (the GPU's
    #    atomic append, made deterministic — byte order, duplicates kept) ──────
    var misses = List[UInt32]()
    var leaders = 0
    var id = 0
    while id < byte_len:
        var flags = Int(sp[unsafe_offset = id * SLOT_STRIDE + S_FLAGS])
        if (flags & F_LEADER) != 0:
            leaders += 1
            if (flags & F_MISSING) != 0:
                misses.append(
                    UInt32(decode_codepoint_at(bytes, id, sequence_length(bytes, id)))
                )
        id += 1

    # ── THE FOLD: serial per item, items in parallel (disjoint ranges) ────────
    var item_count = len(items)
    var item_bounds = List[Float64](length=item_count * 8, fill=0)
    var kp = item_bounds.unsafe_ptr()
    var tg2 = TaskGroup()
    for i in range(item_count):
        tg2.create_task(_fold_item(sp, items[i], op, kp, i * 8))
    tg2.wait()

    # ── paginate: stride DERIVED from the fold scalars; inactive items skip ───
    var tg3 = TaskGroup()
    for i in range(item_count):
        if not page_active(items[i]):
            continue
        var stride = derive_stride(item_bounds[i * 8 + 7], items[i])
        var start = items[i].byte_start
        var stop = start + items[i].byte_count
        for w in range(workers):
            var a = shard_lo(start, stop, workers, w)
            var b = shard_lo(start, stop, workers, w + 1)
            tg3.create_task(_paginate_shard(sp, items[i], stride, a, b))
    tg3.wait()

    # ── per-item boxes: sharded local boxes, exact min/max merge ─────────────
    var batch_bounds = List[Float64](length=8, fill=0)
    batch_bounds[0] = F64_INF
    batch_bounds[1] = F64_INF
    batch_bounds[2] = F64_INF
    batch_bounds[3] = -F64_INF
    batch_bounds[4] = -F64_INF
    batch_bounds[5] = -F64_INF
    var shard_boxes = List[Float64](length=workers * 8, fill=0)
    var xp = shard_boxes.unsafe_ptr()
    for i in range(item_count):
        var b8 = i * 8
        for w in range(workers):
            shard_boxes[w * 8 + 0] = F64_INF
            shard_boxes[w * 8 + 1] = F64_INF
            shard_boxes[w * 8 + 2] = F64_INF
            shard_boxes[w * 8 + 3] = -F64_INF
            shard_boxes[w * 8 + 4] = -F64_INF
            shard_boxes[w * 8 + 5] = -F64_INF
        var start = items[i].byte_start
        var stop = start + items[i].byte_count
        var tg4 = TaskGroup()
        for w in range(workers):
            var a = shard_lo(start, stop, workers, w)
            var b = shard_lo(start, stop, workers, w + 1)
            tg4.create_task(_bounds_shard(sp, xp, w * 8, a, b))
        tg4.wait()
        item_bounds[b8 + 0] = F64_INF
        item_bounds[b8 + 1] = F64_INF
        item_bounds[b8 + 2] = F64_INF
        item_bounds[b8 + 3] = -F64_INF
        item_bounds[b8 + 4] = -F64_INF
        item_bounds[b8 + 5] = -F64_INF
        for w in range(workers):
            var l = 0
            while l < 3:
                if shard_boxes[w * 8 + l] < item_bounds[b8 + l]:
                    item_bounds[b8 + l] = shard_boxes[w * 8 + l]
                l += 1
            while l < 6:
                if shard_boxes[w * 8 + l] > item_bounds[b8 + l]:
                    item_bounds[b8 + l] = shard_boxes[w * 8 + l]
                l += 1
        var l = 0
        while l < 3:
            if item_bounds[b8 + l] < batch_bounds[l]:
                batch_bounds[l] = item_bounds[b8 + l]
            l += 1
        while l < 8:
            if item_bounds[b8 + l] > batch_bounds[l]:
                batch_bounds[l] = item_bounds[b8 + l]
            l += 1

    # Keep-alive anchor (ASAP destruction): shard_boxes' last task-visible use is
    # inside the loop's create_task calls; it must outlive every wait.
    _ = len(shard_boxes)

    var r = PipelineResult()
    r.slots = slots^
    r.ord_to_byte = ord_to_byte^
    r.misses = misses^
    r.leaders = leaders
    r.item_bounds = item_bounds^
    r.batch_bounds = batch_bounds^
    return r^
