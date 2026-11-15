#!/usr/bin/env bun
/**
 * check.mjs — run the repo's checks from ONE manifest (tools/check-manifest.mjs).
 *
 *   bun tools/check.mjs                        all headless checks (tier full = inner + full)
 *   bun tools/check.mjs --tier inner           after each change: the fast headless set
 *   bun tools/check.mjs books render           only the checks scoped to books or render
 *   bun tools/check.mjs flat-root layering     checks by name
 *   bun tools/check.mjs --tier browser|gpu     the checks that need Vite, a browser, a GPU
 *   bun tools/check.mjs --tier all             full + browser + gpu (never parked)
 *   bun tools/check.mjs --tier parked          the parked hand tests
 *   bun tools/check.mjs --list [--tier T]      what would run, with what each compares / can't see
 *   bun tools/check.mjs -j 8                   concurrency (default: every core)
 *   bun tools/check.mjs --ratchet              raise this tier's floor to what ran (never lowers)
 *   bun tools/check.mjs --cli PATH             the relay binary (default ./glyph3d-cli)
 *
 * Output: a PASS / FAIL / KNOWN / SKIP line per check as it finishes, NOTE lines (report-only
 * checks, what was skipped and why), a TIME line, and ONE verdict line, last:
 *   ALL GREEN — n of m ran (tier, scope)       every check that ran passed (known reds matched)
 *   RED — k failed …                           exit 1
 *   NOTHING RAN — not a pass                   exit 1: a selection that ran nothing proves nothing
 * A failed check keeps its whole output under out/check/kept/<ts>-<name>/; the run's record is
 * out/check/last-run.json.
 *
 * What a browser / gpu check needs, the runner starts and stops itself — its own Vite on a free
 * port (cache in out/check/vite-cache, never the dev server's), and per check a PRIVATE relay:
 *   glyph3d-cli serve --listen 127.0.0.1 --port <free> --relay-only --termd-ns c<n> \
 *                     --no-gomuxai <scratch root>         (G3D_TERMD_DIR = a scratch dir of its own)
 * serving a fresh copy of the fixture (the core's sources + a mixed emoji/tab/wide file). Never
 * ports 5173 / 5180 / 5280 / 8080 / 8099 / 8180, never a person's termd namespace, never gomuxai. Anything it
 * can't start, it names in a NOTE and SKIPS the checks that needed it.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, SCOPES, TIERS } from './check-manifest.mjs';
import { privateTermd, stopTermd, termdBeside } from './lib/termd.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out/check');
const FLOORS_PATH = join(ROOT, 'tools/check-floors.json');
// `relay`: the runner starts a private relay and fills {relay}/{root}/{dir}. `own-relay`: the check starts
// its own private relay (tools/lib/wall-relay.mjs) — the runner only hands it a free port as {port}.
const NEEDS = ['vite', 'wall-vite', 'relay', 'own-relay', 'browser', 'gpu', 'termd', 'network'];
/** Ports a person's live loop uses: the runner never takes them, even if the OS offers one. */
const RESERVED_PORTS = new Set([5173, 5174, 5180, 5280, 8080, 8099, 8180]);
const DEFAULT_TIMEOUT = { inner: 120_000, full: 120_000, parked: 300_000, browser: 300_000, gpu: 600_000 };
/** Which manifest tiers a --tier selects. */
const TIER_SETS = { inner: ['inner'], full: ['inner', 'full'], browser: ['browser'], gpu: ['gpu'], all: ['inner', 'full', 'browser', 'gpu'], parked: ['parked'] };

// ── args ─────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const valueFlags = new Set(['--tier', '-j', '--cli']);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TIER = flag('--tier', 'full');
const JOBS = Math.max(1, Number(flag('-j', availableParallelism())) || 1);
const CLI = resolve(ROOT, flag('--cli', 'glyph3d-cli'));
const LIST = argv.includes('--list');
const RATCHET = argv.includes('--ratchet');
const positional = argv.filter((a, i) => !a.startsWith('-') && !valueFlags.has(argv[i - 1]));

const say = (s) => process.stdout.write(s + '\n');
const fatal = (s) => { say(s); say('RED — the run could not start (see above)'); process.exit(1); };

