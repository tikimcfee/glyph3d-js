/**
 * Driver: three layers of validation + memory accounting, over the corpus and a
 * few real files.   bun _experiments/glyph-encoding/run.js
 *
 *   1. source round-trip   — decodeSource(unpack(pack(encode(text)))) === text
 *   2. glyph fidelity      — expand(map) slot sequence === fresh chain shaping
 *   3. curve image         — rasterize both, pixel-diff must be 0; PNGs to out/
 *   + structural check     — render stream + cluster map agree on codepoint count
 *
 * Non-zero exit on any failure.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadAppEngine } from './shaper.js';
import { encode, pack, unpack, decodeSource, expandRender, sizes } from './codec.js';
import { shapeText } from '../../packages/glyph3d-core/src/shaping/shapeText.js';
import { renderToImage, diffImages } from './raster.js';
import { encodePNG } from './png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const INPUTS = [
  { label: 'torture.txt', path: join(HERE, 'corpus/torture.txt'), image: true },
  { label: 'sample.js', path: join(HERE, 'corpus/sample.js'), image: true },
  { label: 'HarfBuzzShaper.js', path: join(ROOT, 'packages/glyph3d-core/src/shaping/HarfBuzzShaper.js'), image: false },
  { label: 'GlyphField.js', path: join(ROOT, 'packages/glyph3d-core/src/GlyphField.js'), image: false },
];

const padR = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const pad = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));
const kb = (n) => (n / 1024).toFixed(1) + 'k';

const { chain, cache, resolve } = await loadAppEngine();
let failures = 0;
const rows = [];

function eqLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return false;
  }
  return true;
}

for (const input of INPUTS) {
  const text = readFileSync(input.path, 'utf8');
  const map = encode(text);
  const packed = pack(map);
  const map2 = unpack(packed); // round-trip through the actual bytes

  const checks = [];

  // 1. source round-trip
  const sourceOk = decodeSource(map2) === text;
  checks.push(['source', sourceOk]);

  // 2. glyph fidelity: map resolved via the live cache vs the app's own shaping
  const reconLines = expandRender(map2, resolve);
  const refLines = shapeText(cache, text).lines.map((l) => l.shaped.map((g) => g.g));
  const fidelityOk = eqLines(reconLines, refLines);
  checks.push(['glyphs', fidelityOk]);

  // structural: per-line render stream + cluster map agree on codepoint count
  const streamCps = map.lines.reduce((n, l) => n + l.length, 0);
  const clusterCps = map.clusters.reduce((n, line) => n + line.reduce((a, b) => a + b, 0), 0);
  const structOk = streamCps === clusterCps;
  checks.push(['struct', structOk]);

  // 3. curve image: rasterize both, diff
  let imgOk = true, diffPx = 0;
  if (input.image) {
    const refImg = renderToImage(chain, refLines);
    const reconImg = renderToImage(chain, reconLines);
    const d = diffImages(refImg, reconImg);
    diffPx = d.diff;
    imgOk = diffPx === 0;
    const base = input.label.replace(/\W+/g, '_');
    writeFileSync(join(OUT, base + '.reference.png'), encodePNG(refImg.width, refImg.height, 1, refImg.data));
    writeFileSync(join(OUT, base + '.reconstructed.png'), encodePNG(reconImg.width, reconImg.height, 1, reconImg.data));
    writeFileSync(join(OUT, base + '.diff.png'), encodePNG(d.image.width, d.image.height, 3, d.image.data));
    checks.push(['image', imgOk]);
  }

  for (const [name, ok] of checks) {
    if (!ok) {
      failures++;
      console.error(`✗ ${input.label}: ${name} check FAILED` + (name === 'image' ? ` (${diffPx} px differ)` : ''));
    }
  }

  rows.push({ label: input.label, ...sizes(text, map, packed), allOk: checks.every(([, ok]) => ok), img: input.image });
}

// ── report ──
const H = [padR('file', 18), pad('glyphs', 8), pad('distinct', 9), pad('utf8', 8),
  pad('cur@40B', 9), pad('map', 8), pad('map(bits)', 10), pad('cur/map', 8), pad('ok', 4)].join(' ');
console.log('\n' + H);
console.log('-'.repeat(H.length));
const tot = { glyphs: 0, utf8: 0, current: 0, mapBytes: 0, mapBytesPacked: 0 };
for (const r of rows) {
  console.log([padR(r.label, 18), pad(r.glyphs, 8), pad(r.distinct, 9), pad(kb(r.utf8), 8),
    pad(kb(r.current), 9), pad(kb(r.mapBytes), 8), pad(kb(r.mapBytesPacked), 10),
    pad((r.current / r.mapBytes).toFixed(1) + '×', 8), pad(r.allOk ? 'ok' : 'FAIL', 4)].join(' '));
  tot.glyphs += r.glyphs; tot.utf8 += r.utf8; tot.current += r.current;
  tot.mapBytes += r.mapBytes; tot.mapBytesPacked += r.mapBytesPacked;
}
console.log('-'.repeat(H.length));
console.log([padR('TOTAL', 18), pad(tot.glyphs, 8), pad('', 9), pad(kb(tot.utf8), 8),
  pad(kb(tot.current), 9), pad(kb(tot.mapBytes), 8), pad(kb(tot.mapBytesPacked), 10),
  pad((tot.current / tot.mapBytes).toFixed(1) + '×', 8), pad('', 4)].join(' '));
console.log(`\nimages → ${OUT}  (reference / reconstructed / diff)\n`);

chain.destroy();

if (failures > 0) { console.error(`${failures} check failure(s).`); process.exit(1); }
console.log('All checks pass: source byte-exact, glyph slots match, curves pixel-identical. ✓');
