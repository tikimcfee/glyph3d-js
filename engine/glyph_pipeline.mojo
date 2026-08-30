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
# (decode_and_resolve, resolve_x, paginate) are thread-shaped —
# `id` is the thread id, buffers are raw pointers, exactly the GPU's calling
# convention — and the drivers run them over TaskGroup shards. Every parallel
# reduction here is EXACT under regrouping: min/max merges and disjoint writes
# only; anything order-sensitive (the fold, miss order) stays serial. There is
# one code path — small inputs just get small shards.
#
# Mirrors (never diverge): packages/glyph3d-core/src/compute/glyphPipelineReference.js
#                          packages/glyph3d-core/src/compute/GlyphTrie.js (trie_lookup)

from std.collections.span import Span
from std.math import inf
from std.memory import unsafe_memset_zero
from std.runtime.asyncrt import TaskGroup, parallelism_level
from glyph_schema import (
    SM_STRIDE, SM_ADVANCE, SM_HEIGHT, SM_GLYPH_ID,
    LM_STRIDE, LM_X, LM_Y, LM_Z, LM_BASE_X,
    LC_STRIDE, LC_ROW, LC_COL,
    FIXTURE_MEASURE_STRIDE, FIXTURE_COUNT_STRIDE,
)

# ── Lane layout: GENERATED, six arrays, split twice ─────────────────────────
# Who WRITES a lane decides where it lives; who READS it decides whether it
# lives at all (see struct Slots and struct Witness). Float carriers hold
# measures, u32 carriers hold counts. No bitcasts anywhere.

comptime BOUNDS_GRAIN = 65536
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
    """One file in the arena: byte range + layout params. line_height is REQUIRED —
    a NaN one is malformed input, not a request for a per-glyph fallback."""
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


struct LayoutSeed(Copyable, Movable):
    """The fold accumulators at a byte — everything layout_item carries forward.

    Laying a whole item is the zero seed at byte_start. Laying a RANGE is the same
    loop with a seed recovered from the bake's checkpoints, which is what lets an
    edit re-lay 4KB instead of the file. One code path either way."""

    var base_row: Int
    var col: Int
    var line_adv: Float64
    var seg_adv: Float32
    var ord: Int

    def __init__(out self):
        self.base_row = 0
        self.col = 0
        self.line_adv = 0
        self.seg_adv = 0
        self.ord = 0


