// glyph-pipeline.test.mjs — the byte-in pipeline, verified without a GPU.
//   bun tools/glyph-pipeline.test.mjs [--orders 30]
//
// The CPU reference (compute/glyphPipelineReference.js) is the executable spec the WGSL
// kernels get diffed against. This proves the spec itself, on real files, against
// independent oracles:
//
//   trie         every codepoint resolves to what the source map says, and every codepoint
//                NOT in the map resolves to missing — no collisions, no aliasing, checked
//                across the whole BMP plus astral samples
//   decode       leader detection and codepoint decoding agree with TextDecoder over real
//                source files, including multi-byte and astral sequences
//   layout       positions match a straight sequential fold, under every dispatch order
//   pagination   is a pure per-slot function — running it twice on separate buffers from
//                the same input gives identical output regardless of thread order
//   bounds       the reduce equals a naive min/max walk, and CONTAINS every placed quad
//
// The point of the byte-indexed design is checked too: slot index == source byte offset,
// so a tree-sitter byte range or a picking hit indexes the buffer with no mapping table.

import { readFileSync } from 'node:fs';
import { buildGlyphTrie, trieLookup, BLOCK_INDEX_LENGTH } from '../packages/glyph3d-core/src/compute/GlyphTrie.js';
import {
  runPipeline, decodeAndResolve, layout, paginate, boundsReduce, allocSlots,
  sequenceLength, rowsForLine, SLOT_STRIDE, S_CODEPOINT, S_X, S_Y, S_Z, S_ROW, S_COL,
  S_ADVANCE, S_HEIGHT, S_FLAGS, S_BASE_X, F_LEADER, NEWLINE,
} from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const N_ORDERS = arg('--orders', 30);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── A stand-in atlas: monospace latin, double-advance emoji, a taller CJK block. Stands in
//    for MonospaceShapeCache + the Slug atlas without needing WASM in the harness.
const CELL_W = 1.2, CELL_H = 1.4;
const SOURCE = new Map();
const addRange = (lo, hi, adv, h) => { for (let cp = lo; cp <= hi; cp++) SOURCE.set(cp, { glyphId: cp, advance: adv, height: h }); };
addRange(0x09, 0x0D, CELL_W, CELL_H);          // tab..CR (newline carries the line height)
addRange(0x20, 0x7E, CELL_W, CELL_H);          // printable ASCII
addRange(0xA0, 0xFF, CELL_W, CELL_H);          // latin-1
addRange(0x2500, 0x257F, CELL_W, CELL_H);      // box drawing
addRange(0x4E00, 0x4E7F, CELL_W * 2, CELL_H * 1.15);  // a CJK slice — wide AND taller
addRange(0x1F600, 0x1F64F, CELL_W * 2, CELL_H);       // emoji (astral)

const trie = buildGlyphTrie(SOURCE.keys(),
  (cp) => SOURCE.get(cp) || null,
  { missingAdvance: CELL_W, missingHeight: CELL_H });

console.log(`trie: ${trie.blockCount} blocks, ${trie.mapped} codepoints, ${(trie.bytes / 1024).toFixed(1)} KB\n`);

// ── trie: exhaustive over the BMP + astral samples ──
{
  let wrong = 0, missWrong = 0, checked = 0;
  for (let cp = 0; cp <= 0xFFFF; cp++) {
    const want = SOURCE.get(cp);
    const got = trieLookup(trie, cp);
    checked++;
    if (want) {
      if (got.missing || got.glyphId !== want.glyphId
          || Math.abs(got.advance - want.advance) > 1e-6
          || Math.abs(got.height - want.height) > 1e-6) wrong++;
    } else if (!got.missing) missWrong++;
  }
  for (let cp = 0x10000; cp <= 0x10FFFF; cp += 97) {
    const want = SOURCE.get(cp); const got = trieLookup(trie, cp);
    checked++;
    if (want) { if (got.missing || got.glyphId !== want.glyphId) wrong++; }
    else if (!got.missing) missWrong++;
  }
  for (const cp of SOURCE.keys()) {              // every mapped astral codepoint explicitly
    const got = trieLookup(trie, cp);
    if (got.missing || got.glyphId !== cp) wrong++;
    checked++;
  }
  ok(wrong === 0, `trie: ${wrong} mapped codepoints resolved wrong`);
  ok(missWrong === 0, `trie: ${missWrong} unmapped codepoints did NOT resolve as missing (aliasing)`);
  ok(checked > 70000, `trie: vacuous (${checked} checked)`);
  ok(trie.blockIndex.length === BLOCK_INDEX_LENGTH, 'trie: blockIndex covers all of Unicode');
  ok(trie.bytes < 512 * 1024, `trie: ${(trie.bytes / 1024).toFixed(1)} KB is not small`);
}

