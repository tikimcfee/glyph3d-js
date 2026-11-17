// wall-relay.mjs — the PRIVATE relay the wall's browser tools (wall-e2e, wall-gpu-attribution,
// wall-text-perf) run against, so they never touch a person's display or terminals:
//
//   const relay = await privateRelay({ port: 8099, ns: 'glyph-wall-e2e', reuse: argv.includes('--reuse-relay') });
//   …
//   await relay.restart();   // kill + start again on the same port and namespace (its adapters die; terminals live)
//   await relay.stop();      // kill it and its termd daemon (a no-op for a reused relay)
//
// It starts `./glyph3d-cli serve --relay-only` on `port`, in its own termd namespace (in a scratch
// G3D_TERMD_DIR, tools/lib/termd.mjs) and without gomuxai, and verifies the listener it then finds
// is the one it started. Something already listening on `port` is refused — a relay takes one
// display, and a person's may be on it — unless `reuse` (the tool's --reuse-relay): then it says
// so, runs against that relay, and leaves it (and its terminals) alone at the end. A relay it
// started is stopped, and its termd daemon with it, on stop(), on process exit, and on SIGINT /
// SIGTERM.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateTermd, stopTermd, stopTermdSync } from './termd.mjs';
import { readRelayToken } from './relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'glyph3d-cli');

/** @param {number} port @param {string} host @returns {Promise<boolean>} */
function accepts(port, host) {
    return new Promise((res) => {
        const s = net.connect(port, host, () => { s.end(); res(true); });
        s.on('error', () => res(false));
    });
}

/**
 * Something accepts connections on the port, on either loopback: the page dials `localhost`, which
 * may reach ::1 before 127.0.0.1 (Vite, for one, listens on ::1 only).
 * @param {number} port @returns {Promise<boolean>}
 */