if (!TIER_SETS[TIER]) fatal(`unknown --tier ${TIER} (one of ${Object.keys(TIER_SETS).join(', ')})`);

// ── manifest validation: a manifest that lies is RED before anything runs ───────────────────
function validate() {
    const errs = [];
    const names = new Set();
    for (const c of CHECKS) {
        if (names.has(c.name)) errs.push(`duplicate name ${c.name}`);
        names.add(c.name);
        if (!TIERS.includes(c.tier)) errs.push(`${c.name}: unknown tier ${c.tier}`);
        for (const s of c.scope ?? []) if (!SCOPES[s]) errs.push(`${c.name}: unknown scope ${s}`);
        if (!c.scope?.length) errs.push(`${c.name}: no scope`);
        for (const n of c.needs ?? []) if (!NEEDS.includes(n)) errs.push(`${c.name}: unknown need ${n}`);
        if (!c.compare || !c.blind) errs.push(`${c.name}: compare and blind are both required`);
        if (c.known && !(c.known.reason && c.known.signature?.length)) errs.push(`${c.name}: known needs a reason and a signature`);
        const tool = c.cmd.find((a) => a.startsWith('tools/'));
        if (tool && !existsSync(join(ROOT, tool))) errs.push(`${c.name}: ${tool} does not exist`);
    }
    // Coverage: every check-shaped file in tools/ is in some entry's cmd.
    const listed = new Set(CHECKS.flatMap((c) => c.cmd.filter((a) => a.startsWith('tools/'))));
    const shaped = readdirSync(join(ROOT, 'tools')).filter((f) => /\.test\.mjs$|-check\.mjs$|\.itest\.mjs$|^wall-.*\.mjs$/.test(f));
    for (const f of shaped) if (!listed.has(`tools/${f}`)) errs.push(`tools/${f} is in no check — add it to tools/check-manifest.mjs`);
    return errs;
}
const manifestErrors = validate();
if (manifestErrors.length) { for (const e of manifestErrors) say(`MANIFEST  ${e}`); fatal(`MANIFEST  ${manifestErrors.length} error(s)`); }

// ── selection ────────────────────────────────────────────────────────────────────────────────
const tiers = TIER_SETS[TIER];
const byName = new Map(CHECKS.map((c) => [c.name, c]));
for (const p of positional) if (!SCOPES[p] && !byName.has(p)) {
    fatal(`'${p}' is neither a scope (${Object.keys(SCOPES).join(', ')}) nor a check name (--list shows them)`);
}
const scopes = positional.filter((p) => SCOPES[p]);
const named = positional.filter((p) => byName.has(p) && !SCOPES[p]);
const scoped = positional.length > 0;
// A named check runs whatever its tier; scopes filter within the tier.
const selected = CHECKS.filter((c) => named.includes(c.name)
    || (tiers.includes(c.tier) && (!scoped || (scopes.length && c.scope.some((s) => scopes.includes(s))))));
const scopeLabel = scoped ? positional.join(' ') : 'all scopes';

if (LIST) {
    for (const c of selected) {
        say(`${c.name.padEnd(32)} ${c.tier.padEnd(8)} [${c.scope.join(',')}]${c.needs?.length ? `  needs ${c.needs.join(',')}` : ''}${c.apart?.length ? `  apart ${c.apart.join(',')}` : ''}${c.known ? '  KNOWN RED' : ''}${c.report ? '  REPORT-ONLY' : ''}`);
        say(`    $ ${c.cmd.join(' ')}`);
        say(`    compares: ${c.compare}`);
        say(`    blind to: ${c.blind}`);
        if (c.known) say(`    known red: ${c.known.reason}`);
    }
    say(`\n${selected.length} checks (tier ${TIER}, ${scopeLabel})`);
    process.exit(0);
}

// ── services: what browser / gpu checks need, started and stopped here ──────────────────────
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(OUT, 'run', `${STAMP}-${process.pid}`);
/** @type {Array<() => Promise<void>|void>} */
const cleanups = [];
const notes = [];

