# fixture_io.mojo — shared loader for the .pipe.bin conformance fixtures.
#
# One Reader (little-endian, packed) + the 'G3DF' pipeline-fixture parse, shared by
# conformance.mojo (oracle-form) and conformance_scan.mojo (scan-form) so the two
# runners can never drift on the format. Format spec: engine/fixtures/gen.mjs.

from std.memory import bitcast
from glyph_pipeline import Trie, Item, SLOT_STRIDE

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
    var exp_slot_bits: List[UInt32]
    var exp_item_bounds: List[UInt64]
    var exp_batch: List[UInt64]

    def __init__(out self):
        self.byte_len = 0
        self.item_count = 0
        self.bytes = List[UInt8]()
        self.trie = Trie(List[UInt32](), List[Float32]())
        self.items = List[Item]()
        self.exp_leaders = 0
        self.exp_misses = List[UInt32]()
        self.exp_ord = List[UInt32]()
        self.exp_slot_bits = List[UInt32]()
        self.exp_item_bounds = List[UInt64]()
        self.exp_batch = List[UInt64]()


def load_pipe_fixture(path: String) raises -> PipeFixture:
    var f = open(path, "r")
    var raw = f.read_bytes()
    f.close()
    var r = Reader(raw^)

    if Int(r.u32()) != PIPE_MAGIC:
        raise Error(path + ": bad magic (not a .pipe.bin fixture)")
    if Int(r.u32()) != 1:
        raise Error(path + ": unknown fixture version")

    var fx = PipeFixture()
    fx.byte_len = Int(r.u32())
    fx.item_count = Int(r.u32())
    var block_index_len = Int(r.u32())
    var blocks_len = Int(r.u32())

    fx.bytes = r.take_bytes(fx.byte_len)
    var block_index = List[UInt32](capacity=block_index_len)
    for _ in range(block_index_len):
        block_index.append(r.u32())
    var blocks = List[Float32](capacity=blocks_len)
    for _ in range(blocks_len):
        blocks.append(r.f32())
    fx.trie = Trie(block_index^, blocks^)

    for _ in range(fx.item_count):
        var it = Item()
        it.byte_start = Int(r.u32())
        it.byte_count = Int(r.u32())
        it.origin_x = r.f64()
        it.origin_y = r.f64()
        it.origin_z = r.f64()
        it.wrap_width = r.f64()
        it.z_step = r.f64()
        it.line_height = r.f64()
        it.has_page = r.f64() > 0.5
        it.page_rows = r.f64()
        it.page_cols = r.f64()
        it.scroll_rows = r.f64()
        it.pages_wide = r.f64()
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
    for _ in range(fx.byte_len * SLOT_STRIDE):
        fx.exp_slot_bits.append(r.u32())
    for _ in range(fx.item_count * 8):
        fx.exp_item_bounds.append(r.u64())
    for _ in range(8):
        fx.exp_batch.append(r.u64())
    return fx^
