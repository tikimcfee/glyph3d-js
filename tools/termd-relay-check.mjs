/**
 * termd-relay-check.mjs — the relay and g3d-termd end to end, with a simulated display (no browser).
 *
 *   bun tools/termd-relay-check.mjs [--relay PORT]
 *
 * Starts its own relay (`serve --relay-only --termd-ns tr`, in a scratch G3D_TERMD_DIR —
 * tools/lib/termd.mjs) on PORT, plays the display (DISPLAY handshake, answers terminal.create and
 * terminal.ping, decodes the 0x01 OUTPUT frames), and checks:
 *   - spawn: the relay starts termd, an adapter creates and owns the terminal, typing echoes back;
 *   - flood: `seq 1 300000` through termd → adapter → relay → display arrives whole, in order;
 *   - relay restart: the terminal survives, terminal.recover re-adopts it, the adoption repaint
 *     carries the old screen, typing works again, the next spawn mints a fresh id; stopping the
 *     relay logs no termd loss, and the re-adopting adapter names the terminal's real program;
 *   - the wheel over a mouse-reporting alt-screen program reaches the program, before the restart
 *     and after re-adoption (the new adapter learns the modes when it subscribes);
 *   - an adapter killed under a live relay: the relay re-adopts its terminal with a new adapter;
 *   - termd crash (SIGKILL): the adapter says LOST termd in the relay log and closes the grid,
 *     terminal.recover lists nothing live (not an error), and the next spawn starts a fresh daemon.
 * Everything it started (relay, daemons, shells) is stopped on exit. Exit 1 on any FAIL.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateTermd, stopTermd, stopTermdSync, termdPid } from './lib/termd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'glyph3d-cli');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NS = 'tr';

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
const info = (msg) => console.log(`info  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const PORT = Number(arg('--relay', 0)) || await freePort();
const termd = privateTermd(`tr${process.pid}`);
const root = path.join(termd.dir, 'root');
mkdirSync(root, { recursive: true });

// ── the relay ───────────────────────────────────────────────────────────────────────────────
let relay = null;
let relayLog = '';
async function startRelay() {
    relay = spawn(BIN, ['serve', '--listen', '127.0.0.1', '--port', String(PORT), '--relay-only', '--termd-ns', NS, '--no-gomuxai', root],
        { env: termd.env, stdio: ['ignore', 'pipe', 'pipe'] });
    relay.stdout.on('data', (b) => { relayLog += b; });
    relay.stderr.on('data', (b) => { relayLog += b; });
    for (let i = 0; i < 100; i++) {
        const up = await new Promise((res) => { const s = net.connect(PORT, '127.0.0.1', () => { s.end(); res(true); }); s.on('error', () => res(false)); });
        if (up) return;
        if (relay.exitCode != null) break;
        await sleep(50);
    }
    throw new Error(`relay did not start on :${PORT}\n${relayLog.slice(-800)}`);
}
async function stopRelay() {
    if (!relay || relay.exitCode != null) return;
    const gone = new Promise((r) => relay.once('exit', r));
    relay.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (relay.exitCode == null) { relay.kill('SIGKILL'); await gone; }
}
const cleanup = () => { try { relay?.kill('SIGKILL'); } catch { /* gone */ } stopTermdSync(termd.dir, NS); };
process.on('exit', cleanup);
process.once('SIGINT', () => { cleanup(); process.exit(130); });

