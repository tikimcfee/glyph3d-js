# glyph_scan.mojo — the parallel fold as a segmented monoid scan, natively.
#
# Port of glyphPipelineScan.js's runScanPipeline: the GPU's dispatch structure
# (chunkReduce → spineReduce → spineScan → partialScan → apply → resolveX →
# paginate → bounds), and here the dispatches actually RUN in parallel — each
# TaskGroup shard below is a batch of the threads one GPU dispatch would launch.
# spineScan stays one thread, exactly as it does on hardware. Determinism is
# structural, same as the GPU's: workers write disjoint elements or reduce with
# exact (min/max) merges; nothing order-sensitive crosses a shard.
#
# Precision contract vs the serial oracle (the repo's own tiered comparator,
# tools/scan-layout.test.mjs):
#   - every EXACT lane (id, advance, height, row, col, flags, ord) bit-equal
#   - fold>0 float lanes bit-equal (resolveX's forward f32 re-sum ≡ serial segAdv)
#   - foldless float lanes within 1e-4 RELATIVE (serial f64 prefix vs the scan's
#     f32 lane — grouping differs by construction, integers never do)
#
# Mirrors (never diverge): packages/glyph3d-core/src/compute/glyphPipelineScan.js

from std.memory import unsafe_memset_zero
from std.runtime.asyncrt import TaskGroup, parallelism_level
from glyph_pipeline import (
    Trie,
    Item,
    PipelineResult,
    SLOT_STRIDE,
    S_ADVANCE,
    S_ROW,
    S_COL,
    S_FLAGS,
    S_LINE_ADV,
    S_ORD,
    F_LEADER,
    F_NEWLINE,
    F_RENDERED,
    F_MISSING,
    F64_INF,
    NEWLINE,
    decode_codepoint_at,
    sequence_length,
    item_for_byte,
    resolve_x,
    paginate,
    page_active,
    bounds_reduce,
    derive_stride,
    trunc_nonneg,
    shard_lo,
    _decode_shard,
    _paginate_shard,
    _bounds_shard,
)
from glyph_bake import (
    ScanElem,
    scan_identity,
    scan_leaf_value,
    scan_combine,
    lanes_from_prefix,
)

comptime CHUNK_SIZE = 64
comptime GROUP_SIZE = 256


def scan_leaf[so: Origin[mut=True]](
    slots: Pointer[Float32, so], id: Int, wrap: Int, is_item_start: Bool
) -> ScanElem:
    """The leaf for byte `id`, read from the decoded slots."""
    var flags = Int(slots[unsafe_offset = id * SLOT_STRIDE + S_FLAGS])
    return scan_leaf_value(
        (flags & F_NEWLINE) != 0,
        slots[unsafe_offset = id * SLOT_STRIDE + S_ADVANCE],
        (flags & F_LEADER) != 0,
        wrap,
        is_item_start,
    )


def _cursor_advance(items: List[Item], mut idx: Int, id: Int):
    """The item cursor: O(1) advances at boundary crossings (the GPU's serial
    chunk loops do exactly this after one binary search at the range start)."""
    while idx + 1 < len(items) and id >= items[idx + 1].byte_start:
        idx += 1


def fold_range[so: Origin[mut=True]](
    slots: Pointer[Float32, so],
    items: List[Item],
    wraps: List[Int],
    from_byte: Int,
    to_byte: Int,
    mut acc: ScanElem,
):
    """Serial fold of leaves over [from, to) — the body of chunkReduce."""
    if from_byte >= to_byte:
        return
    var idx = item_for_byte(items, from_byte)
    var id = from_byte
    while id < to_byte:
        _cursor_advance(items, idx, id)
        var leaf = scan_leaf(slots, id, wraps[idx], id == items[idx].byte_start)
        scan_combine(acc, leaf)
        id += 1


async def _chunk_reduce_shard[so: Origin[mut=True], po: Origin[mut=True]](
    slots: Pointer[Float32, so],
    items: List[Item],
    wraps: List[Int],
    partials: Pointer[ScanElem, po],
    n: Int,
    k: Int,
    c_start: Int,
    c_stop: Int,
):
    for c in range(c_start, c_stop):
        var acc = scan_identity()
        var to = (c + 1) * k
        if to > n:
            to = n
        fold_range(slots, items, wraps, c * k, to, acc)
        partials[unsafe_offset = c] = acc^


