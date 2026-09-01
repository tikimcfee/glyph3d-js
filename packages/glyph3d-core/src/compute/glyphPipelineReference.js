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

// ── lane representation ──────────────────────────────────────────────────────
// The slot buffer is u32. Twelve lanes, two kinds, and the buffer can only have
// one type — so one kind travels reinterpreted.
//
// COUNTS (ROW/COL/FLAGS/ORD) live in the u32 array and are exact for
// the full u32 range. That is the whole point: they used to ride f32 lanes,
// where consecutive integers stop being representable past 2^24 and two glyphs
// fold onto one ordinal while addressing stays perfectly exact.
//
// MEASURES (X/Y/Z/ADVANCE/HEIGHT/BASE_X/LINE_ADV) live in the f32 array, where a
// measure is simply the number it is.
//
// THE IEEE REINTERPRETATION PAIR IS GONE. `fbits` wrote an f32's bit pattern into a u32
// lane and `fval` read it back; their entire job was moving a measure into and out of a
// container that was the wrong kind for it. Assignment into a Float32Array rounds to f32
// exactly as fbits did — that is what its own "PRESERVES THE ROUNDING" note was about —
// so with the measures in their own array there is no pattern left to write. Deleting
// the helpers is the migration's last step, and the point of deleting them rather than
// leaving them unused: the primitive that made a mixed container POSSIBLE no longer
// exists, so the next lane cannot quietly reach for it.


/**
 * Per-slot lanes. One flat Uint32Array so the GPU binds one buffer — counts native,
 * floats bitcast (see LANE KINDS above).
 *
 * The fold pass (scan on the GPU, serial here) writes E_ROW, E_COL, E_ORD and
 * M_LINE_ADV. resolveX turns them into the fold-relative M_BASE_X (plus the
 * unpaginated M_X/M_Y/M_Z), and paginate remaps from M_BASE_X + the exact lanes. Each
 * pass's cross-thread read set is the PREVIOUS pass's write set — no pass reads a lane
 * written by a racing sibling, which is what makes every dispatch deterministic.
 */
/**
 * THE SLOT RECORD, SPLIT BY CARRIER — two arrays, one kind each.
 *
 * It was ONE Uint32Array of 12 lanes with the seven measures held as bitcast f32 and a
 * LANE_KIND set on the side saying which was which. That container cost this project the
 * ordinal wall, the pick ids, foldScalars' totalRows, GLYPH_ID, and I_BYTE_COUNT — five
 * defects, one cause, every one of them an exact value on a float carrier. Each was fixed
 * by moving a lane; the CAUSE was the container, and it survived every fix.
 *
 * Split, the kind IS the container. A measure read as a count is not a correct-looking
 * access returning a denormal — it is a read of a different array. `fbits`/`fval` are
 * gone from this file's slot paths entirely: writing an f64 into a Float32Array rounds
 * exactly as `fbits` did (that is what its "PRESERVES THE ROUNDING" note was about), so
 * the bit-pattern round trip existed only to smuggle a float through a uint container.
 *
 * LANE ORDER IS THE WIRE ORDER. The render-read fields form a contiguous PREFIX of each
 * array — X, Y, Z, ADVANCE, HEIGHT then the fold scratch; GLYPH_ID, ROW, COL then the
 * fold scratch. That is the contract's truncation rule (`glyphContract.js`: emitting a
 * record is a TRUNCATION of what the producer keeps, never a repack), and it makes this
 * layer's containers structurally identical to the native backend's GlyphRecord —
 * [f32;5] + [u32;3] with a 32-byte assert. Same kinds, same order, no bitcast at the seam.
 */

/** MEASURE lanes — an f32 array. Lanes 0..4 are the render-read prefix. */
export const SLOT_MEASURE_STRIDE = 7;
export const M_X = 0;
export const M_Y = 1;
export const M_Z = 2;
export const M_ADVANCE = 3;
export const M_HEIGHT = 4;
export const M_BASE_X = 5;    // resolveX's fold-relative x (+ item origin), written once —
                              // paginate reads THIS, so the page remap is a pure function
                              // of base position and re-running it accumulates nothing
