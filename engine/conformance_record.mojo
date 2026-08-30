# conformance_record.mojo — the record format, proven two ways.
#
# 1. TRUNCATION. Every record must equal the render-read prefix of the slot it came
#    from, bit-for-bit. This is what makes "compact" a copy rather than a transform:
#    if a record ever differs from its source prefix, the schema's ordering promise
#    has been broken and the record format has silently become a repack.
#
# 2. DECOUPLING. Laying the corpus item-by-item through a scratch pool must produce
#    EXACTLY the records that laying it whole produces. That is the claim the whole
#    scratch-pool design rests on — if streaming changed a single bit, the arena
#    could not be decoupled from the corpus without changing what is rendered.
#
# Run: mojo run -I engine engine/conformance_record.mojo engine/fixtures/*.pipe.bin

from std.sys import argv
from glyph_schema import (
    FIXTURE_MEASURE_STRIDE, FIXTURE_COUNT_STRIDE,
    RECORD_MEASURE_STRIDE, RECORD_COUNT_STRIDE, RECORD_BYTES,
)
from glyph_pipeline import run_pipeline, F_LEADER
from glyph_record import RecordSet, compact, run_streaming
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 6


def check_case(path: String) raises -> Int:
    var fx = load_pipe_fixture(path)
    var bad = 0
    var printed = 0

    var r = run_pipeline(fx.bytes, fx.trie, fx.items)
    var whole = RecordSet()
    compact(r, fx.byte_len, r.leaders, whole)

    # ── 1. the truncation holds ──────────────────────────────────────────────
    if whole.glyphs != r.leaders:
        bad += 1
        print("  record count", whole.glyphs, "!= leaders", r.leaders)
    var rec = 0
    for id in range(fx.byte_len):
        if (Int(r.fl[id]) & F_LEADER) == 0:
            continue
        # The record's measure order IS the fixture's measure order for the first
        # six lanes, so m_at(slot, k) is the per-slot expectation.
        for k in range(RECORD_MEASURE_STRIDE):
            var g = UInt32(whole.measures[rec * RECORD_MEASURE_STRIDE + k].to_bits())
            var e = UInt32(r.m_at(id, k).to_bits())
            if g != e:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  byte", id, "measure lane", k, "— record", g, "slot", e)
                    printed += 1
        for k in range(RECORD_COUNT_STRIDE):
            if whole.counts[rec * RECORD_COUNT_STRIDE + k] != r.c_at(id, k):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  byte", id, "count lane", k)
                    printed += 1
        rec += 1

    # ── 2. streaming through a scratch pool changes nothing ──────────────────
    var streamed = run_streaming(fx.bytes, fx.trie, fx.items, 4096)
    if streamed.glyphs != whole.glyphs:
        bad += 1
        print("  streamed", streamed.glyphs, "records vs whole", whole.glyphs)
    else:
        for i in range(whole.glyphs * RECORD_MEASURE_STRIDE):
            if UInt32(streamed.measures[i].to_bits()) != UInt32(whole.measures[i].to_bits()):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  streamed measure", i, streamed.measures[i], "vs", whole.measures[i])
                    printed += 1
        for i in range(whole.glyphs * RECORD_COUNT_STRIDE):
            if streamed.counts[i] != whole.counts[i]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  streamed count", i, streamed.counts[i], "vs", whole.counts[i])
                    printed += 1
    return bad


def main() raises:
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/conformance_record.mojo <fixture.pipe.bin> ...")
        return
    var total_bad = 0
    var bytes_total = 0
    var glyphs_total = 0
    for i in range(1, len(args)):
        var path = String(args[i])
        var bad = check_case(path)
        var fx = load_pipe_fixture(path)
        var r = run_pipeline(fx.bytes, fx.trie, fx.items)
        bytes_total += fx.byte_len
        glyphs_total += r.leaders
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "mismatches")
        total_bad += bad

    var slot_bytes = bytes_total * (FIXTURE_MEASURE_STRIDE + FIXTURE_COUNT_STRIDE) * 4
    var rec_bytes = glyphs_total * RECORD_BYTES
    print("")
    print("resident cost over the fixture corpus:")
    print("  slots  ", slot_bytes, "B  (", bytes_total, "source bytes x",
          (FIXTURE_MEASURE_STRIDE + FIXTURE_COUNT_STRIDE) * 4, "B )")
    print("  records", rec_bytes, "B  (", glyphs_total, "glyphs x", RECORD_BYTES, "B )")
    if rec_bytes > 0:
        print("  ratio  ", Float64(slot_bytes) / Float64(rec_bytes), "x smaller resident")

    if total_bad != 0:
        raise Error("record conformance failed")
    print("")
    print("record conformance: truncation is bit-exact, and streaming through a")
    print("scratch pool produces byte-identical records to laying the corpus whole.")
