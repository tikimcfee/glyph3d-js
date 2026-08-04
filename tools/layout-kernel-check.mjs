// layout-kernel-check.mjs — per-slot equivalence harness: GPU glyph layout vs the CPU builder.
//
// The compute kernel (packages/glyph3d-core/src/compute/GlyphLayoutKernel.js) is meant to
// reproduce, on the GPU, the fold `core/foldEvaluate.evaluateFold` computes on the CPU. This is
// the gate: boot the app CLIENT-ONLY, run the REAL builder with the LIVE atlas for the glyph
// attributes + line table (never a reimplementation, never hardcoded metrics — project law),
// evaluate the fold longhand on the CPU from those tables, run the kernel against a SECOND
// offscreen WebGPURenderer (the live scene's renderer is untouched), and diff every slot.
//
// The builder does NOT lay anything out any more, so it is not the reference: evaluateFold is —
// the same evaluator layout-mirror.test.mjs and layout-fuzz.test.mjs check positionAt against,
// so a green mirror plus a green kernel-check chains GPU → mirror with one shared oracle.
//
//   bun tools/layout-kernel-check.mjs                          # flat + column modes, torture text
//   bun tools/layout-kernel-check.mjs --mode flat               # one mode
//   bun tools/layout-kernel-check.mjs --text-file packages/glyph3d-core/src/GlyphAtlas.js
//   bun tools/layout-kernel-check.mjs --eps 1e-3 --wrap-width 80
//   bun tools/layout-kernel-check.mjs --dump /tmp/layout-kernel.json --json
//
// COVERAGE TEETH: a diff of two empty arrays passes vacuously, so the CPU reference is asserted
// non-degenerate BEFORE any comparison — slots > 0, source lines > 3, >1 distinct x AND >1
// distinct y, one slot per codepoint, a line table that starts at 0 and never goes backwards,
// an empty line, and (column mode) a line longer than the wrap width. Any teeth failure is a
// FAIL even if the diff is clean.
//
// SAFETY: never dials the relay (no relayPort, no ?relay) — a relay boot arms workspace autosave
// and can clobber the operator's real session. Client-only is the correct mode here.
//
// Exit: 0 only when every mode has full teeth AND every slot matches within epsilon.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openApp } from './itest/driver.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const MODES = (flag('--mode', 'flat,column,wrap4,newspaper,z-pages')).split(',').map((s) => s.trim()).filter(Boolean);
const EPS = Number(flag('--eps', '1e-4'));
const WRAP = Number(flag('--wrap-width', '200'));
const PAGE_HEIGHT = Number(flag('--page-height', '4'));   // small enough that 14 lines paginate
const PAGES_WIDE = Number(flag('--pages-wide', '2'));
const WORLD_SCALE = Number(flag('--world-scale', '0.025'));   // the app's CodeGrid default (fileLoader.js)
const MAX_LINES = Number(flag('--max-lines', '400'));
const TEXT_FILE = flag('--text-file', null);
const DUMP = flag('--dump', null);
const AS_JSON = has('--json');
const HEADED = has('--headed');
const USE_LIVE_RENDERER = has('--use-live-renderer'); // escape hatch if a 2nd GPUDevice can't be had
const SELFTEST = has('--selftest');   // stand a CPU reference model in for the kernel module
const ASCII = has('--ascii');         // fold every non-ASCII codepoint to '.' (uniform advance)
const BENCH = has('--bench');         // decompose timing: configure walk / steady-state dispatch / GPU time / readback
const BENCH_N = Number(flag('--bench-n', '200'));
const DIR = flag('--dir', null);      // bulk-load bench: lay out EVERY file under a directory in a tight loop
const MAX_FILES = Number(flag('--max-files', '150'));

// ---- the deterministic torture text ----
// Empty lines, leading/trailing spaces, tabs, a very long line (> wrap width), an emoji,
// astral-plane codepoints, box drawing, CJK. One slot per CODEPOINT is the builder's contract,
// so surrogate pairs are the sharpest edge here.
const TORTURE = [
  'const answer = 42;',
  '',
  '    leading spaces and trailing spaces    ',
  '\ttab\tseparated\tcolumns',
  '',
  'unicode: éèê αβγ 你好 ─┬┐',
  'xy\u{1F600}z',                               // spec §8 Fixture A: ONE slot, DOUBLE advance
  'emoji: \u{1F389} done ✅ fast \u{1F680}',
  'astral: \u{1D400}\u{1D401}\u{1D402} \u{1F4A1}',
  'x'.repeat(WRAP + 137),                       // definitively past the wrap boundary
  '',
  '',
  'function tail(a, b) { return a + b; }',
  '  }',
  'end',
].join('\n');

let TEXT = TORTURE, TEXT_LABEL = `torture (${TORTURE.split('\n').length} lines, wrap=${WRAP})`;
if (TEXT_FILE) {
  const abs = path.isAbsolute(TEXT_FILE) ? TEXT_FILE : path.join(REPO, TEXT_FILE);
  const raw = readFileSync(abs, 'utf8').split('\n').slice(0, MAX_LINES).join('\n');
  TEXT = raw;
  TEXT_LABEL = `${path.relative(REPO, abs)} (first ${raw.split('\n').length} lines)`;
}
if (ASCII) {
  // Array.from splits by CODEPOINT, so astral chars fold to one '.' and the slot count is
  // preserved. Isolates the uniform-advance path: every glyph then steps exactly cellWidth.
  TEXT = TEXT.split('\n').map((l) => Array.from(l).map((ch) => (ch.codePointAt(0) > 0x7f ? '.' : ch)).join('')).join('\n');
  TEXT_LABEL += ' [--ascii: non-ASCII folded to .]';
}

