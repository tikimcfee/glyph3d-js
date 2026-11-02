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
//
// Console errors and uncaught exceptions go to --log as they happen (one line each), so a
// headless run is never silent about a crash.
//
// It heals itself: a Vite restart (HMR "Failed to reload", "server connection lost") or a page
// that stops answering (no window.__glyphClient) gets one reload a few seconds later, and
// SIGUSR1 reloads on demand (`pkill -USR1 -f '^bun tools/agent-display.mjs'` — anchored, so it never
// signals the shell that launched it). Launch it with `exec` so no wrapper shell sits in between:
//   tmux new-session -d -s planes-display 'exec bun tools/agent-display.mjs'

import { appendFileSync, mkdirSync } from 'node:fs';
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

const quit = async (sig) => { log(`[stop] ${sig}`); await browser.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', () => quit('SIGINT'));
process.on('SIGTERM', () => quit('SIGTERM'));
await new Promise(() => {});   // stay up until signalled
