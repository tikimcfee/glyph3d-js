/**
 * glyphBake — a file's layout, as an IDEMPOTENT fold over its bytes.
 *
 * The bake is a pure function of (bytes, trie): one streaming forward pass — O(1)
 * state, NO slot allocation — that emits everything layout can know about a file
 * before the GPU ever sees it:
 *
 *   total        the whole file's monoid summary (glyphPipelineScan's element) —
 *                newlines, leaders, tail line, tail advance
 *   checkpoints  the exclusive prefix every `checkpointInterval` bytes. THE index:
 *                because the fold is an associative monoid, the layout state at ANY
 *                byte is checkpoint[floor(b/K)] folded forward ≤ K bytes — random
 *                access into the layout of a file that was never fully materialized.
 *                A GPU windowed scan seeds from the same records.
 *   scalars      the intrinsic (wrap 0, unpaged) shape: totalRows, maxRowExtent
 *                (the fold scalar the page-fan stride derives from), maxLineWidth,
 *                maxHeight — enough to MEASURE a grid before its bytes arrive
 *   box          the exact wrap-0 oracle bounds at the baked lineHeight
 *   lineHist     sparse line-length histogram — rowsUnderWrap() answers the exact
 *                visual row count under ANY wrap width from it
 *   census       every codepoint in the file (the repo union pre-bakes the atlas
 *                trie so nothing misses at load) + the codepoints the baking trie
 *                itself was missing (those advances were the missing fallback —
 *                report loud, never silently bake a lie)
 *
 * Same bytes + same trie ⇒ bit-identical record: the fold mirrors the oracle's
 * serial pass (glyphPipelineReference.layoutItem) leaf-for-leaf — decode is the
 * same arithmetic as decodeAndResolve, leaves come from the shared scanLeafValue,
 * maxima reduce in the same f64/fround discipline as the oracle's scalars. The
 * proof lives in tools/bake.test.mjs: bake scalars == runPipeline itemBounds, and
 * checkpoint-seeded folds == the full fold at every boundary.
 *
 * Worker-safe: no DOM, no three, no filesystem — hashing and index I/O belong to
 * the bake tool (tools/bake.mjs), not here.
 */

import { NEWLINE, sequenceLength, rowsForLine } from './glyphPipelineReference.js';
import { scanIdentity, scanCombine, scanLeafValue } from './glyphPipelineScan.js';
import { trieLookup } from './GlyphTrie.js';

/** Bumping this invalidates every baked record (the fold or the format changed). */
export const BAKE_VERSION = 2;

/** Bytes folded between checkpoints. 4096 ⇒ the index is ~1.2% of the source. */
export const CHECKPOINT_INTERVAL = 4096;

/**
 * Checkpoint lanes — one monoid summary, f64 so counts stay exact past 2^24.
 * (reset/wrap are omitted: inside one file reset is always 0 and wrap is a query
 * parameter, not file state.)
 */
export const CK_STRIDE = 6;
export const CK_NL = 0;
export const CK_GLYPHS = 1;
export const CK_ROWS = 2;
export const CK_HEAD_LEN = 3;
export const CK_TAIL_LEN = 4;
export const CK_TAIL_ADV = 5;

/** Checkpoint `i` (the exclusive prefix at byte (i+1)·interval) → a monoid element. */
export function checkpointAt(checkpoints, i) {
    const o = i * CK_STRIDE;
    const e = scanIdentity();
    e.nl = checkpoints[o + CK_NL];
    e.glyphs = checkpoints[o + CK_GLYPHS];
    e.rows = checkpoints[o + CK_ROWS];
    e.headLen = checkpoints[o + CK_HEAD_LEN];
    e.tailLen = checkpoints[o + CK_TAIL_LEN];
    e.tailAdv = checkpoints[o + CK_TAIL_ADV];
    return e;
}

/**
 * Decode the codepoint whose sequence starts at `id` — the same arithmetic as
 * decodeAndResolve, without a slot buffer to land in. Caller has already
 * established `n = sequenceLength(bytes, id) > 0`.
 */
