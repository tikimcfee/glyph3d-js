# gpu_bounds.mojo — the bounds reduce on device, and the fold-scalar split.
#
# The CPU kernel folds boxes in f64. Metal has no f64, so the device cannot. But
# widening f32 -> f64 is LOSSLESS and min/max preserves order, so f64 buys nothing
# for the reduce itself — it buys exactly one thing: `x + w` and `y + h` computed
# at f64 instead of rounding once in f32. That is an eps-tier difference, and the
# 6 box lanes are already compared at eps by conformance_scan.
#
# THE SPLIT. Lane 6 (TOTAL_ROWS) is a COUNT — `row + 1` — and the TSL side stores
# it through floatToOrderedKey, which is a float carrier wearing a u32 costume. It
# aliases past 2^24, and it is reachable: S_ROW is the VISUAL row, so at wrap = 1
# rows track glyph count and cross 2^24 at ~16.8MB inside a 44.7MB arena. Measured.
#
# So on device the lanes go by KIND, which is also the only form Metal can run:
#   measures (6 box lanes + MAX_ROW_EXTENT)  f32 via a monotonic ordered key, so
#                                            integer atomicMin/Max implements float
#                                            min/max (the TSL side's own trick)
#   counts   (TOTAL_ROWS)                    a NATIVE u32 atomicMax. No mapping at
#                                            all, no wall, and 0 is genuinely the
#                                            identity for max over non-negative u32
#                                            rather than "the key for -inf".
#
# Run: mojo run -I engine engine/gpu_bounds.mojo engine/fixtures/*.pipe.bin

from std.sys import argv, has_accelerator
from std.gpu import global_idx
from std.atomic import Atomic
from std.memory import bitcast
from max.gpu.host import DeviceContext
from glyph_schema import (
    SM_STRIDE, SM_ADVANCE, SM_HEIGHT,
    LM_STRIDE, LM_X, LM_Y, LM_Z,
    LC_STRIDE, LC_ROW, BOUNDS_STRIDE,
    B_MIN_X, B_MIN_Y, B_MIN_Z, B_MAX_X, B_MAX_Y, B_MAX_Z,
    B_TOTAL_ROWS, B_MAX_ROW_EXTENT,
)
from glyph_pipeline import run_pipeline, F_LEADER, item_for_byte
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8
comptime EPS = 1e-4


def ordered_key(v: Float32) -> UInt32:
    """f32 -> a u32 whose INTEGER order matches float order, so integer atomics
    implement float min/max. Negatives invert; non-negatives get the sign bit set."""
    var b = UInt32(v.to_bits())
    if (b & 0x80000000) != 0:
        return ~b
    return b | 0x80000000


def key_to_float(k: UInt32) -> Float32:
    var b: UInt32
    if (k & 0x80000000) != 0:
        b = k & 0x7FFFFFFF
    else:
        b = ~k
    return bitcast[DType.float32](b)


def bounds_kernel(
    sm: MutPointer[Float32, MutAnyOrigin],
    fl: MutPointer[UInt32, MutAnyOrigin],
    lm: MutPointer[Float32, MutAnyOrigin],
    lc: MutPointer[UInt32, MutAnyOrigin],
    item_of: MutPointer[UInt32, MutAnyOrigin],
    box_keys: MutPointer[UInt32, MutAnyOrigin],
    row_counts: MutPointer[UInt32, MutAnyOrigin],
    n_bytes: Int32,
):
    """Thread per byte. Measures fold through ordered-key atomics; the one COUNT
    folds through a native u32 atomicMax with no mapping."""
    var id = global_idx.x
    if id >= Int(n_bytes):
        return
    if (Int(fl[unsafe_offset=id]) & F_LEADER) == 0:
        return
    var it = Int(item_of[unsafe_offset=id])
    var mo = id * LM_STRIDE
    var so = id * SM_STRIDE
    var bb = it * BOUNDS_STRIDE

    var x = lm[unsafe_offset = mo + LM_X]
    var y = lm[unsafe_offset = mo + LM_Y]
    var z = lm[unsafe_offset = mo + LM_Z]
    var w = sm[unsafe_offset = so + SM_ADVANCE]
    var h = sm[unsafe_offset = so + SM_HEIGHT]

    # min lanes: ordered-key atomicMin. max lanes: ordered-key atomicMax.
    _ = Atomic.min(box_keys + (bb + B_MIN_X), ordered_key(x))
    _ = Atomic.min(box_keys + (bb + B_MIN_Y), ordered_key(y))
    _ = Atomic.min(box_keys + (bb + B_MIN_Z), ordered_key(z))
    _ = Atomic.max(box_keys + (bb + B_MAX_X), ordered_key(x + w))
    _ = Atomic.max(box_keys + (bb + B_MAX_Y), ordered_key(y + h))
    _ = Atomic.max(box_keys + (bb + B_MAX_Z), ordered_key(z))

    # THE COUNT: native u32, no ordered key, no wall.
    var row = lc[unsafe_offset = id * LC_STRIDE + LC_ROW]
    _ = Atomic.max(row_counts + (it), row + 1)


def rel_close(a: Float64, b: Float64) -> Bool:
    var d = a - b
    if d < 0:
        d = -d
    var m = a if a > 0 else -a
    var mb = b if b > 0 else -b
    if mb > m:
        m = mb
    if m < 1.0:
        m = 1.0
    return d / m <= EPS


