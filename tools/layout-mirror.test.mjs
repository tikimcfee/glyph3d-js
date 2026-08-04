// layout-mirror.test.mjs — the fold has three CPU evaluators and one closed-form extent;
// this asserts they are one function. Pure node (no three, no GPU).
//   bun tools/layout-mirror.test.mjs
//
// The GPU owns the laid-out position buffer. The CPU answers "where is this glyph" by
// evaluating the same fold per query (LayoutDescription.positionAt) or in bulk
// (evaluateFold), and answers "how big is this" WITHOUT evaluating it at all
// (LayoutDescription.extent → foldGeometry.foldExtent, closed form).
//
// evaluateFold is the oracle here: it is the fold written out longhand, one glyph at a
// time, so it is what a buffer would contain if a buffer existed. Everything else is
// checked against it —
//   positionAt   must land on the oracle for every materialized (line,col), plus the
//                end-of-line and empty-line carets;
//   extent()     must CONTAIN the oracle's measured min/max, and match it exactly where
//                the closed form is exact (unpaginated content).
//
// Emoji double-advance, wrap staircase, scroll conveyor, arranger displacements, and both
// pagination axes are all exercised. The kernel's own bit-exact gate against evaluateFold
// lives in tools/layout-kernel-check.mjs (that one needs a GPU).

import { buildBatchBuffers, resolveLayoutParams } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { computeCellMetrics } from '../packages/glyph3d-core/src/core/cellMetrics.js';
import LayoutDescription from '../packages/glyph3d-core/src/core/LayoutDescription.js';
import { evaluateFold } from '../packages/glyph3d-core/src/core/foldEvaluate.js';
import { pageFold, layoutScan } from '../packages/glyph3d-core/src/core/foldGeometry.js';

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
  // Content EXACTLY one page tall: pagination armed but must never fire — the boundary the
  // float gate and the integer gate used to disagree about.
  { name: 'exact-page', layout: { wrapWidth: 0, zWrapSpacing: 0.15, pageHeight: 6, pagesWide: 2, pageGapX: 10, pageGapY: 10, axis: 'xy' }, scroll: 0 },
];

const EPS = 1e-4;
const srcLines = TEXT.split('\n');
const ORIGIN = { x: -1.5, y: 2.25, z: 0.5 };
let emojiSlots = 0, wrappedCases = 0, paginatedCases = 0;

/** The oracle's measured box: min/max over the longhand fold's own output. */
function measure(pos, sizes, count) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let s = 0; s < count; s++) {
    const px = pos[s * 3], py = pos[s * 3 + 1], pz = pos[s * 3 + 2];
    const sw = sizes[s * 2], sh = sizes[s * 2 + 1];
    if (px < mnx) mnx = px; if (py < mny) mny = py; if (pz < mnz) mnz = pz;
    if (px + sw > mxx) mxx = px + sw; if (py + sh > mxy) mxy = py + sh; if (pz > mxz) mxz = pz;
  }
  return { min: { x: mnx, y: mny, z: mnz }, max: { x: mxx, y: mxy, z: mxz } };
}

/** Assemble a description EXACTLY as CodeGrid._buildLayoutDescription does. */
function describe(buffers, layout, scroll, displacements = null) {
  const meta = buffers.itemMeta[0];
  const lineSlotBase = Int32Array.from(meta.lineSlotOffsets);
  const lineLengths = Int32Array.from(srcLines, cpsOf);
  const lineStartRow = new Int32Array(srcLines.length);
  const scan = layoutScan({
    slotCount: buffers.count, lineTable: lineSlotBase, sizes: buffers.sizes,
    wrapWidth: layout.wrapWidth, lineStartRow,
  });
  const desc = new LayoutDescription({
    lineSlotBase, lineStartRow, lineLengths,
    sizes: buffers.sizes,
    wrapWidth: layout.wrapWidth,
    page: pageFold(layout, metrics, scan.maxRowExtent),
    originX: ORIGIN.x, originY: ORIGIN.y, originZ: ORIGIN.z,
    lineSpacing: metrics.lineSpacing,
    zStep: metrics.charHeight * (layout.zWrapSpacing || 0),
    cellHeight: metrics.charHeight,
    advance: metrics.charWidth + metrics.letterSpacing,
    scrollOffset: scroll,
    totalRows: scan.totalRows, maxRowExtent: scan.maxRowExtent, maxSegs: scan.maxSegs,
    displacements,
  });
  return { desc, scan, lineSlotBase, lineLengths, lineStartRow };
}

