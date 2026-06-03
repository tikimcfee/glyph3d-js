// cdp-shot.mjs — grab a PNG from a running Chromium-family browser via the
// remote-debugging protocol (CDP). Captures the actual rendered page (WebGPU
// included) regardless of window focus, so it works headed on a busy desktop.
//
// Run with bun (the repo's runtime):
//   bun tools/cdp-shot.mjs <out.png> [port=9222] [urlSubstringMatch]
//
// Pairs with tools/web-preview.sh, which launches the browser with
// --remote-debugging-port. See tools/PREVIEW.md for the full loop.

const out = process.argv[2] || 'shot.png';
const port = process.argv[3] || '9222';
const match = process.argv[4] || '';

const targets = await (await fetch(`http://localhost:${port}/json`)).json();
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const target = (match ? pages.find((t) => (t.url || '').includes(match)) : null) || pages[0];
if (!target) { console.error('cdp-shot: no page target on :' + port); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

await send('Page.enable');
const { data } = await send('Page.captureScreenshot', { format: 'png' });
await Bun.write(out, Buffer.from(data, 'base64'));
console.log(`cdp-shot: wrote ${out}  (from ${target.url})`);
ws.close();