export const M_LINE_ADV = 6;  // fold: advance sum since line start (exclusive). The
                              // foldless x, and resolveX's gather-free source.

/** EXACT lanes — a u32 array. Lanes 0..2 are the render-read prefix. */
export const SLOT_EXACT_STRIDE = 5;
export const E_GLYPH_ID = 0;
export const E_ROW = 1;       // the glyph's visual row (wrap segments included)
export const E_COL = 2;       // glyphs since the last newline
export const E_FLAGS = 3;
export const E_ORD = 4;       // fold: item-relative leader ordinal (newlines included)

/** Render-read prefix lengths — what a record emission truncates TO. */
export const RENDER_MEASURE_COUNT = 5;   // X Y Z ADVANCE HEIGHT
export const RENDER_EXACT_COUNT = 3;     // GLYPH_ID ROW COL

/**
 * Allocate/address helpers. Every lane site goes through a NAMED lane and one of these
 * two arrays; there is no flat index into a mixed buffer any more, so there is nothing
 * left for a `laneValue`-style kind lookup to disambiguate. `laneValue` and `isFloatLane`
 * are deleted rather than ported: a helper whose whole job was telling two kinds apart
 * inside one container has no meaning once the container is the kind.
 */
export const mBase = (id) => id * SLOT_MEASURE_STRIDE;
export const eBase = (id) => id * SLOT_EXACT_STRIDE;

/** Byte capacity of a slot pair — derived from the MEASURE array, and asserted against
 *  the exact one so a pair built from mismatched lengths cannot pass silently. */
export function slotCount(s) {
    const n = s.m.length / SLOT_MEASURE_STRIDE;
    if (s.x.length / SLOT_EXACT_STRIDE !== n) {
        throw new Error(`slotCount: the pair disagrees — ${n} bytes of measures vs `
            + `${s.x.length / SLOT_EXACT_STRIDE} of exact lanes`);
    }
    return n;
}

/** A deep copy of a slot pair (`slots.slice()` on the old flat buffer). */
export const cloneSlots = (s) => ({ m: s.m.slice(), x: s.x.slice() });

// There is NO codepoint lane: a slot index IS its source byte offset, so the codepoint
// is always re-derivable from the byte buffer. The one downstream decision it fed —
// "is this a newline?" — is a decode-time fact and rides E_FLAGS as F_NEWLINE.
export const F_LEADER = 1;        // this byte begins a codepoint


/**
 * An item's lineHeight must be a finite number. This is the SPEC's contract, and it
 * refuses rather than substitutes.
 *
 * There used to be a substitution: an unset lineHeight silently selected the glyph's own
 * the glyph's own height, which staggered baselines within a row (a taller CJK glyph at -row * 1.61
 * beside its neighbours at -row * 1.4). The GPU kernel never had that branch, so the
 * oracle and the Mojo port agreed with each other and disagreed with the renderer — in a
 * case no gate could see. Deleting the substitution (see the previous commit) left the
 * value flowing through as undefined, producing NaN, which is a QUIETER failure than the
 * bug it replaced: every downstream comparison that tests bit equality reports two
 * matching NaNs as EQUAL and passes.
 *
 * So the illegal state has to be refused where it enters, not detected where it lands.
 * NaN is rejected explicitly and not merely by falling out of the finite check, because
 * the fixture format encodes NaN as "unset" — it is the wire representation of exactly
 * this error, and a reader handing it back deserves to be told so by name.
 *
 * Callers that legitimately have no opinion do not omit it — they normalise. See
 * GlyphPipelineArena.stage(), which writes lineHeight = 1 into the item it stages, so
 * what reaches this function is fully specified rather than defaulted past a check.
 *
 * @param {*} lineHeight @param {number} itemIndex @returns {number} the validated value
 */
export function assertLineHeight(lineHeight, itemIndex = 0) {
    if (typeof lineHeight === 'number' && Number.isFinite(lineHeight)) return lineHeight;
    const shown = Number.isNaN(lineHeight) ? 'NaN (the fixture format\'s encoding of "unset")'
        : String(lineHeight);
    throw new Error(
        `glyphPipeline: item ${itemIndex} has lineHeight ${shown} — it must be a finite `
        + 'number. lineHeight is the ITEM\'s row pitch, never the glyph\'s own height; '
        + 'there is no per-glyph fallback (it staggered baselines within a row). A caller '
        + 'with no opinion should pass an explicit value, as GlyphPipelineArena.stage() does.',
    );
}
export const F_RENDERED = 2;      // layout completed this slot (a truth marker, not a
                                  // publish protocol — no pass ever waits on it)
