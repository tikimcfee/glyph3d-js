/**
 * glyphPipelineReference — the GPU glyph pipeline, written out in JS, one thread at a time.
 *
 * This is the EXECUTABLE SPEC. Each function here is one compute kernel, and each is written
 * as the body of a single thread with its `id` passed in, so the JS and the WGSL stay
 * line-for-line comparable. The GPU is diffed against this; when they disagree, this is
 * what's right until proven otherwise.
 *
 * The pipeline takes the file's UTF-8 BYTES and produces positions and a bounding box. It
 * never sees a JavaScript string, never splits on newlines, and builds no line table — the
 * CPU's entire job is moving bytes from the socket into a buffer.
 *
 *   1. decodeAndResolve  bytes → codepoint → glyph metrics (trie). Thread per byte.
 *   2. layout            the backward walk. Thread per byte.
 *   3. paginate          pure per-slot remap of a flat position. Thread per byte.
 *   4. boundsReduce      min/max over the placed quads. Thread per byte.
 *
 * BYTE-INDEXED THROUGHOUT. There is one slot per BYTE, not per glyph: a continuation byte
 * of a multi-byte sequence stays a non-leader and is skipped by every later pass. That is
 * what buys us no compaction pass and no prefix sum to find glyph indices — and it makes a
 * slot index identical to a source byte offset, so picking, tree-sitter ranges, and the
 * cursor all address the same space with no mapping table anywhere.
 *
 * Worker-safe: no DOM, no three.
 */

import { trieLookup } from './GlyphTrie.js';

export const NEWLINE = 0x0A;

/**
 * Per-slot lanes. One flat Float32Array so the GPU binds one buffer.
 *
 * ROW and COL are the reason this works. They are exact integers — a count of newlines and
 * a count of glyphs since the last newline — and EVERY DISCRETE DECISION reads them, never
 * the float position. x accumulates in f32 and is therefore not associative: inheriting at
 * step 129 versus step 400 sums the same advances in different groupings and lands a few
 * ULPs apart. Harmless for placement (sub-thousandth of a cell), fatal for a decision —
 * `floor(y / pageHeight)` at a page boundary flips a glyph a whole page on a 1-ULP wobble.
 * That is the same instability the old CPU path papered over with a scaled epsilon nudge.
 * Integers do not wobble, so the nudge has nothing to fix.
 */
export const SLOT_STRIDE = 10;
export const S_CODEPOINT = 0;
export const S_GLYPH_ID = 1;
export const S_ADVANCE = 2;
export const S_HEIGHT = 3;
export const S_X = 4;
export const S_Y = 5;
export const S_Z = 6;
export const S_ROW = 7;    // exact: newlines before this glyph
export const S_COL = 8;    // exact: glyphs since the last newline
export const S_FLAGS = 9;

export const F_LEADER = 1;        // this byte begins a codepoint
export const F_RENDERED = 2;      // this slot's absolute position is published
export const F_LINE_START = 4;    // the walk found a line break before finding a position
export const F_MISSING = 8;       // no atlas entry yet — blank, but correctly spaced

/** Allocate the slot buffer for a file of `byteLength` bytes. */
export function allocSlots(byteLength) {
    return new Float32Array(byteLength * SLOT_STRIDE);
}

