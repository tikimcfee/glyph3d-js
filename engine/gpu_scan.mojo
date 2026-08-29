# gpu_scan.mojo — the FOLD on real GPU threads, proven bit-exact.
#
# gpu_decode proved a dispatch with no cross-thread dependency and no float
# accumulation. This is the harder half: chunkReduce folds K bytes per thread
# through the segmented monoid, so it is where the float discipline actually meets
# the hardware. If anything about the port's rounding were accidental rather than
# reproduced, this is the dispatch that would show it.
#
# The discipline under test, and why it survives:
#   tail_adv is summed f32-PER-ADD, never in a wider accumulator. An f32 add IS
#   round(exact sum), so regrouping the adds cannot change the result — which is
#   the whole reason the reduce is allowed to be parallel at all. Every other lane
#   is an exact count.
#
# ScanElem lives in TWO buffers on device, by the same rule as the slot buffers:
# counts (u32) and measures (f32). Its layout is generated from the schema.
#
# Run: mojo run -I engine engine/gpu_scan.mojo engine/fixtures/*.pipe.bin

from std.sys import argv, has_accelerator
from std.gpu import global_idx
from max.gpu.host import DeviceContext
from glyph_schema import (
    MEASURE_STRIDE, COUNT_STRIDE, M_ADVANCE, C_FLAGS,
    PARTIAL_COUNT_STRIDE, PARTIAL_MEASURE_STRIDE,
    P_RESET, P_NL, P_GLYPHS, P_ROWS, P_HEAD_LEN, P_TAIL_LEN, P_WRAP, PM_TAIL_ADV,
)
from glyph_pipeline import run_pipeline, F_LEADER, F_NEWLINE, trunc_nonneg, item_for_byte
from glyph_bake import ScanElem, scan_identity, scan_leaf_value, scan_combine, rows_for_line
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8
comptime CHUNK = 64


def chunk_reduce_kernel(
    flags: MutPointer[UInt32, MutAnyOrigin],
    advance: MutPointer[Float32, MutAnyOrigin],
    wrap_of: MutPointer[UInt32, MutAnyOrigin],
    is_start: MutPointer[UInt32, MutAnyOrigin],
    p_counts: MutPointer[UInt32, MutAnyOrigin],
    p_meas: MutPointer[Float32, MutAnyOrigin],
    n_bytes: Int32,
    k: Int32,
    n_chunks: Int32,
):
    """One thread per chunk — the serial fold of that chunk's bytes."""
    var c = global_idx.x
    if c >= Int(n_chunks):
        return
    var n = Int(n_bytes)
    var kk = Int(k)

    # identity
    var a_reset = 0
    var a_nl = 0
    var a_glyphs = 0
    var a_rows = 0
    var a_head = 0
    var a_tail = 0
    var a_adv = Float32(0)
    var a_wrap = 0
    var seen = False

    var id = c * kk
    var to = (c + 1) * kk
    if to > n:
        to = n
    while id < n and id < to:
        # ── leaf ────────────────────────────────────────────────────────────
        var f = Int(flags[unsafe_offset = id * COUNT_STRIDE + C_FLAGS])
        var leader = (f & F_LEADER) != 0
        var newline = (f & F_NEWLINE) != 0
        var b_wrap = Int(wrap_of[unsafe_offset=id])
        var b_reset = Int(is_start[unsafe_offset=id])
        var b_nl = 0
        var b_glyphs = 0
        var b_head = 0
        var b_tail = 0
        var b_adv = Float32(0)
        if leader:
            b_glyphs = 1
            if newline:
                b_nl = 1
            else:
                b_head = 1
                b_tail = 1
                b_adv = advance[unsafe_offset = id * MEASURE_STRIDE + M_ADVANCE]

        # ── combine(a, leaf) — the absorbing reset makes items structural ───
        if not seen or b_reset != 0:
            a_reset = b_reset if seen else b_reset
            a_nl = b_nl
            a_glyphs = b_glyphs
            a_rows = 0
            a_head = b_head
            a_tail = b_tail
            a_adv = b_adv
            a_wrap = b_wrap
            if not seen:
                a_reset = b_reset
            seen = True
            id += 1
            continue
        a_wrap = b_wrap
        a_glyphs += b_glyphs
        if b_nl == 0:
            a_tail += b_tail
            if a_nl == 0:
                a_head = a_tail
            a_adv = a_adv + b_adv  # f32 PER ADD — exact under regrouping
        else:
            if a_nl == 0:
                a_head = a_tail
                a_rows = 0
            else:
                a_rows += rows_for_line(a_tail, b_wrap)
            a_nl += b_nl
            a_tail = 0
            a_adv = 0
        id += 1

    var o = c * PARTIAL_COUNT_STRIDE
    p_counts[unsafe_offset = o + P_RESET] = UInt32(a_reset)
    p_counts[unsafe_offset = o + P_NL] = UInt32(a_nl)
    p_counts[unsafe_offset = o + P_GLYPHS] = UInt32(a_glyphs)
    p_counts[unsafe_offset = o + P_ROWS] = UInt32(a_rows)
    p_counts[unsafe_offset = o + P_HEAD_LEN] = UInt32(a_head)
    p_counts[unsafe_offset = o + P_TAIL_LEN] = UInt32(a_tail)
    p_counts[unsafe_offset = o + P_WRAP] = UInt32(a_wrap)
    p_meas[unsafe_offset = c * PARTIAL_MEASURE_STRIDE + PM_TAIL_ADV] = a_adv


