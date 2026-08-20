# glyph_scan.mojo — the parallel fold as a segmented monoid scan, natively.
#
# Port of glyphPipelineScan.js's runScanPipeline: the GPU's dispatch structure
# (chunkReduce → spineReduce → spineScan → partialScan → apply → resolveX →
# paginate → bounds), computed serially loop-for-dispatch. This is the GPU
# backend's skeleton: each `for chunk` / `for group` loop body below is one
# thread's work; lifting this to Mojo GPU kernels replaces the loops, not the
# bodies.
#
# Precision contract vs the serial oracle (the repo's own tiered comparator,
# tools/scan-layout.test.mjs):
#   - every EXACT lane (id, advance, height, row, col, flags, ord) bit-equal
#   - fold>0 float lanes bit-equal (resolveX's forward f32 re-sum ≡ serial segAdv)
#   - foldless float lanes within 1e-4 RELATIVE (serial f64 prefix vs the scan's
#     f32 lane — grouping differs by construction, integers never do)
#
# Mirrors (never diverge): packages/glyph3d-core/src/compute/glyphPipelineScan.js

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
    F64_INF,
    NEWLINE,
    decode_and_resolve,
    item_for_byte,
    resolve_x,
    paginate,
    bounds_reduce,
    derive_stride,
    trunc_nonneg,
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


