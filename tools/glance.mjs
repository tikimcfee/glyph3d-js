#!/usr/bin/env bun
// glance — one-shot "let an agent SEE the live display". Dials the RUNNING relay,
// optionally issues bus verb(s), then captures the LIVE WebGPU canvas to a PNG.
//
//   bun tools/glance.mjs [--shot OUT.png]              capture the current scene
//   bun tools/glance.mjs --cmd 'dock.list' --shot x.png  issue a verb, then capture
//   bun tools/glance.mjs --cmd 'camera.frame all' --cmd 'attention.set primary none' --shot x.png
//
// Why this exists (vs tools/smoke.mjs): smoke launches its OWN headless browser via
// Playwright — a fresh, empty display. glance attaches to the EXISTING human display
// Ivan is watching, over the same relay WebSocket the CLI uses. It is ONE-SHOT
// (connect → command(s) → capture → write → exit) because the Claude Code harness
// reaps backgrounded children when a turn ends — there is no long-lived driver to die.
//
// The capture itself is bus-native: it sends the `screenshot` verb (registered in
// app/commands/handlers/systemCommands.js), which forces a render and reads the canvas
// back via toDataURL() in the same synchronous turn — so the WebGPU backbuffer still
// holds pixels (no preserveDrawingBuffer needed; readback is Y=0-top, no flip).
//
// FLAGS
//   --port N        relay port (default 8080)
//   --shot PATH     output PNG (default /tmp/glance.png)
//   --cmd 'verb …'  bus verb to issue before capture (repeatable, runs in order)
//   --wait MS       settle delay after the last --cmd before capture (default 300)
//   --json          print the screenshot reply metadata as JSON to stdout

const VALUE_FLAGS = new Set(['port', 'shot', 'wait']);
const BOOL_FLAGS = new Set(['json', 'help']);

const flags = { cmds: [] };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (a === '--cmd') {
      const v = argv[++i];
      if (v === undefined) die('--cmd needs a verb string');
      flags.cmds.push(v);
      continue;
    }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
      if (VALUE_FLAGS.has(name)) {
        const v = argv[++i];
        if (v === undefined) die(`--${name} needs a value`);
        flags[name] = v;
        continue;
      }
      die(`unknown flag --${name} (see --help)`);
    }
    die(`unexpected argument "${a}" (did you mean --cmd '${a}'?)`);
  }
}

if (flags.help) { help(); process.exit(0); }

const PORT = Number(flags.port ?? 8080);
const OUT = flags.shot ?? '/tmp/glance.png';
const WAIT = Number(flags.wait ?? 300);

function die(msg) { console.error(`[glance] ${msg}`); process.exit(2); }

function help() {
  console.log(`glance — one-shot screenshot of the LIVE glyph3d display (attaches, never launches)

USAGE
  bun tools/glance.mjs [--shot OUT.png]                 capture the current scene
  bun tools/glance.mjs --cmd 'verb …' [--cmd …] --shot OUT.png   issue verb(s), then capture

FLAGS
  --port N        relay port (default 8080)
  --shot PATH     output PNG (default /tmp/glance.png)
  --cmd 'verb …'  bus verb before capture (repeatable, in order)
  --wait MS       settle delay after the last --cmd (default 300)
  --json          print screenshot reply metadata as JSON

Unlike tools/smoke.mjs (own headless browser), glance talks to the EXISTING display
over the relay WS — the same window a human is watching.`);
}

// ---------------------------------------------------------------------------
// relay connection — handshake: send "ping" → "OK: connected as ctrl-N" → "pong"
// (identical to tools/buslog.mjs; the relay is the one shared seam).

function dial(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const inbox = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const raw = String(e.data);
      const w = waiters.shift();
      if (w) { clearTimeout(w.timer); w.resolve(raw); } else inbox.push(raw);
    };
    const take = (timeoutMs = 15000) => new Promise((res, rej) => {
      if (inbox.length) return res(inbox.shift());
      const entry = {
        resolve: res,
        timer: setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error(`no reply from relay within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiters.push(entry);
    });
    ws.onerror = () => reject(new Error(`cannot reach relay on :${port} — is the dev loop / binary up?`));
    ws.onopen = async () => {
      try {
        ws.send('ping');
        const hello = await take(5000); // 'OK: connected as ctrl-N'
        if (!hello.startsWith('OK:')) throw new Error(`unexpected hello: ${hello}`);
        await take(5000); // 'pong'
        resolve({ ws, take, hello, send: (s) => ws.send(s) });
      } catch (e) { reject(e); }
    };
  });
}

/** Parse a controller reply: JSON {response,data} or plain text. */
function parseReply(raw) {
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object' && ('response' in m || 'data' in m)) {
      return { text: m.response ?? null, data: m.data ?? null };
    }
  } catch { /* plain text */ }
  return { text: raw, data: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

const c = await dial(PORT).catch((e) => die(e.message));
console.error(`[glance] ${c.hello} — driving ws://localhost:${PORT}`);

// 1. issue the pre-capture verbs, in order, on the one connection.
for (const cmd of flags.cmds) {
  c.send(cmd);
  const reply = parseReply(await c.take().catch((e) => die(e.message)));
  const t = typeof reply.text === 'string' ? reply.text : JSON.stringify(reply.text);
  console.error(`[glance] cmd: ${cmd} → ${t ?? 'ok'}`);
  if (typeof t === 'string' && t.startsWith('ERR')) { c.ws.close(); die(`command failed: ${t}`); }
}
if (flags.cmds.length && WAIT > 0) await sleep(WAIT); // let async work (fly/open/relayout) settle

// 2. capture — the bus-native screenshot verb reads the live canvas back as base64 PNG.
c.send('screenshot');
const shot = parseReply(await c.take(20000).catch((e) => die(e.message)));
c.ws.close();

if (typeof shot.text === 'string' && shot.text.startsWith('ERR')) die(`screenshot failed: ${shot.text}`);
const img = shot.data?.image;
if (!img) die(`screenshot returned no image data (reply: ${shot.text})`);

const bytes = Buffer.from(img, 'base64');
await Bun.write(OUT, bytes);

const { width, height } = shot.data;
// Sanity: a truly blank canvas PNG-compresses to a few KB; flag suspiciously tiny output.
const tiny = bytes.length < 16 * 1024;
console.error(`[glance] wrote ${OUT} — ${width}x${height}, ${bytes.length} bytes${tiny ? '  ⚠ suspiciously small (canvas may be blank)' : ''}`);
if (flags.json) console.log(JSON.stringify({ out: OUT, width, height, bytes: bytes.length }));
process.exit(tiny ? 1 : 0);
