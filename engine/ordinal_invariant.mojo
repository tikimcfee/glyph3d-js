# ordinal_invariant.mojo — the check a fixture diff structurally CANNOT make.
#
# The conformance suites compare the port against the JS oracle bit-for-bit. That
# catches any divergence between them — but it is blind to a fault they SHARE.
# The f32 ordinal wall WAS exactly such a fault: `ord` was computed exactly on
# both sides (a JS number; a Mojo Int) and quantized only on the store into an
# f32 lane. Past 2^24 both sides rounded identically, so the differ reported
# PASS while both were wrong together. The lanes are u32 today and the wall is
# gone — this suite is what proves it STAYS gone (its mutation deliberately puts
# the f32 carrier back). A correlated error is invisible to a differential test.
#
# This checks an INVARIANT instead, referencing no oracle at all. The same fact —
# "which glyph is the n-th leader of this item" — is recorded twice in different
# types:
#
#   lc[id * LC_STRIDE + LC_ORD]            u32 count  (exact to 2^32)
#   ord_to_byte[item.byte_start + ord]     u32 array  (exact to 2^32)
#
# So the u32 array is an independent, exact witness for the lossy lane, and
# round-tripping one through the other must be the identity:
#
#   ord_to_byte[byte_start + ord] == id    for every leader
#
# When two leaders alias onto one ordinal, the later store wins and the earlier
# glyph's round-trip lands on the wrong byte. The check fails loudly, with no
# expected-output file involved.
#
# Note this is a PER-ITEM bound, not a per-arena one: `ord` resets to 0 for each
# item (glyph_pipeline.mojo, layout loop), and ord_to_byte is indexed relative to
# byte_start. A 100MB arena of ordinary files is perfectly safe; ONE item past
# 2^24 bytes is not. The arena's global 2^24 cap in the JS side is a conservative
# proxy for this rule — it bounds the total because, in principle, one item could
# be the whole arena.
#
# Run: mojo run -I engine engine/ordinal_invariant.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from glyph_schema import LC_STRIDE, LC_ORD
from glyph_pipeline import run_pipeline, Item, Trie, PipelineResult, F_LEADER
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 6


def check_ordinals(result: PipelineResult, items: List[Item]) -> Int:
    """Round-trip every leader's f32 ordinal lane through the u32 witness."""
    var bad = 0
    var printed = 0
    for i in range(len(items)):
        var start = items[i].byte_start
        var stop = start + items[i].byte_count
        var id = start
        while id < stop:
            if (Int(result.fl[id]) & F_LEADER) != 0:
                var lane = Int(result.lc[id * LC_STRIDE + LC_ORD])
                var witness = Int(result.ord_to_byte[start + lane])
                if witness != id:
                    bad += 1
                    if printed < MAX_PRINTED:
                        print(
                            "  item", i, "byte", id, "— ordinal lane", lane,
                            "round-trips to byte", witness,
                            "(aliased: the lane cannot represent this ordinal)",
                        )
                        printed += 1
            id += 1
    return bad


def synthetic_item_case(trie: Trie, n_bytes: Int, force_f32_ordinal: Bool = False) raises -> Int:
    """One item of `n_bytes` single-byte leaders.

    `force_f32_ordinal` re-introduces the OLD carrier by round-tripping the ordinal
    through an f32 after the fact. The real wall is gone — ORD is a native u32 count
    now — so without this the boundary probe has nothing left to catch and the
    checker would be decorative. This is how it stays provably live: the mutation
    is built into the runner rather than applied by hand."""
    var bytes = List[UInt8](unsafe_uninit_length=n_bytes)
    for i in range(n_bytes):
        bytes[i] = UInt8(97)  # 'a': one byte, one leader, no newline
    var it = Item()
    it.byte_start = 0
    it.byte_count = n_bytes
    it.line_height = 1
    var items = List[Item]()
    items.append(it^)
    var result = run_pipeline(bytes, trie, items)
    if force_f32_ordinal:
        for id in range(n_bytes):
            if (Int(result.fl[id]) & F_LEADER) != 0:
                var ord = Int(result.lc[id * LC_STRIDE + LC_ORD])
                result.lc[id * LC_STRIDE + LC_ORD] = UInt32(Int(Float32(ord)))
    return check_ordinals(result, items)


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/ordinal_invariant.mojo <fixture.pipe.bin> ...")
        return

    # 1. Every real fixture must satisfy the invariant (proves the check is sane).
    var total_bad = 0
    var trie_src = String(args[1])
    for i in range(1, len(args)):
        var path = String(args[i])
        var fx = load_pipe_fixture(path)
        var result = run_pipeline(fx.bytes, fx.trie, fx.items)
        var bad = check_ordinals(result, fx.items)
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "aliased ordinal(s)")
        total_bad += bad

    # 2. The mutation test: prove the check can FAIL. One item just under the
    #    wall must pass; one item just over it must not. If the "over" case
    #    passes, this checker is decorative and must not be trusted.
    var fx = load_pipe_fixture(trie_src)
    var wall = 1 << 24

    # THE WALL FELL. ORD is a native u32 count, so an item past 2^24 no longer
    # aliases. The probe therefore asserts the opposite of what it once did — and
    # then re-introduces the f32 carrier deliberately, because a check that can no
    # longer fail proves nothing (CLAUDE.md: a green must be earned).
    print("\nboundary probe (single item, one leader per byte):")
    var over = synthetic_item_case(fx.trie, wall + 2)
    print("  ", wall + 2, "bytes, u32 ordinal ->", over, "aliased —",
          "the wall is gone" if over == 0 else "UNEXPECTED: still aliasing")
    var forced = synthetic_item_case(fx.trie, wall + 2, True)
    print("  ", wall + 2, "bytes, f32 ordinal ->", forced, "aliased —",
          "the checker is live" if forced > 0 else "DECORATIVE: it cannot fail")

    if total_bad != 0:
        raise Error("ordinal invariant violated on a real fixture")
    if over != 0:
        raise Error("a u32 ordinal aliased past 2^24 — the migration is incomplete")
    if forced == 0:
        raise Error("the f32-carrier mutation did not fire — this checker is decorative")
    print("\nordinal invariant: holds on every fixture; the 2^24 wall is gone,")
    print("and the checker still fires when the f32 carrier is put back.")
