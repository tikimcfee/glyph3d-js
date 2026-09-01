# split_bench.mojo — does the STATIC/POSITIONAL phase split pay end to end?
#
# lane_write_bench measured the write SHAPE in isolation and got 2.9x. Isolated
# kernel benchmarks have overstated their contribution three times in this branch
# (bounds 2.11% -> 4.5%, decode 1.49x -> 5%, a fused prototype's 2.92x decomposing
# into five independent changes), so the prediction on record is 1.3-1.5x and the
# point of this file is to find out before refactoring five files and thirteen
# suites.
#
# THE TWO LAYOUTS, same work, same trie, same corpus:
#
#   AoS (pre-split)   measures f32 x8  [X Y Z ADVANCE HEIGHT GLYPH_ID BASE_X LINE_ADV]
#                 counts   u32 x4  [ROW COL FLAGS ORD]
#                 decode dirties all 48 B; the fold dirties all 48 B again.
#
#   SPLIT         static   f32 x4  [ADVANCE HEIGHT GLYPH_ID pad]  + u32 x1 [FLAGS]
#                 pos      f32 x5  [X Y Z BASE_X LINE_ADV]        + u32 x3 [ROW COL ORD]
#                 decode dirties 20 B and the fold READS 20 (clean, no RFO) and
#                 dirties 32.
#
# HONEST CAVEAT: both variants here are written for this bench rather than lifted
# from glyph_pipeline, so absolute times are not the production path's. What the
# file measures is the RATIO between two layouts given identical treatment — same
# ASCII gate, same wide trie load, same fold arithmetic. They are checked against
# each other value-for-value first, so the ratio is between two layouts doing
# provably the same work rather than between a careful one and a sloppy one.
#
# Run: mojo run -I engine --fp-mode contract=off engine/bench/split_bench.mojo

from std.time import perf_counter_ns
from std.memory import bitcast
from std.runtime.asyncrt import TaskGroup, parallelism_level
from glyph_pipeline import Trie, Item, F_LEADER, F_MISSING, F_NEWLINE

# THE PRE-SPLIT CONTAINER, pinned locally. This bench is the measured argument
# FOR the split (1.37x), so its AoS variant must model the container that no
# longer exists — the schema deleted these constants when the split landed, and
# importing them broke this file silently (nothing runs it in check.sh). A bench
# that is cited as evidence must stay runnable, so the old layout lives here as
# what it now is: a historical artifact under test.
comptime MEASURE_STRIDE = 8
comptime M_X = 0
comptime M_Y = 1
comptime M_Z = 2
comptime M_ADVANCE = 3
comptime M_HEIGHT = 4
comptime M_GLYPH_ID = 5
comptime M_BASE_X = 6
comptime M_LINE_ADV = 7
comptime COUNT_STRIDE = 4
comptime C_ROW = 0
comptime C_COL = 1
comptime C_FLAGS = 2
comptime C_ORD = 3

comptime REPS = 5
comptime BLOCK_SHIFT = 8
comptime BLOCK_MASK = 255
comptime NEWLINE = 0x0A

# SPLIT strides. static is 4 f32 wide so the decode store is one aligned 16 B
# write and four slots share a cache line; the 4th lane is padding, and padding
# that buys alignment is cheaper than the unaligned store that saving it costs.
comptime S_STRIDE = 4
comptime S_ADVANCE = 0
comptime S_HEIGHT = 1
comptime S_GLYPH_ID = 2
comptime P_STRIDE = 5
comptime P_X = 0
comptime P_Y = 1
comptime P_Z = 2
comptime P_BASE_X = 3
comptime P_LINE_ADV = 4
comptime PC_STRIDE = 3
comptime PC_ROW = 0
comptime PC_COL = 1
comptime PC_ORD = 2


def seq_len(b: Int) -> Int:
    if (b & 0x80) == 0x00: return 1
    if (b & 0xE0) == 0xC0: return 2
    if (b & 0xF0) == 0xE0: return 3
    if (b & 0xF8) == 0xF0: return 4
    return 0


