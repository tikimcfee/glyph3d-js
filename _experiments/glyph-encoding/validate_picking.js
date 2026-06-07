/**
 * Picking / access-pattern validation. Proves the map supports the interactive
 * operations the IDE needs, BEFORE we optimize the byte layout:
 *
 *   hover-a-glyph     slot → {line,col, codepoint, char, byteRange, grapheme}
 *   highlight-a-range (lines | byteRange | substring) → exact slot set
 *   do-stuff-at-index every mapping round-trips and matches independent truth
 *
 * Ground truth is computed straight from the raw text (no map), then every
 * IndexView answer is checked against it for EVERY slot. A visual highlight image
 * confirms a range query lands on the right glyphs.
 *
 *   bun _experiments/glyph-encoding/validate_picking.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChain } from './shaper.js';
import { encode, pack, unpack } from './codec.js';
import { IndexView, cpByte } from './index_view.js';
import { renderHighlighted } from './raster.js';
import { encodePNG } from './png.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Independent ground truth derived straight from the source text. */
function groundTruth(text) {
  const lines = text.split('\n');
  const slots = []; // one per codepoint (newlines excluded)
  const lineStart = [0];
  let byte = 0;
  for (let li = 0; li < lines.length; li++) {
    const lt = lines[li];
    let col = 0;
    for (const ch of lt) { // string iterator = codepoints
      const cp = ch.codePointAt(0);
      slots.push({ line: li, col, byte, cp, char: ch });
      byte += cpByte(cp);
      col++;
    }
    lineStart.push(slots.length);
    if (li < lines.length - 1) byte += 1; // newline
  }
  // grapheme → slot range, per line
  const graphemeOfSlot = new Array(slots.length);
  for (let li = 0; li < lines.length; li++) {
    let col = 0, gi = 0;
    for (const { segment } of seg.segment(lines[li])) {
      const cps = [...segment].length;
      const start = lineStart[li] + col, end = start + cps;
      for (let s = start; s < end; s++) graphemeOfSlot[s] = { line: li, grapheme: gi, slotStart: start, slotEnd: end };
      col += cps; gi++;
    }
  }
  return { slots, byteLength: byte, graphemeOfSlot };
}

let failures = 0;
const assert = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } };

const INPUTS = [
  { label: 'sample.js', path: join(HERE, 'corpus/sample.js'), image: true,
    highlights: [{ kind: 'substring', needle: 'fibMemo' }, { kind: 'lines', l0: 1, l1: 2 }] },
  { label: 'torture.txt', path: join(HERE, 'corpus/torture.txt'), image: true,
    highlights: [{ kind: 'substring', needle: 'rtl arabic' }] },
  { label: 'HarfBuzzShaper.js', path: join(ROOT, 'packages/glyph3d-core/src/shaping/HarfBuzzShaper.js'), image: false, highlights: [] },
];

const chain = await loadChain();

