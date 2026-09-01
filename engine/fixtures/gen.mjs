/**
 * gen.mjs — conformance fixture generator: the JS oracle's answers, serialized.
 *
 * Runs `runPipeline` (glyphPipelineReference — the semantic oracle) over a corpus
 * that hits every precision cliff the spec documents, and dumps each case as one
 * self-contained little-endian binary: inputs (bytes, trie, item table) followed by
 * expected outputs (slots, ordinal map, misses, leaders, per-item + batch bounds).
 *
 * The native engine's conformance runner (engine/conformance.mojo) replays the
 * inputs through its own port and diffs bit-for-bit. Floats are compared as bit
 * patterns, not tolerances: the oracle is deterministic and the port is required to
 * reproduce its exact f32/f64 rounding discipline — a tolerance would hide exactly
 * the class of bug (grouping-dependent float drift) this rig exists to catch.
 *
 * Format (all little-endian, packed, no alignment):
 *   u32 magic 'G3DF' (0x46443347)   u32 version=3
 *
 * v2 CARRIER NOTE: float payloads (trie blocks, slots) are stored as f64 VALUES,
 * not as the buffer's current representation. f64 holds every f32 exactly (and
 * every u32, with 2^53 headroom), so the corpus survives a change of slot-lane
 * representation without regenerating. Which lanes are counts and which are
 * genuine floats is a property of the PIPELINE, so it lives in the differ, not
 * in this file. v1 stored raw f32 bits and was hostage to the buffer's type.
 *   u32 byteLen  u32 itemCount  u32 blockIndexLen  u32 blocksFloatLen
 *   u8[byteLen] bytes
 *   u32[blockIndexLen] blockIndex
 *   f64[blocksFloatLen] blocks   (VALUES, per the carrier note above — this
 *       line said f32 until 2026-09-01, a v1 leftover contradicting the note
 *       four lines above it and the writer that has always emitted f64)
 *   itemCount × item record:
 *     u32 byteStart  u32 byteCount
 *     f64 originX originY originZ
 *     f64 wrapWidth  f64 zStep  f64 lineHeight (NaN = unset)
 *     f64 hasPage (0|1)
 *     f64 pageRows pageCols scrollRows pagesWide pageGapX bandStrideY
 *         depthPerBand depthPerColumn
 *     f64 pageLineHeight (NaN = unset)
 *   u32 leaders
 *   u32 missCount  u32[missCount] misses (codepoints, byte order, dups kept)
 *   u32[byteLen] ordToByte
 *   f64[byteLen*8] measures  (VALUES — X Y Z ADVANCE HEIGHT GLYPH_ID BASE_X LINE_ADV)
 *   u32[byteLen*4] counts    (EXACT   — ROW COL FLAGS ORD)
 *   itemCount × f64[8] item bounds row (minX minY minZ maxX maxY maxZ totalRows
 *     maxRowExtent; an item with no leaders is +inf/+inf/+inf/-inf/-inf/-inf/0/0)
 *   f64[8] batch bounds row (same shape/sentinel)
 *
 * Run: bun engine/fixtures/gen.mjs   (writes *.pipe.bin beside this file)
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, mBase, eBase, slotCount,
    E_GLYPH_ID, M_ADVANCE, M_HEIGHT, M_X, M_Y, M_Z,
    E_ROW, E_COL, E_FLAGS, M_BASE_X, M_LINE_ADV, E_ORD,
} from '../../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import { FIXTURE_MEASURE_STRIDE as MEASURE_STRIDE, FIXTURE_COUNT_STRIDE as COUNT_STRIDE } from '../glyph_schema.mjs';
import { buildGlyphTrie, trieWireValue, trieWireLength } from '../../packages/glyph3d-core/src/compute/GlyphTrie.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const utf8 = (s) => new TextEncoder().encode(s);

// ── Trie: synthetic metrics with awkward f32 mantissas, so every advance-sum
//    exercises real rounding. '@' is deliberately unmapped (the F_MISSING path);
//    emoji advance is doubled (the "x is a lookup, not a multiply" case).
const MISSING_ADVANCE = Math.fround(0.61);
const MISSING_HEIGHT = Math.fround(1.25);
function metricsFor(cp) {
    if (cp === 0x40 /* '@' */) return null;
    const emoji = cp >= 0x1F300;
    const advance = Math.fround((0.6 + (cp % 13) * 0.0173) * (emoji ? 2 : 1));
    const height = Math.fround(1.2 + (cp % 7) * 0.031);
    return { glyphId: (cp % 4093) + 1, advance, height };
}
function buildTrieFor(bytesList) {
    const cps = new Set();
    for (const bytes of bytesList) {
        for (const ch of new TextDecoder('utf-8', { fatal: false }).decode(bytes)) {
            cps.add(ch.codePointAt(0));
        }
    }
    cps.delete(0xFFFD);
    return buildGlyphTrie(cps, metricsFor, {
        missingAdvance: MISSING_ADVANCE, missingHeight: MISSING_HEIGHT,
    });
}

