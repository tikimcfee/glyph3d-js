// profile-bulkload.mjs — CPU-profile a bulk file.openDir in the real app and report
// where main-thread time goes. Built for hunting super-linear load regressions
// (e.g. "200 files = one 53s long task"): attaches a CDP sampling profiler around
// the trigger, then aggregates self-time by function and by module.
//
//   bun tools/profile-bulkload.mjs [--relay PORT] [--dir PATH] [--top N] [--out FILE.json]
//
// Needs Vite on :5173 and a relay on --relay (default 8099 — run a PRIVATE relay,
// the user's display on :8080 holds that relay's one display slot).

import { launchGpuBrowser, openApp, assertRealGpu } from './itest/driver.mjs';

function parseArgs(argv) {
  const a = { relayPort: 8099, dir: '', top: 30, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--relay') a.relayPort = Number(argv[++i]);
    else if (t === '--dir') a.dir = argv[++i];
    else if (t === '--top') a.top = Number(argv[++i]);
    else if (t === '--out') a.out = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
// Platform-resolved: headed wherever headless is software, so these numbers
// describe this machine rather than a CPU rasterizer.
const browser = await launchGpuBrowser({});
const app = await openApp(browser, { url: 'http://localhost:5173/', wait: 8000, relayPort: args.relayPort, session: 'off' });
const gpu = await assertRealGpu(app, { tool: 'profile-bulkload' });
console.log(`[gpu] ${gpu.vendor}/${gpu.architecture}`);

try {
  if (!app.booted) throw new Error('app did not boot');

  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); // 1ms

  // Clear content first so the run measures exactly cap files from zero.
  await app.page.evaluate(async () => {
    const c = window.__glyphClient;
    c.session._autosaveOn = false;
    await c.router.execute('scene.clear_grids');
    await new Promise((r) => setTimeout(r, 300));
  });

  await cdp.send('Profiler.start');
  const t0 = Date.now();
  const trigger = await app.page.evaluate(async ({ dir }) => {
    const c = window.__glyphClient;
    const t0 = performance.now();
    const r = await c.router.execute(['file.openDir', dir]);
    const tCmd = performance.now() - t0;
    // The blowup is deferred (next frames). A timer can only fire after the long
    // task ends, so awaiting it measures through the block; rAFs ensure renders ran.
    await new Promise((r2) => setTimeout(r2, 100));
    await new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2)));
    const tTotal = performance.now() - t0;
    return { text: r.text, cmdMs: Math.round(tCmd), totalMs: Math.round(tTotal) };
  }, { dir: args.dir });
  const wallMs = Date.now() - t0;
  const { profile } = await cdp.send('Profiler.stop');

  // Aggregate self time per node; profile.samples ~ 1 per interval.
  const sampleMs = 1; // matches setSamplingInterval
  const byFn = new Map();
  const byUrl = new Map();
  let totalSamples = 0;
  for (const node of profile.nodes) {
    const hits = node.hitCount || 0;
    if (!hits) continue;
    totalSamples += hits;
    const cf = node.callFrame;
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const fnKey = `${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`;
    byFn.set(fnKey, (byFn.get(fnKey) || 0) + hits);
    const urlKey = url || '(native/VM)';
    byUrl.set(urlKey, (byUrl.get(urlKey) || 0) + hits);
  }

  console.log(`\ntrigger: ${trigger.text}`);
  console.log(`command awaited: ${trigger.cmdMs}ms | through deferred block: ${trigger.totalMs}ms | wall: ${wallMs}ms`);
  console.log(`samples: ${totalSamples} (~${Math.round(totalSamples * sampleMs)}ms on-CPU)\n`);

  console.log(`── top ${args.top} functions by self time ──`);
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top)) {
    console.log(`${String(v * sampleMs).padStart(8)}ms  ${k}`);
  }
  console.log(`\n── modules by self time ──`);
  for (const [k, v] of [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${String(v * sampleMs).padStart(8)}ms  ${k}`);
  }

  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, JSON.stringify(profile));
    console.log(`\nraw profile: ${args.out}`);
  }
} finally {
  await browser.close();
}
