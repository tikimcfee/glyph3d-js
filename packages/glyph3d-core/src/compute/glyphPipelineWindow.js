/**
 * glyphPipelineWindow — WINDOWED layout, seeded from the baked index: the spec for
 * the pipeline where slots are a CACHE, not a mirror.
 *
 * The full pipeline materializes every byte's slot. At repo scale that is the wall
 * (a slot is 13 f32 — 52× the source byte). This module states the alternative the
 * checkpoint index exists for: materialize ONLY a byte window's slots, seeding the
 * fold with the window-start's exclusive prefix — checkpoint[floor(b/K)] plus a
 * ≤ K-byte walk. Same three-layer discipline as the scan
 * (oracle → spec → TSL): this file is the CPU-provable spec, structured so each
 * piece maps onto a dispatch; the TSL windowed lane reproduces it against the same
 * proofs (tools/bake.test.mjs fuzzes window ≡ full run).
 *
 * TWO QUERIES + ONE MATERIALIZER:
 *
 *   windowSeedAt      greatest window-startable leader ≤ a byte, with its seed
 *   byteRangeForRows  visual rows [rowFrom, rowTo) → the byte window + seed (the
 *                     scroll/visibility lane's question), O(log checkpoints + K)
 *   runWindow         decode + seeded apply + resolveX + paginate + bounds over
 *                     [from, to) ONLY — the SHARED per-slot kernels, restricted
 *
 * WINDOW-STARTABLE means the fold owes nothing to bytes left of the window:
 * a leader at a fold-segment boundary (col % fold == 0; any leader when foldless).
 * resolveX re-sums x forward from the segment start, so every predecessor it reads
 * lies inside the window — no apron, no gather outside [from, to).
 *
 * THE WRAP CONTRACT. Checkpoints are baked at wrap 0. Their nl/glyphs/headLen/
 * tailLen/tailAdv lanes are wrap-INDEPENDENT (glyph counts since newlines); the
 * `rows` lane is wrap-dependent — at wrap 0 it counts interior closed LINES.
 * Under a live wrap `w`, an interior line of length len occupies rowsForLine(len,
 * w) rows, which equals 1 — the wrap-0 value — exactly when len < w. So the baked
 * seed is EXACT for any wrap STRICTLY WIDER than the file's longest line
 * (record.maxLineLen < wrap), and for unwrapped layout always. A file with
 * wrapping lines returns null from the queries — the caller takes the full fold,
 * loudly. The constraint is on WRAP alone: a pageCols fold never moves a row
 * (it repaginates x), so wrap-0 items with page columns are always seedable.
 * (The default boot fold is wrap 200; code lines are almost always shorter. A
 * per-wrap checkpoint lane is a format-v3 option if that stops being true.)
 *
 * PAGINATION takes the fan stride as an INPUT (deriveStride over the item's fold
 * scalars): a window can't measure the file's widest row, but the bake already
 * did — record.maxRowExtent is exact whenever the seed contract above holds.
 *
 * Worker-safe: no DOM, no three.
 */

import {
    mBase, eBase, M_LINE_ADV, E_ROW, E_COL, E_FLAGS, E_ORD, F_LEADER, F_RENDERED, NEWLINE,
    allocSlots, decodeAndResolve, resolveX, paginate, boundsReduce, sequenceLength} from './glyphPipelineReference.js';
import { scanIdentity, scanCombine, scanLeaf, scanLeafValue, lanesFromPrefix } from './glyphPipelineScan.js';
import { CK_STRIDE, checkpointAt, decodeCodepointAt } from './glyphBake.js';
import { trieLookup } from './GlyphTrie.js';

/** Is this WRAP seedable from wrap-0 checkpoints for this record? (See header —
 *  the constraint is on wrap only; a pageCols fold never moves a row.) */
export function windowSeedable(record, wrap) {
    return wrap === 0 || record.maxLineLen < wrap;
}

/**
 * Walk [from, to), calling `visit(id, cp, advance, prefix)` at each leader with its
 * EXCLUSIVE prefix, folding as it goes. Returns the prefix at `to`. The one walk
 * body every query below shares.
 * @private
 */
function walk(bytes, trie, from, to, acc, visit) {
    for (let id = from; id < to; id++) {
        const n = sequenceLength(bytes, id);
        if (n === 0) continue;
        const cp = decodeCodepointAt(bytes, id, n);
        const g = trieLookup(trie, cp);
        if (visit) visit(id, cp, g.advance, acc);
        scanCombine(acc, scanLeafValue(cp === NEWLINE, g.advance, true, 0, id === 0));
    }
    return acc;
}

/** Checkpoint index whose prefix we start a walk to `byteIndex` from. @private */
function ckBefore(record, byteIndex) {
    const K = record.checkpointInterval;
    return Math.min(Math.floor(byteIndex / K), record.checkpoints.length / CK_STRIDE);
}

/**
 * The greatest window-startable leader ≤ `targetByte`, with its seed prefix.
 * @param {Uint8Array} bytes @param {Object} trie
 * @param {{checkpoints:Float64Array, checkpointInterval:number, maxLineLen:number}} record
 * @param {number} targetByte
 * @param {number} wrap - the item's wrap width (0 = unwrapped)
 * @param {number} [fold] - the x re-sum unit (wrap when wrapping, else pageCols —
 *   resolveX's rule); defaults to `wrap`
 * @returns {{from:number, seed:Object}|null} null when the wrap isn't seedable
 *   from wrap-0 checkpoints, or no startable leader exists at/before targetByte
 */
