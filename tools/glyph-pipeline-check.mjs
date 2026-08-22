// glyph-pipeline-check.mjs — the Layer 2 GPU gate: the byte-in pipeline's TSL kernels
// (packages/glyph3d-core/src/compute/glyphPipelineKernels.js) vs their proven executable
// spec (compute/glyphPipelineReference.js), on real hardware.
//
// The spec is proven headlessly (tools/glyph-pipeline.test.mjs, tools/backtrack-layout.test.mjs).
// The TSL has NEVER EXECUTED — this harness is the first run, and it answers the handoff's
// three open questions:
//   1. does TSL's Loop/Break express the walk (or is wgslFn needed)?
//   2. the coherence window on this hardware (correctness must hold at ANY window, 0 included —
//      the window is a cost/visibility dial, not a correctness parameter)
//   3. real dispatch cost on real scheduling
//
// The check, per lane: same bytes through runPipeline() (CPU spec) and through
// setFile/run/readSlots/readItemBounds/readMisses (GPU), then diff every slot. row/col/
// flags/codepoint must be EXACT (the integer-lane law); x/y/z within eps (f32,
// order-free). A repaginate lane proves strides+kernel-3 alone re-fold a mode switch.
//
// MULTI-FILE lanes (the hoist): 2-3 corpora concatenated into ONE buffer as items with
// different origins + page params, through setFiles/run vs runPipeline({items}). Asserts
// row/col are file-relative (every item's first glyph is row 0, col 0), the PER-ITEM
// bounds table matches itemBounds (box + totalRows + maxRowExtent, per item — the
// records the arena's one post-flush readback distributes), and ITEM ISOLATION:
// re-running with one item's origin+page changed must leave every other item's slots
// bit-identical.
//
//   bun tools/glyph-pipeline-check.mjs                     # all lanes
//   bun tools/glyph-pipeline-check.mjs --eps 1e-4 --json
//   bun tools/glyph-pipeline-check.mjs --headed            # watch it
//
// SAFETY: never dials the relay (no relayPort, no ?relay) — client-only, like
// layout-kernel-check. Exit: 0 only when every lane passes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const EPS = Number(flag('--eps', '1e-3'));
const AS_JSON = has('--json');
const HEADED = has('--headed');
const WAIT = Number(flag('--wait', '8000'));
// A worktree runs its own Vite on its own port — point the gate at it (the default
// stays the normal checkout's dev loop).
const URL_ = flag('--url', 'http://localhost:5173/');

// ---- corpora (strings cross the boundary; bytes are TextEncoder-encoded in-page) ----
// The fixture atlas covers: 0x09-0x0D, 0x20-0x7E, 0xA0-0xFF, 0x2500-0x257F,
// 0x4E00-0x4E7F (wide+tall), 0x1F600-0x1F64F (double advance). 0x0370 is deliberately
// OUTSIDE — the miss path must record it and still occupy its advance.
const TORTURE = [
  'const answer = 42;',
  '',
  '    leading spaces and trailing spaces    ',
  '\ttab\tseparated\tcolumns',
  '',
  'unicode: éèê αβγ 你好 ─┬┐',
  'xy\u{1F600}z',
  'emoji: \u{1F389} done ✅ fast \u{1F680}',
  'astral: \u{1D400}\u{1D401}\u{1D402} \u{1F4A1}',
  'miss: Ͱͱ lands on the missing block',
  'x'.repeat(337),
  '',
  '',
  'function tail(a, b) { return a + b; }',
  'end',
].join('\n');
const SINGLE_LINE = 'x'.repeat(40000);   // the wrap-is-the-cost-bound corpus
const REAL_FILE = 'packages/glyph3d-core/src/compute/GlyphTrie.js';

const corpora = [
  { name: 'torture', text: TORTURE },
  { name: 'single-line-40k', text: SINGLE_LINE },
  { name: path.basename(REAL_FILE), text: readFileSync(path.join(REPO, REAL_FILE), 'utf8') },
];

