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
from glyph_pipeline import run_pipeline, Item, Trie, F_LEADER
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

    if bad != 0:
        raise Error("gap conformance failed")
    print("gap conformance: unclaimed bytes stay defined (the memset is not missed)")
