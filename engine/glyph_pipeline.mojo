# pipeline.mojo — the byte-in glyph pipeline, ported to Mojo.
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
# Structured for the backend swap: the per-slot kernels (decode_and_resolve,
# paginate, bounds_reduce) are already thread-shaped — `id` is the thread id — and
# layout_item is the serial fold whose parallel form is the monoid scan
# (glyphPipelineScan.js). A GPU backend replaces the driver loops, not the kernels.
#
# Mirrors (never diverge): packages/glyph3d-core/src/compute/glyphPipelineReference.js
#                          packages/glyph3d-core/src/compute/GlyphTrie.js (trie_lookup)

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

from std.math import inf

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


def trie_lookup_base(trie: Trie, cp: Int) -> Int:
    """The exact two-load sequence the shader runs; returns the entry's float base."""
    var block = Int(trie.block_index[cp >> BLOCK_SHIFT])
    return ((block << BLOCK_SHIFT) | (cp & BLOCK_MASK)) * ENTRY_STRIDE


def decode_and_resolve(
    bytes: List[UInt8],
    mut slots: List[Float32],
    trie: Trie,
    id: Int,
    mut misses: List[UInt32],
):
    """KERNEL 1 — thread per byte: decode the codepoint, resolve through the trie."""
    if id >= len(bytes):
        return
    var n = sequence_length(bytes, id)
    var o = id * SLOT_STRIDE
    if n == 0:
        # Non-leader: size zeroed EXPLICITLY (rewritten ranges held a real glyph).
        slots[o + S_ADVANCE] = 0
        slots[o + S_HEIGHT] = 0
        return

    var b0 = byte_at(bytes, id)
    var b1 = byte_at(bytes, id + 1)
    var b2 = byte_at(bytes, id + 2)
    var b3 = byte_at(bytes, id + 3)
    var cp: Int
    if n == 1:
        cp = b0
    elif n == 2:
        cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F)
    elif n == 3:
        cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F)
    else:
        cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)

    var tb = trie_lookup_base(trie, cp)
    var missing = (Int(trie.blocks[tb + LANE_FLAGS]) & FLAG_MISSING) != 0
    slots[o + S_GLYPH_ID] = trie.blocks[tb + LANE_GLYPH_ID]
    slots[o + S_ADVANCE] = trie.blocks[tb + LANE_ADVANCE]
    slots[o + S_HEIGHT] = trie.blocks[tb + LANE_HEIGHT]
    var flags = F_LEADER
    if cp == NEWLINE:
        flags |= F_NEWLINE
    if missing:
        flags |= F_MISSING
    slots[o + S_FLAGS] = Float32(flags)
    if missing:
        misses.append(UInt32(cp))


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