# ── AoS decode: the PRE-SPLIT shape, all 12 lanes ───────────────────────────
async def _dec_aos[bo: Origin[mut=True], so: Origin[mut=True], xo: Origin[mut=True]](
    bp: Pointer[UInt8, bo], m: Pointer[Float32, so],
    c: Pointer[UInt32, xo], trie: Trie, start: Int, stop: Int, n: Int,
):
    var tbi = trie.block_index.unsafe_ptr()
    var tmb = trie.blocks_m.unsafe_ptr()
    var tcb = trie.blocks_c.unsafe_ptr()
    var ascii_block = Int(tbi[unsafe_offset=0])
    for id in range(start, stop):
        var b0 = Int(bp[unsafe_offset=id])
        var mo = id * MEASURE_STRIDE
        var co = id * COUNT_STRIDE
        var nlen = seq_len(b0)
        if nlen == 0:
            for k in range(MEASURE_STRIDE): m[unsafe_offset = mo + k] = 0
            for k in range(COUNT_STRIDE): c[unsafe_offset = co + k] = 0
            continue
        var cp = b0 if nlen == 1 else 0xFFFD
        var block = ascii_block if cp < 256 else Int(tbi[unsafe_offset = cp >> BLOCK_SHIFT])
        var tb = (block << BLOCK_SHIFT) | (cp & BLOCK_MASK)
        var em = tmb.unsafe_load[width=2](tb * 2)
        var ec = tcb.unsafe_load[width=2](tb * 2)
        m[unsafe_offset = mo + M_GLYPH_ID] = Float32(ec[0])
        m.unsafe_store[width=2](mo + M_ADVANCE, SIMD[DType.float32, 2](em[0], em[1]))
        var f = F_LEADER
        if ec[1] != 0: f |= F_MISSING
        if cp == NEWLINE: f |= F_NEWLINE
        c[unsafe_offset = co + C_FLAGS] = UInt32(f)
        m[unsafe_offset = mo + M_X] = 0
        m[unsafe_offset = mo + M_Y] = 0
        m[unsafe_offset = mo + M_Z] = 0
        m[unsafe_offset = mo + M_BASE_X] = 0
        m[unsafe_offset = mo + M_LINE_ADV] = 0
        c[unsafe_offset = co + C_ROW] = 0
        c[unsafe_offset = co + C_COL] = 0
        c[unsafe_offset = co + C_ORD] = 0


# ── SPLIT decode: only the lanes decode OWNS ────────────────────────────────
async def _dec_split[bo: Origin[mut=True], so: Origin[mut=True], xo: Origin[mut=True]](
    bp: Pointer[UInt8, bo], st: Pointer[Float32, so],
    sc: Pointer[UInt32, xo], trie: Trie, start: Int, stop: Int, n: Int,
):
    var tbi = trie.block_index.unsafe_ptr()
    var tmb = trie.blocks_m.unsafe_ptr()
    var tcb = trie.blocks_c.unsafe_ptr()
    var ascii_block = Int(tbi[unsafe_offset=0])
    for id in range(start, stop):
        var b0 = Int(bp[unsafe_offset=id])
        var so_ = id * S_STRIDE
        var nlen = seq_len(b0)
        if nlen == 0:
            st.unsafe_store[width=4](so_, SIMD[DType.float32, 4](0, 0, 0, 0))
            sc[unsafe_offset=id] = 0
            continue
        var cp = b0 if nlen == 1 else 0xFFFD
        var block = ascii_block if cp < 256 else Int(tbi[unsafe_offset = cp >> BLOCK_SHIFT])
        var tb = (block << BLOCK_SHIFT) | (cp & BLOCK_MASK)
        var em = tmb.unsafe_load[width=2](tb * 2)
        var ec = tcb.unsafe_load[width=2](tb * 2)
        # ONE aligned 16-byte store for the whole static record.
        st.unsafe_store[width=4](so_, SIMD[DType.float32, 4](em[0], em[1], Float32(ec[0]), 0))
        var f = F_LEADER
        if ec[1] != 0: f |= F_MISSING
        if cp == NEWLINE: f |= F_NEWLINE
        sc[unsafe_offset=id] = UInt32(f)


def fold_aos[so: Origin[mut=True], xo: Origin[mut=True]](
    m: Pointer[Float32, so], c: Pointer[UInt32, xo], n: Int
):
    var row = 0
    var col = 0
    var ord = 0
    var line_adv: Float64 = 0
    for id in range(n):
        var mo = id * MEASURE_STRIDE
        var co = id * COUNT_STRIDE
        var f = Int(c[unsafe_offset = co + C_FLAGS])
        if (f & F_LEADER) == 0: continue
        var adv = m[unsafe_offset = mo + M_ADVANCE]
        var lh = Float64(m[unsafe_offset = mo + M_HEIGHT])
        c[unsafe_offset = co + C_ROW] = UInt32(row)
        c[unsafe_offset = co + C_COL] = UInt32(col)
        c[unsafe_offset = co + C_ORD] = UInt32(ord)
        m[unsafe_offset = mo + M_LINE_ADV] = Float32(line_adv)
        m[unsafe_offset = mo + M_BASE_X] = Float32(line_adv)
        m[unsafe_offset = mo + M_X] = Float32(line_adv)
        m[unsafe_offset = mo + M_Y] = Float32(-Float64(row) * lh)
        m[unsafe_offset = mo + M_Z] = 0
        if (f & F_NEWLINE) != 0:
            row += 1; col = 0; line_adv = 0
        else:
            col += 1; line_adv = line_adv + Float64(adv)
        ord += 1


