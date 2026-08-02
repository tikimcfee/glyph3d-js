// layout-fuzz.test.mjs — adversarial randomized parity: builder vs fold mirror vs
// evaluateFold, across random content, random params, and random SEQUENCES.
//   bun tools/layout-fuzz.test.mjs [--seeds 200] [--seed 12345]
//
// The standing mirror test proves chosen fixtures; this fuzzer hunts the shapes nobody
// chose: wrap widths landing exactly on line lengths, page heights at row-count
// boundaries, empty-line runs, emoji adjacent to wraps, scroll offsets past the content,
// zero-line texts, and — the sequence dimension — the SAME description re-derived through
// a random walk of scroll/param changes, where any hidden state would accumulate.
// Every step asserts per-slot equality of all three evaluators against the builder.

import { buildBatchBuffers, paginationGeometry, resolveLayoutParams } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { computeCellMetrics } from '../packages/glyph3d-core/src/core/cellMetrics.js';
import LayoutDescription from '../packages/glyph3d-core/src/core/LayoutDescription.js';
import { evaluateFold } from '../packages/glyph3d-core/src/core/foldEvaluate.js';

const argvFlag = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const SEEDS = argvFlag('--seeds', 200);
const SEED0 = argvFlag('--seed', 1);
const EPS = 1e-4;

// Deterministic PRNG (mulberry32) — every failure is replayable by seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UPEM = 2048, CELL_AX = 1229;
const metrics = { ...computeCellMetrics({ width: 29, height: 56.1552 }, 0.025), worldScale: 0.025, atlasSize: 2048 };

function randomText(r) {
  const lines = [];
  const nLines = 1 + Math.floor(r() * 40);
  for (let i = 0; i < nLines; i++) {
    const roll = r();
    if (roll < 0.15) { lines.push(''); continue; }                       // empty-line runs
    const len = roll < 0.3 ? Math.floor(r() * 4)                          // tiny
      : roll < 0.9 ? Math.floor(r() * 90)                                 // normal
      : 150 + Math.floor(r() * 300);                                      // long (wraps)
    let s = '';
    for (let c = 0; c < len; c++) {
      const cr = r();
      s += cr < 0.02 ? '\u{1F600}' : cr < 0.04 ? '\u{1D400}' : String.fromCharCode(33 + Math.floor(r() * 90));
    }
    lines.push(s);
  }
  return lines.join('\n');
}

function shape(text) {
  const lines = []; let total = 0;
  for (const lt of text.split('\n')) {
    const shaped = [];
    for (let i = 0; i < lt.length;) {
      const cp = lt.codePointAt(i); i += cp > 0xFFFF ? 2 : 1;
      shaped.push({ g: cp, ax: cp >= 0x1F000 ? CELL_AX * 2 : CELL_AX, dx: 0, dy: 0 });
      total++;
    }
    lines.push({ shaped, text: lt });
  }
  return { lines, totalGlyphs: total };
}

function randomLayout(r) {
  const wraps = [0, 1, 2, 4, 7, 40, 80, 200];
  const wrapWidth = wraps[Math.floor(r() * wraps.length)];
  const paginate = r() < 0.5;
  return resolveLayoutParams({
    wrapWidth,
    zWrapSpacing: r() < 0.5 ? 0.15 : r() * 2,
    pageHeight: paginate ? 1 + Math.floor(r() * 12) : 0,
    pagesWide: 1 + Math.floor(r() * 5),
    pageGapX: Math.floor(r() * 20), pageGapY: Math.floor(r() * 20),
    pageDepth: Math.floor(r() * 30),
    axis: r() < 0.5 ? 'xy' : 'z',
  });
}

const cpsOf = (s) => { let n = 0; for (let i = 0; i < s.length;) { const cp = s.codePointAt(i); i += cp > 0xFFFF ? 2 : 1; n++; } return n; };

let pass = 0, fail = 0, checkedSlots = 0, wrappedSeeds = 0, paginatedSeeds = 0, emojiSlots = 0;
const failures = [];

