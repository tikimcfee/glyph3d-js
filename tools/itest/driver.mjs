// driver.mjs — shared browser-driving primitives for the integration harness and the
// smoke check. Launch a real WebGPU browser, open the app with full error capture, and
// drive it through the command bus (window.__glyphClient.router) — the same verbs the
// UI and CLI use. Used by tools/smoke.mjs (ad-hoc) and tools/itest.mjs (test runner),
// so there's one source of truth for launch + capture.

import { chromium } from 'playwright';

const isGpuNoise = (s) =>
  /webgpu|gpuadapter|gpudevice|requestadapter|gpu process|fallback to|swiftshader/i.test(s);

// WebGPU on the REAL GPU — the ONE home for the launch flags (every self-launching
// tool imports webgpuArgs; per-tool copies drifted and were Linux-only).
//
// Linux: the two ANGLE flags are load-bearing for HEADLESS — without them, headless
// Chromium has no display/Vulkan surface and silently falls back to the SwiftShader
// SOFTWARE adapter (google/swiftshader). The minimal page survives that, but the full
// GlyphField workload (compute + big int textures + Slug coverage) overwhelms it and
// the device is dropped mid-run ("Instance dropped in popErrorScope"). With
// --use-angle=vulkan + --use-gl=angle, headless gets the actual GPU (nvidia/...),
// matching headed — verified via the wgpu adapter probe. Harmless headed (already on-GPU).
//
// macOS: ANGLE's default backend IS Metal — forcing --use-angle=vulkan there would do
// the opposite of its Linux job (no Vulkan surface → software fallback), so darwin
// gets only the enable + blocklist flags and rides Metal.
export function webgpuArgs() {
  const base = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  if (process.platform === 'darwin') return base;
  return [...base, '--enable-features=Vulkan', '--use-angle=vulkan', '--use-gl=angle'];
}

export async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({ headless: !headed, args: webgpuArgs() });
}

// ── GPU truth ────────────────────────────────────────────────────────────────
// webgpuArgs answers "which flags"; these answer the two questions that flags
// alone can't, and that a measurement tool must not get wrong:
//   1. can HEADLESS reach the real GPU on this platform at all?
//   2. what adapter actually answered — and is it software?
//
// (2) is the one that matters. A tool that reports numbers from SwiftShader has
// not measured this machine; it has measured a CPU rasterizer that happens to
// speak WebGPU. That failure is silent by construction — the page boots, the
// scene renders, every probe reads healthy — so the guard belongs in the shared
// driver where no tool can forget it, not in each tool's own preflight.

/**
 * Can headless Chromium reach the real GPU here?
 *
 * Linux: yes — the ANGLE/Vulkan flags in webgpuArgs give headless a real
 * adapter (that is precisely their job).
 * macOS: NO. The headless shell has no Metal surface and there is no flag
 * equivalent to the Linux fix; ANGLE falls to `--use-angle=swiftshader-webgl`.
 * Measured on an M-series box: headless = google/swiftshader at ~1 rAF/s,
 * headed = apple/metal-3 at 61 — the same build, minutes apart.
 *
 * @returns {boolean}
 */
export function headlessHasGpu() {
  return process.platform !== 'darwin';
}

/** Adapter identifiers that mean "CPU pretending to be a GPU". */
const SOFTWARE_ADAPTER = /swiftshader|lavapipe|llvmpipe|softpipe|software|basic render|microsoft basic|\bwarp\b/i;

/**
 * Read the WebGPU adapter the page actually got.
 * @param {{evalPage: Function}} app - an openApp driver
 * @returns {Promise<{vendor: string, architecture: string, device: string, description: string, software: boolean}>}
 */
export async function adapterInfo(app) {
  const info = await app.evalPage(async () => {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return null;
    const i = a.info || {};
    return {
      vendor: i.vendor || '', architecture: i.architecture || '',
      device: i.device || '', description: i.description || '',
    };
  });
  if (!info) return { vendor: '', architecture: '', device: '', description: '', software: true };
  const joined = `${info.vendor} ${info.architecture} ${info.device} ${info.description}`;
  return { ...info, software: SOFTWARE_ADAPTER.test(joined) };
}

/**
 * Refuse to report measurements taken on a software adapter.
 *
 * Call this after openApp in any tool whose OUTPUT IS A NUMBER. Correctness
 * gates (does it boot, does the kernel match its oracle) are welcome to run on
 * SwiftShader — they assert behavior, not speed. Set GLYPH_ALLOW_SOFTWARE=1 to
 * override deliberately (a CI box with no GPU, checking that a tool still runs).
 *
 * @param {{evalPage: Function}} app
 * @param {{tool?: string}} opts
 * @returns {Promise<object>} the adapter info, so callers can print it
 */