// ── the simulated display ───────────────────────────────────────────────────────────────────
/** Per terminal: its owner (controller id), the text of every OUTPUT frame, closes seen. */
const terms = new Map();
const term = (id) => { if (!terms.has(id)) terms.set(id, { owner: null, text: '', sizes: [], closes: 0 }); return terms.get(id); };
let display = null;
const events = [];
async function connectDisplay() {
    display = new WebSocket(`ws://127.0.0.1:${PORT}`);
    display.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { display.onopen = res; display.onerror = () => rej(new Error('display could not connect')); });
    display.onmessage = (e) => {
        if (typeof e.data !== 'string') {
            const b = new Uint8Array(e.data);
            if (b[0] !== 0x01) return;
            const n = b[1];
            const id = new TextDecoder().decode(b.subarray(2, 2 + n));
            const cols = (b[2 + n] << 8) | b[3 + n], rows = (b[4 + n] << 8) | b[5 + n];
            const t = term(id);
            t.text += new TextDecoder().decode(b.subarray(6 + n));
            const last = t.sizes.at(-1);
            if (!last || last[0] !== cols || last[1] !== rows) t.sizes.push([cols, rows]);
            return;
        }
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.from && typeof m.cmd === 'string') {
            const [verb, id] = m.cmd.split(/\s+/);
            let response = `OK: ${verb}`;
            if (verb === 'terminal.create') { term(id).owner = m.from; response = `OK: terminal '${id}' created`; }
            else if (verb === 'terminal.ping') response = terms.has(id) && term(id).owner === m.from ? `OK: ${id}` : `ERR: no terminal '${id}'`;
            else if (verb === 'terminal.close') { const t = term(id); t.closes++; t.owner = null; response = `OK: closed '${id}'`; }
            display.send(JSON.stringify({ to: m.from, response }));
            return;
        }
        events.push(m);
    };
    display.send('DISPLAY');
    await waitFor(() => events.some((e) => e.role === 'display'), 3000, 'display ack');
}
async function waitFor(fn, ms, what) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await fn()) return true; await sleep(25); }
    throw new Error(`timed out waiting for ${what}`);
}
const relayEvent = async (msg, event, ms = 8000) => {
    const from = events.length;
    display.send(JSON.stringify(msg));
    let got = null;
    await waitFor(() => (got = events.slice(from).find((e) => e.event === event)), ms, event);
    return got;
};
const type = (id, text) => display.send(JSON.stringify({ to: term(id).owner, event: 'terminal.bytes', data: { terminalId: id, b64: Buffer.from(text).toString('base64') } }));
const screenHas = (id, s, ms = 8000) => waitFor(() => term(id).text.includes(s), ms, `"${s}" on ${id}`).then(() => true, () => false);
const wheel = (id, lines) => display.send(JSON.stringify({ to: term(id).owner, event: 'terminal.scroll', data: { terminalId: id, lines } }));
/** The pid of the adapter process serving terminal `id` on this relay. */
const adapterPid = (id) => {
    const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const line = ps.split('\n').find((l) => l.includes(` attach ${id} --port ${PORT} `));
    return line ? Number(line.trim().split(/\s+/)[0]) : null;
};
// A program on the alternate screen that asked for SGR mouse reports, echoing what it reads.
const ALT_MOUSE = ['sh', '-c', "printf '\\033[?1049h\\033[?1000h\\033[?1006hALT-READY'; stty raw -echo; exec cat -v"];

