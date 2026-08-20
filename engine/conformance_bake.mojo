# conformance_bake.mojo — replay bake fixtures through the native bake, diff bits.
#
# Loads fixtures written by engine/fixtures/gen-bake.mjs and checks the full seed
# protocol: the streaming record (totals, checkpoints, scalars, box, histogram,
# census/missing) AND the query side — checkpoint-seeded prefixAt, lanesFromPrefix
# at several wraps, rowsUnderWrap. f64 lanes compare as u64 bit patterns; counts
# compare exactly.
#
# Run: mojo run -I engine engine/conformance_bake.mojo engine/fixtures/*.bake.bin

from std.sys import argv
from std.memory import bitcast
from glyph_pipeline import Trie
from glyph_bake import (
    ScanElem,
    BakeRecord,
    bake_file,
    prefix_at,
    lanes_from_prefix,
    rows_under_wrap,
    CK_STRIDE,
)

comptime MAGIC = 0x42443347
comptime MAX_PRINTED = 12


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


def elem7(e: ScanElem) -> List[Float64]:
    var out = List[Float64]()
    out.append(Float64(e.reset))
    out.append(Float64(e.nl))
    out.append(Float64(e.glyphs))
    out.append(Float64(e.rows))
    out.append(Float64(e.head_len))
    out.append(Float64(e.tail_len))
    out.append(Float64(e.tail_adv))
    return out^


def check_int(name: String, got: Int, expected: Int, mut bad: Int, mut printed: Int):
    if got != expected:
        bad += 1
        if printed < MAX_PRINTED:
            print("  ", name, ": got", got, "expected", expected)
            printed += 1


def check_f64(
    name: String, got: Float64, expected: Float64, mut bad: Int, mut printed: Int
):
    if UInt64(got.to_bits()) != UInt64(expected.to_bits()):
        bad += 1
        if printed < MAX_PRINTED:
            print("  ", name, ": got", got, "expected", expected)
            printed += 1


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
    var block_index_len = Int(r.u32())
    var blocks_len = Int(r.u32())
    var line_height = r.f64()
    var interval = Int(r.u32())

    var bytes = r.take_bytes(byte_len)
    var block_index = List[UInt32](capacity=block_index_len)
    for _ in range(block_index_len):
        block_index.append(r.u32())
    var blocks = List[Float32](capacity=blocks_len)
    for _ in range(blocks_len):
        blocks.append(r.f32())
    var trie = Trie(block_index^, blocks^)

    var got = bake_file(bytes, trie, line_height, interval)

    var bad = 0
    var printed = 0

    check_int("leaders", got.leaders, Int(r.u32()), bad, printed)
    check_int("newlines", got.newlines, Int(r.u32()), bad, printed)
    check_int("totalRows", got.total_rows, Int(r.u32()), bad, printed)
    check_int("maxLineLen", got.max_line_len, Int(r.u32()), bad, printed)
    check_f64("maxRowExtent", got.max_row_extent, r.f64(), bad, printed)
    check_f64("maxLineWidth", got.max_line_width, r.f64(), bad, printed)
    check_f64("maxHeight", got.max_height, r.f64(), bad, printed)
    var exp_has_box = Int(r.u32()) != 0
    if got.has_box != exp_has_box:
        bad += 1
        print("  hasBox: got", got.has_box, "expected", exp_has_box)
    for i in range(6):
        var e = r.f64()
        if exp_has_box and got.has_box:
            check_f64("box[" + String(i) + "]", got.box[i], e, bad, printed)

    var exp_total = List[Float64]()
    for _ in range(7):
        exp_total.append(r.f64())
    var got_total = elem7(got.total)
    for i in range(7):
        check_f64("total[" + String(i) + "]", got_total[i], exp_total[i], bad, printed)

    var ck_count = Int(r.u32())
    check_int("ckCount", len(got.checkpoints) // CK_STRIDE, ck_count, bad, printed)
    for i in range(ck_count * CK_STRIDE):
        var e = r.f64()
        if i < len(got.checkpoints):
            check_f64("checkpoint[" + String(i) + "]", got.checkpoints[i], e, bad, printed)

    var hist_count = Int(r.u32())
    check_int("histBins", len(got.hist_lens), hist_count, bad, printed)
    for i in range(hist_count):
        var e_len = Int(r.u32())
        var e_count = Int(r.u32())
        if i < len(got.hist_lens):
            check_int("hist len[" + String(i) + "]", got.hist_lens[i], e_len, bad, printed)
            check_int("hist count[" + String(i) + "]", got.hist_counts[i], e_count, bad, printed)

    var census_count = Int(r.u32())
    check_int("censusCount", len(got.census), census_count, bad, printed)
    for i in range(census_count):
        var e = Int(r.u32())
        if i < len(got.census):
            check_int("census[" + String(i) + "]", got.census[i], e, bad, printed)
    var missing_count = Int(r.u32())
    check_int("missingCount", len(got.missing), missing_count, bad, printed)
    for i in range(missing_count):
        var e = Int(r.u32())
        if i < len(got.missing):
            check_int("missing[" + String(i) + "]", got.missing[i], e, bad, printed)

    # ── The query side: checkpoint-seeded random access ─────────────────────
    var pq_count = Int(r.u32())
    for q in range(pq_count):
        var byte_index = Int(r.u32())
        var wrap = Int(r.u32())
        var p = prefix_at(bytes, trie, got, byte_index)
        var got_p = elem7(p)
        for i in range(7):
            var e = r.f64()
            check_f64(
                "prefix@" + String(byte_index) + "[" + String(i) + "]",
                got_p[i], e, bad, printed,
            )
        var lanes = lanes_from_prefix(p, wrap)
        check_int("row@" + String(byte_index) + "w" + String(wrap), lanes.row, Int(r.u32()), bad, printed)
        check_int("col@" + String(byte_index), lanes.col, Int(r.u32()), bad, printed)
        check_int("ord@" + String(byte_index), lanes.ord, Int(r.u32()), bad, printed)
        check_f64("lineAdv@" + String(byte_index), Float64(lanes.line_adv), r.f64(), bad, printed)
        _ = q

    var wq_count = Int(r.u32())
    for _ in range(wq_count):
        var wrap = Int(r.u32())
        var e_rows = Int(r.u32())
        check_int("rowsUnderWrap(" + String(wrap) + ")", rows_under_wrap(got, wrap), e_rows, bad, printed)

    return bad


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance_bake.mojo <fixture.bake.bin> ...")
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
        print("bake conformance: all cases bit-exact")
    else:
        print("bake conformance:", failed_cases, "case(s) failed,", total_bad, "mismatches")
        raise Error("bake conformance failed")
