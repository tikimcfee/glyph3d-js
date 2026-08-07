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

console.log(`\n${fail === 0 ? '✓' : '✗'} bake: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
