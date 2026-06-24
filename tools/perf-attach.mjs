// perf-attach.mjs — attach to a RUNNING browser over the raw page-level CDP socket and
// CPU-profile a hover window. Profiles YOUR live display (the exact lagging scene), not a
// headless repro. You hover the laggy grid during the window; it records the CPU profile +
// long tasks (the spikes) and reports where main-thread time goes.
//
// Uses the PAGE webSocketDebuggerUrl directly (like cdp-shot.mjs) — avoids Playwright
// connectOverCDP, which hangs on the browser-level endpoint with Vivaldi/Chromium.
//
// SETUP: launch a Chromium-family browser with the debug port + origin allowance, on the app:
//   vivaldi --remote-debugging-port=9222 '--remote-allow-origins=*' --user-data-dir=/tmp/viv-perf "http://localhost:5173/?relay=8080" &
//
// RUN (then hover the laggy grid for the whole window):
//   bun tools/perf-attach.mjs [--port 9222] [--match 5173] [--span MS] [--lead MS] [--top N] [--out FILE.json]

function parseArgs(argv) {
  const a = { port: '9222', match: '5173', span: 10000, lead: 3000, top: 35, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--port') a.port = String(argv[++i]);
    else if (t === '--match') a.match = argv[++i];
    else if (t === '--span') a.span = Number(argv[++i]);
    else if (t === '--lead') a.lead = Number(argv[++i]);
    else if (t === '--top') a.top = Number(argv[++i]);
    else if (t === '--out') a.out = argv[++i];
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- find the page target + open its raw CDP socket (cdp-shot pattern) ---
let targets;
try { targets = await (await fetch(`http://localhost:${args.port}/json`)).json(); }
catch (e) { console.error(`cannot reach http://localhost:${args.port}/json — is the browser up with --remote-debugging-port=${args.port}?\n  ${e.message}`); process.exit(2); }
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const target = pages.find((t) => (t.url || '').includes(args.match)) || pages[0];
if (!target) { console.error(`no page target matching "${args.match}" on :${args.port}`); process.exit(2); }
console.log(`attached → ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
  return r.result?.value;
};

try {
  // 1) Scene readiness + arm observers (long tasks = the spikes; distinct grids hovered = engagement).
  const ready = await evalJs(`(() => {
    const c = window.__glyphClient;
    window.__lt = []; window.__hovered = new Set();
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {}
    const am = c?.ctx?.attentionManager;
    const rd = am ? () => (am.get?.('hover') ?? am.hover ?? am.slots?.hover ?? null) : () => null;
    window.__hp = setInterval(() => { const h = rd(); if (h) window.__hovered.add(typeof h === 'object' ? (h.id ?? JSON.stringify(h)) : h); }, 16);
    const r = c?.ctx?.renderer || c?.ctx?.gl;
    const info = r?.info?.render;
    return { client: !!c, grids: (c?.ctx?.registry?.findByType?.('grid') || []).length, terminals: (c?.ctx?.registry?.findByType?.('terminal') || []).length, drawCalls: info?.drawCalls ?? info?.calls ?? null };
  })()`);
  if (!ready?.client) console.log('warning: window.__glyphClient not found — is this the glyph app tab?');
  else console.log(`scene: ${ready.grids} grids, ${ready.terminals} terminals · draw calls/frame: ${ready.drawCalls ?? 'n/a'}  (≪ grids ⇒ culling dropping off-screen grids)`);

  // 2) CPU profile: lead-in (you start hovering), then the steady window.
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 200 });   // 0.2ms
  if (args.lead > 0) await sleep(args.lead);
  await send('Profiler.start');
  await sleep(args.span);
  const { profile } = await send('Profiler.stop');
  const longtasks = await evalJs('(() => { clearInterval(window.__hp); return window.__lt || []; })()');
  const hovered = await evalJs('[...(window.__hovered || [])].length');

  // 3) Aggregate self time per function + per module.
  const sampleMs = 0.2;
  const byFn = new Map(), byUrl = new Map();
  let totalSamples = 0;
  for (const node of profile.nodes) {
    const hits = node.hitCount || 0;
    if (!hits) continue;
    totalSamples += hits;
    const cf = node.callFrame;
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = `${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) || 0) + hits);
    byUrl.set(url || '(native/VM)', (byUrl.get(url || '(native/VM)') || 0) + hits);
  }

  const lt = (longtasks || []).slice().sort((a, b) => b - a);
  console.log(`\nhover engagement: ${hovered} distinct grid(s) hovered`);
  console.log(`samples ${totalSamples} (~${Math.round(totalSamples * sampleMs)}ms on-CPU over ${Math.round(args.span / 1000)}s)`);
  console.log(`long tasks (>50ms): ${lt.length}${lt.length ? ` — worst ${lt[0]}ms, all: ${lt.join(', ')}ms` : ' — none'}`);

  console.log(`\n── top ${args.top} functions by self time ──`);
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top))
    console.log(`${String(Math.round(v * sampleMs)).padStart(7)}ms  ${k}`);
  console.log(`\n── modules by self time ──`);
  for (const [k, v] of [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18))
    console.log(`${String(Math.round(v * sampleMs)).padStart(7)}ms  ${k}`);

  if (args.out) { await Bun.write(args.out, JSON.stringify(profile)); console.log(`\nraw .cpuprofile: ${args.out}  (DevTools ▸ Performance ▸ Load profile)`); }
} finally {
  ws.close();
}
