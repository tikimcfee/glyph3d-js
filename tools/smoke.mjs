// smoke.mjs — boot the app in a real (WebGPU) browser, drive it, report errors.
//
// The repeatable "does the UI actually boot and run" loop. It loads the page and
// captures every console error + uncaught exception (the app's [error-tracker]
// forwards to console, so those land here too), optionally runs command-bus verbs
// via window.__glyphClient.router, optionally screenshots, and exits non-zero if
// anything real errored. This is what catches render-crash bugs — e.g. an undefined
// variable in a component — before they reach the browser by hand.
//
//   bun tools/smoke.mjs [--url URL] [--shot OUT.png] [--headed] [--wait MS] [--cmd 'verb arg']...
//
//   bun tools/smoke.mjs                                          # boot :5173, report errors
//   bun tools/smoke.mjs --headed --shot /tmp/app.png            # real GPU render + screenshot
//   bun tools/smoke.mjs --cmd 'repo.load tikimcfee/glyph3d-js' --cmd 'file.open README.md' --shot /tmp/r.png
//   bun tools/smoke.mjs --url 'http://localhost:5173/?relay=8080'
//
// Needs the dev loop up (tools/dev.sh). WebGPU renders reliably HEADED on a GPU box
// (use --headed when you want the screenshot to show real pixels); headless still
// captures all JS/console errors — GPU-init errors are reported but not counted as
// failures, so headless stays useful for catching the render-crash class.

import { chromium } from 'playwright';

function parseArgs(argv) {
  const a = { url: 'http://localhost:5173/', shot: null, headed: false, wait: 4000, bootTimeout: 20000, cmds: [], eval: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--url') a.url = argv[++i];
    else if (t === '--shot') a.shot = argv[++i];
    else if (t === '--headed') a.headed = true;
    else if (t === '--wait') a.wait = Number(argv[++i]);
    else if (t === '--cmd') a.cmds.push(argv[++i]);
    else if (t === '--eval') a.eval = argv[++i];
  }
  return a;
}

const isGpuNoise = (s) => /webgpu|gpuadapter|gpudevice|requestadapter|gpu process|fallback to|swiftshader/i.test(s);

const args = parseArgs(process.argv.slice(2));
const errors = [];        // real JS errors — failure-worthy
const gpuErrors = [];     // GPU-availability noise (headless) — reported, not fatal
const failedResources = []; // 4xx/5xx/failed requests — reported with URL, not fatal (favicon etc.)
const warnings = [];

const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--use-gl=angle'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('pageerror', (err) => {
  const rec = { kind: 'uncaught', text: err.message, stack: (err.stack || '').split('\n').slice(0, 3).join(' | ') };
  (isGpuNoise(rec.text) ? gpuErrors : errors).push(rec);
});
page.on('console', (msg) => {
  const type = msg.type();
  const text = msg.text();
  // Resource-load failures get their URL from the response/requestfailed listeners
  // below; don't double-count the generic console line as a fatal JS error.
  if (text.includes('Failed to load resource')) return;
  if (type === 'error') (isGpuNoise(text) ? gpuErrors : errors).push({ kind: 'console', text });
  else if (type === 'warning' || text.includes('[tree-sitter]')) warnings.push(text);
});
page.on('response', (resp) => { const s = resp.status(); if (s >= 400) failedResources.push(`${s} ${resp.url()}`); });
page.on('requestfailed', (req) => { failedResources.push(`ERR ${req.url()} (${req.failure()?.errorText || 'failed'})`); });

let booted = false;
try {
  await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
  try {
    await page.waitForFunction(() => !!window.__glyphClient, { timeout: args.bootTimeout });
    booted = true;
  } catch { /* reported below as "booted: NO" */ }
  await page.waitForTimeout(args.wait); // atlas gen + async content + first frames

  for (const cmd of args.cmds) {
    const parts = cmd.split(/\s+/);
    const res = await page.evaluate(async (p) => {
      try {
        const r = await window.__glyphClient?.router?.execute(p.length > 1 ? p : p[0]);
        return { text: r?.text ?? null };
      } catch (e) { return { error: e?.message || String(e) }; }
    }, parts);
    console.log(`cmd: ${cmd} → ${res?.error ? 'ERROR ' + res.error : (res?.text ?? 'ok')}`);
    await page.waitForTimeout(3000); // repo fetch / file open / lazy grammar load + colorize are async
  }
  if (args.cmds.length) await page.waitForTimeout(2500); // final colorize settle

  if (args.eval) {
    const r = await page.evaluate(args.eval).catch((e) => ({ evalError: e?.message || String(e) }));
    console.log('eval:', JSON.stringify(r, null, 2));
  }
  if (args.shot) { await page.screenshot({ path: args.shot }); console.log(`shot: ${args.shot}`); }
} catch (e) {
  errors.push({ kind: 'harness', text: e?.message || String(e) });
} finally {
  await browser.close();
}

console.log(`\n── smoke report ──`);
console.log(`url:    ${args.url}   (${args.headed ? 'headed' : 'headless'})`);
console.log(`booted: ${booted ? 'yes (window.__glyphClient present)' : 'NO — app did not initialize'}`);
console.log(`errors: ${errors.length} | failed-resources: ${failedResources.length} | gpu-noise: ${gpuErrors.length} | warnings: ${warnings.length}`);
for (const e of errors)     console.log(`  ✗ [${e.kind}] ${e.text}${e.stack ? '\n       ' + e.stack : ''}`);
for (const r of [...new Set(failedResources)].slice(0, 12)) console.log(`  ↯ ${r}`);
for (const w of warnings.slice(0, 12)) console.log(`  ⚠ ${w}`);
if (gpuErrors.length) console.log(`  (gpu-noise, non-fatal: ${gpuErrors[0].text.slice(0, 80)}…)`);

const ok = booted && errors.length === 0;
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