export function decodeCodepointAt(bytes, id, n) {
    const at = (i) => (i < bytes.length ? bytes[i] : 0);
    const b0 = bytes[id], b1 = at(id + 1), b2 = at(id + 2), b3 = at(id + 3);
    if (n === 1) return b0;
    if (n === 2) return ((b0 & 0x1F) << 6) | (b1 & 0x3F);
    if (n === 3) return ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
    return ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
}

/**
 * Census-only pass — every codepoint the file's bytes decode to, no trie needed.
 * The bake tool's first pass unions these across the repo and primes the shape
 * cache once, so ONE trie (with nothing missing) serves every file's bake.
 * @param {Uint8Array} bytes @param {Set<number>} census - added to and returned
 */
export function collectCensus(bytes, census) {
    for (let id = 0; id < bytes.length; id++) {
        const n = sequenceLength(bytes, id);
        if (n === 0) continue;
        census.add(decodeCodepointAt(bytes, id, n));
    }
    return census;
}

/**
 * Fold bytes [from, to) of ONE file onto `acc` — decode, trie-resolve, combine.
 * The seeding primitive: start from scanIdentity() (or a checkpoint) and this
 * reaches the exact exclusive prefix of byte `to`. Shared by the bake pass, the
 * random-access query below, and the seeding proof in tools/bake.test.mjs.
 *
 * @param {Uint8Array} bytes @param {{blockIndex:Uint32Array,blocks:Float32Array}} trie
 * @param {number} from @param {number} to @param {Object} acc - mutated and returned
 */
export function foldBytes(bytes, trie, from, to, acc) {
    for (let id = from; id < to; id++) {
        const n = sequenceLength(bytes, id);
        if (n === 0) continue;                    // continuation byte: identity leaf
        const cp = decodeCodepointAt(bytes, id, n);
        const g = trieLookup(trie, cp);
        scanCombine(acc, scanLeafValue(cp, g.advance, true, 0, id === 0));
    }
    return acc;
}

/**
 * The exclusive prefix of byte `byteIndex` — nearest checkpoint + a ≤ interval
 * tail fold. lanesFromPrefix (glyphPipelineScan) turns it into row/col/ord/lineAdv.
 *
 * @param {Uint8Array} bytes @param {Object} trie
 * @param {{checkpoints:Float64Array, checkpointInterval:number}} record
 * @param {number} byteIndex
 */
export function prefixAt(bytes, trie, record, byteIndex) {
    const K = record.checkpointInterval;
    const ck = Math.min(Math.floor(byteIndex / K), record.checkpoints.length / CK_STRIDE);
    const acc = ck > 0 ? checkpointAt(record.checkpoints, ck - 1) : scanIdentity();
    return foldBytes(bytes, trie, ck * K, byteIndex, acc);
}

/**
 * THE BAKE — one streaming pass, the record out.
 *
 * `lineHeight` is required: the exact box is part of the record, and world y is
 * rows × lineHeight (the app-wide metrics bag the arena's grids share). A missing
 * value here would silently bake per-glyph heights the runtime never uses.
 *
 * @param {Uint8Array} bytes
 * @param {{blockIndex:Uint32Array, blocks:Float32Array}} trie
 * @param {{lineHeight:number, checkpointInterval?:number}} opts
 * @returns {{
 *   byteLength:number, leaders:number, newlines:number, totalRows:number,
 *   maxRowExtent:number, maxLineWidth:number, maxHeight:number,
 *   box:?{min:{x,y,z}, max:{x,y,z}},
 *   total:Object, checkpoints:Float64Array, checkpointInterval:number,
 *   lineHist:Map<number,number>, census:Uint32Array, missing:Uint32Array,
 *   lineHeight:number, version:number,
 * }}
 */
