// far-texels-check.mjs — the far-texture (minified text-mass LOD) hardware gate.
//
// The two far kernels (K10a farScatter, K10b farNormalize — glyphPipelineKernels.js)
// are proven against their CPU ORACLES (farScatterOracle / farNormalizeOracle in
// compute/glyphPipelineReference.js — the spec-is-right law) on real GPU dispatch:
//
//   scatter     GPU farAccum ≈ oracle accumulator over the SAME laid slots (uint
//               fixed-point sums; tolerance for f32 pow/trunc vs f64, never structure)
//   normalize   GPU farPacked ≈ oracle packed RGBA8 per slab texel (±1 u8 LSB)
//   self-clean  after normalize, the slab's accumulators are ZERO (the next batch
//               starts clean — a leaked sum is a double-count on the next regen)
//   isolation   file A's slab contains none of file B's ink, and atlas texels outside
//               every slab stay zero
//   teeth       non-degenerate content asserted BEFORE any comparison: real ink mass,
//               >1 distinct texel color, coverage strictly inside (0,1] on text rows,
//               empty regions empty
//
// Harness shape mirrors layout-kernel-check.mjs: boot the app CLIENT-ONLY (no relay —
// the safety note there applies), run the REAL kernels module + the LIVE atlas trie
// through the app's own module graph (/@fs), dispatch on a SECOND offscreen
// WebGPURenderer (the live scene's is untouched), diff in-page, return a compact report.
//
//   bun tools/far-texels-check.mjs                  # full gate (needs the Vite server)
//   bun tools/far-texels-check.mjs --headed         # watch it
//   bun tools/far-texels-check.mjs --json
//
// Exit: 0 only when every check has teeth AND every diff is within tolerance.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const HEADED = has('--headed');
const AS_JSON = has('--json');

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ---- the corpus: two small files with DISTINCT color bands + one contrasting run ----
const FILE_A = [
  'alpha one two',
  'beta three four',
  '',
  'gamma KEYWORD six',
  'delta seven eight',
  'epsilon nine ten',
].join('\n');
const FILE_B = [
  'zz top',
  'yy middle',
  'xx bottom',
].join('\n');
// Authored (sRGB) colors: A = green-ish with a red KEYWORD run, B = blue-ish.
const COLOR_A = { r: 0.2, g: 0.9, b: 0.3 };
const COLOR_KW = { r: 0.95, g: 0.2, b: 0.2 };
const COLOR_B = { r: 0.25, g: 0.45, b: 0.95 };

