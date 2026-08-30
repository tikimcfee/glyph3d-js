# lane_write_bench.mojo — WHICH write shape is dispatch 1 actually paying for?
#
# The trie agent measured decode at 18.45ms full vs 3.89ms readonly (4.8x) and
# called it "at the memory roofline". That number is real but it does not say
# WHICH of two very different things costs it:
#
#   (a) STORE COUNT  — 12 lanes written per byte (pre-split), 8 fold-overwritten.
#   (b) LINE TRAFFIC — MEASURE_STRIDE=8 f32 (32B) + COUNT_STRIDE=4 u32 (16B) means
#                      every slot dirties 48B of cache line, and write-allocate
#                      writes back the whole line whether you touched 4 lanes or 12.
#
# If (a), dropping decode's dead stores wins. If (b), it wins NOTHING and the only
# lever is narrowing the array decode touches.
#
# Every variant writes the SAME 4 values decode actually produces
# (ADVANCE, HEIGHT, GLYPH_ID, FLAGS). They differ only in the container.
#
# Run: mojo run -I engine --fp-mode contract=off engine/bench/lane_write_bench.mojo

from std.time import perf_counter_ns
from std.runtime.asyncrt import TaskGroup, parallelism_level

comptime N = 8_000_000        # slots == source bytes in one 8MB job
comptime REPS = 7


def shard_lo(stop: Int, workers: Int, w: Int) -> Int:
    var per = (stop + workers - 1) // workers
    var a = w * per
    return a if a < stop else stop


# ── A: the pre-split shape. 8 f32 + 4 u32 per slot, all 12 lanes written. ───
async def _aos_full[so: Origin[mut=True], xo: Origin[mut=True]](
    m: Pointer[Float32, so], c: Pointer[UInt32, xo], start: Int, stop: Int,
):
    for i in range(start, stop):
        var mo = i * 8
        var co = i * 4
        var g = Float32(i & 1023)
        m[unsafe_offset = mo + 3] = g          # ADVANCE
        m[unsafe_offset = mo + 4] = g          # HEIGHT
        m[unsafe_offset = mo + 5] = g          # GLYPH_ID
        m[unsafe_offset = mo + 0] = 2.5        # X      \
        m[unsafe_offset = mo + 1] = 2.5        # Y       | the 8 lanes the fold
        m[unsafe_offset = mo + 2] = 2.5        # Z       | overwrites for every
        m[unsafe_offset = mo + 6] = 2.5        # BASE_X  | leader inside an item
        m[unsafe_offset = mo + 7] = 2.5        # LINE_ADV/
        c[unsafe_offset = co + 2] = UInt32(i & 7)   # FLAGS
        c[unsafe_offset = co + 0] = 911        # ROW    \
        c[unsafe_offset = co + 1] = 911        # COL     | dead too
        c[unsafe_offset = co + 3] = 911        # ORD    /


# ── B: dead stores gone. Same arrays, same strides, only the 4 real lanes. ──
async def _aos_sparse[so: Origin[mut=True], xo: Origin[mut=True]](
    m: Pointer[Float32, so], c: Pointer[UInt32, xo], start: Int, stop: Int,
):
    for i in range(start, stop):
        var mo = i * 8
        var g = Float32(i & 1023)
        m.unsafe_store[width=2](mo + 3, SIMD[DType.float32, 2](g, g))
        m[unsafe_offset = mo + 5] = g
        c[unsafe_offset = i * 4 + 2] = UInt32(i & 7)


# ── C: split by PHASE. Decode owns a stride-4 f32 array + a stride-1 u32 one. ─
#      Same dense addressing: still indexed by source byte offset.
#      One 16B aligned store per slot; 4 slots per cache line.
async def _split4[so: Origin[mut=True], xo: Origin[mut=True]](
    m: Pointer[Float32, so], c: Pointer[UInt32, xo], start: Int, stop: Int,
):
    for i in range(start, stop):
        var g = Float32(i & 1023)
        m.unsafe_store[width=4](i * 4, SIMD[DType.float32, 4](g, g, g, 0))
        c[unsafe_offset=i] = UInt32(i & 7)


# ── D: floor. The trie agent's "readonly" shape — 4B/slot, nothing else. ─────
async def _floor[xo: Origin[mut=True]](
    c: Pointer[UInt32, xo], start: Int, stop: Int,
):
    for i in range(start, stop):
        c[unsafe_offset=i] = UInt32(i & 7)