// ---- lanes: wrap × page × scroll. ----
const PAGE_OFF = null;
const PAGE_NEWS = { pageRows: 8, pageCols: 0, colWidth: 0, pageGapX: 3, pagesWide: 2, depthPerBand: 5, depthPerColumn: 0, bandStrideY: 13.2 };
const PAGE_Z = { pageRows: 8, pageCols: 0, pagesWide: 1, depthPerBand: 20, depthPerColumn: 0 };
// MetalLink's max-page-width fold: an over-wide line breaks into depth pages
// (xPages = floor(col / pageCols), z recedes per column — Compute.metal:396).
const PAGE_COLS = { pageRows: 0, pageCols: 200, pagesWide: 1, depthPerBand: 0, depthPerColumn: 4 };
const lanes = [
  // The old walk's expectFail lane, now a PASS: with no fold unit, x IS the line prefix
  // — exact at any length. The 40k single line is the lane that proves the fuse is gone.
  { wrapWidth: 0, page: PAGE_OFF },
  { wrapWidth: 24, page: PAGE_OFF },
  { wrapWidth: 200, page: PAGE_OFF },
  { wrapWidth: 200, page: PAGE_NEWS },
  { wrapWidth: 200, page: PAGE_Z },
  { wrapWidth: 200, page: PAGE_NEWS, repaginateTo: PAGE_Z },  // strides+paginate alone re-fold, from base
  { wrapWidth: 0, page: PAGE_COLS, onlyOn: 'single-line-40k' },  // the long line folds into depth pages
  { wrapWidth: 0, page: PAGE_COLS, onlyOn: 'single-line-40k',    // fold-unit retune: resolveX+strides+paginate,
    refoldTo: { pageRows: 0, pageCols: 120, pageStrideX: 0, pagesWide: 1, depthPerBand: 0, depthPerColumn: 4 } }, // NO re-scan
  { wrapWidth: 200, page: PAGE_NEWS, scrollRows: 12 },   // the conveyor, paginated
  { wrapWidth: 200, page: null, scrollRows: 12 },        // scroll without pagination
  { wrapWidth: 200, page: PAGE_NEWS, onlyOn: 'GlyphTrie.js', liveTrie: true },  // the REAL atlas's trie
  { wrapWidth: 200, page: PAGE_Z, onlyOn: 'GlyphTrie.js', liveTrie: true },
];
const ZSTEP = 0.21;   // 0.15 × CELL_H — the app's long-column zWrapSpacing, in world units

// ---- MULTI-FILE lanes: N items concatenated in ONE buffer, ONE set of dispatches (the
// multi-file hoist). Each item carries its own origin + page params; the walk must floor
// at each file's first byte (row/col file-relative) and no item's params may leak into
// another. isolateChange re-runs the batch with one item's origin+page replaced and
// asserts every OTHER item's slots are bit-identical (item isolation).
const MULTI = [
  { name: 'multi: torture+GlyphTrie (news|z)', wrapWidth: 200,
    items: [
      { corpus: 'torture', origin: { x: 0, y: 0, z: 0 }, page: PAGE_NEWS },
      { corpus: path.basename(REAL_FILE), origin: { x: 120, y: 6, z: -4 }, page: PAGE_Z },
    ],
    isolateChange: { itemIndex: 1, origin: { x: -55, y: 2.5, z: 9 },
      page: { pageRows: 5, pageCols: 0, pageGapX: 5, pagesWide: 3, depthPerBand: 8, depthPerColumn: 0, bandStrideY: 21 } } },
  { name: 'multi: 3 items (scroll|cols|z)', wrapWidth: 24,
    items: [
      { corpus: 'torture', origin: { x: 3, y: 0, z: 0 }, page: { scrollRows: 4 } },
      { corpus: path.basename(REAL_FILE), origin: { x: 0, y: -10, z: 2 }, page: PAGE_COLS },
      { corpus: 'torture', origin: { x: -30, y: 4, z: -7 }, page: PAGE_Z },
    ] },
];

