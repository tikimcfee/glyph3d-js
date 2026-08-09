/**
 * glyphPipelineScan — the parallel fold as a SEGMENTED MONOID SCAN, in JS.
 *
 * This is the ALGORITHM's executable spec: `glyphPipelineReference.js` states the
 * semantics (one serial pass per item); this module states how the GPU computes the
 * same answer in parallel, structured DISPATCH-FOR-DISPATCH like the TSL in
 * `glyphPipelineKernels.js`. It is proven against the oracle headlessly
 * (tools/scan-layout.test.mjs: chunk-size invariance, monoid associativity fuzz,
 * item-reset isolation) — when the TSL disagrees with hardware, this is the
 * line-comparable middle layer to diff against.
 *
 * THE MONOID. Every byte contributes a small summary; combining the summaries of two
 * adjacent intervals gives the summary of their union — associatively, so any
 * grouping (chunks, supers, threads) folds to the same answer:
 *
 *   reset    the interval contains an item start; it ABSORBS everything left of it
 *            (combine(a,b) = b when b.reset) — file isolation is structural, no walk
 *            floor, no state can leak across items under ANY grouping
 *   nl       newlines in the interval (since the last reset)
 *   glyphs   leaders in the interval — the ordinal counter (newlines included)
 *   rows     visual rows of lines that START AND END inside the interval (wrap-aware;
 *            the head line is excluded — its start is not the interval's business)
 *   headLen  glyphs before the first newline
 *   tailLen  glyphs after the last newline    (nl == 0 ⇒ headLen == tailLen)
 *   tailAdv  f32 advance sum after the last newline
 *   wrap     the owning item's fold unit (uniform within an interval — an interval
 *            with no reset lies inside ONE item)
 *
 * A leader's EXCLUSIVE prefix P (fold of every byte before it; identity when the
 * leader IS its item's first byte) yields its exact lanes in O(1):
 *
 *   col        = P.tailLen
 *   ord        = P.glyphs
 *   lineAdv    = P.tailAdv
 *   row        = (P.nl > 0 ? rowsForLine(P.headLen, wrap) + P.rows : 0)
 *                + floor(col / wrap)                  [wrap > 0]
 *
 * THE SHAPE ON THE GPU — a RAKING reduce-then-scan, chosen for what it does NOT need:
 * no workgroup shared memory, no barriers, no atomics in the scan, no forward-progress
 * assumption, no cross-thread read of anything a sibling wrote in the same dispatch.
 * Every loop is bounded by a compile-time constant. Work is O(n); the result is
 * bit-deterministic (fixed f32 grouping) under every schedule:
 *
 *   chunkReduce    thread per K-byte chunk: serial fold → partials[chunk]
 *   spineReduce    thread per G-chunk group: serial fold → supers[group]
 *   spineScan      ONE thread: serial exclusive scan of supers (≤ maxSupers combines)
 *   partialScan    thread per group: seed superPrefix[g], serial exclusive scan of its
 *                  G partials → partialPrefix[chunk]
 *   apply          thread per chunk: run the running prefix through K leaves, writing
 *                  each leader's exact lanes + the ordinal map
 *
 * then resolveX / paginate / bounds exactly as the reference states them.
 *
 * Worker-safe: no DOM, no three.
 */

import {
    SLOT_STRIDE, S_ADVANCE, S_ROW, S_COL, S_FLAGS, S_LINE_ADV, S_ORD,
    F_LEADER, F_NEWLINE, F_RENDERED,
    allocSlots, decodeAndResolve, itemForByte, rowsForLine, resolveX, paginate,
    boundsReduce, deriveStride, normalizeItems,
} from './glyphPipelineReference.js';

/** Chunk width: bytes folded serially per scan thread. */
export const CHUNK_SIZE = 64;
/** Group width: chunks folded serially per spine thread. */
export const GROUP_SIZE = 256;

/** The monoid's identity — also the exclusive prefix of an item's first byte. */
export function scanIdentity() {
    return { reset: 0, nl: 0, glyphs: 0, rows: 0, headLen: 0, tailLen: 0, tailAdv: 0, wrap: 0 };
}

/**
 * The leaf as a pure value — one byte's monoid element from its decoded facts alone.
 * The slots-reading scanLeaf below and the bake's streaming fold (glyphBake.js, which
 * never allocates slots) both build their leaves HERE, so the element can't drift.
 * `wrap` is the owning item's fold unit; `isItemStart` marks the absorbing reset.
 */
export function scanLeafValue(isNewline, advance, isLeader, wrap, isItemStart) {
    const e = scanIdentity();
    e.reset = isItemStart ? 1 : 0;
    e.wrap = wrap;
    if (!isLeader) return e;                      // continuation byte: reset/wrap only
    e.glyphs = 1;
    if (isNewline) {
        e.nl = 1;                                 // head/tail stay 0: the line it closes
    } else {                                      // started before this interval
        e.headLen = 1;
        e.tailLen = 1;
        e.tailAdv = advance;
    }
    return e;
}

