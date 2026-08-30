# leader_bitmap_bench.mojo — is F_LEADER worth 32 bits per source byte?
#
# Today leader-ness rides the C_FLAGS lane: 4 bytes per SOURCE byte. But it is a
# ONE-BIT predicate — a UTF-8 leader is any byte with (b & 0xC0) != 0x80. This bench
# asks whether a 1-bit-per-byte bitmap wins on BOTH sides of its life:
#
#   PRODUCE  build the bitmap vs write the u32 lane
#   CONSUME  find every leader (what compact() does) by scanning the bitmap
#            word-at-a-time and skipping 64 dead bytes at once, vs a strided
#            per-byte load of the lane
#
# The consume side is the half that is easy to forget and could sink the idea:
# a 32x smaller producer is worthless if the consumer gets slower.
#
# ARM HAS NO movemask. simdjson's trick is an x86 instruction; on NEON it must be
# emulated. Mojo's std.memory.unsafe.pack_bits does it — this measures what it costs.
#
# Run: mojo run -I engine --fp-mode contract=off engine/bench/leader_bitmap_bench.mojo

from std.time import perf_counter_ns
from std.bit import pop_count, count_trailing_zeros
from std.memory.unsafe import pack_bits

comptime N = 8_000_000          # source bytes in one 8MB job
comptime REPS = 7
comptime F_LEADER = 1


def make_corpus() -> List[UInt8]:
    """~99% ASCII with occasional 2/3/4-byte sequences — the real source-text mix."""
    var b = List[UInt8](unsafe_uninit_length=N)
    var p = b.unsafe_ptr()
    var i = 0
    var seed: UInt64 = 0x2545F4914F6CDD1D
    while i < N:
        seed ^= seed << 13
        seed ^= seed >> 7
        seed ^= seed << 17
        var r = Int(seed & 1023)
        if r < 1014 or i + 4 >= N:                 # ASCII
            p[unsafe_offset=i] = UInt8(32 + (r & 63))
            i += 1
        elif r < 1020:                             # 2-byte
            p[unsafe_offset=i] = 0xC3
            p[unsafe_offset = i + 1] = 0xA9
            i += 2
        elif r < 1022:                             # 3-byte
            p[unsafe_offset=i] = 0xE2
            p[unsafe_offset = i + 1] = 0x9C
            p[unsafe_offset = i + 2] = 0x93
            i += 3
        else:                                      # 4-byte (emoji)
            p[unsafe_offset=i] = 0xF0
            p[unsafe_offset = i + 1] = 0x9F
            p[unsafe_offset = i + 2] = 0x98
            p[unsafe_offset = i + 3] = 0x80
            i += 4
    return b^


# ── PRODUCE A: today — one u32 lane per source byte. ────────────────────────
def produce_lane(b: List[UInt8], mut flags: List[UInt32]) -> Int:
    var bp = b.unsafe_ptr()
    var fp = flags.unsafe_ptr()
    var leaders = 0
    for i in range(N):
        var v = Int(bp[unsafe_offset=i])
        if (v & 0xC0) != 0x80:
            fp[unsafe_offset=i] = F_LEADER
            leaders += 1
        else:
            fp[unsafe_offset=i] = 0
    return leaders


# ── PRODUCE B: 1 bit per byte via pack_bits, leader count from popcount. ────
def produce_bitmap(b: List[UInt8], mut bits: List[UInt64]) -> Int:
    var bp = b.unsafe_ptr()
    var wp = bits.unsafe_ptr()
    var cont = SIMD[DType.uint8, 16](0x80)
    var m6 = SIMD[DType.uint8, 16](0xC0)
    var leaders = 0
    var w = 0
    var i = 0
    while i + 64 <= N:
        # four 16-byte blocks -> one 64-bit word. The leader COUNT falls out of
        # popcount; no per-byte increment, no branch.
        var w0 = UInt64(pack_bits((bp.unsafe_load[width=16](i) & m6).ne(cont)))
        var w1 = UInt64(pack_bits((bp.unsafe_load[width=16](i + 16) & m6).ne(cont)))
        var w2 = UInt64(pack_bits((bp.unsafe_load[width=16](i + 32) & m6).ne(cont)))
        var w3 = UInt64(pack_bits((bp.unsafe_load[width=16](i + 48) & m6).ne(cont)))
        var word = w0 | (w1 << 16) | (w2 << 32) | (w3 << 48)
        wp[unsafe_offset=w] = word
        leaders += Int(pop_count(word))
        w += 1
        i += 64
    while i < N:
        if (Int(bp[unsafe_offset=i]) & 0xC0) != 0x80:
            leaders += 1
        i += 1
    return leaders