export async function assertRealGpu(app, { tool = 'this tool' } = {}) {
  const info = await adapterInfo(app);
  if (!info.software) return info;

  const id = `${info.vendor || '?'}/${info.architecture || '?'}`;
  if (process.env.GLYPH_ALLOW_SOFTWARE === '1') {
    console.warn(`[gpu] WARNING: software adapter (${id}) — numbers are NOT this machine's. Allowed by GLYPH_ALLOW_SOFTWARE=1.`);
    return info;
  }
  const fix = headlessHasGpu()
    ? 'Headless should reach the GPU on this platform — check that webgpuArgs() flags survived, and that a real GPU/driver is present.'
    : `Headless cannot reach the GPU on ${process.platform}. Re-run headed (--headed), which measurement tools now default to here.`;
  throw new Error(
    `${tool}: refusing to report numbers from a SOFTWARE adapter (${id}).\n` +
    `  ${fix}\n` +
    '  Override deliberately with GLYPH_ALLOW_SOFTWARE=1.',
  );
}

/**
 * Launch a browser for MEASUREMENT: headed wherever headless would be software.
 *
 * `headed: null` (the default) means "decide by platform" — headless on Linux,
 * headed on macOS — so a tool that just wants valid numbers gets them without
 * every author remembering the platform rule. Pass an explicit boolean to force
 * one; the assertRealGpu guard still has the final word on whether the run's
 * output is trustworthy.
 *
 * @param {{headed?: boolean|null, extraArgs?: string[]}} opts
 */
export async function launchGpuBrowser({ headed = null, extraArgs = [] } = {}) {
  const useHeaded = headed === null ? !headlessHasGpu() : headed;
  if (headed === null && useHeaded) {
    console.error(`[gpu] ${process.platform}: headless is software here — launching headed so the numbers are real.`);
  }
  return chromium.launch({ headless: !useHeaded, args: [...webgpuArgs(), ...extraArgs] });
}

// Open the app in a fresh page, wire error capture BEFORE navigating, wait for boot
// (window.__glyphClient) + a settle, and return a driver. `errors` are real JS errors
// (failure-worthy); GPU-init noise and 4xx/5xx resources are bucketed separately so
// headless runs stay useful.
export async function openApp(browser, {
  url = 'http://localhost:5173/', relayPort = null, wait = 5000, bootTimeout = 20000,
  session = null,
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
  // Optional: inject the relay port through the app's OWN config path (resolveRelay honors
  // ?relay) to dial a real relay — by construction, not a hack. DEFAULT null = no relay dial:
  // tests drive via the command bus and don't need it, and connecting swaps the file provider
  // + races GitHub repo.load (nondeterministic). Opt in (relayPort: 8080) only when a test
  // actually exercises the relay's local project.
  // Compose query params on the real URL rather than string-appending — the old
  // `?relay=` concat silently dropped the param whenever the url already had a
  // query, which is exactly when a second one is being added.
  const target = (() => {
    const u = new URL(url);
    if (relayPort && !u.searchParams.has('relay')) u.searchParams.set('relay', String(relayPort));
    // session=off → ephemeral page: no restore, no autosave (see SessionStore).
    if (session) u.searchParams.set('session', session);
    return u.toString();
  })();
  await page.goto(target, { waitUntil: 'load', timeout: 30000 });
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
    // Structured errors from the app's own ErrorTracker (window.__errorTracker) — the
    // authoritative signal, since the tracker preventDefault()s the error event so
    // Playwright's pageerror never fires for uncaught exceptions.
    async trackedErrors() {
      const list = await page.evaluate(async () => {
        const norm = (e) => ({ message: e.message, name: e.name, type: e.context?.type,
          stack: e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : null });
        // Prefer the command bus (error.list) — the bus-native source of truth; fall back to
        // the raw tracker global if the verb isn't wired (older build).
        try {
          const r = await window.__glyphClient?.router?.execute?.('error.list 50');
          if (Array.isArray(r?.data?.errors)) return r.data.errors.map(norm);
        } catch { /* fall through */ }
        return (window.__errorTracker?.getErrors?.(50) || []).map(norm);
      }).catch(() => []);
      return list.filter((e) => !isGpuNoise(e.message || ''));
    },
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