// ── The corpus ──────────────────────────────────────────────────────────────
const repoFile = readFileSync(
    join(HERE, '../../packages/glyph3d-core/src/core/foldGeometry.js'),
).subarray(0, 4096);

const longLine = 'const x = ' + 'ab(1, 2.5) + '.repeat(400) + '0;';

const malformed = new Uint8Array([
    0x61, 0x80, 0x80, 0xFF, 0x0A,             // stray continuations + invalid byte
    0xE2, 0x82,                                // truncated 3-byte sequence (€ minus a byte)
    0x62, 0xC3, 0x0A,                          // 2-byte leader whose continuation is \n
    0xF0, 0x9F, 0x9A, 0x80,                    // valid 🚀 to prove recovery
    0x63,
]);

const CASES = [
    {
        name: 'ascii-basic',
        bytes: utf8('hello world\nsecond line\n\nfourth line, longer than the rest'),
        items: [{ origin: { x: 1.5, y: 2.25, z: -3 }, lineHeight: 1.2 }],
    },
    {
        name: 'utf8-emoji',
        bytes: utf8('naïve café ☂ 🚀🌍 @mixed@\nsecond ✨ line\nüber-line 🎉 end\n'),
        items: [{ origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.3 }],
    },
    {
        name: 'wrap-exact',
        bytes: utf8('abcd\nabcdefgh\nab\nabcdefghijkl\n\nxy'),
        items: [{ origin: { x: -2, y: 4, z: 0.5 }, wrapWidth: 4, zStep: 0.25, lineHeight: 1.1 }],
    },
    {
        name: 'wrap-emoji',
        bytes: utf8('a🚀b🌍cdef\nxy✨z✨✨\n🎉🎉🎉🎉'),
        items: [{ origin: { x: 0, y: 0, z: 0 }, wrapWidth: 3, zStep: 0.4, lineHeight: 1.2 }],
    },
    {
        name: 'paged-rows',
        bytes: utf8(Array.from({ length: 40 }, (_, i) => `line ${i} of the paged body`).join('\n')),
        items: [{
            origin: { x: 0.5, y: -1, z: 2 }, lineHeight: 1.1,
            page: { pageRows: 6, pagesWide: 2, pageGapX: 0.8, bandStrideY: 9.5, depthPerBand: -2.5, scrollRows: 3, lineHeight: 1.1 },
        }],
    },
    {
        name: 'paged-cols',
        bytes: utf8('0123456789abcdefghij\nshort\nanother-long-line-here-with-cols\n'),
        items: [{
            origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.0,
            page: { pageCols: 8, depthPerColumn: 0.75, lineHeight: 1.0 },
        }],
    },
    {
        name: 'scroll-only',
        bytes: utf8(Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n')),
        items: [{ origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.3, page: { scrollRows: 5, lineHeight: 1.3 } }],
    },
    {
        name: 'long-line',
        bytes: utf8(longLine),
        items: [{ origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.0 }],
    },
    {
        name: 'malformed',
        bytes: malformed,
        items: [{ origin: { x: 1, y: 1, z: 1 }, lineHeight: 1.0 }],
    },
    {
        name: 'repo-file',
        bytes: new Uint8Array(repoFile),
        items: [{ origin: { x: 0, y: 0, z: 0 }, wrapWidth: 100, zStep: 0.1, lineHeight: 1.0 }],
    },
    // ── GNARLY REAL INPUTS. The constructed fixtures are polite: short lines,
    //    small counts, properties chosen one at a time. Real files are the fuzz
    //    tier — long files, long lines, mixed content — and a fixture is ~100x
    //    its source on disk (it carries every expected value in f64), so these
    //    are SLICES sized to keep the corpus checked-in-able, not whole trees.
    //    Whole-tree coverage is the oracle-free cross-form runner's job.
    {
        // A real production source file, WHOLE: 1,665 lines through the actual
        // oracle, wrapped AND paged at once — the co-occurrence the census
        // found missing from every polite fixture.
        name: 'real-kernels',
        bytes: new Uint8Array(readFileSync(
            join(HERE, '../../packages/glyph3d-core/src/compute/glyphPipelineKernels.js'))),
        items: [{
            origin: { x: 0, y: 0, z: 0 }, wrapWidth: 80, zStep: 0.25, lineHeight: 1.2,
            page: { rows: 40, pagesWide: 3, lineHeight: 1.2, gapX: 2 },
        }],
    },
    {
        // A REAL minified bundle slice, VENDORED: engine/fixtures/inputs/
        // minified-sample.js is 48KB of one-enormous-line JS (47 newlines in
        // 49,152 bytes), checked in and frozen. It began life as the app
        // bundle's first 48KB (index-GRwQWdWg.js) — a content-hashed dist/
        // artifact that was never tracked, so the day a rebuild replaced it,
        // this generator died with ENOENT and the fixture became permanently
        // unreproducible. The input was RECOVERED from the committed fixture
        // itself (format v2 carries the source bytes) and vendored 2026-08-31.
        // A fixture input must be TRACKED: an untracked input makes the
        // fixture a snapshot of an accident.
        //
        // Why this shape: wrap at 120 makes hundreds of visual rows from a
        // single source line — the exact shape rowsUnderWrap exists for and
        // no constructed fixture dared.
        name: 'real-minified',
        bytes: new Uint8Array(readFileSync(
            join(HERE, 'inputs/minified-sample.js'))),
        items: [{
            origin: { x: 0, y: 0, z: 0 }, wrapWidth: 120, zStep: 0.1, lineHeight: 1.0,
        }],
    },
    (() => {
        const a = utf8('item A\nplain text body\n');
        const b = utf8('item B wraps at five and steps in z 🚀🚀\nmore\n');
        const c = utf8(Array.from({ length: 20 }, (_, i) => `C line ${i}`).join('\n'));
        const bytes = new Uint8Array(a.length + b.length + c.length);
        bytes.set(a, 0); bytes.set(b, a.length); bytes.set(c, a.length + b.length);
        return {
            name: 'multi-item',
            bytes,
            items: [
                { byteStart: 0, byteCount: a.length, origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.2 },
                { byteStart: a.length, byteCount: b.length, origin: { x: 10, y: 0, z: -1 }, wrapWidth: 5, zStep: 0.3, lineHeight: 1.0 },
                {
                    byteStart: a.length + b.length, byteCount: c.length,
                    origin: { x: -8, y: 3, z: 0 }, lineHeight: 1.1,
                    page: { pageRows: 4, pagesWide: 3, pageGapX: 0.5, depthPerBand: -1.5, lineHeight: 1.1 },
                },
            ],
        };
    })(),
    (() => {
        const a = utf8('ab\n');
        const cont = new Uint8Array([0x80, 0x80, 0x80, 0x80]);   // leaderless item → null bounds
        const bytes = new Uint8Array(a.length + cont.length);
        bytes.set(a, 0); bytes.set(cont, a.length);
        return {
            name: 'cont-only-item',
            bytes,
            items: [
                { byteStart: 0, byteCount: a.length, origin: { x: 0, y: 0, z: 0 }, lineHeight: 1.0 },
                { byteStart: a.length, byteCount: cont.length, origin: { x: 5, y: 5, z: 5 }, lineHeight: 1.0 },
            ],
        };
    })(),
];


// The slot buffer is u32: COUNT lanes (E_ROW/E_COL/E_FLAGS/E_ORD) are stored
// natively, FLOAT lanes are bitcast. The corpus carries VALUES, so each lane is
// decoded by kind before it is written — otherwise a float lane serializes its
// BIT PATTERN as an f64 value and every fixture shifts while nothing semantic
// moved. E_GLYPH_ID is deferred (still a trie float), so it decodes as a float.
// FLOAT_LANES is imported — the lane kinds live in ONE place (the oracle).
// v3: the oracle still carries 12 mixed lanes in one u32 array; the SCHEMA says
// measures and counts are different buffers. Split here — the generator is the
// seam, exactly as it was for the f64 carrier in v2. Measures go out as f64
// VALUES (representation-independent); counts go out as exact u32.
// (container, lane) pairs, because the FIXTURE's measure block and this layer's measure
// ARRAY are not the same set: GLYPH_ID is written into the fixture's measure block (a
// frozen v2 format decision) while living in the exact array here. The wire order below
// is the format; where each value is read FROM is this layer's business. Keeping both
// facts in one table is what makes the corpus survive a container change untouched.
const MEASURE_FROM = [['m', M_X], ['m', M_Y], ['m', M_Z], ['m', M_ADVANCE],
    ['m', M_HEIGHT], ['x', E_GLYPH_ID], ['m', M_BASE_X], ['m', M_LINE_ADV]];
const COUNT_FROM = [E_ROW, E_COL, E_FLAGS, E_ORD];
if (MEASURE_FROM.length !== MEASURE_STRIDE || COUNT_FROM.length !== COUNT_STRIDE) {
    throw new Error(`fixture lane map disagrees with the schema (${MEASURE_FROM.length}/${MEASURE_STRIDE}, `
        + `${COUNT_FROM.length}/${COUNT_STRIDE}) — run bun tools/gen-schema.mjs`);
}
function writeSlotValues(w, slots) {
    const nb = slotCount(slots);
    for (let i = 0; i < nb; i++) {
        for (const [c, lane] of MEASURE_FROM) {
            w.f64(c === 'm' ? slots.m[mBase(i) + lane] : slots.x[eBase(i) + lane]);
        }
    }
    for (let i = 0; i < nb; i++) {
        for (const lane of COUNT_FROM) w.u32(slots.x[eBase(i) + lane]);
    }
}


// ── Binary writer ───────────────────────────────────────────────────────────
class Writer {
    constructor() { this.chunks = []; this.len = 0; }
    _push(buf) { this.chunks.push(new Uint8Array(buf)); this.len += buf.byteLength; }
    u32(v) { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v >>> 0, true); this._push(b.buffer); }
    f32(v) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); this._push(b.buffer); }
    f64(v) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); this._push(b.buffer); }
    bytes(arr) { this._push(arr.buffer ? arr.slice().buffer : arr); }
    u32array(arr) { for (const v of arr) this.u32(v); }
    f32array(arr) { for (const v of arr) this.f32(v); }
    f64array(arr) { for (const v of arr) this.f64(v); }
    done() {
        const out = new Uint8Array(this.len);
        let at = 0;
        for (const c of this.chunks) { out.set(c, at); at += c.length; }
        return out;
    }
}

