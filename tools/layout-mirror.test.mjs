// layout-mirror.test.mjs — positionAt IS the fold: per-slot parity between
// LayoutDescription's fold mirror and the real builder, pure node (no three, no GPU).
//   bun tools/layout-mirror.test.mjs
//
// The GPU owns the laid-out position buffer; the CPU answers "where is this glyph"
// by evaluating the same fold (LayoutDescription.positionAt). This test is what makes
// that a CONTRACT: every materialized (line, col) — plus end-of-line and empty-line
// carets — must land exactly where the builder (and therefore the kernel, which has
// its own bit-exact gate against the builder) puts the glyph. Emoji double-advance,
// wrap staircase, scroll conveyor, and both pagination axes are all exercised.

import { buildBatchBuffers, paginationGeometry, resolveLayoutParams } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { computeCellMetrics } from '../packages/glyph3d-core/src/core/cellMetrics.js';
import LayoutDescription from '../packages/glyph3d-core/src/core/LayoutDescription.js';
import { evaluateFold } from '../packages/glyph3d-core/src/core/foldEvaluate.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

// Synthetic monospace shaping, spec-faithful (layout-spec §8): one glyph per codepoint,
// forced 'M' advance, emoji (cp ≥ 0x1F000) double, dx = dy = 0.
const UPEM = 2048, CELL_AX = 1229, FONT_SIZE = 48, EM_HEIGHT = 1.1699, WORLD_SCALE = 0.025;
const charSize = { width: Math.ceil(CELL_AX / UPEM * FONT_SIZE), height: EM_HEIGHT * FONT_SIZE };
const metrics = { ...computeCellMetrics(charSize, WORLD_SCALE), worldScale: WORLD_SCALE, atlasSize: 2048 };

function shape(text) {
  const lines = [];
  let total = 0;
  for (const lineText of text.split('\n')) {
    const shaped = [];
    for (let i = 0; i < lineText.length;) {
      const cp = lineText.codePointAt(i); i += cp > 0xFFFF ? 2 : 1;
      shaped.push({ g: cp, ax: cp >= 0x1F000 ? CELL_AX * 2 : CELL_AX, dx: 0, dy: 0 });
      total++;
    }
    lines.push({ shaped, text: lineText });
  }
  return { lines, totalGlyphs: total };
}

const cpsOf = (s) => { let n = 0; for (let i = 0; i < s.length;) { const cp = s.codePointAt(i); i += cp > 0xFFFF ? 2 : 1; n++; } return n; };

const TEXT = [
  'const answer = 42;',
  '',
  'emoji: \u{1F389} mid \u{1F680} end',
  'x'.repeat(23),
  '',
  'tail(a, b) { return a + b; }',
].join('\n');

const CASES = [
  { name: 'flat',      layout: { wrapWidth: 0, zWrapSpacing: 0.15, pageHeight: 0, pagesWide: 1, axis: 'xy' }, scroll: 0 },
  { name: 'wrap6',     layout: { wrapWidth: 6, zWrapSpacing: 0.15, pageHeight: 0, pagesWide: 1, axis: 'xy' }, scroll: 0 },
  { name: 'scrolled',  layout: { wrapWidth: 6, zWrapSpacing: 0.15, pageHeight: 0, pagesWide: 1, axis: 'xy' }, scroll: 3 },
  { name: 'newspaper', layout: { wrapWidth: 6, zWrapSpacing: 0.15, pageHeight: 3, pagesWide: 2, pageGapX: 10, pageGapY: 10, axis: 'xy' }, scroll: 0 },
  { name: 'z-pages',   layout: { wrapWidth: 6, zWrapSpacing: 0.15, pageHeight: 3, pagesWide: 1, pageDepth: 20, axis: 'z' }, scroll: 0 },
];

const EPS = 1e-4;
const srcLines = TEXT.split('\n');
let emojiSlots = 0, wrappedCases = 0;