struct Slots(Copyable, Movable):
    """THE CONTAINER, realized in exactly one place.

    Four render-read arrays, split by PHASE — who writes a lane decides where
    it lives:

      sm  f32 x4  ADVANCE HEIGHT GLYPH_ID PAD   decode's output; one aligned
                                                16-byte store per byte
      fl  u32 x1  FLAGS                         decode writes; the fold ORs in
                                                F_RENDERED
      lm  f32 x4  X Y Z BASE_X                  the fold's output; one aligned
                                                16-byte store per leader
      lc  u32 x2  ROW COL                       the fold's output

    Decode NEVER touches lm/lc — that is the write-axis split, and it is why
    dispatch 1 stopped dirtying 48 B per source byte (measured 1.37x end-to-end
    before this was built; engine/bench/split_bench.mojo). LINE_ADV and ORD are
    NOT here: no render path reads them, so the read-axis split moved them to
    struct Witness (the scan form consumes them internally; the serial form
    writes them only when instantiated witnessed). Every kernel reads and writes
    through these accessors, so the next re-layout edits this struct and the
    schema, not thirty call sites.

    Pointers are origin-erased: a Slots is a VIEW over Lists the caller keeps
    alive (the drivers' `_ = len(...)` anchors)."""

    var sm: Pointer[Float32, MutUntrackedOrigin]
    var fl: Pointer[UInt32, MutUntrackedOrigin]
    var lm: Pointer[Float32, MutUntrackedOrigin]
    var lc: Pointer[UInt32, MutUntrackedOrigin]

    def __init__(
        out self,
        sm: Pointer[Float32, MutUntrackedOrigin],
        fl: Pointer[UInt32, MutUntrackedOrigin],
        lm: Pointer[Float32, MutUntrackedOrigin],
        lc: Pointer[UInt32, MutUntrackedOrigin],
    ):
        self.sm = sm
        self.fl = fl
        self.lm = lm
        self.lc = lc

    # ── static: written by decode, read by everyone ──────────────────────────
    def set_static(self, id: Int, advance: Float32, height: Float32, glyph_id: Float32):
        # One aligned 16-byte store; PAD carries 0 so the whole slot is defined.
        self.sm.unsafe_store[width=4](
            id * SM_STRIDE, SIMD[DType.float32, 4](advance, height, glyph_id, 0)
        )

    def advance(self, id: Int) -> Float32:
        return self.sm[unsafe_offset = id * SM_STRIDE + SM_ADVANCE]

    def height(self, id: Int) -> Float32:
        return self.sm[unsafe_offset = id * SM_STRIDE + SM_HEIGHT]

    def glyph_id(self, id: Int) -> Float32:
        return self.sm[unsafe_offset = id * SM_STRIDE + SM_GLYPH_ID]

    def flags(self, id: Int) -> Int:
        return Int(self.fl[unsafe_offset=id])

    def set_flags(self, id: Int, v: Int):
        self.fl[unsafe_offset=id] = UInt32(v)

    # ── positional: written by the fold (and paginate), never by decode ──────
    def x(self, id: Int) -> Float32:
        return self.lm[unsafe_offset = id * LM_STRIDE + LM_X]

    def y(self, id: Int) -> Float32:
        return self.lm[unsafe_offset = id * LM_STRIDE + LM_Y]

    def z(self, id: Int) -> Float32:
        return self.lm[unsafe_offset = id * LM_STRIDE + LM_Z]

    def base_x(self, id: Int) -> Float32:
        return self.lm[unsafe_offset = id * LM_STRIDE + LM_BASE_X]

    def set_x(self, id: Int, v: Float32):
        self.lm[unsafe_offset = id * LM_STRIDE + LM_X] = v

    def set_y(self, id: Int, v: Float32):
        self.lm[unsafe_offset = id * LM_STRIDE + LM_Y] = v

    def set_z(self, id: Int, v: Float32):
        self.lm[unsafe_offset = id * LM_STRIDE + LM_Z] = v

    def set_base_x(self, id: Int, v: Float32):
        self.lm[unsafe_offset = id * LM_STRIDE + LM_BASE_X] = v

    def set_position(self, id: Int, x: Float32, y: Float32, z: Float32, base_x: Float32):
        """THE READ-AXIS DIVIDEND: with LINE_ADV moved to the witness array,
        the fold's positional measure write is ONE aligned 16-byte store — the
        exact mirror of set_static."""
        self.lm.unsafe_store[width=4](
            id * LM_STRIDE, SIMD[DType.float32, 4](x, y, z, base_x)
        )

    def set_rowcol(self, id: Int, row: Int, col: Int):
        self.lc.unsafe_store[width=2](
            id * LC_STRIDE, SIMD[DType.uint32, 2](UInt32(row), UInt32(col))
        )

    def row(self, id: Int) -> Int:
        return Int(self.lc[unsafe_offset = id * LC_STRIDE + LC_ROW])

    def col(self, id: Int) -> Int:
        return Int(self.lc[unsafe_offset = id * LC_STRIDE + LC_COL])

    def set_row(self, id: Int, v: Int):
        self.lc[unsafe_offset = id * LC_STRIDE + LC_ROW] = UInt32(v)

    def set_col(self, id: Int, v: Int):
        self.lc[unsafe_offset = id * LC_STRIDE + LC_COL] = UInt32(v)

    def zero_positional(self, id: Int):
        """Every positional lane of one byte to zero — the defined state of a
        non-leader or gap byte. Decode used to write these zeros for EVERY byte;
        the split moves the duty to the fold (which walks every byte of its item
        anyway) and to the driver's gap sweep, so decode never dirties these
        lines at all."""
        self.lm.unsafe_store[width=4](
            id * LM_STRIDE, SIMD[DType.float32, 4](0, 0, 0, 0)
        )
        self.lc.unsafe_store[width=2](
            id * LC_STRIDE, SIMD[DType.uint32, 2](0, 0)
        )

    def zero_static(self, id: Int):
        self.sm.unsafe_store[width=4](id * SM_STRIDE, SIMD[DType.float32, 4](0, 0, 0, 0))


struct Witness(Copyable, Movable):
    """THE WITNESS TIER — fold interior no render path reads.

    The read-axis split: LINE_ADV, ORD, and ord_to_byte are written per byte
    but consumed only by the scan form's resolve step and by verification.
    So they live apart from the render-read container, and the SERIAL form
    stores into them only under its witnessed instantiation — the suites run
    witnessed, production runs elided, and conformance_elide pins the two
    instantiations' render-read arrays bit-identical.

      wm   f32 x1  LINE_ADV   the fold's f64 line prefix, narrowed per leader
      wc   u32 x1  ORD        per-item ordinal (the lane that started all of
                              this — aliased past 2^24 as an f32, exact here)
      otb  u32 x1  ord_to_byte[byte_start + ord] == id, the round-trip witness

    Same origin-erasure rules as Slots: a VIEW over Lists the caller anchors."""

    var wm: Pointer[Float32, MutUntrackedOrigin]
    var wc: Pointer[UInt32, MutUntrackedOrigin]
    var otb: Pointer[UInt32, MutUntrackedOrigin]

    def __init__(
        out self,
        wm: Pointer[Float32, MutUntrackedOrigin],
        wc: Pointer[UInt32, MutUntrackedOrigin],
        otb: Pointer[UInt32, MutUntrackedOrigin],
    ):
        self.wm = wm
        self.wc = wc
        self.otb = otb