def fold_split[
    so: Origin[mut=True], xo: Origin[mut=True], po: Origin[mut=True], qo: Origin[mut=True]
](
    st: Pointer[Float32, so], sc: Pointer[UInt32, xo],
    pm: Pointer[Float32, po], pc: Pointer[UInt32, qo], n: Int,
):
    var row = 0
    var col = 0
    var ord = 0
    var line_adv: Float64 = 0
    for id in range(n):
        var f = Int(sc[unsafe_offset=id])
        if (f & F_LEADER) == 0: continue
        var so_ = id * S_STRIDE
        var po = id * P_STRIDE
        var pco = id * PC_STRIDE
        var adv = st[unsafe_offset = so_ + S_ADVANCE]
        var lh = Float64(st[unsafe_offset = so_ + S_HEIGHT])
        pc[unsafe_offset = pco + PC_ROW] = UInt32(row)
        pc[unsafe_offset = pco + PC_COL] = UInt32(col)
        pc[unsafe_offset = pco + PC_ORD] = UInt32(ord)
        pm[unsafe_offset = po + P_LINE_ADV] = Float32(line_adv)
        pm[unsafe_offset = po + P_BASE_X] = Float32(line_adv)
        pm[unsafe_offset = po + P_X] = Float32(line_adv)
        pm[unsafe_offset = po + P_Y] = Float32(-Float64(row) * lh)
        pm[unsafe_offset = po + P_Z] = 0
        if (f & F_NEWLINE) != 0:
            row += 1; col = 0; line_adv = 0
        else:
            col += 1; line_adv = line_adv + Float64(adv)
        ord += 1


def load() raises -> BenchIn:
    var f = open("engine/bench/bench.bin", "r")
    var raw = f.read_bytes()
    f.close()

    def u32_at(d: List[UInt8], at: Int) -> Int:
        return (Int(d[at]) | (Int(d[at + 1]) << 8) | (Int(d[at + 2]) << 16)
                | (Int(d[at + 3]) << 24))

    # 'G3DY' — split-carrier trie; see bench.mojo's loader for why the magic
    # moved with the format rather than staying over new bytes.
    if u32_at(raw, 0) != 0x59443347:
        raise Error(
            "bad bench.bin — expected 'G3DY' (split-carrier trie). If this is a"
            " stale 'G3DX' file, regenerate: bun engine/bench/gen-bench.mjs"
        )
    var byte_len = u32_at(raw, 4)
    var bil = u32_at(raw, 8)
    var exact_len = u32_at(raw, 12)
    var measure_len = u32_at(raw, 16)
    var bytes = List[UInt8](capacity=byte_len)
    var at = 20
    for i in range(byte_len):
        bytes.append(raw[at + i])
    at += byte_len
    var bi = List[UInt32](capacity=bil)
    for i in range(bil):
        bi.append(UInt32(u32_at(raw, at + i * 4)))
    at += bil * 4
    var bc = List[UInt32](capacity=exact_len)    # GLYPH_ID, FLAGS
    for i in range(exact_len):
        bc.append(UInt32(u32_at(raw, at + i * 4)))
    at += exact_len * 4
    var bm = List[Float32](capacity=measure_len)  # ADVANCE, HEIGHT
    for i in range(measure_len):
        bm.append(bitcast[DType.float32](UInt32(u32_at(raw, at + i * 4))))
    return BenchIn(bytes^, Trie(bi^, bm^, bc^))


struct BenchIn(Movable):
    var bytes: List[UInt8]
    var trie: Trie

    def __init__(out self, var bytes: List[UInt8], var trie: Trie):
        self.bytes = bytes^
        self.trie = trie^


def shard_lo(n: Int, workers: Int, w: Int) -> Int:
    var per = (n + workers - 1) // workers
    var a = w * per
    return a if a < n else n


def run_aos[
    bo: Origin[mut=True], so: Origin[mut=True], xo: Origin[mut=True]
](
    bp: Pointer[UInt8, bo], mp: Pointer[Float32, so],
    cp: Pointer[UInt32, xo], trie: Trie, n: Int, workers: Int,
):
    var tg = TaskGroup()
    for w in range(workers):
        tg.create_task(_dec_aos(bp, mp, cp, trie, shard_lo(n, workers, w),
                                shard_lo(n, workers, w + 1), n))
    tg.wait()
    fold_aos(mp, cp, n)