async def _spine_reduce_shard[po: Origin[mut=True], uo: Origin[mut=True]](
    partials: Pointer[ScanElem, po],
    supers: Pointer[ScanElem, uo],
    num_chunks: Int,
    g: Int,
    g_start: Int,
    g_stop: Int,
):
    for sg in range(g_start, g_stop):
        var acc = scan_identity()
        var c = sg * g
        var last = (sg + 1) * g
        if last > num_chunks:
            last = num_chunks
        while c < last:
            scan_combine(acc, partials[unsafe_offset = c])
            c += 1
        supers[unsafe_offset = sg] = acc^


async def _partial_scan_shard[
    po: Origin[mut=True], fo: Origin[mut=True], xo: Origin[mut=True]
](
    partials: Pointer[ScanElem, po],
    super_prefix: Pointer[ScanElem, fo],
    partial_prefix: Pointer[ScanElem, xo],
    num_chunks: Int,
    g: Int,
    g_start: Int,
    g_stop: Int,
):
    for sg in range(g_start, g_stop):
        var acc = super_prefix[unsafe_offset = sg].copy()
        var c = sg * g
        var last = (sg + 1) * g
        if last > num_chunks:
            last = num_chunks
        while c < last:
            partial_prefix[unsafe_offset = c] = acc.copy()
            scan_combine(acc, partials[unsafe_offset = c])
            c += 1


async def _apply_shard[
    so: Origin[mut=True], xo: Origin[mut=True], oo: Origin[mut=True]
](
    slots: Pointer[Float32, so],
    items: List[Item],
    wraps: List[Int],
    partial_prefix: Pointer[ScanElem, xo],
    ord_to_byte: Pointer[UInt32, oo],
    n: Int,
    k: Int,
    c_start: Int,
    c_stop: Int,
):
    for c in range(c_start, c_stop):
        var from_byte = c * k
        var to = (c + 1) * k
        if to > n:
            to = n
        if from_byte >= to:
            continue
        var run = partial_prefix[unsafe_offset = c].copy()
        var idx = item_for_byte(items, from_byte)
        var id = from_byte
        while id < to:
            _cursor_advance(items, idx, id)
            var is_start = id == items[idx].byte_start
            if is_start:
                run = scan_identity()
                run.wrap = wraps[idx]
            var o = id * SLOT_STRIDE
            var flags = Int(slots[unsafe_offset = o + S_FLAGS])
            if (flags & F_LEADER) != 0:
                var v = lanes_from_prefix(run, wraps[idx])
                slots[unsafe_offset = o + S_ROW] = Float32(v.row)
                slots[unsafe_offset = o + S_COL] = Float32(v.col)
                slots[unsafe_offset = o + S_LINE_ADV] = v.line_adv
                slots[unsafe_offset = o + S_ORD] = Float32(v.ord)
                slots[unsafe_offset = o + S_FLAGS] = Float32(flags | F_RENDERED)
                ord_to_byte[unsafe_offset = items[idx].byte_start + v.ord] = UInt32(id)
            var leaf = scan_leaf(slots, id, wraps[idx], is_start)
            scan_combine(run, leaf)
            id += 1


async def _resolve_x_shard[
    so: Origin[mut=True], oo: Origin[mut=True], ko: Origin[mut=True]
](
    slots: Pointer[Float32, so],
    item: Item,
    ord_to_byte: Pointer[UInt32, oo],
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
    start: Int,
    stop: Int,
):
    for id in range(start, stop):
        resolve_x(slots, id, item, ord_to_byte, scalars, scalar_base)


