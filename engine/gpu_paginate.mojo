# gpu_paginate.mojo — pagination on device, and where the bit-exact tier ENDS.
#
# decode and chunkReduce are bit-exact on device. paginate cannot be, and the
# reason is structural rather than a shortfall:
#
#   The CPU kernel does its positional math in f64 — `origin_y - Float64(row) * lh`,
#   `Float64(y_page % wide) * page_stride_x`. It does that because the JS oracle
#   uses JS numbers, which ARE f64, and the port's job is to reproduce the oracle.
#   Metal has no double precision at all, so that arithmetic cannot run on an Apple
#   GPU in any form. The device must compute positions in f32.
#
# So this dispatch is an EPS-tier comparison, exactly like the foldless float lanes
# in conformance_scan — and for the same underlying reason, now confirmed as a
# hardware fact rather than a numerical preference.
#
# What stays exact, and this is the part worth noticing: every page DECISION is an
# integer gate on the count lanes — y_page, x_page, band, seg, screen_row are all
# integer arithmetic on ROW/COL. Only the final positions differ, and only in the
# last bits. The pagination never picks a different page on device; it places the
# same glyph on the same page a few ULP away.
#
# Run: mojo run -I engine engine/gpu_paginate.mojo engine/fixtures/*.pipe.bin

from std.sys import argv, has_accelerator
from std.gpu import global_idx
from max.gpu.host import DeviceContext
from glyph_schema import (
    MEASURE_STRIDE, COUNT_STRIDE, M_X, M_Y, M_Z, M_BASE_X, C_ROW, C_COL, C_FLAGS,
    ITEM_STRIDE, I_ORIGIN_Y, I_ORIGIN_Z, I_PAGE_ROWS, I_PAGE_COLS, I_SCROLL_ROWS,
    I_PAGES_WIDE, I_WRAP_WIDTH, I_LINE_HEIGHT, I_PAGE_LINE_HEIGHT, I_Z_STEP,
    I_BAND_STRIDE_Y, I_DEPTH_PER_BAND, I_DEPTH_PER_COL, I_PAGE_STRIDE_X, I_HAS_PAGE,
)
from glyph_pipeline import (
    run_pipeline, F_LEADER, trunc_nonneg, is_nan, item_for_byte, derive_stride,
)
from fixture_io import load_pipe_fixture

comptime MAX_PRINTED = 8
comptime EPS = 1e-4


def trunc_nn32(v: Float32) -> Int:
    if v != v or v <= 0:
        return 0
    return Int(v)


