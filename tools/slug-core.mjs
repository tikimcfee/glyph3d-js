#!/usr/bin/env bun
/**
 * slug-core.mjs — idempotency + round-trip harness for SlugBuffer serialization.
 *
 *   bun tools/slug-core.mjs
 *
 * This is the FOUNDATION test for the prebaked slug-core (serialize → ship → boot
 * hydrates instead of re-encoding). It is deliberately PURE and HEADLESS: a fake
 * deterministic shaper drives the real `addGlyphs` path, so there's no HarfBuzz
 * WASM, no canvas, no font fetch — it runs anywhere and is safe to gate CI on.
 *
 * What it proves (the teeth — a serialization test is vacuous without byte-equality):
 *   1. Round-trip       deserialize(serialize(buf)) reproduces the exact textures.
 *   2. Texture bytes    curve + glyph-map texture data are identical post-hydrate.
 *   3. Determinism      encoding the same glyphs twice serializes byte-identically.
 *   4. Idempotency      serialize ∘ deserialize ∘ serialize is a fixed point.
 *   5. Empty-glyph      an encoded-but-EMPTY glyph survives (the reason `_encoded`
 *                       is stored explicitly, not reconstructed from the sparse map).
 *   6. Live after load  a hydrated buffer keeps growing via addGlyphs.
 *   7. Validation       a tampered / wrong-version descriptor is REJECTED (throws),
 *                       so the cache layer can catch → fall back to live encode.
 *   8. Empty buffer     the zero-glyph edge round-trips.
 *
 * Realistic full-core validation (the actual LARGE_CORE through a real FontChain +
 * blob size) is a separate probe against the live app — this harness owns the
 * algebra, not the font.
 */

import { SlugBuffer, SLUG_BUFFER_FORMAT } from '../packages/glyph3d-core/src/shaping/slugData.js';
import { TEXTURE_WIDTH } from '../packages/glyph3d-core/src/shaping/slug-constants.js';

// ── fake shaper ────────────────────────────────────────────────────────────
// Deterministic outlines: id%7===0 → EMPTY (the critical encoded-but-blank case);
// FAT_ID → ~600 curves (forces the curve texture past one 1024-texel row, so the
// row-alignment of multi-row data is exercised); everything else → a small varied
// quadratic blob keyed by id. No randomness → byte-stable across runs.
const FAT_ID = 1024;
const fakeShaper = {
    upem: 2048,
    isBitmapSlot() { return false; },
    glyphAdvance(id) { return 1024 + (id % 3) * 128; },
    fontExtents() { return { ascender: 1638, descender: -410 }; },
    glyphName(id) { return `g${id}`; },
    glyphOutline(id) {
        if (id % 7 === 0) return [];                         // encoded-but-empty
        const n = id === FAT_ID ? 600 : (id % 5) + 1;
        const segs = [{ type: 'M', values: [0, 0] }];
        for (let k = 0; k < n; k++) {
            const a = (id * 13 + k * 7) % 1000;
            const b = (id * 29 + k * 11) % 1000;
            segs.push({ type: 'Q', values: [a, b, (a + b) % 1000, (a * 2) % 1000] });
        }
        segs.push({ type: 'Z', values: [] });
        return segs;
    },
};

// A sparse, multi-row id set: small ids, a row-boundary cluster (1023/1024/1025),
// the fat glyph, and a high id (1500 → glyph-map spans 2 rows). Several id%7 empties.
const IDS = [
    ...Array.from({ length: 20 }, (_, i) => i + 1),
    100, 101, 105, 200, 343, 500, 700, 1023, FAT_ID, 1025, 1500,
];

// ── assert framework ─────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, msg) => {
    if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
    else { fail++; console.log(`  \x1b[31m✗ ${msg}\x1b[0m`); }
};
const eqU32 = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};
const eqSet = (s, arr) => s.size === arr.length && arr.every((x) => s.has(x));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const build = (ids) => { const b = new SlugBuffer(); b.addGlyphs(fakeShaper, ids); return b; };

// ── 1+2. round-trip + texture-byte equality ──────────────────────────────────
console.log('\n[1/2] round-trip + texture-byte equality');
const buf1 = build(IDS);
const d = buf1.serialize();
const buf2 = SlugBuffer.deserialize(d);

