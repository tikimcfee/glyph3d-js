/**
 * gen-bake.mjs — bake fixtures: the seed protocol, serialized from the JS oracle.
 *
 * Dumps `bakeFile`'s complete record (totals, checkpoints, scalars, box, line
 * histogram, census/missing) plus QUERY answers that exercise the seed-and-fold
 * contract the state split ships to clients:
 *   - prefixAt: checkpoint-seeded random access to the exclusive prefix of a byte
 *   - lanesFromPrefix: the O(1) row/col/ord/lineAdv derivation at a given wrap
 *   - rowsUnderWrap: exact visual rows under arbitrary wrap, from the histogram
 *
 * Format 'G3DB' v1 (little-endian, packed):
 *   u32 magic 0x42443347  u32 version=2   (v2: trie blocks are f64 VALUES — see gen.mjs)
 *   u32 byteLen  u32 blockIndexLen  u32 blocksFloatLen
 *   f64 lineHeight  u32 checkpointInterval
 *   u8[byteLen] bytes   u32[] blockIndex   f32[] blocks
 *   expected record:
 *     u32 leaders  u32 newlines  u32 totalRows  u32 maxLineLen
 *     f64 maxRowExtent  f64 maxLineWidth  f64 maxHeight
 *     u32 hasBox  f64[6] box (minXYZ maxXYZ; zeros when hasBox=0)
 *     f64[7] total (reset nl glyphs rows headLen tailLen tailAdv)
 *     u32 ckCount  f64[ckCount*6] checkpoints
 *     u32 histCount  histCount × (u32 len, u32 count) sorted by len
 *     u32 censusCount  u32[] census (sorted)
 *     u32 missingCount  u32[] missing (sorted)
 *   queries:
 *     u32 prefixQueryCount × { u32 byteIndex, u32 wrap,
 *       f64[7] prefix (reset nl glyphs rows headLen tailLen tailAdv),
 *       u32 row, u32 col, u32 ord, f64 lineAdv }
 *     u32 wrapQueryCount × { u32 wrap, u32 rows }
 *
 * Run: bun engine/fixtures/gen-bake.mjs   (writes *.bake.bin beside this file)
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFile, prefixAt, rowsUnderWrap, CK_STRIDE } from '../../packages/glyph3d-core/src/compute/glyphBake.js';
import { lanesFromPrefix } from '../../packages/glyph3d-core/src/compute/glyphPipelineScan.js';
import { buildGlyphTrie, trieWireValue, trieWireLength } from '../../packages/glyph3d-core/src/compute/GlyphTrie.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const utf8 = (s) => new TextEncoder().encode(s);

// Same synthetic metrics as gen.mjs — one trie discipline across both rigs.
const MISSING_ADVANCE = Math.fround(0.61);
const MISSING_HEIGHT = Math.fround(1.25);
function metricsFor(cp) {
    if (cp === 0x40 /* '@' */) return null;
    const emoji = cp >= 0x1F300;
    const advance = Math.fround((0.6 + (cp % 13) * 0.0173) * (emoji ? 2 : 1));
    const height = Math.fround(1.2 + (cp % 7) * 0.031);
    return { glyphId: (cp % 4093) + 1, advance, height };
}
function buildTrieFor(bytes) {
    const cps = new Set();
    for (const ch of new TextDecoder('utf-8', { fatal: false }).decode(bytes)) {
        cps.add(ch.codePointAt(0));
    }
    cps.delete(0xFFFD);
    return buildGlyphTrie(cps, metricsFor, {
        missingAdvance: MISSING_ADVANCE, missingHeight: MISSING_HEIGHT,
    });
}

const repoFile = readFileSync(
    join(HERE, '../../packages/glyph3d-core/src/compute/glyphPipelineScan.js'),
);

const CASES = [
    { name: 'bake-repo-file', bytes: new Uint8Array(repoFile), lineHeight: 1.2, interval: 4096 },
    { name: 'bake-repo-small-k', bytes: new Uint8Array(repoFile.subarray(0, 9000)), lineHeight: 1.0, interval: 64 },
    { name: 'bake-emoji-missing', bytes: utf8('naïve @ café 🚀\n@@@\n✨ tail without newline'), lineHeight: 1.3, interval: 8 },
    { name: 'bake-empty', bytes: new Uint8Array(0), lineHeight: 1.0, interval: 4096 },
    { name: 'bake-one-line-no-nl', bytes: utf8('just one open line, no newline at all'), lineHeight: 1.1, interval: 16 },
    { name: 'bake-newlines-only', bytes: utf8('\n\n\n\n\n'), lineHeight: 1.0, interval: 2 },
    { name: 'bake-cont-at-zero', bytes: new Uint8Array([0x80, 0x80, 0x61, 0x0A, 0x62]), lineHeight: 1.0, interval: 2 },
    { name: 'bake-long-line', bytes: utf8('x'.repeat(3000) + '\nshort\n' + 'y'.repeat(500)), lineHeight: 1.0, interval: 256 },
];

