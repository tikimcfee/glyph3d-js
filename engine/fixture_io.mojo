# fixture_io.mojo — shared loader for the .pipe.bin conformance fixtures.
#
# One Reader (little-endian, packed) + the 'G3DF' pipeline-fixture parse, shared by
# conformance.mojo (oracle-form) and conformance_scan.mojo (scan-form) so the two
# runners can never drift on the format. Format spec: engine/fixtures/gen.mjs.

from std.memory import bitcast
# FIXTURE strides, not container strides: the on-disk format is frozen at 8+4
# per byte regardless of how the engine lays its working buffers.
from glyph_schema import FIXTURE_MEASURE_STRIDE, FIXTURE_COUNT_STRIDE
from glyph_pipeline import Trie, Item, trunc_nonneg

comptime PIPE_MAGIC = 0x46443347


struct Reader(Movable):
    var data: List[UInt8]
    var at: Int

    def __init__(out self, var data: List[UInt8]):
        self.data = data^
        self.at = 0

    def u32(mut self) -> UInt32:
        var v = (
            Int(self.data[self.at])
            | (Int(self.data[self.at + 1]) << 8)
            | (Int(self.data[self.at + 2]) << 16)
            | (Int(self.data[self.at + 3]) << 24)
        )
        self.at += 4
        return UInt32(v)

    def u64(mut self) -> UInt64:
        var lo = UInt64(self.u32())
        var hi = UInt64(self.u32())
        return lo | (hi << 32)

    def f32(mut self) -> Float32:
        return bitcast[DType.float32](self.u32())

    def f64(mut self) -> Float64:
        return bitcast[DType.float64](self.u64())

    def take_bytes(mut self, n: Int) -> List[UInt8]:
        var out = List[UInt8](capacity=n)
        var i = 0
        while i < n:
            out.append(self.data[self.at + i])
            i += 1
        self.at += n
        return out^


struct PipeFixture(Movable):
    """One 'G3DF' case: inputs (bytes, trie, items) + the oracle's expected outputs."""
    var byte_len: Int
    var item_count: Int
    var bytes: List[UInt8]
    var trie: Trie
    var items: List[Item]
    var exp_leaders: Int
    var exp_misses: List[UInt32]
    var exp_ord: List[UInt32]
    var exp_measures: List[Float64]  # VALUES (f64 carrier)
    var exp_counts: List[UInt32]     # EXACT — counts have no carrier question
    var exp_item_bounds: List[UInt64]
    var exp_batch: List[UInt64]

    def __init__(out self):
        self.byte_len = 0
        self.item_count = 0
        self.bytes = List[UInt8]()
        self.trie = Trie(List[UInt32](), List[Float32](), List[UInt32]())
        self.items = List[Item]()
        self.exp_leaders = 0
        self.exp_misses = List[UInt32]()
        self.exp_ord = List[UInt32]()
        self.exp_measures = List[Float64]()
        self.exp_counts = List[UInt32]()
        self.exp_item_bounds = List[UInt64]()
        self.exp_batch = List[UInt64]()