export const F_NEWLINE = 4;       // the codepoint is 0x0A — the fold's one content test
export const F_MISSING = 8;       // no atlas entry yet — blank, but correctly spaced

/**
 * The GPU item table, SPLIT BY CARRIER — two containers, one per kind.
 *
 * byteStart is NOT here: it lives in the separate itemStarts uint buffer, because it is
 * the binary-search key. Everything else a pass reads per file rides the item.
 *
 * There used to be ONE table of 15 mixed lanes in a Uint32Array, nine measures held as
 * bitcast f32, with a LANE_KIND set on the side saying which lane was which. That
 * arrangement cost this project I_BYTE_COUNT aliasing past 2^24 — an item's tail folding
 * into the next item's range, silently, at a size the arena ceiling had just made
 * reachable. The kind was right in the table and right in the shader; it was right by
 * DISCIPLINE, and discipline is a thing you can forget exactly once.
 *
 * Split, the kind IS the container. A measure read as a count is no longer a
 * correct-looking access returning a denormal — it is a read of a different buffer, and
 * a count assigned into the float array is a type the storage node will not take. The
 * side table is gone because nothing is left to consult it.
 */

/** MEASURE lanes — an f32 container. Real quantities: origins, gaps, depths, steps. */
export const ITEM_MEASURE_STRIDE = 9;
export const IM_ORIGIN_X = 0;
export const IM_ORIGIN_Y = 1;
export const IM_ORIGIN_Z = 2;
export const IM_PAGE_GAP_X = 3;    // world x gap between fanned page columns — the stride
                                   // is DERIVED (widest item-relative row + this gap),
                                   // never a CPU input
export const IM_BAND_STRIDE_Y = 4;
export const IM_DEPTH_PER_BAND = 5;
export const IM_DEPTH_PER_COL = 6;
export const IM_Z_STEP = 7;        // depth per wrap segment
export const IM_LINE_HEIGHT = 8;   // world y per row

/** EXACT lanes — a u32 container. Page geometry counts, the fold unit, the byte count. */
export const ITEM_EXACT_STRIDE = 6;
export const IE_PAGE_ROWS = 0;
export const IE_PAGE_COLS = 1;     // also the fold unit when wrap is off — per item
export const IE_PAGES_WIDE = 2;
export const IE_SCROLL_ROWS = 3;
export const IE_WRAP_WIDTH = 4;    // the fold unit — load-time (changing it re-folds)
export const IE_BYTE_COUNT = 5;    // the item's byte length — ownership is EXPLICIT:
                                   // [byteStart, byteStart + byteCount). Bytes between one
                                   // item's end and the next start are DEAD SPACE (the
                                   // arena's free-list recycles tombstoned ranges); the
                                   // kernels treat them as inert (apply kills their leader
                                   // flag, so no reduce ever attributes them to a live item)

/**
 * This layer's item mapping, BY NAME — what the contract assertion reads.
 *
 * The shared tier carries parameter names and KINDS and deliberately says nothing about
 * lane numbers, so what this layer owes is a statement of where each named param lives
 * and in which carrier. These two objects are that statement, once. The conformance gate
 * checks that every shared ITEM_PARAM appears in exactly one of them and that each
 * object's lanes are a PERMUTATION of 0..stride-1 — so a lane added to a container
 * without a name here lowers the permutation and fails, rather than quietly lowering
 * coverage.
 */
export const ITEM_MEASURE_LANE_OF = Object.freeze({
    ORIGIN_X: IM_ORIGIN_X, ORIGIN_Y: IM_ORIGIN_Y, ORIGIN_Z: IM_ORIGIN_Z,
    PAGE_GAP_X: IM_PAGE_GAP_X, BAND_STRIDE_Y: IM_BAND_STRIDE_Y,
    DEPTH_PER_BAND: IM_DEPTH_PER_BAND, DEPTH_PER_COL: IM_DEPTH_PER_COL,
    Z_STEP: IM_Z_STEP, LINE_HEIGHT: IM_LINE_HEIGHT,
});