for (const { name, layout: layoutSpec, scroll } of CASES) {
  const layout = resolveLayoutParams(layoutSpec);
  const buffers = buildBatchBuffers(
    [{ position: { x: 0, y: 0, z: 0 }, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(TEXT) }],
    { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout, scrollOffset: scroll },
  );
  const meta = buffers.itemMeta[0];

  // Assemble the description EXACTLY as CodeGrid._buildLayoutDescription does.
  const lineSlotBase = Int32Array.from(meta.lineSlotOffsets);
  const lineWrapCols = meta.wrapColsPerLine || srcLines.map(() => []);
  const lineStartRow = new Int32Array(srcLines.length);
  let rows = 0;
  for (let i = 0; i < srcLines.length; i++) { lineStartRow[i] = rows; rows += 1 + (lineWrapCols[i]?.length || 0); }
  const lineLengths = Int32Array.from(srcLines, cpsOf);
  const geom = paginationGeometry(
    { charWidth: metrics.charWidth, letterSpacing: metrics.letterSpacing, lineSpacing: metrics.lineSpacing },
    meta.pageContentWidth || 0,
    layout,
  );
  const desc = new LayoutDescription({
    lineSlotBase, lineStartRow, lineWrapCols, lineLengths,
    sizes: buffers.sizes, geom,
    originX: 0, originY: 0,
    lineSpacing: metrics.lineSpacing,
    zStep: metrics.charHeight * (layout.zWrapSpacing || 0),
    advance: metrics.charWidth + metrics.letterSpacing,
    scrollOffset: scroll,
  });

  // Every materialized glyph: mirror == builder, all three axes.
  let worst = 0, bad = 0, checked = 0;
  for (let line = 0; line < srcLines.length; line++) {
    const len = lineLengths[line];
    for (let col = 0; col < len; col++) {
      const slot = lineSlotBase[line] + col;
      const p = desc.positionAt(line, col);
      const dx = Math.abs(p.x - buffers.positions[slot * 3]);
      const dy = Math.abs(p.y - buffers.positions[slot * 3 + 1]);
      const dz = Math.abs(p.z - buffers.positions[slot * 3 + 2]);
      const d = Math.max(dx, dy, dz);
      if (d > worst) worst = d;
      if (d > EPS) bad++;
      checked++;
      if (buffers.sizes[slot * 2] > metrics.charWidth * 1.5) emojiSlots++;
    }
    // End-of-line caret: last glyph's right edge (or line start when empty).
    const eol = desc.positionAt(line, len);
    if (len > 0) {
      const s = lineSlotBase[line] + len - 1;
      const want = buffers.positions[s * 3] + buffers.sizes[s * 2];
      ok(Math.abs(eol.x - want) < EPS, `${name}: EOL x line ${line} (got ${eol.x}, want ${want})`);
      ok(Math.abs(eol.y - buffers.positions[s * 3 + 1]) < EPS, `${name}: EOL y line ${line}`);
    } else {
      ok(Number.isFinite(eol.x) && Number.isFinite(eol.y), `${name}: empty-line caret finite (line ${line})`);
    }
  }
  ok(bad === 0, `${name}: ${bad}/${checked} slots beyond ${EPS} (worst ${worst.toExponential(2)})`);
  ok(checked > 40, `${name}: vacuous — only ${checked} slots checked`);

  // Third evaluator: evaluateFold (bulk CPU) against the same builder truth, every slot.
  {
    const advances = new Float32Array(buffers.count);
    for (let s = 0; s < buffers.count; s++) advances[s] = buffers.sizes[s * 2];
    const bulk = evaluateFold({
      slotCount: buffers.count, lineTable: lineSlotBase, advances,
      origin: { x: 0, y: 0, z: 0 }, scrollOffset: scroll,
      wrapWidth: layout.wrapWidth, lineSpacing: metrics.lineSpacing,
      zStep: metrics.charHeight * layout.zWrapSpacing,
      geom: meta.pageContentWidth > 0 ? geom : null,
    });
    let bulkBad = 0, bulkWorst = 0;
    for (let s = 0; s < buffers.count * 3; s++) {
      const d = Math.abs(bulk[s] - buffers.positions[s]);
      if (d > bulkWorst) bulkWorst = d;
      if (d > EPS) bulkBad++;
    }
    ok(bulkBad === 0, `${name}: evaluateFold ${bulkBad}/${buffers.count * 3} beyond ${EPS} (worst ${bulkWorst.toExponential(2)})`);
  }
  if (meta.wrapColsPerLine?.some((w) => w.length > 0)) wrappedCases++;
  if (name === 'newspaper' || name === 'z-pages') {
    ok(meta.pageContentWidth > 0, `${name}: pagination fired (pageContentWidth ${meta.pageContentWidth})`);
  }
}

