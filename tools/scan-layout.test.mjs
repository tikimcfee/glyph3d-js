// scan-layout.test.mjs — the scan spec vs the oracle, without a GPU.
//   bun tools/scan-layout.test.mjs [--seeds 60]
//
// glyphPipelineScan.js is the ALGORITHM (segmented monoid scan, in the GPU's dispatch
// structure); glyphPipelineReference.js is the SEMANTICS (serial fold per item). This
// proves them equal, and proves the properties the GPU inherits from the algebra:
//
//   associativity   combine(combine(a,b),c) === combine(a,combine(b,c)) over leaf runs
//                   cut at random split points — the license for ANY grouping
//   invariance      every chunk/group size produces the same answer: integer lanes
//                   BIT-EXACT; f32 lanes exact wherever resolveX re-sums (fold > 0),
//                   eps-bounded only where the line prefix itself is the answer
//   reset law       every item's first leader is row 0 / col 0 / ord 0 under every
//                   grouping — including chunks that straddle item boundaries
//   isolation       changing one item's content leaves every other item's exact lanes
//                   bit-identical
//
// The old backward-walk needed a dispatch-ORDER fuzz (the inherit was a race). The scan
// has no order to fuzz — grouping is its only degree of freedom, and this sweep covers it.

import { buildGlyphTrie } from '../packages/glyph3d-core/src/compute/GlyphTrie.js';
import {
  runPipeline, SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT,
  S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, S_LINE_ADV, S_ORD, F_LEADER,
} from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import {
  runScanPipeline, scanIdentity, scanLeaf, scanCombine,
} from '../packages/glyph3d-core/src/compute/glyphPipelineScan.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('--seeds', 60);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── the stand-in atlas (same shape as glyph-pipeline.test.mjs) ──
const CELL_W = 1.2, CELL_H = 1.4;
const SOURCE = new Map();
const addRange = (lo, hi, adv, h) => { for (let cp = lo; cp <= hi; cp++) SOURCE.set(cp, { glyphId: cp, advance: adv, height: h }); };
addRange(0x09, 0x0D, CELL_W, CELL_H);
addRange(0x20, 0x7E, CELL_W, CELL_H);
addRange(0xA0, 0xFF, CELL_W, CELL_H);
addRange(0x2500, 0x257F, CELL_W, CELL_H);
addRange(0x4E00, 0x4E7F, CELL_W * 2, CELL_H * 1.15);
addRange(0x1F600, 0x1F64F, CELL_W * 2, CELL_H);
const trie = buildGlyphTrie(SOURCE.keys(), (cp) => SOURCE.get(cp) || null,
  { missingAdvance: CELL_W, missingHeight: CELL_H });

const enc = new TextEncoder();

const TORTURE = [
  'const answer = 42;', '', '    lead and trail    ', '\ttab\tcols', '',
  'unicode: éèê αβγ 你好 ─┬┐', 'xy\u{1F600}z', 'emoji: \u{1F389} ✅ \u{1F680}',
  'miss: Ͱͱ missing block', 'x'.repeat(337), '', '', 'tail line', 'end',
].join('\n');

function randomText(r, lines = 40) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    const n = Math.floor(r() * r() * 90);
    let s = '';
    for (let j = 0; j < n; j++) {
      const roll = r();
      if (roll < 0.85) s += String.fromCharCode(0x20 + Math.floor(r() * 95));
      else if (roll < 0.92) s += String.fromCodePoint(0x4E00 + Math.floor(r() * 0x80));
      else if (roll < 0.97) s += String.fromCodePoint(0x1F600 + Math.floor(r() * 0x50));
      else s += '\t';
    }
    out.push(s);
  }
  return out.join('\n');
}

// ── comparator: exact where the algebra promises exact, eps where f32 grouping may differ ──
function diffSlots(name, refSlots, gotSlots, n, foldPerByte) {
  const EXACT = [S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_ROW, S_COL, S_FLAGS, S_ORD];
  let bad = null, worstRel = 0;
  for (let id = 0; id < n && !bad; id++) {
    const o = id * SLOT_STRIDE;
    if ((refSlots[o + S_FLAGS] & F_LEADER) === 0) {
      for (let l = 0; l < SLOT_STRIDE; l++) if (gotSlots[o + l] !== refSlots[o + l]) bad = { id, l, why: 'non-leader lane differs' };
      continue;
    }
    for (const l of EXACT) if (gotSlots[o + l] !== refSlots[o + l]) bad = { id, l, why: 'exact lane' };
    const folded = foldPerByte(id) > 0;
    for (const l of [S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV]) {
      const a = refSlots[o + l], b = gotSlots[o + l];
      if (folded && l !== S_LINE_ADV) {
        if (a !== b) bad = { id, l, why: 'fold>0 float lane must be bit-exact' };
      } else {
        // Serial-vs-tree f32 grouping: error bound grows with run length; 1e-4
        // RELATIVE is ~10× the worst observed on a 5k-glyph line and far below
        // anything a pixel can show at that coordinate magnitude.
        const rel = Math.abs(a - b) / Math.max(1, Math.abs(a));
        if (rel > worstRel) worstRel = rel;
        if (rel > 1e-4) bad = { id, l, why: `rel ${rel.toExponential(2)}` };
      }
    }
  }
  ok(!bad, `${name}: slot ${bad?.id} lane ${bad?.l} — ${bad?.why}`);
  return worstRel;
}

