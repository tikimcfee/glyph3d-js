// driver.mjs — shared browser-driving primitives for the integration harness and the
// smoke check. Launch a real WebGPU browser, open the app with full error capture, and
// drive it through the command bus (window.__glyphClient.router) — the same verbs the
// UI and CLI use. Used by tools/smoke.mjs (ad-hoc) and tools/itest.mjs (test runner),
// so there's one source of truth for launch + capture.

import { chromium } from 'playwright';

const isGpuNoise = (s) =>
  /webgpu|gpuadapter|gpudevice|requestadapter|gpu process|fallback to|swiftshader/i.test(s);

// Flags proven to render WebGPU headed on a GPU box (see tools/capture.mjs).
export async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  });
}

// Open the app in a fresh page, wire error capture BEFORE navigating, wait for boot
// (window.__glyphClient) + a settle, and return a driver. `errors` are real JS errors
// (failure-worthy); GPU-init noise and 4xx/5xx resources are bucketed separately so
// headless runs stay useful.
export async function openApp(browser, {
  url = 'http://localhost:5173/', wait = 5000, bootTimeout = 20000,
  viewport = { width: 1280, height: 800 },
} = {}) {
  const errors = [], gpuErrors = [], failedResources = [], warnings = [];
  const page = await browser.newPage({ viewport });

  page.on('pageerror', (err) => {
    const rec = { kind: 'uncaught', text: err.message };
    (isGpuNoise(rec.text) ? gpuErrors : errors).push(rec);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Failed to load resource')) return; // captured with URL below
    if (msg.type() === 'error') (isGpuNoise(text) ? gpuErrors : errors).push({ kind: 'console', text });
    else if (msg.type() === 'warning' || text.includes('[tree-sitter]')) warnings.push(text);
  });
  page.on('response', (r) => { if (r.status() >= 400) failedResources.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => failedResources.push(`ERR ${r.url()} (${r.failure()?.errorText || 'failed'})`));

  let booted = false;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  try { await page.waitForFunction(() => !!window.__glyphClient, { timeout: bootTimeout }); booted = true; } catch { /* caller checks .booted */ }
  await page.waitForTimeout(wait); // atlas gen + async content + first frames

  return {
    page,
    get booted() { return booted; },
    errors, gpuErrors, failedResources, warnings,
    // Run a command-bus verb (string or 'verb arg arg'); returns { text } or { error }.
    async cmd(verb) {
      const parts = String(verb).split(/\s+/);
      return page.evaluate(async (p) => {
        try { const r = await window.__glyphClient?.router?.execute(p.length > 1 ? p : p[0]); return { text: r?.text ?? null }; }
        catch (e) { return { error: e?.message || String(e) }; }
      }, parts);
    },
    evalPage: (expr, arg) => page.evaluate(expr, arg),
    waitFor: (ms) => page.waitForTimeout(ms),
    shot: async (path) => { await page.screenshot({ path }); return path; },
    close: () => page.close(),
  };
}

// Tiny throwing assert — fail fast; the runner catches and reports the message.
export function makeAssert() {
  return {
    ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); },
    equal(got, want, msg) { if (got !== want) throw new Error(`${msg || 'equal'} — got ${got}, want ${want}`); },
    atLeast(n, min, msg) { if (!(n >= min)) throw new Error(`${msg || 'atLeast'} — ${n} < ${min}`); },
    // No unexpected JS/console errors occurred during the test.
    noErrors(app) {
      if (app.errors.length) {
        throw new Error(`${app.errors.length} JS/console error(s): ` +
          app.errors.map((e) => e.text).slice(0, 3).join(' | '));
      }
    },
  };
}
