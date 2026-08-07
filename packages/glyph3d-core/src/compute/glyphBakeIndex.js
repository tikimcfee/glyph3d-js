/**
 * glyphBakeIndex — the baked layout index as ONE binary file.
 *
 * The whole repo's index is a single `.glyph3d/bake/index.bin`: one fetch, zero
 * JSON, and the consumer reads records as typed-array views over the fetched
 * buffer — a file that is never opened costs nothing to "parse". Layout (all
 * little-endian; sections 8-aligned):
 *
 *   header      fixed 96 bytes: magic 'GBK2', version, metrics identity
 *               (fontSize/worldScale/lineHeight/charSize — the whole advance
 *               expression), interval, counts, section offsets
 *   census      u32 × censusCount — every codepoint in the repo, sorted
 *   records     f64 × REC_STRIDE per file — the scalar record (counts are exact
 *               in f64; one lane type keeps the reader one view)
 *   hashes      32 bytes per file — the content sha256 (the carry-forward key)
 *   paths       per file: u32 length + UTF-8 bytes, in record order
 *   checkpoints f64 × CK_STRIDE per checkpoint — every file's monoid prefixes
 *   hist        u32 pairs (len, count) — every file's line-length histogram
 *
 * encode/decode live TOGETHER here (worker-safe, no DOM/fs) so the bake tool and
 * the browser consumer cannot drift: the tool round-trips its own output through
 * decode in its tests, and carried-forward records re-slice a previous index
 * through the same decoder.
 */

import { BAKE_VERSION, CK_STRIDE } from './glyphBake.js';

export const INDEX_MAGIC = 0x324B4247;   // 'GBK2' little-endian

/** Per-record f64 lanes. */
export const REC_STRIDE = 19;
export const R_BYTES = 0;
export const R_LEADERS = 1;
export const R_NEWLINES = 2;
export const R_ROWS = 3;
export const R_MAX_ROW_EXTENT = 4;
export const R_MAX_LINE_WIDTH = 5;
export const R_MAX_HEIGHT = 6;
export const R_MAX_LINE_LEN = 7;
export const R_BOX_MAX_Y = 8;            // the one box lane rows×lineHeight can't derive
export const R_T_NL = 9;                 // the total summary (the whole-file fold)
export const R_T_GLYPHS = 10;
export const R_T_ROWS = 11;
export const R_T_HEAD_LEN = 12;
export const R_T_TAIL_LEN = 13;
export const R_T_TAIL_ADV = 14;
export const R_CK_INDEX = 15;            // first checkpoint (index, not bytes)
export const R_CK_COUNT = 16;
export const R_HIST_INDEX = 17;          // first hist pair (index, not bytes)
export const R_HIST_COUNT = 18;

const HEADER_BYTES = 96;
const align8 = (n) => (n + 7) & ~7;

/**
 * Encode the index. `entries` is [{path, hash(Uint8Array 32), record}] in FINAL
 * order (the tool sorts by path); `record` is a bakeFile() record — or a carried
 * one re-sliced from a previous index (same shape via recordAt + slices).
 *
 * @param {{fontSize:number, worldScale:number, lineHeight:number,
 *          charSize:{width:number,height:number}, checkpointInterval:number}} header
 * @param {Uint32Array|number[]} census - sorted repo codepoint union
 * @param {Array<{path:string, hash:Uint8Array, record:Object}>} entries
 * @returns {Uint8Array}
 */