/**
 * How many bytes the sequence starting at `i` occupies — 0 if this byte is a continuation
 * byte (or invalid), which is exactly the "am I a leader" test.
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
 * The decode is pure arithmetic on up to four bytes: no table, no lookup, no dependency on
 * any other thread. The RESOLVE is the trie's two loads. A continuation byte returns
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
    if (n === 0) return;                         // continuation byte — not a leader, stays zeroed

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

/** Nearest leader slot strictly before `id`, or `id` when there is none. */
function leaderBefore(slots, id) {
    for (let j = id - 1; j >= 0; j--) {
        if ((slots[j * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) return j;
    }
    return id;
}

/**
 * Visual rows a line occupies under `wrap`. `len` counts the line's non-newline glyphs; the
 * newline itself rides at column `len`, so a line whose length is an exact multiple of the
 * wrap width ends with a row holding only the (invisible) newline. Taking that literally
 * rather than special-casing it is what keeps the walk free of edge cases: EVERY glyph,
 * newline included, is at `floor(col / wrap)` of its line.
 */
export function rowsForLine(len, wrap) {
    if (!(wrap > 0)) return 1;
    return Math.floor(len / wrap) + 1;
}

/**
 * KERNEL 2 — thread per byte. THE LAYOUT WALK.
 *
 * Walk backward until finding a predecessor that has already published, then inherit and
 * stop. Find none and you walk to the start and compute the prefix yourself — a miss costs
 * redundant work, never a stall, so this needs no forward-progress guarantee.
 *
 * WRAP IS THE COST BOUND, NOT A FEATURE. Without it a minified JSON blob or a binary is one
 * line of millions of glyphs: nothing severs the accumulation, the layout is one absurd row,
 * and every thread that cannot inherit walks the whole file. `wrapWidth` cuts the line into
 * visual rows every N glyphs, and because x RESETS at each row start, the float sum can
 * never reach back further than one wrap. That is why the walk is split in two:
 *
 *   Phase A — row and col, as exact INTEGERS. Bounded by the inherit. Integer adds are
 *             cheap, so walking far here is survivable, and being exact is what lets every
 *             downstream decision (wrap, page, cursor) avoid float boundaries entirely.
 *   Phase B — x, the float sum of advances. Bounded UNCONDITIONALLY by `wrapWidth`, because
 *             the row start is at most `col % wrapWidth` glyphs back. This is the phase that
 *             would otherwise be unbounded, and wrap is what bounds it.
 *
 * A newline severs both. It does NOT zero an accumulation already made past it — that bug is
 * what tools/backtrack-layout.test.mjs keeps out, and it only reproduces when the inherit
 * point varies, which is exactly what a real GPU schedule does.
 *
 * `window` is a coherence dial, not a correctness one: refusing to inherit until that far
 * back means reading slots written by much earlier workgroups, which are likelier to be
 * visible. Correctness holds at window 0; the value is whatever the hardware needs.
 *
 * @param {Float32Array} slots @param {number} id
 * @param {{window?:number, wrapWidth?:number}} [params]
 */
export function layout(slots, id, params = {}) {
    const window = params.window ?? 128;
    const wrap = Math.max(0, Math.trunc(params.wrapWidth || 0));
    const o = id * SLOT_STRIDE;
    if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;

    // ── Phase A: exact integers. `run` counts glyphs back to the previous newline; the
    //    first newline crossed closes MY column, each one after that closes a whole line
    //    above me and contributes its wrapped row count.
    let run = 0, col = -1, row = 0, steps = 0;
    let prev = leaderBefore(slots, id);
    while (prev !== id) {
        const po = prev * SLOT_STRIDE;
        const ready = (slots[po + S_FLAGS] & F_RENDERED) !== 0 && steps > window;

        if (slots[po + S_CODEPOINT] === NEWLINE) {
            // Close whatever run was open: the first newline crossed ends MY line and fixes
            // my column; every later one closes a complete line above me.
            if (col < 0) col = run; else row += rowsForLine(run, wrap);
            run = 0;
            // Inheriting FROM a newline is its own case, and conflating it with the glyph
            // case is what broke wrap=200: a newline's `col` is its LINE's length, not a
            // position inside the run we just counted. Its row is the last visual row of the
            // line it terminates, so content after it starts exactly one row below.
            if (ready) { row += slots[po + S_ROW] + 1; break; }
        } else {
            if (ready) {
                // A normal glyph. Strip its own wrapped row off to recover its line's base,
                // then re-add from my side.
                const pCol = slots[po + S_COL];
                const pBase = slots[po + S_ROW] - (wrap > 0 ? Math.floor(pCol / wrap) : 0);
                if (col < 0) col = run + pCol + 1;               // same line as the predecessor
                else row += rowsForLine(run + pCol + 1, wrap);   // its line, completed by my run
                row += pBase;
                break;
            }
            run += 1;
        }

        steps++;
        const cur = prev;
        prev = leaderBefore(slots, prev);
        if (prev === cur) {                          // reached the first leader in the buffer
            if (col < 0) col = run; else row += rowsForLine(run, wrap);
            break;
        }
    }
    if (col < 0) col = run;

    // My own wrapped row within my line.
    const wrapRow = wrap > 0 ? Math.floor(col / wrap) : 0;
    row += wrapRow;

    // ── Phase B: x. The row started at most `col % wrapWidth` glyphs back — walk exactly
    //    that far and sum. With wrap off this walks to the line start instead, which is the
    //    unbounded case wrap exists to remove.
    const backTo = wrap > 0 ? (col % wrap) : col;
    let x = 0, k = 0, q = leaderBefore(slots, id);
    while (k < backTo && q !== id) {
        const qo = q * SLOT_STRIDE;
        if (slots[qo + S_CODEPOINT] === NEWLINE) break;
        x += slots[qo + S_ADVANCE];
        k++;
        const cur = q;
        q = leaderBefore(slots, q);
        if (q === cur) break;
    }

    slots[o + S_X] = x;
    slots[o + S_Y] = -row * (params.lineHeight ?? slots[o + S_HEIGHT]);
    slots[o + S_Z] = 0;
    slots[o + S_ROW] = row;
    slots[o + S_COL] = col;
    // Position first, THEN publish — the ordering the inherit branch depends on.
    slots[o + S_FLAGS] |= F_RENDERED;
}

/**
 * @typedef {Object} PageParams
 * @property {number} pageRows    - ROWS per page before breaking. 0 = no vertical paging.
 * @property {number} lineHeight  - world y per row (the page's world height is rows x this)
 * @property {number} pageCols    - COLUMNS per page before breaking. 0 = no horizontal paging.
 * @property {number} colWidth    - world x per column
 * @property {number} pageStrideX - world x between fanned page columns (0 = no fan). An
 *   explicit distance rather than a measured content width: the fan must not depend on a
 *   reduction this kernel cannot see. Feed it from the bounds pass when you want it snug.
 * @property {number} pagesWide   - page columns before wrapping down into the next band
 * @property {number} depthPerBand   - z recession per completed band of pages
 * @property {number} depthPerColumn - z recession per horizontal page
 */

/**
 * KERNEL 3 — thread per byte. Pagination as a PURE per-slot remap.
 *
 * A separate dispatch on purpose: the layout kernel stays one job, and a layout MODE is a
 * different kernel here rather than another branch inside the walk. Nothing here reads
 * another slot.
 *
 * EVERY PAGE DECISION READS THE INTEGER row/col, NEVER THE FLOAT POSITION. `floor(y /
 * pageHeight)` on an f32 y that was accumulated by a racing walk is not stable: two valid
 * dispatch orders sum the same advances in different groupings, land a few ULPs apart, and
 * a row sitting exactly on a page boundary flips to the other page. Measured, not theorised
 * — it was 119 slots on the torture corpus before this was integer-keyed, and it is the
 * same instability the old CPU path carried a scaled epsilon nudge to hide. An integer row
 * cannot wobble, so there is nothing left to nudge.
 *
 * The float position is then reconstructed FROM the integer page assignment, so placement
 * inherits the decision's exactness instead of the other way round.
 *
 * @param {Float32Array} slots @param {number} id @param {PageParams} p
 */
export function paginate(slots, id, p) {
    const o = id * SLOT_STRIDE;
    if ((slots[o + S_FLAGS] & F_LEADER) === 0) return;

    const rows = Math.max(0, Math.trunc(p.pageRows || 0));
    const cols = Math.max(0, Math.trunc(p.pageCols || 0));
    if (rows === 0 && cols === 0) return;

    const row = slots[o + S_ROW], col = slots[o + S_COL];
    let x = slots[o + S_X], y = slots[o + S_Y], z = slots[o + S_Z];

    let yPage = 0;
    if (rows > 0) {
        yPage = Math.floor(row / rows);                       // exact
        y += yPage * rows * p.lineHeight;                     // lift back to this page's top
    }
    let xPage = 0;
    if (cols > 0) {
        xPage = Math.floor(col / cols);                       // exact
        x -= xPage * cols * p.colWidth;                       // and back to its left edge
    }

    // Fan the vertical pages across `pagesWide` columns, then wrap down into the next band.
    // Both the column slot and the band index come from the exact page number.
    const wide = Math.max(1, Math.trunc(p.pagesWide || 1));
    x += (yPage % wide) * (p.pageStrideX || 0);
    const band = Math.floor(yPage / wide);
    z += band * (p.depthPerBand || 0) + xPage * (p.depthPerColumn || 0);

    slots[o + S_X] = x;
    slots[o + S_Y] = y;
    slots[o + S_Z] = z;
}

/**
 * KERNEL 4 — thread per byte. Fold this slot's quad into the running min/max.
 *
 * On the GPU these are six atomics with an early-out: a thread that cannot widen the box
 * loads once and leaves, so contention collapses almost immediately instead of every thread
 * doing a compare-exchange. Here it is the same reduction written serially.
 *
 * `box` is [minX, minY, minZ, maxX, maxY, maxZ], pre-armed to ±Infinity.
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
 * Run the whole pipeline serially — the reference result the GPU must reproduce.
 *
 * `order` lets a test dispatch the layout kernel in any thread order; the walk is a
 * deliberate race and every order must converge (tools/backtrack-layout.test.mjs).
 *
 * @param {Uint8Array} bytes
 * @param {{blockIndex:Uint32Array, blocks:Float32Array}} trie
 * @param {Object} [opts]
 * @param {PageParams} [opts.page]
 * @param {number} [opts.window]
 * @param {number[]} [opts.order] - layout dispatch order (default: ascending)
 * @returns {{slots:Float32Array, bounds:?{min:{x,y,z},max:{x,y,z}}, misses:number[], leaders:number}}
 */
export function runPipeline(bytes, trie, opts = {}) {
    const slots = allocSlots(bytes.length);
    const misses = [];
    for (let id = 0; id < bytes.length; id++) decodeAndResolve(bytes, slots, trie, id, misses);

    const order = opts.order || null;
    const lp = { window: opts.window ?? 128, wrapWidth: opts.wrapWidth ?? 0, lineHeight: opts.lineHeight };
    if (order) for (const id of order) layout(slots, id, lp);
    else for (let id = 0; id < bytes.length; id++) layout(slots, id, lp);

    if (opts.page) for (let id = 0; id < bytes.length; id++) paginate(slots, id, opts.page);

    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let id = 0; id < bytes.length; id++) boundsReduce(slots, id, box);

    let leaders = 0;
    for (let id = 0; id < bytes.length; id++) {
        if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) leaders++;
    }

    return {
        slots,
        bounds: box[0] === Infinity ? null : {
            min: { x: box[0], y: box[1], z: box[2] },
            max: { x: box[3], y: box[4], z: box[5] },
        },
        misses,
        leaders,
    };
}
