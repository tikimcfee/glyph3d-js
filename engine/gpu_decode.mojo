# gpu_decode.mojo — dispatch 1 on real GPU threads, proven against the CPU port.
#
# The scan port was written loop-for-dispatch: every TaskGroup shard is a batch of
# the threads one GPU dispatch would launch. This is the first of those dispatches
# actually launched on a device, and it exists to answer one question before any
# more are moved — does the 4th layer stay bit-exact when the threads are real?
#
# Decode is the right first lift: thread-per-byte, no cross-thread dependency, no
# float accumulation. If bits move HERE, they moved because of the device or the
# port, not because of parallel float regrouping — which keeps the first result
# unambiguous. The later dispatches fold, and their tolerance story is different.
#
# The check is CPU-vs-GPU on the same fixture, compared as u32 bit patterns with no
# tolerance, exactly as conformance.mojo compares against the oracle.
#
# Run: mojo run -I engine engine/gpu_decode.mojo engine/fixtures/*.pipe.bin

from std.sys import argv, has_accelerator
from std.gpu import global_idx
from max.gpu.host import DeviceContext
from glyph_schema import (
    MEASURE_STRIDE, COUNT_STRIDE, M_GLYPH_ID, M_ADVANCE, M_HEIGHT, C_FLAGS,
)
from glyph_pipeline import (
    BLOCK_SHIFT, BLOCK_MASK, ENTRY_STRIDE,
    LANE_GLYPH_ID, LANE_ADVANCE, LANE_HEIGHT, LANE_FLAGS,
    FLAG_MISSING, F_LEADER, F_NEWLINE, F_MISSING, NEWLINE,
    decode_and_resolve,
)
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8


def decode_kernel(
    bytes: MutPointer[UInt8, MutAnyOrigin],
    block_index: MutPointer[UInt32, MutAnyOrigin],
    blocks: MutPointer[Float32, MutAnyOrigin],
    measures: MutPointer[Float32, MutAnyOrigin],
    counts: MutPointer[UInt32, MutAnyOrigin],
    n_bytes: Int32,   # scalar kernel args must be fixed-width (Int is not DevicePassable)
):
    """One thread per byte — the exact body of decode_and_resolve."""
    var id = global_idx.x
    var n_total = Int(n_bytes)
    if id >= n_total:
        return

    var b0 = Int(bytes[unsafe_offset=id])
    var n: Int
    if (b0 & 0x80) == 0x00:
        n = 1
    elif (b0 & 0xE0) == 0xC0:
        n = 2
    elif (b0 & 0xF0) == 0xE0:
        n = 3
    elif (b0 & 0xF8) == 0xF0:
        n = 4
    else:
        n = 0

    var mo = id * MEASURE_STRIDE
    var co = id * COUNT_STRIDE
    if n == 0:
        measures[unsafe_offset = mo + M_ADVANCE] = 0
        measures[unsafe_offset = mo + M_HEIGHT] = 0
        return

    # Bounds-checked continuation reads (the shader reads 0 past the end).
    var b1 = 0
    var b2 = 0
    var b3 = 0
    if id + 1 < n_total:
        b1 = Int(bytes[unsafe_offset = id + 1])
    if id + 2 < n_total:
        b2 = Int(bytes[unsafe_offset = id + 2])
    if id + 3 < n_total:
        b3 = Int(bytes[unsafe_offset = id + 3])

    var cp: Int
    if n == 1:
        cp = b0
    elif n == 2:
        cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F)
    elif n == 3:
        cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F)
    else:
        cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)

    var block = Int(block_index[unsafe_offset = cp >> BLOCK_SHIFT])
    var tb = ((block << BLOCK_SHIFT) | (cp & BLOCK_MASK)) * ENTRY_STRIDE

    var missing = (Int(blocks[unsafe_offset = tb + LANE_FLAGS]) & FLAG_MISSING) != 0
    measures[unsafe_offset = mo + M_GLYPH_ID] = blocks[unsafe_offset = tb + LANE_GLYPH_ID]
    measures[unsafe_offset = mo + M_ADVANCE] = blocks[unsafe_offset = tb + LANE_ADVANCE]
    measures[unsafe_offset = mo + M_HEIGHT] = blocks[unsafe_offset = tb + LANE_HEIGHT]
    var flags = F_LEADER
    if cp == NEWLINE:
        flags |= F_NEWLINE
    if missing:
        flags |= F_MISSING
    counts[unsafe_offset = co + C_FLAGS] = UInt32(flags)