const boundsRow = (b) => b === null
    ? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]
    : [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, b.totalRows, b.maxRowExtent];

mkdirSync(HERE, { recursive: true });
for (const c of CASES) {
    const items = c.items.map((it, i) => ({
        byteStart: it.byteStart ?? 0,
        byteCount: it.byteCount ?? c.bytes.length,
        ...it,
    }));
    const trie = buildTrieFor([c.bytes]);
    const r = runPipeline(c.bytes, trie, { items });

    const w = new Writer();
    w.u32(0x46443347); w.u32(3);
    w.u32(c.bytes.length); w.u32(items.length);
    w.u32(trie.blockIndex.length); w.u32(trieWireLength(trie));
    w.bytes(c.bytes);
    w.u32array(trie.blockIndex);
    // Per LANE, not raw: blocks are u32 with the measures BITCAST, so the raw word
    // for advance/height is a bit pattern, not a value. The format carries VALUES
    // precisely so a container change leaves the corpus untouched — decoding here
    // is what makes that true.
    for (let i = 0, n = trieWireLength(trie); i < n; i++) w.f64(trieWireValue(trie, i));
    for (const it of items) {
        w.u32(it.byteStart); w.u32(it.byteCount);
        w.f64(it.origin?.x || 0); w.f64(it.origin?.y || 0); w.f64(it.origin?.z || 0);
        w.f64(it.wrapWidth ?? 0); w.f64(it.zStep ?? 0); w.f64(it.lineHeight ?? NaN);
        const p = it.page;
        w.f64(p ? 1 : 0);
        w.f64(p?.pageRows || 0); w.f64(p?.pageCols || 0); w.f64(p?.scrollRows || 0);
        w.f64(p?.pagesWide || 0); w.f64(p?.pageGapX || 0); w.f64(p?.bandStrideY || 0);
        w.f64(p?.depthPerBand || 0); w.f64(p?.depthPerColumn || 0);
        w.f64(p?.lineHeight ?? NaN);
    }
    w.u32(r.leaders);
    w.u32(r.misses.length); w.u32array(r.misses);
    w.u32array(r.ordToByte);
    writeSlotValues(w, r.slots);
    for (const b of r.itemBounds) for (const v of boundsRow(b)) w.f64(v);
    for (const v of boundsRow(r.bounds)) w.f64(v);

    const path = join(HERE, `${c.name}.pipe.bin`);
    writeFileSync(path, w.done());
    console.log(`${c.name}: ${c.bytes.length} bytes, ${items.length} item(s), ` +
        `${r.leaders} leaders, ${r.misses.length} misses → ${w.len} B fixture`);
}