// ── 1. associativity fuzz: leaf runs cut at random points ──
{
  let mismatches = 0;
  for (let s = 0; s < SEEDS; s++) {
    const r = rng(1000 + s);
    const bytes = enc.encode(randomText(r, 12));
    const res = runPipeline(bytes, trie, { wrapWidth: [0, 3, 24][s % 3] });
    const wrap = [0, 3, 24][s % 3];
    const n = bytes.length;
    if (n < 6) continue;
    const leaves = [];
    for (let id = 0; id < n; id++) leaves.push(scanLeaf(res.slots, id, wrap, id === 0));
    const foldOver = (from, to) => {
      const acc = scanIdentity();
      for (let i = from; i < to; i++) scanCombine(acc, leaves[i]);
      return acc;
    };
    for (let t = 0; t < 20; t++) {
      const i = 1 + Math.floor(r() * (n - 2));
      const j = i + 1 + Math.floor(r() * (n - i - 1));
      const ab_c = scanCombine(foldOver(0, j), foldOver(j, n));
      const a_bc = scanCombine(foldOver(0, i), scanCombine(foldOver(i, j), foldOver(j, n)));
      for (const k of ['reset', 'nl', 'glyphs', 'rows', 'headLen', 'tailLen', 'wrap']) {
        if (ab_c[k] !== a_bc[k]) mismatches++;
      }
      if (Math.abs(ab_c.tailAdv - a_bc.tailAdv) > 1e-4) mismatches++;
    }
  }
  ok(mismatches === 0, `associativity: ${mismatches} lane mismatches across random cuts`);
}

// ── 2. scan ≡ oracle across chunk/group sizes, folds, pages, scroll ──
const PAGE_NEWS = { pageRows: 8, pagesWide: 2, depthPerBand: 5, bandStrideY: 13.2, pageGapX: 3 };
const PAGE_Z = { pageRows: 8, pagesWide: 1, depthPerBand: 20 };
const PAGE_COLS = { pageCols: 40, depthPerColumn: 4 };
{
  const corpora = [
    ['torture', TORTURE],
    ['single-line-5k', 'x'.repeat(5000)],
    ['empty-heavy', '\n\n\na\n\n\nb\n\n'],
    ['emoji-boundary', ('ab\u{1F600}'.repeat(40) + '\n').repeat(6)],
  ];
  const lanes = [
    { wrapWidth: 0 },
    { wrapWidth: 3 },
    { wrapWidth: 24, zStep: 0.21 },
    { wrapWidth: 200, page: PAGE_NEWS, lineHeight: CELL_H },
    { wrapWidth: 200, page: PAGE_Z, lineHeight: CELL_H, scrollRows: 7 },
    { wrapWidth: 0, page: PAGE_COLS, lineHeight: CELL_H },
  ];
  for (const [cname, text] of corpora) {
    const bytes = enc.encode(text);
    for (const lane of lanes) {
      const oracle = runPipeline(bytes, trie, lane);
      const foldPerByte = () => (lane.wrapWidth > 0 ? lane.wrapWidth : (lane.page?.pageCols || 0));
      for (const [K, G] of [[1, 1], [3, 4], [64, 256], [257, 2]]) {
        const scan = runScanPipeline(bytes, trie, lane, { chunkSize: K, groupSize: G });
        diffSlots(`${cname} wrap=${lane.wrapWidth} page=${lane.page ? 'y' : 'n'} K=${K} G=${G}`,
          oracle.slots, scan.slots, bytes.length, foldPerByte);
        ok(scan.leaders === oracle.leaders, `${cname} K=${K}: leader count`);
        ok(JSON.stringify(scan.ordToByte) === JSON.stringify(oracle.ordToByte),
          `${cname} K=${K}: ordinal map`);
      }
    }
  }
}

