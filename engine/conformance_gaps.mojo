# conformance_gaps.mojo — bytes no item claims must still be DEFINED.
#
# Every checked-in fixture has items tiling [0, byte_len) exactly, so no fixture
# exercises a gap. That made a silent hazard: the driver used to memset the slot
# buffers, so gap bytes read as zeros by accident rather than by design. Dropping
# the memset (decode now writes every lane) only stays correct because decode
# covers ALL bytes — and nothing in the suite proved that until this file.
#
# The failure this guards against is not a wrong number, it is UNINITIALIZED
# MEMORY: an adversarial review of a fused prototype that dropped both the memset
# and full-range decode observed ord_to_byte values of 3758096384 and 1073661922 —
# raw allocator garbage, nondeterministic, leaking a previous job's memory. No
# existing fixture would have caught it.
#
# Run: mojo run -I engine engine/conformance_gaps.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from glyph_schema import MEASURE_STRIDE, COUNT_STRIDE, C_FLAGS
from glyph_pipeline import run_pipeline, Item, Trie, F_LEADER, F_MISSING
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8


def check(name: String, fx_bytes: List[UInt8], trie: Trie, items: List[Item]) -> Int:
    """Every byte outside every item must have all lanes defined (zero)."""
    var n = len(fx_bytes)
    var claimed = List[Bool](unsafe_uninit_length=n)
    for i in range(n):
        claimed[i] = False
    for i in range(len(items)):
        for b in range(items[i].byte_start, items[i].byte_start + items[i].byte_count):
            if b >= 0 and b < n:
                claimed[b] = True

    var r = run_pipeline(fx_bytes, trie, items)
    var bad = 0
    var printed = 0
    var gaps = 0
    for id in range(n):
        if claimed[id]:
            continue
        gaps += 1
        var co = id * COUNT_STRIDE
        # decode may legitimately set the DECODE lanes of a gap byte (it covers the
        # whole range); what must never happen is an UNWRITTEN lane. Check the ones
        # only the fold writes — those have no other writer for a gap byte.
        for k in range(COUNT_STRIDE):
            if k == C_FLAGS:
                continue
            if r.counts[co + k] != 0:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", name, "gap byte", id, "count lane", k, "=",
                          r.counts[co + k], "(expected 0)")
                    printed += 1
    # ordToByte past each item's glyph count must also be defined
    for i in range(len(items)):
        var start = items[i].byte_start
        for q in range(start, start + items[i].byte_count):
            if r.ord_to_byte[q] > UInt32(n):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  ", name, "ordToByte[", q, "] =", r.ord_to_byte[q],
                          "which is past byte_len", n, "— uninitialized")
                    printed += 1
    print("  ", name, ":", gaps, "gap bytes,", bad, "defects")
    return bad


def check_miss_order(trie: Trie, n: Int) -> Int:
    """Misses must come out in BYTE order, across shard boundaries.

    V2 collects misses per decode SHARD and concatenates in shard order, which is
    byte order because shards are contiguous ascending ranges tiling [0, n). No
    fixture proves that: repo-file has 7 misses in 4096 bytes, and with 4 shards
    they all land in one, so reversing the concatenation changes nothing and the
    mutation does not fire.

    This builds a corpus with misses deliberately SPREAD across the whole range,
    then recomputes the expected list the way the old serial pass did — ascending
    byte order, duplicates kept — and compares. That is the property, checked
    directly rather than via a fixture that cannot discriminate."""
    var bytes = List[UInt8](unsafe_uninit_length=n)
    # Alternate a codepoint the trie has with one it does not, so misses appear
    # every few bytes for the entire length and therefore in EVERY shard.
    for i in range(n):
        bytes[i] = UInt8(97 + (i % 3)) if (i % 7) != 0 else UInt8(64 + (i % 26))
    var items = List[Item]()
    items.append(mk(0, n))
    var r = run_pipeline(bytes, trie, items)

    # the serial reference: ascending byte order, duplicates kept
    var want = List[UInt32]()
    for id in range(n):
        var f = Int(r.counts[id * COUNT_STRIDE + C_FLAGS])
        if (f & F_LEADER) != 0 and (f & F_MISSING) != 0:
            want.append(UInt32(Int(bytes[id])))
    var bad = 0
    if len(r.misses) != len(want):
        print("   miss-order   : got", len(r.misses), "misses, expected", len(want))
        bad += 1
    else:
        var printed = 0
        for i in range(len(want)):
            if r.misses[i] != want[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("   miss-order   : miss[", i, "] =", r.misses[i],
                          "expected", want[i])
                    printed += 1
    print("   miss-order   :", len(want), "misses spread over", n, "bytes,", bad, "defects")
    return bad


def mk(start: Int, count: Int) -> Item:
    var it = Item()
    it.byte_start = start
    it.byte_count = count
    it.line_height = 1
    return it^


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance_gaps.mojo <fixture.pipe.bin>")
        return
    var fx = load_pipe_fixture(String(args[1]))
    var n = len(fx.bytes)
    var bad = 0

    # 1. leading gap
    var a = List[Item]()
    a.append(mk(n // 3, n - n // 3))
    bad += check("leading-gap ", fx.bytes, fx.trie, a)

    # 2. trailing gap
    var b = List[Item]()
    b.append(mk(0, n // 2))
    bad += check("trailing-gap", fx.bytes, fx.trie, b)

    # 3. hole in the middle
    var c = List[Item]()
    c.append(mk(0, n // 4))
    c.append(mk(3 * n // 4, n - 3 * n // 4))
    bad += check("middle-hole ", fx.bytes, fx.trie, c)

    # 4. no items at all — every byte is a gap
    var d = List[Item]()
    bad += check("no-items    ", fx.bytes, fx.trie, d)

    # misses must be byte-ordered across shard boundaries (V2's whole claim)
    bad += check_miss_order(fx.trie, 40000)

    if bad != 0:
        raise Error("gap conformance failed")
    print("gap conformance: unclaimed bytes stay defined (the memset is not missed)")
