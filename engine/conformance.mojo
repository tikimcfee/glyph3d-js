# conformance.mojo — replay oracle fixtures through the native pipeline, diff bits.
#
# Loads fixtures written by engine/fixtures/gen.mjs (the JS oracle's inputs and
# answers), runs run_pipeline, and compares BIT-FOR-BIT: f32 slot lanes as u32
# patterns, f64 bounds as u64 patterns, integer outputs exactly. No tolerances —
# a tolerance would hide exactly the grouping-dependent float drift this rig
# exists to catch. (The scan form compares TIERED instead — conformance_scan.mojo —
# because foldless float lanes differ from the serial fold by construction.)
#
# Run: mojo run -I engine engine/conformance.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from std.memory import bitcast
from glyph_schema import (
    FIXTURE_MEASURE_STRIDE, FIXTURE_COUNT_STRIDE,
    fixture_measure_lane_name, fixture_count_lane_name,
)
from glyph_pipeline import run_pipeline
from fixture_io import PipeFixture, load_pipe_fixture, nan_lanes

comptime MAX_PRINTED = 12


def check_case(path: String) raises -> Int:
    var fx = load_pipe_fixture(path)
    var got = run_pipeline(fx.bytes, fx.trie, fx.items)

    var bad = 0
    var printed = 0

    if got.leaders != fx.exp_leaders:
        print("  leaders:", got.leaders, "expected", fx.exp_leaders)
        bad += 1
    if len(got.misses) != len(fx.exp_misses):
        print("  misses count:", len(got.misses), "expected", len(fx.exp_misses))
        bad += 1
    else:
        for i in range(len(fx.exp_misses)):
            if got.misses[i] != fx.exp_misses[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  miss[", i, "]:", got.misses[i], "expected", fx.exp_misses[i])
                    printed += 1
    for i in range(fx.byte_len):
        if got.ord_to_byte[i] != fx.exp_ord[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  ordToByte[", i, "]:", got.ord_to_byte[i], "expected", fx.exp_ord[i])
                printed += 1

    # NaN sweep BEFORE the bit comparison. The comparison below is bit equality,
    # so matching NaNs on both sides pass it; nothing else in this file can see that.
    # The sweep covers BOTH float arrays — the split means a NaN can hide in
    # either phase.
    var nan_first = -1
    var nan_count = nan_lanes(got.lm, fx.byte_len * 5, nan_first)
    nan_count += nan_lanes(got.sm, fx.byte_len * 4, nan_first)
    if nan_count > 0:
        bad += nan_count
        print("  NaN in", nan_count, "measure lane(s); first flat index", nan_first)

    for slot in range(fx.byte_len):
        # MEASURES: f64 values narrowed to f32 and compared as bits — in FIXTURE
        # order, mapped onto the phase arrays by m_at. The fixture format is
        # frozen; the container is not, and the suites must never notice a
        # container change (that is what m_at/c_at exist for).
        for lane in range(FIXTURE_MEASURE_STRIDE):
            var idx = slot * FIXTURE_MEASURE_STRIDE + lane
            var g = UInt32(got.m_at(slot, lane).to_bits())
            var e = UInt32(Float32(fx.exp_measures[idx]).to_bits())
            if g != e:
                bad += 1
                if printed < MAX_PRINTED:
                    print(
                        "  slot", slot, fixture_measure_lane_name(lane),
                        "got", got.m_at(slot, lane), "expected", Float32(fx.exp_measures[idx]),
                    )
                    printed += 1
        # COUNTS: exact integers. No carrier, no narrowing, no classification —
        # this comparison has no way to be subtly wrong.
        for lane in range(FIXTURE_COUNT_STRIDE):
            var idx = slot * FIXTURE_COUNT_STRIDE + lane
            if got.c_at(slot, lane) != fx.exp_counts[idx]:
                bad += 1
                if printed < MAX_PRINTED:
                    print(
                        "  slot", slot, fixture_count_lane_name(lane),
                        "got", got.c_at(slot, lane), "expected", fx.exp_counts[idx],
                    )
                    printed += 1

    for i in range(fx.item_count * 8):
        var g = UInt64(got.item_bounds[i].to_bits())
        if g != fx.exp_item_bounds[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print(
                    "  itemBounds[", i // 8, "][", i % 8, "]: got",
                    got.item_bounds[i], "expected",
                    bitcast[DType.float64](fx.exp_item_bounds[i]),
                )
                printed += 1
    for i in range(8):
        var g = UInt64(got.batch_bounds[i].to_bits())
        if g != fx.exp_batch[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print(
                    "  batchBounds[", i, "]: got", got.batch_bounds[i],
                    "expected", bitcast[DType.float64](fx.exp_batch[i]),
                )
                printed += 1

    return bad


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance.mojo <fixture.pipe.bin> ...")
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