// ---- the in-page probe ----
const probe = (opts) => `(async (o) => {
  const R = { lanes: [], notes: [] };
  const F = (p) => '/@fs' + o.repo + p;
  const client = window.__glyphClient;
  if (!client) return { fatal: 'window.__glyphClient missing — the app did not boot' };

  let trieMod, refMod, kernMod, liveTrieMod;
  try {
    trieMod = await import(F('/packages/glyph3d-core/src/compute/GlyphTrie.js'));
    refMod  = await import(F('/packages/glyph3d-core/src/compute/glyphPipelineReference.js'));
    kernMod = await import(F('/packages/glyph3d-core/src/compute/glyphPipelineKernels.js'));
    liveTrieMod = await import(F('/packages/glyph3d-core/src/compute/liveTrie.js'));
  } catch (e) { return { fatal: 'import failed: ' + (e && e.message || e) }; }

  // The fixture atlas — identical to glyph-pipeline.test.mjs's, so a green headless spec and
  // a green GPU gate chain to the same numbers.
  const CELL_W = 1.2, CELL_H = 1.4;
  const SOURCE = new Map();
  const addRange = (lo, hi, adv, h) => { for (let cp = lo; cp <= hi; cp++) SOURCE.set(cp, { glyphId: cp, advance: adv, height: h }); };
  addRange(0x09, 0x0D, CELL_W, CELL_H);
  addRange(0x20, 0x7E, CELL_W, CELL_H);
  addRange(0xA0, 0xFF, CELL_W, CELL_H);
  addRange(0x2500, 0x257F, CELL_W, CELL_H);
  addRange(0x4E00, 0x4E7F, CELL_W * 2, CELL_H * 1.15);
  addRange(0x1F600, 0x1F64F, CELL_W * 2, CELL_H);
  const fixtureTrie = trieMod.buildGlyphTrie(SOURCE.keys(), (cp) => SOURCE.get(cp) || null,
    { missingAdvance: CELL_W, missingHeight: CELL_H });
  // The live trie: built from the app's real atlas (FontChain slots, real advances). Used by
  // liveTrie lanes; reference and GPU share the same trie object, so the comparison is
  // self-consistent regardless of the metrics in it.
  let liveTrie = null, liveErr = null;
  try { liveTrie = liveTrieMod.buildLiveTrie(client.ctx.atlas, 0.025); } catch (e) { liveErr = e && e.message || String(e); }

  // Offscreen renderer, reused across lanes (the live scene's is untouched).
  const store = window.__glyphPipelineCheck || (window.__glyphPipelineCheck = {});
  try {
    if (!store.renderer) {
      const Ctor = client.ctx.renderer && client.ctx.renderer.constructor;
      if (!Ctor) throw new Error('client.ctx.renderer missing');
      store.renderer = new Ctor({ antialias: false });
      await store.renderer.init();
    }
  } catch (e) { return { fatal: 'offscreen renderer init failed: ' + (e && e.message || e) }; }
  R.renderer = store.renderer.constructor.name;

  const { SLOT_STRIDE, S_GLYPH_ID, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, F_LEADER, fval } = refMod;
  const enc = new TextEncoder();
  const LINE_H = CELL_H;

  // ── The GPU-vs-reference diffs, shared by the single-file lanes and the multi-file
  //    lanes. row/col/flags/glyphId are EXACT (the integer-lane law); x/y/z sit within
  //    the magnitude-scaled f32 tolerance.
  const diffSlots = (L, fail, ref, gpu, lo, hi) => {
    let firstBad = -1;
    for (let id = lo; id < hi; id++) {
      const b = id * SLOT_STRIDE;
      const leaderRef = (ref.slots[b + S_FLAGS] & F_LEADER) !== 0;
      const leaderGpu = (gpu[b + S_FLAGS] & F_LEADER) !== 0;
      if (leaderRef !== leaderGpu) { fail('slot ' + id + ' leader mismatch ref=' + leaderRef + ' gpu=' + leaderGpu); if (firstBad < 0) firstBad = id; continue; }
      if (!leaderRef) continue;
      L.exactChecked++;
      if (gpu[b + S_GLYPH_ID] !== ref.slots[b + S_GLYPH_ID]) { fail('slot ' + id + ' glyphId ' + gpu[b + S_GLYPH_ID] + ' != ' + ref.slots[b + S_GLYPH_ID]); if (firstBad < 0) firstBad = id; }
      if (gpu[b + S_ROW] !== ref.slots[b + S_ROW]) { fail('slot ' + id + ' ROW ' + gpu[b + S_ROW] + ' != ' + ref.slots[b + S_ROW]); if (firstBad < 0) firstBad = id; }
      if (gpu[b + S_COL] !== ref.slots[b + S_COL]) { fail('slot ' + id + ' COL ' + gpu[b + S_COL] + ' != ' + ref.slots[b + S_COL]); if (firstBad < 0) firstBad = id; }
      if (gpu[b + S_ADVANCE] !== ref.slots[b + S_ADVANCE] || gpu[b + S_HEIGHT] !== ref.slots[b + S_HEIGHT]) { fail('slot ' + id + ' metrics mismatch'); if (firstBad < 0) firstBad = id; }
      for (const [lane2, name] of [[S_X, 'x'], [S_Y, 'y'], [S_Z, 'z'], [S_BASE_X, 'baseX']]) {
        // Float lanes are bitcast in the u32 slot buffer: DECODE both sides before a
        // magnitude-scaled compare. On bit patterns the same 5e-5 gate is ~1.3% on
        // values — the net would still be here, with holes in it.
        const gv = fval(gpu[b + lane2]), rv = fval(ref.slots[b + lane2]);
        const d = Math.abs(gv - rv);
        if (d > L.maxDelta) L.maxDelta = d;
        // The scan is deterministic, so the only float slack is representation, not
        // schedule: fold > 0 lanes re-sum in the oracle's own f32 order (expected
        // bit-exact — watch maxDelta report 0), and foldless lanes carry serial-f32
        // rounding bias that scales with magnitude. row/col/ord stay EXACT.
        const tol = o.eps + Math.abs(rv) * 5e-5;
        if (d > tol) { fail('slot ' + id + ' ' + name + ' delta ' + d.toExponential(2) + ' (gpu ' + gv + ' vs ref ' + rv + ')'); if (firstBad < 0) firstBad = id; }
        L.posChecked++;
      }
    }
    return firstBad;
  };
  // PER-ITEM: the GPU's bounds table entry vs the reference's itemBounds — box lanes
  // magnitude-scaled like positions, totalRows exact (integer count), maxRowExtent the
  // same float tolerance. The batch box is just the union, so per-item is the stronger
  // assert and the only one kept.
  const diffBounds = (fail, refB, gpuB, tag) => {
    const t = tag ? tag + ' ' : '';
    if (!refB) { if (gpuB) fail(t + 'ref has no bounds but GPU does'); return; }
    if (!gpuB) { fail(t + 'GPU bounds null where ref has bounds'); return; }
    for (const k of ['x', 'y', 'z']) {
      const dMin = Math.abs(gpuB.min[k] - refB.min[k]);
      const dMax = Math.abs(gpuB.max[k] - refB.max[k]);
      const tol = o.eps + Math.max(Math.abs(refB.min[k]), Math.abs(refB.max[k])) * 5e-5;
      if (dMin > tol || dMax > tol) fail(t + 'bounds.' + k + ' gpu [' + gpuB.min[k] + ', ' + gpuB.max[k] + '] vs ref [' + refB.min[k] + ', ' + refB.max[k] + ']');
    }
    if (gpuB.totalRows !== refB.totalRows) fail(t + 'totalRows gpu ' + gpuB.totalRows + ' vs ref ' + refB.totalRows);
    const eTol = o.eps + Math.abs(refB.maxRowExtent) * 5e-5;
    if (Math.abs(gpuB.maxRowExtent - refB.maxRowExtent) > eTol) fail(t + 'maxRowExtent gpu ' + gpuB.maxRowExtent + ' vs ref ' + refB.maxRowExtent);
  };
  const diffMisses = (fail, ref, gpuMisses) => {
    const a = Array.from(gpuMisses).sort((p, q) => p - q), b2 = Array.from(ref.misses).sort((p, q) => p - q);
    if (a.length !== b2.length || a.some((v, i) => v !== b2[i])) fail('misses gpu [' + a + '] vs ref [' + b2 + ']');
  };

  for (const corpus of o.corpora) {
    const bytes = enc.encode(corpus.text);
    for (const lane of o.lanes) {
      if (lane.onlyOn && lane.onlyOn !== corpus.name) continue;
      const L = { corpus: corpus.name, wrapWidth: lane.wrapWidth,
        page: lane.page ? (lane.page.depthPerBand === 20 ? 'z' : lane.page.pageCols > 0 ? 'cols' : 'news') : 'off',
        repaginate: !!lane.repaginateTo, refold: !!lane.refoldTo, scrollRows: lane.scrollRows || 0,
        failures: [], exactChecked: 0, posChecked: 0, maxDelta: 0 };
      const fail = (m) => { if (L.failures.length < 6) L.failures.push(m); L.ok = false; };
      L.ok = true;
      try {
        if (lane.liveTrie && !liveTrie) throw new Error('live trie build failed: ' + liveErr);
        const trie = lane.liveTrie ? liveTrie : fixtureTrie;
        const pageParams = (p) => p ? Object.assign({}, p, { lineHeight: LINE_H }) : undefined;
        const refOpts = { wrapWidth: lane.wrapWidth, lineHeight: LINE_H,
          zStep: o.zStep, scrollRows: lane.scrollRows || 0,
          page: pageParams(lane.refoldTo || lane.repaginateTo || lane.page) };
        const ref = refMod.runPipeline(bytes, trie, refOpts);

        const K = new kernMod.default(store.renderer, { maxBytes: Math.max(1024, bytes.length), trie });
        const t0 = performance.now();
        const pageBag = Object.assign({}, lane.page || {});
        if (lane.scrollRows) pageBag.scrollRows = lane.scrollRows;
        K.setFile(bytes, { wrapWidth: lane.wrapWidth, lineHeight: LINE_H,
          zStep: o.zStep, origin: { x: 0, y: 0, z: 0 }, page: pageBag });
        K.run();
        if (lane.repaginateTo) { K.setPage(lane.repaginateTo); K.repaginate(); }
        if (lane.refoldTo) { K.setPage(lane.refoldTo); K.refold(); }
        const t1 = performance.now();
        const gpu = await K.readSlots();
        const gpuItemBounds = await K.readItemBounds();
        const gpuMisses = await K.readMisses();
        L.dispatchMs = +(t1 - t0).toFixed(2);

        // per-slot diff
        const firstBad = diffSlots(L, fail, ref, gpu, 0, bytes.length);
        if (firstBad >= 0) L.firstBadSlot = firstBad;

        // bounds — the GPU's per-item record vs the reference's
        diffBounds(fail, ref.itemBounds[0], gpuItemBounds[0]);

        // misses — same set, order-free
        diffMisses(fail, ref, gpuMisses);

        K.dispose();
      } catch (e) {
        L.ok = false;
        L.failures.push('EXCEPTION: ' + (e && e.message || e));
      }
      R.lanes.push(L);
    }
  }

  // ── MULTI-FILE lanes: N items in ONE buffer, ONE set of dispatches ────────────────────
  // The multi-file hoist: the walk must floor at each file's first byte (row/col are
  // file-relative), each item's origin + page params apply to its own bytes only, and
  // changing one item's params must not move another item's glyphs (item isolation).
  const corpusByName = {};
  for (const c of o.corpora) corpusByName[c.name] = c;

  for (const mf of o.multi) {
    const L = { corpus: mf.name, wrapWidth: mf.wrapWidth, page: 'multi',
      repaginate: false, refold: false, scrollRows: 0,
      failures: [], exactChecked: 0, posChecked: 0, maxDelta: 0, ok: true };
    const fail = (m) => { if (L.failures.length < 6) L.failures.push(m); L.ok = false; };
    try {
      const parts = mf.items.map((it) => ({
        bytes: enc.encode(corpusByName[it.corpus].text), origin: it.origin, page: it.page || undefined,
      }));
      const starts = [];
      {
        let off = 0;
        for (const p of parts) { starts.push(off); off += p.bytes.length; }
      }
      const total = starts[starts.length - 1] + parts[parts.length - 1].bytes.length;
      const concat = new Uint8Array(total);
      parts.forEach((p, i) => concat.set(p.bytes, starts[i]));
      // mods: optional per-item { origin, page } overrides (the isolation re-run).
      const refItems = (mods) => parts.map((p, i) => ({
        byteStart: starts[i], byteCount: p.bytes.length,
        origin: (mods && mods[i] && mods[i].origin) || p.origin,
        page: (mods && mods[i] && mods[i].page) || p.page,
      }));
      const gpuItems = (mods) => parts.map((p, i) => ({
        bytes: p.bytes,
        origin: (mods && mods[i] && mods[i].origin) || p.origin,
        page: (mods && mods[i] && mods[i].page) || p.page,
      }));
      const fieldParams = { wrapWidth: mf.wrapWidth, lineHeight: LINE_H, zStep: o.zStep };

      const K = new kernMod.default(store.renderer, { maxBytes: Math.max(1024, total), trie: fixtureTrie });
      const t0 = performance.now();
      K.setFiles(gpuItems(null), fieldParams);
      K.run();
      const t1 = performance.now();
      const gpu = await K.readSlots();
      const gpuItemBounds = await K.readItemBounds();
      L.dispatchMs = +(t1 - t0).toFixed(2);

      const ref = refMod.runPipeline(concat, fixtureTrie, Object.assign({}, fieldParams, { items: refItems(null) }));
      const firstBad = diffSlots(L, fail, ref, gpu, 0, total);
      if (firstBad >= 0) L.firstBadSlot = firstBad;
      for (let i = 0; i < ref.itemBounds.length; i++) {
        diffBounds(fail, ref.itemBounds[i], gpuItemBounds[i], 'item ' + i);
      }

      // File-relative lanes: every item's first glyph is row 0, col 0 — the walk floored
      // at the file's first byte and never crossed into the previous file.
      for (let i = 1; i < parts.length; i++) {
        const b = starts[i] * SLOT_STRIDE;
        if (ref.slots[b + S_ROW] !== 0 || ref.slots[b + S_COL] !== 0) {
          fail('item ' + i + ' REF first glyph at row ' + ref.slots[b + S_ROW] + ' col ' + ref.slots[b + S_COL] + ' (not file-relative)');
        }
        if (gpu[b + S_ROW] !== 0 || gpu[b + S_COL] !== 0) {
          fail('item ' + i + ' GPU first glyph at row ' + gpu[b + S_ROW] + ' col ' + gpu[b + S_COL] + ' (not file-relative)');
        }
      }
      if (!ref.itemBounds || ref.itemBounds.length !== parts.length) fail('ref itemBounds missing or wrong length');

      // ── ITEM ISOLATION: change one item's origin + page; every OTHER item's slots must
      //    be bit-identical, and the changed item must match the reference under its new
      //    params.
      if (mf.isolateChange) {
        const ci = mf.isolateChange.itemIndex;
        const mods = [];
        mods[ci] = { origin: mf.isolateChange.origin, page: mf.isolateChange.page };
        K.setFiles(gpuItems(mods), fieldParams);
        K.run();
        const gpu2 = await K.readSlots();
        let isoBad = 0, isoFirst = -1;
        for (let id = 0; id < total; id++) {
          if (id >= starts[ci] && id < starts[ci] + parts[ci].bytes.length) continue;
          const b = id * SLOT_STRIDE;
          for (let l = 0; l < SLOT_STRIDE; l++) {
            if (gpu2[b + l] !== gpu[b + l]) { isoBad++; if (isoFirst < 0) isoFirst = id; break; }
          }
        }
        if (isoBad > 0) fail('isolation: ' + isoBad + ' slots OUTSIDE item ' + ci + ' moved when its params changed (first at byte ' + isoFirst + ')');
        const ref2 = refMod.runPipeline(concat, fixtureTrie, Object.assign({}, fieldParams, { items: refItems(mods) }));
        diffSlots(L, fail, ref2, gpu2, starts[ci], starts[ci] + parts[ci].bytes.length);
      }

      K.dispose();
    } catch (e) {
      L.ok = false;
      L.failures.push('EXCEPTION: ' + (e && e.message || e));
    }
    R.lanes.push(L);
  }
  return R;
})(${JSON.stringify(opts)})`;

