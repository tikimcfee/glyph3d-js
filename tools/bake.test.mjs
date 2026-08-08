// bake.test.mjs — the bake vs the oracle, without a GPU.
//   bun tools/bake.test.mjs [--seeds 60]
//
// glyphBake.js is the IDEMPOTENT fold: one streaming pass over a file's bytes → the
// record (total summary, checkpoints, intrinsic scalars, box, line histogram, census).
// This proves the record against glyphPipelineReference (the semantic oracle):
//
//   agreement     bake scalars/box == runPipeline itemBounds at wrap 0 — integer
//                 lanes BIT-EXACT, float lanes eps-bounded (serial fround vs the
//                 oracle's f64 truth layer, same tolerance scan-layout uses)
//   seeding       prefixAt (checkpoint + ≤K tail fold) == the full fold from byte 0,
//                 BIT-IDENTICAL every lane — the random-access-layout property the
//                 whole index exists for. A serial fold resumed from its own saved
//                 state is the same fold; nothing may drift.
//   lanes         lanesFromPrefix over prefixAt == the oracle's slot lanes at every
//                 sampled leader (row/col/ord exact, lineAdv eps)
//   rows(w)       rowsUnderWrap == oracle totalRows under EVERY wrap width — the
//                 histogram answers a question the bake never ran
//   census        every leader codepoint is in the census; misses are reported
//   idempotency   two bakes of the same bytes are deep-equal, checkpoints byte-equal

import { buildGlyphTrie } from '../packages/glyph3d-core/src/compute/GlyphTrie.js';
import {
  runPipeline, SLOT_STRIDE, S_CODEPOINT, S_ROW, S_COL, S_ORD, S_LINE_ADV, S_FLAGS, F_LEADER,
} from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import { scanIdentity, lanesFromPrefix } from '../packages/glyph3d-core/src/compute/glyphPipelineScan.js';
import {
  bakeFile, foldBytes, prefixAt, rowsUnderWrap, checkpointAt, CK_STRIDE,
} from '../packages/glyph3d-core/src/compute/glyphBake.js';
import { encodeBakeIndex, decodeBakeIndex } from '../packages/glyph3d-core/src/compute/glyphBakeIndex.js';
import {
  windowSeedable, windowSeedAt, byteRangeForRows, runWindow,
} from '../packages/glyph3d-core/src/compute/glyphPipelineWindow.js';
import { deriveStride, S_X, S_Y, S_Z, S_BASE_X, S_ADVANCE, S_HEIGHT, S_GLYPH_ID } from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('--seeds', 60);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eps = (a, b, m) => ok(Math.abs(a - b) / Math.max(1, Math.abs(a)) <= 1e-4, `${m}: ${a} vs ${b}`);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── the stand-in atlas (same shape as scan-layout.test.mjs) ──
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

const CORPORA = [
  ['torture', TORTURE],
  ['empty', ''],
  ['one-newline', '\n'],
  ['no-trailing-nl', 'tail without newline'],
  ['trailing-nl', 'closed line\n'],
  ['single-line-5k', 'x'.repeat(5000)],
  ['empty-heavy', '\n\n\na\n\n\nb\n\n'],
  ['emoji-boundary', ('ab\u{1F600}'.repeat(40) + '\n').repeat(6)],
  ['wrap-multiple', 'x'.repeat(48) + '\n' + 'y'.repeat(24) + '\n'],
];

// ── 1. agreement: bake record vs the oracle at wrap 0 ──
for (const [name, text] of CORPORA) {
  const bytes = enc.encode(text);
  const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 64 });
  const oracle = runPipeline(bytes, trie, { wrapWidth: 0, lineHeight: CELL_H });
  const b = oracle.itemBounds[0];

  ok(rec.leaders === oracle.leaders, `${name}: leaders ${rec.leaders} vs ${oracle.leaders}`);
  ok(rec.byteLength === bytes.length, `${name}: byteLength`);
  if (!b) {
    ok(rec.box === null && rec.totalRows === 0, `${name}: empty file bakes an empty record`);
  } else {
    ok(rec.totalRows === b.totalRows, `${name}: totalRows ${rec.totalRows} vs ${b.totalRows}`);
    eps(rec.maxRowExtent, b.maxRowExtent, `${name}: maxRowExtent`);
    eps(rec.box.min.x, b.min.x, `${name}: box.min.x`);
    eps(rec.box.min.y, b.min.y, `${name}: box.min.y`);
    eps(rec.box.max.x, b.max.x, `${name}: box.max.x`);
    eps(rec.box.max.y, b.max.y, `${name}: box.max.y`);
    ok(rec.box.min.z === 0 && rec.box.max.z === 0, `${name}: wrap-0 box is flat`);
  }

  // total is the fold of the whole file — foldBytes from identity must agree exactly.
  const full = foldBytes(bytes, trie, 0, bytes.length, scanIdentity());
  for (const k of ['nl', 'glyphs', 'rows', 'headLen', 'tailLen', 'tailAdv']) {
    ok(rec.total[k] === full[k], `${name}: total.${k}`);
  }
}

