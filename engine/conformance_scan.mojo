# conformance_scan.mojo — the scan form vs the oracle's fixtures, tiered.
#
# Runs run_scan_pipeline (the GPU's dispatch structure, serially) over the same
# .pipe.bin fixtures the serial port is proven on, at TWO tunings — the default
# (64/256) and a deliberately awkward one (7/3) that puts chunk seams inside
# multi-byte sequences and fold units. Comparison is the repo's own tiered
# contract (tools/scan-layout.test.mjs):
#
#   - non-leader slots: every lane bit-equal
#   - EXACT lanes (id, advance, height, row, col, flags, ord): bit-equal
#   - fold>0 measure lanes (M_X, M_Y, M_Z, M_BASE_X): bit-equal — resolveX's forward
#     f32 re-sum IS the serial segAdv
#   - foldless measure lanes + M_LINE_ADV: ≤ 1e-4 RELATIVE (serial f64 prefix vs the
#     scan's f32 grouping — differs by construction; integers never do)
#   - bounds: totalRows exact; float lanes ≤ 1e-4 relative (inf compares by bits)
#   - leaders / misses / ordToByte: exact
#
# Run: mojo run -I engine engine/conformance_scan.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from std.memory import bitcast
from glyph_schema import (
    MEASURE_STRIDE, COUNT_STRIDE, C_FLAGS, measure_lane_name,
    M_X, M_Y, M_Z, M_BASE_X, M_LINE_ADV,
)
from glyph_pipeline import Item, F_LEADER, trunc_nonneg
from glyph_scan import run_scan_pipeline
from fixture_io import PipeFixture, load_pipe_fixture

comptime MAX_PRINTED = 12
comptime REL_EPS = 1e-4



def item_fold(it: Item) -> Int:
    var wrap = trunc_nonneg(it.wrap_width)
    if wrap > 0:
        return wrap
    return trunc_nonneg(it.page_cols) if it.has_page else 0


def rel_close(a: Float64, b: Float64) -> Bool:
    if UInt64(a.to_bits()) == UInt64(b.to_bits()):
        return True  # covers ±inf and exact equality
    var mag = abs(a)
    if mag < 1.0:
        mag = 1.0
    return abs(a - b) / mag <= REL_EPS


def check_case(path: String, chunk_size: Int, group_size: Int) raises -> Int:
    var fx = load_pipe_fixture(path)
    var got = run_scan_pipeline(fx.bytes, fx.trie, fx.items, chunk_size, group_size)

    # Per-byte fold unit (which comparison tier a float lane gets).
    var folds = List[Int]()
    var i = 0
    while i < fx.item_count:
        var f = item_fold(fx.items[i])
        for _ in range(fx.items[i].byte_count):
            folds.append(f)
        i += 1

    var bad = 0
    var printed = 0

    if got.leaders != fx.exp_leaders:
        print("  leaders:", got.leaders, "expected", fx.exp_leaders)
        bad += 1
    if len(got.misses) != len(fx.exp_misses):
        print("  misses count:", len(got.misses), "expected", len(fx.exp_misses))
        bad += 1
    for i2 in range(fx.byte_len):
        if got.ord_to_byte[i2] != fx.exp_ord[i2]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  ordToByte[", i2, "]:", got.ord_to_byte[i2], "expected", fx.exp_ord[i2])
                printed += 1

    for slot in range(fx.byte_len):
        var o = slot * MEASURE_STRIDE
        var is_leader = (Int(fx.exp_counts[slot * COUNT_STRIDE + C_FLAGS]) & F_LEADER) != 0
        for lane in range(MEASURE_STRIDE):
            var idx = o + lane
            var g32 = got.measures[idx]
            var e32 = Float32(fx.exp_measures[idx])
            var bits_equal = UInt32(g32.to_bits()) == UInt32(e32.to_bits())
            var lane_ok: Bool
            if not is_leader:
                lane_ok = bits_equal  # non-leader lanes never differ
            elif lane == M_X or lane == M_Y or lane == M_Z or lane == M_BASE_X:
                if folds[slot] > 0:
                    lane_ok = bits_equal  # fold>0 float lanes must be bit-exact
                else:
                    lane_ok = rel_close(Float64(e32), Float64(g32))
            elif lane == M_LINE_ADV:
                lane_ok = rel_close(Float64(e32), Float64(g32))
            else:
                lane_ok = bits_equal  # the EXACT lanes
            if not lane_ok:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  slot", slot, "lane", lane, ": got", g32, "expected", e32)
                    printed += 1

    for i2 in range(fx.item_count * 8 + 8):
        var g: Float64
        var e: Float64
        var which: String
        if i2 < fx.item_count * 8:
            g = got.item_bounds[i2]
            e = bitcast[DType.float64](fx.exp_item_bounds[i2])
            which = "itemBounds[" + String(i2 // 8) + "][" + String(i2 % 8) + "]"
        else:
            g = got.batch_bounds[i2 - fx.item_count * 8]
            e = bitcast[DType.float64](fx.exp_batch[i2 - fx.item_count * 8])
            which = "batchBounds[" + String(i2 - fx.item_count * 8) + "]"
        var lane = i2 % 8
        var ok: Bool
        if lane == 6:
            ok = UInt64(g.to_bits()) == UInt64(e.to_bits())  # totalRows: exact
        else:
            ok = rel_close(e, g)
        if not ok:
            bad += 1
            if printed < MAX_PRINTED:
                print("  ", which, ": got", g, "expected", e)
                printed += 1

    return bad


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance_scan.mojo <fixture.pipe.bin> ...")
        return
    var total_bad = 0
    var failed = 0
    for i in range(1, len(args)):
        var path = String(args[i])
        # Default tuning + an awkward one that puts chunk seams everywhere.
        var bad = check_case(path, 64, 256) + check_case(path, 7, 3)
        if bad == 0:
            print("PASS", path, "(K=64/G=256 and K=7/G=3)")
        else:
            print("FAIL", path, "—", bad, "mismatches")
            failed += 1
        total_bad += bad
    if total_bad == 0:
        print("scan conformance: all cases within the tiered contract")
    else:
        print("scan conformance:", failed, "case(s) failed,", total_bad, "mismatches")
        raise Error("scan conformance failed")