export function bakeFile(bytes, trie, opts = {}) {
    const L = opts.lineHeight;
    if (!(L > 0)) throw new Error('bakeFile: a positive lineHeight is required (the app-wide metrics bag value)');
    const K = Math.max(1, Math.trunc(opts.checkpointInterval ?? CHECKPOINT_INTERVAL));
    const n = bytes.length;

    const ckCount = n > 0 ? Math.floor((n - 1) / K) : 0;
    const checkpoints = new Float64Array(ckCount * CK_STRIDE);

    const acc = scanIdentity();
    const census = new Set();
    const missing = new Set();
    const lineHist = new Map();
    let maxRow = -1, maxRowExtent = 0, maxLineWidth = 0, maxTop = -Infinity, maxHeight = 0, leaders = 0;

    for (let id = 0; id < n; id++) {
        if (id > 0 && id % K === 0) {
            const o = (id / K - 1) * CK_STRIDE;
            checkpoints[o + CK_NL] = acc.nl;
            checkpoints[o + CK_GLYPHS] = acc.glyphs;
            checkpoints[o + CK_ROWS] = acc.rows;
            checkpoints[o + CK_HEAD_LEN] = acc.headLen;
            checkpoints[o + CK_TAIL_LEN] = acc.tailLen;
            checkpoints[o + CK_TAIL_ADV] = acc.tailAdv;
        }

        const seq = sequenceLength(bytes, id);
        if (seq === 0) continue;                  // continuation byte: identity leaf
        const cp = decodeCodepointAt(bytes, id, seq);
        const g = trieLookup(trie, cp);
        census.add(cp);
        if (g.missing) missing.add(cp);
        leaders++;

        // The exclusive prefix IS the accumulator right now — read the leader's
        // wrap-0 lanes before its own leaf folds in (mirrors layoutItem's order).
        const row = acc.nl;                       // wrap 0: every closed line is one row
        const x = acc.tailAdv;                    // foldless x IS the line prefix
        if (row > maxRow) maxRow = row;
        if (x > maxRowExtent) maxRowExtent = x;   // the fold scalar (lane 7): max x
        const xw = x + g.advance;                 // the box edge (lane 3): max x+w, f64
        if (xw > maxLineWidth) maxLineWidth = xw;
        const top = g.height - row * L;           // boundsReduce's y+h at wrap 0
        if (top > maxTop) maxTop = top;
        if (g.height > maxHeight) maxHeight = g.height;
        if (cp === NEWLINE) {
            lineHist.set(acc.tailLen, (lineHist.get(acc.tailLen) || 0) + 1);
        }

        scanCombine(acc, scanLeafValue(cp, g.advance, true, 0, id === 0));
    }

    const totalRows = maxRow + 1;
    let maxLineLen = acc.tailLen;
    for (const len of lineHist.keys()) if (len > maxLineLen) maxLineLen = len;
    return {
        version: BAKE_VERSION,
        byteLength: n,
        leaders,
        newlines: acc.nl,
        totalRows,
        maxRowExtent,
        maxLineWidth,
        maxHeight,
        maxLineLen,
        box: leaders === 0 ? null : {
            min: { x: 0, y: -maxRow * L, z: 0 },
            max: { x: maxLineWidth, y: maxTop, z: 0 },
        },
        total: acc,
        checkpoints,
        checkpointInterval: K,
        lineHist,
        census: Uint32Array.from([...census].sort((a, b) => a - b)),
        missing: Uint32Array.from([...missing].sort((a, b) => a - b)),
        lineHeight: L,
    };
}

/**
 * Exact visual rows under ANY wrap width, from the histogram + the total summary —
 * the measure a grid needs before its bytes arrive, for whatever wrap it will use.
 * Every closed line contributes rowsForLine(len, wrap); an open tail line occupies
 * floor((tailLen-1)/wrap)+1 rows (its last glyph's wrap row, inclusive).
 *
 * @param {{lineHist:Map<number,number>, total:{tailLen:number}}} record
 * @param {number} wrap - 0 = no wrap
 */
export function rowsUnderWrap(record, wrap) {
    let rows = 0;
    for (const [len, count] of record.lineHist) rows += rowsForLine(len, wrap) * count;
    const tail = record.total.tailLen;
    if (tail > 0) rows += (wrap > 0 ? Math.floor((tail - 1) / wrap) : 0) + 1;
    return rows;
}
