// loadcurve.mjs — watch a bulk file.openDir at scale: heap / grid count / FPS /
// crash detection, sampled live. The companion to profile-bulkload.mjs (which
// answers "where does CPU time go"); this answers "does it survive, and what's
// resident afterward". Built on the sentry 18k-file stress case.
//
//   bun tools/loadcurve.mjs --dir static/app/views [--relay 8099] [--url http://localhost:8099/]
//
// MEASUREMENT HYGIENE (learned the hard way):
//   - Point --url at a relay serving the BUILT app (`serve --local --port 8099 <project>`),
//     not Vite. A Vite restart mid-run reloads the page and poisons the run, and
//     dev-mode retains ~17x more JS heap (module graph + sourcemaps) than the build.
//   - A gap in the sample stream = the main thread was blocked solid for that span.
import { launchGpuBrowser, openApp, assertRealGpu } from './itest/driver.mjs';

const argv = process.argv.slice(2);
const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const dir = get('--dir', '');
const relayPort = Number(get('--relay', 8099));
const url = get('--url', 'http://localhost:8099/');

// Platform-resolved: headed wherever headless is software, so these numbers
// describe this machine rather than a CPU rasterizer.
const browser = await launchGpuBrowser({});
const app = await openApp(browser, { url, relayPort, wait: 8000, session: 'off' });
const gpu = await assertRealGpu(app, { tool: 'loadcurve' });
console.log(`[gpu] ${gpu.vendor}/${gpu.architecture}`);
if (!app.booted) { console.error('app did not boot'); process.exit(1); }

let crashed = false;
app.page.on('crash', () => { crashed = true; console.log('\n!! PAGE CRASHED (renderer process died)'); });

// Kick the load WITHOUT awaiting page.evaluate inline — the context may die mid-flight.
const t0 = Date.now();
const loadDone = app.page.evaluate(async (d) => {
  const c = window.__glyphClient;
  c.session._autosaveOn = false;
  await c.router.execute('scene.clear_grids');
  const r = await c.router.execute(['file.openDir', d]);
  return r.text;
}, dir).catch((e) => `EVAL-DIED: ${e.message.split('\n')[0]}`);

const samples = [];
const sampler = setInterval(async () => {
  try {
    const s = await app.page.evaluate(() => ({
      heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
      heapLimitMB: Math.round((performance.memory?.jsHeapSizeLimit || 0) / 1048576),
      grids: window.__glyphClient?.registry?.count?.() ?? window.__glyphClient?.registry?.size ?? -1,
    }));
    samples.push({ t: Date.now() - t0, ...s });
    process.stdout.write(`\r  t=${(samples.at(-1).t / 1000).toFixed(1)}s heap=${s.heapMB}MB/${s.heapLimitMB}MB grids=${s.grids}   `);
  } catch { /* context gone; crash handler reports */ }
}, 500);

const result = await Promise.race([
  loadDone,
  new Promise((r) => setTimeout(() => r('TIMEOUT 300s'), 300_000)),
]);
const tLoad = (Date.now() - t0) / 1000;

// Post-load watch: the first frames with N grids resident are their own stress
// phase (pipeline compile, virtualizer adds, GPU uploads). Watch 12s for crash + FPS.
console.log(`\n\nload result: ${result} (${tLoad.toFixed(1)}s) — watching post-load frames…`);
let fps = -1;
for (let i = 0; i < 12 && !crashed; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    fps = await app.page.evaluate(() => new Promise((res) => {
      let n = 0; const start = performance.now();
      const tick = () => { n++; if (performance.now() - start < 500) requestAnimationFrame(tick); else res(n * 2); };
      requestAnimationFrame(tick);
    }));
  } catch { fps = -1; }
}
clearInterval(sampler);

console.log(`post-load: crashed=${crashed} approxFPS=${fps}`);
console.log(`wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('last samples:');
for (const s of samples.slice(-8)) console.log(`  t=${(s.t / 1000).toFixed(1)}s heap=${s.heapMB}MB grids=${s.grids}`);
const errs = [...app.errors, ...app.gpuErrors].slice(-6);
if (errs.length) { console.log('errors:'); for (const e of errs) console.log(`  [${e.kind}] ${e.text.slice(0, 200)}`); }
await browser.close();
process.exit(crashed ? 1 : 0);