def load_pipe_fixture(path: String) raises -> PipeFixture:
    var f = open(path, "r")
    var raw = f.read_bytes()
    f.close()
    var r = Reader(raw^)

    if Int(r.u32()) != PIPE_MAGIC:
        raise Error(path + ": bad magic (not a .pipe.bin fixture)")
    if Int(r.u32()) != 3:
        raise Error(path + ": unknown fixture version (expected v3 — regenerate)")

    var fx = PipeFixture()
    fx.byte_len = Int(r.u32())
    fx.item_count = Int(r.u32())
    var block_index_len = Int(r.u32())
    var blocks_len = Int(r.u32())

    fx.bytes = r.take_bytes(fx.byte_len)
    var block_index = List[UInt32](capacity=block_index_len)
    for _ in range(block_index_len):
        block_index.append(r.u32())
    # v2 stores trie blocks as f64 VALUES in entry-major lane order
    # [GLYPH_ID, ADVANCE, HEIGHT, FLAGS] — which is why the corpus survived the
    # trie's container moving on BOTH sides of the oracle: the format carries
    # values, and each loader realizes its own container. This one splits by
    # carrier: measures to f32 (exact for anything that was f32 to begin with),
    # the identity and bitfield to native u32.
    var entries = blocks_len // 4
    var blocks_m = List[Float32](capacity=entries * 2)
    var blocks_c = List[UInt32](capacity=entries * 2)
    for _ in range(entries):
        var gid = r.f64()
        var adv = r.f64()
        var h = r.f64()
        var fl = r.f64()
        blocks_m.append(Float32(adv))
        blocks_m.append(Float32(h))
        blocks_c.append(UInt32(gid))
        blocks_c.append(UInt32(fl))
    fx.trie = Trie(block_index^, blocks_m^, blocks_c^)

    for _ in range(fx.item_count):
        var it = Item()
        it.byte_start = Int(r.u32())
        it.byte_count = Int(r.u32())
        it.origin_x = r.f64()
        it.origin_y = r.f64()
        it.origin_z = r.f64()
        # THE BOUNDARY: v2 carries item params as f64 VALUES; the five integer
        # page-geometry params truncate HERE, once, instead of at every read.
        it.wrap_width = trunc_nonneg(r.f64())
        it.z_step = r.f64()
        it.line_height = r.f64()
        it.has_page = r.f64() > 0.5
        it.page_rows = trunc_nonneg(r.f64())
        it.page_cols = trunc_nonneg(r.f64())
        it.scroll_rows = trunc_nonneg(r.f64())
        it.pages_wide = trunc_nonneg(r.f64())
        it.page_gap_x = r.f64()
        it.band_stride_y = r.f64()
        it.depth_per_band = r.f64()
        it.depth_per_col = r.f64()
        it.page_line_height = r.f64()
        fx.items.append(it.copy())

    fx.exp_leaders = Int(r.u32())
    var miss_count = Int(r.u32())
    for _ in range(miss_count):
        fx.exp_misses.append(r.u32())
    for _ in range(fx.byte_len):
        fx.exp_ord.append(r.u32())
    for _ in range(fx.byte_len * FIXTURE_MEASURE_STRIDE):
        fx.exp_measures.append(r.f64())
    for _ in range(fx.byte_len * FIXTURE_COUNT_STRIDE):
        fx.exp_counts.append(r.u32())
    for _ in range(fx.item_count * 8):
        fx.exp_item_bounds.append(r.u64())
    for _ in range(8):
        fx.exp_batch.append(r.u64())
    return fx^


def nan_lanes(measures: List[Float32], total_lanes: Int, mut first: Int) -> Int:
    """Count measure lanes holding NaN. `first` receives the first offending index.

    WHY THIS EXISTS, and it is not hypothetical. Every suite compares measures BY
    BITS — `got.to_bits() != Float32(exp).to_bits()`. That is deliberate: bit
    equality is the contract. But it means two NaNs COMPARE EQUAL AND PASS, and a
    NaN is never a correct value for any lane in this buffer: X/Y/Z/BASE_X/LINE_ADV
    /ADVANCE/HEIGHT are real quantities and GLYPH_ID is an identity.

    Found by the render side, not by us: deleting the oracle's lineHeight fallback
    turned three test lanes to NaN, and the oracle and the scan produced IDENTICAL
    NaN bit patterns (2143289344 on both sides). Their float comparison caught it
    only by the accident of NaN != NaN. Ours is a bit comparison and has no such
    accident — it would have reported GREEN on two equally-wrong values.

    So the equality check cannot police this and a separate invariant must. This is
    the same family as every other trap this week: a comparison that agrees is not
    the same as a comparison that is right."""
    var bad = 0
    first = -1
    for i in range(total_lanes):
        var b = UInt32(measures[i].to_bits())
        # NaN: exponent all ones AND a nonzero mantissa. Infinity is NOT NaN and is
        # caught by the bit comparison like any other value, so do not fold it in.
        if (b & 0x7F800000) == 0x7F800000 and (b & 0x007FFFFF) != 0:
            bad += 1
            if first < 0:
                first = i
    return bad
