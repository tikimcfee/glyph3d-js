# blob_bench.mojo — the corpus resident in RAM, laid in size-targeted JOBS.
#
# stream_bench measures the shape the app has today: read a file, lay it, move on.
# That conflates two very different costs, and the conflation produced a wrong
# conclusion once already (see the README's correction). This separates them:
#
#   LOAD   read every file into one contiguous blob. Paid ONCE.
#   LAY    run the pipeline over job-sized batches of that blob. Paid per relayout.
#
# The blob is also the answer to "how do we batch": items become ranges into one
# buffer, so a job is a contiguous SPAN OF ITEMS rather than a packing step. That
# is what the arena always wanted to be, and it is the natural GPU upload unit too.
#
# Run: mojo run -I engine engine/bench/blob_bench.mojo <fixture.pipe.bin> <manifest> <job_mb>

from std.sys import argv
from std.time import perf_counter_ns
from std.memory import memcpy
from glyph_schema import MEASURE_STRIDE, COUNT_STRIDE
from glyph_pipeline import Item, run_pipeline
from fixture_io import load_pipe_fixture


def main() raises:
    var args = argv()
    if len(args) < 4:
        print("usage: mojo run -I engine engine/bench/blob_bench.mojo <fixture.pipe.bin> <manifest> <job_mb>")
        return
    var seed = load_pipe_fixture(String(args[1]))
    var mf = open(String(args[2]), "r")
    var manifest = mf.read()
    mf.close()
    var paths = manifest.split("\n")
    var job_bytes = Int(Float64(String(args[3]))) * 1048576

    # ── LOAD: paid once ─────────────────────────────────────────────────────
    var t0 = perf_counter_ns()
    # Geometric growth + memcpy. A byte-at-a-time append loop runs at ~2.4 GB/s
    # (930 MB/s when the source is a large cold blob); memcpy does ~12.3 GB/s. At
    # 1.4 GB of corpus that difference is seconds, not noise.
    var cap = 1 << 24
    var blob = List[UInt8](unsafe_uninit_length=cap)
    var used = 0
    var starts = List[Int]()
    var lens = List[Int]()
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
            continue
        if len(bytes) == 0:
            continue
        var nb = len(bytes)
        while used + nb > cap:
            cap *= 2
            var grown = List[UInt8](unsafe_uninit_length=cap)
            memcpy(dest=grown.unsafe_ptr(), src=blob.unsafe_ptr(), count=used)
            blob = grown^
        starts.append(used)
        lens.append(nb)
        memcpy(dest=blob.unsafe_ptr() + used, src=bytes.unsafe_ptr(), count=nb)
        used += nb
    var load_ns = perf_counter_ns() - t0
    var mb = Float64(used) / 1048576.0

    # ── LAY: paid per relayout ──────────────────────────────────────────────
    var t1 = perf_counter_ns()
    var jobs = 0
    var glyphs = 0
    var peak_scratch = 0
    var i = 0
    while i < len(starts):
        var j = i
        var span = 0
        while j < len(starts) and (span == 0 or span + lens[j] <= job_bytes):
            span += lens[j]
            j += 1
        var base = starts[i]
        var slice = List[UInt8](unsafe_uninit_length=span)
        memcpy(dest=slice.unsafe_ptr(), src=blob.unsafe_ptr() + base, count=span)
        var items = List[Item]()
        for q in range(i, j):
            var it = Item()
            it.byte_start = starts[q] - base
            it.byte_count = lens[q]
            it.line_height = 1
            items.append(it^)
        var scratch = span * (MEASURE_STRIDE + COUNT_STRIDE) * 4
        if scratch > peak_scratch:
            peak_scratch = scratch
        var r = run_pipeline(slice, seed.trie, items)
        glyphs += r.leaders
        jobs += 1
        i = j
    var lay_ns = perf_counter_ns() - t1

    print("items            ", len(starts))
    print("blob             ", used, "B =", mb, "MB")
    print("item table       ", len(starts) * 16, "B")
    print("")
    print("LOAD (once)      ", Float64(load_ns) / 1e9, "s =", mb / (Float64(load_ns) / 1e9), "MB/s")
    print("LAY  (per pass)  ", Float64(lay_ns) / 1e9, "s =", mb / (Float64(lay_ns) / 1e9), "MB/s")
    print("   ", jobs, "jobs of <=", job_bytes // 1048576, "MB,", glyphs, "glyphs")
    print("    peak scratch", Float64(peak_scratch) / 1048576.0, "MB")
    print("")
    print("load is", Float64(load_ns) * 100.0 / Float64(load_ns + lay_ns), "% of a cold pass")
