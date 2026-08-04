// layout-fuzz.test.mjs — adversarial randomized parity: fold mirror vs evaluateFold, and
// the closed-form extent vs what the fold actually occupies.
//   bun tools/layout-fuzz.test.mjs [--seeds 200] [--seed 12345]
//
// The standing mirror test proves chosen fixtures; this fuzzer hunts the shapes nobody
// chose: wrap widths landing exactly on line lengths, page heights at row-count boundaries,
// empty-line runs, emoji adjacent to wraps, scroll offsets past the content, zero-line
// texts, and — the sequence dimension — the SAME description re-derived through a random
// walk of scroll/param changes, where any hidden state would accumulate.
//
// evaluateFold is the oracle (the fold longhand, glyph by glyph). Each step asserts:
//   · positionAt lands on the oracle for every materialized slot;
//   · extent() CONTAINS every glyph the oracle placed — the property a cull box must never
//     violate, and the one the band/page arithmetic in foldExtent is easiest to get subtly
//     wrong at a boundary;
//   · unpaginated, extent() is EXACT, not merely conservative.

import { buildBatchBuffers, resolveLayoutParams } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { computeCellMetrics } from '../packages/glyph3d-core/src/core/cellMetrics.js';
import LayoutDescription from '../packages/glyph3d-core/src/core/LayoutDescription.js';
import { evaluateFold } from '../packages/glyph3d-core/src/core/foldEvaluate.js';
import { pageFold, layoutScan } from '../packages/glyph3d-core/src/core/foldGeometry.js';

const argvFlag = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const SEEDS = argvFlag('--seeds', 200);
const SEED0 = argvFlag('--seed', 1);

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

// The oracle stores f32, positionAt computes f64 — at |v| ~1000 one ulp is ~6e-5, which is
// representation noise, not layout error. A true fold bug moves by a cell or page stride
// (>= 0.05 world units), 50x this floor. Tight-eps parity is layout-mirror.test's job.
const tol = (v) => 1e-3 + Math.abs(v) * 2e-5;

let pass = 0, fail = 0, checkedSlots = 0, wrappedSeeds = 0, paginatedSeeds = 0, emojiSlots = 0;
let extentChecks = 0, exactExtents = 0;
const failures = [];