/** The oracle: the fold written out longhand, one glyph at a time. */
function oracle(buffers, layout, scroll, scan, lineSlotBase, displacements = null) {
  const advances = new Float32Array(buffers.count);
  for (let s = 0; s < buffers.count; s++) advances[s] = buffers.sizes[s * 2];
  return evaluateFold({
    slotCount: buffers.count, lineTable: lineSlotBase, advances,
    origin: ORIGIN, scrollOffset: scroll,
    wrapWidth: layout.wrapWidth, lineSpacing: metrics.lineSpacing,
    zStep: metrics.charHeight * (layout.zWrapSpacing || 0),
    page: pageFold(layout, metrics, scan.maxRowExtent),
    displacements,
  });
}

for (const { name, layout: layoutSpec, scroll } of CASES) {
  const layout = resolveLayoutParams(layoutSpec);
  const buffers = buildBatchBuffers(
    [{ position: ORIGIN, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(TEXT) }],
    { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout, scrollOffset: scroll },
  );
  const { desc, scan, lineSlotBase, lineLengths } = describe(buffers, layout, scroll);
  const pos = oracle(buffers, layout, scroll, scan, lineSlotBase);

  // ── positionAt == the oracle, every materialized glyph, all three axes ──
  let worst = 0, bad = 0, checked = 0;
  for (let line = 0; line < srcLines.length; line++) {
    const len = lineLengths[line];
    for (let col = 0; col < len; col++) {
      const slot = lineSlotBase[line] + col;
      const p = desc.positionAt(line, col);
      const d = Math.max(
        Math.abs(p.x - pos[slot * 3]),
        Math.abs(p.y - pos[slot * 3 + 1]),
        Math.abs(p.z - pos[slot * 3 + 2]),
      );
      if (d > worst) worst = d;
      if (d > EPS) bad++;
      checked++;
      if (buffers.sizes[slot * 2] > metrics.charWidth * 1.5) emojiSlots++;
    }
    // End-of-line caret: last glyph's right edge (or line start when empty).
    const eol = desc.positionAt(line, len);
    if (len > 0) {
      const s = lineSlotBase[line] + len - 1;
      const want = pos[s * 3] + buffers.sizes[s * 2];
      ok(Math.abs(eol.x - want) < EPS, `${name}: EOL x line ${line} (got ${eol.x}, want ${want})`);
      ok(Math.abs(eol.y - pos[s * 3 + 1]) < EPS, `${name}: EOL y line ${line}`);
      ok(Math.abs(eol.z - pos[s * 3 + 2]) < EPS, `${name}: EOL z line ${line}`);
    } else {
      ok(Number.isFinite(eol.x) && Number.isFinite(eol.y), `${name}: empty-line caret finite (line ${line})`);
    }
  }
  ok(bad === 0, `${name}: positionAt ${bad}/${checked} slots beyond ${EPS} (worst ${worst.toExponential(2)})`);
  ok(checked > 40, `${name}: vacuous — only ${checked} slots checked`);

  // ── extent() vs the oracle's measured box ──
  const ext = desc.extent();
  const box = measure(pos, buffers.sizes, buffers.count);
  ok(!!ext, `${name}: extent produced`);
  if (ext) {
    // CONTAINMENT is the hard contract: the cull box must never clip live content.
    ok(ext.min.x <= box.min.x + EPS && ext.min.y <= box.min.y + EPS && ext.min.z <= box.min.z + EPS
       && ext.max.x >= box.max.x - EPS && ext.max.y >= box.max.y - EPS && ext.max.z >= box.max.z - EPS,
      `${name}: extent contains content — got [${ext.min.x.toFixed(3)},${ext.min.y.toFixed(3)},${ext.min.z.toFixed(3)}]..`
      + `[${ext.max.x.toFixed(3)},${ext.max.y.toFixed(3)},${ext.max.z.toFixed(3)}] vs measured `
      + `[${box.min.x.toFixed(3)},${box.min.y.toFixed(3)},${box.min.z.toFixed(3)}]..`
      + `[${box.max.x.toFixed(3)},${box.max.y.toFixed(3)},${box.max.z.toFixed(3)}]`);

    const paginated = layout.pageHeight > 0 && (scan.totalRows - 1 - scroll) >= layout.pageHeight;
    if (paginated) paginatedCases++;
    if (!paginated) {
      // Unpaginated the closed form is EXACT, not merely conservative.
      const worstFace = Math.max(
        Math.abs(ext.min.x - box.min.x), Math.abs(ext.min.y - box.min.y), Math.abs(ext.min.z - box.min.z),
        Math.abs(ext.max.x - box.max.x), Math.abs(ext.max.y - box.max.y), Math.abs(ext.max.z - box.max.z));
      ok(worstFace < EPS, `${name}: unpaginated extent is EXACT (worst face off by ${worstFace.toExponential(2)})`);
    } else {
      // Paginated it may over-cover (the widest row need not sit in the last column), but
      // never by more than one page stride per axis — a loose box is a wasted draw.
      const page = pageFold(layout, metrics, scan.maxRowExtent);
      const slackX = (ext.max.x - ext.min.x) - (box.max.x - box.min.x);
      const slackY = (ext.max.y - ext.min.y) - (box.max.y - box.min.y);
      ok(slackX <= page.strideX + EPS, `${name}: extent x slack ${slackX.toFixed(3)} exceeds a page stride`);
      ok(slackY <= page.strideY + EPS, `${name}: extent y slack ${slackY.toFixed(3)} exceeds a page stride`);
    }
  }

  // ── the exactly-one-page case must NOT paginate ──
  if (name === 'exact-page') {
    ok(scan.totalRows === srcLines.length, `exact-page: ${scan.totalRows} rows (expected ${srcLines.length}, unwrapped)`);
    ok(scan.totalRows === layout.pageHeight, `exact-page: content is exactly one page (${scan.totalRows} == ${layout.pageHeight})`);
    let fanned = 0;
    for (let s = 0; s < buffers.count; s++) if (pos[s * 3] > ORIGIN.x + scan.maxRowExtent + EPS) fanned++;
    ok(fanned === 0, `exact-page: ${fanned} glyphs fanned into a second column — the gate fired on content that fits`);
  }
  if (scan.maxSegs > 0) wrappedCases++;
}