def layout_item(
    mut slots: List[Float32],
    item: Item,
    mut ord_to_byte: List[UInt32],
    mut scalars: List[Float64],
    scalar_base: Int,
):
    """THE FOLD — one item, one forward pass, every lane (layoutItem in the oracle).

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
    while id < item.byte_start + item.byte_count:
        var o = id * SLOT_STRIDE
        var flags = Int(slots[o + S_FLAGS])
        if (flags & F_LEADER) == 0:
            id += 1
            continue
        var wrap_row = (col // wrap) if wrap > 0 else 0
        var row = base_row + wrap_row
        var x: Float64 = Float64(seg_adv) if fold > 0 else line_adv
        var lh: Float64 = Float64(slots[o + S_HEIGHT]) if lh_unset else item.line_height
        slots[o + S_ROW] = Float32(row)
        slots[o + S_COL] = Float32(col)
        slots[o + S_LINE_ADV] = Float32(line_adv)
        slots[o + S_ORD] = Float32(ord)
        slots[o + S_BASE_X] = Float32(x + ox)
        slots[o + S_X] = Float32(x + ox)
        slots[o + S_Y] = Float32(-Float64(row) * lh + oy)
        slots[o + S_Z] = Float32(-Float64(wrap_row) * z_step + oz)
        slots[o + S_FLAGS] = Float32(flags | F_RENDERED)
        ord_to_byte[item.byte_start + ord] = UInt32(id)
        if Float64(row + 1) > scalars[scalar_base + 6]:
            scalars[scalar_base + 6] = Float64(row + 1)  # totalRows (pre-conveyor)
        if x > scalars[scalar_base + 7]:
            scalars[scalar_base + 7] = x  # widest row, ITEM-RELATIVE
        ord += 1
        if (flags & F_NEWLINE) != 0:
            base_row += rows_for_line(col, wrap)
            col = 0
            line_adv = 0
            seg_adv = 0
        else:
            col += 1
            line_adv += Float64(slots[o + S_ADVANCE])
            if fold > 0 and col % fold == 0:
                seg_adv = 0
            else:
                seg_adv = seg_adv + slots[o + S_ADVANCE]
        id += 1


def resolve_x(
    mut slots: List[Float32],
    id: Int,
    item: Item,
    ord_to_byte: List[UInt32],
    mut scalars: List[Float64],
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
    if (Int(slots[o + S_FLAGS]) & F_LEADER) == 0:
        return
    var wrap = trunc_nonneg(item.wrap_width)
    var fold: Int
    if wrap > 0:
        fold = wrap
    else:
        fold = trunc_nonneg(item.page_cols) if item.has_page else 0
    var col = Int(slots[o + S_COL])
    var ord = Int(slots[o + S_ORD])

    var x: Float64
    if fold > 0:
        var x32: Float32 = 0
        var k = col % fold
        while k >= 1:
            var q = Int(ord_to_byte[item.byte_start + ord - k])
            x32 = x32 + slots[q * SLOT_STRIDE + S_ADVANCE]
            k -= 1
        x = Float64(x32)
    else:
        x = Float64(slots[o + S_LINE_ADV])

    var row = Int(slots[o + S_ROW])
    var wrap_row = (col // wrap) if wrap > 0 else 0
    var lh: Float64
    if item.line_height != item.line_height:  # NaN = unset: the glyph's own height
        lh = Float64(slots[o + S_HEIGHT])
    else:
        lh = item.line_height
    slots[o + S_BASE_X] = Float32(x + item.origin_x)
    slots[o + S_X] = Float32(x + item.origin_x)
    slots[o + S_Y] = Float32(-Float64(row) * lh + item.origin_y)
    slots[o + S_Z] = Float32(-Float64(wrap_row) * item.z_step + item.origin_z)

    if Float64(row + 1) > scalars[scalar_base + 6]:
        scalars[scalar_base + 6] = Float64(row + 1)  # totalRows (pre-conveyor)
    if x > scalars[scalar_base + 7]:
        scalars[scalar_base + 7] = x  # widest row, ITEM-RELATIVE


def derive_stride(max_row_extent: Float64, item: Item) -> Float64:
    """THE stride formula: a row-paged item fans page columns at
    (widest item-relative row + pageGapX); pageRows 0 derives 0."""
    if not item.has_page or trunc_nonneg(item.page_rows) <= 0:
        return 0
    return max_row_extent + item.page_gap_x


def paginate(
    mut slots: List[Float32],
    id: Int,
    item: Item,
    page_stride_x: Float64,
):
    """KERNEL — pagination as a PURE per-slot remap of the base position. Every
    page decision reads the INTEGER row/col lanes, never the float position."""
    var o = id * SLOT_STRIDE
    if (Int(slots[o + S_FLAGS]) & F_LEADER) == 0:
        return

    var rows = trunc_nonneg(item.page_rows) if item.has_page else 0
    var cols = trunc_nonneg(item.page_cols) if item.has_page else 0
    var scroll = trunc_nonneg(item.scroll_rows) if item.has_page else 0
    if rows == 0 and cols == 0 and scroll == 0:
        return

    var row = Int(slots[o + S_ROW])
    var col = Int(slots[o + S_COL])
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
    var oy = item.origin_y
    var oz = item.origin_z
    slots[o + S_X] = Float32(
        Float64(slots[o + S_BASE_X]) + Float64(y_page % wide) * page_stride_x
    )
    slots[o + S_Y] = Float32(
        oy
        - Float64(screen_row - y_page * rows) * lh
        - Float64(band) * item.band_stride_y
    )
    slots[o + S_Z] = Float32(
        oz
        - Float64(seg) * item.z_step
        + Float64(band) * item.depth_per_band
        + Float64(x_page) * item.depth_per_col
    )


def bounds_reduce(slots: List[Float32], id: Int, mut box: List[Float64], base: Int):
    """KERNEL — fold this slot's quad into the running min/max box (lanes 0-5,
    FINAL positions). Lanes 6/7 are the fold scalars, untouched here."""
    var o = id * SLOT_STRIDE
    if (Int(slots[o + S_FLAGS]) & F_LEADER) == 0:
        return
    var x = Float64(slots[o + S_X])
    var y = Float64(slots[o + S_Y])
    var z = Float64(slots[o + S_Z])
    var w = Float64(slots[o + S_ADVANCE])
    var h = Float64(slots[o + S_HEIGHT])
    if x < box[base + 0]:
        box[base + 0] = x
    if y < box[base + 1]:
        box[base + 1] = y
    if z < box[base + 2]:
        box[base + 2] = z
    if x + w > box[base + 3]:
        box[base + 3] = x + w
    if y + h > box[base + 4]:
        box[base + 4] = y + h
    if z > box[base + 5]:
        box[base + 5] = z


def run_pipeline(bytes: List[UInt8], trie: Trie, items: List[Item]) -> PipelineResult:
    """The whole pipeline, serially — the oracle's runPipeline, natively.
    decode → fold per item (with fold-scalar reduce riding along) → paginate with
    the DERIVED fan stride → per-item boxes over final positions → batch union."""
    var byte_len = len(bytes)
    var slots = List[Float32](length=byte_len * SLOT_STRIDE, fill=0)
    var ord_to_byte = List[UInt32](length=byte_len, fill=0)
    var misses = List[UInt32]()

    var id = 0
    while id < byte_len:
        decode_and_resolve(bytes, slots, trie, id, misses)
        id += 1

    var item_count = len(items)
    var item_bounds = List[Float64](length=item_count * 8, fill=0)
    var i = 0
    while i < item_count:
        layout_item(slots, items[i], ord_to_byte, item_bounds, i * 8)
        i += 1

    var strides = List[Float64]()
    i = 0
    while i < item_count:
        strides.append(derive_stride(item_bounds[i * 8 + 7], items[i]))
        i += 1

    id = 0
    while id < byte_len:
        var owner = item_for_byte(items, id)
        paginate(slots, id, items[owner], strides[owner])
        id += 1

    var batch_bounds = List[Float64](length=8, fill=0)
    batch_bounds[0] = F64_INF
    batch_bounds[1] = F64_INF
    batch_bounds[2] = F64_INF
    batch_bounds[3] = -F64_INF
    batch_bounds[4] = -F64_INF
    batch_bounds[5] = -F64_INF
    i = 0
    while i < item_count:
        var b = i * 8
        item_bounds[b + 0] = F64_INF
        item_bounds[b + 1] = F64_INF
        item_bounds[b + 2] = F64_INF
        item_bounds[b + 3] = -F64_INF
        item_bounds[b + 4] = -F64_INF
        item_bounds[b + 5] = -F64_INF
        var it = items[i].copy()
        id = it.byte_start
        while id < it.byte_start + it.byte_count:
            bounds_reduce(slots, id, item_bounds, b)
            id += 1
        var l = 0
        while l < 3:
            if item_bounds[b + l] < batch_bounds[l]:
                batch_bounds[l] = item_bounds[b + l]
            l += 1
        while l < 8:
            if item_bounds[b + l] > batch_bounds[l]:
                batch_bounds[l] = item_bounds[b + l]
            l += 1
        i += 1

    var leaders = 0
    id = 0
    while id < byte_len:
        if (Int(slots[id * SLOT_STRIDE + S_FLAGS]) & F_LEADER) != 0:
            leaders += 1
        id += 1

    var r = PipelineResult()
    r.slots = slots^
    r.ord_to_byte = ord_to_byte^
    r.misses = misses^
    r.leaders = leaders
    r.item_bounds = item_bounds^
    r.batch_bounds = batch_bounds^
    return r^
