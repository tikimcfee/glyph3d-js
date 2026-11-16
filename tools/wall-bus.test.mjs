// wall-bus.test.mjs — the wall's gomuxai agents (wall/WallBus.js): which agents a host lists and in
// what order, the target `agent attach` takes (name, or name@host), what's attachable, the program an
// attach terminal runs (run here in a real sh against a stand-in `agent`: a clean detach closes, a
// failed attach holds its reason until Enter, the target never lands inside the script), and the
// store's memory of which terminal attaches to which agent (forgotten and pruned like a name).
// Run: bun test tools/wall-bus.test.mjs
import { test, expect, beforeEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
const { busHosts, busTarget, isBusTarget, busAttachable, busStatus, attachArgv, default: WallBus } = await import('../wall/WallBus.js');
const { default: WallStore } = await import('../wall/WallStore.js');

beforeEach(() => mem.clear());

const agent = (name, o = {}) => ({ name, live: true, attached: true, status: 'idle', ...o });

test('a target is the name here, name@host on another host', () => {
    expect(busTarget(agent('helper'))).toBe('helper');
    expect(busTarget(agent('helper', { host: 'workstation' }))).toBe('helper@workstation');
    for (const ok of ['helper', 'tinybot-m2', 'a_b@workstation', 'X@laptop-2']) expect(isBusTarget(ok)).toBe(true);
    for (const bad of ['', '-x', 'a b', 'a@', '@h', 'a@b@c', 'a;rm', 'a.b', '$(x)', undefined]) expect(isBusTarget(bad)).toBe(false);
});

test('hosts: live agents only, this host first, then by name; waiting first within a host', () => {
    const hosts = busHosts({
        gen: 1, dirs: [],
        agents: [
            agent('zeta', { host: 'workstation', status: 'processing' }),
            agent('b', { status: 'idle' }),
            agent('a', { status: 'ended' }),
            agent('c', { status: 'waiting' }),
            agent('gone', { live: false }),
            agent('alpha', { host: 'aardvark' }),
            agent('d', { status: 'idle' }),
        ],
    });
    expect(hosts.map((h) => h.host)).toEqual(['', 'aardvark', 'workstation']);
    expect(hosts[0].agents.map((a) => a.name)).toEqual(['c', 'b', 'd', 'a']);
    expect(hosts[2].agents[0].target).toBe('zeta@workstation');
    expect(busHosts(null)).toEqual([]);
    // the relay names this machine (the snapshot's host) and its agents: it still lists first
    const named = busHosts({ gen: 1, host: 'workstation', dirs: [], agents: [
        agent('far', { host: 'aardvark' }), agent('here', { host: 'workstation' }), agent('far', { host: 'laptop', attached: undefined }),
    ] });
    expect(named.map((h) => h.host)).toEqual(['workstation', 'aardvark', 'laptop']);
    expect(named.map((h) => h.agents[0].target)).toEqual(['here@workstation', 'far@aardvark', 'far@laptop']);
});

test('attachable unless a host says the session is gone; an unknown status reads as unknown', () => {
    expect(busAttachable(agent('a'))).toBe(true);
    expect(busAttachable(agent('a', { attached: undefined }))).toBe(true);   // a far host that couldn't say
    expect(busAttachable(agent('a', { attached: false }))).toBe(false);
    expect(busStatus('nonsense').word).toBe('unknown');
    expect(busStatus(undefined).word).toBe('unknown');
});

test('WallBus keeps the tree, finds by target, and says why there is none', async () => {
    let changes = 0;
    const bus = new WallBus(() => changes++);
    let push = null;
    const bridge = {
        rpcRequest: async (m) => { if (m === 'gomux/list') return { gen: 2, dirs: [], agents: [agent('helper'), agent('far', { host: 'workstation' })] }; throw new Error('no'); },
        onRpcNotification: (fn) => { push = fn; return () => { push = null; }; },
    };
    bus.start(bridge);
    await bus.refresh();
    expect(bus.reason).toBe('');
    expect(bus.find('far@workstation')?.name).toBe('far');
    expect(bus.find('far')).toBeNull();
    push('gomux/changed', { gen: 3, dirs: [], agents: [agent('helper', { status: 'waiting' })] });
    expect(bus.find('helper').status).toBe('waiting');
    expect(bus.find('far@workstation')).toBeNull();
    const refusing = new WallBus(() => {});
    refusing.start({ rpcRequest: async () => { throw new Error('gomuxai watcher not running'); }, onRpcNotification: () => () => {} });
    await refusing.refresh();
    expect(refusing.snapshot).toBeNull();
    expect(refusing.reason).toBe('gomuxai watcher not running');
    bus.stop();
    expect(push).toBeNull();
    expect(changes).toBeGreaterThanOrEqual(3);
});

test('attachArgv refuses what is not an agent name', () => {
    expect(() => attachArgv('a b')).toThrow(/isn't an agent name/);
    expect(() => attachArgv('$(touch x)')).toThrow();
    const argv = attachArgv('helper@workstation');
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(argv[2]).not.toContain('helper');                 // the target rides as $1, never in the script
    expect(argv.at(-1)).toBe('helper@workstation');
});

test('the attach program: a clean detach exits, a failure holds its reason until Enter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wall-bus-'));
    try {
        const log = join(dir, 'args');
        // A stand-in `agent`: records its args, exits with $AGENT_EXIT.
        writeFileSync(join(dir, 'agent'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nexit "\${AGENT_EXIT:-0}"\n`);
        chmodSync(join(dir, 'agent'), 0o755);
        const run = (exit, input) => {
            const [cmd, ...args] = attachArgv('helper@workstation');
            return spawnSync(cmd, args, { env: { PATH: `${dir}:/usr/bin:/bin`, AGENT_EXIT: String(exit) }, input, encoding: 'utf8', timeout: 5000 });
        };
        const ok = run(0, '');
        expect(ok.status).toBe(0);
        expect(ok.stdout).toBe('');
        expect(readFileSync(log, 'utf8')).toBe('attach\nhelper@workstation\n');
        const failed = run(1, '\n');
        expect(failed.status).toBe(0);                       // Enter closes it
        expect(failed.stdout).toContain('[agent attach helper@workstation ended with status 1. Press Enter to close.]');
        // termd's PATH lacks `agent`: the login shell's PATH (here a stand-in $SHELL that knows dir) finds it.
        const bin = mkdtempSync(join(tmpdir(), 'wall-bus-sh-'));
        try {
            writeFileSync(join(bin, 'login-sh'), `#!/bin/sh\n[ "$1" = -lc ] && printf %s "${dir}:/usr/bin:/bin"\n`);
            chmodSync(join(bin, 'login-sh'), 0o755);
            rmSync(log, { force: true });
            const [cmd, ...args] = attachArgv('helper');
            const viaLogin = spawnSync(cmd, args, { env: { PATH: '/usr/bin:/bin', SHELL: join(bin, 'login-sh') }, input: '', encoding: 'utf8', timeout: 5000 });
            expect(viaLogin.status).toBe(0);
            expect(readFileSync(log, 'utf8')).toBe('attach\nhelper\n');
        } finally { rmSync(bin, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the store remembers which terminal attaches to which agent, per relay, and forgets it with the terminal', () => {
    const s = new WallStore(8099);
    s.setAttached('term-1', 'helper');
    s.setAttached('term-2', 'far@workstation');
    expect(new WallStore(8099).attached('term-2')).toBe('far@workstation');
    expect(new WallStore(8093).attached('term-2')).toBeNull();
    expect(s.attachedTo('helper')).toEqual(['term-1']);
    s.forget('term-1');
    expect(s.attached('term-1')).toBeNull();
    expect(s.prune(new Set())).toEqual(['term-2']);           // a gone session takes its attach with it
    expect(new WallStore(8099).attachedTo('far@workstation')).toEqual([]);
});
