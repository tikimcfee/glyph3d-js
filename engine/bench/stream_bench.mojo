# stream_bench.mojo — streaming a whole DIRECTORY, and what the arena costs.
#
# The scaling benchmark measured one big file. That is not the shape the app has:
# a repo is tens of thousands of items, not one 28MB blob. This measures the shape
# that matters, and the claim the record format exists to make:
#
#   SCRATCH is per-JOB and reused, so it stays flat no matter how large the corpus.
#   RECORDS are per-GLYPH and resident, so they grow with content and nothing else.
#
# Under the old arena both of those were one number — 48 B per source byte held for
# the corpus's lifetime, so the ceiling was a function of total bytes. Here the
# ceiling is a function of the LARGEST SINGLE ITEM, and the resident cost is a
# function of rendered glyphs. Those are different questions with different answers,
# which is the whole point of separating them.
#
# Takes a manifest (one path per line) so the walk is the shell's job, not this
# file's — `find <dir> -type f > manifest`.
#
# Run: mojo run -I engine engine/bench/stream_bench.mojo <fixture.pipe.bin> <manifest>

from std.sys import argv
from std.time import perf_counter_ns
from glyph_schema import MEASURE_STRIDE, COUNT_STRIDE, RECORD_BYTES
from glyph_pipeline import Item, Trie, run_pipeline
from glyph_record import RecordSet, compact
from fixture_io import load_pipe_fixture


def main() raises:
    var args = argv()
    if len(args) < 3:
        print("usage: mojo run -I engine engine/bench/stream_bench.mojo <fixture.pipe.bin> <manifest>")
        return
    var seed = load_pipe_fixture(String(args[1]))
    # --count: stream and measure WITHOUT accumulating records. The full linux tree
    # would need ~44GB of records to hold at once, which is the finding rather than
    # a limitation of the harness — see the note this prints at the end.
    var count_only = len(args) > 3 and String(args[3]) == "--count"

    var mf = open(String(args[2]), "r")
    var manifest = mf.read()
    mf.close()
    var paths = manifest.split("\n")

    var total_bytes = 0
    var total_glyphs = 0
    var peak_scratch = 0
    var files = 0
    var skipped = 0
    var records = RecordSet()

    var t0 = perf_counter_ns()
    for pi in range(len(paths)):
        var path = String(paths[pi]).strip()
        if path.byte_length() == 0:
            continue
        var bytes: List[UInt8]
        try:
            var f = open(path, "r")
            bytes = f.read_bytes()
            f.close()
        except:
            skipped += 1
            continue
        var n = len(bytes)
        if n == 0:
            continue

        var it = Item()
        it.byte_start = 0
        it.byte_count = n
        it.line_height = 1
        var items = List[Item]()
        items.append(it^)

        # THE SCRATCH POOL. Allocated for this job, dropped at the end of this
        # iteration. Its high-water mark is the largest single item, never the sum.
        var scratch = n * (MEASURE_STRIDE + COUNT_STRIDE) * 4
        if scratch > peak_scratch:
            peak_scratch = scratch
        var r = run_pipeline(bytes, seed.trie, items)
        if not count_only:
            compact(r.measures, r.counts, n, records)

        total_bytes += n
        total_glyphs += r.leaders
        files += 1
    var ns = perf_counter_ns() - t0

    var glyph_total = total_glyphs if count_only else records.glyphs
    var resident = glyph_total * RECORD_BYTES
    var old_arena = total_bytes * (MEASURE_STRIDE + COUNT_STRIDE) * 4
    var mb = Float64(total_bytes) / 1048576.0
    print("files            ", files, "(", skipped, "unreadable )")
    print("source bytes     ", total_bytes, "=", mb, "MB")
    print("glyphs           ", total_glyphs)
    print("")
    print("PEAK SCRATCH     ", peak_scratch, "B =", Float64(peak_scratch) / 1048576.0, "MB")
    print("   (the largest single item, not the sum — this is the arena ceiling now)")
    print("RESIDENT RECORDS ", resident, "B =", Float64(resident) / 1048576.0, "MB")
    print("   (", RECORD_BYTES, "B x", glyph_total, "rendered glyphs )")
    print("")
    print("old arena would need", old_arena, "B =", Float64(old_arena) / 1048576.0, "MB")
    print("   (", (MEASURE_STRIDE + COUNT_STRIDE) * 4, "B x every source byte, corpus lifetime )")
    if resident > 0:
        print("resident reduction  ", Float64(old_arena) / Float64(resident), "x")
    if peak_scratch > 0:
        print("peak live vs old    ", Float64(old_arena) / Float64(peak_scratch + resident), "x")
    print("")
    print("elapsed", Float64(ns) / 1e6, "ms =", mb / (Float64(ns) / 1e9), "MB/s")
    if count_only:
        print("")
        print("(--count: records were NOT accumulated. The number above is what holding")
        print(" this corpus resident WOULD cost, which is the point: compaction bounds")
        print(" the SCRATCH, it does not make an unbounded corpus free. Past a certain")
        print(" size residency needs eviction, not just a smaller record.)")