# ── CONSUME A: compact's scan today — a strided load per source byte. ───────
def consume_lane(flags: List[UInt32], mut out: List[UInt32]) -> Int:
    var fp = flags.unsafe_ptr()
    var op = out.unsafe_ptr()
    var w = 0
    for i in range(N):
        if (Int(fp[unsafe_offset=i]) & F_LEADER) != 0:
            op[unsafe_offset=w] = UInt32(i)
            w += 1
    return w


# ── CONSUME B: word scan — a zero word skips 64 bytes in one test. ──────────
def consume_bitmap(bits: List[UInt64], mut out: List[UInt32]) -> Int:
    var wp = bits.unsafe_ptr()
    var op = out.unsafe_ptr()
    var words = N // 64
    var k = 0
    for w in range(words):
        var word = wp[unsafe_offset=w]
        var base = w * 64
        while word != 0:
            var t = Int(count_trailing_zeros(word))
            op[unsafe_offset=k] = UInt32(base + t)
            k += 1
            word &= word - 1                      # clear lowest set bit
    return k


# ── CONSUME C: DENSE idiom. 98.5% of bytes are leaders, so iterating SET BITS
#      via ctz is a serial dependency chain on nearly every bit. Walk bytes
#      linearly instead and test a bit — still reads 32x less than the lane.
def consume_bitmap_dense(bits: List[UInt64], mut out: List[UInt32]) -> Int:
    var wp = bits.unsafe_ptr()
    var op = out.unsafe_ptr()
    var k = 0
    var words = N // 64
    for w in range(words):
        var word = wp[unsafe_offset=w]
        var base = w * 64
        for t in range(64):
            if ((word >> UInt64(t)) & 1) != 0:
                op[unsafe_offset=k] = UInt32(base + t)
                k += 1
    return k


# ── CONSUME D: dense + ALL-ONES FAST PATH. The same shape as decode's ASCII
#      block gate: one test says "these 64 bytes are ALL leaders", and the
#      branch disappears for the ~90% of words that are solid.
def consume_bitmap_gate(bits: List[UInt64], mut out: List[UInt32]) -> Int:
    var wp = bits.unsafe_ptr()
    var op = out.unsafe_ptr()
    var k = 0
    var words = N // 64
    for w in range(words):
        var word = wp[unsafe_offset=w]
        var base = w * 64
        if word == 0xFFFFFFFFFFFFFFFF:
            # every byte in these 64 is a leader: no bit test, no branch, and the
            # writes are contiguous — the same shape as decode's ASCII block gate.
            for t in range(64):
                op[unsafe_offset = k + t] = UInt32(base + t)
            k += 64
        elif word != 0:
            for t in range(64):
                if ((word >> UInt64(t)) & 1) != 0:
                    op[unsafe_offset=k] = UInt32(base + t)
                    k += 1
    return k



# NO @parameter CLOSURES. An earlier version of this bench timed each variant through
# a captured closure; the closures captured COPIES of the List arguments, so
# produce_lane wrote into a copy and consume_lane read UNINITIALISED memory. It
# printed a plausible-looking 4,057,949 leaders — ~50.7% of bytes, which is exactly
# what random garbage with bit 0 set gives you. The agreement check caught it.
# Direct calls, one timing loop each, verbose and unambiguous.