export function encodeBakeIndex(header, census, entries) {
    const enc = new TextEncoder();
    const pathBytes = entries.map((e) => enc.encode(e.path));

    let ckTotal = 0, histTotal = 0, pathTotal = 0;
    for (const e of entries) {
        ckTotal += e.record.checkpoints.length / CK_STRIDE;
        histTotal += e.record.lineHist.size;
    }
    for (const p of pathBytes) pathTotal += 4 + p.byteLength;

    const censusOff = HEADER_BYTES;
    const recOff = align8(censusOff + census.length * 4);
    const hashOff = recOff + entries.length * REC_STRIDE * 8;
    const pathOff = hashOff + entries.length * 32;
    const ckOff = align8(pathOff + pathTotal);
    const histOff = ckOff + ckTotal * CK_STRIDE * 8;
    const total = align8(histOff + histTotal * 8);

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);

    dv.setUint32(0, INDEX_MAGIC, true);
    dv.setUint32(4, BAKE_VERSION, true);
    dv.setFloat64(8, header.fontSize, true);
    dv.setFloat64(16, header.worldScale, true);
    dv.setFloat64(24, header.lineHeight, true);
    dv.setFloat64(32, header.charSize.width, true);
    dv.setFloat64(40, header.charSize.height, true);
    dv.setUint32(48, header.checkpointInterval, true);
    dv.setUint32(52, entries.length, true);
    dv.setUint32(56, census.length, true);
    dv.setUint32(60, censusOff, true);
    dv.setUint32(64, recOff, true);
    dv.setUint32(68, hashOff, true);
    dv.setUint32(72, pathOff, true);
    dv.setUint32(76, ckOff, true);
    dv.setUint32(80, histOff, true);
    dv.setUint32(84, total, true);
    // 88..96: metricsHash — 16 hex chars (64 bits of the fonts+config sha256). The
    // carry-forward key: font BYTES can change without charSize changing, so the
    // scalar header alone can't prove advance identity across bakes.
    for (let i = 0; i < 8; i++) out[88 + i] = parseInt(header.metricsHash.slice(i * 2, i * 2 + 2), 16);

    new Uint32Array(out.buffer, censusOff, census.length).set(census);

    const recs = new Float64Array(out.buffer, recOff, entries.length * REC_STRIDE);
    const cks = new Float64Array(out.buffer, ckOff, ckTotal * CK_STRIDE);
    const hists = new Uint32Array(out.buffer, histOff, histTotal * 2);

    let ckAt = 0, histAt = 0, pathAt = pathOff;
    for (let i = 0; i < entries.length; i++) {
        const { hash, record: r } = entries[i];
        const o = i * REC_STRIDE;
        recs[o + R_BYTES] = r.byteLength;
        recs[o + R_LEADERS] = r.leaders;
        recs[o + R_NEWLINES] = r.newlines;
        recs[o + R_ROWS] = r.totalRows;
        recs[o + R_MAX_ROW_EXTENT] = r.maxRowExtent;
        recs[o + R_MAX_LINE_WIDTH] = r.maxLineWidth;
        recs[o + R_MAX_HEIGHT] = r.maxHeight;
        recs[o + R_MAX_LINE_LEN] = r.maxLineLen;
        recs[o + R_BOX_MAX_Y] = r.box ? r.box.max.y : 0;
        recs[o + R_T_NL] = r.total.nl;
        recs[o + R_T_GLYPHS] = r.total.glyphs;
        recs[o + R_T_ROWS] = r.total.rows;
        recs[o + R_T_HEAD_LEN] = r.total.headLen;
        recs[o + R_T_TAIL_LEN] = r.total.tailLen;
        recs[o + R_T_TAIL_ADV] = r.total.tailAdv;

        const nCk = r.checkpoints.length / CK_STRIDE;
        recs[o + R_CK_INDEX] = ckAt / CK_STRIDE;
        recs[o + R_CK_COUNT] = nCk;
        cks.set(r.checkpoints, ckAt);
        ckAt += nCk * CK_STRIDE;

        recs[o + R_HIST_INDEX] = histAt / 2;
        recs[o + R_HIST_COUNT] = r.lineHist.size;
        for (const [len, count] of [...r.lineHist.entries()].sort((a, b) => a[0] - b[0])) {
            hists[histAt++] = len;
            hists[histAt++] = count;
        }

        if (hash.byteLength !== 32) throw new Error(`encodeBakeIndex: hash for ${entries[i].path} is ${hash.byteLength} bytes, want 32`);
        out.set(hash, hashOff + i * 32);

        dv.setUint32(pathAt, pathBytes[i].byteLength, true);
        out.set(pathBytes[i], pathAt + 4);
        pathAt += 4 + pathBytes[i].byteLength;
    }
    return out;
}

/**
 * Decode an index — views over the buffer, no copies. Throws on a bad magic or
 * version (the caller decides how loud; a version mismatch is a rebake, never a
 * best-effort parse). `recordAt(i)` materializes one file's record object —
 * including its lineHist Map and checkpoint view — so unopened files cost only
 * their slice of the paths table.
 *
 * @param {Uint8Array} bytes
 * @returns {{header:Object, paths:string[], pathIndex:Map<string,number>,
 *            census:Uint32Array, recordAt:(i:number)=>Object,
 *            hashAt:(i:number)=>Uint8Array}}
 */