def scan_leaf(slots: List[Float32], id: Int, wrap: Int, is_item_start: Bool) -> ScanElem:
    """The leaf for byte `id`, read from the decoded slots."""
    var flags = Int(slots[id * SLOT_STRIDE + S_FLAGS])
    return scan_leaf_value(
        (flags & F_NEWLINE) != 0,
        slots[id * SLOT_STRIDE + S_ADVANCE],
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
    slots: List[Float32],
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


def run_scan_pipeline(
    bytes: List[UInt8],
    trie: Trie,
    items: List[Item],
    chunk_size: Int,
    group_size: Int,
) -> PipelineResult:
    """Run the pipeline by the scan — same inputs and outputs as run_pipeline,
    computed in the GPU's dispatch structure. chunk/group sizes are the tuning
    dials the tests sweep (invariance across them is associativity in situ)."""
    var k = chunk_size if chunk_size > 0 else 1
    var g = group_size if group_size > 0 else 1
    var n = len(bytes)

    # ── dispatch 1: decode (shared kernel) ───────────────────────────────────
    var slots = List[Float32](length=n * SLOT_STRIDE, fill=0)
    var misses = List[UInt32]()
    var id = 0
    while id < n:
        decode_and_resolve(bytes, slots, trie, id, misses)
        id += 1

    var wraps = List[Int]()
    var i = 0
    while i < len(items):
        wraps.append(trunc_nonneg(items[i].wrap_width))
        i += 1

    # ── dispatch 2: chunkReduce — thread per chunk ───────────────────────────
    var num_chunks = (n + k - 1) // k
    var partials = List[ScanElem]()
    var c = 0
    while c < num_chunks:
        var acc = scan_identity()
        var to = (c + 1) * k
        if to > n:
            to = n
        fold_range(slots, items, wraps, c * k, to, acc)
        partials.append(acc^)
        c += 1

    # ── dispatch 3: spineReduce — thread per group ───────────────────────────
    var num_supers = (num_chunks + g - 1) // g
    var supers = List[ScanElem]()
    var sg = 0
    while sg < num_supers:
        var acc = scan_identity()
        c = sg * g
        var last = (sg + 1) * g
        if last > num_chunks:
            last = num_chunks
        while c < last:
            scan_combine(acc, partials[c])
            c += 1
        supers.append(acc^)
        sg += 1

    # ── dispatch 4: spineScan — ONE thread, exclusive scan of supers ─────────
    var super_prefix = List[ScanElem]()
    var spine_acc = scan_identity()
    sg = 0
    while sg < num_supers:
        super_prefix.append(spine_acc.copy())
        scan_combine(spine_acc, supers[sg])
        sg += 1

    # ── dispatch 5: partialScan — thread per group, seeded from the super ────
    var partial_prefix = List[ScanElem]()
    c = 0
    while c < num_chunks:
        partial_prefix.append(scan_identity())
        c += 1
    sg = 0
    while sg < num_supers:
        var acc = super_prefix[sg].copy()
        c = sg * g
        var last = (sg + 1) * g
        if last > num_chunks:
            last = num_chunks
        while c < last:
            partial_prefix[c] = acc.copy()
            scan_combine(acc, partials[c])
            c += 1
        sg += 1

    # ── dispatch 6: apply — thread per chunk: prefix through K leaves ────────
    var ord_to_byte = List[UInt32](length=n, fill=0)
    c = 0
    while c < num_chunks:
        var from_byte = c * k
        var to = (c + 1) * k
        if to > n:
            to = n
        if from_byte >= to:
            c += 1
            continue
        var run = partial_prefix[c].copy()
        var idx = item_for_byte(items, from_byte)
        id = from_byte
        while id < to:
            _cursor_advance(items, idx, id)
            var is_start = id == items[idx].byte_start
            if is_start:
                run = scan_identity()
                run.wrap = wraps[idx]
            var o = id * SLOT_STRIDE
            var flags = Int(slots[o + S_FLAGS])
            if (flags & F_LEADER) != 0:
                var v = lanes_from_prefix(run, wraps[idx])
                slots[o + S_ROW] = Float32(v.row)
                slots[o + S_COL] = Float32(v.col)
                slots[o + S_LINE_ADV] = v.line_adv
                slots[o + S_ORD] = Float32(v.ord)
                slots[o + S_FLAGS] = Float32(flags | F_RENDERED)
                ord_to_byte[items[idx].byte_start + v.ord] = UInt32(id)
            var leaf = scan_leaf(slots, id, wraps[idx], is_start)
            scan_combine(run, leaf)
            id += 1
        c += 1

    # ── dispatch 7: resolveX (shared kernel) + the fold-scalar reduce ────────
    var item_bounds = List[Float64](length=len(items) * 8, fill=0)
    id = 0
    while id < n:
        var owner = item_for_byte(items, id)
        resolve_x(slots, id, items[owner], ord_to_byte, item_bounds, owner * 8)
        id += 1

    # ── dispatch 8: paginate, stride derived from the fold scalars ───────────
    var strides = List[Float64]()
    i = 0
    while i < len(items):
        strides.append(derive_stride(item_bounds[i * 8 + 7], items[i]))
        i += 1
    id = 0
    while id < n:
        var owner = item_for_byte(items, id)
        paginate(slots, id, items[owner], strides[owner])
        id += 1

    # ── per-item bounds over final positions + batch union ───────────────────
    var batch_bounds = List[Float64](length=8, fill=0)
    batch_bounds[0] = F64_INF
    batch_bounds[1] = F64_INF
    batch_bounds[2] = F64_INF
    batch_bounds[3] = -F64_INF
    batch_bounds[4] = -F64_INF
    batch_bounds[5] = -F64_INF
    i = 0
    while i < len(items):
        var b = i * 8
        item_bounds[b + 0] = F64_INF
        item_bounds[b + 1] = F64_INF
        item_bounds[b + 2] = F64_INF
        item_bounds[b + 3] = -F64_INF
        item_bounds[b + 4] = -F64_INF
        item_bounds[b + 5] = -F64_INF
        id = items[i].byte_start
        var stop = items[i].byte_start + items[i].byte_count
        while id < stop:
            bounds_reduce(slots, id, item_bounds, b)
            id += 1
        var l = 0
        while l < 3:
            if item_bounds[b + l] < batch_bounds[l]:
                batch_bounds[l] = item_bounds[b + l]
            l += 1
        while l < 8:
            if item_bounds[b + l] > batch_bounds[l]:
                batch_bounds[l] = item_bounds[b + l]
            l += 1
        i += 1

    var leaders = 0
    id = 0
    while id < n:
        if (Int(slots[id * SLOT_STRIDE + S_FLAGS]) & F_LEADER) != 0:
            leaders += 1
        id += 1

    var r = PipelineResult()
    r.slots = slots^
    r.ord_to_byte = ord_to_byte^
    r.misses = misses^
    r.leaders = leaders
    r.item_bounds = item_bounds^
    r.batch_bounds = batch_bounds^
    return r^