def main() raises:
    var b = make_corpus()
    var flags = List[UInt32](unsafe_uninit_length=N)
    var bits = List[UInt64](unsafe_uninit_length=N // 64 + 1)
    var out = List[UInt32](unsafe_uninit_length=N + 64)
    print("bytes:", N)

    var t_pl = 1 << 62
    var n_lane = 0
    for k in range(REPS + 1):
        var t0 = perf_counter_ns()
        n_lane = produce_lane(b, flags)
        var dt = perf_counter_ns() - t0
        if k > 0 and dt < t_pl: t_pl = dt

    var t_pb = 1 << 62
    var n_bits = 0
    for k in range(REPS + 1):
        var t0 = perf_counter_ns()
        n_bits = produce_bitmap(b, bits)
        var dt = perf_counter_ns() - t0
        if k > 0 and dt < t_pb: t_pb = dt

    var t_cl = 1 << 62
    var a_lane = 0
    for k in range(REPS + 1):
        var t0 = perf_counter_ns()
        a_lane = consume_lane(flags, out)
        var dt = perf_counter_ns() - t0
        if k > 0 and dt < t_cl: t_cl = dt
    var probe_lane = out[a_lane - 1]

    var t_cb = 1 << 62
    var a_ctz = 0
    for k in range(REPS + 1):
        var t0 = perf_counter_ns()
        a_ctz = consume_bitmap(bits, out)
        var dt = perf_counter_ns() - t0
        if k > 0 and dt < t_cb: t_cb = dt
    var probe_ctz = out[a_ctz - 1]

    var t_cd = 1 << 62
    var a_dense = 0
    for k in range(REPS + 1):
        var t0 = perf_counter_ns()
        a_dense = consume_bitmap_dense(bits, out)
        var dt = perf_counter_ns() - t0
        if k > 0 and dt < t_cd: t_cd = dt
    var probe_dense = out[a_dense - 1]

    var t_cg = 1 << 62
    var a_gate = 0
    for k in range(REPS + 1):
        var t0 = perf_counter_ns()
        a_gate = consume_bitmap_gate(bits, out)
        var dt = perf_counter_ns() - t0
        if k > 0 and dt < t_cg: t_cg = dt
    var probe_gate = out[a_gate - 1]

    def ms(x: Int) -> Float64:
        return Float64(x) / 1e6

    var counts_ok = (n_lane == n_bits and a_lane == n_lane and a_ctz == n_lane
                     and a_dense == n_lane and a_gate == n_lane)
    var probes_ok = (probe_lane == probe_ctz and probe_lane == probe_dense
                     and probe_lane == probe_gate)
    print("leaders:", n_lane, " all four consumers compacted the same count:",
          counts_ok)
    print("last compacted index:", probe_lane, " identical across consumers:",
          probes_ok)
    if not (counts_ok and probes_ok):
        raise Error("variants disagree - timings below are meaningless")
    print("leader density:", Float64(n_lane) * 100.0 / Float64(N), "%")
    print("")
    print("PRODUCE  u32 lane (32MB out):", ms(t_pl), "ms")
    print("PRODUCE  bitmap   ( 1MB out):", ms(t_pb), "ms   speedup",
          Float64(t_pl) / Float64(t_pb))
    print("CONSUME  u32 lane           :", ms(t_cl), "ms")
    print("CONSUME  bitmap ctz-scan    :", ms(t_cb), "ms   speedup",
          Float64(t_cl) / Float64(t_cb))
    print("CONSUME  bitmap dense       :", ms(t_cd), "ms   speedup",
          Float64(t_cl) / Float64(t_cd))
    print("CONSUME  bitmap dense+gate  :", ms(t_cg), "ms   speedup",
          Float64(t_cl) / Float64(t_cg))
    print("")
    print("TOTAL    lane          :", ms(t_pl + t_cl), "ms")
    print("TOTAL    bitmap (gate) :", ms(t_pb + t_cg), "ms   speedup",
          Float64(t_pl + t_cl) / Float64(t_pb + t_cg))