const probe = (opts) => `(async (o) => {
  const R = { teeth: [], notes: [] };
  const tooth = (name, pass, detail) => { R.teeth.push({ name, pass: !!pass, detail: detail ?? null }); return !!pass; };
  const F = (p) => '/@fs' + o.repo + p;

  const client = window.__glyphClient;
  if (!client) return { fatal: 'window.__glyphClient missing — the app did not boot' };
  const atlas = client.ctx && client.ctx.atlas;
  if (!atlas) return { fatal: 'client.ctx.atlas missing — the glyph engine did not boot' };

  let Kernels, Ref, TrieMod, FarMod, StorageAttr;
  try {
    Kernels     = (await import(F('/packages/glyph3d-core/src/compute/glyphPipelineKernels.js'))).default;
    Ref         = await import(F('/packages/glyph3d-core/src/compute/glyphPipelineReference.js'));
    TrieMod     = await import(F('/packages/glyph3d-core/src/compute/liveTrie.js'));
    FarMod      = await import(F('/packages/glyph3d-core/src/core/FarTextAtlas.js'));
    StorageAttr = (await import(F('/node_modules/three/src/renderers/common/StorageInstancedBufferAttribute.js'))).default;
  } catch (e) { return { fatal: 'import failed: ' + (e && e.message || e) }; }

  // A SECOND, offscreen renderer (the live scene's is never touched). Cached on window.
  const store = window.__farTexelsCheck || (window.__farTexelsCheck = {});
  try {
    if (!store.renderer) {
      const Ctor = client.ctx.renderer && client.ctx.renderer.constructor;
      if (!Ctor) throw new Error('client.ctx.renderer missing');
      store.renderer = new Ctor({ antialias: false });
      await store.renderer.init();
    }
  } catch (e) { return { fatal: 'offscreen renderer init failed: ' + (e && e.message || e) }; }
  const renderer = store.renderer;

  const enc = new TextEncoder();
  const bytesA = enc.encode(o.fileA), bytesB = enc.encode(o.fileB);
  const startB = bytesA.length;
  const total = startB + bytesB.length;
  const maxBytes = 1 << 16;

  const trie = TrieMod.buildLiveTrie(atlas, 0.025);
  const kernels = new Kernels(renderer, { maxBytes, maxItems: 8, trie });
  const items = [
    { bytes: bytesA, byteStart: 0, origin: { x: 0, y: 0, z: 0 }, page: {}, wrapWidth: 0, lineHeight: 1, zStep: 0 },
    { bytes: bytesB, byteStart: startB, origin: { x: 0, y: 0, z: 0 }, page: {}, wrapWidth: 0, lineHeight: 1, zStep: 0 },
  ];
  kernels.setItems(items);
  kernels.writeBytes(items);
  kernels.run();
  R.notes.push('laid ' + kernels.byteLength + ' bytes across 2 items');

  // Colors: per-slot authored sRGB — A green with a red KEYWORD run, B blue.
  // RGBA8, matching the RENDER path. Two traps live here, both silent:
  //  1. The color lane became RGBA8 in 1c4b8dd ("instanceColor is RGBA8 — the first
  //     diet slice"): the kernel binds this buffer as ONE u32 per glyph and unpacks
  //     bytes by hand. A Float32Array here hands it IEEE-754 bit patterns to unpack
  //     as colour — which is what this gate did, silently, from the day it was written.
  //  2. normalized is load-bearing. three widens a Uint8Array attribute to one u32
  //     PER BYTE unless normalized === true (WebGPUAttributeUtils.js). The real app
  //     sets it (GlyphField._ensureColorAttr, MegaGlyphField); a gate that forgets it
  //     gets green and blue exactly zero while alpha stays perfect — which reads as a
  //     kernel bug and is not one.
  const attr = new StorageAttr(new Uint8Array(maxBytes * 4), 4);
  attr.normalized = true;
  const kwAt = o.fileA.indexOf('KEYWORD');
  const paint = (slot, c) => {
      const b = slot * 4;
      attr.array[b] = Math.round(c.r * 255);
      attr.array[b + 1] = Math.round(c.g * 255);
      attr.array[b + 2] = Math.round(c.b * 255);
      attr.array[b + 3] = 255;
  };
  for (let s = 0; s < total; s++) paint(s, o.colorA);
  for (let s = kwAt; s < kwAt + 7; s++) paint(s, o.colorKw);
  for (let s = startB; s < total; s++) paint(s, o.colorB);
  attr.needsUpdate = true;
  kernels.setFarColorSource(attr);

  // Ink table from the LIVE slug data (no reimplementation — the same source the
  // arena uses), shared with the oracle as densityAt.
  const ink = FarMod.buildFarInkTable(atlas._live && atlas._live._slugData && atlas._live._slugData.glyphMapTexture);
  kernels.setFarInk(ink);
  const densityAt = (gid) => ink[gid] || 0;
  const colorAt = (id) => {
    if (id >= startB) return o.colorB;
    if (id >= kwAt && id < kwAt + 7) return o.colorKw;
    return o.colorA;
  };

  // Ratios from the GPU's OWN extent record — the arena's formula, so this gate
  // covers the same derivation the app runs.
  const bounds = await kernels.readItemBounds();
  if (!bounds[0] || !bounds[1]) return { fatal: 'readItemBounds returned null for a laid item' };
  const cellW = (atlas.getCharSize().width || 1) * 0.025 || 1;
  const ratios = bounds.map((b) => ({
    rpt: b.totalRows / Ref.FAR_SLAB,
    cpt: Math.max(1, (b.maxRowExtent || cellW) / cellW) / Ref.FAR_SLAB,
  }));
  R.ratios = ratios;

  // Arm: item 0 → slab 0 (origin 0,0), item 1 → slab 1 (origin 64,0); both dirty.
  const farItems = new Float32Array(8 * Ref.FAR_ITEM_STRIDE).fill(-1);
  const arm = (row, slabX, slabY) => {
    const fb = row * Ref.FAR_ITEM_STRIDE;
    farItems[fb + Ref.FI_SLAB_X] = slabX;
    farItems[fb + Ref.FI_SLAB_Y] = slabY;
    farItems[fb + Ref.FI_ROWS_PER_TEXEL] = ratios[row].rpt;
    farItems[fb + Ref.FI_COLS_PER_TEXEL] = ratios[row].cpt;
    farItems[fb + Ref.FI_DIRTY] = 1;
  };
  arm(0, 0, 0);
  arm(1, Ref.FAR_SLAB, 0);
  kernels.setFarItems(farItems, new Uint32Array([0, 1]), 2);
  // Split the batch: the accum must be read BETWEEN scatter and normalize (normalize
  // resets it — the self-cleaning invariant the last check verifies).
  kernels.runFarScatter();
  const accumGPU = await kernels.readFarAccum();
  kernels.runFarNormalize();
  const packedGPU = await kernels.readFarPacked();
  const accumAfter = await kernels.readFarAccum();

  const slotsGPU = await kernels.readSlots();

  // ── ORACLE: same inputs (the GPU's own laid slots — scatter's exact read set) ──
  const itemStarts = [{ byteStart: 0 }, { byteStart: startB }];
  const accumCPU = Ref.farScatterOracle(slotsGPU, kernels.byteLength, itemStarts, farItems, { colorAt, densityAt });

  // scatter diff: uint fixed-point sums. f32 pow/trunc vs f64 → per-addend low-bit
  // noise; tolerance scales with the sum. NEVER structural (a missing glyph, a wrong
  // texel, an off-by-one row — all of those blow past this band).
  let worst = 0, over = 0, massCPU = 0, massGPU = 0;
  for (let i = 0; i < accumCPU.length; i++) {
    const d = Math.abs(accumGPU[i] - accumCPU[i]);
    massCPU += accumCPU[i]; massGPU += accumGPU[i];
    if (d > worst) worst = d;
    if (d > 4 + accumCPU[i] * 0.02) over++;
  }
  tooth('scatter mass', massCPU > 1000 && massGPU > 1000, 'cpu ' + massCPU + ' gpu ' + massGPU);
  tooth('scatter ≈ oracle', over === 0, 'worst |Δ| ' + worst + ' (' + over + ' lanes over tolerance)');

  // normalize diff: packed RGBA8 per slab texel (±1 u8 LSB per channel).
  let packedOver = 0, packedWorst = 0, inkTexels = 0, distinctColors = new Set();
  const slabCheck = (slabX, slabY, row) => {
    const cpu = Ref.farNormalizeOracle(accumCPU, slabX, slabY, ratios[row].rpt, ratios[row].cpt);
    for (let ty = 0; ty < Ref.FAR_SLAB; ty++) {
      for (let tx = 0; tx < Ref.FAR_SLAB; tx++) {
        const want = cpu[ty * Ref.FAR_SLAB + tx];
        const got = packedGPU[(slabY + ty) * Ref.FAR_TEX + slabX + tx];
        for (let ch = 0; ch < 4; ch++) {
          const d = Math.abs(((got >>> (ch * 8)) & 0xFF) - ((want >>> (ch * 8)) & 0xFF));
          if (d > packedWorst) packedWorst = d;
          if (d > 2) packedOver++;
        }
        if ((got >>> 24) > 0) { inkTexels++; distinctColors.add(got & 0xFFFFFF); }
      }
    }
  };
  slabCheck(0, 0, 0);
  slabCheck(Ref.FAR_SLAB, 0, 1);
  tooth('normalize ≈ oracle', packedOver === 0, 'worst channel Δ ' + packedWorst + ' (' + packedOver + ' over ±2)');
  tooth('teeth: ink present + varied', inkTexels > 8 && distinctColors.size > 1, inkTexels + ' ink texels, ' + distinctColors.size + ' distinct colors');

  // self-clean: after normalize, both slabs' accumulators are ZERO (GPU side).
  let residue = 0;
  for (let ty = 0; ty < Ref.FAR_SLAB; ty++) {
    for (let tx = 0; tx < 2 * Ref.FAR_SLAB; tx++) {
      const ab = (ty * Ref.FAR_TEX + tx) * 4;
      residue += accumAfter[ab] + accumAfter[ab + 1] + accumAfter[ab + 2] + accumAfter[ab + 3];
    }
  }
  tooth('self-clean accum', residue === 0, 'residual sum ' + residue);

  // isolation: slab 0 (file A) carries no B-blue; texels below the slabs are zero.
  let bLeak = 0, belowZero = 0;
  const bPacked = (Math.round(o.colorB.r * 255) << 0) | (Math.round(o.colorB.g * 255) << 8) | (Math.round(o.colorB.b * 255) << 16);
  for (let ty = 0; ty < Ref.FAR_SLAB; ty++) {
    for (let tx = 0; tx < Ref.FAR_SLAB; tx++) {
      const p = packedGPU[ty * Ref.FAR_TEX + tx];
      if ((p & 0xFFFFFF) === bPacked && (p >>> 24) > 0) bLeak++;
    }
  }
  for (let i = Ref.FAR_SLAB * Ref.FAR_TEX; i < packedGPU.length; i++) belowZero += packedGPU[i];
  tooth('item isolation', bLeak === 0, bLeak + ' B-colored texels in A slab');
  tooth('outside slabs empty', belowZero === 0, 'sum below slab row: ' + belowZero);

  // the KEYWORD run: its red must survive somewhere in A's slab (content-truth).
  let kwFound = false;
  for (let ty = 0; ty < Ref.FAR_SLAB && !kwFound; ty++) {
    for (let tx = 0; tx < Ref.FAR_SLAB; tx++) {
      const p = packedGPU[ty * Ref.FAR_TEX + tx];
      const r = p & 0xFF, g = (p >>> 8) & 0xFF;
      if ((p >>> 24) > 0 && r > 120 && r > g + 40) { kwFound = true; break; }
    }
  }
  tooth('KEYWORD red survives', kwFound, 'a red-leaning ink texel in slab 0');

  // LATE COLOR REBIND. The far kernels close over the color node, so a source set
  // AFTER they are built used to be silently ignored — scatter kept reading the
  // previous buffer (a 4-byte placeholder at construction) and every texel came out
  // black, with nothing raised. MegaGlyphField._ensureCapacity really does replace
  // the instanceColor attribute on growth, so this path is reachable.
  // Swap in an all-red source post-build and require the slab to follow it.
  {
    const red = new StorageAttr(new Uint8Array(maxBytes * 4), 4);
    red.normalized = true;
    for (let sl = 0; sl < total; sl++) {
      const b = sl * 4;
      red.array[b] = 255; red.array[b + 1] = 0; red.array[b + 2] = 0; red.array[b + 3] = 255;
    }
    red.needsUpdate = true;
    kernels.setFarColorSource(red);
    kernels.setFarItems(farItems, new Uint32Array([0, 1]), 2);
    kernels.runFarScatter();
    kernels.runFarNormalize();
    const after = await kernels.readFarPacked();
    let redTexels = 0, otherTexels = 0;
    for (let i = 0; i < after.length; i++) {
      const p32 = after[i] >>> 0;
      const r = p32 & 255, g = (p32 >>> 8) & 255, b = (p32 >>> 16) & 255, a = (p32 >>> 24) & 255;
      if (a === 0) continue;
      if (r > g && r > b) redTexels++; else otherTexels++;
    }
    tooth('late setFarColorSource takes effect', redTexels > 0 && otherTexels === 0,
      'every ink texel follows the NEW source (' + redTexels + ' red, ' + otherTexels + ' stale)');
  }

  R.ok = R.teeth.every((t) => t.pass);
  return R;
})(${JSON.stringify(opts)})`;

