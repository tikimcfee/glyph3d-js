/**
 * Highlight composition (step 1b). The new render-neutral highlight product
 * (CodeGrid.getHighlights() → {gen, lang, captures}) carries tree-sitter UTF-16
 * coordinates: row/col (UTF-16 cols) AND absolute UTF-16 startIndex/endIndex.
 * The map's index is codepoint/byte based, so this proves the UTF-16↔codepoint
 * conversion lands captures on the EXACT glyphs — including across astral chars
 * (emoji/CJK) where UTF-16 offset ≠ codepoint offset.
 *
 * Captures here are synthesized as word/letter tokens (a stand-in for tree-sitter
 * captures, in the same coordinate space). Ground truth = the matched token text.
 *
 *   bun _experiments/glyph-encoding/validate_highlights.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadAppEngine } from './shaper.js';
import { encode, pack, unpack, expandRender } from './codec.js';
import { IndexView } from './index_view.js';
import { renderHighlighted } from './raster.js';
import { encodePNG } from './png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const { chain, resolve } = await loadAppEngine();

// Letters/numbers/underscore, Unicode-aware. matchAll .index is a UTF-16 offset
// (JS strings are UTF-16) — exactly the space tree-sitter captures live in.
const TOKEN = /[\p{L}\p{N}_]+/gu;

const FILES = [
  { label: 'sample.js', path: join(HERE, 'corpus/sample.js'), image: true },
  { label: 'torture.txt', path: join(HERE, 'corpus/torture.txt'), image: true }, // astral teeth
  { label: 'GlyphField.js', path: join(ROOT, 'packages/glyph3d-core/src/GlyphField.js'), image: false },
];

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; if (failures <= 8) console.error('  ✗ ' + m); } };
const rangeArr = ([a, b]) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);

for (const f of FILES) {
  const text = readFileSync(f.path, 'utf8');
  const map = unpack(pack(encode(text)));
  const idx = new IndexView(map);

  let tokens = 0, converted = 0;
  const hi = new Set();
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0];
    if (tok.includes('\n')) continue; // tokens are single-line by construction
    const startIndex = m.index, endIndex = m.index + tok.length;

    // derive tree-sitter style row/col (UTF-16) independently
    const before = text.slice(0, startIndex);
    const row = (before.match(/\n/g) || []).length;
    const startCol = startIndex - (before.lastIndexOf('\n') + 1); // UTF-16 col
    const endCol = startCol + tok.length;

    // teeth: does this capture's position actually require a UTF-16→codepoint
    // shift (i.e. is there an astral char before it)? [...before].length is the
    // codepoint index; startIndex is the UTF-16 index.
    if ([...before].length !== startIndex) converted++;

    // two capture forms must agree and both must land on the token exactly
    const byIndex = idx.captureToSlots({ startIndex, endIndex });
    const byRowCol = idx.captureToSlots({ startRow: row, startCol, endRow: row, endCol });
    assert(byIndex[0] === byRowCol[0] && byIndex[1] === byRowCol[1],
      `${f.label} "${tok}" @${startIndex}: index form ${byIndex} != rowcol form ${byRowCol}`);
    const got = idx.sourceForSlots(rangeArr(byIndex));
    assert(got === tok, `${f.label} "${tok}" @${startIndex}: got "${got}"`);

    for (const s of rangeArr(byIndex)) hi.add(s);
    tokens++;
  }
  console.log(`${f.label}: ${tokens} token captures resolved to exact glyphs` +
    (converted ? `  (${converted} sit after astral chars — real UTF-16→codepoint conversion exercised)`
               : `  (no astral positions — conversion was identity here)`));

  if (f.image) {
    const img = renderHighlighted(chain, expandRender(map, resolve), hi);
    const file = join(OUT, f.label.replace(/\W+/g, '_') + '.tokens.png');
    writeFileSync(file, encodePNG(img.width, img.height, 3, img.data));
    console.log(`  → ${file}`);
  }
}

chain.destroy();
if (failures) { console.error(`\n${failures} highlight composition check(s) FAILED.`); process.exit(1); }
console.log('\nAll captures (UTF-16 row/col AND absolute index) land on the exact glyphs. ✓');