export function decodeBakeIndex(bytes) {
    if (bytes.byteLength < HEADER_BYTES) throw new Error(`bake index: ${bytes.byteLength} bytes is no index`);
    // Typed views need alignment; a fetched buffer's byteOffset may not be 8-aligned.
    const buf = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== INDEX_MAGIC) throw new Error(`bake index: bad magic 0x${magic.toString(16)}`);
    const version = dv.getUint32(4, true);
    if (version !== BAKE_VERSION) throw new Error(`bake index: version ${version}, runtime is ${BAKE_VERSION} — rebake`);

    const header = {
        version,
        fontSize: dv.getFloat64(8, true),
        worldScale: dv.getFloat64(16, true),
        lineHeight: dv.getFloat64(24, true),
        charSize: { width: dv.getFloat64(32, true), height: dv.getFloat64(40, true) },
        checkpointInterval: dv.getUint32(48, true),
        fileCount: dv.getUint32(52, true),
        metricsHash: [...buf.subarray(88, 96)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    };
    const censusCount = dv.getUint32(56, true);
    const censusOff = dv.getUint32(60, true);
    const recOff = dv.getUint32(64, true);
    const hashOff = dv.getUint32(68, true);
    const pathOff = dv.getUint32(72, true);
    const ckOff = dv.getUint32(76, true);
    const histOff = dv.getUint32(80, true);
    const total = dv.getUint32(84, true);
    if (total !== buf.byteLength) throw new Error(`bake index: header says ${total} bytes, file is ${buf.byteLength} — truncated?`);

    const base = buf.byteOffset;
    const census = new Uint32Array(buf.buffer, base + censusOff, censusCount);
    const recs = new Float64Array(buf.buffer, base + recOff, header.fileCount * REC_STRIDE);
    const cks = new Float64Array(buf.buffer, base + ckOff, (histOff - ckOff) / 8);
    const hists = new Uint32Array(buf.buffer, base + histOff, Math.floor((total - histOff) / 4));

    const dec = new TextDecoder();
    const paths = new Array(header.fileCount);
    const pathIndex = new Map();
    let at = pathOff;
    for (let i = 0; i < header.fileCount; i++) {
        const len = dv.getUint32(at, true);
        paths[i] = dec.decode(new Uint8Array(buf.buffer, base + at + 4, len));
        pathIndex.set(paths[i], i);
        at += 4 + len;
    }

    const recordAt = (i) => {
        const o = i * REC_STRIDE;
        const histIdx = recs[o + R_HIST_INDEX] * 2;
        const histCount = recs[o + R_HIST_COUNT];
        const lineHist = new Map();
        for (let h = 0; h < histCount; h++) lineHist.set(hists[histIdx + h * 2], hists[histIdx + h * 2 + 1]);
        const rows = recs[o + R_ROWS];
        const lh = header.lineHeight;
        return {
            byteLength: recs[o + R_BYTES],
            leaders: recs[o + R_LEADERS],
            newlines: recs[o + R_NEWLINES],
            totalRows: rows,
            rows,                                            // the consumer alias CodeGrid reads
            maxRowExtent: recs[o + R_MAX_ROW_EXTENT],
            maxLineWidth: recs[o + R_MAX_LINE_WIDTH],
            maxHeight: recs[o + R_MAX_HEIGHT],
            maxLineLen: recs[o + R_MAX_LINE_LEN],
            box: recs[o + R_LEADERS] > 0 ? {
                min: { x: 0, y: -(rows - 1) * lh, z: 0 },
                max: { x: recs[o + R_MAX_LINE_WIDTH], y: recs[o + R_BOX_MAX_Y], z: 0 },
            } : null,
            total: {
                reset: 0, wrap: 0,
                nl: recs[o + R_T_NL], glyphs: recs[o + R_T_GLYPHS], rows: recs[o + R_T_ROWS],
                headLen: recs[o + R_T_HEAD_LEN], tailLen: recs[o + R_T_TAIL_LEN], tailAdv: recs[o + R_T_TAIL_ADV],
            },
            checkpoints: cks.subarray(recs[o + R_CK_INDEX] * CK_STRIDE, (recs[o + R_CK_INDEX] + recs[o + R_CK_COUNT]) * CK_STRIDE),
            checkpointInterval: header.checkpointInterval,
            lineHist,
            lineHeight: lh,
        };
    };

    const hashAt = (i) => new Uint8Array(buf.buffer, base + hashOff + i * 32, 32);

    return { header, paths, pathIndex, census, recordAt, hashAt };
}
