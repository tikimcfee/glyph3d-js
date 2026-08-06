/**
 * glyphPipelineReference — the byte-in glyph pipeline's executable spec, in JS.
 *
 * The pipeline takes a file's UTF-8 BYTES and produces positions and bounds. It never
 * sees a JavaScript string, never splits on newlines, and builds no line table — the
 * CPU's entire job is moving bytes from the socket into a buffer.
 *
 * This module is the SEMANTIC ORACLE: `runPipeline` computes the one true answer with
 * the simplest possible serial code (one forward pass per item). The GPU reaches the
 * same answer by a parallel prefix SCAN — that algorithm's executable spec lives in
 * `glyphPipelineScan.js`, structured dispatch-for-dispatch like the TSL, and is proven
 * against this oracle headlessly. Three layers, one contract:
 *
 *   oracle (this file)  →  scan spec (glyphPipelineScan.js)  →  TSL kernels
 *        semantics             algorithm, CPU-testable            same code on hardware
 *
 * The per-slot KERNEL functions here (decodeAndResolve, resolveX, paginate,
 * boundsReduce) are shared verbatim by the oracle and the scan spec — only the
 * row/col derivation differs (serial fold here, monoid scan there).
 *
 * BYTE-INDEXED THROUGHOUT. One slot per BYTE, not per glyph: a continuation byte of a
 * multi-byte sequence stays a non-leader and is skipped by every later pass. A slot
 * index is identical to a source byte offset, so picking, tree-sitter ranges, and the
 * cursor all address the same space with no mapping table anywhere — every glyph is a
 * particle with a stable address.
 *
 * ROW and COL are the reason this works. They are exact integers — a count of visual
 * rows and a count of glyphs since the last newline — and EVERY DISCRETE DECISION reads
 * them, never the float position. f32 addition is not associative: two summation
 * groupings land a few ULPs apart, and `floor(y / pageHeight)` at a page boundary flips
 * a glyph a whole page on a 1-ULP wobble. Integers do not wobble.
 *
 * X PRECISION follows the same discipline: a glyph's x is the sum of its FOLD UNIT's
 * advances (at most `fold` small numbers), never the difference of two file-scale
 * prefix sums — differencing f32 prefixes loses ~ULP(prefix) absolute, which on a
 * 40k-glyph line is 100× a caret width. Only the foldless case (wrap 0, pageCols 0)
 * uses the line prefix directly, where the position IS the prefix and f32
 * representation of the position itself is the only limit.
 *
 * ── MULTI-FILE (the item table) ─────────────────────────────────────────────────────
 * One pipeline run serves N files concatenated in ONE byte buffer. Each file is an
 * ITEM: { byteStart, byteCount, origin, page, wrapWidth?, zStep?, lineHeight? }. A
 * per-slot pass resolves its item by binary search over byteStarts; the row/col fold
 * RESETS at every item start (in the scan, item starts are absorbing monoid resets —
 * isolation is structural, not a floored walk), so row/col are FILE-RELATIVE and no
 * state can leak across files. wrap/zStep/lineHeight are per-item lanes with
 * field-level defaults: one arena serves grids that fold differently (a filename at
 * wrap 0 beside content at wrap 200).
 *
 * BOUNDS ARE PER-ITEM: the GPU carries a maxItems×8 bounds table — resolveX reduces
 * the fold scalars (lanes 6/7: totalRows + the ITEM-RELATIVE widest row) and the
 * paginate kernel reduces the final box (lanes 0-5) — so ONE post-flush readback hands
 * every field its extent. This mirror computes the same per-item table (`itemBounds`);
 * the batch box is the union. The page-fan stride DERIVES from lane 7 + the item's
 * pageGapX (`deriveStride`, the one shared formula) — a measured content width, never
 * a CPU-supplied stride.
 *
 * A single file is the one-item case: opts.origin/opts.page/opts.scrollRows wrap into
 * one item spanning the buffer.
 *
 * Worker-safe: no DOM, no three.
 */

import { trieLookup } from './GlyphTrie.js';

export const NEWLINE = 0x0A;