// ── decode: leaders + codepoints agree with TextDecoder, on real files ──
const FILES = [
  'packages/glyph3d-core/src/collections/CodeGrid.js',
  'packages/glyph3d-core/src/compute/GlyphLayoutKernel.js',
  'CLAUDE.md',
];
const CORPORA = [];
for (const f of FILES) {
  let raw;
  try { raw = readFileSync(f); } catch { continue; }
  CORPORA.push({ name: f, bytes: new Uint8Array(raw) });
}
// Plus a synthetic torture file: every sequence length, adjacent, with runs of newlines.
{
  const parts = [];
  const r = rng(99);
  for (let i = 0; i < 900; i++) {
    const q = r();
    if (q < 0.10) parts.push('\n');
    else if (q < 0.16) parts.push('\u{1F600}');          // 4-byte
    else if (q < 0.22) parts.push('中');             // 3-byte, wide + tall
    else if (q < 0.28) parts.push('é');             // 2-byte
    else if (q < 0.32) parts.push('─');             // 3-byte box drawing
    else if (q < 0.35) parts.push('\u{1F4A9}');          // 4-byte, UNMAPPED → missing path
    else parts.push(String.fromCharCode(33 + Math.floor(r() * 90)));
  }
  CORPORA.push({ name: '<torture>', bytes: new TextEncoder().encode(parts.join('')) });
}

for (const { name, bytes } of CORPORA) {
  const slots = allocSlots(bytes.length);
  const misses = [];
  for (let id = 0; id < bytes.length; id++) decodeAndResolve(bytes, slots, trie, id, misses);

  // Oracle: TextDecoder + a codePointAt walk, tracking byte offsets independently.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const wantCps = [], wantOffsets = [];
  {
    let byteOff = 0;
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      wantCps.push(cp); wantOffsets.push(byteOff);
      const chLen = cp > 0xFFFF ? 2 : 1;
      byteOff += new TextEncoder().encode(text.slice(i, i + chLen)).length;
      i += chLen;
    }
  }
  const gotCps = [], gotOffsets = [];
  for (let id = 0; id < bytes.length; id++) {
    if ((slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) !== 0) {
      gotCps.push(slots[id * SLOT_STRIDE + S_CODEPOINT]); gotOffsets.push(id);
    }
  }
  ok(gotCps.length === wantCps.length, `${name}: leader count ${gotCps.length} vs ${wantCps.length}`);
  let cpBad = 0, offBad = 0;
  for (let i = 0; i < Math.min(gotCps.length, wantCps.length); i++) {
    if (gotCps[i] !== wantCps[i]) cpBad++;
    if (gotOffsets[i] !== wantOffsets[i]) offBad++;
  }
  ok(cpBad === 0, `${name}: ${cpBad} codepoints differ from TextDecoder`);
  // THE byte-indexed invariant: a slot index IS a source byte offset.
  ok(offBad === 0, `${name}: ${offBad} slot indices are not the source byte offset`);
  ok(bytes.length > 200, `${name}: vacuous corpus`);
}

// ── layout: matches a sequential fold, under every dispatch order ──
/**
 * The oracle: one forward pass, wrap-aware, in f64. Row and col are exact; x is the running
 * sum of advances since the current visual row started.
 */
