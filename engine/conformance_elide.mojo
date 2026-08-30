# conformance_elide.mojo — the two instantiations of the serial fold, adjudicating
# each other.
#
# run_pipeline[witness=True] (what every other suite runs) also fills the witness
# tier: LINE_ADV, ORD, ord_to_byte. run_pipeline[witness=False] (what production
# streaming runs) writes only the render-read arrays. The elided form is the one
# nothing else executes under verification — precisely the instantiation that
# would otherwise be trusted on the argument "it's the same code with three
# stores gated out." That argument is a proof about a counterfactual, so this
# suite tests the counterfactual instead of believing it:
#
#   1. sm / fl / lm / lc, misses, leaders, item and batch bounds: BIT-IDENTICAL
#      between the instantiations, every byte, every fixture. A witness gate that
#      accidentally swallows a render-read store fails here and nowhere else.
#   2. The elided result's witness Lists have length 1 — the dummy allocation
#      that keeps pointers valid. This is the "something that changes when
#      nothing happens": quietly reintroducing corpus-scale witness allocation
#      (the ~12 B/byte this elision exists to reclaim) flips these lengths, so
#      the regression cannot land silently even though it would stay CORRECT.
#
# The record path has its own version of this proof: conformance_record streams
# ELIDED through the scratch pool and pins the records byte-identical to the
# witnessed whole-corpus lay.
#
# Run: mojo run -I engine engine/conformance_elide.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from glyph_schema import SM_STRIDE, LM_STRIDE, LC_STRIDE
from glyph_pipeline import run_pipeline
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance_elide.mojo <fixture.pipe.bin> ...")
        return
    var failures = 0
    for a in range(1, len(args)):
        var fx = load_pipe_fixture(String(args[a]))
        var wit = run_pipeline(fx.bytes, fx.trie, fx.items)
        var eli = run_pipeline[witness=False](fx.bytes, fx.trie, fx.items)
        var bad = 0
        var printed = 0

        # ── 1. render-read arrays: bit-identical ────────────────────────────
        for i in range(fx.byte_len * SM_STRIDE):
            if wit.sm[i].to_bits() != eli.sm[i].to_bits():
                bad += 1
                if printed < MAX_PRINTED:
                    print("  sm[", i, "] witnessed", wit.sm[i], "elided", eli.sm[i])
                    printed += 1
        for i in range(fx.byte_len):
            if wit.fl[i] != eli.fl[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  fl[", i, "] witnessed", wit.fl[i], "elided", eli.fl[i])
                    printed += 1
        for i in range(fx.byte_len * LM_STRIDE):
            if wit.lm[i].to_bits() != eli.lm[i].to_bits():
                bad += 1
                if printed < MAX_PRINTED:
                    print("  lm[", i, "] witnessed", wit.lm[i], "elided", eli.lm[i])
                    printed += 1
        for i in range(fx.byte_len * LC_STRIDE):
            if wit.lc[i] != eli.lc[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  lc[", i, "] witnessed", wit.lc[i], "elided", eli.lc[i])
                    printed += 1

        # ── results carried beside the arrays ───────────────────────────────
        if wit.leaders != eli.leaders:
            bad += 1
            print("  leaders witnessed", wit.leaders, "elided", eli.leaders)
        if len(wit.misses) != len(eli.misses):
            bad += 1
            print("  miss count witnessed", len(wit.misses), "elided", len(eli.misses))
        else:
            for i in range(len(wit.misses)):
                if wit.misses[i] != eli.misses[i]:
                    bad += 1
                    if printed < MAX_PRINTED:
                        print("  miss[", i, "] witnessed", wit.misses[i],
                              "elided", eli.misses[i])
                        printed += 1
        for i in range(len(wit.item_bounds)):
            if wit.item_bounds[i].to_bits() != eli.item_bounds[i].to_bits():
                bad += 1
                if printed < MAX_PRINTED:
                    print("  itemBounds[", i, "] witnessed", wit.item_bounds[i],
                          "elided", eli.item_bounds[i])
                    printed += 1
        for i in range(8):
            if wit.batch_bounds[i].to_bits() != eli.batch_bounds[i].to_bits():
                bad += 1
                print("  batchBounds[", i, "] witnessed", wit.batch_bounds[i],
                      "elided", eli.batch_bounds[i])

        # ── 2. the elision actually elides ──────────────────────────────────
        if len(eli.wm) != 1 or len(eli.wc) != 1 or len(eli.ord_to_byte) != 1:
            bad += 1
            print("  elided witness Lists are", len(eli.wm), "/", len(eli.wc),
                  "/", len(eli.ord_to_byte), "— expected 1/1/1: corpus-scale",
                  "witness allocation is back")
        if len(wit.wm) != fx.byte_len or len(wit.wc) != fx.byte_len:
            bad += 1
            print("  witnessed witness Lists are", len(wit.wm), "/", len(wit.wc),
                  "— expected byte_len", fx.byte_len)

        if bad > 0:
            failures += 1
            print("FAIL", String(args[a]), "—", bad, "mismatches")
        else:
            print("PASS", String(args[a]))
    if failures > 0:
        raise Error("elide conformance failed")
    print("elide conformance: witnessed and elided instantiations bit-identical")
    print("on every render-read array; the elided form allocates no witness tier.")
