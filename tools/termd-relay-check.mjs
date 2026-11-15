/**
 * termd-relay-check.mjs — the relay and g3d-termd end to end, with a simulated display (no browser).
 *
 *   bun tools/termd-relay-check.mjs [--relay PORT]
 *
 * Starts its own relay (`serve --relay-only --termd-ns tr`, in a scratch G3D_TERMD_DIR —
 * tools/lib/termd.mjs) on PORT, plays the display (DISPLAY handshake, answers terminal.create and
 * terminal.ping, decodes the 0x01 OUTPUT frames), and checks:
 *   - spawn: the relay starts termd, an adapter creates and owns the terminal, typing echoes back;
 *   - a spawn with no argv, from a relay whose environment carries another terminal's identity and
 *     a parent shell's state: termd starts the account's shell as a login shell in the relay's
 *     served root, with termd's own TERM_PROGRAM and none of the relay's identity (the
 *     environment from /proc on Linux; on macOS, which withholds a platform shell's, from `g3d env`);
 *     the relay sends no environment of its own, so `g3d env` tags nothing `caller`;
 *   - flood: `seq 1 300000` through termd → adapter → relay → display arrives whole, in order;
 *   - relay restart: the terminal survives, terminal.recover re-adopts it, the adoption repaint
 *     carries the old screen, typing works again, the next spawn mints a fresh id; stopping the
 *     relay logs no termd loss, and the re-adopting adapter names the terminal's real program;
 *   - the wheel over a mouse-reporting alt-screen program reaches the program, before the restart
 *     and after re-adoption (the new adapter learns the modes when it subscribes);
 *   - an adapter killed under a live relay: the relay re-adopts its terminal with a new adapter;
 *   - termd's brain SIGKILLed: the holder restarts it, every adapter rides the restart (no grid
 *     closes, no LOST termd), the re-subscribe repaint brings the screen back, typing works, and
 *     terminal.recover meanwhile answers the live terminals or an error, never an empty list;
 *   - `g3d upgrade` to a copy of the binary: the adapters reconnect at once, grids stay, typing works;
 *   - termd's holder SIGKILLed (every shell dies with it): the adapter says LOST termd in the relay
 *     log and closes the grid, terminal.recover lists nothing live (not an error), and the next
 *     spawn starts a fresh daemon;
 *   - termd's status reaches the display with no per-terminal query: a termd/status push with each
 *     relay state the run passes through (ok with termd's document listing the terminals, one at
 *     registration after a relay restart, restarting across the brain crash, lost when the holder
 *     dies), the display's own termd/status request, and the CLI's page-less termd.status.
 * Everything it started (relay, daemons, shells) is stopped on exit. Exit 1 on any FAIL.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brainPid, g3dBeside, privateTermd, stopTermd, stopTermdSync, termdBeside, termdPid } from './lib/termd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'glyph3d-cli');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NS = 'tr';

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
const info = (msg) => console.log(`info  ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a started relay may take to log its listener (a failure bound, never the wait). */
const BIND_MS = 10_000;

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
// The relay starts from an environment that is not a desktop session's: another terminal's
// identity and a parent shell's state, none of which may reach a terminal (DESIGN.md, "Environment").
const relayEnv = { ...termd.env, TERM_PROGRAM: 'Apple_Terminal', TERM_SESSION_ID: 'w0t0p0:check', SHLVL: '7', COLUMNS: '33', TMUX: '/nonexistent/tmux,1,0' };
async function startRelay(env = relayEnv, ns = NS, port = PORT) {
    relay = spawn(BIN, ['serve', '--listen', '127.0.0.1', '--port', String(port), '--relay-only', '--termd-ns', ns, '--no-gomuxai', root],
        { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The relay logs `[serve] listening on <addr>` once its socket is bound: that line, or its exit,
    // is what a start waits for (BIND_MS only bounds a relay that does neither).
    const from = relayLog.length;
    let bound = null;
    const ready = new Promise((res) => { bound = res; });
    const keep = (b) => { relayLog += b; if (relayLog.indexOf('[serve] listening on ', from) >= 0) bound(true); };
    relay.stdout.on('data', keep);
    relay.stderr.on('data', keep);
    // Both pipes close when every process holding them has exited: the relay and its adapters
    // (they inherit its stdout and stderr) — what "the relay and everything it ran are gone" is.
    const r = relay;
    r.drained = Promise.all([r.stdout, r.stderr].map((p) => new Promise((res) => p.once('close', res))));
    let bounded = null;
    const up = await Promise.race([ready, new Promise((res) => r.once('exit', () => res(false))), new Promise((res) => { bounded = setTimeout(() => res(false), BIND_MS); })]);
    clearTimeout(bounded);
    if (up) return;
    throw new Error(`relay did not start on :${port}\n${relayLog.slice(-800)}`);
}
async function stopRelay() {
    if (!relay || relay.exitCode != null) return;
    const gone = new Promise((r) => relay.once('exit', r));
    relay.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (relay.exitCode == null) { relay.kill('SIGKILL'); await gone; }
}
// The stripped relay's own namespace (its daemon reads the session source: G3D_TERMD_ENV_SOURCE unset).
const AUTO_NS = 'tra';
const autoTermd = privateTermd(`tra${process.pid}`);
const cleanup = () => { try { relay?.kill('SIGKILL'); } catch { /* gone */ } stopTermdSync(termd.dir, NS); stopTermdSync(autoTermd.dir, AUTO_NS); };
process.on('exit', cleanup);
process.once('SIGINT', () => { cleanup(); process.exit(130); });

// ── the simulated display ───────────────────────────────────────────────────────────────────
/** Per terminal: its owner (controller id), the text of every OUTPUT frame, closes seen. */
const terms = new Map();
const term = (id) => { if (!terms.has(id)) terms.set(id, { owner: null, text: '', sizes: [], closes: 0 }); return terms.get(id); };
let display = null;
const events = [];
async function connectDisplay(port = PORT) {
    display = new WebSocket(`ws://127.0.0.1:${port}`);
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
/** The termd/status pushes the display got, from index `from` on. */
const statuses = (from = 0) => events.slice(from).filter((e) => e.jsonrpc === '2.0' && e.method === 'termd/status').map((e) => e.params);
const statusSeen = (from, fn, ms = 10_000, what = 'a termd/status push') =>
    waitFor(() => statuses(from).find(fn), ms, what).then(() => statuses(from).find(fn), () => null);
const relayEvent = async (msg, event, ms = 8000) => {
    const from = events.length;
    display.send(JSON.stringify(msg));
    let got = null;
    await waitFor(() => (got = events.slice(from).find((e) => e.event === event)), ms, event);
    return got;
};
const type = (id, text) => display.send(JSON.stringify({ to: term(id).owner, event: 'terminal.bytes', data: { terminalId: id, b64: Buffer.from(text).toString('base64') } }));
const screenHas = (id, s, ms = 8000) => waitFor(() => term(id).text.includes(s), ms, `"${s}" on ${id}`).then(() => true, () => false);
/** A display's key event and paste, as the wall's keyboard and clipboard push them. */
const press = (id, key) => display.send(JSON.stringify({ to: term(id).owner, event: 'terminal.key', data: { terminalId: id, action: 'press', ...key } }));
const pasteText = (id, text) => display.send(JSON.stringify({ to: term(id).owner, event: 'terminal.paste', data: { terminalId: id, text } }));
/** What a program read, as the hex echo below prints it. */
const hexOf = (s) => [...Buffer.from(s)].map((b) => `[${b.toString(16).padStart(2, '0')}]`).join('');
const wheel = (id, lines) => display.send(JSON.stringify({ to: term(id).owner, event: 'terminal.scroll', data: { terminalId: id, lines } }));
/** The pid of the adapter process serving terminal `id` on this relay. */
const adapterPid = (id) => {
    const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const line = ps.split('\n').find((l) => l.includes(` attach ${id} --port ${PORT} `));
    return line ? Number(line.trim().split(/\s+/)[0]) : null;
};
// A program that pushed Kitty keyboard flags (CSI > 1 u) and asked for bracketed paste, echoing each
// byte it reads in hex.
const KITTY_HEX = ['sh', '-c', "stty raw -echo; printf '\\033[>1u\\033[?2004hKEYS-%s\\n' READY; " +
    "while :; do b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); printf '[%s]' \"$b\"; done"];
// A program on the alternate screen that asked for SGR mouse reports, echoing what it reads.
// ALT-READY is printed once the tty is raw (so a report reaches cat whole) and the modes are set:
// termd's `modes` event follows the output that set them, so the adapter knows them before the
// display can see the marker and answer it.
const ALT_MOUSE = ['sh', '-c', "stty raw -echo; printf '\\033[?1049h\\033[?1000h\\033[?1006hALT-READY'; exec cat -v"];

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

    // ── termd's status reaches the display: pushed, asked for, and page-less ──
    {
        const st = await statusSeen(0, (p) => p.relay.state === 'ok' && p.status?.terminals?.some((t) => t.id === A), 10_000);
        ok(!!st, `a termd/status push says ok with termd's document listing ${A} (${st ? `${st.status.daemon.version}, ns ${st.relay.ns}, bundled ${st.relay.bundled}` : 'none'})`);
        ok(statuses(0).some((p) => p.relay.state === 'absent'), 'before the first spawn it read absent (no daemon yet)');
        ok(!!st && st.relay.bundled === st.status.daemon.version, `the relay ships the termd it runs (${st?.relay.bundled})`);
        ok(Array.isArray(st?.relay.lacks) && st.relay.lacks.length === 0, `the brain offers every input op the display uses (lacks ${JSON.stringify(st?.relay.lacks)})`);
        const id = 777;
        display.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'termd/status', params: {} }));
        let reply = null;
        await waitFor(() => (reply = events.find((e) => e.jsonrpc === '2.0' && e.id === id)), 3000, 'the termd/status reply').catch(() => {});
        ok(reply?.result?.relay?.state === 'ok' && reply.result.status?.terminals?.length >= 1, "the display's termd/status request answers with the last notification");
        let cli = '';
        try { cli = execFileSync(BIN, ['--port', String(PORT), 'termd.status'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { cli = `${e.stdout ?? ''}${e.message}`; }
        ok(/termd ok · ns tr · g3d-termd\/\S+ · brain \d+ gen 1 · 1 terminal/.test(cli) && cli.includes(A), `the CLI's termd.status answers page-less (${cli.split('\n')[0]})`);
    }

    // ── a spawn with no argv: the account's login shell, in the served root, termd's environment ──
    const sd = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24 }, 'terminal.spawning');
    await waitFor(() => term(sd.id).owner, 8000, 'the default-shell terminal');
    const ls = execFileSync(g3dBeside(BIN), ['--ns', NS, 'ls'], { env: termd.env, encoding: 'utf8' });
    const line = ls.split('\n').find((l) => l.startsWith(`${sd.id} `)) ?? '';
    const shellPid = Number(/ pid (\d+)/.exec(line)?.[1]);
    const passwdShell = os.userInfo().shell; // getpwuid, as termd reads it
    ok(line.includes(` ${passwdShell}`), `with no argv the relay's terminal runs the account's shell (${line.trim()})`);
    // argv[0] and the cwd: /proc on Linux; ps and lsof elsewhere (macOS has no /proc).
    const linux = existsSync(`/proc/${shellPid}`);
    const argv0 = linux
        ? readFileSync(`/proc/${shellPid}/cmdline`, 'utf8').split('\0')[0]
        : execFileSync('ps', ['-o', 'args=', '-p', String(shellPid)], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    const cwd = linux
        ? readlinkSync(`/proc/${shellPid}/cwd`)
        : execFileSync('lsof', ['-a', '-p', String(shellPid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n'))?.slice(1);
    ok(argv0 === `-${path.basename(passwdShell)}`, `...as a login shell (argv[0] ${JSON.stringify(argv0)})`);
    ok(cwd === root, `...in the relay's served root (${cwd})`);
    // The relay is a creator with no shell: no env_base, so the session's names, never its own.
    let tags = [];
    try {
        tags = JSON.parse(execFileSync(g3dBeside(BIN), ['--ns', NS, 'env', sd.id, '--json'], { env: termd.env, encoding: 'utf8' })).env ?? [];
    } catch (e) { info(`g3d env: ${e.message}`); }
    // The kernel's view on Linux; macOS withholds a platform binary's environment (zsh's) from
    // other processes, so there the environment checks read termd's own account of it.
    const env = linux
        ? Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean)
            .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
        : Object.fromEntries(tags.map((v) => [v.name, v.value]));
    if (!linux) info('the login shell\'s environment as `g3d env` reports it (macOS withholds a platform binary\'s; cargo test\'s tests/env.rs reads the kernel\'s)');
    ok(env.TERM_PROGRAM === 'g3d-termd' && env.TERM === 'xterm-256color' && env.PWD === root && env.G3D_TERMD_ID === sd.id,
        `...with termd's own variables (TERM_PROGRAM ${env.TERM_PROGRAM}, TERM ${env.TERM}, PWD ${env.PWD})`);
    const leaked = ['TERM_SESSION_ID', 'SHLVL', 'COLUMNS', 'TMUX', 'G3D_TERMD_DIR', 'G3D_TERMD_ENV_SOURCE'].filter((k) => k in env);
    ok(leaked.length === 0, `...and none of the relay's identity or shell state (leaked: ${leaked.join(' ') || 'none'})`);
    const callers = tags.filter((v) => v.source === 'caller').map((v) => v.name);
    ok(tags.length === Object.keys(env).length && callers.length === 0,
        `...the relay sent no environment of its own: g3d env tags ${tags.length} variables, none caller (${callers.join(' ') || 'none'})`);
    // Ended as the display ends one (terminal.kill → terminal.shutdown), so later counts hold.
    display.send(JSON.stringify({ to: term(sd.id).owner, event: 'terminal.shutdown', data: { terminalId: sd.id } }));
    await waitFor(() => !execFileSync(g3dBeside(BIN), ['--ns', NS, 'ls'], { env: termd.env, encoding: 'utf8' }).includes(`${sd.id} `),
        8000, `${sd.id} to end`);

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

    // ── key events and paste: termd encodes them in the program's own modes ──
    {
        const sk = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: KITTY_HEX }, 'terminal.spawning');
        await waitFor(() => term(sk.id).owner, 8000, 'the Kitty-keyboard terminal');
        ok(await screenHas(sk.id, 'KEYS-READY'), 'the Kitty-keyboard program is up');
        press(sk.id, { code: 'Enter', key: 'Enter', mods: ['Shift'], text: '' });
        ok(await screenHas(sk.id, hexOf('\x1b[13;2u')), 'terminal.key Shift+Enter reaches a Kitty-keyboard program as CSI 13;2u');
        press(sk.id, { code: 'KeyA', key: 'a', mods: [], text: 'a' });
        ok(await screenHas(sk.id, hexOf('\x1b[13;2ua')), "terminal.key a types its text, a (Kitty's CSI 97u would mean the text was lost)");
        press(sk.id, { code: 'KeyC', key: 'c', mods: ['Control'], text: 'c' });
        ok(await screenHas(sk.id, hexOf('a\x1b[99;5u')), 'terminal.key Ctrl+C reaches it as CSI 99;5u, not a SIGINT byte');
        pasteText(sk.id, 'hi\x1b[201~x');
        ok(await screenHas(sk.id, hexOf('\x1b[200~hi [201~x\x1b[201~')),
            'terminal.paste is bracketed, and an ESC inside it is a space: the bracket ends once');
        display.send(JSON.stringify({ to: term(sk.id).owner, event: 'terminal.shutdown', data: { terminalId: sk.id } }));
        await waitFor(() => !execFileSync(g3dBeside(BIN), ['--ns', NS, 'ls'], { env: termd.env, encoding: 'utf8' }).includes(`${sk.id} `),
            8000, `${sk.id} to end`);
    }

    // ── the wheel over a mouse-reporting alt-screen program goes to the program ──
    const sw = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: ALT_MOUSE }, 'terminal.spawning');
    const W = sw.id;
    await waitFor(() => term(W).owner, 8000, 'the alt-screen terminal');
    ok(await screenHas(W, 'ALT-READY'), 'the alt-screen program is up');
    wheel(W, 3);
    ok(await screenHas(W, '^[[<64;'), 'a wheel over it arrives as SGR wheel reports');

    // ── a relay restart: the terminal survives and is re-adopted ──
    type(A, 'echo before-restart\r');
    ok(await screenHas(A, 'before-restart\r\n'), 'marker on screen before the restart');
    const logAtStop = relayLog.length;
    await stopRelay();
    display.close();
    // The adapters notice and detach: once they (and the relay) are gone, the pipes they shared close.
    await Promise.race([relay.drained, sleep(10_000)]);
    ok(!/LOST termd/.test(relayLog.slice(logAtStop)), 'stopping the relay logs no termd loss (termd is fine)');
    for (const id of [A, W]) { term(id).owner = null; term(id).text = ''; }
    ok(termdPid(termd.dir, NS) === daemon1, 'termd outlives the relay');
    await startRelay();
    const evAtRestart = events.length;
    await connectDisplay();
    const pushed = await statusSeen(evAtRestart, (p) => p.relay.state === 'ok', 10_000);
    ok(!!pushed, 'a restarted relay pushes termd/status to the display that registers (ok, its document)');
    const rec = await relayEvent({ relay: 'terminal.recover' }, 'terminal.recovered');
    ok(rec.ids?.includes(A) && rec.live?.includes(A), `terminal.recover re-adopts ${A} (ids ${JSON.stringify(rec.ids)}, live ${JSON.stringify(rec.live)})`);
    await waitFor(() => term(A).owner, 8000, 'the new adapter to re-create the grid');
    ok(await screenHas(A, 'before-restart'), "the adoption repaint carries the terminal's screen from before the restart");
    ok(new RegExp(`\\[attach\\] ${A} adopted in termd namespace "${NS}" \\([^)]*\\): /\\S*/sh in /`).test(relayLog),
        "the re-adopting adapter names the terminal's own program (sh, resolved), not its default shell");
    await waitFor(() => term(W).owner, 8000, 'the alt-screen terminal re-adopted');
    // Its adoption repaint (the screen, marker included): the adapter has subscribed, and termd's
    // `modes` follow the repaint in its stream (PROTOCOL.md, `subscribe`), so it knows them by now.
    ok(await screenHas(W, 'ALT-READY'), 'the alt-screen terminal is repainted after the restart');
    // Down this time (button 65): the repaint carries the up reports already on the screen.
    wheel(W, -3);
    ok(await screenHas(W, '^[[<65;'), 'after re-adoption the wheel still reaches the alt-screen program (the adapter knows its modes)');
    type(A, 'echo after-$((2+3))\r');
    ok(await screenHas(A, 'after-5'), 'typing reaches the re-adopted shell');
    const lastId = Math.max(...[...terms.keys()].map((id) => Number(/^term-(\d+)$/.exec(id)?.[1] ?? 0)));
    const s2 = await relayEvent({ relay: 'terminal.spawn', cols: 60, rows: 10, argv: ['sh'] }, 'terminal.spawning');
    ok(s2.id === `term-${lastId + 1}`, `a spawn after the restart mints a fresh id, past every one before it (${s2.id})`);
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

    // ── termd's brain crashes: the holder restarts it and every grid rides it out ──
    type(A, 'echo before-brain-$((6*6))\r');
    ok(await screenHas(A, 'before-brain-36\r\n'), 'marker on screen before the brain crash');
    // termd's own word that the screen with the marker is saved: a status document built after the
    // marker reached us names A's seq (at least the marker's end), and a later one a saved_seq at
    // or past it (the snapshot interval's save).
    const tMarker = Date.now(), evAtMarker = events.length;
    const seqOf = (p, key) => p.status?.terminals?.find((t) => t.id === A)?.[key];
    const afterMark = await statusSeen(evAtMarker, (p) => p.status?.at > tMarker && seqOf(p, 'seq') > 0, 10_000);
    const markSeq = afterMark ? seqOf(afterMark, 'seq') : Infinity;
    const saved = await statusSeen(evAtMarker, (p) => (seqOf(p, 'saved_seq') ?? -1) >= markSeq, 10_000);
    ok(!!saved, `termd saved ${A}'s screen with the marker before the crash (saved_seq ${saved ? seqOf(saved, 'saved_seq') : 'never'} ≥ seq ${markSeq})`);
    const brain1 = brainPid(termd.dir, NS);
    ok(!!brain1 && brain1 !== daemon1, `found termd's brain (pid ${brain1}) beside its holder (pid ${daemon1})`);
    const closesBefore = term(A).closes + term(s2.id).closes;
    const logAtBrain = relayLog.length;
    const evAtBrain = events.length;
    term(A).text = '';
    if (brain1) process.kill(brain1, 'SIGKILL');
    // While no brain answers, the list is unknown: recover says so, or lists A once a brain is back.
    const recMid = await relayEvent({ relay: 'terminal.recover' }, 'terminal.recovered');
    ok(!!recMid.error || recMid.live?.includes(A), `terminal.recover during the restart is an error or lists ${A}, never empty (${JSON.stringify(recMid)})`);
    await waitFor(() => relayLog.slice(logAtBrain).includes(`[attach] ${A}: back on termd`), 10_000, 'the adapter to ride the restart').catch(() => {});
    ok(relayLog.slice(logAtBrain).includes(`[attach] ${A}: back on termd (brain generation 2`), `${A}'s adapter rode the restart onto brain generation 2`);
    ok(await screenHas(A, 'before-brain-36'), "the re-subscribe repaint brings the screen back (restored from the brain's snapshot)");
    type(A, 'echo after-brain-$((7*6))\r');
    ok(await screenHas(A, 'after-brain-42'), 'typing reaches the shell through the new brain');
    ok(term(A).closes + term(s2.id).closes === closesBefore, 'no grid closed across the brain restart');
    ok(!/LOST termd/.test(relayLog.slice(logAtBrain)), 'the relay log has no termd loss for a brain restart');
    ok(termdPid(termd.dir, NS) === daemon1, 'the holder (and every shell) outlived its brain');
    ok(!!(await statusSeen(evAtBrain, (p) => p.relay.state === 'restarting', 5000)), 'termd/status said restarting while the brain was down');
    const gen2 = await statusSeen(evAtBrain, (p) => p.relay.state === 'ok' && p.status?.daemon.brain.generation === 2, 10_000);
    ok(gen2?.status.daemon.brain.restarts.crash === 1, `...then ok on generation 2, the crash counted (${JSON.stringify(gen2?.status.daemon.brain.restarts)})`);

    // ── g3d upgrade: a planned brain replacement, reconnected at once ──
    const next = path.join(termd.dir, 'g3d-termd-next');
    copyFileSync(termdBeside(BIN), next);
    const logAtUpgrade = relayLog.length;
    let upgradeOut = '';
    try {
        upgradeOut = execFileSync(g3dBeside(BIN), ['--socket', path.join(termd.dir, `termd-${NS}.sock`), 'upgrade', '--binary', next],
            { env: termd.env, encoding: 'utf8', timeout: 30_000 });
    } catch (e) { upgradeOut = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`; }
    ok(/upgraded: .* generation 3/.test(upgradeOut), `g3d upgrade replaced the brain (${upgradeOut.trim()})`);
    await waitFor(() => relayLog.slice(logAtUpgrade).includes(`[attach] ${A}: back on termd (brain generation 3`), 10_000, 'the adapter to follow the upgrade').catch(() => {});
    ok(/termd connection ended \(restart: /.test(relayLog.slice(logAtUpgrade)), 'the adapter saw ERROR restart (a planned restart: it reconnects at once)');
    type(A, 'echo upgraded-$((8*8))\r');
    ok(await screenHas(A, 'upgraded-64'), 'typing reaches the shell after the upgrade');
    ok(term(A).closes + term(s2.id).closes === closesBefore, 'no grid closed across the upgrade');
    ok(!/LOST termd/.test(relayLog.slice(logAtUpgrade)), 'the relay log has no termd loss for an upgrade');

    // ── termd's holder dies (every shell with it): loud, and the next spawn starts a fresh daemon ──
    const logAtCrash = relayLog.length;
    const evAtCrash = events.length;
    process.kill(daemon1, 'SIGKILL');
    await waitFor(() => term(A).closes > 0 && term(s2.id).closes > 0, 8000, 'the adapters to close their grids').catch(() => {});
    ok(term(A).closes > 0 && term(s2.id).closes > 0, 'every adapter closes its grid when termd dies');
    await waitFor(() => /LOST termd/.test(relayLog.slice(logAtCrash)), 3000, 'the loss in the relay log').catch(() => {});
    ok(/\[attach\] term-1: LOST termd \(namespace "tr"\)/.test(relayLog.slice(logAtCrash)), 'the relay log names the loss: "[attach] term-1: LOST termd (namespace "tr")…"');
    const lost = await statusSeen(evAtCrash, (p) => p.relay.state === 'lost', 10_000);
    ok(!!lost && lost.status === null, 'termd/status says lost when the holder dies with terminals in it (no document)');
    const rec2 = await relayEvent({ relay: 'terminal.recover' }, 'terminal.recovered');
    ok(!rec2.error && Array.isArray(rec2.live) && rec2.live.length === 0, `after the crash nothing is live, and that is not an error (${JSON.stringify(rec2)})`);
    const s3 = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: ['sh'] }, 'terminal.spawning');
    await waitFor(() => term(s3.id).owner, 8000, 'a terminal after the crash');
    const daemon2 = termdPid(termd.dir, NS);
    ok(!!daemon2 && daemon2 !== daemon1, `the next spawn started a fresh daemon (pid ${daemon2})`);
    type(s3.id, 'echo fresh-$((4*4))\r');
    ok(await screenHas(s3.id, 'fresh-16'), 'the fresh daemon serves typing');

    // ── a relay started from a stripped environment, its daemon asking the session source ──
    // The environment's gate: a relay-created terminal from a stripped relay environment gets the session's
    // handles. The relay carries a stale DISPLAY, a stale bus address, a missing runtime directory,
    // another terminal's identity and names that are no session's (on macOS a stale SSH agent socket
    // too, and no TMPDIR); its daemon (namespace "tra", no G3D_TERMD_ENV_SOURCE) asks the session
    // source, read-only, as a person's would: the systemd user manager, or launchd.
    display.close();
    await stopRelay();
    terms.clear();
    events.length = 0;
    const PORT2 = await freePort();
    const strippedEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME,
        G3D_TERMD_DIR: autoTermd.dir, G3D_TERMD_CONFIG: path.join(autoTermd.dir, 'termd.toml'),
        DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus', XDG_RUNTIME_DIR: '/nonexistent',
        TERM_PROGRAM: 'Apple_Terminal', REX_SESSION: 'rex-tab-3', SECRET_LEAK: 'leak',
        XDG_CONFIG_HOME: path.join(autoTermd.dir, 'scratch-cfg'), TZ: 'UTC', LC_ALL: 'C',
        ...(process.platform === 'darwin' ? { SSH_AUTH_SOCK: '/nonexistent/stale-agent' } : {}),
    };
    await startRelay(strippedEnv, AUTO_NS, PORT2);
    await connectDisplay(PORT2);
    const sa = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24, argv: ['sleep', '300'] }, 'terminal.spawning');
    await waitFor(() => term(sa.id).owner, 8000, 'the stripped relay\'s terminal');
    const g3dAuto = (...args) => execFileSync(g3dBeside(BIN), ['--ns', AUTO_NS, ...args], { env: { ...process.env, G3D_TERMD_DIR: autoTermd.dir }, encoding: 'utf8' });
    {
        // The display's grid comes first; the adapter's create reaches termd after it (on macOS
        // the brain's first launchd lookup is ~0.1 s), so wait for termd to list it.
        let autoLs = '';
        await waitFor(() => (autoLs = g3dAuto('ls')).split('\n').some((l) => l.startsWith(`${sa.id} `)), 8000, `${sa.id} in termd`).catch(() => {});
        const autoPid = Number(/ pid (\d+)/.exec(autoLs.split('\n').find((l) => l.startsWith(`${sa.id} `)) ?? '')?.[1]);
        if (!autoPid) info(`no pid for ${sa.id} in g3d ls:\n${autoLs}`);
        const tags = Object.fromEntries((JSON.parse(g3dAuto('env', sa.id, '--json')).env ?? []).map((v) => [v.name, { value: v.value, tag: `${v.source}${v.via ? ` (${v.via})` : ''}` }]));
        // The program's environment: the kernel's on Linux; on macOS, which withholds a platform
        // binary's (sleep's), termd's own account of it.
        const linuxEnv = existsSync(`/proc/${autoPid}`);
        const env = linuxEnv
            ? Object.fromEntries(readFileSync(`/proc/${autoPid}/environ`, 'utf8').split('\0').filter(Boolean)
                .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
            : Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, v.value]));
        const tag = (k) => tags[k]?.tag;
        const leaked = ['REX_SESSION', 'SECRET_LEAK', 'TZ', 'XDG_CONFIG_HOME', 'LC_ALL'].filter((k) => k in env && env[k] === strippedEnv[k]);
        ok(env.TERM_PROGRAM === 'g3d-termd' && leaked.length === 0, `the stripped relay's terminal carries none of its creator's (leaked: ${leaked.join(' ') || 'none'})`);
        if (process.platform === 'darwin') {
            // launchd's: what launchctl getenv holds (the agent's socket), and the per-user TMPDIR it
            // gives every job. Outside a GUI session (an ssh login) there is none to read.
            const launchctl = (...a) => { try { return execFileSync('/bin/launchctl', a, { encoding: 'utf8' }).trim(); } catch { return ''; } };
            if (launchctl('managername') !== 'Aqua') info(`launchctl managername is ${JSON.stringify(launchctl('managername'))}, not Aqua: no GUI session's handles to check`);
            else {
                const want = {
                    TMPDIR: launchctl('getenv', 'TMPDIR') || execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(),
                    SSH_AUTH_SOCK: launchctl('getenv', 'SSH_AUTH_SOCK'),
                };
                const handles = Object.keys(want).filter((k) => want[k]);
                const wrong = handles.filter((k) => env[k] !== want[k] || tag(k) !== 'session (launchd)');
                ok(wrong.length === 0, `...and the session's handles, fresh from launchd: ${handles.map((k) => `${k}=${env[k]} [${tag(k)}]`).join(', ')}`);
                ok(env.DISPLAY === ':99' && tag('DISPLAY') === 'session (daemon)', `...and, launchd holding no DISPLAY, the relay's by name (${env.DISPLAY} [${tag('DISPLAY')}])`);
            }
        } else {
            let manager = null;
            try {
                const out = execFileSync('busctl', ['--user', '--json=short', 'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                    'org.freedesktop.systemd1.Manager', 'Environment'], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` }, encoding: 'utf8', timeout: 5000 });
                manager = Object.fromEntries(JSON.parse(out).data.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
            } catch (e) { info(`no systemd user manager answers here (${e.message.split('\n')[0]}): the handles fall back to the relay's start values`); }
            const handles = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'].filter((k) => manager?.[k]);
            if (handles.length) {
                const wrong = handles.filter((k) => env[k] !== manager[k] || tag(k) !== 'session (systemd-user)');
                ok(wrong.length === 0, `...and the session's handles, fresh from the user manager: ${handles.map((k) => `${k}=${env[k]} [${tag(k)}]`).join(', ')}`);
            } else {
                ok(env.DISPLAY === ':99' && tag('DISPLAY') === 'session (daemon)', `...and, with no user manager holding the handles, the relay's DISPLAY by name (${env.DISPLAY} [${tag('DISPLAY')}])`);
            }
        }
    }
} catch (e) {
    failures++;
    console.log(`FAIL  ${e.message}`);
    console.log(relayLog.split('\n').slice(-30).join('\n'));
} finally {
    display?.close();
    await stopRelay();
    await stopTermd(termd.dir, NS);
    await stopTermd(autoTermd.dir, AUTO_NS);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