/**
 * Per-slot lanes. One flat Float32Array so the GPU binds one buffer.
 *
 * The fold pass (scan on the GPU, serial here) writes ONLY the exact lanes — S_ROW,
 * S_COL, S_LINE_ADV, S_ORD. resolveX turns them into the fold-relative S_BASE_X (plus
 * the unpaginated S_X/S_Y/S_Z), and paginate remaps from S_BASE_X + integers. Each
 * pass's cross-thread read set is the PREVIOUS pass's write set — no pass reads a lane
 * written by a racing sibling, which is what makes every dispatch deterministic.
 */
export const SLOT_STRIDE = 13;
export const S_CODEPOINT = 0;
export const S_GLYPH_ID = 1;
export const S_ADVANCE = 2;
export const S_HEIGHT = 3;
export const S_X = 4;
export const S_Y = 5;
export const S_Z = 6;
export const S_ROW = 7;      // exact: the glyph's visual row (wrap segments included)
export const S_COL = 8;      // exact: glyphs since the last newline
export const S_FLAGS = 9;
export const S_BASE_X = 10;  // resolveX's fold-relative x (+ item origin), written once —
                             // paginate reads THIS, so the page remap is a pure function
                             // of base position and re-running it accumulates nothing
export const S_LINE_ADV = 11; // exact fold: f32 advance sum since line start (exclusive).
                              // The foldless x, and resolveX's gather-free source.
export const S_ORD = 12;      // exact fold: item-relative leader ordinal (newlines
                              // included). ≤ byteCount, so exact in f32 ≤ 2^24.

export const F_LEADER = 1;        // this byte begins a codepoint
export const F_RENDERED = 2;      // layout completed this slot (a truth marker, not a
                                  // publish protocol — no pass ever waits on it)
export const F_MISSING = 8;       // no atlas entry yet — blank, but correctly spaced
                                  // (4 is retired: F_LINE_START, never consumed)

/**
 * The GPU item table's lane layout (glyphPipelineKernels.js packs the same strides).
 * byteStart is NOT here — it lives in the separate itemStarts uint buffer, because it
 * is the binary-search key. Everything a pass reads per file rides the item.
 */
export const ITEM_STRIDE = 14;
export const I_ORIGIN_X = 0;
export const I_ORIGIN_Y = 1;
export const I_ORIGIN_Z = 2;
export const I_PAGE_ROWS = 3;
export const I_PAGE_COLS = 4;    // also the fold unit when wrap is off — per item
export const I_PAGES_WIDE = 5;
export const I_PAGE_GAP_X = 6;   // world x gap between fanned page columns — the stride
                                 // is DERIVED (widest item-relative row + this gap),
                                 // never a CPU input
export const I_BAND_STRIDE_Y = 7;
export const I_DEPTH_PER_BAND = 8;
export const I_DEPTH_PER_COL = 9;
export const I_SCROLL_ROWS = 10;
export const I_WRAP_WIDTH = 11;  // the fold unit — load-time (changing it re-folds)
export const I_Z_STEP = 12;      // depth per wrap segment
export const I_LINE_HEIGHT = 13; // world y per row

/** Allocate the slot buffer for a file of `byteLength` bytes. */
export function allocSlots(byteLength) {
    return new Float32Array(byteLength * SLOT_STRIDE);
}

/**
 * How many bytes the sequence starting at `i` occupies — 0 if this byte is a
 * continuation byte (or invalid), which is exactly the "am I a leader" test.
 * @param {Uint8Array} bytes @param {number} i
 */
export function sequenceLength(bytes, i) {
    if (i < 0 || i >= bytes.length) return 0;
    const b = bytes[i];
    if ((b & 0x80) === 0x00) return 1;
    if ((b & 0xE0) === 0xC0) return 2;
    if ((b & 0xF0) === 0xE0) return 3;
    if ((b & 0xF8) === 0xF0) return 4;
    return 0;                                    // continuation byte, or malformed
}

/** Byte at `i`, or 0 past the end — the shader's bounds-checked read. */
const at = (bytes, i) => (i >= 0 && i < bytes.length ? bytes[i] : 0);