/** The leaf for byte `id`, read from the decoded slots. */
export function scanLeaf(slots, id, wrap, isItemStart) {
    const o = id * SLOT_STRIDE;
    return scanLeafValue(
        (slots[o + S_FLAGS] & F_NEWLINE) !== 0,
        slots[o + S_ADVANCE],
        (slots[o + S_FLAGS] & F_LEADER) !== 0,
        wrap, isItemStart,
    );
}

/**
 * combine(a, b) — the summary of a's interval followed by b's. Associative (fuzzed in
 * tools/scan-layout.test.mjs); b.reset absorbs a wholesale. Mutates and returns `a`
 * (the serial folds accumulate in place; the GPU does the same in registers).
 */
export function scanCombine(a, b) {
    if (b.reset) {
        a.reset = 1; a.nl = b.nl; a.glyphs = b.glyphs; a.rows = b.rows;
        a.headLen = b.headLen; a.tailLen = b.tailLen; a.tailAdv = b.tailAdv;
        a.wrap = b.wrap;
        return a;
    }
    a.wrap = b.wrap;
    if (b.nl === 0) {
        a.tailLen += b.tailLen;
        a.tailAdv = Math.fround(a.tailAdv + b.tailAdv);
        if (a.nl === 0) a.headLen = a.tailLen;    // still one open line: head == tail
    } else {
        if (a.nl === 0) {
            a.headLen += b.headLen;               // a's open run extends b's head line
            a.rows = b.rows;
        } else {
            // The junction line: a's tail run + b's head run, closed by b's first
            // newline — it starts and ends inside the union, so it joins `rows`.
            a.rows += rowsForLine(a.tailLen + b.headLen, b.wrap) + b.rows;
        }
        a.tailLen = b.tailLen;
        a.tailAdv = b.tailAdv;
    }
    a.nl += b.nl;
    a.glyphs += b.glyphs;
    return a;
}

/** A leader's exact lanes from its exclusive prefix — the O(1) query. */
export function lanesFromPrefix(P, wrap) {
    const col = P.tailLen;
    const closed = P.nl > 0 ? rowsForLine(P.headLen, wrap) + P.rows : 0;
    const wrapRow = wrap > 0 ? Math.floor(col / wrap) : 0;
    return { row: closed + wrapRow, col, lineAdv: P.tailAdv, ord: P.glyphs };
}

/**
 * The item cursor: resolves each byte's item + wrap while walking a range serially —
 * binary search once at the range start, then O(1) advances at boundary crossings
 * (the GPU's serial chunk loops do exactly this).
 */
function itemCursor(items, wraps, startByte) {
    let i = itemForByte(items, startByte);
    return {
        at(id) {
            while (i + 1 < items.length && id >= items[i + 1].byteStart) i++;
            return { index: i, wrap: wraps[i], isStart: id === items[i].byteStart };
        },
    };
}

/** Serial fold of leaves over [from, to) — the body of chunkReduce and the tail of apply. */
function foldRange(slots, items, wraps, from, to, acc) {
    const cursor = itemCursor(items, wraps, from);
    for (let id = from; id < to; id++) {
        const c = cursor.at(id);
        scanCombine(acc, scanLeaf(slots, id, c.wrap, c.isStart));
    }
    return acc;
}

/**
 * Run the pipeline by the scan — same inputs and outputs as the oracle's runPipeline,
 * computed in the GPU's dispatch structure. `chunkSize`/`groupSize` are the tuning
 * dials the tests sweep (invariance across them is the associativity proof in situ).
 *
 * @param {Uint8Array} bytes
 * @param {{blockIndex:Uint32Array, blocks:Float32Array}} trie
 * @param {Object} [opts] - as runPipeline
 * @param {{chunkSize?:number, groupSize?:number}} [tuning]
 */
