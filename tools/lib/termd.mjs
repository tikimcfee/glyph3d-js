// termd.mjs — the private termd namespace a test relay's terminals live in, and stopping its
// daemon. A relay starts `g3d-termd` for its namespace on the first terminal it needs, and the
// daemon outlives the relay on purpose (that is how terminals survive a relay restart), so a tool
// that started a relay must stop the relay's daemon too — or its shells stay behind.
//
//   const t = privateTermd('ck-123');          // { dir, env } — pass t.env to the relay
//   …serve --termd-ns <ns> …                   // the relay and its adapters use dir/termd-<ns>.sock
//   await stopTermd(t.dir, ns);                // SIGTERM: termd kills every terminal, then exits
//
// The socket lives in $G3D_TEST_RUN_DIR/<tag> (or out/termd/<tag>), never in a person's
// runtime dir, so a test can't reach a live namespace even by name.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A scratch directory for a tool's daemons (G3D_TERMD_DIR: sockets, locks, logs). A terminal whose
 * creator sends no environment takes the session's names from the tool's own start values
 * (G3D_TERMD_ENV_SOURCE=daemon), never the desktop session's; and no termd.toml but the
 * directory's own (G3D_TERMD_CONFIG, absent unless a tool writes it), never the person's.
 * @param {string} tag @returns {{ dir: string, env: NodeJS.ProcessEnv }}
 */
export function privateTermd(tag) {
    const base = process.env.G3D_TEST_RUN_DIR || path.join(ROOT, 'out', 'termd');
    const dir = path.join(base, tag);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { dir, env: { ...process.env, G3D_TERMD_DIR: dir, G3D_TERMD_ENV_SOURCE: 'daemon', G3D_TERMD_CONFIG: path.join(dir, 'termd.toml') } };
}

/** The g3d-termd built beside a relay binary. @param {string} cli */
export const termdBeside = (cli) => path.join(path.dirname(cli), 'g3d-termd');

/** The g3d client built beside a relay binary. @param {string} cli */
export const g3dBeside = (cli) => path.join(path.dirname(cli), 'g3d');

/**
 * The pid of the daemon serving `ns` in `dir` — its holder, the shells' parent — from its lock
 * file, only if that pid is still a g3d-termd (a pid is reused once its process is gone).
 * @param {string} dir @param {string} ns @returns {number|null}
 */
export function termdPid(dir, ns) {
    let pid;
    try { pid = Number(readFileSync(path.join(dir, `termd-${ns}.sock.lock`), 'utf8').trim()); } catch { return null; }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }
    if (existsSync('/proc')) {
        try {
            if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('g3d-termd')) return null;
        } catch { return null; }
    }
    return pid;
}

/**
 * The pid of the namespace's brain: the holder's child running `g3d-termd --brain` (the holder
 * restarts it after a crash, so ask again after one).
 * @param {string} dir @param {string} ns @returns {number|null}
 */
export function brainPid(dir, ns) {
    const holder = termdPid(dir, ns);
    if (!holder) return null;
    const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    for (const line of ps.split('\n')) {
        const [pid, ppid, ...args] = line.trim().split(/\s+/);
        if (Number(ppid) === holder && args.includes('--brain') && !args.includes('--candidate')) return Number(pid);
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stops a namespace's daemon (every terminal in it dies) and waits for its holder to go; SIGKILL
 * after 5 s.
 * @param {string} dir @param {string} ns @returns {Promise<boolean>} whether a daemon was running
 */
export async function stopTermd(dir, ns) {
    const pid = termdPid(dir, ns);
    if (!pid) return false;
    try { process.kill(pid, 'SIGTERM'); } catch { return false; }
    for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { return true; }
        await sleep(50);
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    return true;
}

/** The same, for an exit handler: signal and don't wait. @param {string} dir @param {string} ns */
export function stopTermdSync(dir, ns) {
    const pid = termdPid(dir, ns);
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}