// ── 3. multi-item: reset law + bounds table + isolation ──
{
  const parts = [
    ['name.js', { wrapWidth: 0 }],
    [TORTURE, { wrapWidth: 24, page: PAGE_NEWS, zStep: 0.21 }],
    ['x'.repeat(900), { wrapWidth: 200, page: PAGE_Z }],
  ];
  const buffers = parts.map(([t]) => enc.encode(t));
  const mkItems = (bufs) => {
    let at = 0;
    return bufs.map((b, i) => {
      const it = {
        byteStart: at, byteCount: b.length,
        origin: { x: i * 100, y: -i * 3, z: i * 2 },
        wrapWidth: parts[i][1].wrapWidth, zStep: parts[i][1].zStep || 0,
        lineHeight: CELL_H, page: parts[i][1].page || null,
      };
      at += b.length;
      return it;
    });
  };
  const all = new Uint8Array(buffers.reduce((s, b) => s + b.length, 0));
  { let at = 0; for (const b of buffers) { all.set(b, at); at += b.length; } }
  const items = mkItems(buffers);
  const oracle = runPipeline(all, trie, { items });

  for (const [K, G] of [[1, 1], [7, 3], [64, 256]]) {
    const scan = runScanPipeline(all, trie, { items }, { chunkSize: K, groupSize: G });
    const fold = (id) => {
      const i = items.findLastIndex((it) => it.byteStart <= id);
      return items[i].wrapWidth > 0 ? items[i].wrapWidth : (items[i].page?.pageCols || 0);
    };
    diffSlots(`multi-item K=${K} G=${G}`, oracle.slots, scan.slots, all.length, fold);

    for (const it of items) {
      const o = it.byteStart * SLOT_STRIDE;
      ok(scan.slots[o + S_ROW] === 0 && scan.slots[o + S_COL] === 0 && scan.slots[o + S_ORD] === 0,
        `reset law K=${K}: item @${it.byteStart} first leader is row0/col0/ord0`);
    }
    for (let i = 0; i < items.length; i++) {
      const a = oracle.itemBounds[i], b = scan.itemBounds[i];
      ok(!!a === !!b && (!a || (a.totalRows === b.totalRows
        && Math.abs(a.maxRowExtent - b.maxRowExtent) < 1e-4
        && Math.abs(a.min.x - b.min.x) < 1e-4 && Math.abs(a.max.y - b.max.y) < 1e-4)),
        `bounds table K=${K}: item ${i}`);
    }
  }

  // isolation: same-length content change in item 1 → items 0/2 exact lanes untouched
  // Same BYTE length, different content: rotate ASCII letters only (1:1 in UTF-8).
  const buffers2 = buffers.map((b, i) => (i === 1
    ? enc.encode(TORTURE.replace(/[a-y]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 1)))
    : b));
  const all2 = new Uint8Array(all.length);
  { let at = 0; for (const b of buffers2) { all2.set(b, at); at += b.length; } }
  const scanA = runScanPipeline(all, trie, { items }, { chunkSize: 13, groupSize: 4 });
  const scanB = runScanPipeline(all2, trie, { items: mkItems(buffers2) }, { chunkSize: 13, groupSize: 4 });
  let leaked = 0;
  for (const i of [0, 2]) {
    const it = items[i];
    for (let id = it.byteStart; id < it.byteStart + it.byteCount; id++) {
      const o = id * SLOT_STRIDE;
      for (const l of [S_ROW, S_COL, S_ORD, S_X, S_Y, S_Z, S_BASE_X]) {
        if (scanA.slots[o + l] !== scanB.slots[o + l]) leaked++;
      }
    }
  }
  ok(leaked === 0, `isolation: ${leaked} lanes leaked across a sibling item's content change`);
}

// ── 4. randomized corpora sweep ──
{
  let worst = 0;
  for (let s = 0; s < SEEDS; s++) {
    const r = rng(5000 + s);
    const bytes = enc.encode(randomText(r, 8 + Math.floor(r() * 30)));
    if (bytes.length === 0) continue;
    const lane = {
      wrapWidth: [0, 1, 2, 5, 40][Math.floor(r() * 5)],
      lineHeight: CELL_H,
      page: r() < 0.4 ? { pageRows: 1 + Math.floor(r() * 9), pagesWide: 1 + Math.floor(r() * 3), pageGapX: r() * 5, depthPerBand: r() * 10 } : null,
      scrollRows: r() < 0.3 ? Math.floor(r() * 20) : 0,
      origin: { x: r() * 50 - 25, y: r() * 50 - 25, z: r() * 10 - 5 },
    };
    const K = 1 + Math.floor(r() * 100), G = 1 + Math.floor(r() * 8);
    const oracle = runPipeline(bytes, trie, lane);
    const scan = runScanPipeline(bytes, trie, lane, { chunkSize: K, groupSize: G });
    const w = diffSlots(`seed ${5000 + s} K=${K} G=${G}`, oracle.slots, scan.slots, bytes.length,
      () => lane.wrapWidth);
    if (w > worst) worst = w;
  }
  console.log(`\n  randomized sweep worst foldless rel Δ: ${worst.toExponential(2)}`);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} scan-layout: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