// ── 2. seeding: checkpoint + tail fold ≡ full fold, bit-identical ──
for (const [name, text] of CORPORA) {
  const bytes = enc.encode(text);
  if (bytes.length === 0) continue;
  const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 64 });
  const r = rng(77);
  const probes = new Set([0, 1, bytes.length - 1, bytes.length, 63, 64, 65, 128]);
  for (let t = 0; t < 40; t++) probes.add(Math.floor(r() * (bytes.length + 1)));
  let bad = 0;
  for (const p of probes) {
    if (p > bytes.length) continue;
    const seeded = prefixAt(bytes, trie, rec, p);
    const full = foldBytes(bytes, trie, 0, p, scanIdentity());
    for (const k of ['nl', 'glyphs', 'rows', 'headLen', 'tailLen', 'tailAdv']) {
      if (seeded[k] !== full[k]) bad++;
    }
  }
  ok(bad === 0, `${name}: ${bad} seeded-vs-full lane mismatches`);
}

// ── 3. lanes: prefixAt → lanesFromPrefix ≡ the oracle's slots ──
for (const [name, text] of CORPORA) {
  const bytes = enc.encode(text);
  if (bytes.length === 0) continue;
  const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 64 });
  const oracle = runPipeline(bytes, trie, { wrapWidth: 0, lineHeight: CELL_H });
  const r = rng(99);
  let bad = 0, checked = 0;
  for (let t = 0; t < 60 && checked < 40; t++) {
    const id = Math.floor(r() * bytes.length);
    const o = id * SLOT_STRIDE;
    if ((oracle.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    checked++;
    const lanes = lanesFromPrefix(prefixAt(bytes, trie, rec, id), 0);
    if (lanes.row !== oracle.slots[o + S_ROW]) bad++;
    if (lanes.col !== oracle.slots[o + S_COL]) bad++;
    if (lanes.ord !== oracle.slots[o + S_ORD]) bad++;
    if (Math.abs(lanes.lineAdv - oracle.slots[o + S_LINE_ADV]) / Math.max(1, Math.abs(lanes.lineAdv)) > 1e-4) bad++;
  }
  ok(bad === 0, `${name}: ${bad} lane mismatches over ${checked} sampled leaders`);
}

// ── 4. rows under every wrap: the histogram answers what the bake never ran ──
for (const [name, text] of CORPORA) {
  const bytes = enc.encode(text);
  const rec = bakeFile(bytes, trie, { lineHeight: CELL_H });
  for (const w of [0, 1, 2, 3, 5, 24, 200]) {
    const oracle = runPipeline(bytes, trie, { wrapWidth: w, lineHeight: CELL_H });
    const want = oracle.itemBounds[0]?.totalRows ?? 0;
    const got = rowsUnderWrap(rec, w);
    ok(got === want, `${name} wrap=${w}: rowsUnderWrap ${got} vs oracle ${want}`);
  }
}

// ── 5. census + misses ──
{
  const bytes = enc.encode(TORTURE);
  const rec = bakeFile(bytes, trie, { lineHeight: CELL_H });
  const oracle = runPipeline(bytes, trie, {});
  const census = new Set(rec.census);
  let absent = 0;
  for (let id = 0; id < bytes.length; id++) {
    const o = id * SLOT_STRIDE;
    if ((oracle.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
    if (!census.has(oracle.slots[o + S_CODEPOINT])) absent++;
  }
  ok(absent === 0, `census: ${absent} leader codepoints absent`);
  ok(new Set(oracle.misses).size === rec.missing.length,
    `misses: bake reports ${rec.missing.length}, oracle saw ${new Set(oracle.misses).size} unique`);
}

// ── 6. idempotency: same bytes, same record — bit for bit ──
{
  let diffs = 0;
  for (let s = 0; s < SEEDS; s++) {
    const r = rng(3000 + s);
    const bytes = enc.encode(randomText(r, 6 + Math.floor(r() * 24)));
    const a = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 128 });
    const b = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 128 });
    if (a.checkpoints.length !== b.checkpoints.length) diffs++;
    else for (let i = 0; i < a.checkpoints.length; i++) if (a.checkpoints[i] !== b.checkpoints[i]) diffs++;
    for (const k of ['byteLength', 'leaders', 'newlines', 'totalRows', 'maxRowExtent', 'maxLineWidth', 'maxHeight']) {
      if (a[k] !== b[k]) diffs++;
    }
    if (JSON.stringify([...a.lineHist]) !== JSON.stringify([...b.lineHist])) diffs++;
    if (a.census.join() !== b.census.join()) diffs++;
  }
  ok(diffs === 0, `idempotency: ${diffs} differences across ${SEEDS} re-bakes`);
}

