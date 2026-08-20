# ordinal_invariant.mojo — the check a fixture diff structurally CANNOT make.
#
# The conformance suites compare the port against the JS oracle bit-for-bit. That
# catches any divergence between them — but it is blind to a fault they SHARE.
# The f32 ordinal wall is exactly such a fault: `ord` is computed exactly on both
# sides (a JS number; a Mojo Int) and quantized only on the store into an f32
# lane. Past 2^24 both sides round identically, so the differ reports PASS while
# both are wrong together. A correlated error is invisible to a differential test.
#
# This checks an INVARIANT instead, referencing no oracle at all. The same fact —
# "which glyph is the n-th leader of this item" — is recorded twice in different
# types:
#
#   slots[o + S_ORD]                       f32 lane   (lossy past 2^24)
#   ord_to_byte[item.byte_start + ord]     u32 array  (exact to 2^32)
#
# So the u32 array is an independent, exact witness for the lossy lane, and
# round-tripping one through the other must be the identity:
#
#   ord_to_byte[byte_start + Int(slots[o + S_ORD])] == id      for every leader
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
from glyph_pipeline import (
    run_pipeline, Item, Trie, PipelineResult,
    SLOT_STRIDE, S_ORD, S_FLAGS, F_LEADER,
)
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
            var o = id * SLOT_STRIDE
            if (Int(result.slots[o + S_FLAGS]) & F_LEADER) != 0:
                var lane = Int(result.slots[o + S_ORD])
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


def synthetic_item_case(trie: Trie, n_bytes: Int) raises -> Int:
    """One item of `n_bytes` single-byte leaders — the shape that breaks the lane."""
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

    print("\nboundary probe (single item, one leader per byte):")
    var under = synthetic_item_case(fx.trie, wall - 2)
    print("  ", wall - 2, "bytes →", under, "aliased —", "OK" if under == 0 else "UNEXPECTED")
    var over = synthetic_item_case(fx.trie, wall + 2)
    print("  ", wall + 2, "bytes →", over, "aliased —", "the wall, observed" if over > 0 else "NOT OBSERVED")

    if total_bad != 0:
        raise Error("ordinal invariant violated on a real fixture")
    if under != 0:
        raise Error("false positive below the wall — checker is wrong")
    if over == 0:
        raise Error("checker did not fire above the wall — it proves nothing")
    print("\nordinal invariant: holds on every fixture; fires exactly at 2^24 per item")
