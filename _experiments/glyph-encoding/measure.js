/**
 * Real measurement — no mock baselines. Runs the ACTUAL buildBatchBuffers from
 * @glyph3d/core on real files and measures the typed arrays it really produces,
 * then proves the map drives that SAME real builder to byte-identical output.
 *
 * Replaces the theoretical `glyphs × 40` with the real GPU-instance buffer size,
 * and the theoretical map size with the real packed byte length.
 *
 *   bun _experiments/glyph-encoding/measure.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadAppEngine } from './shaper.js';
import { encode, pack, unpack } from './codec.js';
import { shapeText } from '../../packages/glyph3d-core/src/shaping/shapeText.js';
import { buildBatchBuffers, DEFAULT_LAYOUT } from '../../packages/glyph3d-core/src/workers/builders/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

const { chain, cache } = await loadAppEngine();

// Values don't affect output buffer SIZES (those are glyph-count driven); they
// only need to be sane so the real builder runs.
const metrics = { charWidth: 24, charHeight: 48, lineSpacing: 56, worldScale: 0.025, pixelWidth: 48, pixelHeight: 48 };
const defaultColor = { r: 0, g: 1, b: 0 };
// Flat layout: buffer SIZES are glyph-count driven (layout-independent), and a
// no-wrap/no-paginate layout keeps positions as clean real numbers. (Paginated
// DEFAULT_LAYOUT + placeholder metrics yields NaN positions — identical in both
// builds, but noise for this measurement.)
const layout = { ...DEFAULT_LAYOUT, wrapWidth: 0, zWrapSpacing: 0, pageHeight: 1e9, pagesWide: 1 };
const shared = { metrics, defaultColor, upem: chain.upem, layout, scrollOffset: 0 };

const buildReal = (shaped) =>
  buildBatchBuffers([{ text: '', position: { x: 0, y: 0, z: 0 }, color: defaultColor, scale: 1, groupId: 0, shaped }], shared);

// Map → the builder's `shaped` input, resolving cp→slot via the live cache.
const mapToShaped = (map) => {
  const lines = map.lines.map((line) => ({
    text: '',
    shaped: line.map((i) => { const e = cache.lookup(map.dict[i].cp); return { g: e.g, ax: e.ax, dx: 0, dy: 0 }; }),
  }));
  return { lines, totalGlyphs: lines.reduce((n, l) => n + l.shaped.length, 0) };
};

// The five arrays that become GPU InstancedBufferAttributes (positions 3 + sizes
// 2 + glyphIds 1 + colors 3 + groupIds 1 = 10 floats = 40 B/glyph). `codepoints`
// is also produced but isn't uploaded as a GPU attribute.
const gpuBytes = (b) => b.positions.byteLength + b.sizes.byteLength + b.glyphIds.byteLength + b.colors.byteLength + b.groupIds.byteLength;
// NaN-aware: identical NaN at the same index is identical (deterministic) output.
const eq = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false; return true; };
const sameBuffers = (x, y) =>
  x.count === y.count && eq(x.positions, y.positions) && eq(x.sizes, y.sizes) &&
  eq(x.glyphIds, y.glyphIds) && eq(x.codepoints, y.codepoints) && eq(x.colors, y.colors) && eq(x.groupIds, y.groupIds);

const FILES = [
  { label: 'sample.js', path: join(HERE, 'corpus/sample.js') },
  { label: 'HarfBuzzShaper.js', path: join(ROOT, 'packages/glyph3d-core/src/shaping/HarfBuzzShaper.js') },
  { label: 'GlyphField.js', path: join(ROOT, 'packages/glyph3d-core/src/GlyphField.js') },
  { label: 'CodeGrid.js', path: join(ROOT, 'packages/glyph3d-core/src/collections/CodeGrid.js') },
];

const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const padL = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));
const kb = (n) => (n / 1024).toFixed(1) + 'k';

console.log('\n' + pad('file', 20) + padL('glyphs', 8) + padL('real GPU buf', 13) + padL('B/glyph', 9) + padL('real map', 10) + padL('GPU/map', 9) + padL('map==real', 10));
console.log('-'.repeat(79));

let failures = 0;
for (const f of FILES) {
  const text = readFileSync(f.path, 'utf8');

  const bRef = buildReal(shapeText(cache, text));            // real builder, text → buffers
  const map = unpack(pack(encode(text)));                     // map through real packed bytes
  const bMap = buildReal(mapToShaped(map));                   // real builder, map → buffers

  const identical = sameBuffers(bRef, bMap);
  if (!identical) failures++;

  const gpu = gpuBytes(bRef);
  const mapBytes = pack(map).length;
  console.log(pad(f.label, 20) + padL(bRef.count, 8) + padL(kb(gpu), 13) +
    padL((gpu / bRef.count).toFixed(0), 9) + padL(kb(mapBytes), 10) +
    padL((gpu / mapBytes).toFixed(1) + '×', 9) + padL(identical ? 'identical' : 'DIFFER', 10));
}

chain.destroy();
console.log('\nreal GPU buf = actual byteLength of the 5 GPU instance arrays from the real buildBatchBuffers.');
console.log('map==real    = the map drives the SAME real builder to byte-identical output (no mock).');
if (failures) { console.error(`\n${failures} file(s): map-driven build DIFFERS from text-driven.`); process.exit(1); }
console.log('\nReal core builder, fed the map, produces byte-identical instance buffers. ✓');