ok(d.v === SLUG_BUFFER_FORMAT, `descriptor format version is ${SLUG_BUFFER_FORMAT}`);
ok(buf2._curveCount === buf1._curveCount, `curveCount preserved (${buf1._curveCount})`);
ok(buf2._maxGlyphId === buf1._maxGlyphId, `maxGlyphId preserved (${buf1._maxGlyphId})`);
ok(eqSet(buf2._encoded, [...buf1._encoded]), `encoded set preserved (${buf1.size} glyphs)`);
ok(eqU32(buf1.curveTexture().data, buf2.curveTexture().data), 'curve texture bytes identical');
ok(eqU32(buf1.glyphMapTexture().data, buf2.glyphMapTexture().data), 'glyph-map texture bytes identical');
const cT = buf1.curveTexture(), gT = buf1.glyphMapTexture();
ok(cT.height >= 2, `curve texture spans multiple rows (${cT.height} rows — fat glyph exercised)`);
ok(gT.height >= 2, `glyph-map spans multiple rows (${gT.height} rows — high id exercised)`);

// ── 3. determinism ───────────────────────────────────────────────────────────
console.log('\n[3] determinism — same glyphs encode byte-identically');
const d3 = build(IDS).serialize();
ok(eqU32(d.curve, d3.curve) && eqU32(d.map, d3.map) && eqU32(d.encodedIds, d3.encodedIds)
   && d.curveCount === d3.curveCount && d.maxGlyphId === d3.maxGlyphId,
   'a fresh encode of the same ids serializes byte-identically');

// ── 4. idempotency (serialize ∘ deserialize is a fixed point) ─────────────────
console.log('\n[4] idempotency — serialize ∘ deserialize ∘ serialize');
const d2 = buf2.serialize();
ok(eqU32(d.curve, d2.curve) && eqU32(d.map, d2.map) && eqU32(d.encodedIds, d2.encodedIds),
   'round-tripped buffer re-serializes to the same bytes');

// ── 5. empty-glyph survival (why _encoded is explicit) ───────────────────────
console.log('\n[5] empty-glyph survival');
const emptyId = IDS.find((id) => id % 7 === 0);
ok(emptyId !== undefined, `test set contains an empty glyph (id ${emptyId})`);
ok(buf1._encoded.has(emptyId), `original encodes the empty glyph ${emptyId}`);
ok([...d.encodedIds].includes(emptyId), 'empty glyph id is in the serialized encodedIds');
ok(buf2._encoded.has(emptyId), 'empty glyph SURVIVES the round-trip (would be lost if rebuilt from the map)');
ok(buf2.glyphMapTexture().data[emptyId * 4 + 1] === 0, 'empty glyph map entry has curveCount 0 (sparse-slot collision case)');

// ── 6. live after load ───────────────────────────────────────────────────────
console.log('\n[6] hydrated buffer stays live');
const before = buf2.size;
const grow = buf2.addGlyphs(fakeShaper, [9991, 9992]);
ok(grow.added === 2 && buf2.size === before + 2, `addGlyphs grows a hydrated buffer (+${grow.added})`);
ok(buf2.has(9991) && buf2.has(9992), 'newly grown glyphs are present');
ok(!throws(() => buf2.serialize()), 're-serializes cleanly after growth');

// ── 7. validation rejects garbage ────────────────────────────────────────────
console.log('\n[7] validation rejects bad descriptors');
ok(throws(() => SlugBuffer.deserialize({ ...d, v: 999 })), 'wrong format version → throws');
ok(throws(() => SlugBuffer.deserialize({ ...d, curve: d.curve.slice(0, d.curve.length - 4) })), 'truncated curve array → throws');
ok(throws(() => SlugBuffer.deserialize({ ...d, maxGlyphId: d.maxGlyphId + TEXTURE_WIDTH })), 'maxGlyphId inconsistent with map length → throws');
ok(throws(() => SlugBuffer.deserialize({ ...d, encodedIds: [...d.encodedIds] })), 'plain-array encodedIds (not Uint32Array) → throws');

// ── 8. empty buffer edge ─────────────────────────────────────────────────────
console.log('\n[8] empty buffer edge');
const e0 = new SlugBuffer();
const de = e0.serialize();
const e1 = SlugBuffer.deserialize(de);
ok(e1.size === 0 && e1._maxGlyphId === -1 && e1._curveCount === 0, 'zero-glyph buffer round-trips');
ok(eqU32(e0.curveTexture().data, e1.curveTexture().data) && eqU32(e0.glyphMapTexture().data, e1.glyphMapTexture().data),
   'empty textures identical');

// ── blob size report ─────────────────────────────────────────────────────────
const rawBytes = (d.curve.length + d.map.length + d.encodedIds.length) * 4;
console.log(`\n  snapshot: ${buf1.size} glyphs · ${buf1.totalCurves} curves · ` +
    `${(rawBytes / 1024).toFixed(1)} KB raw (curve ${(d.curve.length * 4 / 1024).toFixed(1)}KB + ` +
    `map ${(d.map.length * 4 / 1024).toFixed(1)}KB + ids ${(d.encodedIds.length * 4 / 1024).toFixed(1)}KB)`);

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