function freePort() {
    return new Promise((res, rej) => {
        const s = net.createServer();
        s.unref();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => (RESERVED_PORTS.has(port) ? freePort().then(res, rej) : res(port)));
        });
    });
}
const listening = (port) => new Promise((res) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); res(true); });
    c.once('error', () => res(false));
});
async function waitFor(test, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await test()) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`${what}: not up after ${ms / 1000} s`);
}
function stopProc(p) {
    return new Promise((res) => {
        if (p.exitCode !== null || p.signalCode !== null) return res();
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
        p.once('exit', () => { clearTimeout(t); res(); });
        try { p.kill('SIGTERM'); } catch { clearTimeout(t); res(); }
    });
}

/** What this machine has, asked once per need (and only for needs a selected check has). */
const probes = {
    browser: async () => {
        try {
            const { chromium } = await import('playwright');
            const exe = chromium.executablePath();
            return existsSync(exe) ? null : `playwright's chromium is not installed (bunx playwright install chromium)`;
        } catch (e) { return `playwright unavailable: ${e.message}`; }
    },
    gpu: async () => {
        if (process.platform === 'darwin') return null;   // headed there (launchGpuBrowser)
        if (process.platform === 'linux') {
            const dri = existsSync('/dev/dri') && readdirSync('/dev/dri').some((f) => f.startsWith('renderD'));
            return dri ? null : 'no GPU render node (/dev/dri/renderD*)';
        }
        return `no GPU probe for ${process.platform}`;
    },
    termd: async () => (existsSync(termdBeside(CLI)) ? null : `no g3d-termd beside ${relative(ROOT, CLI) || CLI} (make build)`),
    network: async () => {
        try {
            const r = await fetch('https://api.github.com/', { method: 'HEAD', signal: AbortSignal.timeout(4000) });
            return r.status < 500 ? null : `github answered ${r.status}`;
        } catch (e) { return `no network to github (${e.message})`; }
    },
    relay: async () => {
        if (!existsSync(CLI)) return `no relay binary at ${relative(ROOT, CLI) || CLI} (make build, or --cli PATH)`;
        return probes.termd();
    },
    // A check that starts its own relay (tools/lib/wall-relay.mjs) needs the same binary and termd.
    'own-relay': async () => probes.relay(),
    vite: async () => (existsSync(join(ROOT, 'node_modules/.bin/vite')) ? null : 'no vite in node_modules (bun install)'),
    'wall-vite': async () => (existsSync(join(ROOT, 'node_modules/.bin/vite')) ? null : 'no vite in node_modules (bun install)'),
};

/** Start a Vite for `app` or `wall` on a free port, with its own cache dir; warm it in a browser. */
async function startVite(which) {
    const port = await freePort();
    mkdirSync(RUN_DIR, { recursive: true });
    const cfg = join(RUN_DIR, `vite.${which}.config.mjs`);
    writeFileSync(cfg, [
        `import base from ${JSON.stringify(join(ROOT, which, 'vite.config.js'))};`,
        `export default { ...base, root: ${JSON.stringify(join(ROOT, which))}, cacheDir: ${JSON.stringify(join(OUT, 'vite-cache', which))},`,
        `  clearScreen: false, server: { ...base.server, host: '127.0.0.1', port: ${port}, strictPort: true } };`,
    ].join('\n'));
    const log = [];
    const p = spawn(join(ROOT, 'node_modules/.bin/vite'), ['--config', cfg], { cwd: join(ROOT, which), stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => log.push(String(d)));
    p.stderr.on('data', (d) => log.push(String(d)));
    cleanups.push(() => stopProc(p));
    const url = `http://127.0.0.1:${port}/`;
    try {
        await waitFor(async () => {
            if (p.exitCode !== null) throw new Error(`vite (${which}) exited ${p.exitCode}: ${log.join('').slice(-400)}`);
            return listening(port);
        }, 30_000, `vite (${which})`);
        // Warm the transform cache once, so the first check doesn't pay the cold compile inside
        // its own boot timeout.
        const { chromium } = await import('playwright');
        const b = await chromium.launch({ headless: true });
        try {
            const page = await b.newPage();
            await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
            await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {});
        } finally { await b.close(); }
    } catch (e) { throw new Error(`${e.message}${log.length ? `\n${log.join('').slice(-600)}` : ''}`); }
    return url;
}