export function runScanPipeline(bytes, trie, opts = {}, tuning = {}) {
    const K = Math.max(1, tuning.chunkSize ?? CHUNK_SIZE);
    const G = Math.max(1, tuning.groupSize ?? GROUP_SIZE);
    const n = bytes.length;

    // ── dispatch 1: decode (shared kernel) ──────────────────────────────────────────
    const slots = allocSlots(n);
    const misses = [];
    for (let id = 0; id < n; id++) decodeAndResolve(bytes, slots, trie, id, misses);

    const items = normalizeItems(bytes, opts);
    const wraps = items.map((it) => Math.max(0, Math.trunc(it.wrapWidth ?? opts.wrapWidth ?? 0)));

    // ── dispatch 2: chunkReduce — thread per chunk ──────────────────────────────────
    const numChunks = Math.ceil(n / K);
    const partials = new Array(numChunks);
    for (let c = 0; c < numChunks; c++) {
        partials[c] = foldRange(slots, items, wraps, c * K, Math.min((c + 1) * K, n), scanIdentity());
    }

    // ── dispatch 3: spineReduce — thread per group ──────────────────────────────────
    const numSupers = Math.ceil(numChunks / G);
    const supers = new Array(numSupers);
    for (let g = 0; g < numSupers; g++) {
        const acc = scanIdentity();
        for (let c = g * G; c < Math.min((g + 1) * G, numChunks); c++) scanCombine(acc, partials[c]);
        supers[g] = acc;
    }

    // ── dispatch 4: spineScan — ONE thread, exclusive scan of supers ────────────────
    const superPrefix = new Array(numSupers);
    {
        let acc = scanIdentity();
        for (let g = 0; g < numSupers; g++) {
            superPrefix[g] = acc;
            acc = scanCombine({ ...acc }, supers[g]);
        }
    }

    // ── dispatch 5: partialScan — thread per group, seeded from the super prefix ────
    const partialPrefix = new Array(numChunks);
    for (let g = 0; g < numSupers; g++) {
        let acc = { ...superPrefix[g] };
        for (let c = g * G; c < Math.min((g + 1) * G, numChunks); c++) {
            partialPrefix[c] = acc;
            acc = scanCombine({ ...acc }, partials[c]);
        }
    }

    // ── dispatch 6: apply — thread per chunk: prefix through K leaves, write lanes ──
    const ordToByte = new Uint32Array(n);
    for (let c = 0; c < numChunks; c++) {
        const from = c * K, to = Math.min((c + 1) * K, n);
        const R = { ...partialPrefix[c] };
        const cursor = itemCursor(items, wraps, from);
        for (let id = from; id < to; id++) {
            const cu = cursor.at(id);
            if (cu.isStart) Object.assign(R, scanIdentity(), { wrap: cu.wrap });
            const o = id * SLOT_STRIDE;
            const flags = slots[o + S_FLAGS];
            if ((flags & F_LEADER) !== 0) {
                const v = lanesFromPrefix(R, cu.wrap);
                slots[o + S_ROW] = v.row;
                slots[o + S_COL] = v.col;
                slots[o + S_LINE_ADV] = v.lineAdv;
                slots[o + S_ORD] = v.ord;
                slots[o + S_FLAGS] = flags | F_RENDERED;
                ordToByte[items[cu.index].byteStart + v.ord] = id;
            }
            scanCombine(R, scanLeaf(slots, id, cu.wrap, cu.isStart));
        }
    }

    // ── dispatch 7: resolveX (shared kernel) + the fold-scalar reduce ───────────────
    const scalarRows = items.map(() => new Float64Array(8));
    const resolveParams = items.map((it, i) => ({
        itemStart: it.byteStart, wrapWidth: wraps[i],
        pageCols: it.page?.pageCols || 0, origin: it.origin,
        lineHeight: it.lineHeight ?? opts.lineHeight,
        zStep: it.zStep ?? opts.zStep ?? 0,
    }));
    for (let id = 0; id < n; id++) {
        const i = itemForByte(items, id);
        resolveX(slots, id, resolveParams[i], ordToByte, scalarRows[i]);
    }

    // ── dispatch 8: paginate (shared kernel), stride derived from the fold scalars ──
    const pageParams = items.map((it, i) => ({
        ...it.page,
        pageStrideX: deriveStride({ maxRowExtent: scalarRows[i][7] }, it.page),
        wrap: wraps[i], zStep: resolveParams[i].zStep, origin: it.origin,
        lineHeight: resolveParams[i].lineHeight ?? it.page?.lineHeight,
    }));
    for (let id = 0; id < n; id++) {
        paginate(slots, id, pageParams[itemForByte(items, id)]);
    }

    // ── the per-item bounds table (final box lanes 0-5; fold scalars stay 6/7) ──────
    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]);
    const itemBounds = items.map((it, i) => {
        const b = scalarRows[i];
        b[0] = b[1] = b[2] = Infinity; b[3] = b[4] = b[5] = -Infinity;
        for (let id = it.byteStart; id < it.byteStart + it.byteCount; id++) boundsReduce(slots, id, b);
        for (let l = 0; l < 3; l++) if (b[l] < box[l]) box[l] = b[l];
        for (let l = 3; l < 6; l++) if (b[l] > box[l]) box[l] = b[l];
        for (let l = 6; l < 8; l++) if (b[l] > box[l]) box[l] = b[l];
        return b[0] === Infinity ? null : {
            min: { x: b[0], y: b[1], z: b[2] }, max: { x: b[3], y: b[4], z: b[5] },
            totalRows: b[6], maxRowExtent: b[7],
        };
    });

    let leaders = 0;
    for (let id = 0; id < n; id++) {
        if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;
    }

    return {
        slots,
        bounds: box[0] === Infinity ? null : {
            min: { x: box[0], y: box[1], z: box[2] }, max: { x: box[3], y: box[4], z: box[5] },
            totalRows: box[6], maxRowExtent: box[7],
        },
        itemBounds,
        misses,
        leaders,
        ordToByte,
    };
}