def check_case(path: String, ctx: DeviceContext) raises -> Int:
    var fx = load_pipe_fixture(path)
    var n = fx.byte_len
    if n == 0:
        return 0
    var n_chunks = (n + CHUNK - 1) // CHUNK

    var r = run_pipeline(fx.bytes, fx.trie, fx.items)

    # Per-byte wrap + item-start, precomputed on the host exactly as the GPU
    # pipeline gets them from itemStarts (the kernel is not the place to binary
    # search an item table).
    var wrap_of = List[UInt32](unsafe_uninit_length=n)
    var is_start = List[UInt32](unsafe_uninit_length=n)
    for id in range(n):
        var i = item_for_byte(fx.items, id)
        wrap_of[id] = UInt32(trunc_nonneg(fx.items[i].wrap_width)) if i >= 0 else 0
        is_start[id] = UInt32(1) if (i >= 0 and fx.items[i].byte_start == id) else UInt32(0)

    # ── CPU reference: the same monoid the conformance suites already prove ──
    var cpu = List[ScanElem]()
    for c in range(n_chunks):
        var acc = scan_identity()
        var to = (c + 1) * CHUNK
        if to > n:
            to = n
        for id in range(c * CHUNK, to):
            var f = Int(r.counts[id * COUNT_STRIDE + C_FLAGS])
            var leaf = scan_leaf_value(
                (f & F_NEWLINE) != 0,
                r.measures[id * MEASURE_STRIDE + M_ADVANCE],
                (f & F_LEADER) != 0,
                Int(wrap_of[id]),
                is_start[id] != 0,
            )
            scan_combine(acc, leaf)
        cpu.append(acc^)

    # ── GPU ─────────────────────────────────────────────────────────────────
    var h_flags = ctx.enqueue_create_host_buffer[DType.uint32](n * COUNT_STRIDE)
    var h_adv = ctx.enqueue_create_host_buffer[DType.float32](n * MEASURE_STRIDE)
    var h_wrap = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_start = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_pc = ctx.enqueue_create_host_buffer[DType.uint32](n_chunks * PARTIAL_COUNT_STRIDE)
    var h_pm = ctx.enqueue_create_host_buffer[DType.float32](n_chunks * PARTIAL_MEASURE_STRIDE)
    ctx.synchronize()
    for i in range(n * COUNT_STRIDE):
        h_flags[i] = r.counts[i]
    for i in range(n * MEASURE_STRIDE):
        h_adv[i] = r.measures[i]
    for i in range(n):
        h_wrap[i] = wrap_of[i]
        h_start[i] = is_start[i]

    var d_flags = ctx.enqueue_create_buffer[DType.uint32](n * COUNT_STRIDE)
    var d_adv = ctx.enqueue_create_buffer[DType.float32](n * MEASURE_STRIDE)
    var d_wrap = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_start = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_pc = ctx.enqueue_create_buffer[DType.uint32](n_chunks * PARTIAL_COUNT_STRIDE)
    var d_pm = ctx.enqueue_create_buffer[DType.float32](n_chunks * PARTIAL_MEASURE_STRIDE)
    ctx.enqueue_copy(dst_buf=d_flags, src_buf=h_flags)
    ctx.enqueue_copy(dst_buf=d_adv, src_buf=h_adv)
    ctx.enqueue_copy(dst_buf=d_wrap, src_buf=h_wrap)
    ctx.enqueue_copy(dst_buf=d_start, src_buf=h_start)
    d_pc.enqueue_fill(0)
    d_pm.enqueue_fill(0.0)

    comptime BLOCK = 128
    ctx.enqueue_function[chunk_reduce_kernel](
        d_flags.unsafe_ptr(), d_adv.unsafe_ptr(), d_wrap.unsafe_ptr(),
        d_start.unsafe_ptr(), d_pc.unsafe_ptr(), d_pm.unsafe_ptr(),
        Int32(n), Int32(CHUNK), Int32(n_chunks),
        grid_dim=(n_chunks + BLOCK - 1) // BLOCK,
        block_dim=BLOCK,
    )
    ctx.enqueue_copy(dst_buf=h_pc, src_buf=d_pc)
    ctx.enqueue_copy(dst_buf=h_pm, src_buf=d_pm)
    ctx.synchronize()

    # ── bit-for-bit, no tolerance ───────────────────────────────────────────
    var bad = 0
    var printed = 0
    for c in range(n_chunks):
        var o = c * PARTIAL_COUNT_STRIDE
        var e = cpu[c].copy()
        var got = List[Int]()
        got.append(Int(h_pc[o + P_NL]))
        got.append(Int(h_pc[o + P_GLYPHS]))
        got.append(Int(h_pc[o + P_ROWS]))
        got.append(Int(h_pc[o + P_HEAD_LEN]))
        got.append(Int(h_pc[o + P_TAIL_LEN]))
        var want = List[Int]()
        want.append(e.nl)
        want.append(e.glyphs)
        want.append(e.rows)
        want.append(e.head_len)
        want.append(e.tail_len)
        for j in range(5):
            if got[j] != want[j]:
                bad += 1
                if printed < MAX_PRINTED:
                    print("  chunk", c, "count lane", j, "— gpu", got[j], "cpu", want[j])
                    printed += 1
        var g_adv = h_pm[c * PARTIAL_MEASURE_STRIDE + PM_TAIL_ADV]
        if UInt32(g_adv.to_bits()) != UInt32(e.tail_adv.to_bits()):
            bad += 1
            if printed < MAX_PRINTED:
                print("  chunk", c, "TAIL_ADV — gpu", g_adv, "cpu", e.tail_adv)
                printed += 1
    return bad


def main() raises:
    comptime assert has_accelerator(), "gpu_scan requires a GPU"
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/gpu_scan.mojo <fixture.pipe.bin> ...")
        return
    var ctx = DeviceContext()
    print("device:", ctx.name())
    var total_bad = 0
    for i in range(1, len(args)):
        var path = String(args[i])
        var bad = check_case(path, ctx)
        if bad == 0:
            print("PASS", path)
        else:
            print("FAIL", path, "—", bad, "differing lanes")
        total_bad += bad
    if total_bad == 0:
        print("gpu chunkReduce: bit-exact with the CPU monoid on every fixture")
    else:
        raise Error("gpu scan diverged")