// ── 7. randomized sweep: agreement + seeding under fuzz ──
{
  for (let s = 0; s < SEEDS; s++) {
    const r = rng(6000 + s);
    const bytes = enc.encode(randomText(r, 4 + Math.floor(r() * 30)));
    if (bytes.length === 0) continue;
    const K = 1 + Math.floor(r() * 200);
    const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: K });
    const oracle = runPipeline(bytes, trie, { wrapWidth: 0, lineHeight: CELL_H });
    const b = oracle.itemBounds[0];
    ok(rec.totalRows === (b?.totalRows ?? 0), `seed ${6000 + s}: totalRows`);
    const p = Math.floor(r() * (bytes.length + 1));
    const seeded = prefixAt(bytes, trie, rec, p);
    const full = foldBytes(bytes, trie, 0, p, scanIdentity());
    ok(seeded.nl === full.nl && seeded.glyphs === full.glyphs && seeded.tailAdv === full.tailAdv,
      `seed ${6000 + s}: seeding at ${p} (K=${K})`);
    const w = [0, 1, 3, 17][s % 4];
    const wrapped = runPipeline(bytes, trie, { wrapWidth: w, lineHeight: CELL_H });
    ok(rowsUnderWrap(rec, w) === (wrapped.itemBounds[0]?.totalRows ?? 0), `seed ${6000 + s}: rows(w=${w})`);
  }
}

// checkpointAt round-trip sanity: the stored lanes rebuild the element foldBytes reached.
{
  const bytes = enc.encode(TORTURE);
  const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 32 });
  const nCk = rec.checkpoints.length / CK_STRIDE;
  let bad = 0;
  for (let i = 0; i < nCk; i++) {
    const stored = checkpointAt(rec.checkpoints, i);
    const full = foldBytes(bytes, trie, 0, (i + 1) * 32, scanIdentity());
    for (const k of ['nl', 'glyphs', 'rows', 'headLen', 'tailLen', 'tailAdv']) {
      if (stored[k] !== full[k]) bad++;
    }
  }
  ok(bad === 0, `checkpoint round-trip: ${bad} mismatches over ${nCk} checkpoints`);
}

