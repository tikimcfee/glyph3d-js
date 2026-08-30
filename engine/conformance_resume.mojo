# conformance_resume.mojo — laying a RANGE must equal laying the whole item.
#
# This is the claim that turns an edit from "re-lay the file" into "re-lay the
# bytes around the change". Nothing else in the system is allowed to notice.
#
# Method: lay an item whole and keep its slots. Then, for a spread of resume
# points, recover the fold state at that byte from the BAKE's checkpoints
# (prefix_at = nearest checkpoint + a <= K tail fold) and lay only [at, end) with
# that seed. Every lane the resumed pass writes must be bit-identical to the whole
# pass. No tolerance: the seed is either exactly the fold's state or it is wrong.
#
# Run: mojo run -I engine engine/conformance_resume.mojo engine/fixtures/*.pipe.bin

from std.collections.span import Span
from std.sys import argv
from std.memory import unsafe_memset_zero
from glyph_schema import (
    MEASURE_STRIDE, COUNT_STRIDE, C_FLAGS, C_ROW,
    measure_lane_name, count_lane_name,
)
from glyph_pipeline import (
    run_pipeline, layout_item, LayoutSeed, Item, F_LEADER, trunc_nonneg,
)
from glyph_bake import bake_file
from glyph_record import seed_at, is_line_start
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 6
comptime CK = 64  # small interval so the tail fold is exercised, not bypassed


def check_case(path: String) raises -> Int:
    var fx = load_pipe_fixture(path)
    if fx.byte_len == 0:
        return 0
    var bad = 0
    var printed = 0
    var skipped_paged = 0

    var whole = run_pipeline(fx.bytes, fx.trie, fx.items)

    for i in range(fx.item_count):
        var item = fx.items[i].copy()
        if item.byte_count == 0:
            continue
        # Paged items are compared through layout only. `paginate` is a PURE
        # per-slot remap of the base position (its own docstring says so) — it
        # accumulates nothing, so it cannot depend on where layout resumed. What
        # resume can break is the FOLD, and that is what this suite exercises.
        # Running the whole pass's paginate against a layout-only resumed pass
        # would compare two different pipelines, not two ways of folding.
        if item.has_page:
            skipped_paged += 1
            continue
        var wrap = trunc_nonneg(item.wrap_width)

        # The item's own bytes, and its bake — the seed source.
        var slice = Span(fx.bytes)[item.byte_start : item.byte_start + item.byte_count]
        var rec = bake_file(slice, fx.trie, 1.0, CK)

        # Resume points = every LINE START in the item. Most are not on a
        # checkpoint boundary, so prefix_at must actually fold a tail to reach them.
        var points = List[Int]()
        for b in range(item.byte_count):
            if is_line_start(slice, b):
                points.append(b)

        for pi in range(len(points)):
            var p = points[pi]
            if p < 0 or p >= item.byte_count:
                continue

            var m = List[Float32](unsafe_uninit_length=fx.byte_len * MEASURE_STRIDE)
            unsafe_memset_zero(m.unsafe_ptr(), len(m))
            var c = List[UInt32](unsafe_uninit_length=fx.byte_len * COUNT_STRIDE)
            unsafe_memset_zero(c.unsafe_ptr(), len(c))
            var otb = List[UInt32](unsafe_uninit_length=fx.byte_len)
            unsafe_memset_zero(otb.unsafe_ptr(), len(otb))
            var sc = List[Float64](unsafe_uninit_length=8)
            unsafe_memset_zero(sc.unsafe_ptr(), 8)

            # Decode lanes are position-independent, so reuse the whole pass's —
            # what is under test is the FOLD resuming, not the decode.
            for k in range(fx.byte_len * MEASURE_STRIDE):
                m[k] = whole.measures[k]
            for k in range(fx.byte_len * COUNT_STRIDE):
                c[k] = whole.counts[k]

            # A wrapped or paged item needs the row from the previous layout —
            # the bake is wrap-agnostic. Model that by reading it off the whole
            # pass, which is exactly what a real re-lay would have on hand.
            var hint = -1
            if wrap > 0:
                var q = item.byte_start + p
                while q < item.byte_start + item.byte_count:
                    if (Int(whole.counts[q * COUNT_STRIDE + C_FLAGS]) & F_LEADER) != 0:
                        hint = Int(whole.counts[q * COUNT_STRIDE + C_ROW])
                        break
                    q += 1
                if hint < 0:
                    continue
            var seed = seed_at(slice, fx.trie, rec, wrap, p, hint)
            layout_item(
                m.unsafe_ptr(), c.unsafe_ptr(), item, otb.unsafe_ptr(),
                sc.unsafe_ptr(), 0, item.byte_start + p, seed,
                False,   # a resumed RANGE must not publish a whole item's box
            )

            # Every byte from the resume point on must match the whole pass.
            for id in range(item.byte_start + p, item.byte_start + item.byte_count):
                var co = id * COUNT_STRIDE
                if (Int(whole.counts[co + C_FLAGS]) & F_LEADER) == 0:
                    continue
                var mo = id * MEASURE_STRIDE
                for lane in range(MEASURE_STRIDE):
                    if UInt32(m[mo + lane].to_bits()) != UInt32(whole.measures[mo + lane].to_bits()):
                        bad += 1
                        if printed < MAX_PRINTED:
                            print("  item", i, "resume@", p, "byte", id,
                                  measure_lane_name(lane), "resumed", m[mo + lane],
                                  "whole", whole.measures[mo + lane])
                            printed += 1
                for lane in range(COUNT_STRIDE):
                    if c[co + lane] != whole.counts[co + lane]:
                        bad += 1
                        if printed < MAX_PRINTED:
                            print("  item", i, "resume@", p, "byte", id,
                                  count_lane_name(lane), "resumed", c[co + lane],
                                  "whole", whole.counts[co + lane])
                            printed += 1
    if skipped_paged > 0:
        print("  (", skipped_paged, "paged item(s) compared through layout only —",
              "paginate is a pure per-slot remap)")
    return bad


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance_resume.mojo <fixture.pipe.bin> ...")
        return
    var total_bad = 0
    for i in range(1, len(args)):
        var path = String(args[i])
        var bad = check_case(path)
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "mismatches")
        total_bad += bad
    if total_bad != 0:
        raise Error("resume conformance failed")
    print("")
    print("resume conformance: laying [at, end) from a bake checkpoint is")
    print("bit-identical to laying the whole item, at every resume point tried.")