/** The fixture each private relay serves: the core's sources + one mixed emoji/tab/wide text. */
function buildFixture() {
    const fx = join(RUN_DIR, 'fixture');
    const src = join(ROOT, 'packages/glyph3d-core/src');
    cpSync(src, join(fx, 'src'), { recursive: true, filter: (p) => statSync(p).isDirectory() || /\.(js|jsx|mjs)$/.test(p) });
    mkdirSync(join(fx, 'mixed'), { recursive: true });
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(`${i}\tcol\t${'😀🧪'.repeat(i % 5)} ${'全角'.repeat(i % 7)} ${'x'.repeat((i * 7) % 90)}`);
    writeFileSync(join(fx, 'mixed/emoji_tabs_wide.txt'), rows.join('\n') + '\n');
    return fx;
}

let relaySeq = 0;
/** A private relay for one check: fresh root, its own port and termd namespace, no gomuxai. */
async function startRelay(fixture, name) {
    const port = await freePort();
    const tag = `${++relaySeq}`;
    const root = join(RUN_DIR, `root-${tag}-${name}`);
    cpSync(fixture, root, { recursive: true });
    // Short: the namespace's socket path must fit a sockaddr.
    const ns = `c${tag}`;
    const termd = privateTermd(`ck-${process.pid}`);
    const log = [];
    const p = spawn(CLI, ['serve', '--listen', '127.0.0.1', '--port', String(port), '--relay-only',
        '--termd-ns', ns, '--no-gomuxai', root], { cwd: RUN_DIR, env: termd.env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => log.push(String(d)));
    p.stderr.on('data', (d) => log.push(String(d)));
    const stop = async () => {
        await stopProc(p);
        // The daemon outlives its relay by design; this one goes with the check.
        await stopTermd(termd.dir, ns);
    };
    cleanups.push(stop);
    await waitFor(async () => {
        if (p.exitCode !== null) throw new Error(`relay exited ${p.exitCode}: ${log.join('').slice(-400)}`);
        return listening(port);
    }, 15_000, 'relay');
    return { port, root, dir: join(root, 'src'), stop, log };
}

// ── running one check ────────────────────────────────────────────────────────────────────────
const fill = (s, vars) => s.replace(/\{(url|wallUrl|relay|port|root|dir)\}/g, (_, k) => {
    if (vars[k] == null) throw new Error(`placeholder {${k}} has no value`);
    return String(vars[k]);
});
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const lastLine = (out) => stripAnsi(out).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

function keep(c, out, extra) {
    const dir = join(OUT, 'kept', `${STAMP}-${c.name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'output.txt'), out);
    writeFileSync(join(dir, 'check.json'), JSON.stringify({ name: c.name, tier: c.tier, ...extra }, null, 2));
    return relative(ROOT, dir);
}

async function runOne(c, svc) {
    const t0 = performance.now();
    const vars = { url: svc.url, wallUrl: svc.wallUrl };
    let relay = null;
    const out = [];
    try {
        if (c.needs?.includes('relay')) {
            relay = await startRelay(svc.fixture, c.name);
            Object.assign(vars, { relay: relay.port, root: relay.root, dir: relay.dir });
        }
        if (c.needs?.includes('own-relay')) vars.port = await freePort();
        const cmd = c.cmd.map((a) => fill(a, vars));
        const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
        for (const [k, v] of Object.entries(c.env ?? {})) env[k] = fill(v, vars);
        const timeout = c.timeoutMs ?? DEFAULT_TIMEOUT[c.tier];
        const r = await new Promise((res) => {
            const p = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
            p.stdout.on('data', (d) => out.push(String(d)));
            p.stderr.on('data', (d) => out.push(String(d)));
            let timedOut = false;
            const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
            p.on('error', (e) => { clearTimeout(t); res({ code: null, error: e.message }); });
            p.on('close', (code, sig) => { clearTimeout(t); res({ code, sig, timedOut }); });
        });
        const text = out.join('');
        const full = relay ? `${text}\n── relay log ──\n${relay.log.join('')}` : text;
        return { ...r, cmd, out: text, full, ms: Math.round(performance.now() - t0) };
    } catch (e) {
        return { code: null, error: e.message, cmd: c.cmd, out: out.join(''), full: out.join(''), ms: Math.round(performance.now() - t0) };
    } finally {
        if (relay) await relay.stop();
    }
}

/** Judge a finished check: pass | fail | known | report. */
function judge(c, r) {
    if (r.error) return { status: 'fail', why: r.error };
    if (r.timedOut) return { status: 'fail', why: `timed out after ${(c.timeoutMs ?? DEFAULT_TIMEOUT[c.tier]) / 1000} s` };
    if (c.report) {
        try { return { status: 'report', note: c.report(r.out) }; } catch (e) { return { status: 'fail', why: `report unreadable: ${e.message}` }; }
    }
    const ok = r.code === 0;
    if (c.known) {
        if (ok) return { status: 'fail', why: `known red now PASSES — remove its \`known\` entry (${c.known.reason})` };
        const missing = c.known.signature.filter((re) => !re.test(r.out));
        if (missing.length) return { status: 'fail', why: `failed, but NOT as known (no match for ${missing.join(', ')})` };
        return { status: 'known', why: c.known.reason };
    }
    return ok ? { status: 'pass' } : { status: 'fail', why: `exit ${r.code ?? r.sig}` };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = performance.now();
    mkdirSync(OUT, { recursive: true });
    const svc = {};
    const missing = new Map();   // need → why
    const wanted = new Set(selected.flatMap((c) => c.needs ?? []));
    for (const n of NEEDS) if (wanted.has(n)) { const why = await probes[n](); if (why) missing.set(n, why); }
    const runnable = (c) => (c.needs ?? []).every((n) => !missing.has(n));
    // Start the services only for checks that can otherwise run.
    const want = (n) => selected.some((c) => c.needs?.includes(n) && runnable(c));
    if (want('vite')) { try { svc.url = await startVite('app'); } catch (e) { missing.set('vite', `the app's Vite did not start: ${e.message.split('\n')[0]}`); } }
    if (want('wall-vite')) { try { svc.wallUrl = await startVite('wall'); } catch (e) { missing.set('wall-vite', `the wall's Vite did not start: ${e.message.split('\n')[0]}`); } }
    if (want('relay')) svc.fixture = buildFixture();

    const results = [];
    const skipped = [];
    const queue = [];
    for (const c of selected) {
        const why = (c.needs ?? []).filter((n) => missing.has(n)).map((n) => `${n}: ${missing.get(n)}`);
        if (why.length) { skipped.push({ c, why }); say(`SKIP  ${c.name}  — ${why.join('; ')}`); } else queue.push(c);
    }

    const print = (c, r, j) => {
        const secs = `${(r.ms / 1000).toFixed(1)} s`;
        if (j.status === 'pass') say(`PASS  ${c.name}  (${secs})  ${lastLine(r.out).slice(0, 110)}`);
        else if (j.status === 'report') say(`NOTE  ${c.name}: ${j.note}  (${secs})`);
        else if (j.status === 'known') say(`KNOWN ${c.name}  (${secs})  red as recorded: ${j.why}`);
        else {
            const kept = keep(c, r.full, { cmd: r.cmd, code: r.code, sig: r.sig, why: j.why, ms: r.ms });
            say(`FAIL  ${c.name}  (${secs}, ${j.why})  ${lastLine(r.out).slice(0, 110)}`);
            say(`      kept: ${kept}/output.txt`);
        }
    };

    // Schedule: at most JOBS at once; two checks sharing an `apart` token never overlap; '*' last, alone.
    const solo = queue.filter((c) => c.apart?.includes('*'));
    const pool = queue.filter((c) => !c.apart?.includes('*'));
    const running = new Set();
    const finish = (c, r) => { const j = judge(c, r); results.push({ c, r, j }); print(c, r, j); };
    await new Promise((resolveAll) => {
        const pump = () => {
            if (!pool.length && !running.size) return resolveAll();
            for (let i = 0; i < pool.length && running.size < JOBS; i++) {
                const c = pool[i];
                const clash = [...running].some((o) => (o.apart ?? []).some((t) => c.apart?.includes(t)));
                if (clash) continue;
                pool.splice(i--, 1);
                running.add(c);
                runOne(c, svc).then((r) => { running.delete(c); finish(c, r); pump(); });
            }
        };
        pump();
    });
    for (const c of solo) finish(c, await runOne(c, svc));

    for (const fn of cleanups.splice(0).reverse()) await fn();
    rmSync(RUN_DIR, { recursive: true, force: true });

    // ── summary ──
    const wall = performance.now() - t0;
    const ran = results.length;
    const failed = results.filter((x) => x.j.status === 'fail');
    const known = results.filter((x) => x.j.status === 'known');
    for (const s of skipped) notes.push(`skipped ${s.c.name}: ${s.why.join('; ')}`);
    for (const n of notes) say(`NOTE  ${n}`);
    const slow = [...results].sort((a, b) => b.r.ms - a.r.ms).slice(0, 5).map((x) => `${x.c.name} ${(x.r.ms / 1000).toFixed(1)}`);
    const sum = results.reduce((a, x) => a + x.r.ms, 0);
    say(`TIME  wall ${(wall / 1000).toFixed(1)} s at -j${JOBS}; checks summed ${(sum / 1000).toFixed(1)} s; slowest: ${slow.join(', ') || '—'}`);

    // Floors: an unscoped run of a tier must run at least its floor.
    const floors = existsSync(FLOORS_PATH) ? JSON.parse(readFileSync(FLOORS_PATH, 'utf8')) : {};
    const floor = scoped ? 0 : (floors[TIER] ?? 0);
    const label = named.length && !scopes.length ? `by name: ${named.join(' ')}` : `tier ${TIER}, ${scopeLabel}`;
    const knownNote = known.length ? ` · ${known.length} known red: ${known.map((x) => x.c.name).join(', ')}` : '';
    const skipNote = skipped.length ? ` · ${skipped.length} skipped` : '';
    let verdict, code;
    if (ran === 0) { verdict = `NOTHING RAN — not a pass (${selected.length} selected, ${label}${skipNote})`; code = 1; }
    else if (failed.length) { verdict = `RED — ${failed.length} failed: ${failed.map((x) => x.c.name).join(', ')} (${ran} of ${selected.length} ran, ${label}${knownNote}${skipNote})`; code = 1; }
    else if (ran < floor) { verdict = `RED — ${ran} ran, under the floor of ${floor} for tier ${TIER} (${selected.length} selected${skipNote}): checks went missing`; code = 1; }
    else { verdict = `ALL GREEN — ${ran} of ${selected.length} ran (${label})${knownNote}${skipNote}`; code = 0; }

    if (RATCHET) {
        if (scoped) say('NOTE  --ratchet ignored: a scoped run proves its scope, not the tier');
        else if (code !== 0) say('NOTE  --ratchet ignored: the run is not green');
        else if (ran > (floors[TIER] ?? 0)) {
            floors[TIER] = ran;
            writeFileSync(FLOORS_PATH, JSON.stringify(floors, null, 2) + '\n');
            say(`NOTE  floor for tier ${TIER} raised to ${ran} (${relative(ROOT, FLOORS_PATH)})`);
        } else say(`NOTE  floor for tier ${TIER} stays ${floors[TIER] ?? 0}`);
    }

    writeFileSync(join(OUT, 'last-run.json'), JSON.stringify({
        at: new Date().toISOString(), tier: TIER, scope: positional, jobs: JOBS, wallMs: Math.round(wall), floor, verdict,
        checks: results.map(({ c, r, j }) => ({ name: c.name, tier: c.tier, status: j.status, why: j.why ?? null, note: j.note ?? null, ms: r.ms, code: r.code ?? null, last: lastLine(r.out).slice(0, 200) })),
        skipped: skipped.map((s) => ({ name: s.c.name, why: s.why })),
    }, null, 1));
    say(verdict);
    process.exit(code);
}

const bail = async (sig) => {
    say(`\n${sig}: stopping the servers this run started`);
    for (const fn of cleanups.splice(0).reverse()) await fn();
    rmSync(RUN_DIR, { recursive: true, force: true });
    say('RED — interrupted');
    process.exit(130);
};
process.on('SIGINT', () => bail('SIGINT'));
process.on('SIGTERM', () => bail('SIGTERM'));

main().catch(async (e) => {
    say(`runner error: ${e.stack || e.message}`);
    for (const fn of cleanups.splice(0).reverse()) await fn();
    say('RED — the runner itself failed');
    process.exit(1);
});