def paginate_kernel(
    measures: MutPointer[Float32, MutAnyOrigin],
    counts: MutPointer[UInt32, MutAnyOrigin],
    items: MutPointer[Float32, MutAnyOrigin],
    item_of: MutPointer[UInt32, MutAnyOrigin],
    n_bytes: Int32,
):
    """Thread per byte. Integer gates on the count lanes; f32 for positions only."""
    var id = global_idx.x
    if id >= Int(n_bytes):
        return
    var co = id * COUNT_STRIDE
    if (Int(counts[unsafe_offset = co + C_FLAGS]) & F_LEADER) == 0:
        return
    var io = Int(item_of[unsafe_offset=id]) * ITEM_STRIDE
    var has_page = items[unsafe_offset = io + I_HAS_PAGE] > 0.5

    var rows = trunc_nn32(items[unsafe_offset = io + I_PAGE_ROWS]) if has_page else 0
    var cols = trunc_nn32(items[unsafe_offset = io + I_PAGE_COLS]) if has_page else 0
    var scroll = trunc_nn32(items[unsafe_offset = io + I_SCROLL_ROWS]) if has_page else 0
    if rows == 0 and cols == 0 and scroll == 0:
        return

    # ── every page decision is an INTEGER gate on the count lanes ────────────
    var row = Int(counts[unsafe_offset = co + C_ROW])
    var col = Int(counts[unsafe_offset = co + C_COL])
    var screen_row = row - scroll
    var y_page = 0
    if rows > 0 and screen_row >= rows:
        y_page = screen_row // rows
    var x_page = 0
    if cols > 0:
        x_page = col // cols
    var wide_raw = trunc_nn32(items[unsafe_offset = io + I_PAGES_WIDE])
    var wide = wide_raw if wide_raw > 1 else 1
    var band = y_page // wide
    var wrap = trunc_nn32(items[unsafe_offset = io + I_WRAP_WIDTH])
    var seg = (col // wrap) if wrap > 0 else 0

    # The page's own lineHeight is NOT consulted — mirrors 4697e3b. The fallback
    # could only fire on an item with a NaN lineHeight, which the oracle now
    # refuses, so it was reachable solely through malformed input. Proven, not
    # argued: poisoning this branch left all twelve suites green, while poisoning
    # the TAKEN read below failed both GPU suites — so they do exercise this line.
    var lh = items[unsafe_offset = io + I_LINE_HEIGHT]

    # ── only the POSITIONS are float, and only here ─────────────────────────
    var mo = id * MEASURE_STRIDE
    measures[unsafe_offset = mo + M_X] = (
        measures[unsafe_offset = mo + M_BASE_X]
        + Float32(y_page % wide) * items[unsafe_offset = io + I_PAGE_STRIDE_X]
    )
    measures[unsafe_offset = mo + M_Y] = (
        items[unsafe_offset = io + I_ORIGIN_Y]
        - Float32(screen_row - y_page * rows) * lh
        - Float32(band) * items[unsafe_offset = io + I_BAND_STRIDE_Y]
    )
    measures[unsafe_offset = mo + M_Z] = (
        items[unsafe_offset = io + I_ORIGIN_Z]
        - Float32(seg) * items[unsafe_offset = io + I_Z_STEP]
        + Float32(band) * items[unsafe_offset = io + I_DEPTH_PER_BAND]
        + Float32(x_page) * items[unsafe_offset = io + I_DEPTH_PER_COL]
    )


def rel_close(a: Float32, b: Float32) -> Bool:
    if a != a and b != b:
        return True  # NaN lanes agree
    var d = Float64(a) - Float64(b)
    if d < 0:
        d = -d
    var m = Float64(a) if a > 0 else -Float64(a)
    var mb = Float64(b) if b > 0 else -Float64(b)
    if mb > m:
        m = mb
    if m < 1.0:
        m = 1.0
    return d / m <= EPS


def check_case(path: String, ctx: DeviceContext) raises -> Int:
    var fx = load_pipe_fixture(path)
    var n = fx.byte_len
    if n == 0:
        return 0
    var whole = run_pipeline(fx.bytes, fx.trie, fx.items)

    # Item table, narrowed f64 -> f32 at the device boundary (see the header).
    var ni = fx.item_count if fx.item_count > 0 else 1
    var tbl = List[Float32](unsafe_uninit_length=ni * ITEM_STRIDE)
    for i in range(len(tbl)):
        tbl[i] = 0
    for i in range(fx.item_count):
        var o = i * ITEM_STRIDE
        var t = fx.items[i].copy()
        tbl[o + I_ORIGIN_Y] = Float32(t.origin_y)
        tbl[o + I_ORIGIN_Z] = Float32(t.origin_z)
        tbl[o + I_PAGE_ROWS] = Float32(t.page_rows)
        tbl[o + I_PAGE_COLS] = Float32(t.page_cols)
        tbl[o + I_SCROLL_ROWS] = Float32(t.scroll_rows)
        tbl[o + I_PAGES_WIDE] = Float32(t.pages_wide)
        tbl[o + I_WRAP_WIDTH] = Float32(t.wrap_width)
        tbl[o + I_LINE_HEIGHT] = Float32(t.line_height)
        tbl[o + I_PAGE_LINE_HEIGHT] = Float32(t.page_line_height)
        tbl[o + I_Z_STEP] = Float32(t.z_step)
        tbl[o + I_BAND_STRIDE_Y] = Float32(t.band_stride_y)
        tbl[o + I_DEPTH_PER_BAND] = Float32(t.depth_per_band)
        tbl[o + I_DEPTH_PER_COL] = Float32(t.depth_per_col)
        # The fan stride is DERIVED from the item's max row extent (a fold
        # scalar), which is why the JS side carries it in its own buffer rather
        # than as an item param. Computed on the host in f64 and narrowed, like
        # every other lane here.
        tbl[o + I_PAGE_STRIDE_X] = Float32(derive_stride(whole.item_bounds[i * 8 + 7], t))
        tbl[o + I_HAS_PAGE] = 1 if t.has_page else 0

    var item_of = List[UInt32](unsafe_uninit_length=n)
    for id in range(n):
        var i = item_for_byte(fx.items, id)
        item_of[id] = UInt32(i) if i >= 0 else UInt32(0)

    var h_m = ctx.enqueue_create_host_buffer[DType.float32](n * MEASURE_STRIDE)
    var h_c = ctx.enqueue_create_host_buffer[DType.uint32](n * COUNT_STRIDE)
    var h_t = ctx.enqueue_create_host_buffer[DType.float32](len(tbl))
    var h_i = ctx.enqueue_create_host_buffer[DType.uint32](n)
    ctx.synchronize()
    for i in range(n * MEASURE_STRIDE):
        h_m[i] = whole.measures[i]
    for i in range(n * COUNT_STRIDE):
        h_c[i] = whole.counts[i]
    for i in range(len(tbl)):
        h_t[i] = tbl[i]
    for i in range(n):
        h_i[i] = item_of[i]

    var d_m = ctx.enqueue_create_buffer[DType.float32](n * MEASURE_STRIDE)
    var d_c = ctx.enqueue_create_buffer[DType.uint32](n * COUNT_STRIDE)
    var d_t = ctx.enqueue_create_buffer[DType.float32](len(tbl))
    var d_i = ctx.enqueue_create_buffer[DType.uint32](n)
    ctx.enqueue_copy(dst_buf=d_m, src_buf=h_m)
    ctx.enqueue_copy(dst_buf=d_c, src_buf=h_c)
    ctx.enqueue_copy(dst_buf=d_t, src_buf=h_t)
    ctx.enqueue_copy(dst_buf=d_i, src_buf=h_i)

    comptime BLOCK = 256
    ctx.enqueue_function[paginate_kernel](
        d_m.unsafe_ptr(), d_c.unsafe_ptr(), d_t.unsafe_ptr(), d_i.unsafe_ptr(),
        Int32(n), grid_dim=(n + BLOCK - 1) // BLOCK, block_dim=BLOCK,
    )
    ctx.enqueue_copy(dst_buf=h_m, src_buf=d_m)
    ctx.synchronize()

    var bad = 0
    var printed = 0
    for id in range(n):
        if (Int(whole.counts[id * COUNT_STRIDE + C_FLAGS]) & F_LEADER) == 0:
            continue
        var mo = id * MEASURE_STRIDE
        for lane in range(3):  # X, Y, Z — the only lanes paginate writes
            var g = h_m[mo + M_X + lane]
            var e = whole.measures[mo + M_X + lane]
            if not rel_close(g, e):
                bad += 1
                if printed < MAX_PRINTED:
                    print("  byte", id, "lane", M_X + lane, "gpu", g, "cpu", e)
                    printed += 1
    return bad


def main() raises:
    comptime assert has_accelerator(), "gpu_paginate requires a GPU"
    var args = argv()
    if len(args) < 2:
        print("usage: mojo run -I engine engine/gpu_paginate.mojo <fixture.pipe.bin> ...")
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
            print("FAIL", path, "—", bad, "lanes past eps")
        total_bad += bad
    if total_bad == 0:
        print("gpu paginate: every page decision identical, positions within 1e-4")
    else:
        raise Error("gpu paginate diverged past the eps tier")