class Writer {
    constructor() { this.chunks = []; this.len = 0; }
    _push(buf) { this.chunks.push(new Uint8Array(buf)); this.len += buf.byteLength; }
    u32(v) { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v >>> 0, true); this._push(b.buffer); }
    f32(v) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); this._push(b.buffer); }
    f64(v) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); this._push(b.buffer); }
    bytes(arr) { this._push(arr.slice().buffer); }
    done() {
        const out = new Uint8Array(this.len);
        let at = 0;
        for (const c of this.chunks) { out.set(c, at); at += c.length; }
        return out;
    }
}

const elem7 = (e) => [e.reset, e.nl, e.glyphs, e.rows, e.headLen, e.tailLen, e.tailAdv];

for (const c of CASES) {
    const trie = buildTrieFor(c.bytes);
    const r = bakeFile(c.bytes, trie, { lineHeight: c.lineHeight, checkpointInterval: c.interval });

    const n = c.bytes.length;
    const K = c.interval;
    // Query byte indexes: identity edge, checkpoint boundaries ±1, mids, the end.
    const qBytes = [...new Set([
        0, 1, Math.min(3, n), K - 1, K, K + 1, 2 * K, (2 * K) + 7,
        Math.floor(n / 2), Math.max(0, n - 1), n,
    ].filter((b) => b >= 0 && b <= n))].sort((a, b) => a - b);
    const qWraps = [0, 3, 80];
    const prefixQueries = [];
    for (const b of qBytes) {
        for (const wrap of qWraps) {
            const P = prefixAt(c.bytes, trie, r, b);
            const lanes = lanesFromPrefix(P, wrap);
            prefixQueries.push({ byteIndex: b, wrap, prefix: elem7(P), lanes });
        }
    }
    const wrapQueries = [0, 1, 2, 3, 5, 40, 80, 100].map((wrap) => ({
        wrap, rows: rowsUnderWrap(r, wrap),
    }));

    const w = new Writer();
    w.u32(0x42443347); w.u32(2);
    w.u32(n); w.u32(trie.blockIndex.length); w.u32(trieWireLength(trie));
    w.f64(c.lineHeight); w.u32(K);
    w.bytes(c.bytes);
    for (const v of trie.blockIndex) w.u32(v);
    // Per LANE in WIRE order, never raw. The format carries VALUES precisely so a
    // container change leaves the corpus untouched — and it has now survived three of
    // them. trieWireValue is the single place the wire order lives.
    for (let i = 0, tn = trieWireLength(trie); i < tn; i++) w.f64(trieWireValue(trie, i));

    w.u32(r.leaders); w.u32(r.newlines); w.u32(r.totalRows); w.u32(r.maxLineLen);
    w.f64(r.maxRowExtent); w.f64(r.maxLineWidth); w.f64(r.maxHeight);
    w.u32(r.box ? 1 : 0);
    const box = r.box ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    w.f64(box.min.x); w.f64(box.min.y); w.f64(box.min.z);
    w.f64(box.max.x); w.f64(box.max.y); w.f64(box.max.z);
    for (const v of elem7(r.total)) w.f64(v);
    const ckCount = r.checkpoints.length / CK_STRIDE;
    w.u32(ckCount);
    for (const v of r.checkpoints) w.f64(v);
    const hist = [...r.lineHist.entries()].sort((a, b) => a[0] - b[0]);
    w.u32(hist.length);
    for (const [len, count] of hist) { w.u32(len); w.u32(count); }
    w.u32(r.census.length);
    for (const v of r.census) w.u32(v);
    w.u32(r.missing.length);
    for (const v of r.missing) w.u32(v);

    w.u32(prefixQueries.length);
    for (const q of prefixQueries) {
        w.u32(q.byteIndex); w.u32(q.wrap);
        for (const v of q.prefix) w.f64(v);
        w.u32(q.lanes.row); w.u32(q.lanes.col); w.u32(q.lanes.ord);
        w.f64(q.lanes.lineAdv);
    }
    w.u32(wrapQueries.length);
    for (const q of wrapQueries) { w.u32(q.wrap); w.u32(q.rows); }

    writeFileSync(join(HERE, `${c.name}.bake.bin`), w.done());
    console.log(`${c.name}: ${n} bytes, ${r.leaders} leaders, ${ckCount} checkpoints, ` +
        `${hist.length} hist bins, ${prefixQueries.length} prefix queries → ${w.len} B`);
}