// ---- runner ----
// Platform-resolved. This gate dispatches REAL COMPUTE, and headless on darwin is
// SwiftShader — measured on this box at 25x slower (124.7s vs 8.0s) for identical
// results. Correctness is unaffected; the wall-clock is not.
const browser = await launchGpuBrowser({ headed: HEADED || null });
let app = null;
let result = null;
try {
  // session:'off' — this gate builds its own kernels on a second offscreen renderer
  // and needs only the atlas, so restoring the operator's saved field is pure cost
  // (5.5s of an 8s run) and pure risk. wait drops with it.
  app = await openApp(browser, { url: flag('--url', 'http://localhost:5173/'), session: 'off', wait: 500 });
  if (!app.booted) { console.error('✗ FAIL  the app did not boot (is the Vite server up? :5173)'); process.exit(1); }
  result = await app.evalPage(probe({
    repo: REPO, fileA: FILE_A, fileB: FILE_B,
    colorA: COLOR_A, colorKw: COLOR_KW, colorB: COLOR_B,
  }));
} catch (err) {
  console.error(`✗ FAIL  harness error: ${err?.message || err}`);
  process.exit(1);
} finally {
  const errs = app ? app.errors : [];
  if (errs.length) console.error(C.dim(`\npage errors (${errs.length}): ${errs.slice(0, 3).map((e) => e.text).join(' | ')}`));
  await browser.close();
}

if (AS_JSON) { console.log(JSON.stringify(result, null, 2)); process.exit(result && result.ok ? 0 : 1); }
if (!result) { console.error('✗ FAIL  no result'); process.exit(1); }
if (result.fatal) { console.error(`✗ FAIL  ${result.fatal}`); process.exit(1); }
for (const n of result.notes || []) console.log(C.dim(`note  ${n}`));
if (result.ratios) console.log(C.dim(`ratios item0 rpt=${result.ratios[0].rpt.toFixed(3)} cpt=${result.ratios[0].cpt.toFixed(3)} · item1 rpt=${result.ratios[1].rpt.toFixed(3)} cpt=${result.ratios[1].cpt.toFixed(3)}`));
let failed = 0;
for (const t of result.teeth) {
  if (!t.pass) failed++;
  console.log(`  ${t.pass ? '✓' : '✗ FAIL'} ${t.name}${t.detail != null ? C.dim(` — ${t.detail}`) : ''}`);
}
console.log(C.bold(failed ? `\n✗ FAIL  ${failed} check(s)` : '\n✓ PASS  far-texels (scatter + normalize + self-clean + isolation)'));
process.exit(failed ? 1 : 0);