def check_case(path: String, ctx: DeviceContext) raises -> Int:
    var fx = load_pipe_fixture(path)
    var n = fx.byte_len
    if n == 0:
        return 0
    var n_meas = n * MEASURE_STRIDE
    var n_cnt = n * COUNT_STRIDE

    # ── CPU reference: the same kernel the conformance suites already prove ──
    var cpu_m = List[Float32](unsafe_uninit_length=n_meas)
    for i in range(n_meas):
        cpu_m[i] = 0
    var cpu_c = List[UInt32](unsafe_uninit_length=n_cnt)
    for i in range(n_cnt):
        cpu_c[i] = 0
    var cm = cpu_m.unsafe_ptr()
    var cc = cpu_c.unsafe_ptr()
    for id in range(n):
        _ = decode_and_resolve(fx.bytes, cm, cc, fx.trie, id)

    # ── GPU ──────────────────────────────────────────────────────────────────
    var n_idx = len(fx.trie.block_index)
    var n_blk = len(fx.trie.blocks)

    var h_bytes = ctx.enqueue_create_host_buffer[DType.uint8](n)
    var h_index = ctx.enqueue_create_host_buffer[DType.uint32](n_idx)
    var h_blocks = ctx.enqueue_create_host_buffer[DType.float32](n_blk)
    var h_meas = ctx.enqueue_create_host_buffer[DType.float32](n_meas)
    var h_cnt = ctx.enqueue_create_host_buffer[DType.uint32](n_cnt)
    ctx.synchronize()
    for i in range(n):
        h_bytes[i] = fx.bytes[i]
    for i in range(n_idx):
        h_index[i] = fx.trie.block_index[i]
    for i in range(n_blk):
        h_blocks[i] = fx.trie.blocks[i]

    var d_bytes = ctx.enqueue_create_buffer[DType.uint8](n)
    var d_index = ctx.enqueue_create_buffer[DType.uint32](n_idx)
    var d_blocks = ctx.enqueue_create_buffer[DType.float32](n_blk)
    var d_meas = ctx.enqueue_create_buffer[DType.float32](n_meas)
    var d_cnt = ctx.enqueue_create_buffer[DType.uint32](n_cnt)
    ctx.enqueue_copy(dst_buf=d_bytes, src_buf=h_bytes)
    ctx.enqueue_copy(dst_buf=d_index, src_buf=h_index)
    ctx.enqueue_copy(dst_buf=d_blocks, src_buf=h_blocks)
    d_meas.enqueue_fill(0.0)
    d_cnt.enqueue_fill(0)

    comptime BLOCK = 256
    var grid = (n + BLOCK - 1) // BLOCK
    ctx.enqueue_function[decode_kernel](
        d_bytes.unsafe_ptr(),
        d_index.unsafe_ptr(),
        d_blocks.unsafe_ptr(),
        d_meas.unsafe_ptr(),
        d_cnt.unsafe_ptr(),
        Int32(n),
        grid_dim=grid,
        block_dim=BLOCK,
    )
    ctx.enqueue_copy(dst_buf=h_meas, src_buf=d_meas)
    ctx.enqueue_copy(dst_buf=h_cnt, src_buf=d_cnt)
    ctx.synchronize()

    # ── bit-for-bit, no tolerance ────────────────────────────────────────────
    var bad = 0
    var printed = 0
    for i in range(n_meas):
        if UInt32(h_meas[i].to_bits()) != UInt32(cpu_m[i].to_bits()):
            bad += 1
            if printed < MAX_PRINTED:
                print("  slot", i // MEASURE_STRIDE, "measure lane", i % MEASURE_STRIDE,
                      "— gpu", h_meas[i], "cpu", cpu_m[i])
                printed += 1
    for i in range(n_cnt):
        if h_cnt[i] != cpu_c[i]:
            bad += 1
            if printed < MAX_PRINTED:
                print("  slot", i // COUNT_STRIDE, "count lane", i % COUNT_STRIDE,
                      "— gpu", h_cnt[i], "cpu", cpu_c[i])
                printed += 1
    return bad


def main() raises:
    comptime assert has_accelerator(), "gpu_decode requires a GPU"
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/gpu_decode.mojo <fixture.pipe.bin> ...")
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
        print("gpu decode: bit-exact with the CPU port on every fixture")
    else:
        raise Error("gpu decode diverged")
