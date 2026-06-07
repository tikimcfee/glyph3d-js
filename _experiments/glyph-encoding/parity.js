/**
 * Slot-identity parity — the integration gate, restated for the no-stored-slot design.
 *
 * The map stores CODEPOINTS, not slots. Slots are resolved live (cp → cache.lookup
 * → slot) the same way the renderer does. This proves on real code files:
 *   1. storing the raw slot is fragile — a differently-primed session's slots
 *      diverge ~100% (motivation for not persisting slots), and
 *   2. the map (codepoints) resolved through the app's live primed cache
 *      reproduces the app's slot stream EXACTLY (0 diff).
 *
 *   bun _experiments/glyph-encoding/parity.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadAppEngine, loadChain } from './shaper.js';
import { encode, expandRender } from './codec.js';
import { shapeText } from '../../packages/glyph3d-core/src/shaping/shapeText.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

const app = await loadAppEngine(); // primed cache — the renderer's real path
const bare = await loadChain();    // unprimed session — document-order slots

const FILES = [
  { label: 'sample.js', path: join(HERE, 'corpus/sample.js') },
  { label: 'HarfBuzzShaper.js', path: join(ROOT, 'packages/glyph3d-core/src/shaping/HarfBuzzShaper.js') },
  { label: 'GlyphField.js', path: join(ROOT, 'packages/glyph3d-core/src/GlyphField.js') },
  { label: 'CodeGrid.js', path: join(ROOT, 'packages/glyph3d-core/src/collections/CodeGrid.js') },
];

const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const padL = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));

console.log('\n' + pad('file', 20) + padL('glyphs', 9) + padL('raw-slot diff', 16) + padL('map-resolve diff', 18));
console.log('-'.repeat(63));

let failures = 0;
for (const f of FILES) {
  const text = readFileSync(f.path, 'utf8');
  const map = encode(text); // codepoints only — no slots stored

  // ground truth: the app's live builder input (primed cache → slots)
  const appLines = shapeText(app.cache, text).lines.map((l) => l.shaped.map((g) => g.g));
  // a different session shaping the same text (document-order slot allocation)
  const bareLines = text.split('\n').map((line) => bare.shape(line).map((g) => g.g));
  // the chosen design: map codepoints resolved through the app's live cache
  const reconLines = expandRender(map, app.resolve);

  let glyphs = 0, rawDiff = 0, mapDiff = 0;
  for (let li = 0; li < appLines.length; li++) {
    for (let j = 0; j < appLines[li].length; j++) {
      glyphs++;
      if (appLines[li][j] !== bareLines[li][j]) rawDiff++;
      if (appLines[li][j] !== reconLines[li][j]) mapDiff++;
    }
  }
  if (mapDiff !== 0) failures++;
  const pct = glyphs ? ((rawDiff / glyphs) * 100).toFixed(0) : '0';
  console.log(pad(f.label, 20) + padL(glyphs, 9) +
    padL(`${rawDiff} (${pct}%)`, 16) + padL(mapDiff === 0 ? '0 [OK]' : `${mapDiff} FAIL`, 18));
}

app.chain.destroy();
bare.destroy();

console.log('\nraw-slot diff   = storing the slot directly breaks across sessions.');
console.log('map-resolve diff = map(codepoints) + live cache reproduces app slots exactly.');
if (failures) { console.error(`\n${failures} file(s) failed map-resolve parity.`); process.exit(1); }
console.log('\nGATE: codepoint map + live resolve = byte-for-byte slot parity with the app. ✓');