struct PipelineResult(Copyable, Movable):
    var sm: List[Float32]     # static measures, SM_STRIDE per byte
    var fl: List[UInt32]      # flags, 1 per byte
    var lm: List[Float32]     # positional measures, LM_STRIDE per byte
    var lc: List[UInt32]      # positional counts, LC_STRIDE per byte
    var wm: List[Float32]     # witness: LINE_ADV per byte (len 1 when elided)
    var wc: List[UInt32]      # witness: ORD per byte (len 1 when elided)
    var ord_to_byte: List[UInt32]
    var misses: List[UInt32]
    var leaders: Int
    var item_bounds: List[Float64]  # item_count × 8 lanes
    var batch_bounds: List[Float64]  # 8 lanes

    def __init__(out self):
        self.sm = List[Float32]()
        self.fl = List[UInt32]()
        self.lm = List[Float32]()
        self.lc = List[UInt32]()
        self.wm = List[Float32]()
        self.wc = List[UInt32]()
        self.ord_to_byte = List[UInt32]()
        self.misses = List[UInt32]()
        self.leaders = 0
        self.item_bounds = List[Float64]()
        self.batch_bounds = List[Float64]()

    def slots(mut self) -> Slots:
        # Origin-erased VIEW: the caller owns the Lists and must keep them alive
        # past every task that holds this (the drivers' `_ = len(...)` anchors).
        return Slots(
            self.sm.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
            self.fl.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
            self.lm.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
            self.lc.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
        )

    def witness(mut self) -> Witness:
        # Same origin-erased VIEW rules as slots().
        return Witness(
            self.wm.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
            self.wc.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
            self.ord_to_byte.unsafe_ptr().unsafe_origin_cast[MutUntrackedOrigin](),
        )

    # ── FIXTURE-ORDER accessors ──────────────────────────────────────────────
    # Fixtures are frozen at format v2: 8 measure lanes [X Y Z ADVANCE HEIGHT
    # GLYPH_ID BASE_X LINE_ADV] + 4 count lanes [ROW COL FLAGS ORD] per byte.
    # The suites compare in that order; these map it onto the phase arrays so a
    # container re-layout never touches a suite again.
    def m_at(self, slot: Int, fix_lane: Int) -> Float32:
        if fix_lane < 3:      # X, Y, Z
            return self.lm[slot * LM_STRIDE + fix_lane]
        if fix_lane < 6:      # ADVANCE, HEIGHT, GLYPH_ID
            return self.sm[slot * SM_STRIDE + (fix_lane - 3)]
        if fix_lane == 6:     # BASE_X
            return self.lm[slot * LM_STRIDE + LM_BASE_X]
        # LINE_ADV — witness array; meaningful only on a WITNESSED result
        return self.wm[slot]

    def c_at(self, slot: Int, fix_lane: Int) -> UInt32:
        if fix_lane < 2:      # ROW, COL
            return self.lc[slot * LC_STRIDE + fix_lane]
        if fix_lane == 2:     # FLAGS
            return self.fl[slot]
        # ORD — witness array; meaningful only on a WITNESSED result
        return self.wc[slot]


def is_nan(v: Float64) -> Bool:
    return v != v


def trunc_nonneg(v: Float64) -> Int:
    """max(0, Math.trunc(v || 0)) — params arrive as f64, decisions are ints."""
    if is_nan(v) or v <= 0:
        return 0
    return Int(v)  # toward zero for non-negatives


def sequence_length[o: ImmOrigin](bytes: Span[UInt8, o], i: Int) -> Int:
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


def byte_at[o: ImmOrigin](bytes: Span[UInt8, o], i: Int) -> Int:
    """Byte at `i`, or 0 past the end — the shader's bounds-checked read."""
    if i >= 0 and i < len(bytes):
        return Int(bytes[i])
    return 0


def decode_codepoint_at[o: ImmOrigin](bytes: Span[UInt8, o], id: Int, n: Int) -> Int:
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


