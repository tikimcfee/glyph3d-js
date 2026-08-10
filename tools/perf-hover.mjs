// perf-hover.mjs — CPU-profile the HOVER / picking path in the real app to hunt a frame spike.
//
// Loads a directory of grids, sweeps a SYNTHETIC pointer across the canvas (the real
// pointermove → GPU pick → hover-resolve → bounds path), CPU-profiles the window, and reports
// where main-thread time goes — plus the worst long-task seen (the spike magnitude). Built for
// the "massive frame spike when hovering over a grid" regression hunt.
//
//   bun tools/perf-hover.mjs [--relay PORT] [--dir PATH] [--sweeps N] [--step MS] [--top N] [--out FILE.json]
//
// Needs Vite on :5173 and a PRIVATE relay on --relay (default 8099 — NOT the display's :8080,
// which holds its one display slot). Start one in tmux:
//   glyph3d-cli serve --port 8099 /home/ivan/dev/glyph3d-js
//
// The headless browser gets the real GPU via driver.mjs's angle flags (see dev-loop gotchas #6).

import { launchGpuBrowser, openApp, assertRealGpu } from './itest/driver.mjs';

function parseArgs(argv) {
  const a = { relayPort: 8099, dir: 'packages/glyph3d-core/src/collections', sweeps: 60, step: 35, top: 30, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--relay') a.relayPort = Number(argv[++i]);
    else if (t === '--dir') a.dir = argv[++i];
    else if (t === '--sweeps') a.sweeps = Number(argv[++i]);
    else if (t === '--step') a.step = Number(argv[++i]);
    else if (t === '--top') a.top = Number(argv[++i]);
    else if (t === '--out') a.out = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
// Platform-resolved: headed wherever headless is software, so these numbers
// describe this machine rather than a CPU rasterizer.
const browser = await launchGpuBrowser({});
const app = await openApp(browser, { url: 'http://localhost:5173/', wait: 8000, relayPort: args.relayPort });
const gpu = await assertRealGpu(app, { tool: 'perf-hover' });
console.log(`[gpu] ${gpu.vendor}/${gpu.architecture}`);

try {
  if (!app.booted) throw new Error('app did not boot (is Vite on :5173 and a relay on :' + args.relayPort + ' up?)');

  // 1) Load a batch of grids, settle, frame them (camera.fitall), and FOCUS one grid so there's a
  //    guaranteed on-screen hover target at canvas center.
  const load = await app.evalPage(async ({ dir }) => {
    const c = window.__glyphClient;
    if (c.session) c.session._autosaveOn = false;
    const r = await c.router.execute(['file.openDir', dir]);
    await new Promise((res) => setTimeout(res, 2000));     // tree layout + async content
    await c.router.execute(['camera.fitall']).catch(() => {});
    await new Promise((res) => setTimeout(res, 800));
    const entries = c.ctx?.registry?.findByType?.('grid') || [];
    // Focus a grid roughly in the middle of the set (camera flies to center + zoom it).
    const focusId = entries.length ? entries[Math.floor(entries.length / 2)].id : null;
    if (focusId) await c.router.execute(['camera.focus', focusId]).catch(() => {});
    await new Promise((res) => setTimeout(res, 1600));     // let the fly settle
    return { text: r?.text ?? null, grids: entries.length, focusId };
  }, { dir: args.dir });
  console.log(`loaded: ${load.text} → ${load.grids} grids, focused ${load.focusId}`);

  // 2) Canvas rect (CSS px) for the sweep.
  const rect = await app.evalPage(() => {
    const cv = document.querySelector('canvas');
    const r = cv.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // 3) Arm observers in the page: long tasks (the spike) + distinct grids hovered (engagement proof).
  await app.evalPage(() => {
    window.__lt = [];
    window.__hovered = new Set();
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch { /* longtask unsupported — CPU profile still tells the story */ }
    const am = window.__glyphClient?.ctx?.attentionManager;
    const readHover = am ? () => (am.get?.('hover') ?? am.hover ?? am.slots?.hover ?? null) : () => null;
    window.__hoverPoll = setInterval(() => { const h = readHover(); if (h) window.__hovered.add(typeof h === 'object' ? (h.id ?? JSON.stringify(h)) : h); }, 16);
  });

  // 4) CPU profile around the hover: settle on the focused grid (center) first, then weave the
  //    framed scene, HOLDING at each point so the pick + hover-resolve + any settle work runs.
  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });   // 0.2ms — fine for a short spike
  await cdp.send('Profiler.start');

  const t0 = Date.now();
  await app.page.mouse.move(rect.x + rect.w * 0.5, rect.y + rect.h * 0.5);   // settle on the focused grid
  await app.page.waitForTimeout(350);
  for (let i = 0; i < args.sweeps; i++) {
    const fx = args.sweeps > 1 ? i / (args.sweeps - 1) : 0.5;
    const x = rect.x + rect.w * (0.20 + 0.60 * fx);
    const y = rect.y + rect.h * (0.50 + 0.16 * Math.sin(i * 0.9));
    await app.page.mouse.move(x, y);
    await app.page.waitForTimeout(args.step);                        // HOLD — let the frame + hover-resolve + settle run
  }
  const sweepMs = Date.now() - t0;
  const { profile } = await cdp.send('Profiler.stop');
  const longtasks = await app.evalPage(() => { clearInterval(window.__hoverPoll); return window.__lt || []; });
  const hovered = await app.evalPage(() => [...(window.__hovered || [])].length);
  console.log(`hover engagement: ${hovered} distinct grid(s) hovered during the sweep`);

  // 5) Aggregate self time per function + per module (same shape as profile-bulkload).
  const sampleMs = 0.2;
  const byFn = new Map(), byUrl = new Map();
  let totalSamples = 0;
  for (const node of profile.nodes) {
    const hits = node.hitCount || 0;
    if (!hits) continue;
    totalSamples += hits;
    const cf = node.callFrame;
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    byFn.set(`${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`, (byFn.get(`${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`) || 0) + hits);
    byUrl.set(url || '(native/VM)', (byUrl.get(url || '(native/VM)') || 0) + hits);
  }

  const lt = longtasks.slice().sort((a, b) => b - a);
  console.log(`\nsweep: ${args.sweeps} moves over ${sweepMs}ms · samples ${totalSamples} (~${Math.round(totalSamples * sampleMs)}ms on-CPU)`);
  console.log(`long tasks (>50ms): ${lt.length}${lt.length ? ` — worst ${lt[0]}ms, top: ${lt.slice(0, 8).join(', ')}ms` : ' — none'}`);

  console.log(`\n── top ${args.top} functions by self time ──`);
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top))
    console.log(`${String(Math.round(v * sampleMs)).padStart(7)}ms  ${k}`);
  console.log(`\n── modules by self time ──`);
  for (const [k, v] of [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
    console.log(`${String(Math.round(v * sampleMs)).padStart(7)}ms  ${k}`);

  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, JSON.stringify(profile));
    console.log(`\nraw .cpuprofile: ${args.out}  (load in DevTools ▸ Performance ▸ Load profile)`);
  }
} finally {
  await browser.close();
}
