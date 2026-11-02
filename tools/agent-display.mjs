#!/usr/bin/env bun
// agent-display.mjs — a long-lived display for agents to drive and see while no person has
// the app open. It launches headless Chromium on the REAL GPU (tools/itest/driver.mjs owns the
// flags and the software-adapter guard), opens the app as the relay's DISPLAY, and stays up, so
// `./glyph3d-cli screenshot …` and every one-shot verb have a page to reach.
//
// The relay takes ONE display: while this runs, a browser a person opens is refused
// ("display already connected"). Stop this first (Ctrl-C in its tmux session, or SIGTERM).
//
// Usage (run it in its own detached tmux session, never in an agent's shell):
//   bun tools/agent-display.mjs [--url http://localhost:5173/] [--relay 8080]
//                               [--size 1600x1000] [--dpr 1] [--log /tmp/glyph3d/agent-display.log]
//                               [--heap-dir /tmp/glyph3d] [--heap-sample 65536]
//
// Console errors and uncaught exceptions go to --log as they happen (one line each), so a
// headless run is never silent about a crash.
//
// It heals itself: a Vite restart (HMR "Failed to reload", "server connection lost") or a page
// that stops answering (no window.__glyphClient) gets one reload a few seconds later, and
// SIGUSR1 reloads on demand (`pkill -USR1 -f '^bun tools/agent-display.mjs'` — anchored, so it never
// signals the shell that launched it).
//
// MEMORY: a sampling heap profiler runs from every page load (CDP HeapProfiler, one sample per
// --heap-sample bytes allocated, default 64 KiB). SIGUSR2 writes what is RETAINED now — the exact
// JS heap (Runtime.getHeapUsage) and the live sampled bytes by allocation site, largest first — to
// <--heap-dir>/agent-display-heap-<time>.txt (and .json, the raw profile): which code holds the
// heap. Sampling costs little; it only sees allocations since the last load.
// Launch it with `exec` so no wrapper shell sits in between:
//   tmux new-session -d -s planes-display 'exec bun tools/agent-display.mjs'

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { webgpuArgs, adapterInfo } from './itest/driver.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const url = opt('url', 'http://localhost:5173/');
const relay = opt('relay', '8080');
const [w, h] = opt('size', '1600x1000').split('x').map(Number);
const dpr = Number(opt('dpr', '1'));
const logPath = opt('log', '/tmp/glyph3d/agent-display.log');
const heapDir = opt('heap-dir', '/tmp/glyph3d');
const heapSample = Number(opt('heap-sample', '65536'));
if (!(heapSample > 0)) throw new Error(`agent-display: bad --heap-sample (${heapSample})`);
if (!(w > 0 && h > 0 && dpr > 0)) throw new Error(`agent-display: bad --size/--dpr (${w}x${h} @${dpr})`);

mkdirSync(dirname(logPath), { recursive: true });
const log = (line) => {
  const s = `${new Date().toISOString()} ${line}`;
  appendFileSync(logPath, s + '\n');
  console.log(s);
};

const browser = await chromium.launch({ headless: true, args: webgpuArgs() });
const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on('pageerror', (e) => log(`[uncaught] ${e.message}`));
let reloadTimer = null;
const reloadSoon = (why, ms = 3000) => {
  if (reloadTimer) return;
  log(`[heal] reload in ${ms} ms — ${why}`);
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try { await page.reload({ waitUntil: 'load', timeout: 30000 }); log('[heal] reloaded'); }
    catch (e) { log(`[heal] reload failed: ${e.message}`); reloadSoon('the last reload failed', 5000); }
  }, ms);
};
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') log(`[console.error] ${t}`);
  if (/\[hmr\] Failed to reload|server connection lost/i.test(t)) reloadSoon(t.slice(0, 80));
});
page.on('crash', () => log('[crash] the page crashed'));
page.on('close', () => { log('[close] the page closed — exiting'); process.exit(1); });

const target = new URL(url);
if (relay && !target.searchParams.has('relay')) target.searchParams.set('relay', relay);
await page.goto(target.toString(), { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => !!window.__glyphClient, { timeout: 30000 });
const gpu = await adapterInfo({ evalPage: (fn) => page.evaluate(fn) });
log(`[up] ${target} ${w}x${h} @${dpr}x — adapter ${gpu.vendor}/${gpu.architecture}${gpu.software ? ' (SOFTWARE — pixels are not this machine\'s)' : ''}`);

setInterval(async () => {
  const alive = await page.evaluate(() => !!window.__glyphClient).catch(() => false);
  if (!alive) reloadSoon('the app is not booted', 1000);
}, 15000);
process.on('SIGUSR1', () => reloadSoon('SIGUSR1', 0));

// ── memory: a sampling heap profile from every load; SIGUSR2 dumps what's retained ──
const cdp = await context.newCDPSession(page);
const startSampling = async () => {
  try { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.startSampling', { samplingInterval: heapSample }); }
  catch (e) { log(`[heap] sampling did not start: ${e.message}`); }
};
await startSampling();
page.on('load', () => { startSampling(); });

/** The live sampled bytes by allocation site (function · url:line), largest first. */
function heapSites(profile) {
  const sites = new Map();
  const walk = (node) => {
    const f = node.callFrame || {};
    const where = `${f.functionName || '(anonymous)'} · ${String(f.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')}:${(f.lineNumber ?? -1) + 1}`;
    if (node.selfSize > 0) sites.set(where, (sites.get(where) || 0) + node.selfSize);
    for (const c of node.children || []) walk(c);
  };
  walk(profile.head);
  return [...sites].sort((a, b) => b[1] - a[1]);
}
process.on('SIGUSR2', async () => {
  try {
    const usage = await cdp.send('Runtime.getHeapUsage');
    const { profile } = await cdp.send('HeapProfiler.getSamplingProfile');
    const sites = heapSites(profile);
    const sampled = sites.reduce((n, [, b]) => n + b, 0);
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(heapDir, { recursive: true });
    const base = `${heapDir}/agent-display-heap-${stamp}`;
    writeFileSync(`${base}.json`, JSON.stringify(profile));
    const lines = [`JS heap used ${mb(usage.usedSize)} of ${mb(usage.totalSize)}; live sampled since the last load ${mb(sampled)} (one sample per ${heapSample} B)`,
      ...sites.slice(0, 60).map(([w, b]) => `${mb(b).padStart(10)}  ${w}`)];
    writeFileSync(`${base}.txt`, lines.join('\n') + '\n');
    log(`[heap] ${lines[0]} → ${base}.txt`);
  } catch (e) { log(`[heap] dump failed: ${e.message}`); }
});

const quit = async (sig) => { log(`[stop] ${sig}`); await browser.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', () => quit('SIGINT'));
process.on('SIGTERM', () => quit('SIGTERM'));
await new Promise(() => {});   // stay up until signalled