# ── E: the 48-BYTE INTERLEAVED record a reviewer assumed variant A was. 48 divides
#      neither 64 nor 128, so every 4th slot STRADDLES a cache line and dirties two.
#      A does NOT have this shape — it is two arrays at 32B and 16B, both powers of
#      two, both line-aligned. This variant exists to price the straddle so the
#      A-vs-C comparison cannot be attributed to alignment.
async def _interleaved48[so: Origin[mut=True]](
    m: Pointer[Float32, so], start: Int, stop: Int,
):
    for i in range(start, stop):
        var o = i * 12
        var g = Float32(i & 1023)
        m[unsafe_offset = o + 3] = g
        m[unsafe_offset = o + 4] = g
        m[unsafe_offset = o + 5] = g
        m[unsafe_offset = o + 0] = 2.5
        m[unsafe_offset = o + 1] = 2.5
        m[unsafe_offset = o + 2] = 2.5
        m[unsafe_offset = o + 6] = 2.5
        m[unsafe_offset = o + 7] = 2.5
        m[unsafe_offset = o + 8] = 2.5
        m[unsafe_offset = o + 9] = 2.5
        m[unsafe_offset = o + 10] = 2.5
        m[unsafe_offset = o + 11] = 2.5


def main() raises:
    var workers = parallelism_level()
    if workers < 1:
        workers = 1
    print("slots:", N, " workers:", workers)

    var m_aos = List[Float32](unsafe_uninit_length=N * 8)
    var c_aos = List[UInt32](unsafe_uninit_length=N * 4)
    var m_s4 = List[Float32](unsafe_uninit_length=N * 4)
    var c_s1 = List[UInt32](unsafe_uninit_length=N)
    var mp = m_aos.unsafe_ptr()
    var cp = c_aos.unsafe_ptr()
    var sp = m_s4.unsafe_ptr()
    var qp = c_s1.unsafe_ptr()

    # dirtied = bytes of CACHE LINE the variant touches per slot (what DRAM sees)
    # stored  = bytes the variant actually issues stores for (what the ISA sees)
    var m_il = List[Float32](unsafe_uninit_length=N * 12)
    var ip = m_il.unsafe_ptr()
    var names: List[String] = ["A aos_full  ", "B aos_sparse", "C split4    ",
                               "D floor     ", "E interlv48 "]
    var dirtied: List[Int] = [48, 48, 20, 4, 48]
    var stored: List[Int] = [48, 16, 20, 4, 48]

    for v in range(5):
        var best = 1 << 62
        for r in range(REPS + 1):          # rep 0 = warm-up (first-touch faults)
            var t0 = perf_counter_ns()
            var tg = TaskGroup()
            for w in range(workers):
                var a = shard_lo(N, workers, w)
                var b = shard_lo(N, workers, w + 1)
                if v == 0:
                    tg.create_task(_aos_full(mp, cp, a, b))
                elif v == 1:
                    tg.create_task(_aos_sparse(mp, cp, a, b))
                elif v == 2:
                    tg.create_task(_split4(sp, qp, a, b))
                elif v == 3:
                    tg.create_task(_floor(qp, a, b))
                else:
                    tg.create_task(_interleaved48(ip, a, b))
            tg.wait()
            var dt = perf_counter_ns() - t0
            if r > 0 and dt < best:
                best = dt
        var ms = Float64(best) / 1e6
        var gbs_d = Float64(N * dirtied[v]) / Float64(best)
        var gbs_s = Float64(N * stored[v]) / Float64(best)
        print(
            names[v],
            " ", ms, "ms   dirtied", dirtied[v], "B/slot =", gbs_d, "GB/s",
            "  stored", stored[v], "B/slot =", gbs_s, "GB/s",
        )

    # keep every buffer live
    # PROOF the dead stores executed. Only variant A writes these lanes, and it
    # writes a sentinel, not 0 — over an uninit buffer, 0 could not distinguish
    # "the store ran" from "the store was eliminated".
    var ok = (m_aos[0] == 2.5 and m_aos[7] == 2.5 and c_aos[0] == 911
              and c_aos[N * 4 - 1] == 911)
    print("dead-lane sentinels landed:", ok,
          " (X=", m_aos[0], " LINE_ADV=", m_aos[7], " ROW=", c_aos[0],
          " last ORD=", c_aos[N * 4 - 1], ")")
    print("probe:", m_aos[5], c_aos[2], m_s4[2], c_s1[7], m_il[11])
