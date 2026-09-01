# bench.mojo — the native side of the ledger. Same corpus, same trie, same work
# as bench.mjs: bake_file + run_pipeline + run_scan_pipeline over the corpus.
# Checksums printed so the work can't be dead-code-eliminated, and to cross-check
# that both benches computed the same thing.
#
# Run:   mojo run -I engine engine/bench/bench.mojo        (JIT)
# Build: mojo build -I engine engine/bench/bench.mojo -o engine/bench/bench && engine/bench/bench

from std.time import perf_counter_ns
from std.memory import bitcast
from glyph_schema import LC_STRIDE, LC_ROW, LM_STRIDE, LM_X

comptime PROBE_BYTE = 1028
from glyph_pipeline import Trie, Item, run_pipeline, PipelineResult
from glyph_scan import run_scan_pipeline
from glyph_bake import bake_file

comptime REPS = 5


struct BenchInput(Movable):
    var bytes: List[UInt8]
    var trie: Trie

    def __init__(out self, var bytes: List[UInt8], var trie: Trie):
        self.bytes = bytes^
        self.trie = trie^


def load_input() raises -> BenchInput:
    var f = open("engine/bench/bench.bin", "r")
    var raw = f.read_bytes()
    f.close()

    def u32_at(data: List[UInt8], at: Int) -> Int:
        return (
            Int(data[at])
            | (Int(data[at + 1]) << 8)
            | (Int(data[at + 2]) << 16)
            | (Int(data[at + 3]) << 24)
        )

    # 'G3DY' — the SPLIT-CARRIER trie (gen-bench.mjs bumped the magic when the
    # format moved, so this loader fails at the header instead of reading f32
    # advances as integer glyph ids; the old 'G3DX' tag is deliberately not
    # accepted). Both sides now realize the same two containers, so the trie
    # arrives as straight copies — no deinterleave, no bitcast, which is the
    # carrier discipline paying its way at a file format seam.
    if u32_at(raw, 0) != 0x59443347:
        raise Error(
            "bad bench.bin — expected 'G3DY' (split-carrier trie). If this is a"
            " stale 'G3DX' file, regenerate: bun engine/bench/gen-bench.mjs"
        )
    var byte_len = u32_at(raw, 4)
    var block_index_len = u32_at(raw, 8)
    var exact_len = u32_at(raw, 12)
    var measure_len = u32_at(raw, 16)

    var bytes = List[UInt8](capacity=byte_len)
    var at = 20
    for i in range(byte_len):
        bytes.append(raw[at + i])
    at += byte_len
    var block_index = List[UInt32](capacity=block_index_len)
    for i in range(block_index_len):
        block_index.append(UInt32(u32_at(raw, at + i * 4)))
    at += block_index_len * 4
    var blocks_c = List[UInt32](capacity=exact_len)   # GLYPH_ID, FLAGS
    for i in range(exact_len):
        blocks_c.append(UInt32(u32_at(raw, at + i * 4)))
    at += exact_len * 4
    var blocks_m = List[Float32](capacity=measure_len)  # ADVANCE, HEIGHT
    for i in range(measure_len):
        blocks_m.append(bitcast[DType.float32](UInt32(u32_at(raw, at + i * 4))))

    return BenchInput(bytes^, Trie(block_index^, blocks_m^, blocks_c^))


def probe_x(res: PipelineResult) -> Int:
    """A MEASURE lane folded into the checksum, and it is not decoration.

    The checksum was leaders + a ROW lane — both pure counts, both derived from
    line breaks and column positions, NEITHER of which reads an advance. So the
    number could not discriminate a misread trie: swapping the ADVANCE and
    HEIGHT lanes at load time left both printed checksums BIT-IDENTICAL
    (measured, not assumed). That is the failure mode that had already bitten
    the JS bench, which viewed a u32 trie as f32 and took every exact lane as a
    denormal while nothing failed.

    X is the fold's f32 output and depends on the advance of every preceding
    glyph in the segment, so folding its bits in makes the measure lanes
    load-bearing on the printed number. Bits, not the float: an integer
    checksum must not be built from a float compare."""
    return Int(res.lm[PROBE_BYTE * LM_STRIDE + LM_X].to_bits())


def one_item(byte_count: Int, wrap: Int) -> List[Item]:
    var it = Item()
    it.byte_count = byte_count
    it.wrap_width = wrap
    it.line_height = 1.0
    var items = List[Item]()
    items.append(it.copy())
    return items^


def report(name: String, best_ns: Int, mb: Float64, checksum: Int):
    var ms = Float64(best_ns) / 1e6
    var mbps = mb / (Float64(best_ns) / 1e9)
    print(name, ": best", ms, "ms  (", mbps, "MB/s)  checksum", checksum)


def main() raises:
    var input = load_input()
    var n = len(input.bytes)
    var mb = Float64(n) / (1024.0 * 1024.0)
    print("corpus:", n, "bytes")

    # ── bake ──────────────────────────────────────────────────────────────────
    var sum = 0
    var best = 1 << 62
    for r in range(REPS + 1):
        var t0 = perf_counter_ns()
        var rec = bake_file(input.bytes, input.trie, 1.0, 4096)
        var t1 = perf_counter_ns()
        if r > 0:  # rep 0 is warmup
            sum += rec.leaders + rec.newlines + len(rec.checkpoints)
            if t1 - t0 < best:
                best = t1 - t0
    report("bake      (mojo)", best, mb, sum)

    # ── serial pipeline ───────────────────────────────────────────────────────
    var items = one_item(n, 100)
    sum = 0
    best = 1 << 62
    for r in range(REPS + 1):
        var t0 = perf_counter_ns()
        var res = run_pipeline(input.bytes, input.trie, items)
        var t1 = perf_counter_ns()
        if r > 0:
            sum += res.leaders + Int(res.lc[PROBE_BYTE * LC_STRIDE + LC_ROW]) + probe_x(res)
            if t1 - t0 < best:
                best = t1 - t0
    report("pipeline  (mojo)", best, mb, sum)

    # ── serial pipeline, ELIDED (the production instantiation) ────────────────
    # Same fold, witness stores comptime-gated out (no LINE_ADV/ORD/ord_to_byte
    # writes, no otb memset, no witness allocation). conformance_elide pins the
    # render-read arrays bit-identical to the witnessed row above; this row keeps
    # the PRICE of the witness tier measured rather than remembered.
    sum = 0
    best = 1 << 62
    for r in range(REPS + 1):
        var t0 = perf_counter_ns()
        var res = run_pipeline[witness=False](input.bytes, input.trie, items)
        var t1 = perf_counter_ns()
        if r > 0:
            sum += res.leaders + Int(res.lc[PROBE_BYTE * LC_STRIDE + LC_ROW]) + probe_x(res)
            if t1 - t0 < best:
                best = t1 - t0
    report("pipeline- elided", best, mb, sum)

    # ── scan-form pipeline ────────────────────────────────────────────────────
    sum = 0
    best = 1 << 62
    for r in range(REPS + 1):
        var t0 = perf_counter_ns()
        var res = run_scan_pipeline(input.bytes, input.trie, items, 64, 256)
        var t1 = perf_counter_ns()
        if r > 0:
            sum += res.leaders + Int(res.lc[PROBE_BYTE * LC_STRIDE + LC_ROW]) + probe_x(res)
            if t1 - t0 < best:
                best = t1 - t0
    report("scan      (mojo)", best, mb, sum)