def run_split[
    bo: Origin[mut=True], so: Origin[mut=True], xo: Origin[mut=True],
    po: Origin[mut=True], qo: Origin[mut=True]
](
    bp: Pointer[UInt8, bo], sp: Pointer[Float32, so],
    scp: Pointer[UInt32, xo], pmp: Pointer[Float32, po],
    pcp: Pointer[UInt32, qo], trie: Trie, n: Int, workers: Int,
):
    var tg = TaskGroup()
    for w in range(workers):
        tg.create_task(_dec_split(bp, sp, scp, trie, shard_lo(n, workers, w),
                                  shard_lo(n, workers, w + 1), n))
    tg.wait()
    fold_split(sp, scp, pmp, pcp, n)


def main() raises:
    var inp = load()
    var n = len(inp.bytes)
    var workers = parallelism_level()
    if workers < 1:
        workers = 1
    var bp = inp.bytes.unsafe_ptr()
    print("bytes:", n, " workers:", workers)

    var m = List[Float32](unsafe_uninit_length=n * MEASURE_STRIDE)
    var c = List[UInt32](unsafe_uninit_length=n * COUNT_STRIDE)
    var st = List[Float32](unsafe_uninit_length=n * S_STRIDE)
    var sc = List[UInt32](unsafe_uninit_length=n)
    var pm = List[Float32](unsafe_uninit_length=n * P_STRIDE)
    var pc = List[UInt32](unsafe_uninit_length=n * PC_STRIDE)
    var mp = m.unsafe_ptr(); var cp = c.unsafe_ptr()
    var sp = st.unsafe_ptr(); var scp = sc.unsafe_ptr()
    var pmp = pm.unsafe_ptr(); var pcp = pc.unsafe_ptr()

    # ── AGREEMENT FIRST. A ratio between two layouts is only meaningful if they
    #    computed the same thing; a variant that skips work is trivially faster.
    run_aos(bp, mp, cp, inp.trie, n, workers)
    run_split(bp, sp, scp, pmp, pcp, inp.trie, n, workers)
    var bad = 0
    var printed = 0
    for id in range(n):
        var mo = id * MEASURE_STRIDE
        var co = id * COUNT_STRIDE
        var so_ = id * S_STRIDE
        var po = id * P_STRIDE
        var pco = id * PC_STRIDE
        var pairs = List[Bool]()
        pairs.append(m[mo + M_ADVANCE].to_bits() == st[so_ + S_ADVANCE].to_bits())
        pairs.append(m[mo + M_HEIGHT].to_bits() == st[so_ + S_HEIGHT].to_bits())
        pairs.append(m[mo + M_GLYPH_ID].to_bits() == st[so_ + S_GLYPH_ID].to_bits())
        pairs.append(c[co + C_FLAGS] == sc[id])
        if (Int(c[co + C_FLAGS]) & F_LEADER) != 0:
            pairs.append(m[mo + M_X].to_bits() == pm[po + P_X].to_bits())
            pairs.append(m[mo + M_Y].to_bits() == pm[po + P_Y].to_bits())
            pairs.append(m[mo + M_BASE_X].to_bits() == pm[po + P_BASE_X].to_bits())
            pairs.append(m[mo + M_LINE_ADV].to_bits() == pm[po + P_LINE_ADV].to_bits())
            pairs.append(c[co + C_ROW] == pc[pco + PC_ROW])
            pairs.append(c[co + C_COL] == pc[pco + PC_COL])
            pairs.append(c[co + C_ORD] == pc[pco + PC_ORD])
        for k in range(len(pairs)):
            if not pairs[k]:
                bad += 1
                if printed < 4:
                    print("  DISAGREE byte", id, "check", k)
                    printed += 1
                break
    if bad != 0:
        raise Error("layouts disagree on " + String(bad) + " bytes — the ratio would be meaningless")
    print("layouts agree on every lane, bit for bit")

    var t_aos = 1 << 62
    for r in range(REPS + 1):
        var t0 = perf_counter_ns()
        run_aos(bp, mp, cp, inp.trie, n, workers)
        var dt = perf_counter_ns() - t0
        if r > 0 and dt < t_aos: t_aos = dt
    var t_split = 1 << 62
    for r in range(REPS + 1):
        var t0 = perf_counter_ns()
        run_split(bp, sp, scp, pmp, pcp, inp.trie, n, workers)
        var dt = perf_counter_ns() - t0
        if r > 0 and dt < t_split: t_split = dt
    var mb = Float64(n) / 1048576.0
    print("")
    print("AoS   (48 B/byte dirtied twice):", Float64(t_aos) / 1e6, "ms  ",
          mb / (Float64(t_aos) / 1e9), "MB/s")
    print("SPLIT (20 decode + 32 fold)   :", Float64(t_split) / 1e6, "ms  ",
          mb / (Float64(t_split) / 1e9), "MB/s")
    print("speedup:", Float64(t_aos) / Float64(t_split))
    print("probe:", m[5], st[2], pm[1], pc[0])