// Arranger displacements: positionAt must add the CPU-authored per-slot table exactly as
// the kernel does post-fold — including the EOL caret riding the LAST glyph's displacement,
// and empty lines taking none.
{
  const layout = resolveLayoutParams({ wrapWidth: 6, zWrapSpacing: 0.15, pageHeight: 0, pagesWide: 1, axis: 'xy' });
  const buffers = buildBatchBuffers(
    [{ position: ORIGIN, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(TEXT) }],
    { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout, scrollOffset: 0 },
  );
  const probe = describe(buffers, layout, 0);
  const { lineSlotBase, lineLengths } = probe;
  const D = new Float32Array(buffers.count * 3);
  // Displace line 2's glyphs by a distinct offset per axis, line 5's by another.
  for (let col = 0; col < lineLengths[2]; col++) { const s = (lineSlotBase[2] + col) * 3; D[s] = 7.5; D[s + 1] = -2.25; D[s + 2] = 1.125; }
  for (let col = 0; col < lineLengths[5]; col++) { const s = (lineSlotBase[5] + col) * 3; D[s] = -3; D[s + 1] = 4; D[s + 2] = -0.5; }

  const { desc } = describe(buffers, layout, 0, D);
  const pos = oracle(buffers, layout, 0, probe.scan, lineSlotBase, D);
  let bad = 0, checked = 0;
  for (let line = 0; line < srcLines.length; line++) {
    for (let col = 0; col < lineLengths[line]; col++) {
      const s = lineSlotBase[line] + col;
      const p = desc.positionAt(line, col);
      const d = Math.max(
        Math.abs(p.x - pos[s * 3]),
        Math.abs(p.y - pos[s * 3 + 1]),
        Math.abs(p.z - pos[s * 3 + 2]),
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
  ok(Math.abs(eol.x - (pos[last * 3] + buffers.sizes[last * 2])) < EPS, 'displaced: EOL x follows last glyph');
  // Empty line takes no displacement (its row comes from the table — line 0 wraps first).
  const empty = desc.positionAt(1, 0);
  ok(Math.abs(empty.x - ORIGIN.x) < EPS
     && Math.abs(empty.y - (ORIGIN.y - probe.lineStartRow[1] * metrics.lineSpacing)) < EPS,
     'displaced: empty line undisplaced');
}

// Corpus teeth: the inputs actually exercised the sharp edges.
ok(emojiSlots > 0, 'corpus: no double-advance slots seen — emoji path unexercised');
ok(wrappedCases >= 4, `corpus: wraps exercised in only ${wrappedCases} cases`);
ok(paginatedCases >= 2, `corpus: pagination exercised in only ${paginatedCases} cases`);

console.log(`\n${fail === 0 ? '✓' : '✗'} layout-mirror: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
