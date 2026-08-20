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
from glyph_pipeline import run_pipeline, SLOT_STRIDE
from fixture_io import PipeFixture, load_pipe_fixture

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

    for slot in range(fx.byte_len):
        for lane in range(SLOT_STRIDE):
            var idx = slot * SLOT_STRIDE + lane
            var g = UInt32(got.slots[idx].to_bits())
            # THE CLASSIFICATION SITE. The fixture carries values; this line
            # says how the slot buffer represents them. Every lane is f32 today,
            # so every expected value narrows to f32 and compares as bits. When a
            # lane's representation changes, it changes HERE — not in the corpus.
            var e = UInt32(Float32(fx.exp_slots[idx]).to_bits())
            if g != e:
                bad += 1
                if printed < MAX_PRINTED:
                    print(
                        "  slot", slot, lane_name(lane),
                        ": got", got.slots[idx], "(", g, ") expected",
                        bitcast[DType.float32](e), "(", e, ")",
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