// ── 8. binary index round-trip: encode → decode ≡ the records that went in ──
{
  const fakeHash = (seed) => { const h = new Uint8Array(32); for (let i = 0; i < 32; i++) h[i] = (seed * 31 + i * 7) & 0xFF; return h; };
  const paths = CORPORA.map(([name]) => `dir/${name}.txt`);
  const entries = CORPORA.map(([name, text], i) => ({
    path: paths[i],
    hash: fakeHash(i),
    record: bakeFile(enc.encode(text), trie, { lineHeight: CELL_H, checkpointInterval: 64 }),
  }));
  const census = new Set();
  for (const e of entries) for (const cp of e.record.census) census.add(cp);
  const header = {
    fontSize: 48, worldScale: 0.025, lineHeight: CELL_H,
    charSize: { width: 29, height: 54.375 }, checkpointInterval: 64, metricsHash: '0123456789abcdef',
  };
  const bin = encodeBakeIndex(header, Uint32Array.from([...census].sort((a, b) => a - b)), entries);
  const d = decodeBakeIndex(bin);

  ok(d.header.metricsHash === header.metricsHash && d.header.lineHeight === CELL_H
    && d.header.charSize.width === 29 && d.header.charSize.height === 54.375
    && d.header.checkpointInterval === 64 && d.header.fileCount === entries.length,
    'binary: header round-trips');
  ok(d.census.length === census.size, 'binary: census round-trips');

  let bad = 0;
  for (let i = 0; i < entries.length; i++) {
    const want = entries[i].record, got = d.recordAt(d.pathIndex.get(paths[i]));
    for (const k of ['byteLength', 'leaders', 'newlines', 'totalRows', 'maxRowExtent', 'maxLineWidth', 'maxHeight', 'maxLineLen']) {
      if (got[k] !== want[k]) { bad++; console.log(`  binary ${paths[i]}: ${k} ${got[k]} vs ${want[k]}`); }
    }
    for (const k of ['nl', 'glyphs', 'rows', 'headLen', 'tailLen', 'tailAdv']) {
      if (got.total[k] !== want.total[k]) bad++;
    }
    if (got.checkpoints.length !== want.checkpoints.length) bad++;
    else for (let c = 0; c < want.checkpoints.length; c++) if (got.checkpoints[c] !== want.checkpoints[c]) bad++;
    if (JSON.stringify([...got.lineHist].sort((a, b) => a[0] - b[0])) !== JSON.stringify([...want.lineHist].sort((a, b) => a[0] - b[0]))) bad++;
    if (!!got.box !== !!want.box) bad++;
    else if (got.box && (Math.abs(got.box.min.y - want.box.min.y) > 1e-12 || got.box.max.y !== want.box.max.y || got.box.max.x !== want.box.max.x)) bad++;
    const hh = d.hashAt(i);
    for (let b = 0; b < 32; b++) if (hh[b] !== entries[i].hash[b]) bad++;
    // rowsUnderWrap through the decoded record — the consumer's actual query.
    for (const w of [0, 3, 24]) if (rowsUnderWrap(got, w) !== rowsUnderWrap(want, w)) bad++;
  }
  ok(bad === 0, `binary: ${bad} record lanes diverged through the round-trip`);

  // Deterministic: encoding the same entries twice is byte-identical.
  const bin2 = encodeBakeIndex(header, Uint32Array.from([...census].sort((a, b) => a - b)), entries);
  let diff = bin.length === bin2.length ? 0 : 1;
  for (let i = 0; i < bin.length && !diff; i++) if (bin[i] !== bin2[i]) diff = 1;
  ok(diff === 0, 'binary: encode is deterministic');

  // Unaligned fetch: decode must survive a buffer whose byteOffset % 8 ≠ 0.
  const shifted = new Uint8Array(bin.length + 4);
  shifted.set(bin, 4);
  const d2 = decodeBakeIndex(shifted.subarray(4));
  ok(d2.header.fileCount === entries.length && d2.recordAt(0).leaders === entries[0].record.leaders,
    'binary: unaligned buffer decodes');
}

