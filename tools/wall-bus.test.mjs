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
const { busHosts, busTarget, localBusName, gomuxScreenId, isBusTarget, busAttachable, busStatus, attachArgv, default: WallBus } = await import('../wall/WallBus.js');
const { default: WallStore } = await import('../wall/WallStore.js');
globalThis.location ??= /** @type {any} */ ({ hostname: 'localhost', origin: 'http://localhost:5180' });
const { default: TerminalWall } = await import('../wall/TerminalWall.js');

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

test('the attach program: a clean detach exits; a failure takes the terminal back, holds its reason, and Enter attaches again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wall-bus-'));
    try {
        const log = join(dir, 'args');
        // A stand-in `agent`: records its args (one run after another), exits with $AGENT_EXIT.
        writeFileSync(join(dir, 'agent'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\nexit "\${AGENT_EXIT:-0}"\n`);
        chmodSync(join(dir, 'agent'), 0o755);
        const run = (exit, input) => {
            rmSync(log, { force: true });
            const [cmd, ...args] = attachArgv('helper@workstation');
            return spawnSync(cmd, args, { env: { PATH: `${dir}:/usr/bin:/bin`, AGENT_EXIT: String(exit) }, input, encoding: 'utf8', timeout: 5000 });
        };
        const ok = run(0, '');
        expect(ok.status).toBe(0);
        expect(ok.stdout).toBe('');
        expect(readFileSync(log, 'utf8')).toBe('attach\nhelper@workstation\n');
        const reason = '[agent attach helper@workstation ended with status 255. Enter attaches again; q then Enter closes.]';
        const closed = run(255, 'q\n');
        expect(closed.status).toBe(0);                       // q closes it
        expect(closed.stdout.split(reason).length - 1).toBe(1);
        expect(readFileSync(log, 'utf8')).toBe('attach\nhelper@workstation\n');
        // The dead client's modes are switched off BEFORE the reason: mouse reporting, focus, bracketed paste, the alternate screen; the cursor shown.
        const before = closed.stdout.slice(0, closed.stdout.indexOf(reason));
        for (const off of ['?1000l', '?1002l', '?1003l', '?1006l', '?1004l', '?2004l', '?1049l', '?25h']) expect(before).toContain(`\x1b[${off}`);
        // Enter attaches again (here it fails again); the end of input closes.
        const again = run(1, '\n');
        expect(again.status).toBe(0);
        expect(readFileSync(log, 'utf8')).toBe('attach\nhelper@workstation\nattach\nhelper@workstation\n');
        expect(again.stdout.split('ended with status 1.').length - 1).toBe(2);
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

test('localBusName and WallBus.find distinguish local termd agents from remote ssh targets', async () => {
    const snap = { gen: 1, host: 'IL-Air-M2', dirs: [], agents: [
        agent('wall-m2-agy', { host: 'IL-Air-M2', session: 'agent-wall-m2-agy', namespace: 'agents' }),
        agent('glyph3d-lead', { host: 'monolith1', session: 'agent-glyph3d-lead' }),
    ] };
    expect(localBusName('wall-m2-agy', snap)).toBe('wall-m2-agy');
    expect(localBusName('wall-m2-agy@IL-Air-M2', snap)).toBe('wall-m2-agy');
    expect(localBusName('glyph3d-lead@monolith1', snap)).toBeNull();
    expect(localBusName('glyph3d-lead@monolith1', null)).toBeNull();
    expect(gomuxScreenId('wall-m2-agy')).toBe('gx-wall-m2-agy');

    const bus = new WallBus(() => {});
    bus.start({ rpcRequest: async () => snap, onRpcNotification: () => () => {} });
    await bus.refresh();
    expect(bus.find('wall-m2-agy')?.name).toBe('wall-m2-agy');
    expect(bus.find('wall-m2-agy@IL-Air-M2')?.name).toBe('wall-m2-agy');
    expect(bus.find('glyph3d-lead@monolith1')?.name).toBe('glyph3d-lead');
    expect(bus.find('glyph3d-lead')).toBeNull();
});

test('TerminalWall.attach subscribes local agents directly via gomux.attach (gx-<name>), keeps ssh wrapper for remote hosts, and re-attaches live gx-* on relay restart', async () => {
    const cam = { isOrthographicCamera: true, zoom: 6, position: { x: 0, y: 0, z: 500 }, updateProjectionMatrix() {} };
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) };
    const regListeners = new Set();
    const regMap = new Map();
    const registry = {
        get: (id) => regMap.get(id),
        register: (id, grid, meta) => { regMap.set(id, { grid, meta }); for (const fn of regListeners) fn(); },
        addChangeListener: (fn) => regListeners.add(fn),
        removeChangeListener: (fn) => regListeners.delete(fn),
    };
    const w = new TerminalWall({ scene: {}, camera: /** @type {any} */ (cam), gl: { domElement: canvas }, atlas: null, registry, relayPort: 8095 });
    w.viewport.setView(1200, 800);
    w.names = /** @type {any} */ ({ attach() {}, prune() {}, barHeight: () => 2, setBarRoom() {} });
    w.groups = /** @type {any} */ ({ groupOf: () => null, ids: () => [], relayoutOf() {}, relayoutAll() {}, setDepths() {} });

    const mkGrid = (id) => ({
        terminalId: id, cols: 120, rows: 40, visible: true, hasSelection: false,
        position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        scale: { x: 2, y: 2, z: 2 },
        cellStride: { x: 1.2, y: 2.4 },
        readText: () => [],
        getLocalBounds() { return { min: { x: 0, y: -(this.rows * 1.2 + 0.6) }, max: { x: this.cols * 0.6 + 0.6, y: 0 } }; },
        setBorder() {}, setBorderFlag() {}, setControlVisible() {}, setCursorFocused() {},
        onResize() {}, onWindowTitle() {},
    });

    const sent = [];
    const waiters = new Map();
    let snap = {
        gen: 1, host: 'IL-Air-M2', dirs: [],
        agents: [
            agent('local-agy', { host: 'IL-Air-M2', session: 'agent-local-agy', namespace: 'agents', sessionId: 'sid-local' }),
            agent('dead-agy', { host: 'IL-Air-M2', attached: false, status: 'ended', endReason: 'gone' }),
            agent('remote-agy', { host: 'monolith1', session: 'agent-remote-agy' }),
        ],
    };
    w.bridge = /** @type {any} */ ({
        connected: true,
        send(raw) {
            const m = JSON.parse(raw);
            sent.push(m);
            if (m.relay === 'gomux.attach') {
                const id = `gx-${m.name}`;
                const g = mkGrid(id);
                w.ctx.terminalHost.place(/** @type {any} */ (g));
                w.ctx.terminals.set(id, /** @type {any} */ (g));
                registry.register(id, g, { type: 'terminal' });
                w._syncTerminals();
                waiters.get('gomux.attaching')?.({ event: 'gomux.attaching', name: m.name, id });
            }
        },
        waitForEvent(ev) {
            return new Promise((resolve) => waiters.set(ev, resolve));
        },
        rpcRequest: async (method) => { if (method === 'gomux/list') return snap; throw new Error(method); },
        onRpcNotification: () => () => {},
    });
    w.bus.start(w.bridge);
    await w.bus.refresh();

    // Remote spawn stub for `terminal.spawn -- sh -c ...`
    const spawnedArgv = [];
    w.router.register('terminal.spawn', (args) => {
        spawnedArgv.push(args);
        const id = 'term-remote-1';
        const g = mkGrid(id);
        w.ctx.terminalHost.place(/** @type {any} */ (g));
        w.ctx.terminals.set(id, /** @type {any} */ (g));
        w._syncTerminals();
        w.ctx.terminalHost.landed(id);
        return { text: 'OK', data: { id, landed: 'focused + framed' } };
    });

    // 1. Local agent attaches directly via `gomux.attach` as `gx-local-agy` (never `terminal.spawn`).
    const rLocal = await w.attach('local-agy');
    expect(rLocal).toEqual({ id: 'gx-local-agy', existing: false });
    expect(sent).toEqual([{ relay: 'gomux.attach', name: 'local-agy' }]);
    expect(spawnedArgv.length).toBe(0);
    expect(w.store.attached('gx-local-agy')).toBe('local-agy@IL-Air-M2');
    // Attaching again by full `name@host` reveals the already-open `gx-local-agy` grid.
    expect(await w.attach('local-agy@IL-Air-M2')).toEqual({ id: 'gx-local-agy', existing: true });

    // 2. Ended local agent without a session is refused cleanly.
    await expect(w.attach('dead-agy@IL-Air-M2')).rejects.toThrow(/has no live session to attach to/);

    // 3. Remote agent (`name@monolith1`) spawns a `wall` terminal running `attachArgv` (`ssh -t`).
    const rRemote = await w.attach('remote-agy@monolith1');
    expect(rRemote).toEqual({ id: 'term-remote-1', existing: false });
    expect(spawnedArgv.length).toBe(1);
    expect(spawnedArgv[0].at(-1)).toBe('remote-agy@monolith1');

    // 4. Relay restart (`_recover`): `gx-local-agy` is NOT in wall's `r.live`, yet stays preserved and re-attaches!
    const savedPos = { ...w.store.position('gx-local-agy') };
    w.ctx.terminals.clear();
    regMap.clear();
    sent.length = 0;
    w.bridge.send = (raw) => {
        const m = JSON.parse(raw);
        sent.push(m);
        if (m.relay === 'terminal.recover') {
            queueMicrotask(() => waiters.get('terminal.recovered')?.({ event: 'terminal.recovered', live: ['term-remote-1'] }));
        }
    };
    await w._recover(w.bus.refresh());
    expect(w.store.position('gx-local-agy')).toEqual(savedPos);
    expect(sent).toContainEqual({ relay: 'gomux.attach', name: 'local-agy' });

    // 5. Once `local-agy` ends (`attached: false`), `_recover` prunes `gx-local-agy` cleanly.
    snap = {
        ...snap, gen: 2,
        agents: [agent('local-agy', { host: 'IL-Air-M2', attached: false, status: 'ended', endReason: 'quit' })],
    };
    sent.length = 0;
    await w._recover(w.bus.refresh());
    expect(w.store.position('gx-local-agy')).toBeNull();
    expect(w.store.attached('gx-local-agy')).toBeNull();
});
