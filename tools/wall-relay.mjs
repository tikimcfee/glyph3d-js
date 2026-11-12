// wall-relay.mjs — the PRIVATE relay the wall's browser tools (wall-e2e, wall-gpu-attribution,
// wall-text-perf) run against, so they never touch a person's display or terminals:
//
//   const relay = await privateRelay({ port: 8099, socket: 'glyph-wall-e2e', reuse: argv.includes('--reuse-relay') });
//   …
//   await relay.restart();   // kill + start again on the same port and socket (its adapters die; sessions live)
//   await relay.stop();      // kill it and its tmux socket's server (a no-op for a reused relay)
//
// It starts `./glyph3d-cli serve --relay-only` on `port`, on its own tmux socket and without
// gomuxai, and verifies the listener it then finds is the one it started. Something already
// listening on `port` is refused — a relay takes one display, and a person's may be on it —
// unless `reuse` (the tool's --reuse-relay): then it says so, runs against that relay, and leaves
// it (and its socket) alone at the end. A relay it started is stopped, and its tmux server killed,
// on stop(), on process exit, and on SIGINT / SIGTERM.

import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

/**
 * @typedef {{ port: number, socket: string|null, started: boolean,
 *   restart: () => Promise<void>, stop: () => Promise<void> }} PrivateRelay
 */

/**
 * @param {{ port: number, socket: string, reuse?: boolean, root?: string }} o
 *   socket: the tmux socket (-L) its terminals live on — never the default `glyphd`
 *   root: the directory it serves (the wall reads no files; any directory does)
 * @returns {Promise<PrivateRelay>}
 */
export async function privateRelay({ port, socket, reuse = false, root = ROOT }) {
    if (!socket || socket === 'glyphd') throw new Error(`[wall-relay] a private relay needs its own tmux socket, not ${JSON.stringify(socket)}`);
    if (await listening(port)) {
        if (!reuse) {
            throw new Error(`[wall-relay] something already listens on :${port} — refusing to run against a relay this tool didn't start (a person's display may be on it). Pick a free --relay port, or pass --reuse-relay to run against a relay you started yourself.`);
        }
        console.log(`info  --reuse-relay: running against the relay already on :${port} — not started here, so not stopped (or its terminals' tmux server killed) here`);
        return { port, socket: null, started: false, restart: async () => { throw new Error('[wall-relay] can\'t restart a reused relay'); }, stop: async () => {} };
    }

    let child = null;
    let log = '';
    const start = async () => {
        log = '';
        child = spawn(BIN, ['serve', '--port', String(port), '--listen', '127.0.0.1', '--relay-only', '--tmux-socket', socket, '--no-gomuxai', root],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        const keep = (b) => { log += b; if (log.length > 64 * 1024) log = log.slice(-32 * 1024); };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const exited = new Promise((res) => child.once('exit', (code, sig) => res(`exited (${sig ?? code})`)));
        child.once('error', (e) => { log += `\nspawn error: ${e.message}`; });
        for (let i = 0; i < 60 && !(await listening(port)); i++) {
            if (child.exitCode != null || child.signalCode != null) break;
            await sleep(100);
        }
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
        await Promise.race([gone, sleep(3000)]);
        if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); await gone; }
    };
    /**
     * The tmux server on the private socket — and the socket file, which a server that exits (killed,
     * or its last session gone) can leave behind. Synchronous: it also runs on exit.
     */
    const killTmux = () => {
        spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
        const dir = path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);
        rmSync(path.join(dir, socket), { force: true });
    };

    await start();
    console.log(`info  started a private relay on :${port} (tmux socket ${socket}, no gomuxai)`);

    let stopped = false;
    const onExit = () => { if (stopped) return; stopped = true; child?.kill('SIGKILL'); killTmux(); };
    const onSignal = (sig) => { console.log(`\ninfo  ${sig}: stopping the private relay on :${port}`); onExit(); process.exit(130); };
    process.on('exit', onExit);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    return {
        port, socket, started: true,
        async restart() {
            await halt();
            for (let i = 0; i < 50 && (await listening(port)); i++) await sleep(100);
            await start();
        },
        async stop() {
            if (stopped) return;
            stopped = true;
            await halt();
            killTmux();
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