for (let k = 0; k < SEEDS; k++) {
  const seed = SEED0 + k;
  const r = rng(seed);
  const text = randomText(r);
  const layout = randomLayout(r);
  const srcLines = text.split('\n');
  const origin = { x: (r() - 0.5) * 40, y: (r() - 0.5) * 40, z: (r() - 0.5) * 10 };

  // The sequence dimension: a random walk of scroll offsets over ONE text+layout — each
  // step is an independent build, but the mirror and evaluateFold are rebuilt from the same
  // tables each step; any divergence that only appears at step N is state where none exists.
  const scrolls = [0];
  const steps = 1 + Math.floor(r() * 4);
  for (let s = 0; s < steps; s++) scrolls.push(Math.floor(r() * 30));

  const buffers = buildBatchBuffers(
    [{ position: origin, color: { r: 1, g: 1, b: 1 }, scale: 1, groupId: 0, shaped: shape(text) }],
    { metrics, defaultColor: { r: 1, g: 1, b: 1 }, upem: UPEM, layout },
  );
  const meta = buffers.itemMeta[0];
  if (!meta || !buffers.count) { pass++; continue; }

  const lineSlotBase = Int32Array.from(meta.lineSlotOffsets);
  const lineLengths = Int32Array.from(srcLines, cpsOf);
  const advances = new Float32Array(buffers.count);
  for (let s = 0; s < buffers.count; s++) advances[s] = buffers.sizes[s * 2];

  for (const scroll of scrolls) {
    const lineStartRow = new Int32Array(srcLines.length);
    const scan = layoutScan({
      slotCount: buffers.count, lineTable: lineSlotBase, sizes: buffers.sizes,
      wrapWidth: layout.wrapWidth, lineStartRow,
    });
    const page = pageFold(layout, metrics, scan.maxRowExtent);
    const desc = new LayoutDescription({
      lineSlotBase, lineStartRow, lineLengths,
      sizes: buffers.sizes,
      wrapWidth: layout.wrapWidth,
      page,
      originX: origin.x, originY: origin.y, originZ: origin.z,
      lineSpacing: metrics.lineSpacing,
      zStep: metrics.charHeight * layout.zWrapSpacing,
      cellHeight: metrics.charHeight,
      advance: metrics.charWidth + metrics.letterSpacing,
      scrollOffset: scroll,
      totalRows: scan.totalRows, maxRowExtent: scan.maxRowExtent, maxSegs: scan.maxSegs,
    });
    const bulk = evaluateFold({
      slotCount: buffers.count, lineTable: lineSlotBase, advances,
      origin, scrollOffset: scroll, wrapWidth: layout.wrapWidth,
      lineSpacing: metrics.lineSpacing, zStep: metrics.charHeight * layout.zWrapSpacing,
      page,
    });

    let bad = null;
    // ── positionAt == the oracle, per slot ──
    for (let line = 0; line < srcLines.length && !bad; line++) {
      for (let col = 0; col < lineLengths[line]; col++) {
        const slot = lineSlotBase[line] + col;
        const p = desc.positionAt(line, col);
        const bx = bulk[slot * 3], by = bulk[slot * 3 + 1], bz = bulk[slot * 3 + 2];
        const dm = Math.max(
          Math.abs(p.x - bx) - tol(bx),
          Math.abs(p.y - by) - tol(by),
          Math.abs(p.z - bz) - tol(bz));
        checkedSlots++;
        if (buffers.sizes[slot * 2] > metrics.charWidth * 1.5) emojiSlots++;
        if (dm > 0) { bad = { seed, scroll, line, col, slot, kind: 'mirror', d: dm }; break; }
      }
    }

    // ── extent() must cover every glyph the oracle placed ──
    if (!bad) {
      const ext = desc.extent();
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (let s = 0; s < buffers.count; s++) {
        const px = bulk[s * 3], py = bulk[s * 3 + 1], pz = bulk[s * 3 + 2];
        const sw = buffers.sizes[s * 2], sh = buffers.sizes[s * 2 + 1];
        if (px < mnx) mnx = px; if (py < mny) mny = py; if (pz < mnz) mnz = pz;
        if (px + sw > mxx) mxx = px + sw; if (py + sh > mxy) mxy = py + sh; if (pz > mxz) mxz = pz;
      }
      if (!ext) {
        bad = { seed, scroll, kind: 'extent-null', d: 0 };
      } else {
        extentChecks++;
        const slack = Math.min(
          mnx - ext.min.x, mny - ext.min.y, mnz - ext.min.z,
          ext.max.x - mxx, ext.max.y - mxy, ext.max.z - mxz);
        const t = tol(Math.max(Math.abs(mnx), Math.abs(mny), Math.abs(mxx), Math.abs(mxy)));
        if (slack < -t) bad = { seed, scroll, kind: 'extent-clips', d: -slack };
        else {
          const lastRow = scan.totalRows - 1 - scroll;
          const paginated = page.rows > 0 && lastRow >= page.rows;
          // The extent spans ROWS, blank ones included (see foldExtent) — so it only
          // coincides with the measured GLYPH box when the first and last rows carry
          // glyphs. Where they do, the closed form must be exact, not merely conservative.
          const endsHaveGlyphs = lineLengths[0] > 0 && lineLengths[srcLines.length - 1] > 0;
          if (!paginated && endsHaveGlyphs) {
            const off = Math.max(
              Math.abs(ext.min.x - mnx), Math.abs(ext.min.y - mny), Math.abs(ext.min.z - mnz),
              Math.abs(ext.max.x - mxx), Math.abs(ext.max.y - mxy), Math.abs(ext.max.z - mxz));
            if (off > t) bad = { seed, scroll, kind: 'extent-inexact', d: off };
            else exactExtents++;
          }
        }
      }
    }

    if (bad) {
      fail++;
      if (failures.length < 6) failures.push(bad);
      if (SEEDS === 1) {
        console.log('LAYOUT', JSON.stringify(layout));
        console.log('scan  ', JSON.stringify(scan), 'scroll', scroll, 'origin', JSON.stringify(origin));
        console.log('page  ', JSON.stringify(page));
        console.log('extent', JSON.stringify(desc.extent()));
        if (bad.slot !== undefined) {
          const s = bad.slot, p = desc.positionAt(bad.line, bad.col);
          console.log('lineLen', lineLengths[bad.line], 'lineStartRow', lineStartRow[bad.line]);
          console.log('mirror ', [p.x, p.y, p.z].map((v) => v.toFixed(4)).join(', '));
          console.log('oracle ', [bulk[s * 3], bulk[s * 3 + 1], bulk[s * 3 + 2]].map((v) => v.toFixed(4)).join(', '));
        }
      }
    } else pass++;
  }
  if (layout.wrapWidth && srcLines.some((l) => cpsOf(l) > layout.wrapWidth)) wrappedSeeds++;
  if (layout.pageHeight > 0) paginatedSeeds++;
}

console.log(`layout-fuzz: ${SEEDS} seeds from ${SEED0} → ${pass} builds passed, ${fail} failed`);
console.log(`  coverage: ${checkedSlots} slots · ${emojiSlots} wide · ${wrappedSeeds} wrapping seeds · ${paginatedSeeds} paginated seeds`);
console.log(`  extent:   ${extentChecks} boxes checked for containment · ${exactExtents} exact (unpaginated)`);
for (const f of failures) console.log(`  ✗ seed ${f.seed} scroll ${f.scroll} ${f.kind}${f.line !== undefined ? ` L${f.line}:C${f.col}` : ''} Δ ${f.d?.toExponential(2)}`);
if (checkedSlots < 10000) { console.log('  ✗ vacuous corpus'); process.exit(1); }
if (extentChecks < 100) { console.log('  ✗ vacuous extent corpus'); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