def run_scan_pipeline(
    bytes: List[UInt8],
    trie: Trie,
    items: List[Item],
    chunk_size: Int,
    group_size: Int,
) -> PipelineResult:
    """Run the pipeline by the scan — same inputs and outputs as run_pipeline,
    computed in the GPU's dispatch structure, dispatches sharded across cores.
    chunk/group sizes are the tuning dials the tests sweep (invariance across
    them is associativity in situ)."""
    var k = chunk_size if chunk_size > 0 else 1
    var g = group_size if group_size > 0 else 1
    var n = len(bytes)
    var workers = parallelism_level()
    if workers < 1:
        workers = 1

    # ── dispatch 1: decode (shared kernel), sharded ───────────────────────────
    var slots = List[Float32](unsafe_uninit_length=n * SLOT_STRIDE)
    unsafe_memset_zero(slots.unsafe_ptr(), len(slots))
    var sp = slots.unsafe_ptr()
    var tg1 = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, n, workers, w)
        var b = shard_lo(0, n, workers, w + 1)
        tg1.create_task(_decode_shard(bytes, sp, trie, a, b))
    tg1.wait()

    # Ordered miss rebuild (byte order, duplicates kept) — the serial pass.
    var misses = List[UInt32]()
    var id = 0
    while id < n:
        var flags = Int(sp[unsafe_offset = id * SLOT_STRIDE + S_FLAGS])
        if (flags & F_LEADER) != 0 and (flags & F_MISSING) != 0:
            misses.append(
                UInt32(decode_codepoint_at(bytes, id, sequence_length(bytes, id)))
            )
        id += 1

    var wraps = List[Int]()
    var i = 0
    while i < len(items):
        wraps.append(trunc_nonneg(items[i].wrap_width))
        i += 1

    # ── dispatch 2: chunkReduce — thread per chunk, chunks sharded ────────────
    var num_chunks = (n + k - 1) // k
    var partials = List[ScanElem]()
    for _ in range(num_chunks):
        partials.append(scan_identity())
    var pp = partials.unsafe_ptr()
    var tg2 = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, num_chunks, workers, w)
        var b = shard_lo(0, num_chunks, workers, w + 1)
        tg2.create_task(_chunk_reduce_shard(sp, items, wraps, pp, n, k, a, b))
    tg2.wait()

    # ── dispatch 3: spineReduce — thread per group, groups sharded ────────────
    var num_supers = (num_chunks + g - 1) // g
    var supers = List[ScanElem]()
    for _ in range(num_supers):
        supers.append(scan_identity())
    var up = supers.unsafe_ptr()
    var tg3 = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, num_supers, workers, w)
        var b = shard_lo(0, num_supers, workers, w + 1)
        tg3.create_task(_spine_reduce_shard(pp, up, num_chunks, g, a, b))
    tg3.wait()

    # ── dispatch 4: spineScan — ONE thread, exclusive scan of supers ──────────
    var super_prefix = List[ScanElem]()
    var spine_acc = scan_identity()
    var sg = 0
    while sg < num_supers:
        super_prefix.append(spine_acc.copy())
        scan_combine(spine_acc, supers[sg])
        sg += 1
    var fp = super_prefix.unsafe_ptr()

    # ── dispatch 5: partialScan — thread per group, groups sharded ────────────
    var partial_prefix = List[ScanElem]()
    for _ in range(num_chunks):
        partial_prefix.append(scan_identity())
    var xp = partial_prefix.unsafe_ptr()
    var tg5 = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, num_supers, workers, w)
        var b = shard_lo(0, num_supers, workers, w + 1)
        tg5.create_task(_partial_scan_shard(pp, fp, xp, num_chunks, g, a, b))
    tg5.wait()

    # ── dispatch 6: apply — thread per chunk, chunks sharded ──────────────────
    var ord_to_byte = List[UInt32](unsafe_uninit_length=n)
    unsafe_memset_zero(ord_to_byte.unsafe_ptr(), len(ord_to_byte))
    var op = ord_to_byte.unsafe_ptr()
    var tg6 = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, num_chunks, workers, w)
        var b = shard_lo(0, num_chunks, workers, w + 1)
        tg6.create_task(_apply_shard(sp, items, wraps, xp, op, n, k, a, b))
    tg6.wait()

    # ── dispatch 7: resolveX + fold-scalar reduce — per item, sharded, with
    #    per-shard scalar rows max-merged (exact under regrouping) ─────────────
    var item_count = len(items)
    var item_bounds = List[Float64](length=item_count * 8, fill=0)
    var shard_scalars = List[Float64](length=workers * 8, fill=0)
    var ssp = shard_scalars.unsafe_ptr()
    for i2 in range(item_count):
        for w in range(workers * 8):
            shard_scalars[w] = 0
        var start = items[i2].byte_start
        var stop = start + items[i2].byte_count
        var tg7 = TaskGroup()
        for w in range(workers):
            var a = shard_lo(start, stop, workers, w)
            var b = shard_lo(start, stop, workers, w + 1)
            tg7.create_task(_resolve_x_shard(sp, items[i2], op, ssp, w * 8, a, b))
        tg7.wait()
        for w in range(workers):
            if shard_scalars[w * 8 + 6] > item_bounds[i2 * 8 + 6]:
                item_bounds[i2 * 8 + 6] = shard_scalars[w * 8 + 6]
            if shard_scalars[w * 8 + 7] > item_bounds[i2 * 8 + 7]:
                item_bounds[i2 * 8 + 7] = shard_scalars[w * 8 + 7]

    # ── dispatch 8: paginate, stride derived from the fold scalars ────────────
    var tg8 = TaskGroup()
    for i2 in range(item_count):
        if not page_active(items[i2]):
            continue
        var stride = derive_stride(item_bounds[i2 * 8 + 7], items[i2])
        var start = items[i2].byte_start
        var stop = start + items[i2].byte_count
        for w in range(workers):
            var a = shard_lo(start, stop, workers, w)
            var b = shard_lo(start, stop, workers, w + 1)
            tg8.create_task(_paginate_shard(sp, items[i2], stride, a, b))
    tg8.wait()

    # ── per-item boxes: sharded local boxes, exact min/max merge ──────────────
    var batch_bounds = List[Float64](length=8, fill=0)
    batch_bounds[0] = F64_INF
    batch_bounds[1] = F64_INF
    batch_bounds[2] = F64_INF
    batch_bounds[3] = -F64_INF
    batch_bounds[4] = -F64_INF
    batch_bounds[5] = -F64_INF
    var shard_boxes = List[Float64](length=workers * 8, fill=0)
    var sbp = shard_boxes.unsafe_ptr()
    for i2 in range(item_count):
        var b8 = i2 * 8
        for w in range(workers):
            shard_boxes[w * 8 + 0] = F64_INF
            shard_boxes[w * 8 + 1] = F64_INF
            shard_boxes[w * 8 + 2] = F64_INF
            shard_boxes[w * 8 + 3] = -F64_INF
            shard_boxes[w * 8 + 4] = -F64_INF
            shard_boxes[w * 8 + 5] = -F64_INF
        var start = items[i2].byte_start
        var stop = start + items[i2].byte_count
        var tg9 = TaskGroup()
        for w in range(workers):
            var a = shard_lo(start, stop, workers, w)
            var b = shard_lo(start, stop, workers, w + 1)
            tg9.create_task(_bounds_shard(sp, sbp, w * 8, a, b))
        tg9.wait()
        item_bounds[b8 + 0] = F64_INF
        item_bounds[b8 + 1] = F64_INF
        item_bounds[b8 + 2] = F64_INF
        item_bounds[b8 + 3] = -F64_INF
        item_bounds[b8 + 4] = -F64_INF
        item_bounds[b8 + 5] = -F64_INF
        for w in range(workers):
            var l = 0
            while l < 3:
                if shard_boxes[w * 8 + l] < item_bounds[b8 + l]:
                    item_bounds[b8 + l] = shard_boxes[w * 8 + l]
                l += 1
            while l < 6:
                if shard_boxes[w * 8 + l] > item_bounds[b8 + l]:
                    item_bounds[b8 + l] = shard_boxes[w * 8 + l]
                l += 1
        var l = 0
        while l < 3:
            if item_bounds[b8 + l] < batch_bounds[l]:
                batch_bounds[l] = item_bounds[b8 + l]
            l += 1
        while l < 8:
            if item_bounds[b8 + l] > batch_bounds[l]:
                batch_bounds[l] = item_bounds[b8 + l]
            l += 1

    var leaders = 0
    id = 0
    while id < n:
        if (Int(sp[unsafe_offset = id * SLOT_STRIDE + S_FLAGS]) & F_LEADER) != 0:
            leaders += 1
        id += 1

    # KEEP-ALIVE ANCHORS. Mojo destroys a value at its LAST USE, not scope end —
    # a List whose final mention is `create_task(...)` is freed before the tasks
    # run, and the workers read recycled memory. Anchoring after the last wait is
    # the documented idiom; these are not dead code.
    _ = len(wraps)
    _ = len(partials)
    _ = len(supers)
    _ = len(super_prefix)
    _ = len(partial_prefix)
    _ = len(shard_scalars)
    _ = len(shard_boxes)

    var r = PipelineResult()
    r.slots = slots^
    r.ord_to_byte = ord_to_byte^
    r.misses = misses^
    r.leaders = leaders
    r.item_bounds = item_bounds^
    r.batch_bounds = batch_bounds^
    return r^
