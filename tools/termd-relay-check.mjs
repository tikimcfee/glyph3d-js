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
 *     served root, with termd's own TERM_PROGRAM and none of the relay's identity (Linux: /proc);
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
 *     spawn starts a fresh daemon.
 * Everything it started (relay, daemons, shells) is stopped on exit. Exit 1 on any FAIL.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import net from 'node:net';
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
async function startRelay() {
    relay = spawn(BIN, ['serve', '--listen', '127.0.0.1', '--port', String(PORT), '--relay-only', '--termd-ns', NS, '--no-gomuxai', root],
        { env: relayEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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

    // ── a spawn with no argv: the account's login shell, in the served root, termd's environment ──
    const sd = await relayEvent({ relay: 'terminal.spawn', cols: 80, rows: 24 }, 'terminal.spawning');
    await waitFor(() => term(sd.id).owner, 8000, 'the default-shell terminal');
    const ls = execFileSync(g3dBeside(BIN), ['--ns', NS, 'ls'], { env: termd.env, encoding: 'utf8' });
    const line = ls.split('\n').find((l) => l.startsWith(`${sd.id} `)) ?? '';
    const shellPid = Number(/ pid (\d+)/.exec(line)?.[1]);
    const passwdShell = execFileSync('getent', ['passwd', String(process.getuid())], { encoding: 'utf8' }).trim().split(':')[6];
    ok(line.includes(` ${passwdShell}`), `with no argv the relay's terminal runs the account's shell (${line.trim()})`);
    if (existsSync(`/proc/${shellPid}`)) {
        const argv0 = readFileSync(`/proc/${shellPid}/cmdline`, 'utf8').split('\0')[0];
        ok(argv0 === `-${path.basename(passwdShell)}`, `...as a login shell (argv[0] ${JSON.stringify(argv0)})`);
        ok(readlinkSync(`/proc/${shellPid}/cwd`) === root, `...in the relay's served root (${readlinkSync(`/proc/${shellPid}/cwd`)})`);
        const env = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean)
            .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
        ok(env.TERM_PROGRAM === 'g3d-termd' && env.TERM === 'xterm-256color' && env.PWD === root && env.G3D_TERMD_ID === sd.id,
            `...with termd's own variables (TERM_PROGRAM ${env.TERM_PROGRAM}, TERM ${env.TERM}, PWD ${env.PWD})`);
        const leaked = ['TERM_SESSION_ID', 'SHLVL', 'COLUMNS', 'TMUX', 'G3D_TERMD_DIR', 'G3D_TERMD_ENV_SOURCE'].filter((k) => k in env);
        ok(leaked.length === 0, `...and none of the relay's identity or shell state (leaked: ${leaked.join(' ') || 'none'})`);
    } else info(`no /proc/${shellPid}: the environment checks are Linux-only here`);
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
    ok(new RegExp(`\\[attach\\] ${A} adopted in termd namespace "${NS}" \\([^)]*\\): /\\S*/sh in /`).test(relayLog),
        "the re-adopting adapter names the terminal's own program (sh, resolved), not its default shell");
    await waitFor(() => term(W).owner, 8000, 'the alt-screen terminal re-adopted');
    await sleep(500);
    // Down this time (button 65): the repaint carries the up reports already on the screen.
    wheel(W, -3);
    ok(await screenHas(W, '^[[<65;'), 'after re-adoption the wheel still reaches the alt-screen program (the adapter knows its modes)');
    type(A, 'echo after-$((2+3))\r');
    ok(await screenHas(A, 'after-5'), 'typing reaches the re-adopted shell');
    const s2 = await relayEvent({ relay: 'terminal.spawn', cols: 60, rows: 10, argv: ['sh'] }, 'terminal.spawning');
    ok(s2.id === 'term-4', `a spawn after the restart mints a fresh id (${s2.id})`);
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
    await sleep(2500); // past one snapshot interval (2 s): the screen with the marker is saved
    const brain1 = brainPid(termd.dir, NS);
    ok(!!brain1 && brain1 !== daemon1, `found termd's brain (pid ${brain1}) beside its holder (pid ${daemon1})`);
    const closesBefore = term(A).closes + term(s2.id).closes;
    const logAtBrain = relayLog.length;
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
