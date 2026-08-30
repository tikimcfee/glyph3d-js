# conformance.mojo — replay oracle fixtures through the native pipeline, diff bits.
#
# Loads fixtures written by engine/fixtures/gen.mjs (the JS oracle's inputs and
# answers) and runs run_pipeline. The assertion is SCOPE B (the contract's tiers,
# applied to the corpus):
#
#   bit-for-bit   the WIRE — fixture measure lanes 0-5 (X Y Z ADVANCE HEIGHT
#                 GLYPH_ID) as u32 patterns, counts ROW/COL/FLAGS exactly, f64
#                 bounds as u64 patterns, leaders and misses exactly. No
#                 tolerances — a tolerance would hide exactly the
#                 grouping-dependent float drift this suite exists to catch.
#   semantic      the ord witness (ordToByte[byteStart + ord] == id, ords a
#                 permutation per item) in place of pinning ORD's value and
#                 ordToByte's contents.
#   unasserted    BASE_X, LINE_ADV — fold scratch; container choices a
#                 specialized backend may re-lay or elide. Pinned where they are
#                 load-bearing instead: conformance_scan reads them through X.
#
# (The scan form compares TIERED instead — conformance_scan.mojo — because
# foldless float lanes differ from the serial fold by construction.)
#
# Run: mojo run -I engine engine/conformance.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from std.memory import bitcast
from glyph_schema import (
    LM_STRIDE, SM_STRIDE,
    FIXTURE_MEASURE_STRIDE, FIXTURE_COUNT_STRIDE,
    fixture_measure_lane_name, fixture_count_lane_name,
)
from glyph_pipeline import run_pipeline, F_LEADER, F_RENDERED
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
    # THE ORD WITNESS replaces the ordToByte value pin. Under scope B the
    # fixture asserts the CONTRACT (record fields bit-exact) plus SEMANTIC
    # invariants; ord_to_byte contents and the ORD lane are container scratch a
    # specialized backend may re-lay or elide. What the pipeline OWES is the
    # schema's witness — ordToByte[byteStart + ord] == id for every rendered
    # leader, ordinals a permutation of [0, leaders) per item — which asserts the
    # PROPERTY rather than one implementation's realization of it, and which
    # catches the same corruption class better (a value pin passes any two
    # implementations that share a fault; the witness is checked against got's
    # own flags, a different failure mode).
    for it_i in range(fx.item_count):
        var it_start = fx.items[it_i].byte_start
        var it_stop = it_start + fx.items[it_i].byte_count
        var seen = List[Bool](length=(it_stop - it_start) if it_stop > it_start else 1, fill=False)
        for id in range(it_start, it_stop):
            if id >= fx.byte_len:
                break
            var f = Int(got.fl[id])
            if (f & F_LEADER) == 0 or (f & F_RENDERED) == 0:
                continue
            var ordv = got.c_at(id, 3)
            var q = it_start + Int(ordv)
            if q >= fx.byte_len or Int(got.ord_to_byte[q]) != id:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ord witness: item", it_i, "byte", id, "ord", ordv)
                    printed += 1
            elif Int(ordv) < len(seen):
                if seen[Int(ordv)]:
                    bad += 1
                    if printed < MAX_PRINTED:
                        print("  ord duplicate: item", it_i, "ord", ordv)
                        printed += 1
                seen[Int(ordv)] = True

    # NaN sweep BEFORE the bit comparison. The comparison below is bit equality,
    # so matching NaNs on both sides pass it; nothing else in this file can see that.
    # The sweep covers BOTH float arrays — the split means a NaN can hide in
    # either phase.
    var nan_first = -1
    var nan_count = nan_lanes(got.lm, fx.byte_len * LM_STRIDE, nan_first)
    nan_count += nan_lanes(got.sm, fx.byte_len * SM_STRIDE, nan_first)
    # The witness measure array too: LINE_ADV left the render-read container in
    # the read-axis split, and the sweep must not silently shrink with it.
    nan_count += nan_lanes(got.wm, fx.byte_len, nan_first)
    if nan_count > 0:
        bad += nan_count
        print("  NaN in", nan_count, "measure lane(s); first flat index", nan_first)

    for slot in range(fx.byte_len):
        # MEASURES: f64 values narrowed to f32 and compared as bits — in FIXTURE
        # order, mapped onto the phase arrays by m_at. The fixture format is
        # frozen; the container is not, and the suites must never notice a
        # container change (that is what m_at/c_at exist for).
        # SCOPE B: lanes 0-5 are the RECORD (the wire) — bit-exact. Lanes 6-7
        # (BASE_X, LINE_ADV) are fold scratch: load-bearing INPUTS where a later
        # stage reads them (paginate reads BASE_X, the scan form's foldless x
        # reads LINE_ADV), so corruption still surfaces in the pinned X — but
        # their VALUES are a container choice the backend may elide. Asserting
        # them was the faithful-port era pinning HOW; the contract pins WHAT.
        for lane in range(6):
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
        for lane in range(3):  # ROW, COL, FLAGS; ORD is the witness's, above
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