/**
 * KERNEL 1 — thread per byte. Decode the codepoint and resolve it through the trie.
 *
 * The decode is pure arithmetic on up to four bytes: no table, no lookup, no dependency
 * on any other thread. The RESOLVE is the trie's two loads. A continuation byte returns
 * immediately and its slot stays a non-leader.
 *
 * @param {Uint8Array} bytes
 * @param {Float32Array} slots
 * @param {{blockIndex:Uint32Array, blocks:Float32Array}} trie
 * @param {number} id - byte index (the thread id)
 * @param {number[]} [misses] - codepoints with no atlas entry, appended for the CPU to encode
 */
export function decodeAndResolve(bytes, slots, trie, id, misses) {
    if (id >= bytes.length) return;
    const n = sequenceLength(bytes, id);
    if (n === 0) return;                         // continuation byte — stays zeroed

    const b0 = at(bytes, id), b1 = at(bytes, id + 1), b2 = at(bytes, id + 2), b3 = at(bytes, id + 3);
    let cp;
    if (n === 1) cp = b0;
    else if (n === 2) cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F);
    else if (n === 3) cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
    else cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);

    const g = trieLookup(trie, cp);
    const o = id * SLOT_STRIDE;
    slots[o + S_CODEPOINT] = cp;
    slots[o + S_GLYPH_ID] = g.glyphId;
    slots[o + S_ADVANCE] = g.advance;
    slots[o + S_HEIGHT] = g.height;
    slots[o + S_FLAGS] = F_LEADER | (g.missing ? F_MISSING : 0);
    if (g.missing && misses) misses.push(cp);    // atomic append on the GPU
}

/**
 * Which item owns byte `id`: the largest item whose byteStart ≤ id. The GPU runs this
 * exact binary search per thread over the itemStarts buffer.
 * @param {Array<{byteStart:number}>} items @param {number} id @returns {number} item index
 */