/** BYTE_COUNT is this layer's own bookkeeping — the arena's range ownership — and is
 *  deliberately NOT a shared ITEM_PARAM. The gate knows it by name for that reason. */
export const ITEM_EXACT_LANE_OF = Object.freeze({
    PAGE_ROWS: IE_PAGE_ROWS, PAGE_COLS: IE_PAGE_COLS, PAGES_WIDE: IE_PAGES_WIDE,
    SCROLL_ROWS: IE_SCROLL_ROWS, WRAP_WIDTH: IE_WRAP_WIDTH, BYTE_COUNT: IE_BYTE_COUNT,
});

/** Allocate the slot buffer for a file of `byteLength` bytes. */
export function allocSlots(byteLength) {
    return {
        m: new Float32Array(byteLength * SLOT_MEASURE_STRIDE),
        x: new Uint32Array(byteLength * SLOT_EXACT_STRIDE),
    };
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
 * @param {Uint32Array} slots
 * @param {{blockIndex:Uint32Array, blocks:Uint32Array}} trie
 * @param {number} id - byte index (the thread id)
 * @param {number[]} [misses] - codepoints with no atlas entry, appended for the CPU to encode
 */
export function decodeAndResolve(bytes, slots, trie, id, misses) {
    if (id >= bytes.length) return;
    const n = sequenceLength(bytes, id);
    if (n === 0) {
        // Continuation byte — a non-leader, size zeroed EXPLICITLY: the vertex culls
        // non-leaders by size (0,0), and a rewritten range's pad was a real glyph in
        // the previous run (fresh arrays are born zero; REWRITES are why this write
        // must exist — the GPU decode kernel makes the same two writes every run).
        const om = mBase(id), oe = eBase(id);
        slots.m[om + M_ADVANCE] = 0;
        slots.m[om + M_HEIGHT] = 0;
        return;
    }

    const b0 = at(bytes, id), b1 = at(bytes, id + 1), b2 = at(bytes, id + 2), b3 = at(bytes, id + 3);
    let cp;
    if (n === 1) cp = b0;
    else if (n === 2) cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F);
    else if (n === 3) cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
    else cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);

    const g = trieLookup(trie, cp);
    const om = mBase(id), oe = eBase(id);
    // EXACT lane. The trie moved to u32 (GlyphTrie: identities native, measures
    // bitcast), so the glyph id arrives as an integer and is stored as one. It was a
    // float carrier only because it was copied verbatim from an f32 trie block.
    slots.x[oe + E_GLYPH_ID] = g.glyphId;
    slots.m[om + M_ADVANCE] = g.advance;
    slots.m[om + M_HEIGHT] = g.height;
    slots.x[oe + E_FLAGS] = F_LEADER
        | (cp === NEWLINE ? F_NEWLINE : 0)
        | (g.missing ? F_MISSING : 0);
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
 * @param {Uint32Array} slots
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
        const om = mBase(id), oe = eBase(id);
        const flags = slots.x[oe + E_FLAGS];
        if ((flags & F_LEADER) === 0) continue;
        const wrapRow = wrap > 0 ? Math.floor(col / wrap) : 0;
        const row = baseRow + wrapRow;
        const x = fold > 0 ? segAdv : lineAdv;
        slots.x[oe + E_ROW] = row;
        slots.x[oe + E_COL] = col;
        slots.m[om + M_LINE_ADV] = lineAdv;
        slots.x[oe + E_ORD] = ord;
        slots.m[om + M_BASE_X] = x + ox;
        slots.m[om + M_X] = x + ox;
        // lineHeight is the ITEM's, never the glyph's. The per-glyph height fallback
        // that stood here staggered baselines WITHIN a row whenever an item omitted it:
        // a taller glyph (CJK, emoji) landed at -row * ITS height while its neighbours
        // sat at -row * theirs. Measured: row 1 with CELL_H 1.4 beside 1.61 gave
        // Y {-1.4, -1.61}. Row 0 hid it, because -0 * anything is 0.
        //
        // The GPU kernel never had the branch (glyphPipelineKernels: -row * lineHeight
        // from the item table, unconditionally), so the ORACLE was the outlier — and the
        // Mojo port reproduced the oracle faithfully, which meant the two checked layers
        // agreed with each other and disagreed with the renderer. See the commit.
        slots.m[om + M_Y] = -row * params.lineHeight + oy;
        slots.m[om + M_Z] = -wrapRow * zStep + oz;
        slots.x[oe + E_FLAGS] = flags | F_RENDERED;
        if (ordToByte) ordToByte[itemStart + ord] = id;
        if (scalars) {
            if (row + 1 > scalars[6]) scalars[6] = row + 1;   // totalRows (pre-conveyor)
            if (x > scalars[7]) scalars[7] = x;               // widest row, ITEM-RELATIVE
        }
        ord++;
        if ((flags & F_NEWLINE) !== 0) {
            baseRow += rowsForLine(col, wrap);
            col = 0;
            lineAdv = 0;
            segAdv = 0;
        } else {
            col++;
            // lineAdv accumulates in f64: the oracle is the TRUTH layer, and on a long
            // foldless line the f64 prefix sits between the two f32 groupings (CPU
            // serial drifts ~linearly with a systematic bias; the GPU's chunked tree
            // stays log-bounded, near this value). segAdv stays fround-per-add — it is
            // the fold>0 x, and matching the GPU's f32 order is what makes those lanes
            // bit-exact.
            lineAdv += slots.m[om + M_ADVANCE];
            segAdv = (fold > 0 && col % fold === 0) ? 0
                : Math.fround(segAdv + slots.m[om + M_ADVANCE]);
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
 * prefixes. Foldless, x IS the line prefix (M_LINE_ADV).
 *
 * Also reduces the item's FOLD SCALARS (lanes 6/7 of the bounds table): totalRows =
 * max(row+1) and the item-relative widest row max(x) — reduced HERE, before paginate,
 * because the page-fan stride derives from lane 7 and paginate reads it.
 *
 * Cross-thread reads: previous passes' lanes + the ordinal map. Writes: M_BASE_X,
 * M_X/M_Y/M_Z, the scalar reduce. Read set and write set are disjoint lanes —
 * deterministic under any schedule.
 *
 * @param {Uint32Array} slots @param {number} id
 * @param {Object} p - {itemStart, wrapWidth, pageCols, origin, lineHeight, zStep}
 * @param {Uint32Array} ordToByte
 * @param {Float64Array|number[]} [scalars] - the item's 8-lane bounds row (6/7 written)
 */
export function resolveX(slots, id, p, ordToByte, scalars) {
    const om = mBase(id), oe = eBase(id);
    if ((slots.x[oe + E_FLAGS] & F_LEADER) === 0) return;
    const wrap = Math.max(0, Math.trunc(p.wrapWidth || 0));
    const fold = wrap > 0 ? wrap : Math.max(0, Math.trunc(p.pageCols || 0));
    const col = slots.x[oe + E_COL];
    const ord = slots.x[oe + E_ORD];
    const itemStart = Math.max(0, Math.trunc(p.itemStart || 0));

    let x = 0;
    if (fold > 0) {
        // FORWARD from the segment start — the same order the oracle's serial segAdv
        // accumulates, so the f32 grouping (and therefore the bits) match exactly.
        const back = col % fold;
        for (let k = back; k >= 1; k--) {
            const q = ordToByte[itemStart + ord - k];
            x = Math.fround(x + slots.m[mBase(q) + M_ADVANCE]);
        }
    } else {
        x = slots.m[om + M_LINE_ADV];
    }

    const row = slots.x[oe + E_ROW];
    const wrapRow = wrap > 0 ? Math.floor(col / wrap) : 0;
    slots.m[om + M_BASE_X] = x + (p.origin?.x || 0);
    slots.m[om + M_X] = x + (p.origin?.x || 0);
    // Same rule as layoutItem: the ITEM's line height, never the glyph's own.
    slots.m[om + M_Y] = -row * p.lineHeight + (p.origin?.y || 0);
    slots.m[om + M_Z] = -wrapRow * (p.zStep || 0) + (p.origin?.z || 0);

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
 * The remap is RECONSTRUCTIVE, never accumulative: x reads the untouched M_BASE_X, and
 * y/z rebuild from the exact integer lanes. Running it again with new params re-derives
 * from base — there is no "re-paginate", the remap cannot double-apply.
 *
 * EVERY PAGE DECISION READS THE INTEGER row/col, NEVER THE FLOAT POSITION — measured on
 * the torture corpus (119 slots flipped page on ULP wobble when float-keyed). The float
 * position is reconstructed FROM the integer page assignment, so placement inherits the
 * decision's exactness.
 *
 * @param {Uint32Array} slots @param {number} id @param {PageParams} p
 */
export function paginate(slots, id, p) {
    const om = mBase(id), oe = eBase(id);
    if ((slots.x[oe + E_FLAGS] & F_LEADER) === 0) return;

    const rows = Math.max(0, Math.trunc(p.pageRows || 0));
    const cols = Math.max(0, Math.trunc(p.pageCols || 0));
    const scroll = Math.max(0, Math.trunc(p.scrollRows || 0));
    if (rows === 0 && cols === 0 && scroll === 0) return;

    const row = slots.x[oe + E_ROW], col = slots.x[oe + E_COL];
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
    slots.m[om + M_X] = slots.m[om + M_BASE_X] + (yPage % wide) * (p.pageStrideX || 0);
    slots.m[om + M_Y] = oy - (screenRow - yPage * rows) * p.lineHeight - band * (p.bandStrideY || 0);
    slots.m[om + M_Z] = oz - seg * (p.zStep || 0) + band * (p.depthPerBand || 0) + xPage * (p.depthPerColumn || 0);
}

/**
 * KERNEL — thread per byte. Fold this slot's quad into the running min/max box
 * (lanes 0-5, over the FINAL positions). On the GPU these are six atomics with an
 * early-out into the item's bounds-table row. Lanes 6/7 are NOT touched here — they
 * are the fold scalars resolveX reduced before pagination.
 *
 * @param {Uint32Array} slots @param {number} id @param {Float64Array|number[]} box
 */
export function boundsReduce(slots, id, box) {
    const om = mBase(id), oe = eBase(id);
    if ((slots.x[oe + E_FLAGS] & F_LEADER) === 0) return;
    const x = slots.m[om + M_X], y = slots.m[om + M_Y], z = slots.m[om + M_Z];
    const w = slots.m[om + M_ADVANCE], h = slots.m[om + M_HEIGHT];
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
 * @param {{blockIndex:Uint32Array, blocks:Uint32Array}} trie
 * @param {Object} [opts]
 * @returns {{slots:Uint32Array, bounds:?Object, itemBounds:Array, misses:number[],
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
    // Refuse an underspecified item HERE, once per item, before a single lane is written.
    // Not inside layoutItem/resolveX: those run per byte, and a per-glyph check would pay
    // for the whole corpus to state something true of the item.
    resolved.forEach((r, i) => { r.lineHeight = assertLineHeight(r.lineHeight, i); });

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
        // The ITEM's lineHeight, full stop. This read used to be
        // `resolved[i].lineHeight ?? it.page?.lineHeight`, and the right-hand side became
        // unreachable the moment assertLineHeight started guaranteeing a finite number
        // above — proven by making the RHS throw and running the whole suite, the fixture
        // generator and a GPU gate without it firing once.
        //
        // It was never a feature either. The `??` prefers the ITEM's value, so a
        // page-specific pitch could only ever take effect on an item whose lineHeight was
        // unset — i.e. only through the malformed input that is now illegal. The page's
        // own pitch was gated on the bug. (mojo-rising's find and argument.)
        //
        // NOTE for anyone adding one back: a lineHeight on the page INPUT is not consulted.
        // Fixtures and tests still pass one, always equal to the item's, so nothing is
        // silently diverging today — but that redundancy is worth removing, and whether an
        // ignored page.lineHeight should be REFUSED rather than ignored is a separate call.
        lineHeight: resolved[i].lineHeight,
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
        if ((slots.x[eBase(id) + E_FLAGS] & F_LEADER) !== 0) leaders++;
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
