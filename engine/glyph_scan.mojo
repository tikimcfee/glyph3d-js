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

from std.collections.span import Span
from std.memory import unsafe_memset_zero
from std.runtime.asyncrt import TaskGroup, parallelism_level
from glyph_schema import SM_STRIDE, LM_STRIDE, LC_STRIDE
from glyph_pipeline import (
    Trie,
    Item,
    PipelineResult,
    Slots,
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
    derive_stride,
    trunc_nonneg,
    shard_lo,
    _decode_shard,
    _paginate_shard,
    _bounds_item,
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


def scan_leaf(
    slots: Slots, id: Int, wrap: Int, is_item_start: Bool
) -> ScanElem:
    """The leaf for byte `id`, read from the decoded STATIC arrays only."""
    var flags = slots.flags(id)
    return scan_leaf_value(
        (flags & F_NEWLINE) != 0,
        slots.advance(id),
        (flags & F_LEADER) != 0,
        wrap,
        is_item_start,
    )


def _cursor_advance(items: List[Item], mut idx: Int, id: Int):
    """The item cursor: O(1) advances at boundary crossings (the GPU's serial
    chunk loops do exactly this after one binary search at the range start)."""
    while idx + 1 < len(items) and id >= items[idx + 1].byte_start:
        idx += 1


def fold_range(
    slots: Slots,
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


async def _chunk_reduce_shard[po: Origin[mut=True]](
    slots: Slots,
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
    po: Origin[mut=True], oo: Origin[mut=True],
](
    slots: Slots,
    items: List[Item],
    wraps: List[Int],
    partial_prefix: Pointer[ScanElem, po],
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
            var flags = slots.flags(id)
            # THE GAP GUARD. item_for_byte returns the largest item whose start <= id
            # and does NOT check ownership, so a byte in a HOLE between two items
            # resolves to the preceding one. Without this test the scan form laid
            # those bytes out as if they belonged to it: ROW/COL/ORD written,
            # F_RENDERED set, the ordinal counter advanced through the gap, and
            # ord_to_byte[byte_start + ord] written PAST the item's range.
            #
            # Measured on a 3-item arena with a 100-byte hole and a 200-byte tail:
            # 300 count-lane disagreements against run_pipeline, 300 gap bytes
            # marked F_RENDERED, 300 ord_to_byte disagreements. The serial
            # layout_item cannot do this — it stops at the item's end.
            #
            # glyphPipelineKernels' apply has had this guard all along, with the
            # reason in its comment: a dead-space byte's "fold-scalar/box reduces
            # must never pollute that item (a stale widest-row is a wrong page-fan
            # stride)". So this was a PORT divergence, not a shared defect.
            #
            # NOTE a remaining three-way difference, deliberately not resolved here:
            # the TSL additionally ZEROES the flags lane for such a byte, while both
            # forms of this port leave decode's flags in place. Aligning the scan
            # form to the serial one is what conformance_scan requires; the flag
            # question belongs with the render side.
            var it_start = items[idx].byte_start
            var in_item = id >= it_start and id < it_start + items[idx].byte_count
            if (flags & F_LEADER) != 0 and in_item:
                var v = lanes_from_prefix(run, wraps[idx])
                slots.set_row(id, v.row)
                slots.set_col(id, v.col)
                slots.set_line_adv(id, v.line_adv)
                slots.set_ord(id, v.ord)
                slots.set_flags(id, flags | F_RENDERED)
                ord_to_byte[unsafe_offset = it_start + v.ord] = UInt32(id)
            else:
                # THE SPLIT'S COVERAGE DUTY, scan form. Decode no longer zeroes
                # the positional lanes, so every byte that is not a laid-out
                # leader — continuation bytes, gap bytes, gap LEADERS the guard
                # above excludes — gets its zeros here. This walk visits every
                # byte of [0, n) exactly once across the chunk shards, so the
                # coverage is total. X/Y/Z/BASE_X of in-item leaders are
                # resolve_x's; everything else has no other writer.
                slots.zero_positional(id)
            var leaf = scan_leaf(slots, id, wraps[idx], is_start)
            scan_combine(run, leaf)
            id += 1


async def _resolve_x_shard[
    oo: Origin[mut=True], ko: Origin[mut=True]
](
    slots: Slots,
    item: Item,
    ord_to_byte: Pointer[UInt32, oo],
    scalars: Pointer[Float64, ko],
    scalar_base: Int,
    start: Int,
    stop: Int,
):
    for id in range(start, stop):
        resolve_x(slots, id, item, ord_to_byte, scalars, scalar_base)


def run_scan_pipeline[o: ImmOrigin](
    bytes: Span[UInt8, o],
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
    # No slot memset. Static: decode covers [0, n). Positional: _apply_shard
    # zeroes every byte that is not a laid-out leader while it walks its chunks
    # (total coverage — the chunks tile [0, n)), and resolve_x writes in-item
    # leaders' X/Y/Z/BASE_X.
    var r = PipelineResult()
    r.sm = List[Float32](unsafe_uninit_length=n * SM_STRIDE)
    r.fl = List[UInt32](unsafe_uninit_length=n)
    r.lm = List[Float32](unsafe_uninit_length=n * LM_STRIDE)
    r.lc = List[UInt32](unsafe_uninit_length=n * LC_STRIDE)
    var slots = r.slots()
    var miss_scratch = List[UInt32](unsafe_uninit_length=n if n > 0 else 1)
    var msp = miss_scratch.unsafe_ptr()
    var tally = List[Int](length=workers * 2, fill=0)
    var tp = tally.unsafe_ptr()
    var tg1 = TaskGroup()
    for w in range(workers):
        var a = shard_lo(0, n, workers, w)
        var b = shard_lo(0, n, workers, w + 1)
        tg1.create_task(_decode_shard(bytes, slots, trie, msp, tp, w, a, b))
    tg1.wait()
    _ = len(miss_scratch)
    _ = len(tally)

    # Concatenate the shards' miss lists in SHARD order, which is byte order.
    var misses = List[UInt32]()
    for w in range(workers):
        var a = shard_lo(0, n, workers, w)
        for k in range(tally[w * 2 + 1]):
            misses.append(miss_scratch[a + k])

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
        tg2.create_task(_chunk_reduce_shard(slots, items, wraps, pp, n, k, a, b))
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
        tg6.create_task(_apply_shard(slots, items, wraps, xp, op, n, k, a, b))
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
            tg7.create_task(_resolve_x_shard(slots, items[i2], op, ssp, w * 8, a, b))
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
            tg8.create_task(_paginate_shard(slots, items[i2], stride, a, b))
    tg8.wait()

    # ── per-item boxes: sharded local boxes, exact min/max merge ──────────────
    var batch_bounds = List[Float64](length=8, fill=0)
    batch_bounds[0] = F64_INF
    batch_bounds[1] = F64_INF
    batch_bounds[2] = F64_INF
    batch_bounds[3] = -F64_INF
    batch_bounds[4] = -F64_INF
    batch_bounds[5] = -F64_INF
    # ONE TaskGroup, one task per item — see _bounds_item in glyph_pipeline.
    var ibp = item_bounds.unsafe_ptr()
    var tg9 = TaskGroup()
    for i2 in range(item_count):
        var start = items[i2].byte_start
        var stop = start + items[i2].byte_count
        tg9.create_task(_bounds_item(slots, ibp, i2 * 8, start, stop))
    tg9.wait()

    for i2 in range(item_count):
        var b8 = i2 * 8
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
        if (slots.flags(id) & F_LEADER) != 0:
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
    _ = len(item_bounds)
    _ = len(r.sm)
    _ = len(r.fl)
    _ = len(r.lm)
    _ = len(r.lc)

    r.ord_to_byte = ord_to_byte^
    r.misses = misses^
    r.leaders = leaders
    r.item_bounds = item_bounds^
    r.batch_bounds = batch_bounds^
    return r^