try {
    await startRelay();
    info(`private relay on :${PORT}, termd namespace "${NS}" in ${termd.dir}`);
    await connectDisplay();

    // ── spawn + typing ──
    const s1 = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: ['sh'] }, 'terminal.spawning');
    const A = s1.id;
    ok(A === 'term-1', `the first spawn is term-1 (${A})`);
    await waitFor(() => term(A).owner, 8000, 'the adapter to create its grid');
    const daemon1 = termdPid(termd.dir, NS);
    ok(!!daemon1, `the relay started g3d-termd for its namespace (pid ${daemon1})`);
    type(A, 'echo hello-$((6*7))\r');
    ok(await screenHas(A, 'hello-42'), 'typing reaches the shell and its echo reaches the display');
    ok(term(A).sizes[0]?.join('x') === '80x24', `OUTPUT frames carry the display's size (${term(A).sizes[0]?.join('x')})`);

    // ── a flood through the whole pipeline ──
    const before = term(A).text.length;
    type(A, 'seq 1 300000; echo FLOOD-$((1+1))-DONE\r');
    ok(await screenHas(A, 'FLOOD-2-DONE', 60_000), 'the flood finished');
    const flood = term(A).text.slice(before);
    // Lines as a terminal shows them: escape sequences and carriage returns are not text.
    const nums = flood.split('\n').map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, ''))
        .filter((l) => /^\d+$/.test(l)).map(Number);
    let inOrder = nums.length === 300000;
    for (let i = 0; inOrder && i < nums.length; i++) if (nums[i] !== i + 1) inOrder = false;
    ok(inOrder, `seq 1 300000 arrived whole and in order through termd → adapter → relay (${nums.length} lines)`);
    if (!inOrder) info(`flood starts ${JSON.stringify(flood.slice(0, 120))} … ends ${JSON.stringify(flood.slice(-120))}`);

    // ── the wheel over a mouse-reporting alt-screen program goes to the program ──
    const sw = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: ALT_MOUSE }, 'terminal.spawning');
    const W = sw.id;
    await waitFor(() => term(W).owner, 8000, 'the alt-screen terminal');
    ok(await screenHas(W, 'ALT-READY'), 'the alt-screen program is up');
    await sleep(300);
    wheel(W, 3);
    ok(await screenHas(W, '^[[<64;'), 'a wheel over it arrives as SGR wheel reports');

    // ── a relay restart: the terminal survives and is re-adopted ──
    type(A, 'echo before-restart\r');
    ok(await screenHas(A, 'before-restart\r\n'), 'marker on screen before the restart');
    const logAtStop = relayLog.length;
    await stopRelay();
    display.close();
    await sleep(500); // the adapters notice and detach
    ok(!/LOST termd/.test(relayLog.slice(logAtStop)), 'stopping the relay logs no termd loss (termd is fine)');
    for (const id of [A, W]) { term(id).owner = null; term(id).text = ''; }
    ok(termdPid(termd.dir, NS) === daemon1, 'termd outlives the relay');
    await startRelay();
    await connectDisplay();
    const rec = await relayEvent({ relay: 'terminal.recover' }, 'terminal.recovered');
    ok(rec.ids?.includes(A) && rec.live?.includes(A), `terminal.recover re-adopts ${A} (ids ${JSON.stringify(rec.ids)}, live ${JSON.stringify(rec.live)})`);
    await waitFor(() => term(A).owner, 8000, 'the new adapter to re-create the grid');
    ok(await screenHas(A, 'before-restart'), "the adoption repaint carries the terminal's screen from before the restart");
    ok(new RegExp(`\\[attach\\] ${A} adopted in termd namespace "${NS}" \\([^)]*\\): sh\\n`).test(relayLog),
        "the re-adopting adapter names the terminal's own program (sh), not its default shell");
    await waitFor(() => term(W).owner, 8000, 'the alt-screen terminal re-adopted');
    await sleep(500);
    // Down this time (button 65): the repaint carries the up reports already on the screen.
    wheel(W, -3);
    ok(await screenHas(W, '^[[<65;'), 'after re-adoption the wheel still reaches the alt-screen program (the adapter knows its modes)');
    type(A, 'echo after-$((2+3))\r');
    ok(await screenHas(A, 'after-5'), 'typing reaches the re-adopted shell');
    const s2 = await relayEvent({ relay: 'terminal.spawn', cols: 60, rows: 10, argv: ['sh'] }, 'terminal.spawning');
    ok(s2.id === 'term-3', `a spawn after the restart mints a fresh id (${s2.id})`);
    await waitFor(() => term(s2.id).owner, 8000, 'the second terminal');

    // ── an adapter dies under a live relay: the relay re-adopts its terminal ──
    const deadAdapter = adapterPid(A);
    ok(!!deadAdapter, `found ${A}'s adapter (pid ${deadAdapter})`);
    const ownerBefore = term(A).owner;
    if (deadAdapter) process.kill(deadAdapter, 'SIGKILL');
    await waitFor(() => term(A).owner && term(A).owner !== ownerBefore, 8000, 'a new adapter for the orphan').catch(() => {});
    ok(term(A).owner && term(A).owner !== ownerBefore, `the relay re-adopted ${A} after its adapter was killed`);
    type(A, 'echo poke-$((3*3))\r');
    ok(await screenHas(A, 'poke-9'), 'typing reaches the shell through the new adapter');

    // ── termd crashes: loud, and the next spawn starts a fresh daemon ──
    const logAtCrash = relayLog.length;
    process.kill(daemon1, 'SIGKILL');
    await waitFor(() => term(A).closes > 0 && term(s2.id).closes > 0, 8000, 'the adapters to close their grids').catch(() => {});
    ok(term(A).closes > 0 && term(s2.id).closes > 0, 'every adapter closes its grid when termd dies');
    await waitFor(() => /LOST termd/.test(relayLog.slice(logAtCrash)), 3000, 'the loss in the relay log').catch(() => {});
    ok(/\[attach\] term-1: LOST termd \(namespace "tr"\)/.test(relayLog.slice(logAtCrash)), 'the relay log names the loss: "[attach] term-1: LOST termd (namespace "tr")…"');
    const rec2 = await relayEvent({ relay: 'terminal.recover' }, 'terminal.recovered');
    ok(!rec2.error && Array.isArray(rec2.live) && rec2.live.length === 0, `after the crash nothing is live, and that is not an error (${JSON.stringify(rec2)})`);
    const s3 = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: ['sh'] }, 'terminal.spawning');
    await waitFor(() => term(s3.id).owner, 8000, 'a terminal after the crash');
    const daemon2 = termdPid(termd.dir, NS);
    ok(!!daemon2 && daemon2 !== daemon1, `the next spawn started a fresh daemon (pid ${daemon2})`);
    type(s3.id, 'echo fresh-$((4*4))\r');
    ok(await screenHas(s3.id, 'fresh-16'), 'the fresh daemon serves typing');
} catch (e) {
    failures++;
    console.log(`FAIL  ${e.message}`);
    console.log(relayLog.split('\n').slice(-30).join('\n'));
} finally {
    display?.close();
    await stopRelay();
    await stopTermd(termd.dir, NS);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