// ── 9. THE WINDOW: seeded materialization ≡ the full run, lane for lane ──
{
  const winDiff = (name, fullSlots, winSlots, from, to, fold) => {
    let bad = null;
    const EXACT = [S_CODEPOINT, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_ROW, S_COL, S_FLAGS, S_ORD];
    for (let id = from; id < to && !bad; id++) {
      const o = id * SLOT_STRIDE;
      if ((fullSlots[o + S_FLAGS] & F_LEADER) === 0) continue;
      for (const l of EXACT) if (winSlots[o + l] !== fullSlots[o + l]) bad = { id, l, why: 'exact lane' };
      for (const l of [S_X, S_Y, S_Z, S_BASE_X, S_LINE_ADV]) {
        const a = fullSlots[o + l], b = winSlots[o + l];
        if (fold > 0 && l !== S_LINE_ADV) {
          if (a !== b) bad = { id, l, why: 'fold>0 float lane must be bit-exact' };
        } else if (Math.abs(a - b) / Math.max(1, Math.abs(a)) > 1e-4) {
          bad = { id, l, why: `rel ${(Math.abs(a - b) / Math.max(1, Math.abs(a))).toExponential(2)}` };
        }
      }
    }
    ok(!bad, `${name}: window slot ${bad?.id} lane ${bad?.l} — ${bad?.why}`);
  };

  const PAGE = { pageRows: 6, pagesWide: 2, pageGapX: 3, bandStrideY: 11, depthPerBand: 2 };
  const lanes = [
    { wrapWidth: 0, lineHeight: CELL_H },
    { wrapWidth: 100, lineHeight: CELL_H, zStep: 0.21 },
    { wrapWidth: 0, page: { ...PAGE, pageCols: 40 }, lineHeight: CELL_H },
    { wrapWidth: 100, page: PAGE, lineHeight: CELL_H },
  ];
  let windows = 0, nulls = 0;
  for (let s = 0; s < SEEDS; s++) {
    const r = rng(9000 + s);
    const bytes = enc.encode(randomText(r, 10 + Math.floor(r() * 40)));
    if (bytes.length < 8) continue;
    const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 1 + Math.floor(r() * 150) });
    const lane = lanes[s % lanes.length];
    const wrap = lane.wrapWidth || 0;
    const fold = wrap > 0 ? wrap : (lane.page?.pageCols || 0);
    if (!windowSeedable(rec, wrap)) { nulls++; continue; }   // randomText lines < 91 < wrap 100 — all lanes seedable

    const full = runPipeline(bytes, trie, lane);
    const stride = deriveStride({ maxRowExtent: full.itemBounds[0]?.maxRowExtent ?? 0 }, lane.page);

    // seed check: windowSeedAt's prefix is the true prefix at `from`, bit for bit.
    const target = Math.floor(r() * bytes.length);
    const ws = windowSeedAt(bytes, trie, rec, target, wrap, fold);
    ok(!!ws && ws.from <= target, `seed ${9000 + s}: windowSeedAt found a start`);
    if (ws) {
      const truth = foldBytes(bytes, trie, 0, ws.from, scanIdentity());
      let sBad = 0;
      for (const k of ['nl', 'glyphs', 'rows', 'headLen', 'tailLen', 'tailAdv']) if (ws.seed[k] !== truth[k]) sBad++;
      ok(sBad === 0, `seed ${9000 + s}: windowSeedAt seed ≡ full fold`);
    }

    // rows → byte range → materialize → compare against the full run.
    const totalRows = full.itemBounds[0]?.totalRows ?? 0;
    if (totalRows < 2) continue;
    const r0 = Math.floor(r() * (totalRows - 1));
    const r1 = Math.min(totalRows, r0 + 1 + Math.floor(r() * 10));
    const win = byteRangeForRows(bytes, trie, rec, r0, r1, wrap);
    ok(!!win, `seed ${9000 + s}: byteRangeForRows(${r0},${r1})`);
    if (!win) continue;

    const wres = runWindow(bytes, trie, {
      origin: undefined, page: lane.page, wrapWidth: lane.wrapWidth,
      lineHeight: lane.lineHeight, zStep: lane.zStep || 0, pageStrideX: stride,
    }, win);
    winDiff(`seed ${9000 + s} fold=${fold} rows[${r0},${r1})`, full.slots, wres.slots, win.from, win.to, fold);

    // Coverage: every leader in rows [r0, r1) lies inside the window.
    let missed = 0;
    for (let id = 0; id < bytes.length; id++) {
      const o = id * SLOT_STRIDE;
      if ((full.slots[o + S_FLAGS] & F_LEADER) === 0) continue;
      const row = full.slots[o + S_ROW];
      if (row >= r0 && row < r1 && (id < win.from || id >= win.to)) missed++;
    }
    ok(missed === 0, `seed ${9000 + s}: ${missed} leaders of rows [${r0},${r1}) fell outside the window`);
    windows++;
  }
  console.log(`  window sweep: ${windows} windows proven, ${nulls} unseedable folds refused`);

  // The refusal contract: a WRAP narrower than the longest line returns null —
  // but the same file stays seedable unwrapped, pageCols fold or not.
  const longLine = enc.encode('x'.repeat(300) + '\nshort\n');
  const rec = bakeFile(longLine, trie, { lineHeight: CELL_H });
  ok(!windowSeedable(rec, 100) && windowSeedAt(longLine, trie, rec, 50, 100) === null
    && byteRangeForRows(longLine, trie, rec, 0, 2, 100) === null,
    'window: wrapping lines refuse wrap-0 seeds (null, caller falls back loud)');
  ok(windowSeedable(rec, 0) && !!byteRangeForRows(longLine, trie, rec, 0, 2, 0)
    && !!windowSeedAt(longLine, trie, rec, 250, 0, 40),
    'window: the same file is seedable unwrapped — pageCols fold included');
}