def decode_and_resolve[o: ImmOrigin](
    bytes: Span[UInt8, o],
    slots: Slots,
    trie: Trie,
    id: Int,
) -> Int:
    """KERNEL 1 — thread per byte: decode the codepoint, resolve through the trie.

    Returns the codepoint for a leader, -1 otherwise. The caller wants it: the old
    serial miss pass re-derived it with sequence_length + decode_codepoint_at for
    every miss, re-deriving what this function already had in a register.

    WRITES ONLY THE STATIC ARRAYS — one aligned 16-byte store plus a flags word,
    20 B per byte where the pre-split form dirtied 48. The positional lanes have
    two other writers with full coverage between them: the fold zeroes non-leaders
    while walking its item (it visits every byte anyway), and the driver sweeps
    the known GAP ranges. V1's "decode writes every lane so the memsets can go"
    was correct against a full-arena memset and still locked in the 48 B floor —
    the split is what actually removes it (measured 1.37x end-to-end,
    engine/bench/split_bench.mojo; A-vs-B there shows dead STORES cost nothing,
    dirtied LINES are the whole price)."""
    if id >= len(bytes):
        return -1
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
    if n == 0:
        # Non-leader (continuation byte, invalid lead byte): zero the static slot.
        # A rewritten range may have held a real glyph here. Its positional lanes
        # are the fold's / gap sweep's duty, not decode's.
        slots.zero_static(id)
        slots.set_flags(id, 0)
        return -1

    var cp = decode_codepoint_at(bytes, id, n)

    # ONE 16-BYTE LOAD instead of four scalar ones. The trie entry is four
    # contiguous f32s (GLYPH_ID, ADVANCE, HEIGHT, FLAGS = 0,1,2,3), so the whole
    # entry arrives in a single NEON register.
    #
    # The block index is also hoisted for the sub-256 path: BLOCK_SHIFT is 8, so
    # cp >> 8 == 0 for every ASCII and Latin-1 codepoint, which is ~99% of source
    # text. That kills the FIRST of the two dependent loads on the common path —
    # dependent loads are what a gather cannot pipeline.
    var bp = trie.block_index.unsafe_ptr()
    var block: Int
    if cp < 256:
        block = Int(bp[unsafe_offset=0])
    else:
        block = Int(bp[unsafe_offset = cp >> BLOCK_SHIFT])
    var tb = ((block << BLOCK_SHIFT) | (cp & BLOCK_MASK)) * ENTRY_STRIDE

    var e = trie.blocks.unsafe_ptr().unsafe_load[width=4](tb)
    var missing = (Int(e[LANE_FLAGS]) & FLAG_MISSING) != 0
    # ONE aligned 16-byte store: the whole static record in a single instruction.
    slots.set_static(id, e[LANE_ADVANCE], e[LANE_HEIGHT], e[LANE_GLYPH_ID])
    var flags = F_LEADER
    if cp == NEWLINE:
        flags |= F_NEWLINE
    if missing:
        flags |= F_MISSING
    slots.set_flags(id, flags)
    return cp


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