for (let k = 0; k < SEEDS; k++) {
  const seed = SEED0 + k;
  const r = rng(seed);
  const text = randomText(r);
  const layout = randomLayout(r);
  const srcLines = text.split('\n');
  const origin = { x: (r() - 0.5) * 40, y: (r() - 0.5) * 40, z: (r() - 0.5) * 10 };

  // The sequence dimension: a random walk of scroll offsets over ONE text+layout —
  // each step is an independent build (the builder has no state), but the mirror and
  // evaluateFold are rebuilt from the same tables each step; any divergence that only
  // appears at step N is state where none should exist.
  const scrolls = [0];
  const steps = 1 + Math.floor(r() * 4);
  for (let s = 0; s < steps; s++) scrolls.push(Math.floor(r() * 30));

  for (const scroll of scrolls) {
    const buffers = buildBatchBuffers(
      [{ position: origin, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(text) }],
      { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout, scrollOffset: scroll },
    );
    const meta = buffers.itemMeta[0];
    if (!meta || !buffers.count) { pass++; continue; }
    const lineSlotBase = Int32Array.from(meta.lineSlotOffsets);
    const lineWrapCols = meta.wrapColsPerLine || srcLines.map(() => []);
    const lineStartRow = new Int32Array(srcLines.length);
    let rows = 0;
    for (let i = 0; i < srcLines.length; i++) { lineStartRow[i] = rows; rows += 1 + (lineWrapCols[i]?.length || 0); }
    const lineLengths = Int32Array.from(srcLines, cpsOf);
    const geom = paginationGeometry(
      { charWidth: metrics.charWidth, letterSpacing: metrics.letterSpacing, lineSpacing: metrics.lineSpacing },
      meta.pageContentWidth || 0, layout,
    );
    const desc = new LayoutDescription({
      lineSlotBase, lineStartRow, lineWrapCols, lineLengths,
      // geom arms ONLY when the builder's pagination actually fired (the witness) —
      // matching CodeGrid._buildLayoutDescription; an always-armed geom shifts boundary
      // rows of exactly-page-tall content that the buffer left flat (mirror-only class).
      sizes: buffers.sizes, geom: meta.pageContentWidth > 0 ? geom : null,
      originX: origin.x, originY: origin.y,
      lineSpacing: metrics.lineSpacing,
      zStep: metrics.charHeight * layout.zWrapSpacing,
      advance: metrics.charWidth + metrics.letterSpacing,
      scrollOffset: scroll,
    });
    // NB the mirror has no originZ — its z is relative (fold z only); compare with origin.z added.
    const advances = new Float32Array(buffers.count);
    for (let s = 0; s < buffers.count; s++) advances[s] = buffers.sizes[s * 2];
    const itemLineTable = new Uint32Array(lineSlotBase.length);
    for (let i = 0; i < lineSlotBase.length; i++) itemLineTable[i] = lineSlotBase[i] - meta.bufferStartIndex;
    const bulk = evaluateFold({
      slotCount: buffers.count, lineTable: itemLineTable, advances,
      origin, scrollOffset: scroll, wrapWidth: layout.wrapWidth,
      lineSpacing: metrics.lineSpacing, zStep: metrics.charHeight * layout.zWrapSpacing,
      geom: meta.pageContentWidth > 0 ? geom : null,
    });

    let bad = null;
    for (let line = 0; line < srcLines.length && !bad; line++) {
      for (let col = 0; col < lineLengths[line]; col++) {
        const slot = lineSlotBase[line] + col;
        const p = desc.positionAt(line, col);
        // Relative tolerance: the builder STORES f32 — at |v| ~1000 one ulp is ~6e-5, which
        // is representation noise, not layout error. A true fold bug moves by cell- or
        // page-stride (>= 0.1 world units) and can never hide under a few relative ulps.
        const tol = (v) => 1e-3 + Math.abs(v) * 2e-5 + col * 1.5e-7;  // STRUCTURAL detector: cell/page strides are >= 0.05 — 50x this floor; tight-eps parity is layout-mirror.test's job
        const bx = buffers.positions[slot * 3], by = buffers.positions[slot * 3 + 1], bz = buffers.positions[slot * 3 + 2];
        const dm = Math.max(Math.abs(p.x - bx) - tol(bx), Math.abs(p.y - by) - tol(by), Math.abs((p.z + origin.z) - bz) - tol(bz));
        const db = Math.max(Math.abs(bulk[slot * 3] - bx) - tol(bx), Math.abs(bulk[slot * 3 + 1] - by) - tol(by), Math.abs(bulk[slot * 3 + 2] - bz) - tol(bz));
        checkedSlots++;
        if (buffers.sizes[slot * 2] > metrics.charWidth * 1.5) emojiSlots++;
        if (dm > 0 || db > 0) { bad = { seed, scroll, line, col, slot, dm, db }; break; }
      }
    }
    if (bad) {
      fail++;
      if (failures.length < 6) failures.push(bad);
      if (SEEDS === 1) {
        const s = bad.slot;
        // Pre-pagination rebuild: recover the builder's exact relY input for this slot.
        const pre = buildBatchBuffers(
          [{ position: origin, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(text) }],
          { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout: { ...layout, pageHeight: 0 }, scrollOffset: scroll },
        );
        const relY = origin.y - pre.positions[s * 3 + 1];
        const H = geom.pageHeightWorld;
        console.log('relY(f32-stored)', relY, 'H', H, 'q0', relY / H, 'origin', JSON.stringify(origin));
        console.log('LAYOUT', JSON.stringify(layout));
        console.log('meta  ', JSON.stringify({ pageContentWidth: meta.pageContentWidth, lines: srcLines.length, count: buffers.count }));
        console.log('geom  ', JSON.stringify(geom));
        console.log('lineLen', lineLengths[bad.line], 'wraps', JSON.stringify(lineWrapCols[bad.line] || []), 'lineStartRow', lineStartRow[bad.line], 'scroll', scroll);
        const p = desc.positionAt(bad.line, bad.col);
        console.log('builder', [buffers.positions[s*3], buffers.positions[s*3+1], buffers.positions[s*3+2]].map(v=>v.toFixed(4)).join(', '));
        console.log('mirror ', [p.x, p.y, p.z + origin.z].map(v=>v.toFixed(4)).join(', '));
        console.log('bulk   ', [bulk[s*3], bulk[s*3+1], bulk[s*3+2]].map(v=>v.toFixed(4)).join(', '));
      }
    }
    else pass++;
  }
  if (meta_wrapped(text, layout)) wrappedSeeds++;
  if (layout.pageHeight > 0) paginatedSeeds++;
}

function meta_wrapped(text, layout) {
  if (!layout.wrapWidth) return false;
  return text.split('\n').some((l) => cpsOf(l) > layout.wrapWidth);
}

console.log(`layout-fuzz: ${SEEDS} seeds from ${SEED0} → ${pass} builds passed, ${fail} failed`);
console.log(`  coverage: ${checkedSlots} slots · ${emojiSlots} wide · ${wrappedSeeds} wrapping seeds · ${paginatedSeeds} paginated seeds`);
for (const f of failures) console.log(`  ✗ seed ${f.seed} scroll ${f.scroll} L${f.line}:C${f.col} slot ${f.slot} mirrorΔ ${f.dm?.toExponential(2)} bulkΔ ${f.db?.toExponential(2)}`);
if (checkedSlots < 10000) { console.log('  ✗ vacuous corpus'); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