// ── 10. window-AS-ITEM: the runtime's windowed staging trick. A window staged as
//        its own arena item (fresh fold, reset at start) + the scrollRows bias
//        (scroll − startRow) reproduces the full fold's POSITIONS bit-for-bit —
//        which is why windowed staging needs NO seeded GPU dispatch: the item
//        reset IS the seed, because windows snap to row starts where every fold
//        counter is zero. (In the seedable regime no line wraps, so wrap-segment
//        z is uniform too — nothing off-window can move a position.) ──
{
  let checked = 0;
  for (let t = 0; t < SEEDS; t++) {
    const r = rng(11000 + t);
    const bytes = enc.encode(randomText(r, 20 + Math.floor(r() * 40)));
    if (bytes.length < 16) continue;
    const wrap = [0, 0, 100][t % 3];
    const lane = { wrapWidth: wrap, lineHeight: CELL_H, zStep: wrap ? 0.21 : 0 };
    const rec = bakeFile(bytes, trie, { lineHeight: CELL_H, checkpointInterval: 1 + Math.floor(r() * 100) });
    if (!windowSeedable(rec, wrap)) continue;
    const full0 = runPipeline(bytes, trie, { ...lane });
    const totalRows = full0.itemBounds[0]?.totalRows ?? 0;
    if (totalRows < 4) continue;

    const scroll = Math.floor(r() * totalRows);
    const r0 = Math.max(0, scroll - Math.floor(r() * 5));           // startRow ≤ scroll
    const r1 = Math.min(totalRows, scroll + 1 + Math.floor(r() * 12));
    if (r1 <= r0) continue;
    const win = byteRangeForRows(bytes, trie, rec, r0, r1, wrap);
    ok(!!win, `window-item seed ${11000 + t}: byteRangeForRows`);
    if (!win) continue;

    const full = runPipeline(bytes, trie, { ...lane, scrollRows: scroll });
    const winRun = runPipeline(bytes.subarray(win.from, win.to), trie, { ...lane, scrollRows: scroll - r0 });
    let bad = 0;
    for (let id = win.from; id < win.to; id++) {
      const fo = id * SLOT_STRIDE, wo = (id - win.from) * SLOT_STRIDE;
      if ((full.slots[fo + S_FLAGS] & F_LEADER) === 0) continue;
      if (full.slots[fo + S_CODEPOINT] !== winRun.slots[wo + S_CODEPOINT]) bad++;
      for (const l of [S_X, S_Y, S_Z]) {
        if (full.slots[fo + l] !== winRun.slots[wo + l]) bad++;     // BIT-exact, no eps
      }
    }
    ok(bad === 0, `window-item seed ${11000 + t} wrap=${wrap} scroll=${scroll} rows[${r0},${r1}): ${bad} position lanes differ`);
    checked++;
  }
  console.log(`  window-as-item sweep: ${checked} staged windows position-identical, bit for bit`);
}

// ── 11. THE PAD INVARIANT (the edit fast path rests on this): a 0x80-padded
//        buffer lays out IDENTICALLY to its bare content. Bare continuation
//        bytes are structural non-leaders — decode, fold, resolveX, paginate,
//        bounds and ordinals all skip them — so an item staged with edit slack
//        renders its content and NOTHING else, and an in-place rewrite that
//        moves the content/pad boundary can never disturb layout. ──
{
  let checked = 0;
  for (let t = 0; t < SEEDS; t++) {
    const r = rng(13000 + t);
    const content = enc.encode(randomText(r, 4 + Math.floor(r() * 20)));
    if (content.length === 0) continue;
    const slack = 1 + Math.floor(r() * 300);
    const padded = new Uint8Array(content.length + slack);
    padded.set(content);
    padded.fill(0x80, content.length);
    const lane = { wrapWidth: [0, 3, 40][t % 3], lineHeight: CELL_H, scrollRows: Math.floor(r() * 8) };
    const bare = runPipeline(content, trie, lane);
    const pad = runPipeline(padded, trie, lane);
    let bad = 0;
    for (let id = 0; id < content.length; id++) {
      for (let l = 0; l < SLOT_STRIDE; l++) {
        if (bare.slots[id * SLOT_STRIDE + l] !== pad.slots[id * SLOT_STRIDE + l]) bad++;
      }
    }
    for (let id = content.length; id < padded.length; id++) {
      if (pad.slots[id * SLOT_STRIDE + S_FLAGS] & F_LEADER) bad++;   // pad must stay inert
    }
    const bb = bare.itemBounds[0], pb = pad.itemBounds[0];
    if (!!bb !== !!pb || (bb && (bb.totalRows !== pb.totalRows
      || bb.max.x !== pb.max.x || bb.min.y !== pb.min.y || bb.maxRowExtent !== pb.maxRowExtent))) bad++;
    if (bare.leaders !== pad.leaders) bad++;
    ok(bad === 0, `pad seed ${13000 + t} slack=${slack}: ${bad} divergences`);
    checked++;
  }
  console.log(`  pad-invariant sweep: ${checked} padded buffers bit-identical to bare content`);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} bake: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