export function itemForByte(items, id) {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (items[mid].byteStart <= id) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/**
 * Visual rows a line occupies under `wrap`. `len` counts the line's non-newline glyphs;
 * the newline itself rides at column `len`, so a line whose length is an exact multiple
 * of the wrap width ends with a row holding only the (invisible) newline. Taking that
 * literally rather than special-casing it keeps the fold free of edge cases: EVERY
 * glyph, newline included, sits at `floor(col / wrap)` of its line.
 */
export function rowsForLine(len, wrap) {
    if (!(wrap > 0)) return 1;
    return Math.floor(len / wrap) + 1;
}

/**
 * THE FOLD — one item, one forward pass, every lane. This is the semantics the GPU's
 * scan + resolveX reproduce in parallel; written serially it is five counters:
 *
 *   baseRow   visual rows of every closed line above me (wrap-aware)
 *   col       glyphs since the last newline
 *   lineAdv   f32 advance sum since the last newline (exclusive of me)
 *   segAdv    f32 advance sum since the last FOLD BOUNDARY (col % fold == 0) — the
 *             glyph's x, accumulated in exactly the order the GPU's resolveX re-sums
 *             (forward from the segment start), so fold > 0 x is BIT-IDENTICAL across
 *             oracle, scan spec, and hardware
 *   ord       item-relative leader ordinal
 *
 * A newline is a glyph OF its line: col = the line's length, row = the line's last
 * visual row — so content after it starts exactly one row below.
 *
 * @param {Float32Array} slots
 * @param {number} itemStart - the item's first byte
 * @param {number} byteCount
 * @param {Object} params - {wrapWidth, pageCols, origin, lineHeight, zStep}
 * @param {Uint32Array} [ordToByte] - the ordinal map: ordToByte[itemStart + ord] = byte
 *   index of that leader. Arena-shared (ordinals live inside their item's byte range).
 * @param {Float64Array|number[]} [scalars] - the item's 8-lane bounds row (6/7 written)
 */
export function layoutItem(slots, itemStart, byteCount, params = {}, ordToByte = null, scalars = null) {
    const wrap = Math.max(0, Math.trunc(params.wrapWidth || 0));
    const fold = wrap > 0 ? wrap : Math.max(0, Math.trunc(params.pageCols || 0));
    const ox = params.origin?.x || 0, oy = params.origin?.y || 0, oz = params.origin?.z || 0;
    const zStep = params.zStep || 0;
    let baseRow = 0, col = 0, lineAdv = 0, segAdv = 0, ord = 0;
    for (let id = itemStart; id < itemStart + byteCount; id++) {
        const o = id * SLOT_STRIDE;
        const flags = slots[o + S_FLAGS];
        if ((flags & F_LEADER) === 0) continue;
        const wrapRow = wrap > 0 ? Math.floor(col / wrap) : 0;
        const row = baseRow + wrapRow;
        const x = fold > 0 ? segAdv : lineAdv;
        slots[o + S_ROW] = row;
        slots[o + S_COL] = col;
        slots[o + S_LINE_ADV] = lineAdv;
        slots[o + S_ORD] = ord;
        slots[o + S_BASE_X] = x + ox;
        slots[o + S_X] = x + ox;
        slots[o + S_Y] = -row * (params.lineHeight ?? slots[o + S_HEIGHT]) + oy;
        slots[o + S_Z] = -wrapRow * zStep + oz;
        slots[o + S_FLAGS] = flags | F_RENDERED;
        if (ordToByte) ordToByte[itemStart + ord] = id;
        if (scalars) {
            if (row + 1 > scalars[6]) scalars[6] = row + 1;   // totalRows (pre-conveyor)
            if (x > scalars[7]) scalars[7] = x;               // widest row, ITEM-RELATIVE
        }
        ord++;
        if (slots[o + S_CODEPOINT] === NEWLINE) {
            baseRow += rowsForLine(col, wrap);
            col = 0;
            lineAdv = 0;
            segAdv = 0;
        } else {
            col++;
            lineAdv = Math.fround(lineAdv + slots[o + S_ADVANCE]);
            segAdv = (fold > 0 && col % fold === 0) ? 0
                : Math.fround(segAdv + slots[o + S_ADVANCE]);
        }
    }
}

/**
 * KERNEL — thread per byte. RESOLVE X from the exact lanes, and place the unpaginated
 * position.
 *
 * The fold unit is the wrap width when wrapping, else the item's pageCols when
 * x-paginating. With a fold unit, x re-sums the glyph's `col % fold` same-row
 * predecessors — each found in O(1) through the ordinal map (leaders in one line are
 * consecutive ordinals; no newline can intervene inside a fold unit). At most `fold`
 * small advances sum in f32: exact to representation, never a difference of file-scale
 * prefixes. Foldless, x IS the line prefix (S_LINE_ADV).
 *
 * Also reduces the item's FOLD SCALARS (lanes 6/7 of the bounds table): totalRows =
 * max(row+1) and the item-relative widest row max(x) — reduced HERE, before paginate,
 * because the page-fan stride derives from lane 7 and paginate reads it.
 *
 * Cross-thread reads: previous passes' lanes + the ordinal map. Writes: S_BASE_X,
 * S_X/S_Y/S_Z, the scalar reduce. Read set and write set are disjoint lanes —
 * deterministic under any schedule.
 *
 * @param {Float32Array} slots @param {number} id
 * @param {Object} p - {itemStart, wrapWidth, pageCols, origin, lineHeight, zStep}
 * @param {Uint32Array} ordToByte
 * @param {Float64Array|number[]} [scalars] - the item's 8-lane bounds row (6/7 written)
 */
export function resolveX(slots, id, p, ordToByte, scalars) {
    const o = id * SLOT_STRIDE;
    if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;
    const wrap = Math.max(0, Math.trunc(p.wrapWidth || 0));
    const fold = wrap > 0 ? wrap : Math.max(0, Math.trunc(p.pageCols || 0));
    const col = slots[o + S_COL];
    const ord = slots[o + S_ORD];
    const itemStart = Math.max(0, Math.trunc(p.itemStart || 0));

    let x = 0;
    if (fold > 0) {
        // FORWARD from the segment start — the same order the oracle's serial segAdv
        // accumulates, so the f32 grouping (and therefore the bits) match exactly.
        const back = col % fold;
        for (let k = back; k >= 1; k--) {
            const q = ordToByte[itemStart + ord - k];
            x = Math.fround(x + slots[q * SLOT_STRIDE + S_ADVANCE]);
        }
    } else {
        x = slots[o + S_LINE_ADV];
    }

    const row = slots[o + S_ROW];
    const wrapRow = wrap > 0 ? Math.floor(col / wrap) : 0;
    slots[o + S_BASE_X] = x + (p.origin?.x || 0);
    slots[o + S_X] = x + (p.origin?.x || 0);
    slots[o + S_Y] = -row * (p.lineHeight ?? slots[o + S_HEIGHT]) + (p.origin?.y || 0);
    slots[o + S_Z] = -wrapRow * (p.zStep || 0) + (p.origin?.z || 0);

    if (scalars) {
        if (row + 1 > scalars[6]) scalars[6] = row + 1;   // totalRows (pre-conveyor)
        if (x > scalars[7]) scalars[7] = x;               // widest row, ITEM-RELATIVE
    }
}

/**
 * THE stride formula, shared by this mirror and the GPU's paginate kernel: a row-paged
 * item fans its page columns at (widest item-relative row + pageGapX). Not fanning
 * (pageRows 0) derives 0 — paginate's fan term is inert either way.
 * @param {?{maxRowExtent:number}} foldScalars - the item's lane-6/7 reduce (pre-paginate)
 * @param {?Object} page - the item's page bag (pageRows + pageGapX read)
 * @returns {number} the resolved pageStrideX
 */
export function deriveStride(foldScalars, page) {
    if (!(page && Math.trunc(page.pageRows || 0) > 0)) return 0;
    return (foldScalars?.maxRowExtent ?? 0) + (page.pageGapX || 0);
}

/**
 * @typedef {Object} PageParams
 * @property {number} pageRows    - ROWS per page before breaking. 0 = no vertical paging.
 * @property {number} lineHeight  - world y per row (the page's world height is rows × this)
 * @property {number} pageCols    - COLUMNS per page before breaking. 0 = no horizontal
 *   paging. When set (and wrap is off) it is ALSO the fold unit resolveX sums within.
 * @property {number} scrollRows  - the conveyor: visual rows scrolled off the top.
 *   screenRow = row − scrollRows; negative rows stay in flow above the origin.
 * @property {number} zStep       - depth step per WRAP SEGMENT (the long-column z-fan).
 * @property {number} wrap        - the wrap width the fold ran with (for the segment index).
 * @property {number} pageStrideX - world x between fanned page columns — DERIVED
 *   (deriveStride) from the item's lane-7 fold scalar + pageGapX; explicit only at this
 *   function's boundary.
 * @property {number} pagesWide   - page columns before wrapping down into the next band
 * @property {number} bandStrideY - world y between bands (newspaper rows of pages step
 *   DOWN). 0 for z-axis paging (bands recede instead).
 * @property {number} depthPerBand   - z recession per completed band of pages
 * @property {number} depthPerColumn - z recession per horizontal page
 */

/**
 * KERNEL — thread per byte. Pagination as a PURE per-slot remap OF THE BASE POSITION.
 *
 * The remap is RECONSTRUCTIVE, never accumulative: x reads the untouched S_BASE_X, and
 * y/z rebuild from the exact integer lanes. Running it again with new params re-derives
 * from base — there is no "re-paginate", the remap cannot double-apply.
 *
 * EVERY PAGE DECISION READS THE INTEGER row/col, NEVER THE FLOAT POSITION — measured on
 * the torture corpus (119 slots flipped page on ULP wobble when float-keyed). The float
 * position is reconstructed FROM the integer page assignment, so placement inherits the
 * decision's exactness.
 *
 * @param {Float32Array} slots @param {number} id @param {PageParams} p
 */
export function paginate(slots, id, p) {
    const o = id * SLOT_STRIDE;
    if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;

    const rows = Math.max(0, Math.trunc(p.pageRows || 0));
    const cols = Math.max(0, Math.trunc(p.pageCols || 0));
    const scroll = Math.max(0, Math.trunc(p.scrollRows || 0));
    if (rows === 0 && cols === 0 && scroll === 0) return;

    const row = slots[o + S_ROW], col = slots[o + S_COL];
    // The conveyor: scroll shifts content up; rows scrolled above the origin (negative
    // screenRow) stay in flow — the page gate is screenRow >= rows, so they never paginate.
    const screenRow = row - scroll;

    // The gate, in INTEGER rows — content shorter than one page never paginates, and a
    // row exactly on the boundary starts a new page (one gate, no epsilon anywhere).
    let yPage = 0;
    if (rows > 0 && screenRow >= rows) yPage = Math.floor(screenRow / rows);   // exact
    let xPage = 0;
    if (cols > 0) xPage = Math.floor(col / cols);                              // exact

    // Fan the vertical pages across `pagesWide` columns, then wrap down into the next
    // band. Both the column slot and the band index come from the exact page number.
    const wide = Math.max(1, Math.trunc(p.pagesWide || 1));
    const band = Math.floor(yPage / wide);

    const wrap = Math.max(0, Math.trunc(p.wrap || 0));
    const seg = wrap > 0 ? Math.floor(col / wrap) : 0;
    const oy = p.origin?.y || 0, oz = p.origin?.z || 0;
    slots[o + S_X] = slots[o + S_BASE_X] + (yPage % wide) * (p.pageStrideX || 0);
    slots[o + S_Y] = oy - (screenRow - yPage * rows) * p.lineHeight - band * (p.bandStrideY || 0);
    slots[o + S_Z] = oz - seg * (p.zStep || 0) + band * (p.depthPerBand || 0) + xPage * (p.depthPerColumn || 0);
}

/**
 * KERNEL — thread per byte. Fold this slot's quad into the running min/max box
 * (lanes 0-5, over the FINAL positions). On the GPU these are six atomics with an
 * early-out into the item's bounds-table row. Lanes 6/7 are NOT touched here — they
 * are the fold scalars resolveX reduced before pagination.
 *
 * @param {Float32Array} slots @param {number} id @param {Float64Array|number[]} box
 */
export function boundsReduce(slots, id, box) {
    const o = id * SLOT_STRIDE;
    if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;
    const x = slots[o + S_X], y = slots[o + S_Y], z = slots[o + S_Z];
    const w = slots[o + S_ADVANCE], h = slots[o + S_HEIGHT];
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (z < box[2]) box[2] = z;
    if (x + w > box[3]) box[3] = x + w;
    if (y + h > box[4]) box[4] = y + h;
    if (z > box[5]) box[5] = z;
}

/**
 * Run the whole pipeline serially — the semantic oracle the scan spec and the GPU must
 * reproduce. Deterministic by construction: there is no dispatch order and no window;
 * the fold is one forward pass per item.
 *
 * MULTI-FILE: `opts.items` is an array of { byteStart, byteCount, origin?, page?,
 * wrapWidth?, zStep?, lineHeight? } — sorted, contiguous, covering [0, bytes.length)
 * (validated, throws otherwise). Without opts.items the top-level origin/page/
 * scrollRows wrap into a single item.
 *
 * @param {Uint8Array} bytes
 * @param {{blockIndex:Uint32Array, blocks:Float32Array}} trie
 * @param {Object} [opts]
 * @returns {{slots:Float32Array, bounds:?Object, itemBounds:Array, misses:number[],
 *   leaders:number, ordToByte:Uint32Array}}
 *   bounds is the batch-wide union; itemBounds[i] is item i's box + fold scalars —
 *   the mirror of the GPU's per-item bounds table.
 */
export function runPipeline(bytes, trie, opts = {}) {
    const slots = allocSlots(bytes.length);
    const misses = [];
    for (let id = 0; id < bytes.length; id++) decodeAndResolve(bytes, slots, trie, id, misses);

    const items = normalizeItems(bytes, opts);
    const resolved = items.map((it) => ({
        wrapWidth: it.wrapWidth ?? opts.wrapWidth ?? 0,
        zStep: it.zStep ?? opts.zStep ?? 0,
        lineHeight: it.lineHeight ?? opts.lineHeight,
    }));

    // ── THE FOLD: one forward pass per item writes every lane, with the item's
    //    fold-scalar reduce riding along.
    const ordToByte = new Uint32Array(bytes.length);
    const scalarRows = items.map(() => new Float64Array(8));
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        layoutItem(slots, it.byteStart, it.byteCount, {
            wrapWidth: resolved[i].wrapWidth, pageCols: it.page?.pageCols || 0,
            origin: it.origin, lineHeight: resolved[i].lineHeight, zStep: resolved[i].zStep,
        }, ordToByte, scalarRows[i]);
    }

    // ── Paginate, with each item's fan stride DERIVED from its fold scalars — the one
    //    shared formula (the GPU's paginate derives the same value from its bounds
    //    table). An all-zero page is an identity remap — paginate early-returns.
    const pageParams = items.map((it, i) => ({
        ...it.page,
        pageStrideX: deriveStride({ maxRowExtent: scalarRows[i][7] }, it.page),
        wrap: resolved[i].wrapWidth, zStep: resolved[i].zStep, origin: it.origin,
        lineHeight: resolved[i].lineHeight ?? it.page?.lineHeight,
    }));
    for (let id = 0; id < bytes.length; id++) {
        paginate(slots, id, pageParams[itemForByte(items, id)]);
    }

    // ── Per-item boxes over the FINAL positions (lanes 0-5; lanes 6/7 stay the fold
    //    scalars) — the mirror of the GPU's per-item bounds table. Batch box = union.
    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]);
    const itemBounds = items.map((it, i) => {
        const b = scalarRows[i];
        b[0] = b[1] = b[2] = Infinity; b[3] = b[4] = b[5] = -Infinity;
        for (let id = it.byteStart; id < it.byteStart + it.byteCount; id++) {
            boundsReduce(slots, id, b);
        }
        for (let l = 0; l < 3; l++) if (b[l] < box[l]) box[l] = b[l];
        for (let l = 3; l < 6; l++) if (b[l] > box[l]) box[l] = b[l];
        for (let l = 6; l < 8; l++) if (b[l] > box[l]) box[l] = b[l];
        return shapeBounds(b);
    });

    let leaders = 0;
    for (let id = 0; id < bytes.length; id++) {
        if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;
    }

    return {
        slots,
        bounds: shapeBounds(box),
        itemBounds,
        misses,
        leaders,
        ordToByte,
    };
}

