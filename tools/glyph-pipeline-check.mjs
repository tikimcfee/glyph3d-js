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
// setFile/run/readSlots/readBounds/readMisses (GPU), then diff every slot. row/col/flags/
// codepoint must be EXACT (the integer-lane law); x/y/z within eps (f32, order-free).
// A repaginate lane proves kernel 3 alone re-folds a mode switch.
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
import { launchBrowser, openApp } from './itest/driver.mjs';

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

// ---- lanes: wrap × window × page. window 0 is a correctness lane, not a perf one. ----
const PAGE_OFF = null;
const PAGE_NEWS = { pageRows: 8, pageCols: 0, colWidth: 0, pageStrideX: 50, pagesWide: 2, depthPerBand: 5, depthPerColumn: 0, bandStrideY: 13.2 };
const PAGE_Z = { pageRows: 8, pageCols: 0, colWidth: 0, pageStrideX: 0, pagesWide: 1, depthPerBand: 20, depthPerColumn: 0 };
// MetalLink's max-page-width fold: an over-wide line breaks into depth pages
// (xPages = floor(col / pageCols), z recedes per column — Compute.metal:396).
const PAGE_COLS = { pageRows: 0, pageCols: 200, pageStrideX: 0, pagesWide: 1, depthPerBand: 0, depthPerColumn: 4 };
const lanes = [
  { wrapWidth: 0, window: 128, page: PAGE_OFF,
    expectFailOn: 'single-line-40k',
    expectFail: 'no fold unit at all (wrap=0, pageCols=0): MAX_WALK_STEPS (4096) is the operative bound and x caps at 4096×advance past slot 4096. The designed answer to a line this long is a fold unit — pageCols (see the cols lane) — the cap stays as the device-loss fuse' },
  { wrapWidth: 24, window: 128, page: PAGE_OFF },
  { wrapWidth: 200, window: 128, page: PAGE_OFF },
  { wrapWidth: 200, window: 0, page: PAGE_OFF },
  { wrapWidth: 200, window: 128, page: PAGE_NEWS },
  { wrapWidth: 200, window: 128, page: PAGE_Z },
  { wrapWidth: 200, window: 128, page: PAGE_NEWS, repaginateTo: PAGE_Z },  // kernel 3 alone re-folds, from base
  { wrapWidth: 0, window: 128, page: PAGE_COLS, onlyOn: 'single-line-40k' },  // the long line folds into depth pages
  { wrapWidth: 200, window: 128, page: PAGE_NEWS, scrollRows: 12 },   // the conveyor, paginated
  { wrapWidth: 200, window: 128, page: null, scrollRows: 12 },        // scroll without pagination
  { wrapWidth: 200, window: 128, page: PAGE_NEWS, onlyOn: 'GlyphTrie.js', liveTrie: true },  // the REAL atlas's trie
  { wrapWidth: 200, window: 128, page: PAGE_Z, onlyOn: 'GlyphTrie.js', liveTrie: true },
];
const ZSTEP = 0.21;   // 0.15 × CELL_H — the app's long-column zWrapSpacing, in world units

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

  const { SLOT_STRIDE, S_CODEPOINT, S_ADVANCE, S_HEIGHT, S_X, S_Y, S_Z, S_ROW, S_COL, S_FLAGS, S_BASE_X, F_LEADER } = refMod;
  const enc = new TextEncoder();
  const LINE_H = CELL_H;

  for (const corpus of o.corpora) {
    const bytes = enc.encode(corpus.text);
    for (const lane of o.lanes) {
      if (lane.onlyOn && lane.onlyOn !== corpus.name) continue;
      const L = { corpus: corpus.name, wrapWidth: lane.wrapWidth, window: lane.window,
        page: lane.page ? (lane.page.depthPerBand === 20 ? 'z' : lane.page.pageCols > 0 ? 'cols' : 'news') : 'off',
        repaginate: !!lane.repaginateTo, scrollRows: lane.scrollRows || 0,
        expectFail: (lane.expectFail && (!lane.expectFailOn || lane.expectFailOn === corpus.name)) ? lane.expectFail : null,
        failures: [], exactChecked: 0, posChecked: 0, maxDelta: 0 };
      const fail = (m) => { if (L.failures.length < 6) L.failures.push(m); L.ok = false; };
      L.ok = true;
      try {
        if (lane.liveTrie && !liveTrie) throw new Error('live trie build failed: ' + liveErr);
        const trie = lane.liveTrie ? liveTrie : fixtureTrie;
        const pageParams = (p) => p ? Object.assign({}, p, { lineHeight: LINE_H }) : undefined;
        const refOpts = { window: lane.window, wrapWidth: lane.wrapWidth, lineHeight: LINE_H,
          zStep: o.zStep, scrollRows: lane.scrollRows || 0,
          page: pageParams(lane.repaginateTo || lane.page) };
        const ref = refMod.runPipeline(bytes, trie, refOpts);

        const K = new kernMod.default(store.renderer, { maxBytes: Math.max(1024, bytes.length), trie });
        const t0 = performance.now();
        const pageBag = Object.assign({}, lane.page || {});
        if (lane.scrollRows) pageBag.scrollRows = lane.scrollRows;
        K.setFile(bytes, { window: lane.window, wrapWidth: lane.wrapWidth, lineHeight: LINE_H,
          zStep: o.zStep, origin: { x: 0, y: 0, z: 0 }, page: pageBag });
        K.run();
        if (lane.repaginateTo) { K.setPage(lane.repaginateTo); K.repaginate(); }
        const t1 = performance.now();
        const gpu = await K.readSlots();
        const gpuBounds = await K.readBounds();
        const gpuMisses = await K.readMisses();
        L.dispatchMs = +(t1 - t0).toFixed(2);

        // per-slot diff
        const n = bytes.length;
        let firstBad = -1;
        for (let id = 0; id < n; id++) {
          const b = id * SLOT_STRIDE;
          const leaderRef = (ref.slots[b + S_FLAGS] & F_LEADER) !== 0;
          const leaderGpu = (gpu[b + S_FLAGS] & F_LEADER) !== 0;
          if (leaderRef !== leaderGpu) { fail('slot ' + id + ' leader mismatch ref=' + leaderRef + ' gpu=' + leaderGpu); if (firstBad < 0) firstBad = id; continue; }
          if (!leaderRef) continue;
          L.exactChecked++;
          if (gpu[b + S_CODEPOINT] !== ref.slots[b + S_CODEPOINT]) { fail('slot ' + id + ' codepoint ' + gpu[b + S_CODEPOINT] + ' != ' + ref.slots[b + S_CODEPOINT]); if (firstBad < 0) firstBad = id; }
          if (gpu[b + S_ROW] !== ref.slots[b + S_ROW]) { fail('slot ' + id + ' ROW ' + gpu[b + S_ROW] + ' != ' + ref.slots[b + S_ROW]); if (firstBad < 0) firstBad = id; }
          if (gpu[b + S_COL] !== ref.slots[b + S_COL]) { fail('slot ' + id + ' COL ' + gpu[b + S_COL] + ' != ' + ref.slots[b + S_COL]); if (firstBad < 0) firstBad = id; }
          if (gpu[b + S_ADVANCE] !== ref.slots[b + S_ADVANCE] || gpu[b + S_HEIGHT] !== ref.slots[b + S_HEIGHT]) { fail('slot ' + id + ' metrics mismatch'); if (firstBad < 0) firstBad = id; }
          for (const [lane2, name] of [[S_X, 'x'], [S_Y, 'y'], [S_Z, 'z'], [S_BASE_X, 'baseX']]) {
            const d = Math.abs(gpu[b + lane2] - ref.slots[b + lane2]);
            if (d > L.maxDelta) L.maxDelta = d;
            // f32 accumulation is order-free but not bit-exact: the walk sums ~hundreds of
            // advances in a scheduling-dependent grouping, so the tolerance scales with
            // magnitude (same shape as layout-fuzz, 5e-5 for the unbounded wrap=0 sums).
            // row/col above stay EXACT — integers don't wobble.
            const tol = o.eps + Math.abs(ref.slots[b + lane2]) * 5e-5;
            if (d > tol) { fail('slot ' + id + ' ' + name + ' delta ' + d.toExponential(2) + ' (gpu ' + gpu[b + lane2] + ' vs ref ' + ref.slots[b + lane2] + ')'); if (firstBad < 0) firstBad = id; }
            L.posChecked++;
          }
        }
        if (firstBad >= 0) L.firstBadSlot = firstBad;

        // bounds — same magnitude-scaled tolerance as positions
        if (!ref.bounds) {
          if (gpuBounds.min.x !== Infinity && isFinite(gpuBounds.min.x)) fail('ref has no bounds but GPU does');
        } else {
          for (const k of ['x', 'y', 'z']) {
            const dMin = Math.abs(gpuBounds.min[k] - ref.bounds.min[k]);
            const dMax = Math.abs(gpuBounds.max[k] - ref.bounds.max[k]);
            const tol = o.eps + Math.max(Math.abs(ref.bounds.min[k]), Math.abs(ref.bounds.max[k])) * 5e-5;
            if (dMin > tol || dMax > tol) fail('bounds.' + k + ' gpu [' + gpuBounds.min[k] + ', ' + gpuBounds.max[k] + '] vs ref [' + ref.bounds.min[k] + ', ' + ref.bounds.max[k] + ']');
          }
          // The scroll/page scalars: totalRows is an integer count — exact. maxRowExtent
          // is a float sum — the same magnitude-scaled tolerance as positions.
          if (gpuBounds.totalRows !== ref.bounds.totalRows) fail('totalRows gpu ' + gpuBounds.totalRows + ' vs ref ' + ref.bounds.totalRows);
          const eTol = o.eps + Math.abs(ref.bounds.maxRowExtent) * 5e-5;
          if (Math.abs(gpuBounds.maxRowExtent - ref.bounds.maxRowExtent) > eTol) fail('maxRowExtent gpu ' + gpuBounds.maxRowExtent + ' vs ref ' + ref.bounds.maxRowExtent);
        }

        // misses — same set, order-free
        const a = Array.from(gpuMisses).sort((p, q) => p - q), b2 = Array.from(ref.misses).sort((p, q) => p - q);
        if (a.length !== b2.length || a.some((v, i) => v !== b2[i])) fail('misses gpu [' + a + '] vs ref [' + b2 + ']');

        K.dispose();
      } catch (e) {
        L.ok = false;
        L.failures.push('EXCEPTION: ' + (e && e.message || e));
      }
      R.lanes.push(L);
    }
  }
  return R;
})(${JSON.stringify(opts)})`;

// ---- drive ----
const browser = await launchBrowser({ headed: HEADED });
const app = await openApp(browser, { wait: WAIT });
let failed = 0;
try {
  if (!app.booted) { console.error('app did not boot'); process.exit(1); }
  const report = await app.page.evaluate(probe({ repo: REPO, corpora, lanes, eps: EPS, zStep: ZSTEP }));
  if (report.fatal) { console.error('FATAL: ' + report.fatal); process.exit(1); }
  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`glyph-pipeline-check — GPU vs executable spec (renderer: ${report.renderer}, eps ${EPS})\n`);
    for (const L of report.lanes) {
      const head = `  ${L.ok ? '✓' : '✗'} ${L.corpus}  wrap=${L.wrapWidth} window=${L.window} page=${L.page}${L.repaginate ? ' (repaginate)' : ''}${L.scrollRows ? ` scroll=${L.scrollRows}` : ''}`;
      if (L.expectFail) {
        // A documented kernel bug lives here. Green while reality matches the note —
        // an unexpected PASS means someone fixed it and the marker should go.
        if (!L.ok) { console.log(`${head}  — EXPECTED FAIL: ${L.expectFail}`); }
        else { failed++; console.log(`${head}  — UNEXPECTED PASS (fixed? remove the expectFail marker)`); }
      } else if (L.ok) {
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