function sequentialFold(bytes, slots, wrap = 0) {
  const row = new Float64Array(bytes.length), col = new Float64Array(bytes.length);
  const xs = new Float64Array(bytes.length);
  let rowBase = 0, c = 0, x = 0;
  for (let id = 0; id < bytes.length; id++) {
    const o = id * SLOT_STRIDE;
    if ((slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    if (wrap > 0 && c > 0 && c % wrap === 0) x = 0;        // this glyph starts a new visual row
    row[id] = rowBase + (wrap > 0 ? Math.floor(c / wrap) : 0);
    col[id] = c;
    xs[id] = x;
    if (slots[o + S_CODEPOINT] === NEWLINE) { rowBase += rowsForLine(c, wrap); c = 0; x = 0; }
    else { x += slots[o + S_ADVANCE]; c += 1; }
  }
  return { row, col, xs };
}
const ids = (n) => Array.from({ length: n }, (_, i) => i);
const shuffled = (r, n) => { const a = ids(n); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// f32 tolerance. x is a running sum of advances in f32, and f32 addition is NOT associative
// — inheriting at step 129 versus step 400 sums the same numbers in different groupings, so
// the result is order-independent as MATHEMATICS, not bit-for-bit. This is the bound on that,
// and the reason every discrete decision reads the exact row/col lanes instead.
const ftol = (v) => 1e-3 + Math.abs(v) * 1e-5;
const spreads = [];

for (const wrapWidth of [0, 24, 200]) {
  for (const { name, bytes } of CORPORA) {
    const base = runPipeline(bytes, trie, { window: 128, wrapWidth, lineHeight: CELL_H });
    const want = sequentialFold(bytes, base.slots, wrapWidth);

    const orders = [ids(bytes.length), ids(bytes.length).reverse()];
    for (let k = 0; k < N_ORDERS; k++) orders.push(shuffled(rng(4000 + k), bytes.length));

    let rowBad = 0, colBad = 0, xBad = 0, xWorst = 0, driftBad = 0;
    for (const order of orders) {
      const run = runPipeline(bytes, trie, { window: 128, wrapWidth, lineHeight: CELL_H, order });
      for (let id = 0; id < bytes.length; id++) {
        const o = id * SLOT_STRIDE;
        if ((run.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
        if (run.slots[o + S_ROW] !== want.row[id]) rowBad++;
        if (run.slots[o + S_COL] !== want.col[id]) colBad++;
        // exact lanes must also be bit-identical ORDER TO ORDER, not merely correct
        if (run.slots[o + S_ROW] !== base.slots[o + S_ROW]
         || run.slots[o + S_COL] !== base.slots[o + S_COL]) driftBad++;
        const dx = Math.abs(run.slots[o + S_X] - want.xs[id]);
        xWorst = Math.max(xWorst, dx);
        if (dx > ftol(want.xs[id])) xBad++;
      }
    }
    const tag = `${name} wrap=${wrapWidth}`;
    ok(rowBad === 0, `${tag}: ${rowBad} visual rows differ from the forward oracle`);
    ok(colBad === 0, `${tag}: ${colBad} columns differ from the forward oracle`);
    ok(driftBad === 0, `${tag}: ${driftBad} exact lanes drifted across dispatch orders`);
    ok(xBad === 0, `${tag}: ${xBad} x positions beyond f32 tolerance (worst ${xWorst.toExponential(2)})`);
    if (wrapWidth === 200) spreads.push({ name, worst: xWorst });
  }
}

// THE COST BOUND wrap exists for: one line of a million glyphs. Without wrap the float sum
// reaches back to the line start; with it, never further than one wrap.
{
  const bytes = new TextEncoder().encode('{"k":' + '0123456789'.repeat(4000) + '}');
  const wrapped = runPipeline(bytes, trie, { wrapWidth: 200, lineHeight: CELL_H });
  const flat = runPipeline(bytes, trie, { wrapWidth: 0, lineHeight: CELL_H });
  let wrappedRows = 0, flatRows = 0, maxX = 0, wrappedMaxX = 0;
  for (let id = 0; id < bytes.length; id++) {
    const o = id * SLOT_STRIDE;
    if ((wrapped.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    wrappedRows = Math.max(wrappedRows, wrapped.slots[o + S_ROW]);
    flatRows = Math.max(flatRows, flat.slots[o + S_ROW]);
    maxX = Math.max(maxX, flat.slots[o + S_X]);
    wrappedMaxX = Math.max(wrappedMaxX, wrapped.slots[o + S_X]);
  }
  ok(flatRows === 0, `single-line unwrapped: ${flatRows} rows (expected 1 absurd row)`);
  ok(wrappedRows > 190, `single-line wrapped: only ${wrappedRows} rows`);
  ok(wrappedMaxX <= 200 * CELL_W + 1e-3, `single-line wrapped: x reaches ${wrappedMaxX.toFixed(1)}, past one wrap`);
  ok(maxX > 40000, `single-line unwrapped: x only reaches ${maxX.toFixed(0)} — corpus too small to show the problem`);
  console.log(`  single-line 40k: unwrapped x reaches ${maxX.toFixed(0)}; wrapped caps at ${wrappedMaxX.toFixed(1)} over ${wrappedRows + 1} rows`);
}

// ── pagination is pure: same input, any order, identical output ──
{
  const { bytes } = CORPORA[CORPORA.length - 1];
  const page = { pageRows: 12, lineHeight: CELL_H, pageCols: 30, colWidth: CELL_W, pageGapX: 4, pagesWide: 3, depthPerBand: 32, depthPerColumn: -4 };
  const a = runPipeline(bytes, trie, { page });
  const b = runPipeline(bytes, trie, { page, order: shuffled(rng(7), bytes.length) });
  let planeDiff = 0, posDiff = 0;
  for (let id = 0; id < bytes.length; id++) {
    const o = id * SLOT_STRIDE;
    if ((a.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    // z is a PURE function of the integer page assignment — one wobble here means a glyph
    // jumped a whole page, which is what keying pagination on the float position used to do
    // (measured: 119 slots on this corpus before row/col existed).
    if (a.slots[o + S_Z] !== b.slots[o + S_Z]) planeDiff++;
    if (Math.abs(a.slots[o + S_X] - b.slots[o + S_X]) > ftol(a.slots[o + S_X])
     || Math.abs(a.slots[o + S_Y] - b.slots[o + S_Y]) > ftol(a.slots[o + S_Y])) posDiff++;
  }
  ok(planeDiff === 0, `paginate: ${planeDiff} slots landed on a DIFFERENT PAGE depending on dispatch order`);
  ok(posDiff === 0, `paginate: ${posDiff} positions beyond f32 tolerance`);

  // and it actually moved things into more than one column and more than one depth plane
  const xs = new Set(), zs = new Set();
  for (let id = 0; id < bytes.length; id++) {
    const o = id * SLOT_STRIDE;
    if ((a.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    xs.add(Math.round(a.slots[o + S_X])); zs.add(Math.round(a.slots[o + S_Z]));
  }
  ok(zs.size > 1, `paginate: only ${zs.size} depth plane(s) — the fan never engaged`);
  ok(xs.size > 4, `paginate: only ${xs.size} distinct x — vacuous`);

  // The DERIVED stride law: pageStrideX is never a CPU input — it is the item's widest
  // walk row + pageGapX. A fan-column-1 glyph therefore sits EXACTLY that far right of
  // its own base x.
  const expectStride = a.itemBounds[0].maxRowExtent + page.pageGapX;
  let strideBad = 0, strideChecked = 0;
  for (let id = 0; id < bytes.length; id++) {
    const o = id * SLOT_STRIDE;
    if ((a.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    const yPage = Math.floor(a.slots[o + S_ROW] / page.pageRows);
    if (yPage % page.pagesWide !== 1) continue;   // fan column 1: offset = stride × 1
    strideChecked++;
    if (Math.abs((a.slots[o + S_X] - a.slots[o + S_BASE_X]) - expectStride) > 1e-3) strideBad++;
  }
  ok(strideChecked > 50 && strideBad === 0,
    `derived stride: ${strideBad} of ${strideChecked} column-1 glyphs off the maxRowExtent+gap law`);
}

// ── bounds: equals a naive walk, and contains every quad ──
for (const { name, bytes } of CORPORA) {
  for (const page of [null, { pageRows: 12, lineHeight: CELL_H, pageCols: 30, colWidth: CELL_W, pageGapX: 4, pagesWide: 3, depthPerBand: 32, depthPerColumn: -4 }]) {
    const run = runPipeline(bytes, trie, page ? { page } : {});
    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let id = 0; id < bytes.length; id++) boundsReduce(run.slots, id, box);
    const b = run.bounds;
    ok(!!b, `${name}${page ? ' paged' : ''}: bounds produced`);
    if (!b) continue;
    ok(b.min.x === box[0] && b.min.y === box[1] && b.min.z === box[2]
       && b.max.x === box[3] && b.max.y === box[4] && b.max.z === box[5],
       `${name}${page ? ' paged' : ''}: reduce differs from a second reduce`);
    let outside = 0;
    for (let id = 0; id < bytes.length; id++) {
      const o = id * SLOT_STRIDE;
      if ((run.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
      const x = run.slots[o + S_X], y = run.slots[o + S_Y], z = run.slots[o + S_Z];
      const w = run.slots[o + S_ADVANCE], h = run.slots[o + S_HEIGHT];
      if (x < b.min.x || y < b.min.y || z < b.min.z
       || x + w > b.max.x + 1e-9 || y + h > b.max.y + 1e-9 || z > b.max.z) outside++;
    }
    ok(outside === 0, `${name}${page ? ' paged' : ''}: ${outside} quads outside the box`);
  }
}

// ── multi-file: N items in ONE buffer, the walk never crosses a file boundary ──
// The hoist's spec: a multi-item runPipeline must reproduce, per item, exactly what a
// single-file run of that file produces (same origin + page params) — row/col exact,
// positions within the f32 tolerance — under any layout dispatch order. Plus the
// file-relative invariant: every item's first glyph is row 0, col 0.
{
  const PAGE_NEWS = { pageRows: 12, lineHeight: CELL_H, pageGapX: 4, pagesWide: 3, depthPerBand: 32, depthPerColumn: -4 };
  const defs = [
    { corpus: CORPORA[0], origin: { x: 0, y: 0, z: 0 }, page: PAGE_NEWS },
    { corpus: CORPORA[CORPORA.length - 1], origin: { x: 120, y: 6, z: -4 }, page: { scrollRows: 5 } },
    { corpus: CORPORA[Math.min(1, CORPORA.length - 1)], origin: { x: -30, y: -2, z: 9 }, page: null },
  ];
  const wrapWidth = 24, zStep = 0.21;
  let off = 0;
  const starts = defs.map((d) => { const s = off; off += d.corpus.bytes.length; return s; });
  const total = off;
  const concat = new Uint8Array(total);
  defs.forEach((d, i) => concat.set(d.corpus.bytes, starts[i]));
  const items = defs.map((d, i) => ({ byteStart: starts[i], byteCount: d.corpus.bytes.length, origin: d.origin, page: d.page }));

  const base = runPipeline(concat, trie, { wrapWidth, lineHeight: CELL_H, zStep, items });
  let relBad = 0, driftBad = 0, posBad = 0, isoBad = 0;

  // file-relative row/col: the walk floored at each file's first byte
  for (let i = 1; i < defs.length; i++) {
    const b = starts[i] * SLOT_STRIDE;
    if (base.slots[b + S_ROW] !== 0 || base.slots[b + S_COL] !== 0) relBad++;
  }

  // per-item equality with the single-file runs, under dispatch orders
  const singles = defs.map((d) => runPipeline(d.corpus.bytes, trie,
    { wrapWidth, lineHeight: CELL_H, zStep, origin: d.origin, page: d.page }));
  const orders = [ids(total)];
  for (let k = 0; k < 6; k++) orders.push(shuffled(rng(9000 + k), total));
  for (const order of orders) {
    const multi = runPipeline(concat, trie, { wrapWidth, lineHeight: CELL_H, zStep, items, order });
    for (let i = 0; i < defs.length; i++) {
      const single = singles[i];
      for (let id = 0; id < defs[i].corpus.bytes.length; id++) {
        const gm = (starts[i] + id) * SLOT_STRIDE, gs = id * SLOT_STRIDE;
        if ((multi.slots[gm + S_FLAGS] & F_LEADER) === 0) continue;
        if (multi.slots[gm + S_ROW] !== single.slots[gs + S_ROW]
         || multi.slots[gm + S_COL] !== single.slots[gs + S_COL]) driftBad++;
        if (multi.slots[gm + S_ROW] !== base.slots[gm + S_ROW]
         || multi.slots[gm + S_COL] !== base.slots[gm + S_COL]) driftBad++;
        for (const l of [S_X, S_Y, S_Z]) {
          if (Math.abs(multi.slots[gm + l] - single.slots[gs + l]) > ftol(single.slots[gs + l])) posBad++;
        }
      }
    }
  }

  // item isolation: re-run with item 1's origin + page changed — items 0 and 2 must not move
  {
    const items2 = defs.map((d, i) => ({ byteStart: starts[i], byteCount: d.corpus.bytes.length,
      origin: i === 1 ? { x: -400, y: 20, z: 3 } : d.origin,
      page: i === 1 ? PAGE_NEWS : d.page }));
    const re = runPipeline(concat, trie, { wrapWidth, lineHeight: CELL_H, zStep, items: items2 });
    for (const i of [0, 2]) {
      for (let id = 0; id < defs[i].corpus.bytes.length; id++) {
        const b = (starts[i] + id) * SLOT_STRIDE;
        for (const l of [S_X, S_Y, S_Z, S_ROW, S_COL]) {
          if (re.slots[b + l] !== base.slots[b + l]) { isoBad++; break; }
        }
      }
    }
  }

  // per-item bounds from the mirror: parallel to items, and each item's scalars are its own
  ok(base.itemBounds && base.itemBounds.length === defs.length, 'multi: itemBounds missing or wrong length');
  ok(base.itemBounds.every((b) => b && isFinite(b.min.x)), 'multi: an item has no bounds');
  ok(relBad === 0, `multi: ${relBad} items' first glyph not at row 0, col 0 (walk crossed a boundary)`);
  ok(driftBad === 0, `multi: ${driftBad} row/col lanes differ from the single-file runs (or drifted across orders)`);
  ok(posBad === 0, `multi: ${posBad} positions differ from the single-file runs beyond f32 tolerance`);
  ok(isoBad === 0, `multi: ${isoBad} slots outside item 1 moved when item 1's params changed (isolation broken)`);
}


{
  const bytes = new TextEncoder().encode('ab\u{1F4A9}cd\n\u{1F4A9}ef');
  const run = runPipeline(bytes, trie, {});
  ok(run.misses.length === 2, `missing: ${run.misses.length} reported (expected 2)`);
  ok(run.misses.every((cp) => cp === 0x1F4A9), 'missing: reported the right codepoint');
  // 'c' must sit one full cell past the un-encoded emoji's advance, not on top of it.
  const cIdx = [...bytes].findIndex((_, i) => run.slots[i * SLOT_STRIDE + S_CODEPOINT] === 0x63);
  ok(run.slots[cIdx * SLOT_STRIDE + S_X] > CELL_W * 2.5,
     'missing: an un-encoded glyph still occupies its advance');
}

console.log('\nf32 placement spread across dispatch orders (window 128):');
for (const sp of spreads) console.log(`  ${sp.name.padEnd(52)} ${sp.worst.toExponential(2)} world units (cell = ${CELL_W})`);
console.log(`\n${fail === 0 ? '✓' : '✗'} glyph-pipeline: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
