# conformance.mojo — replay oracle fixtures through the native pipeline, diff bits.
#
# Loads fixtures written by engine/fixtures/gen.mjs (the JS oracle's inputs and
# answers), runs run_pipeline, and compares BIT-FOR-BIT: f32 slot lanes as u32
# patterns, f64 bounds as u64 patterns, integer outputs exactly. No tolerances —
# a tolerance would hide exactly the grouping-dependent float drift this rig
# exists to catch.
#
# Run: mojo run -I engine engine/conformance.mojo engine/fixtures/*.bin

from std.sys import argv
from std.memory import bitcast
from glyph_pipeline import (
    Trie,
    Item,
    run_pipeline,
    SLOT_STRIDE,
)

comptime MAGIC = 0x46443347
comptime MAX_PRINTED = 12

def lane_name(lane: Int) -> String:
    var names = List[String]()
    names.append("S_GLYPH_ID")
    names.append("S_ADVANCE")
    names.append("S_HEIGHT")
    names.append("S_X")
    names.append("S_Y")
    names.append("S_Z")
    names.append("S_ROW")
    names.append("S_COL")
    names.append("S_FLAGS")
    names.append("S_BASE_X")
    names.append("S_LINE_ADV")
    names.append("S_ORD")
    return names[lane]


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


def check_case(path: String) raises -> Int:
    var f = open(path, "r")
    var raw = f.read_bytes()
    f.close()
    var r = Reader(raw^)

    if Int(r.u32()) != MAGIC:
        print(path, ": bad magic")
        return 1
    if Int(r.u32()) != 1:
        print(path, ": unknown version")
        return 1
    var byte_len = Int(r.u32())
    var item_count = Int(r.u32())
    var block_index_len = Int(r.u32())
    var blocks_len = Int(r.u32())

    var bytes = r.take_bytes(byte_len)
    var block_index = List[UInt32](capacity=block_index_len)
    for _ in range(block_index_len):
        block_index.append(r.u32())
    var blocks = List[Float32](capacity=blocks_len)
    for _ in range(blocks_len):
        blocks.append(r.f32())
    var trie = Trie(block_index^, blocks^)

    var items = List[Item]()
    for _ in range(item_count):
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
        items.append(it.copy())

    var exp_leaders = Int(r.u32())
    var miss_count = Int(r.u32())
    var exp_misses = List[UInt32](capacity=miss_count)
    for _ in range(miss_count):
        exp_misses.append(r.u32())
    var exp_ord = List[UInt32](capacity=byte_len)
    for _ in range(byte_len):
        exp_ord.append(r.u32())
    var exp_slot_bits = List[UInt32](capacity=byte_len * SLOT_STRIDE)
    for _ in range(byte_len * SLOT_STRIDE):
        exp_slot_bits.append(r.u32())
    var exp_item_bounds = List[UInt64](capacity=item_count * 8)
    for _ in range(item_count * 8):
        exp_item_bounds.append(r.u64())
    var exp_batch = List[UInt64](capacity=8)
    for _ in range(8):
        exp_batch.append(r.u64())

    # ── Run the native pipeline ──────────────────────────────────────────────
    var got = run_pipeline(bytes, trie, items)

    var bad = 0
    var printed = 0

    if got.leaders != exp_leaders:
        print("  leaders:", got.leaders, "expected", exp_leaders)
        bad += 1
    if len(got.misses) != miss_count:
        print("  misses count:", len(got.misses), "expected", miss_count)
        bad += 1
    else:
        for i in range(miss_count):
            if got.misses[i] != exp_misses[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  miss[", i, "]:", got.misses[i], "expected", exp_misses[i])
                    printed += 1
    for i in range(byte_len):
        if got.ord_to_byte[i] != exp_ord[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  ordToByte[", i, "]:", got.ord_to_byte[i], "expected", exp_ord[i])
                printed += 1

    for slot in range(byte_len):
        for lane in range(SLOT_STRIDE):
            var idx = slot * SLOT_STRIDE + lane
            var g = UInt32(got.slots[idx].to_bits())
            var e = exp_slot_bits[idx]
            if g != e:
                bad += 1
                if printed < MAX_PRINTED:
                    print(
                        "  slot", slot, lane_name(lane),
                        ": got", got.slots[idx], "(", g, ") expected",
                        bitcast[DType.float32](e), "(", e, ")",
                    )
                    printed += 1

    for i in range(item_count * 8):
        var g = UInt64(got.item_bounds[i].to_bits())
        if g != exp_item_bounds[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print(
                    "  itemBounds[", i // 8, "][", i % 8, "]: got",
                    got.item_bounds[i], "expected", bitcast[DType.float64](exp_item_bounds[i]),
                )
                printed += 1
    for i in range(8):
        var g = UInt64(got.batch_bounds[i].to_bits())
        if g != exp_batch[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print(
                    "  batchBounds[", i, "]: got", got.batch_bounds[i],
                    "expected", bitcast[DType.float64](exp_batch[i]),
                )
                printed += 1

    return bad


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance.mojo <fixture.bin> ...")
        return
    var total_bad = 0
    var failed_cases = 0
    for i in range(1, len(args)):
        var path = String(args[i])
        var bad = check_case(path)
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "mismatches")
            failed_cases += 1
        total_bad += bad
    if total_bad == 0:
        print("conformance: all cases bit-exact")
    else:
        print("conformance:", failed_cases, "case(s) failed,", total_bad, "mismatches")
        raise Error("conformance failed")