// ---- bulk-load corpus (--dir): every code-ish file under a directory, the tree-load shape ----
function collectDirCorpus(dir) {
  const abs = path.isAbsolute(dir) ? dir : path.join(REPO, dir);
  const exts = new Set(['.js', '.jsx', '.mjs', '.go', '.md', '.json', '.css', '.html', '.metal', '.sh']);
  const skip = /node_modules|\.git|dist\/|\/web\/|bun\.lock/;
  const files = [];
  for (const rel of readdirSync(abs, { recursive: true })) {
    const p = path.join(abs, String(rel));
    if (skip.test(p) || !exts.has(path.extname(p))) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (!st.isFile() || st.size > 512 * 1024) continue;   // cap: pathological blobs skew the tail
    files.push({ name: path.relative(REPO, p), text: readFileSync(p, 'utf8') });
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

// ---- the in-page probe ----
// Built as one string (Playwright can't pass args alongside a string expression), with the
// options JSON-interpolated. Everything numeric happens IN the page — only a compact report
// crosses the boundary, so no typed array has to survive serialization.
const probe = (opts) => `(async (o) => {
  const R = { mode: o.mode, teeth: [], notes: [] };
  const tooth = (name, pass, detail) => { R.teeth.push({ name, pass: !!pass, detail: detail ?? null }); return !!pass; };
  const F = (p) => '/@fs' + o.repo + p;

  const client = window.__glyphClient;
  if (!client) return { fatal: 'window.__glyphClient missing — the app did not boot' };
  const atlas = client.ctx && client.ctx.atlas;
  if (!atlas) return { fatal: 'client.ctx.atlas missing — the glyph engine did not boot' };

  // ---- the REAL builder + the LIVE atlas, through the app's own module graph (/@fs) ----
  let builders, cellMetrics, shaping, bridgeMod = null, foldEval = null, foldGeom = null;
  try {
    builders    = await import(F('/packages/glyph3d-core/src/workers/builders/index.js'));
    cellMetrics = await import(F('/packages/glyph3d-core/src/core/cellMetrics.js'));
    shaping     = await import(F('/packages/glyph3d-core/src/shaping/shapeText.js'));
    bridgeMod   = await import(F('/packages/glyph3d-core/src/workers/WorkerBridge.js'));
    foldEval    = await import(F('/packages/glyph3d-core/src/core/foldEvaluate.js'));
    foldGeom    = await import(F('/packages/glyph3d-core/src/core/foldGeometry.js'));
  } catch (e) { return { fatal: 'builder import failed: ' + (e && e.message || e) }; }

  // Metrics EXACTLY as CodeGrid._prepareAddsForBuild assembles them (computeCellMetrics off the
  // live atlas charSize) — no hardcoded character dimensions anywhere in this harness.
  const charSize = atlas.getCharSize();
  const metrics = Object.assign(
    cellMetrics.computeCellMetrics(charSize, o.worldScale),
    { worldScale: o.worldScale, atlasSize: atlas.getAtlasTexture().width },
  );
  R.metrics = { charSize: { w: charSize.width, h: charSize.height }, charWidth: metrics.charWidth,
    charHeight: metrics.charHeight, lineSpacing: metrics.lineSpacing, letterSpacing: metrics.letterSpacing,
    worldScale: metrics.worldScale, upem: (atlas._shaper && atlas._shaper.upem) || null };

  // Live Slug growth, same as the grid path: first sighting of a codepoint allocates its slot
  // in the shared shape cache (otherwise fresh glyphs shape to a blank cell).
  try {
    if (atlas._live && atlas._shapeCache) {
      const fresh = [];
      for (let i = 0; i < o.text.length;) { const cp = o.text.codePointAt(i); i += cp > 0xFFFF ? 2 : 1; if (cp > 32) fresh.push(cp); }
      atlas._live.ensureCodepoints(fresh, atlas._shapeCache);
    }
  } catch (e) { R.notes.push('ensureCodepoints: ' + (e && e.message || e)); }

  // Each mode is a BUILDER layout bundle (what the CPU reference folds with) paired with the
  // kernel's mode name. 'newspaper' has no separate kernel mode — it IS 'column' with pageHeight
  // > 0, exactly as the builder treats it.
  const Z = 0.15, GX = 10, GY = 10, PD = 20;
  const MODE_TABLE = {
    flat:       { kernelMode: 'flat',    layout: { wrapWidth: 0,           zWrapSpacing: Z, pageHeight: 0,            pagesWide: 1,            pageGapX: GX, pageGapY: GY, pageDepth: PD, axis: 'xy' } },
    column:     { kernelMode: 'column',  layout: { wrapWidth: o.wrapWidth, zWrapSpacing: Z, pageHeight: 0,            pagesWide: 1,            pageGapX: GX, pageGapY: GY, pageDepth: PD, axis: 'xy' } },
    wrap4:      { kernelMode: 'column',  layout: { wrapWidth: 4,           zWrapSpacing: Z, pageHeight: 0,            pagesWide: 1,            pageGapX: GX, pageGapY: GY, pageDepth: PD, axis: 'xy' } },
    newspaper:  { kernelMode: 'column',  layout: { wrapWidth: o.wrapWidth, zWrapSpacing: Z, pageHeight: o.pageHeight, pagesWide: o.pagesWide,  pageGapX: GX, pageGapY: GY, pageDepth: PD, axis: 'xy' } },
    'z-pages':  { kernelMode: 'z-pages', layout: { wrapWidth: o.wrapWidth, zWrapSpacing: Z, pageHeight: o.pageHeight, pagesWide: 1,            pageGapX: GX, pageGapY: GY, pageDepth: PD, axis: 'z'  } },
  };
  const entry = MODE_TABLE[o.mode];
  if (!entry) return { fatal: 'unknown mode ' + o.mode + ' (' + Object.keys(MODE_TABLE).join('|') + ')' };
  const layout = builders.resolveLayoutParams(entry.layout);
  R.kernelMode = entry.kernelMode;

  const origin = { x: 0, y: 0, z: 0 };
  const color = { r: 1, g: 1, b: 1 };
  const items = [{ text: o.text, position: origin, color, scale: 1, groupId: 0 }];

  let buffers, buildPath;
  const bridge = bridgeMod.getWorkerBridge && bridgeMod.getWorkerBridge();
  if (bridge && bridge.fontReady) {
    // Same module instance as the app (the singleton already carries the booted shaper) —
    // this is the exact call CodeGrid._flush() makes.
    buffers = bridge.buildBatchBuffersSync(items, { metrics, defaultColor: color, layout, scrollOffset: 0 });
    buildPath = 'WorkerBridge.buildBatchBuffersSync (app singleton — same module graph)';
  } else {
    // The /@fs import landed on a SEPARATE module instance (fresh singleton, no shaper).
    // Same builder, shaped off the live atlas cache by hand — still zero reimplementation.
    const shaperOrCache = atlas._shapeCache || atlas._shaper;
    if (!shaperOrCache) return { fatal: 'no shaper/shape cache on the live atlas' };
    const shapedItems = items.map((it) => ({ position: it.position, color: it.color, scale: it.scale,
      groupId: it.groupId, shaped: shaping.shapeText(shaperOrCache, it.text) }));
    buffers = builders.buildBatchBuffers(shapedItems, { metrics, defaultColor: color,
      upem: atlas._shaper ? atlas._shaper.upem : 0, layout, scrollOffset: 0 });
    buildPath = 'buildBatchBuffers (direct — /@fs import is a separate module instance)';
    R.notes.push('WorkerBridge singleton not shared with the app (fontReady=false); used the direct builder call');
  }
  R.buildPath = buildPath;

  const sizes = buffers.sizes;
  const meta = buffers.itemMeta[0];
  const slotCount = buffers.count;
  const lineOffsets = (meta && meta.lineSlotOffsets) || [0];
  const lineTable = Uint32Array.from(lineOffsets);
  const srcLines = o.text.split('\\n');

  // slot → (line, col, codepoint). The builder emits one slot per CODEPOINT, so this walk is
  // the identity mapping — and asserting it matches slotCount is itself a tooth.
  const slotLine = new Int32Array(slotCount), slotCol = new Int32Array(slotCount), slotCp = new Int32Array(slotCount);
  let k = 0;
  for (let li = 0; li < srcLines.length; li++) {
    const L = srcLines[li];
    let col = 0;
    for (let i = 0; i < L.length;) {
      const cp = L.codePointAt(i); i += cp > 0xFFFF ? 2 : 1;
      if (k < slotCount) { slotLine[k] = li; slotCol[k] = col; slotCp[k] = cp; }
      k++; col++;
    }
  }

  // ---- COVERAGE TEETH (before any comparison — an empty-vs-empty diff is vacuous) ----
  const xs = new Set(), ys = new Set(), zs = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, finite = true;
  for (let i = 0; i < slotCount; i++) {
    const x = cpu[i * 3], y = cpu[i * 3 + 1], z = cpu[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) finite = false;
    if (xs.size < 64) xs.add(Math.round(x * 1e6)); if (ys.size < 64) ys.add(Math.round(y * 1e6));
    if (zs.size < 64) zs.add(Math.round(z * 1e6));
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const emptyLines = lineTable.length > 1 && Array.from(lineTable).some((v, i) => i > 0 && v === lineTable[i - 1]);
  let ascending = lineTable.length > 0 && lineTable[0] === 0;
  for (let i = 1; i < lineTable.length; i++) if (lineTable[i] < lineTable[i - 1]) ascending = false;
  let longestLineCps = 0;
  for (const L of srcLines) { let n = 0; for (let i = 0; i < L.length;) { const cp = L.codePointAt(i); i += cp > 0xFFFF ? 2 : 1; n++; } if (n > longestLineCps) longestLineCps = n; }

  tooth('slotCount > 0', slotCount > 0, slotCount);
  tooth('source lines > 3', srcLines.length > 3, srcLines.length);
  tooth('positions finite (no NaN/Inf)', finite);
  tooth('> 1 distinct x', xs.size > 1, xs.size >= 64 ? '64+' : xs.size);
  tooth('> 1 distinct y', ys.size > 1, ys.size >= 64 ? '64+' : ys.size);
  tooth('x span > 0', maxX - minX > 0, (maxX - minX).toFixed(4));
  tooth('y span > 0', maxY - minY > 0, (maxY - minY).toFixed(4));
  tooth('one slot per codepoint', k === slotCount, k + ' walked vs ' + slotCount + ' slots');
  tooth('lineTable[0] === 0 and never decreases', ascending, 'len ' + lineTable.length);
  tooth('lineTable length === source line count', lineTable.length === srcLines.length, lineTable.length + ' vs ' + srcLines.length);
  tooth('an EMPTY line is present (repeated offset)', emptyLines);
  // ---- the layout scan: the per-slot advance prefix sum + the visual-row prefix, plus the
  //      three scalars the page stride and the extent are closed forms on. The SHARED
  //      implementation (core/foldGeometry.layoutScan) — the same one configure() runs, so
  //      "widest row" cannot mean two different things across the wire.
  const advances = new Float32Array(slotCount);
  for (let i = 0; i < slotCount; i++) advances[i] = sizes[i * 2];
  const wrapCols = entry.kernelMode === 'flat' ? 0 : Math.max(0, Math.trunc(layout.wrapWidth));
  const lineStartRow = new Uint32Array(lineTable.length);
  const scan = foldGeom.layoutScan({
    slotCount, lineTable, sizes, wrapWidth: wrapCols, lineStartRow,
  });
  R.totalRows = scan.totalRows;
  R.maxRowExtent = scan.maxRowExtent;

  // THE CPU REFERENCE: the fold, longhand, one glyph at a time — from the builder's own line
  // table and real advances. Everything below diffs the GPU against this.
  const page = foldGeom.pageFold(
    Object.assign({}, layout, { wrapWidth: wrapCols }), metrics, scan.maxRowExtent);
  const cpu = foldEval.evaluateFold({
    slotCount, lineTable, advances, origin, scrollOffset: 0,
    wrapWidth: wrapCols, lineSpacing: metrics.lineSpacing,
    zStep: metrics.charHeight * layout.zWrapSpacing,
    page,
  });
  // y = origin.y − lineStartRow[L] × lineSpacing. Pagination remaps y wholesale, but only PAST
  // the first page — rows inside it are untouched — so restricting to those keeps one tooth
  // valid in every mode, wrapped or paginated.
  {
    const rowLimit = layout.pageHeight > 0 ? layout.pageHeight : Infinity;
    let rowsAgree = false, firstBadLine = -1, checked = 0;
    for (let L = 0; L < lineTable.length; L++) {
      const start = lineTable[L];
      const end = L + 1 < lineTable.length ? lineTable[L + 1] : slotCount;
      if (end <= start || lineStartRow[L] >= rowLimit) continue;   // empty, or past page 0
      checked++;
      if (Math.abs(cpu[start * 3 + 1] - (origin.y - lineStartRow[L] * metrics.lineSpacing)) > 1e-4) {
        firstBadLine = L; break;
      }
    }
    rowsAgree = checked > 0 && firstBadLine < 0;
    tooth('lineStartRow scan reproduces line y (y = origin − row × lineSpacing)', rowsAgree,
      firstBadLine >= 0 ? 'first disagreement at line ' + firstBadLine
        : checked + ' lines checked, ' + R.totalRows + ' rows total');
  }

  if (o.mode === 'column' || o.mode === 'wrap4') {
    const wrapped = longestLineCps > layout.wrapWidth;
    const fix = wrapped ? null : 'longest line ' + longestLineCps + ' cps ≤ wrapWidth ' +
      layout.wrapWidth + ' — nothing wrapped; rerun with --wrap-width below ' + longestLineCps;
    tooth('a line exceeds wrapWidth (wrap path exercised)', wrapped,
      fix || ('longest ' + longestLineCps + ' cps vs wrapWidth ' + layout.wrapWidth));
    tooth('> 1 distinct z (z-staircase engaged)', zs.size > 1,
      zs.size > 1 ? (zs.size >= 64 ? '64+' : zs.size) : 'only 1 z plane — no wrap occurred');
  }
  if (layout.pageHeight > 0) {
    // Pagination fires when the content reaches past one page — the one gate, the same
    // comparison the shader makes per slot. No separate "did it fire" witness exists.
    const paged = scan.totalRows - 1 >= layout.pageHeight;
    tooth('pagination fired (rows past one page)', paged,
      paged ? scan.totalRows + ' rows vs pageHeight ' + layout.pageHeight
            : 'content never exceeded pageHeight ' + layout.pageHeight + ' rows — lower --page-height');
    if (layout.axis === 'z') tooth('> 1 distinct z (pages recede in depth)', zs.size > 1, zs.size);
    else tooth('> 1 page column in x (pages fan right)', xs.size > 1, xs.size >= 64 ? '64+' : xs.size);
  }

  R.slotCount = slotCount;
  R.lineCount = srcLines.length;
  R.longestLineCps = longestLineCps;
  R.layout = layout;
  R.bounds = { minX, maxX, minY, maxY };
  R.lineTableHead = Array.from(lineTable.slice(0, 12));

  // ---- THE CELL WIDTH IS THE BUILDER'S OWN ADVANCE, NOT charWidth ----
  // metrics.charWidth is atlas.getCharSize().width × worldScale, and getCharSize().width is
  // CEIL'd to whole pixels (deriveCharSize in glyphEngine.js). The builder never uses it for x:
  // it steps by sg.ax / upem × (worldScale × pixelHeight) × scale. The two differ by the ceil
  // (~11% on this font), which would smear the whole comparison. So the cell width is taken
  // from the builder's OWN emitted advance (buffers.sizes) — its modal value — and the metric-
  // derived number is reported alongside as a mismatch warning.
  const bins = new Map();
  for (let i = 0; i < slotCount; i++) {
    const key = Math.round(sizes[i * 2] * 1e6);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  let modalKey = 0, modalCount = -1;
  for (const [key, count] of bins) if (count > modalCount) { modalCount = count; modalKey = key; }
  const cellWidth = slotCount > 0 ? modalKey / 1e6 : metrics.charWidth + metrics.letterSpacing;
  const cellHeight = metrics.lineSpacing;
  const cellWidthFromMetrics = metrics.charWidth + metrics.letterSpacing;

  let nonUniform = 0; const nonUniformSample = [];
  for (let i = 0; i < slotCount; i++) {
    const adv = sizes[i * 2];
    if (Math.abs(adv - cellWidth) > 1e-6) {
      nonUniform++;
      if (nonUniformSample.length < 6) nonUniformSample.push({ slot: i, line: slotLine[i], col: slotCol[i],
        cp: 'U+' + slotCp[i].toString(16).toUpperCase(), advance: adv, cellWidth });
    }
  }
  let advanceFontUnits = null;
  try { advanceFontUnits = atlas._shapeCache ? atlas._shapeCache.lookup(0x4D).ax : null; } catch (e) { /* diagnostic only */ }
  R.advance = { cellWidth, cellHeight, cellWidthFromMetrics, modalCount, distinctAdvances: bins.size,
    advanceFontUnits, nonUniformSlots: nonUniform, sample: nonUniformSample };

  // The cell model must actually reproduce a real line — otherwise "cellWidth"/"cellHeight" are
  // fictions and every kernel comparison downstream is meaningless. Both probes stay inside the
  // pre-wrap region so the column mode's z-staircase can't skew them.
  const cpsOf = (s) => { let n = 0; for (let i = 0; i < s.length;) { const cp = s.codePointAt(i); i += cp > 0xFFFF ? 2 : 1; n++; } return n; };
  const wrapAt = layout.wrapWidth > 0 ? layout.wrapWidth : Infinity;
  const line0End = Math.min(lineTable.length > 1 ? lineTable[1] : slotCount, wrapAt);
  let cellReproducesLine0 = line0End > 0;
  for (let i = 0; i < line0End; i++) {
    if (Math.abs(cpu[i * 3] - (origin.x + i * cellWidth)) > 1e-4) { cellReproducesLine0 = false; break; }
  }
  tooth('cellWidth reproduces line 0 x positions (x = origin + col × cellWidth)', cellReproducesLine0,
    'line 0 = ' + line0End + ' slots checked');

  // cellHeight must BE the row pitch: two rows that actually differ in the CPU build have to sit
  // exactly one multiple of it apart. (The lineStartRow tooth below covers every line; this one
  // pins the VALUE handed to the kernel as params.cellHeight.)
  let pitchOk = false, pitchNote = 'no second row in the build';
  for (let i = 1; i < slotCount; i++) {
    const dy = cpu[(i - 1) * 3 + 1] - cpu[i * 3 + 1];
    if (dy > 1e-6) {
      const k = dy / cellHeight;
      pitchOk = Math.abs(k - Math.round(k)) < 1e-4 && Math.round(k) >= 1;
      pitchNote = 'first row drop ' + dy.toFixed(6) + ' = ' + (dy / cellHeight).toFixed(4) + ' × cellHeight';
      break;
    }
  }
  tooth('cellHeight is the row pitch', pitchOk, pitchNote);

  // ---- GPU side ----
  let Kernel = null;
  if (o.selftest) {
    // --selftest: a CPU reference model standing in for the kernel, with the SAME constructor /
    // configure / compute / readPositions surface. It proves every stage downstream of the CPU
    // build (offscreen renderer, call sequence, readback shape, per-slot diff, mismatch report)
    // without a kernel module on disk — and it doubles as the executable spec for the kernel:
    // this is exactly what the GPU is expected to reproduce from (slotCount, lineTable, params).
    R.kernelSource = 'SELF-TEST reference model (--selftest)';
    Kernel = class SelfTestLayoutKernel {
      constructor(renderer, opts) {
        if (!renderer) throw new Error('selftest: no renderer handed to the kernel');
        this._renderer = renderer; this._maxSlots = opts && opts.maxSlots;
      }
      configure(cfg) {
        this._cfg = cfg;
        // The real kernel derives lineStartRow + the row extents from its own layoutScan;
        // mirror that here so the self-test exercises the same interface, not a richer one.
        const it = cfg.items[0];
        const wrap = it.params.mode === 'flat' ? 0 : Math.max(0, Math.trunc(it.params.wrapWidth));
        this._lsr = new Uint32Array(it.lineTable.length);
        this._scan = foldGeom.layoutScan({
          slotCount: it.slotCount, lineTable: it.lineTable, sizes: it.sizes,
          sizeBase: it.sizeBase || 0, wrapWidth: wrap, lineStartRow: this._lsr,
        });
        return [this._scan];
      }
      async compute() {
        const { slotCount: n, lineTable: lt, sizes: sz, sizeBase, params: p } = this._cfg.items[0];
        const lsr = this._lsr, base = sizeBase || 0;
        const out = new Float32Array(n * 3);
        const wrap = p.mode === 'flat' ? 0 : Math.max(0, Math.trunc(p.wrapWidth));
        const ls = p.cellHeight;
        for (let L = 0; L < lt.length; L++) {
          const start = lt[L], end = L + 1 < lt.length ? lt[L + 1] : n;
          // x is a SEGMENTED PREFIX SUM of the per-slot advances — not col × cellWidth. That is
          // the whole reason "advances" is an input: a wide glyph carries its own step.
          let x = p.originX, seg = 0, row = lsr[L], z = p.originZ;
          for (let i = start; i < end; i++) {
            if (wrap && seg >= wrap) { row++; seg = 0; x = p.originX; z -= p.zWrapStep; }
            out[i * 3] = x; out[i * 3 + 1] = p.originY - row * ls; out[i * 3 + 2] = z;
            x += sz ? sz[(base + i) * 2] : p.cellWidth;
            seg++;
          }
        }
        // Pagination, applied after the whole item is laid out — same order as the builder.
        const H = p.pageHeight * ls;
        if (H > 0) {
          // The page gap multiplies charAdvance (metrics.charWidth + letterSpacing) — the CEIL'd
          // pixel metric — NOT the real glyph advance the x-step uses. Two different cell widths
          // in one builder; the page-fold geometry is where they part.
          const unit = p.pageGapUnit > 0 ? p.pageGapUnit : p.cellWidth;
          const Wp = this._scan.maxRowExtent > 0 ? this._scan.maxRowExtent : wrap * unit;
          const gapX = p.pageGapX * unit, gapY = p.pageGapY * ls;
          const pagesWide = Math.max(1, Math.trunc(p.pagesWide)), depth = p.pageDepth * ls;
          for (let i = 0; i < n; i++) {
            const relY = p.originY - out[i * 3 + 1];
            if (relY < H) continue;
            const vPage = Math.floor(relY / H), rowOff = relY - vPage * H;
            if (p.axis === 'z') { out[i * 3 + 1] = p.originY - rowOff; out[i * 3 + 2] -= vPage * depth; }
            else {
              out[i * 3] += (vPage % pagesWide) * (Wp + gapX);
              out[i * 3 + 1] = p.originY - (rowOff + Math.floor(vPage / pagesWide) * (H + gapY));
            }
          }
        }
        this._out = out;
      }
      async readPositions() { return this._out; }
    };
  } else {
    try {
      const mod = await import(F('/packages/glyph3d-core/src/compute/GlyphLayoutKernel.js'));
      Kernel = mod.GlyphLayoutKernel || mod.default || null;
      R.kernelSource = 'packages/glyph3d-core/src/compute/GlyphLayoutKernel.js';
      if (!Kernel) R.kernelSkip = 'module loaded but exports no GlyphLayoutKernel / default';
    } catch (e) { R.kernelSkip = 'import failed: ' + (e && e.message || e); }
  }

  if (!Kernel) { if (o.dump) R.cpuPositions = Array.from(cpu.slice(0, Math.min(slotCount, 20000) * 3)); return R; }

  // A SECOND, offscreen renderer — the live scene's renderer is never touched. Cached on window
  // so running several modes in one page doesn't churn GPU devices.
  const store = window.__layoutKernelCheck || (window.__layoutKernelCheck = {});
  try {
    if (o.useLiveRenderer) { store.renderer = client.ctx.renderer; R.rendererMode = 'LIVE renderer (--use-live-renderer)'; }
    else if (!store.renderer) {
      const Ctor = client.ctx.renderer && client.ctx.renderer.constructor;
      if (!Ctor) throw new Error('client.ctx.renderer missing — cannot reach the WebGPURenderer class');
      // trackTimestamp arms the WebGPU timestamp-query pool so --bench can read PURE GPU
      // execution time; it costs nothing unless resolveTimestampsAsync is called.
      store.renderer = new Ctor({ antialias: false, trackTimestamp: true });
      await store.renderer.init();
      R.rendererMode = 'offscreen second WebGPURenderer (' + Ctor.name + ')';
    } else R.rendererMode = 'offscreen second WebGPURenderer (reused)';
  } catch (e) { R.kernelSkip = 'offscreen renderer init failed: ' + (e && e.message || e); return R; }

  // Params: cellWidth/cellHeight are the contract; the rest are the SAME numbers the CPU build
  // used, passed through so the kernel can read whichever it needs without a second derivation.
  const params = {
    mode: entry.kernelMode, cellWidth, cellHeight,
    origin, originX: origin.x, originY: origin.y, originZ: origin.z,
    wrapWidth: layout.wrapWidth, zWrapSpacing: layout.zWrapSpacing,
    // The builder multiplies charHeight for the z step but lineSpacing for every page gap; they
    // coincide only while LINE_PITCH === 1.0, so the exact world step is passed explicitly.
    zWrapStep: metrics.charHeight * layout.zWrapSpacing,
    pageHeight: layout.pageHeight, pagesWide: layout.pagesWide,
    pageGapX: layout.pageGapX, pageGapY: layout.pageGapY, pageDepth: layout.pageDepth,
    // The page gap multiplies charAdvance = metrics.charWidth +
    // letterSpacing — the CEIL'd pixel metric — while x steps by the REAL advance. They differ
    // by ~12%, so the gap unit is its own param; the world-unit forms are handed over too.
    pageGapUnit: metrics.charWidth + metrics.letterSpacing,
    pageGapXWorld: layout.pageGapX * (metrics.charWidth + metrics.letterSpacing),
    pageGapYWorld: layout.pageGapY * metrics.lineSpacing,
    pageDepthWorld: layout.pageDepth * metrics.lineSpacing,
    // The x page stride depends on the widest laid-out row. configure() measures it in its own
    // layout scan and writes it into the item table, so it is NOT an input — it is reported here
    // only so a divergence can be read against the CPU scan's value.
    contentWidth: scan.maxRowExtent,
    axis: layout.axis, scrollOffset: 0,
    // Derived conveniences under the spec's other vocabulary — a superset, since resolveParams
    // reads per-key with ?? and ignores what it doesn't know.
    charWidth: metrics.charWidth, charHeight: metrics.charHeight,
    lineSpacing: metrics.lineSpacing, letterSpacing: metrics.letterSpacing,
    linePitch: cellMetrics.LINE_PITCH, worldScale: metrics.worldScale, scale: 1,
  };
  R.params = Object.assign({}, params, { origin: undefined });

  let gpu; let benchKernel = null;
  try {
    const t0 = performance.now();
    const kernel = new Kernel(store.renderer, { maxSlots: slotCount, maxLines: lineTable.length });
    // The kernel takes the field's own sizes array directly and runs its own layoutScan — no
    // advance copy crosses the boundary, and the row extent it paginates by is the one it
    // measured itself.
    kernel.configure({ items: [{ slotCount, lineTable, sizes, sizeBase: 0, outBase: 0, params }], totalSlots: slotCount });
    await kernel.compute();
    gpu = await kernel.readPositions();
    R.kernelMs = Math.round(performance.now() - t0);

    // Displacement parity (stage 4): arm a deterministic CPU-authored table, re-dispatch,
    // and expect EXACTLY builder positions + D. One mode carries it (wrap4 — wraps ensure
    // the add lands after seg/page math). setDisplacements may reallocate + rebuild the
    // kernel, so configure again before dispatching.
    if (o.mode === 'wrap4' && typeof kernel.setDisplacements === 'function') {
      const D = new Float32Array(slotCount * 3);
      for (let s = 0; s < slotCount; s++) {
        D[s * 3] = ((s % 7) - 3) * 0.25;
        D[s * 3 + 1] = ((s % 5) - 2) * 0.5;
        D[s * 3 + 2] = ((s % 3) - 1) * 0.125;
      }
      kernel.setDisplacements(D);
      kernel.configure({ items: [{ slotCount, lineTable, sizes, sizeBase: 0, outBase: 0, params }], totalSlots: slotCount });
      await kernel.compute();
      const gpuD = await kernel.readPositions();
      let over = 0, worst = 0;
      for (let s = 0; s < slotCount * 3; s++) {
        const d = Math.abs(gpuD[s] - (cpu[s] + D[s]));
        if (d > worst) worst = d;
        if (d > o.eps) over++;
      }
      R.disp = { over, worst, checked: slotCount * 3 };
      // Restore the undisplaced state for any later bench reuse.
      kernel.setDisplacements(null);
      kernel.configure({ items: [{ slotCount, lineTable, sizes, sizeBase: 0, outBase: 0, params }], totalSlots: slotCount });
      await kernel.compute();
    }

    if (o.bench && !o.selftest) benchKernel = kernel;
    else if (typeof kernel.dispose === 'function') kernel.dispose();
  } catch (e) { R.kernelError = (e && e.stack ? String(e.stack).split('\\n').slice(0, 4).join(' | ') : String(e && e.message || e)); return R; }

  if (!gpu || typeof gpu.length !== 'number') { R.kernelError = 'readPositions() returned ' + Object.prototype.toString.call(gpu); return R; }
  R.gpuLength = gpu.length;
  tooth('readPositions() length === slotCount * 3', gpu.length === slotCount * 3, gpu.length + ' vs ' + slotCount * 3);

  // ---- per-slot diff ----
  const maxAbs = [0, 0, 0]; const argMax = [-1, -1, -1];
  let over = 0; const mismatches = [];
  const n = Math.min(slotCount, Math.floor(gpu.length / 3));
  for (let i = 0; i < n; i++) {
    let bad = false; const d = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(gpu[i * 3 + c] - cpu[i * 3 + c]);
      d[c] = delta;
      if (delta > maxAbs[c]) { maxAbs[c] = delta; argMax[c] = i; }
      if (delta > o.eps) bad = true;
    }
    if (bad) {
      over++;
      if (mismatches.length < 5) mismatches.push({
        slot: i, line: slotLine[i], col: slotCol[i],
        cp: 'U+' + slotCp[i].toString(16).toUpperCase(),
        char: JSON.stringify(String.fromCodePoint(slotCp[i] || 32)),
        cpu: [cpu[i * 3], cpu[i * 3 + 1], cpu[i * 3 + 2]],
        gpu: [gpu[i * 3], gpu[i * 3 + 1], gpu[i * 3 + 2]],
        delta: d,
      });
    }
  }
  // Where the worst x delta landed, and what it implies. The CPU builder ACCUMULATES
  // (x += advance, rounded to f32 on every store); a kernel that computes x = col × cellWidth
  // in closed form drifts against that accumulation, linearly in the column index. Projecting
  // the per-column rate says how long a line can get before the drift alone breaks epsilon.
  const wx = argMax[0] >= 0 ? { slot: argMax[0], line: slotLine[argMax[0]], col: slotCol[argMax[0]] } : null;
  const perCol = wx && wx.col > 0 ? maxAbs[0] / wx.col : 0;
  R.diff = { compared: n, over, eps: o.eps, maxAbs, argMax, mismatches,
    overFraction: n ? over / n : 0, worstX: wx, perColumnDrift: perCol,
    epsColumnBudget: perCol > 0 ? Math.floor(o.eps / perCol) : null };
  // ---- bench: decompose where the milliseconds actually live ----
  // The check's own kernelMs bundles pipeline creation + a full readback fence, neither of
  // which the render path pays. This separates: the CPU table walk (the offload budget),
  // amortized steady-state dispatch (submit + GPU execution, no readback — the real per-
  // relayout cost), pure GPU execution (timestamp queries, when the device grants them),
  // and the readback round trip (test-only apparatus).
  if (benchKernel) {
    try {
      const K = benchKernel, RD = store.renderer, N = Math.max(10, o.benchN || 200);
      const B = { n: N };
      { const REPS = 20; const t0 = performance.now();
        for (let i = 0; i < REPS; i++) K.configure({ items: [{ slotCount, lineTable, sizes, sizeBase: 0, outBase: 0, params }], totalSlots: slotCount });
        B.configureMs = (performance.now() - t0) / REPS; }
      { const t0 = performance.now();
        for (let i = 0; i < 3; i++) bridge && bridge.fontReady
          ? bridge.buildBatchBuffersSync(items, { metrics, defaultColor: color, layout, scrollOffset: 0 })
          : builders.buildBatchBuffers([{ position: origin, color, scale: 1, groupId: 0,
              shaped: shaping.shapeText(atlas._shapeCache || atlas._shaper, o.text) }],
              { metrics, defaultColor: color, upem: (atlas._shaper && atlas._shaper.upem) || 0, layout, scrollOffset: 0 });
        B.cpuBuildMs = (performance.now() - t0) / 3; }
      const queue = RD.backend && RD.backend.device && RD.backend.device.queue;
      try { if (RD.resolveTimestampsAsync) await RD.resolveTimestampsAsync('compute'); } catch (e) { /* pool may be empty */ }
      { const t0 = performance.now();
        for (let i = 0; i < N; i++) await K.compute();
        if (queue) await queue.onSubmittedWorkDone();
        B.dispatchMs = (performance.now() - t0) / N; }
      try {
        const total = RD.resolveTimestampsAsync ? await RD.resolveTimestampsAsync('compute') : null;
        B.gpuMs = typeof total === 'number' && total > 0 ? total / N : null;
      } catch (e) { B.gpuMs = null; B.gpuNote = String(e && e.message || e); }
      { const t0 = performance.now(); await K.readPositions(); B.readbackMs = performance.now() - t0; }
      R.bench = B;
    } catch (e) { R.benchError = String(e && e.message || e); }
    if (typeof benchKernel.dispose === 'function') benchKernel.dispose();
  }

  if (o.dump) {
    const cap = Math.min(n, 20000) * 3;
    R.cpuPositions = Array.from(cpu.slice(0, cap));
    R.gpuPositions = Array.from(gpu.slice(0, cap));
  }
  return R;
})(${JSON.stringify(opts)})`;

// ---- the bulk-load probe (--dir): the tree-load tight loop, three ways ----
// CPU baseline (today's per-file build), GPU serial (configure + await per file — the naive
// integration), GPU pipelined (configure + fire per file, ONE fence at the end — the repo-load
// pattern; queue order makes upload_i precede dispatch_i, so reusing one kernel's buffers is
// sound). Ends with an exactness spot-check on the LARGEST file so the bench can't quietly
// diverge from the gate. No backticks in here: this rides a template literal.
const bulkProbe = (opts) => `(async (o) => {
  const R = { files: o.files.length, notes: [] };
  const client = window.__glyphClient;
  if (!client) return { fatal: 'window.__glyphClient missing — the app did not boot' };
  const atlas = client.ctx && client.ctx.atlas;
  if (!atlas) return { fatal: 'client.ctx.atlas missing' };
  const F = (p) => '/@fs' + o.repo + p;

  let builders, cellMetrics, bridgeMod, kmod;
  try {
    builders    = await import(F('/packages/glyph3d-core/src/workers/builders/index.js'));
    cellMetrics = await import(F('/packages/glyph3d-core/src/core/cellMetrics.js'));
    bridgeMod   = await import(F('/packages/glyph3d-core/src/workers/WorkerBridge.js'));
    kmod        = await import(F('/packages/glyph3d-core/src/compute/GlyphLayoutKernel.js'));
  } catch (e) { return { fatal: 'import failed: ' + (e && e.message || e) }; }
  const Kernel = kmod.default;
  const bridge = bridgeMod.getWorkerBridge && bridgeMod.getWorkerBridge();
  if (!bridge || !bridge.fontReady) return { fatal: 'app WorkerBridge not font-ready — boot incomplete' };

  const charSize = atlas.getCharSize();
  const metrics = Object.assign(
    cellMetrics.computeCellMetrics(charSize, o.worldScale),
    { worldScale: o.worldScale, atlasSize: atlas.getAtlasTexture().width },
  );
  const layout = builders.resolveLayoutParams({ wrapWidth: o.wrapWidth, zWrapSpacing: 0.15, pageHeight: 0, pagesWide: 1, axis: 'xy' });
  const color = { r: 1, g: 1, b: 1 };
  const origin = { x: 0, y: 0, z: 0 };

  // Atlas growth is a one-time cost of first sight, not a per-layout cost — pay it up front
  // and report it separately so the loops measure layout, not Slug encoding.
  { const t0 = performance.now();
    const fresh = [];
    for (const file of o.files) for (let i = 0; i < file.text.length;) {
      const cp = file.text.codePointAt(i); i += cp > 0xFFFF ? 2 : 1; if (cp > 32) fresh.push(cp);
    }
    try { if (atlas._live && atlas._shapeCache) atlas._live.ensureCodepoints(fresh, atlas._shapeCache); } catch (e) { R.notes.push('ensureCodepoints: ' + (e && e.message || e)); }
    R.atlasWarmMs = performance.now() - t0; }

  const shared = { metrics, defaultColor: color, layout, scrollOffset: 0 };
  const perFileCpu = new Float64Array(o.files.length);
  const built = new Array(o.files.length);

  // ---- lane 1: today's CPU build, file by file (the tree-load inner loop as it exists) ----
  { const t0 = performance.now();
    for (let fi = 0; fi < o.files.length; fi++) {
      const t1 = performance.now();
      built[fi] = bridge.buildBatchBuffersSync(
        [{ text: o.files[fi].text, position: origin, color, scale: 1, groupId: 0 }], shared);
      perFileCpu[fi] = performance.now() - t1;
    }
    R.cpuTotalMs = performance.now() - t0; }

  let totalSlots = 0, maxSlots = 1, maxLines = 1, biggest = 0;
  const tables = new Array(o.files.length);
  for (let fi = 0; fi < o.files.length; fi++) {
    const b = built[fi], meta = b.itemMeta[0];
    const lineTable = Uint32Array.from(meta.lineSlotOffsets);
    tables[fi] = { slotCount: b.count, lineTable, sizes: b.sizes };
    totalSlots += b.count;
    if (b.count > maxSlots) { maxSlots = b.count; biggest = fi; }
    if (lineTable.length > maxLines) maxLines = lineTable.length;
  }
  R.totalSlots = totalSlots;

  const store = window.__layoutKernelCheck || (window.__layoutKernelCheck = {});
  if (!store.renderer) {
    const Ctor = client.ctx.renderer && client.ctx.renderer.constructor;
    if (!Ctor) return { fatal: 'no renderer class reachable' };
    store.renderer = new Ctor({ antialias: false, trackTimestamp: true });
    await store.renderer.init();
  }
  const RD = store.renderer;
  const queue = RD.backend && RD.backend.device && RD.backend.device.queue;
  const params = {
    origin, scrollOffset: 0, wrapWidth: layout.wrapWidth, lineSpacing: metrics.lineSpacing,
    zWrapStep: metrics.charHeight * layout.zWrapSpacing, pageHeight: 0, pagesWide: 1,
    pageGapXWorld: 0, pageGapYWorld: 0, pageDepthWorld: 0, axis: 'xy',
  };
  const kernel = new Kernel(RD, { maxSlots, maxLines });
  const cfg = (fi) => { const t = tables[fi]; kernel.configure({ items: [{ slotCount: t.slotCount,
    lineTable: t.lineTable, sizes: t.sizes, sizeBase: 0, outBase: 0, params }], totalSlots: t.slotCount }); };

  // Warm: first dispatch builds the pipeline; keep it out of both GPU lanes.
  cfg(0); await kernel.compute();
  if (queue) await queue.onSubmittedWorkDone();

  // ---- lane 2: GPU serial — configure + await, file by file (naive per-grid integration) ----
  const perFileGpu = new Float64Array(o.files.length);
  { const t0 = performance.now();
    for (let fi = 0; fi < o.files.length; fi++) {
      const t1 = performance.now();
      cfg(fi); await kernel.compute();
      perFileGpu[fi] = performance.now() - t1;
    }
    if (queue) await queue.onSubmittedWorkDone();
    R.gpuSerialTotalMs = performance.now() - t0; }

  // ---- lane 3: GPU pipelined — fire every file, fence ONCE (the repo-load storm) ----
  try { if (RD.resolveTimestampsAsync) await RD.resolveTimestampsAsync('compute'); } catch (e) { /* pool empty */ }
  { const t0 = performance.now();
    for (let fi = 0; fi < o.files.length; fi++) { cfg(fi); RD.compute(kernel._kernel); }
    if (queue) await queue.onSubmittedWorkDone();
    R.gpuPipelinedTotalMs = performance.now() - t0; }
  try {
    const total = RD.resolveTimestampsAsync ? await RD.resolveTimestampsAsync('compute') : null;
    R.gpuPureTotalMs = typeof total === 'number' && total > 0 ? total : null;
  } catch (e) { R.gpuPureTotalMs = null; }

  // ---- exactness spot-check on the LARGEST file (the bench must not outrun the gate) ----
  { cfg(biggest); await kernel.compute();
    const gpu = await kernel.readPositions();
    const cpu = built[biggest].positions; const n = tables[biggest].slotCount;
    let worst = 0, over = 0;
    for (let i = 0; i < n * 3; i++) { const d = Math.abs(gpu[i] - cpu[i]); if (d > worst) worst = d; if (d > o.eps) over++; }
    R.spot = { file: o.files[biggest].name, slots: n, worst, over }; }
  kernel.dispose();

  const stats = (arr) => { const s = Array.from(arr).sort((a, b) => a - b); const n = s.length;
    return { mean: s.reduce((a, b) => a + b, 0) / n, p50: s[n >> 1], p95: s[Math.min(n - 1, Math.floor(n * 0.95))], max: s[n - 1] }; };
  R.cpuPerFile = stats(perFileCpu);
  R.gpuPerFile = stats(perFileGpu);
  return R;
})(${JSON.stringify(opts)})`;

// ---- reporting ----
const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const f = (n) => (typeof n === 'number' ? (Math.abs(n) < 1e-3 && n !== 0 ? n.toExponential(3) : n.toFixed(6)) : String(n));

function report(r) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push(C.bold(`\n── mode: ${r.mode} ──────────────────────────────────────────`));
  if (r.fatal) { push(`✗ FATAL  ${r.fatal}`); return { text: lines.join('\n'), ok: false, reason: r.fatal }; }

  push(`text        ${TEXT_LABEL}`);
  push(`builder     ${r.buildPath}`);
  push(`metrics     charSize ${r.metrics.charSize.w}x${r.metrics.charSize.h}px · worldScale ${r.metrics.worldScale} · ` +
       `cell ${f(r.advance.cellWidth)} x ${f(r.advance.cellHeight)} · upem ${r.metrics.upem}`);
  push(`layout      ${JSON.stringify(r.layout)}`);
  push(`slots       ${r.slotCount} over ${r.lineCount} lines (longest line ${r.longestLineCps} cps)`);
  push(`lineTable   [${r.lineTableHead.join(', ')}${r.lineTableHead.length < r.lineCount ? ', …' : ''}]`);
  push(`bounds      x [${f(r.bounds.minX)} … ${f(r.bounds.maxX)}]  y [${f(r.bounds.minY)} … ${f(r.bounds.maxY)}]`);
  for (const n of r.notes || []) push(C.dim(`note        ${n}`));

  push('');
  push(C.bold('coverage teeth'));
  let teethOk = true;
  for (const t of r.teeth) {
    if (!t.pass) teethOk = false;
    push(`  ${t.pass ? '✓' : '✗ FAIL'} ${t.name}${t.detail !== null && t.detail !== undefined ? C.dim(`  (${t.detail})`) : ''}`);
  }

  push('');
  push(C.bold('cell width (the kernel contract)'));
  const a = r.advance;
  push(`  cellWidth   ${f(a.cellWidth)}   ${C.dim(`modal builder advance — ${a.modalCount}/${r.slotCount} slots, ${a.distinctAdvances} distinct`)}`);
  push(`  cellHeight  ${f(a.cellHeight)}   ${C.dim('= metrics.lineSpacing')}`);
  if (Math.abs(a.cellWidth - a.cellWidthFromMetrics) > 1e-6) {
    push(`  ${C.bold('⚠')} metrics.charWidth + letterSpacing = ${f(a.cellWidthFromMetrics)} — ` +
         `${(Math.abs(a.cellWidth / a.cellWidthFromMetrics - 1) * 100).toFixed(2)}% OFF the builder's step.`);
    push(C.dim(`    getCharSize().width is CEIL'd to whole pixels; the builder steps by`));
    push(C.dim(`    sg.ax / upem × (worldScale × pixelHeight) × scale${a.advanceFontUnits ? ` (ax('M') = ${a.advanceFontUnits} font units)` : ''}.`));
    push(C.dim('    A kernel that derives cellWidth from charWidth will miss by this factor on EVERY slot.'));
  }
  push(`  ${a.nonUniformSlots} / ${r.slotCount} slots carry an advance ≠ cellWidth (double-width / fallback glyphs)`);
  for (const s of a.sample) {
    push(C.dim(`    slot ${s.slot} L${s.line}:C${s.col} ${s.cp} advance ${f(s.advance)}`));
  }
  if (a.nonUniformSlots > 0) {
    push(C.dim('  → a kernel deriving x from col × cellWidth alone will diverge at and AFTER these slots.'));
  }

  push('');
  if (r.kernelSkip) {
    push(C.bold('kernel  SKIPPED'));
    push(`  ${r.kernelSkip}`);
    push(`  CPU reference built and proven${teethOk ? ' (all teeth green)' : ' — BUT TEETH FAILED'}; nothing to compare against.`);
    return { text: lines.join('\n'), ok: false, reason: teethOk ? `kernel unavailable: ${r.kernelSkip}` : 'coverage teeth failed' };
  }
  if (r.kernelError) {
    push(C.bold('kernel  ERROR'));
    push(`  renderer: ${r.rendererMode}`);
    push(`  ${r.kernelError}`);
    return { text: lines.join('\n'), ok: false, reason: `kernel threw: ${r.kernelError}` };
  }

  push(C.bold('gpu vs cpu'));
  push(`  kernel src  ${r.kernelSource}`);
  push(`  renderer    ${r.rendererMode}`);
  push(`  params      ${JSON.stringify(r.params)}`);
  push(`  kernel      compute+readback ${r.kernelMs}ms · ${r.gpuLength} floats`);
  const d = r.diff;
  push(`  compared    ${d.compared} slots @ eps ${d.eps}`);
  push(`  max |Δ|     x ${f(d.maxAbs[0])} (slot ${d.argMax[0]})  y ${f(d.maxAbs[1])} (slot ${d.argMax[1]})  z ${f(d.maxAbs[2])} (slot ${d.argMax[2]})`);
  push(`  over eps    ${d.over} slots (${(d.overFraction * 100).toFixed(2)}%)`);
  // Only meaningful while the worst delta is sub-cell noise. A delta on the order of a whole
  // cell is a SEMANTIC divergence (a missed double-width advance, a wrong wrap), not drift.
  if (d.worstX && d.perColumnDrift > 0 && d.maxAbs[0] < r.advance.cellWidth * 0.01) {
    push(C.dim(`  worst x at L${d.worstX.line}:C${d.worstX.col} → ${d.perColumnDrift.toExponential(2)} per column`));
    push(C.dim(`  → the CPU builder ACCUMULATES x (f32 rounding each store). At this rate a closed-form`));
    push(C.dim(`    x = col × cellWidth breaks eps ${d.eps} past ~${d.epsColumnBudget} columns — a prefix sum, or an`));
    push(C.dim('    eps that scales with the column index, is what keeps long lines honest.'));
  }
  for (const m of d.mismatches) {
    push(`    slot ${m.slot} L${m.line}:C${m.col} ${m.cp} ${m.char}`);
    push(`      cpu [${m.cpu.map(f).join(', ')}]`);
    push(`      gpu [${m.gpu.map(f).join(', ')}]`);
    push(`      Δ   [${m.delta.map(f).join(', ')}]`);
  }

  if (r.bench) {
    const b = r.bench;
    const ms = (v) => (typeof v === 'number' ? v.toFixed(3) + 'ms' : 'n/a');
    push('');
    push(C.bold(`bench (${b.n} dispatches, ${r.slotCount} slots)`));
    push(`  cpu full build   ${ms(b.cpuBuildMs)}   ${C.dim('shape+layout+attrs — what the GPU path replaces')}`);
    push(`  configure walk   ${ms(b.configureMs)}   ${C.dim('CPU tables (lineTable/rowPrefix/xOffsets) — the residual CPU cost per content change')}`);
    push(`  dispatch steady  ${ms(b.dispatchMs)}   ${C.dim('amortized submit+GPU per relayout, no readback — the real per-fold cost')}`);
    push(`  gpu execution    ${ms(b.gpuMs)}   ${C.dim(b.gpuMs === null ? 'timestamp-query unavailable' + (b.gpuNote ? ' (' + b.gpuNote + ')' : '') : 'pure kernel time (timestamp query)')}`);
    push(`  readback         ${ms(b.readbackMs)}   ${C.dim('test-only apparatus — the render path never pays this')}`);
  }
  if (r.benchError) push(`  bench ERROR  ${r.benchError}`);

  if (r.disp) {
    push(`  displacement ${r.disp.over === 0 ? '✓' : '✗ FAIL'}  ${r.disp.checked} lanes vs builder+D, worst |Δ| ${r.disp.worst.toExponential(2)}`);
  }

  const ok = teethOk && d.over === 0 && (!r.disp || r.disp.over === 0);
  push('');
  push(ok ? C.bold(`✓ PASS  mode ${r.mode}: ${d.compared} slots match within ${d.eps}`)
          : C.bold(`✗ FAIL  mode ${r.mode}: ${!teethOk ? 'coverage teeth failed; ' : ''}${d.over} slot(s) beyond ${d.eps}${r.disp && r.disp.over ? `; displacement ${r.disp.over} lanes off` : ''}`));
  return { text: lines.join('\n'), ok, reason: ok ? null : (!teethOk ? 'coverage teeth failed' : `${d.over} slots beyond eps`) };
}

// ---- run ----
const browser = await launchBrowser({ headed: HEADED });
const results = [];
const raw = [];
let app = null;
try {
  // relayPort intentionally omitted → CLIENT-ONLY. Dialing the relay arms workspace autosave.
  app = await openApp(browser, { url: flag('--url', 'http://localhost:5173/'), wait: 6000 });
  if (!app.booted) {
    console.error('✗ FAIL  the app never exposed window.__glyphClient (is `tools/dev.sh` up on :5173?)');
    if (app.errors.length) console.error('  errors: ' + app.errors.slice(0, 3).map((e) => e.text).join(' | '));
    process.exit(1);
  }
  if (DIR) {
    const corpus = collectDirCorpus(DIR);
    const r = await app.evalPage(bulkProbe({
      repo: REPO, files: corpus, eps: EPS, wrapWidth: WRAP, worldScale: WORLD_SCALE,
    }));
    const ms = (v) => (typeof v === 'number' ? v.toFixed(3) + 'ms' : 'n/a');
    const st = (s) => `mean ${ms(s.mean)} · p50 ${ms(s.p50)} · p95 ${ms(s.p95)} · max ${ms(s.max)}`;
    if (r.fatal) { console.error(`✗ FAIL  ${r.fatal}`); process.exit(1); }
    console.log(C.bold(`\n── bulk load: ${DIR} — ${r.files} files, ${r.totalSlots} slots ──`));
    for (const n of r.notes || []) console.log(C.dim(`note  ${n}`));
    console.log(`  atlas warm-up     ${ms(r.atlasWarmMs)}   ${C.dim('one-time Slug growth, excluded from lanes')}`);
    console.log(`  cpu build total   ${ms(r.cpuTotalMs)}   ${C.dim('per file: ' + st(r.cpuPerFile))}`);
    console.log(`  gpu serial total  ${ms(r.gpuSerialTotalMs)}   ${C.dim('per file: ' + st(r.gpuPerFile))}`);
    console.log(`  gpu pipelined     ${ms(r.gpuPipelinedTotalMs)}   ${C.dim('fire all, fence once — the repo-load storm')}`);
    console.log(`  gpu pure exec     ${ms(r.gpuPureTotalMs)}   ${C.dim('timestamp-query total across the pipelined lane')}`);
    const teethOk = r.files >= 10 && r.totalSlots >= 10000;
    const spotOk = r.spot && r.spot.over === 0;
    console.log(`  spot-check        ${spotOk ? '✓' : '✗ FAIL'} ${r.spot ? `${r.spot.file} (${r.spot.slots} slots, worst |Δ| ${r.spot.worst.toExponential(2)})` : 'missing'}`);
    if (!teethOk) console.log(`  ✗ FAIL vacuous corpus: ${r.files} files / ${r.totalSlots} slots — point --dir at a real tree`);
    console.log(C.bold(spotOk && teethOk ? '\n✓ PASS  bulk bench (exactness held on the largest file)' : '\n✗ FAIL  bulk bench'));
    await browser.close();
    process.exit(spotOk && teethOk ? 0 : 1);
  }

  for (const mode of MODES) {
    const r = await app.evalPage(probe({
      repo: REPO, mode, text: TEXT, eps: EPS, wrapWidth: WRAP, worldScale: WORLD_SCALE,
      dump: !!DUMP, useLiveRenderer: USE_LIVE_RENDERER, selftest: SELFTEST,
      pageHeight: PAGE_HEIGHT, pagesWide: PAGES_WIDE,
      bench: BENCH, benchN: BENCH_N,
    }));
    raw.push(r);
    results.push(report(r));
  }
} catch (err) {
  console.error(`✗ FAIL  harness error: ${err?.message || err}`);
  process.exit(1);
} finally {
  const errs = app ? app.errors.filter((e) => !/GlyphLayoutKernel/.test(e.text)) : [];
  if (errs.length) console.error(C.dim(`\npage errors (${errs.length}): ${errs.slice(0, 3).map((e) => e.text).join(' | ')}`));
  await browser.close();
}

if (DUMP) {
  writeFileSync(DUMP, JSON.stringify(raw, null, 1));
  console.log(C.dim(`dump → ${DUMP}`));
}
if (AS_JSON) console.log(JSON.stringify(raw.map((r, i) => ({ ...r, verdict: results[i].ok ? 'PASS' : 'FAIL', reason: results[i].reason })), null, 2));
else for (const r of results) console.log(r.text);

const failed = results.filter((r) => !r.ok);
console.log(C.bold(`\n${results.length - failed.length}/${results.length} mode(s) passed`));
for (const fr of failed) console.log(`  ✗ ${fr.reason}`);
process.exit(failed.length ? 1 : 0);