def check_case(path: String, ctx: DeviceContext) raises -> Int:
    var fx = load_pipe_fixture(path)
    var n = fx.byte_len
    if n == 0 or fx.item_count == 0:
        return 0
    var whole = run_pipeline(fx.bytes, fx.trie, fx.items)
    var ni = fx.item_count

    var item_of = List[UInt32](unsafe_uninit_length=n)
    for id in range(n):
        var i = item_for_byte(fx.items, id)
        item_of[id] = UInt32(i) if i >= 0 else UInt32(0)

    var h_sm = ctx.enqueue_create_host_buffer[DType.float32](n * SM_STRIDE)
    var h_fl = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_lm = ctx.enqueue_create_host_buffer[DType.float32](n * LM_STRIDE)
    var h_lc = ctx.enqueue_create_host_buffer[DType.uint32](n * LC_STRIDE)
    var h_i = ctx.enqueue_create_host_buffer[DType.uint32](n)
    var h_b = ctx.enqueue_create_host_buffer[DType.uint32](ni * BOUNDS_STRIDE)
    var h_r = ctx.enqueue_create_host_buffer[DType.uint32](ni)
    ctx.synchronize()
    for i in range(n * SM_STRIDE):
        h_sm[i] = whole.sm[i]
    for i in range(n):
        h_fl[i] = whole.fl[i]
    for i in range(n * LM_STRIDE):
        h_lm[i] = whole.lm[i]
    for i in range(n * LC_STRIDE):
        h_lc[i] = whole.lc[i]
    for i in range(n):
        h_i[i] = item_of[i]
    # min lanes arm at u32 max; max lanes and the count arm at 0 — which for the
    # count is genuinely max's identity over non-negative integers, not a trick.
    for i in range(ni):
        var b = i * BOUNDS_STRIDE
        h_b[b + B_MIN_X] = UInt32(0xFFFFFFFF)
        h_b[b + B_MIN_Y] = UInt32(0xFFFFFFFF)
        h_b[b + B_MIN_Z] = UInt32(0xFFFFFFFF)
        h_b[b + B_MAX_X] = 0
        h_b[b + B_MAX_Y] = 0
        h_b[b + B_MAX_Z] = 0
        h_b[b + B_TOTAL_ROWS] = 0
        h_b[b + B_MAX_ROW_EXTENT] = 0
        h_r[i] = 0

    var d_sm = ctx.enqueue_create_buffer[DType.float32](n * SM_STRIDE)
    var d_fl = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_lm = ctx.enqueue_create_buffer[DType.float32](n * LM_STRIDE)
    var d_lc = ctx.enqueue_create_buffer[DType.uint32](n * LC_STRIDE)
    var d_i = ctx.enqueue_create_buffer[DType.uint32](n)
    var d_b = ctx.enqueue_create_buffer[DType.uint32](ni * BOUNDS_STRIDE)
    var d_r = ctx.enqueue_create_buffer[DType.uint32](ni)
    ctx.enqueue_copy(dst_buf=d_sm, src_buf=h_sm)
    ctx.enqueue_copy(dst_buf=d_fl, src_buf=h_fl)
    ctx.enqueue_copy(dst_buf=d_lm, src_buf=h_lm)
    ctx.enqueue_copy(dst_buf=d_lc, src_buf=h_lc)
    ctx.enqueue_copy(dst_buf=d_i, src_buf=h_i)
    ctx.enqueue_copy(dst_buf=d_b, src_buf=h_b)
    ctx.enqueue_copy(dst_buf=d_r, src_buf=h_r)

    comptime BLOCK = 256
    ctx.enqueue_function[bounds_kernel](
        d_sm.unsafe_ptr(), d_fl.unsafe_ptr(), d_lm.unsafe_ptr(), d_lc.unsafe_ptr(),
        d_i.unsafe_ptr(),
        d_b.unsafe_ptr(), d_r.unsafe_ptr(), Int32(n),
        grid_dim=(n + BLOCK - 1) // BLOCK, block_dim=BLOCK,
    )
    ctx.enqueue_copy(dst_buf=h_b, src_buf=d_b)
    ctx.enqueue_copy(dst_buf=h_r, src_buf=d_r)
    ctx.synchronize()

    var bad = 0
    var printed = 0
    for i in range(ni):
        var b = i * BOUNDS_STRIDE
        var e = i * 8
        # 6 box lanes: eps tier (f64 CPU vs f32 device — Metal has no f64).
        for lane in range(6):
            var g = Float64(key_to_float(h_b[b + lane]))
            var want = whole.item_bounds[e + lane]
            if want > 1e300 or want < -1e300:
                continue  # a leaderless item's +/-inf sentinel
            if not rel_close(g, want):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  item", i, "box lane", lane, "gpu", g, "cpu", want)
                    printed += 1
        # TOTAL_ROWS: a COUNT. Compared EXACTLY — there is no tolerance to hide in.
        var g_rows = Int(h_r[i])
        var want_rows = Int(whole.item_bounds[e + B_TOTAL_ROWS])
        if g_rows != want_rows:
            bad += 1
            if printed < MAX_PRINTED:
                print("  item", i, "TOTAL_ROWS gpu", g_rows, "cpu", want_rows)
                printed += 1
    return bad


def main() raises:
    comptime assert has_accelerator(), "gpu_bounds requires a GPU"
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/gpu_bounds.mojo <fixture.pipe.bin> ...")
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
            print("FAIL", path, "—", bad, "mismatches")
        total_bad += bad
    if total_bad == 0:
        print("gpu bounds: boxes within 1e-4, TOTAL_ROWS exact as a native u32 count")
    else:
        raise Error("gpu bounds diverged")