// Arranger displacements (stage 4): positionAt must add the CPU-authored per-slot table
// exactly as the kernel does post-fold — including the EOL caret riding the LAST glyph's
// displacement, and empty lines taking none.
{
  const layout = resolveLayoutParams({ wrapWidth: 6, zWrapSpacing: 0.15, pageHeight: 0, pagesWide: 1, axis: 'xy' });
  const buffers = buildBatchBuffers(
    [{ position: { x: 0, y: 0, z: 0 }, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(TEXT) }],
    { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout, scrollOffset: 0 },
  );
  const meta = buffers.itemMeta[0];
  const lineSlotBase = Int32Array.from(meta.lineSlotOffsets);
  const lineWrapCols = meta.wrapColsPerLine || srcLines.map(() => []);
  const lineStartRow = new Int32Array(srcLines.length);
  let rows = 0;
  for (let i = 0; i < srcLines.length; i++) { lineStartRow[i] = rows; rows += 1 + (lineWrapCols[i]?.length || 0); }
  const lineLengths = Int32Array.from(srcLines, cpsOf);
  const D = new Float32Array(buffers.count * 3);
  // Displace line 2's glyphs by a distinct offset per axis, line 5's by another.
  for (let col = 0; col < lineLengths[2]; col++) { const s = (lineSlotBase[2] + col) * 3; D[s] = 7.5; D[s + 1] = -2.25; D[s + 2] = 1.125; }
  for (let col = 0; col < lineLengths[5]; col++) { const s = (lineSlotBase[5] + col) * 3; D[s] = -3; D[s + 1] = 4; D[s + 2] = -0.5; }
  const desc = new LayoutDescription({
    lineSlotBase, lineStartRow, lineWrapCols, lineLengths,
    sizes: buffers.sizes, geom: null,
    originX: 0, originY: 0, lineSpacing: metrics.lineSpacing,
    zStep: metrics.charHeight * layout.zWrapSpacing,
    advance: metrics.charWidth + metrics.letterSpacing, scrollOffset: 0,
    displacements: D,
  });
  let bad = 0, checked = 0;
  for (let line = 0; line < srcLines.length; line++) {
    for (let col = 0; col < lineLengths[line]; col++) {
      const s = lineSlotBase[line] + col;
      const p = desc.positionAt(line, col);
      const d = Math.max(
        Math.abs(p.x - (buffers.positions[s * 3] + D[s * 3])),
        Math.abs(p.y - (buffers.positions[s * 3 + 1] + D[s * 3 + 1])),
        Math.abs(p.z - (buffers.positions[s * 3 + 2] + D[s * 3 + 2])),
      );
      if (d > EPS) bad++;
      checked++;
    }
  }
  ok(bad === 0, `displaced: ${bad}/${checked} slots beyond ${EPS}`);
  ok(checked > 40, `displaced: vacuous (${checked})`);
  // EOL rides the LAST glyph's displacement.
  const L = 2, len = lineLengths[L], last = lineSlotBase[L] + len - 1;
  const eol = desc.positionAt(L, len);
  ok(Math.abs(eol.x - (buffers.positions[last * 3] + buffers.sizes[last * 2] + D[last * 3])) < EPS, 'displaced: EOL x follows last glyph');
  // Empty line takes no displacement (its row comes from the table — line 0 wraps first).
  const empty = desc.positionAt(1, 0);
  ok(Math.abs(empty.x - 0) < EPS && Math.abs(empty.y - (-lineStartRow[1] * metrics.lineSpacing)) < EPS, 'displaced: empty line undisplaced');
}

// Corpus teeth: the inputs actually exercised the sharp edges.
ok(emojiSlots > 0, `corpus: no double-advance slots seen — emoji path unexercised`);
ok(wrappedCases >= 4, `corpus: wraps exercised in only ${wrappedCases} cases`);

console.log(`\n${fail === 0 ? '✓' : '✗'} layout-mirror: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