for (const input of INPUTS) {
  const text = readFileSync(input.path, 'utf8');
  const map = unpack(pack(encode(text, chain))); // through the packed bytes
  const idx = new IndexView(map);
  const gt = groundTruth(text);

  console.log(`\n${input.label}  (${gt.slots.length} slots, ${gt.byteLength} source bytes)`);

  // counts agree
  assert(idx.total === gt.slots.length, `slot count: ${idx.total} != ${gt.slots.length}`);
  assert(idx.byteLength === gt.byteLength, `byte length: ${idx.byteLength} != ${gt.byteLength}`);

  // every slot: all mappings + inverses, checked against ground truth
  for (let s = 0; s < gt.slots.length; s++) {
    const t = gt.slots[s];
    const lc = idx.slotToLineCol(s);
    assert(lc.line === t.line && lc.col === t.col, `slot ${s} → linecol (${lc.line},${lc.col}) != (${t.line},${t.col})`);
    assert(idx.lineColToSlot(t.line, t.col) === s, `linecol (${t.line},${t.col}) → slot != ${s}`);
    assert(idx.slotToCp(s) === t.cp, `slot ${s} → cp ${idx.slotToCp(s)} != ${t.cp}`);
    assert(idx.slotToChar(s) === t.char, `slot ${s} → char mismatch`);
    const br = idx.slotToByteRange(s);
    assert(br[0] === t.byte, `slot ${s} → byte ${br[0]} != ${t.byte}`);
    assert(idx.byteToSlot(t.byte) === s, `byte ${t.byte} → slot != ${s}`);
    const g = idx.slotToGrapheme(s), tg = gt.graphemeOfSlot[s];
    assert(g.slotStart === tg.slotStart && g.slotEnd === tg.slotEnd,
      `slot ${s} → grapheme [${g.slotStart},${g.slotEnd}) != [${tg.slotStart},${tg.slotEnd})`);
  }

  // use-case 1: hover — show a full resolution for a representative slot
  const probe = Math.min(gt.slots.length - 1, Math.floor(gt.slots.length / 2));
  if (probe >= 0) {
    const lc = idx.slotToLineCol(probe), br = idx.slotToByteRange(probe), g = idx.slotToGrapheme(probe);
    console.log(`  hover slot ${probe}: '${idx.slotToChar(probe)}' line ${lc.line} col ${lc.col} ` +
      `bytes [${br[0]},${br[1]}) glyphId ${idx.slotToGlyphId(probe)} grapheme slots [${g.slotStart},${g.slotEnd})`);
  }

  // use-case 2: highlight a substring by byte range → slots → source must match
  for (const h of input.highlights) {
    if (h.kind === 'substring') {
      let from = 0, hits = 0;
      const nb = Buffer.byteLength(h.needle, 'utf8');
      while (true) {
        const at = text.indexOf(h.needle, from);
        if (at < 0) break;
        const b0 = Buffer.byteLength(text.slice(0, at), 'utf8');
        const slots = idx.slotsForByteRange(b0, b0 + nb);
        assert(idx.sourceForSlots(slots) === h.needle,
          `substring "${h.needle}" @${b0}: got "${idx.sourceForSlots(slots)}"`);
        hits++; from = at + h.needle.length;
      }
      console.log(`  highlight substring "${h.needle}": ${hits} occurrence(s), all slot sets exact`);
    } else if (h.kind === 'lines') {
      const slots = idx.slotsForLines(h.l0, h.l1);
      const expect = text.split('\n').slice(h.l0, h.l1 + 1).join('');
      assert(idx.sourceForSlots(slots) === expect, `lines [${h.l0},${h.l1}] source mismatch`);
      console.log(`  highlight lines [${h.l0},${h.l1}]: ${slots.length} slots, source exact`);
    }
  }

  // visual: render with the first highlight tinted
  if (input.image && input.highlights.length) {
    const refLines = map.lines.map((line) => line.map((i) => map.dict[i].slot));
    const hi = new Set();
    const h = input.highlights[0];
    if (h.kind === 'substring') {
      let from = 0;
      const nb = Buffer.byteLength(h.needle, 'utf8');
      while (true) {
        const at = text.indexOf(h.needle, from); if (at < 0) break;
        const b0 = Buffer.byteLength(text.slice(0, at), 'utf8');
        for (const s of idx.slotsForByteRange(b0, b0 + nb)) hi.add(s);
        from = at + h.needle.length;
      }
    } else if (h.kind === 'lines') {
      for (const s of idx.slotsForLines(h.l0, h.l1)) hi.add(s);
    }
    const img = renderHighlighted(chain, refLines, hi);
    const file = join(OUT, input.label.replace(/\W+/g, '_') + '.highlight.png');
    writeFileSync(file, encodePNG(img.width, img.height, 3, img.data));
    console.log(`  → ${file}`);
  }
}

chain.destroy();

if (failures > 0) { console.error(`\n${failures} picking check(s) FAILED.`); process.exit(1); }
console.log('\nAll picking checks pass: every slot maps to source/line/col/byte/grapheme and back, exactly. ✓');