export async function listening(port) {
    const [v4, v6] = await Promise.all([accepts(port, '127.0.0.1'), accepts(port, '::1')]);
    return v4 || v6;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a started relay may take to log its listener before start gives up on it (a failure bound). */
const BIND_MS = 10_000;
/** How long a stopped relay may take to exit on SIGTERM before it is SIGKILLed (a failure bound). */
const EXIT_MS = 3000;

/**
 * @typedef {{ port: number, ns: string|null, termdDir: string|null, started: boolean, token: () => string|null, log: () => string,
 *   logged: (re: RegExp, ms?: number) => Promise<boolean>,
 *   restart: () => Promise<void>, stop: () => Promise<void> }} PrivateRelay
 */

/**
 * @param {{ port: number, ns: string, reuse?: boolean, root?: string, origins?: string[] }} o
 *   ns: the termd namespace its terminals live in (in a scratch dir of its own)
 *   root: the directory it serves (the wall reads no files; any directory does)
 *   origins: extra browser Origins allowed to upgrade (besides `--url` in argv and default Vite ports)
 * @returns {Promise<PrivateRelay>}
 */
export async function privateRelay({ port, ns, reuse = false, root = ROOT, origins = [] }) {
    if (!ns || ns === 'default') throw new Error(`[wall-relay] a private relay needs its own termd namespace, not ${JSON.stringify(ns)}`);
    if (await listening(port)) {
        if (!reuse) {
            throw new Error(`[wall-relay] something already listens on :${port} — refusing to run against a relay this tool didn't start (a person's display may be on it). Pick a free --relay port, or pass --reuse-relay to run against a relay you started yourself.`);
        }
        console.log(`info  --reuse-relay: running against the relay already on :${port} — not started here, so not stopped (or its terminals killed) here`);
        return { port, ns: null, termdDir: null, started: false, token: () => readRelayToken(port), log: () => '', logged: async () => false, restart: async () => { throw new Error('[wall-relay] can\'t restart a reused relay'); }, stop: async () => {} };
    }

    const originSet = new Set(origins);
    const urlIdx = process.argv.indexOf('--url');
    if (urlIdx >= 0 && process.argv[urlIdx + 1]) {
        try { originSet.add(new URL(process.argv[urlIdx + 1]).origin); } catch { /* ignore */ }
    }
    const originArgs = [...originSet].flatMap((o) => ['--origin', o]);

    const termd = privateTermd(`w${process.pid}`); // short: the socket path must fit a sockaddr
    let child = null;
    let log = '';
    /** Who waits for a line in the log (logged). @type {Set<{re: RegExp, done: (v: boolean) => void, bound: any}>} */
    const watchers = new Set();
    const start = async () => {
        log = '';
        child = spawn(BIN, ['serve', '--port', String(port), '--listen', '127.0.0.1', ...originArgs, '--relay-only', '--termd-ns', ns, '--no-gomuxai', root],
            { env: termd.env, stdio: ['ignore', 'pipe', 'pipe'] });
        // The relay logs `[serve] listening on <addr>` once its socket is bound: that line, or its
        // exit, is what start waits for (BIND_MS only bounds a relay that does neither).
        let bound = null;
        const ready = new Promise((res) => { bound = res; });
        const keep = (b) => {
            log += b;
            if (/\[serve\] listening on /.test(log)) bound('listening');
            if (log.length > 64 * 1024) log = log.slice(-32 * 1024);
            for (const w of [...watchers]) if (w.re.test(log)) { watchers.delete(w); clearTimeout(w.bound); w.done(true); }
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const exited = new Promise((res) => child.once('exit', (code, sig) => res(`exited (${sig ?? code})`)));
        child.once('error', (e) => { log += `\nspawn error: ${e.message}`; });
        let bounded = null;
        await Promise.race([ready, exited, new Promise((res) => { bounded = setTimeout(res, BIND_MS); })]);
        clearTimeout(bounded);
        // Ours, verified: the port answers, the relay we started is still running, and it bound the
        // port on its first try (a relay that found the port taken logs that it's waiting for it).
        const alive = child.exitCode == null && child.signalCode == null;
        if (!(await listening(port)) || !alive || /in use/.test(log)) {
            child.kill('SIGKILL');
            throw new Error(`[wall-relay] the relay started on :${port} isn't the one answering (${alive ? 'running' : await exited}${/in use/.test(log) ? ', port was taken' : ''}; is ./glyph3d-cli built?)\n${log.trim().split('\n').slice(-8).join('\n')}`);
        }
    };
    const halt = async () => {
        if (!child || child.exitCode != null || child.signalCode != null) return;
        const gone = new Promise((res) => child.once('exit', res));
        child.kill('SIGTERM');
        await Promise.race([gone, sleep(EXIT_MS)]);
        if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); await gone; }
    };
    await start();
    console.log(`info  started a private relay on :${port} (termd namespace ${ns} in ${termd.dir}, no gomuxai)`);

    let stopped = false;
    const onExit = () => { if (stopped) return; stopped = true; child?.kill('SIGKILL'); stopTermdSync(termd.dir, ns); };
    const onSignal = (sig) => { console.log(`\ninfo  ${sig}: stopping the private relay on :${port}`); onExit(); process.exit(130); };
    process.on('exit', onExit);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    return {
        port, ns, termdDir: termd.dir, started: true,
        token: () => readRelayToken(port, termd.env),
        /** The relay's log so far (its last 32–64 KB), for a failure to show. */
        log: () => log,
        /**
         * Resolves true once the relay's log (its adapters' lines included: they share its stderr)
         * holds a match for `re` — at once if it already does — or false after `ms` (a failure bound).
         * @param {RegExp} re @param {number} [ms]
         */
        logged(re, ms = 15000) {
            if (re.test(log)) return Promise.resolve(true);
            return new Promise((done) => {
                const w = { re, done, bound: null };
                w.bound = setTimeout(() => { if (watchers.delete(w)) done(false); }, ms);
                watchers.add(w);
            });
        },
        async restart() {
            await halt();   // its exit closed its listener (Go opens every fd close-on-exec: no child holds it)
            await start();
        },
        async stop() {
            if (stopped) return;
            stopped = true;
            await halt();
            await stopTermd(termd.dir, ns);
            process.off('exit', onExit);
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        },
    };
}

/**
 * Spawn `n` terminals of the tool's own on the wall page — the only terminals a tool may type into.
 * @param {(fn: Function, a?: any) => Promise<any>} evalPage
 * @param {number} n
 * @returns {Promise<string[]>} their ids
 */
export async function spawnOwnTerminals(evalPage, n) {
    const ids = [];
    for (let i = 0; i < n; i++) {
        const r = await evalPage(() => window.__wall.spawn());
        if (!r.ok) throw new Error(`[wall-relay] spawn ${i + 1}/${n} failed: ${r.reason}`);
        ids.push(r.id);
    }
    return ids;
}