// ---- drive ----
// Platform-resolved: this gate dispatches REAL COMPUTE, and headless on darwin is
// SwiftShader — same results, ~25x the wall clock. Correctness is unaffected;
// patience is. --headed still forces it.
const browser = await launchGpuBrowser({ headed: HEADED || null });
// session:'off' — a gate needs the atlas, not the operator's saved field.
// Restoring it is pure cost and pure risk (measured: 5.5s of an 8s run).
const app = await openApp(browser, { url: URL_, session: 'off', wait: WAIT });
let failed = 0;
try {
  if (!app.booted) { console.error('app did not boot'); process.exit(1); }
  const report = await app.page.evaluate(probe({ repo: REPO, corpora, lanes, multi: MULTI, eps: EPS, zStep: ZSTEP }));
  if (report.fatal) { console.error('FATAL: ' + report.fatal); process.exit(1); }
  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`glyph-pipeline-check — GPU vs executable spec (renderer: ${report.renderer}, eps ${EPS})\n`);
    for (const L of report.lanes) {
      const head = `  ${L.ok ? '✓' : '✗'} ${L.corpus}  wrap=${L.wrapWidth} page=${L.page}${L.repaginate ? ' (repaginate)' : ''}${L.refold ? ' (refold)' : ''}${L.scrollRows ? ` scroll=${L.scrollRows}` : ''}`;
      if (L.ok) {
        console.log(`${head}  — ${L.exactChecked} leaders exact, max |Δ| ${L.maxDelta.toExponential(2)}, dispatch ${L.dispatchMs}ms`);
      } else {
        failed++;
        console.log(head);
        for (const f of L.failures) console.log(`      └ ${f}`);
      }
    }
    console.log(failed ? `\n${failed} lane(s) FAILED` : '\nall lanes passed');
  }
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