/** Box lanes → the public bounds shape, or null when no glyph contributed. */
function shapeBounds(box) {
    return box[0] === Infinity ? null : {
        min: { x: box[0], y: box[1], z: box[2] },
        max: { x: box[3], y: box[4], z: box[5] },
        totalRows: box[6],
        maxRowExtent: box[7],
    };
}

/**
 * Resolve the item list for a run. No opts.items → one item from the top-level opts
 * (the single-file case). With opts.items, validate the table: sorted, contiguous,
 * covering the whole buffer — the binary search per thread is only honest when every
 * byte has exactly one owner.
 */
export function normalizeItems(bytes, opts) {
    if (!opts.items) {
        const scrollRows = Math.max(0, Math.trunc(opts.scrollRows ?? opts.page?.scrollRows ?? 0));
        const page = (opts.page || scrollRows > 0) ? { ...opts.page, scrollRows } : null;
        return [{ byteStart: 0, byteCount: bytes.length, origin: opts.origin, page }];
    }
    const items = opts.items;
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('runPipeline: opts.items must be a non-empty array');
    }
    let at = 0;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.byteStart !== at) {
            throw new Error(`runPipeline: item ${i} starts at ${it.byteStart}, expected ${at} — items must be contiguous from 0`);
        }
        if (!(it.byteCount > 0)) {
            throw new Error(`runPipeline: item ${i} has no bytes`);
        }
        at += it.byteCount;
    }
    if (at !== bytes.length) {
        throw new Error(`runPipeline: items cover ${at} bytes, buffer is ${bytes.length}`);
    }
    return items;
}
