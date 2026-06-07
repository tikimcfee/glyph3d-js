/**
 * Slot-identity parity test — the integration gate.
 *
 * The app draws with FontChain SLOTS, and slots are allocated densely on
 * first-use. The app pre-allocates them by PRIMING a MonospaceShapeCache with
 * fixed ranges (glyphEngine DEFAULT_ENGINE_OPTIONS) before any document, so its
 * slot numbering is fixed by the prime order. A map that stores raw slots from a
 * differently-ordered session will NOT match the app's glyph-map texture.
 *
 * This proves two things on real code files:
 *   1. raw slots DIVERGE across sessions (storing `slot` is fragile)
 *   2. storing the STABLE (fontIdx, gid) and remapping via the live chain's
 *      slotFor() reproduces the app's slots EXACTLY (the integration-safe design)
 *
 *   bun _experiments/glyph-encoding/parity.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FONT_SPECS } from './shaper.js'; // side effect: installs the file:// fetch shim
import FontChain from '../../packages/glyph3d-core/src/shaping/FontChain.js';
import MonospaceShapeCache from '../../packages/glyph3d-core/src/shaping/MonospaceShapeCache.js';
import { shapeText } from '../../packages/glyph3d-core/src/shaping/shapeText.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

// Mirror of glyphEngine.js DEFAULT_ENGINE_OPTIONS.primeRanges (ASCII + Latin-1 +
// box-drawing). The app primes the shape cache with exactly these before render.
const PRIME_RANGES = [[0x20, 0x7e], [0xa0, 0xff], [0x2500, 0x257f]];
const codepointsFromRanges = (ranges) => {
  let s = '';
  for (const [lo, hi] of ranges) for (let cp = lo; cp <= hi; cp++) s += String.fromCodePoint(cp);
  return s;
};

/** Build a FontChain the way the app does (optionally primed). */
async function buildChain(primed) {
  const chain = new FontChain();
  await chain.init(FONT_SPECS);
  let cache = null;
  if (primed) { cache = new MonospaceShapeCache(chain); cache.prime(codepointsFromRanges(PRIME_RANGES)); }
  return { chain, cache };
}

/** slot → stable (fontIdx, gid) via the chain's slot table. */
const resolve = (chain, slot) => chain._slotMeta[slot] || { fontIdx: -1, gid: 0 };

// The APP replica: primed cache, slots via shapeText(cache, ...) — exactly the
// live builder input.   The OTHER session: a fresh chain, document-order slots.
const app = await buildChain(true);
const other = await buildChain(false);

const FILES = [
  { label: 'sample.js', path: join(HERE, 'corpus/sample.js') },
  { label: 'HarfBuzzShaper.js', path: join(ROOT, 'packages/glyph3d-core/src/shaping/HarfBuzzShaper.js') },
  { label: 'GlyphField.js', path: join(ROOT, 'packages/glyph3d-core/src/GlyphField.js') },
  { label: 'CodeGrid.js', path: join(ROOT, 'packages/glyph3d-core/src/collections/CodeGrid.js') },
];

const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const padL = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));

console.log('\n' + pad('file', 20) + padL('glyphs', 9) + padL('raw-slot diff', 16) + padL('remap diff', 12));
console.log('-'.repeat(57));

let failures = 0;
for (const f of FILES) {
  const text = readFileSync(f.path, 'utf8');

  // app ground truth: primed-cache slots, per line (the live builder input)
  const appLines = shapeText(app.cache, text).lines.map((l) => l.shaped.map((g) => g.g));

  // a different session shaping the same text (document-order slot allocation)
  const otherLines = text.split('\n').map((line) => other.chain.shape(line).map((g) => g.g));

  let glyphs = 0, rawDiff = 0, remapDiff = 0;
  for (let li = 0; li < appLines.length; li++) {
    const a = appLines[li], o = otherLines[li];
    for (let j = 0; j < a.length; j++) {
      glyphs++;
      if (a[j] !== o[j]) rawDiff++;                                  // (1) raw slots diverge
      const { fontIdx, gid } = resolve(other.chain, o[j]);           // stable identity from the OTHER session
      const remapped = app.chain.slotFor(fontIdx, gid);             // remap through the app's live chain
      if (remapped !== a[j]) remapDiff++;                            // (2) remap should match exactly
    }
  }
  if (remapDiff !== 0) failures++;
  const pct = glyphs ? ((rawDiff / glyphs) * 100).toFixed(0) : '0';
  console.log(pad(f.label, 20) + padL(glyphs, 9) +
    padL(`${rawDiff} (${pct}%)`, 16) + padL(remapDiff === 0 ? '0 [OK]' : `${remapDiff} FAIL`, 12));
}

app.chain.destroy();
other.chain.destroy();

console.log('\nraw-slot diff = storing the slot directly breaks across sessions.');
console.log('remap diff   = storing (fontIdx,gid) + live slotFor() reproduces app slots exactly.');
if (failures) { console.error(`\n${failures} file(s) failed remap parity.`); process.exit(1); }
console.log('\nGATE: (fontIdx,gid) + remap = byte-for-byte slot parity with the app. ✓');