export function windowSeedAt(bytes, trie, record, targetByte, wrap, fold = wrap) {
    if (!windowSeedable(record, wrap)) return null;
    const K = record.checkpointInterval;
    let ck = ckBefore(record, targetByte);
    // A startable leader might precede this checkpoint's interval — back up until
    // one is found (each step is one ≤K walk; in code text the very first interval
    // almost always hits: every line start is startable).
    for (; ck >= 0; ck--) {
        const acc = ck > 0 ? checkpointAt(record.checkpoints, ck - 1) : scanIdentity();
        let best = null;
        walk(bytes, trie, ck * K, Math.min(targetByte + 1, bytes.length), acc, (id, cp, adv, P) => {
            if (id <= targetByte && (fold === 0 || P.tailLen % fold === 0)) {
                best = { from: id, seed: { ...P } };
            }
        });
        if (best) return best;
    }
    return null;
}

/**
 * Visual rows [rowFrom, rowTo) under `wrap` → the byte window + seed. Two seeks,
 * each O(log checkpoints + K): rows are monotone over checkpoints, so binary
 * search finds the interval, and one walk inside it finds the exact leader.
 *
 * @returns {{from:number, to:number, seed:Object}|null} to == bytes.length when
 *   rowTo runs past the file; null when the wrap isn't seedable. A row-start
 *   leader is startable under ANY fold: its col is 0 or a wrap multiple.
 */
export function byteRangeForRows(bytes, trie, record, rowFrom, rowTo, wrap) {
    if (!windowSeedable(record, wrap)) return null;

    const K = record.checkpointInterval;
    const nCk = record.checkpoints.length / CK_STRIDE;
    const rowOfCk = (i) => lanesFromPrefix(checkpointAt(record.checkpoints, i), wrap).row;

    // First byte whose leader sits at row ≥ `row`, walking from the last
    // checkpoint strictly below it.
    const seek = (row) => {
        let lo = 0, hi = nCk - 1, ck = 0;                  // ck = 1 + last index with row < target
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (rowOfCk(mid) < row) { ck = mid + 1; lo = mid + 1; } else hi = mid - 1;
        }
        const acc = ck > 0 ? checkpointAt(record.checkpoints, ck - 1) : scanIdentity();
        let found = null;
        let at = ck * K;
        while (found === null && at < bytes.length) {      // cross intervals until the row arrives
            const end = Math.min(at + K, bytes.length);
            walk(bytes, trie, at, end, acc, (id, cp, adv, P) => {
                if (found === null && lanesFromPrefix(P, wrap).row >= row) {
                    found = { at: id, seed: { ...P } };
                }
            });
            at = end;
        }
        return found;                                       // null → row is past the file
    };

    const start = seek(rowFrom);
    if (!start) return null;
    const end = seek(rowTo);
    return { from: start.at, to: end ? end.at : bytes.length, seed: start.seed };
}

/**
 * Materialize ONLY [from, to): decode, seeded apply, resolveX, paginate, bounds —
 * the shared kernels, restricted to the window. `slots` spans the whole buffer
 * (spec-level; the GPU lane maps a window to a pooled allocation) but only window
 * lanes are written.
 *
 * @param {Uint8Array} bytes @param {Object} trie
 * @param {Object} p - {origin, page, wrapWidth, pageCols, lineHeight, zStep,
 *                      pageStrideX} — one item; pageStrideX from the BAKED fold
 *                      scalars (deriveStride), not measured here
 * @param {{from:number, to:number, seed:Object}} win
 * @returns {{slots:Uint32Array, ordToByte:Uint32Array, box:Float64Array}}
 */
export function runWindow(bytes, trie, p, win) {
    const { from, to, seed } = win;
    const wrap = Math.max(0, Math.trunc(p.wrapWidth || 0));
    const slots = allocSlots(bytes.length);
    const ordToByte = new Uint32Array(bytes.length);

    // dispatch 1, restricted: decode the window's bytes.
    for (let id = from; id < to; id++) decodeAndResolve(bytes, slots, trie, id);

    // dispatch 6, seeded: run the seed prefix through the window's leaves, writing
    // each leader's exact lanes (the same body as the scan's apply, with the
    // partialPrefix replaced by the index's seed).
    const R = { ...seed };
    for (let id = from; id < to; id++) {
        const om = mBase(id), oe = eBase(id);
        const flags = slots.x[oe + E_FLAGS];
        if ((flags & F_LEADER) !== 0) {
            const v = lanesFromPrefix(R, wrap);
            slots.x[oe + E_ROW] = v.row;
            slots.x[oe + E_COL] = v.col;
            slots.m[om + M_LINE_ADV] = v.lineAdv;
            slots.x[oe + E_ORD] = v.ord;
            slots.x[oe + E_FLAGS] = flags | F_RENDERED;
            ordToByte[v.ord] = id;
        }
        scanCombine(R, scanLeaf(slots, id, wrap, id === 0));
    }

    // dispatches 7-9, restricted: the shared kernels over the window's ids. Every
    // fold predecessor resolveX gathers is ≥ from (window-startable start).
    const rp = {
        itemStart: 0, wrapWidth: wrap, pageCols: p.page?.pageCols || p.pageCols || 0,
        origin: p.origin, lineHeight: p.lineHeight, zStep: p.zStep || 0,
    };
    for (let id = from; id < to; id++) resolveX(slots, id, rp, ordToByte);

    const pageParams = {
        ...p.page,
        pageStrideX: p.pageStrideX || 0,
        wrap, zStep: p.zStep || 0, origin: p.origin, lineHeight: p.lineHeight,
    };
    for (let id = from; id < to; id++) paginate(slots, id, pageParams);

    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]);
    for (let id = from; id < to; id++) boundsReduce(slots, id, box);

    return { slots, ordToByte, box };
}