def layout_item[ko: Origin[mut=True], witness: Bool = True](
    slots: Slots,
    item: Item,
    w: Witness,
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
    start: Int,
    seed: LayoutSeed,
    write_bounds: Bool,
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

    # V3: fold the box HERE when the positions this loop writes are final — that
    # is, when paginate will not run for this item. Saves a whole extra pass that
    # only read back lanes we had just stored.
    #
    # write_bounds is False for a RESUMED range: conformance_resume calls this
    # directly with a seed, and a partial range must not publish a whole item's box.
    var bmnx = F64_INF
    var bmny = F64_INF
    var bmnz = F64_INF
    var bmxx = -F64_INF
    var bmxy = -F64_INF
    var bmxz = -F64_INF
    var base_row = seed.base_row
    var col = seed.col
    var line_adv = seed.line_adv
    var seg_adv = seed.seg_adv
    var ord = seed.ord
    var id = start
    var stop = item.byte_start + item.byte_count
    while id < stop:
        var flags = slots.flags(id)
        if (flags & F_LEADER) == 0:
            # The split moved non-leader zeroing HERE from decode: this loop
            # already visits every byte of its item, and decode not touching the
            # positional arrays is the entire point of the split. ~1.5% of source
            # bytes take this store.
            slots.zero_positional(id)
            comptime if witness:
                w.wm[unsafe_offset=id] = 0
                w.wc[unsafe_offset=id] = 0
            id += 1
            continue
        var advance = slots.advance(id)
        var wrap_row = (col // wrap) if wrap > 0 else 0
        var row = base_row + wrap_row
        var x: Float64 = Float64(seg_adv) if fold > 0 else line_adv
        # lineHeight is the ITEM's, never the glyph's. The oracle carried a
        # `?? glyphHeight` fallback and this port mirrored it; both are gone as of
        # 3285e40. Per-glyph line height staggered baselines WITHIN a row (a tall
        # emoji at row 5 landed at -5*emojiHeight beside -5*textHeight), the GPU
        # kernel never had the branch, and no fixture exercised it — so the oracle
        # and this port agreed with each other while disagreeing with the renderer.
        # An unset line_height is NaN here and propagates; the NaN sweep in
        # fixture_io.nan_lanes is what now catches that, since a bit comparison
        # cannot (two NaNs compare equal).
        var lh: Float64 = item.line_height
        # X and BASE_X carry the same value at fold time (paginate is what
        # later separates them), so the four positional measures are one
        # aligned 16-byte store — same expressions, same narrowing, same bits
        # as the four scalar stores this replaced.
        var pos_x = Float32(x + ox)
        slots.set_position(
            id, pos_x,
            Float32(-Float64(row) * lh + oy),
            Float32(-Float64(wrap_row) * z_step + oz),
            pos_x,
        )
        slots.set_rowcol(id, row, col)
        slots.set_flags(id, flags | F_RENDERED)
        comptime if witness:
            w.wm[unsafe_offset=id] = Float32(line_adv)
            w.wc[unsafe_offset=id] = UInt32(ord)
            w.otb[unsafe_offset = item.byte_start + ord] = UInt32(id)
        if write_bounds:
            # Read back the STORED, ROUNDED lanes, never the f64 intermediates —
            # folding the wider values would shift box lanes 0-5 off the oracle.
            var bx = Float64(slots.x(id))
            var by = Float64(slots.y(id))
            var bz = Float64(slots.z(id))
            var bw = Float64(slots.advance(id))
            var bh = Float64(slots.height(id))
            if bx < bmnx:
                bmnx = bx
            if by < bmny:
                bmny = by
            if bz < bmnz:
                bmnz = bz
            if bx + bw > bmxx:
                bmxx = bx + bw
            if by + bh > bmxy:
                bmxy = by + bh
            if bz > bmxz:
                bmxz = bz
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

    if write_bounds:
        scalars[unsafe_offset = scalar_base + 0] = bmnx
        scalars[unsafe_offset = scalar_base + 1] = bmny
        scalars[unsafe_offset = scalar_base + 2] = bmnz
        scalars[unsafe_offset = scalar_base + 3] = bmxx
        scalars[unsafe_offset = scalar_base + 4] = bmxy
        scalars[unsafe_offset = scalar_base + 5] = bmxz


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


def paginate(
    slots: Slots,
    id: Int,
    item: Item,
    page_stride_x: Float64,
):
    """KERNEL — pagination as a PURE per-slot remap of the base position. Every
    page decision reads the INTEGER row/col lanes, never the float position."""
    if (slots.flags(id) & F_LEADER) == 0:
        return

    var rows = trunc_nonneg(item.page_rows) if item.has_page else 0
    var cols = trunc_nonneg(item.page_cols) if item.has_page else 0
    var scroll = trunc_nonneg(item.scroll_rows) if item.has_page else 0
    if rows == 0 and cols == 0 and scroll == 0:
        return

    var row = slots.row(id)
    var col = slots.col(id)
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
    # The page's own lineHeight is NOT consulted. This mirrored the oracle's
    # `resolved[i].lineHeight ?? it.page?.lineHeight`, deleted in 4697e3b as
    # unreachable: assertLineHeight guarantees the item's is finite before paginate
    # reads it, so the fallback could only ever fire on the malformed input that is
    # now refused. A page pitch was never a feature — it was gated on the bug.
    var lh = item.line_height
    slots.set_x(id, Float32(
        Float64(slots.base_x(id)) + Float64(y_page % wide) * page_stride_x
    ))
    slots.set_y(id, Float32(
        item.origin_y
        - Float64(screen_row - y_page * rows) * lh
        - Float64(band) * item.band_stride_y
    ))
    slots.set_z(id, Float32(
        item.origin_z
        - Float64(seg) * item.z_step
        + Float64(band) * item.depth_per_band
        + Float64(x_page) * item.depth_per_col
    ))


# ── Parallel shard workers (the TaskGroup bodies) ────────────────────────────


async def _decode_shard[
    o: ImmOrigin, mo2: Origin[mut=True], no: Origin[mut=True],
](
    bytes: Span[UInt8, o],
    slots: Slots,
    trie: Trie,
    miss_out: Pointer[UInt32, mo2],
    tally: Pointer[Int, no],
    w: Int,
    start: Int,
    stop: Int,
):
    """Decode a byte range AND collect this shard's leader count and miss list.

    The driver used to do this in a separate SERIAL pass over every byte — O(n)
    even with zero misses, and unable to use more than one of four cores. Shards
    are contiguous ascending ranges that tile [0, byte_len), so concatenating their
    miss lists in shard order IS byte order: duplicates kept, gaps included, item
    order irrelevant. Per-ITEM collection would lose all three of those.

    Each shard writes into miss_out[start ...], its own disjoint region, bounded by
    its own length. No zeroing needed — `tally` records how much is live."""
    var leaders = 0
    var nmiss = 0
    var bp = bytes.unsafe_ptr()
    var tbi = trie.block_index.unsafe_ptr()
    var tbb = trie.blocks.unsafe_ptr()
    var ascii_block = Int(tbi[unsafe_offset=0])

    var id = start
    while id < stop:
        # ASCII BLOCK GATE. One 16-byte load answers "is any byte multi-byte?" for
        # sixteen bytes at once: a UTF-8 lead or continuation byte always has bit 7
        # set, so (v & 0x80) == 0 across the block means sixteen single-byte
        # leaders. Source text is ~99% ASCII, so this path takes almost all of it
        # and skips the 4-way sequence-length ladder and every bounds-checked
        # multi-byte read.
        #
        # W=16 is NEON's native width for u8; W=32 measured SLOWER (it costs more
        # than it saves once a block straddles a non-ASCII byte).
        if id + 16 <= stop:
            var v = bp.unsafe_load[width=16](id)
            if Int((v & 0x80).reduce_or()) == 0:
                for k in range(16):
                    var b = Int(v[k])
                    # cp < 256, so the block index is the hoisted ASCII one and the
                    # first dependent load is gone.
                    var tb = ((ascii_block << BLOCK_SHIFT) | b) * ENTRY_STRIDE
                    var e = tbb.unsafe_load[width=4](tb)
                    var f = F_LEADER
                    if b == NEWLINE:
                        f |= F_NEWLINE
                    if (Int(e[LANE_FLAGS]) & FLAG_MISSING) != 0:
                        f |= F_MISSING
                        miss_out[unsafe_offset = start + nmiss] = UInt32(b)
                        nmiss += 1
                    # STATIC ONLY: one 16-byte store + one flags word per byte.
                    # The positional lanes belong to the fold and the gap sweep.
                    slots.set_static(
                        id + k, e[LANE_ADVANCE], e[LANE_HEIGHT], e[LANE_GLYPH_ID]
                    )
                    slots.set_flags(id + k, f)
                leaders += 16
                id += 16
                continue

        var cp = decode_and_resolve(bytes, slots, trie, id)
        id += 1
        if cp < 0:
            continue
        leaders += 1
        if (slots.flags(id - 1) & F_MISSING) != 0:
            miss_out[unsafe_offset = start + nmiss] = UInt32(cp)
            nmiss += 1
    tally[unsafe_offset = w * 2] = leaders
    tally[unsafe_offset = w * 2 + 1] = nmiss


async def _fold_item[ko: Origin[mut=True], witness: Bool](
    slots: Slots,
    item: Item,
    w: Witness,
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
    write_bounds: Bool,
):
    layout_item[witness=witness](
        slots, item, w, scalars, scalar_base,
        item.byte_start, LayoutSeed(), write_bounds,
    )


async def _paginate_shard(
    slots: Slots,
    item: Item,
    stride: Float64,
    start: Int,
    stop: Int,
):
    for id in range(start, stop):
        paginate(slots, id, item, stride)


async def _bounds_item[bo: Origin[mut=True]](
    slots: Slots,
    box: Pointer[Float64, bo],
    base: Int,
    start: Int,
    stop: Int,
):
    """One task per ITEM, min/max carried in REGISTERS and stored once.

    The previous form ran a TaskGroup per item (64,457 of them over linux, 258k
    tasks) and sharded every item `workers` ways regardless of size — a 167-byte
    file got 4 tasks of 42 bytes. Worse, bounds_reduce did a load-compare-store
    against `box` for every slot, making the accumulator a loop-carried dependency
    through MEMORY rather than registers.

    Items are already disjoint and contiguous, so one task each needs no merge
    step at all. Min/max is exact under any regrouping, which is what let the old
    form shard in the first place and what lets this one not."""
    var mnx = F64_INF
    var mny = F64_INF
    var mnz = F64_INF
    var mxx = -F64_INF
    var mxy = -F64_INF
    var mxz = -F64_INF
    for id in range(start, stop):
        if (slots.flags(id) & F_LEADER) == 0:
            continue
        var x = Float64(slots.x(id))
        var y = Float64(slots.y(id))
        var z = Float64(slots.z(id))
        var w = Float64(slots.advance(id))
        var h = Float64(slots.height(id))
        if x < mnx:
            mnx = x
        if y < mny:
            mny = y
        if z < mnz:
            mnz = z
        if x + w > mxx:
            mxx = x + w
        if y + h > mxy:
            mxy = y + h
        if z > mxz:
            mxz = z
    # Each task owns a DISJOINT scratch slot. An earlier version had grains
    # read-compare-write a shared box, which is a lost-update race — and every
    # fixture is under one grain, so conformance could not have caught it.
    box[unsafe_offset = base + 0] = mnx
    box[unsafe_offset = base + 1] = mny
    box[unsafe_offset = base + 2] = mnz
    box[unsafe_offset = base + 3] = mxx
    box[unsafe_offset = base + 4] = mxy
    box[unsafe_offset = base + 5] = mxz


def shard_lo(start: Int, stop: Int, workers: Int, w: Int) -> Int:
    """Start of contiguous shard w of [start, stop) split across `workers`."""
    var per = (stop - start + workers - 1) // workers
    var a = start + w * per
    return a if a < stop else stop


def run_pipeline[o: ImmOrigin, witness: Bool = True](
    bytes: Span[UInt8, o], trie: Trie, items: List[Item]
) -> PipelineResult:
    """The whole pipeline — the oracle's runPipeline, natively, sharded across
    cores. decode → ordered miss rebuild + leader count → fold per item (items in
    parallel) → paginate with the DERIVED fan stride (inactive items skipped, one
    item's shards in parallel) → per-item boxes via exact sharded min/max merge →
    batch union.

    `witness` selects the instantiation: witnessed (the default — what every
    suite runs) also fills the witness tier (LINE_ADV, ORD, ord_to_byte);
    elided writes only the render-read arrays and allocates the witness Lists
    at length 1 so the pointers stay valid and no store is reachable.
    conformance_elide pins the two instantiations' render-read arrays
    bit-identical, which is what makes the elided form VERIFIED rather than
    merely plausible."""
    var byte_len = len(bytes)
    var workers = parallelism_level()
    if workers < 1:
        workers = 1
    # No slot memset. Coverage after the split is a THREE-WAY contract:
    #   static     decode writes every byte of [0, byte_len), gaps included
    #   positional the fold zeroes non-leaders while walking its item; the GAP
    #              SWEEP below zeroes bytes no item claims
    # ord_to_byte's memset STAYS (witnessed only) — the fold fills just
    # [byte_start, +ord), so its tail has no writer.
    var r = PipelineResult()
    r.sm = List[Float32](unsafe_uninit_length=byte_len * SM_STRIDE)
    r.fl = List[UInt32](unsafe_uninit_length=byte_len)
    r.lm = List[Float32](unsafe_uninit_length=byte_len * LM_STRIDE)
    r.lc = List[UInt32](unsafe_uninit_length=byte_len * LC_STRIDE)
    # The witness tier: full-size only when witnessed. Elided keeps 1-element
    # Lists so Witness pointers are valid while every store is comptime-gated out.
    var wlen = (byte_len if byte_len > 0 else 1) if witness else 1
    r.wm = List[Float32](unsafe_uninit_length=wlen)
    r.wc = List[UInt32](unsafe_uninit_length=wlen)
    r.ord_to_byte = List[UInt32](unsafe_uninit_length=wlen)
    comptime if witness:
        unsafe_memset_zero(r.ord_to_byte.unsafe_ptr(), len(r.ord_to_byte))
    var slots = r.slots()
    var w = r.witness()

    # ── THE GAP SWEEP: positional zeros for bytes no item claims ─────────────
    # Items arrive sorted ascending by byte_start (every caller builds them so);
    # if they ever are not, fall back to zeroing everything rather than trusting
    # the walk. A gap byte's STATIC lanes are decode's (it covers the full range);
    # only positional needs a writer here. Usually there are no gaps and this
    # loop body never runs.
    var cursor = 0
    var sorted_items = True
    for i in range(len(items)):
        if items[i].byte_start < cursor:
            sorted_items = False
            break
        cursor = items[i].byte_start + items[i].byte_count
    if sorted_items:
        cursor = 0
        for i in range(len(items)):
            for gid in range(cursor, min(items[i].byte_start, byte_len)):
                slots.zero_positional(gid)
                comptime if witness:
                    w.wm[unsafe_offset=gid] = 0
                    w.wc[unsafe_offset=gid] = 0
            cursor = items[i].byte_start + items[i].byte_count
        for gid in range(cursor, byte_len):
            slots.zero_positional(gid)
            comptime if witness:
                w.wm[unsafe_offset=gid] = 0
                w.wc[unsafe_offset=gid] = 0
    else:
        for gid in range(byte_len):
            slots.zero_positional(gid)
            comptime if witness:
                w.wm[unsafe_offset=gid] = 0
                w.wc[unsafe_offset=gid] = 0

    # ── decode: shards write disjoint slot ranges ────────────────────────────
    var miss_scratch = List[UInt32](unsafe_uninit_length=byte_len if byte_len > 0 else 1)
    var msp = miss_scratch.unsafe_ptr()
    var tally = List[Int](length=workers * 2, fill=0)
    var tp = tally.unsafe_ptr()
    var tg = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, byte_len, workers, w)
        var b = shard_lo(0, byte_len, workers, w + 1)
        tg.create_task(_decode_shard(bytes, slots, trie, msp, tp, w, a, b))
    tg.wait()
    _ = len(miss_scratch)
    _ = len(tally)

    # ── concatenate the shards' miss lists IN SHARD ORDER, which is byte order ──
    var misses = List[UInt32]()
    var leaders = 0
    for w in range(workers):
        leaders += tally[w * 2]
        var a = shard_lo(0, byte_len, workers, w)
        for k in range(tally[w * 2 + 1]):
            misses.append(miss_scratch[a + k])

    # ── THE FOLD: serial per item, items in parallel (disjoint ranges) ────────
    var item_count = len(items)
    var item_bounds = List[Float64](length=item_count * 8, fill=0)
    var kp = item_bounds.unsafe_ptr()
    var tg2 = TaskGroup()
    for i in range(item_count):
        tg2.create_task(
            _fold_item[witness=witness](
                slots, items[i], w, kp, i * 8, not page_active(items[i])
            )
        )
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
            tg3.create_task(_paginate_shard(slots, items[i], stride, a, b))
    tg3.wait()

    # ── per-item boxes: sharded local boxes, exact min/max merge ─────────────
    var batch_bounds = List[Float64](length=8, fill=0)
    batch_bounds[0] = F64_INF
    batch_bounds[1] = F64_INF
    batch_bounds[2] = F64_INF
    batch_bounds[3] = -F64_INF
    batch_bounds[4] = -F64_INF
    batch_bounds[5] = -F64_INF
    # ONE TaskGroup for the whole job, one task per item. Lanes 6/7 are the fold
    # scalars layout_item already wrote into item_bounds; only 0-5 are touched here.
    # GRAIN, not item boundaries. One task per item was already better than the old
    # workers-per-item form, but it is SIZE-BLIND: linux has 9,584 files under 1 KB
    # and one of 22.9 MB, so the big one becomes the critical path while three cores
    # idle. Over-decomposition is free — the runtime queue balances it, and 512
    # tasks measure the same as 4 — and it was worth 2.11x on a heavy-tailed batch.
    #
    # Each grain gets its OWN scratch slot and the merge is serial, because min/max
    # being exact under regrouping says nothing about a concurrent read-modify-write
    # on a shared location.
    # V3: non-paged items already have their box from the fold. Only paged items,
    # whose positions paginate rewrote, need the separate pass.
    var grain_of = List[Int]()
    for i in range(item_count):
        var n_i = items[i].byte_count if page_active(items[i]) else 0
        var g = (n_i + BOUNDS_GRAIN - 1) // BOUNDS_GRAIN
        grain_of.append(g)
    var total_grains = 0
    for i in range(item_count):
        total_grains += grain_of[i]
    if total_grains == 0:
        total_grains = 1
    var gboxes = List[Float64](unsafe_uninit_length=total_grains * 8)
    var gp = gboxes.unsafe_ptr()
    # Each grain writes its OWN disjoint scratch slot and the merge below is
    # SERIAL — no CAS, no shared write. min/max being exact under regrouping says
    # nothing about a concurrent read-modify-write on a shared location, which is
    # the race an earlier form of this pass actually had.
    var tg4 = TaskGroup()
    var gi = 0
    for i in range(item_count):
        var start = items[i].byte_start
        var stop = start + items[i].byte_count
        var at = start
        for _ in range(grain_of[i]):
            var end = at + BOUNDS_GRAIN
            if end > stop:
                end = stop
            tg4.create_task(_bounds_item(slots, gp, gi * 8, at, end))
            gi += 1
            at = end
    tg4.wait()

    # serial merge: grains of item i are contiguous in gboxes
    gi = 0
    for i in range(item_count):
        var b8 = i * 8
        if not page_active(items[i]):
            continue          # the fold already wrote lanes 0-5
        item_bounds[b8 + 0] = F64_INF
        item_bounds[b8 + 1] = F64_INF
        item_bounds[b8 + 2] = F64_INF
        item_bounds[b8 + 3] = -F64_INF
        item_bounds[b8 + 4] = -F64_INF
        item_bounds[b8 + 5] = -F64_INF
        for _ in range(grain_of[i]):
            var go = gi * 8
            var k = 0
            while k < 3:
                if gboxes[go + k] < item_bounds[b8 + k]:
                    item_bounds[b8 + k] = gboxes[go + k]
                k += 1
            while k < 6:
                if gboxes[go + k] > item_bounds[b8 + k]:
                    item_bounds[b8 + k] = gboxes[go + k]
                k += 1
            gi += 1

    for i in range(item_count):
        var b8 = i * 8
        var l = 0
        while l < 3:
            if item_bounds[b8 + l] < batch_bounds[l]:
                batch_bounds[l] = item_bounds[b8 + l]
            l += 1
        while l < 8:
            if item_bounds[b8 + l] > batch_bounds[l]:
                batch_bounds[l] = item_bounds[b8 + l]
            l += 1

    # Keep-alive anchors (ASAP destruction): the slot Lists' last task-visible
    # use is through the origin-erased Slots view inside create_task calls; they
    # must outlive every wait.
    _ = len(gboxes)
    _ = len(item_bounds)
    _ = len(r.sm)
    _ = len(r.fl)
    _ = len(r.lm)
    _ = len(r.lc)
    _ = len(r.wm)
    _ = len(r.wc)
    _ = len(r.ord_to_byte)

    r.misses = misses^
    r.leaders = leaders
    r.item_bounds = item_bounds^
    r.batch_bounds = batch_bounds^
    return r^
