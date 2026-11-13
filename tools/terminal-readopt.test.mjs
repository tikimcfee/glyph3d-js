// terminal-readopt.test.mjs — a terminal.create for a grid the display already shows RE-ADOPTS it.
//
// After a relay restart the page keeps its grids, the relay forks fresh adapters, and their
// controller ids start over: the adapter that now owns `term-3` may be `ctrl-1`, and the old owner's
// id is dead or belongs to some other adapter (which drops a terminalId that isn't its own). So the
// re-create must hand the grid to its sender: the registry's owner, the grid's input route (and so
// resize / scroll / kill, which read the owner), and a repaint push to the new adapter. A local
// create (no sender) leaves the owner alone.
//
// Real core verbs (services/terminal), a real TerminalGrid, SceneRegistry, CommandRouter and
// WebSocketBridge — the bridge's socket replaced by a capture of what it pushes.
//
//   bun test tools/terminal-readopt.test.mjs

import { test, expect } from 'bun:test';

// WebSocketBridge + ErrorTracker touch `window` at import/construct time — stub before importing.
globalThis.window ??= { location: { hostname: 'localhost' }, addEventListener() {}, removeEventListener() {} };
await import('./headless-canvas.mjs');
const { HEADLESS_ATLAS } = await import('./headless-atlas.mjs');
const THREE = await import('three');
const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
const { default: WebSocketBridge } = await import('../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js');
const { default: SceneRegistry } = await import('../packages/glyph3d-core/src/services/SceneRegistry.js');
const { default: registerTerminalCommands } = await import('../packages/glyph3d-core/src/services/terminal/terminalCommands.js');
const { assertTerminalHost } = await import('../packages/glyph3d-core/src/services/terminal/TerminalHost.js');

function setup() {
    const terminalHost = assertTerminalHost({
        theme: () => ({}), place: () => {}, landed: () => 'landed', focus: () => ({ ok: true }),
        release: () => {}, resizing: () => '',
        surfaces: { get: () => null, set: () => {}, remove: () => {} },
    }, 'readopt-test');
    const ctx = { scene: new THREE.Scene(), atlas: HEADLESS_ATLAS, registry: new SceneRegistry(), terminals: new Map(), terminalHost };
    const router = new CommandRouter(ctx);
    registerTerminalCommands(router);
    const bridge = new WebSocketBridge(router, { autoConnect: false, showStatus: false });
    bridge.connected = true;
    const pushed = [];
    bridge.ws = { send: (raw) => pushed.push(JSON.parse(raw)) };
    ctx.wsbridge = bridge;
    return { ctx, router, pushed };
}

test('a re-create from a new adapter takes the grid: owner, input, repaint, resize, kill', async () => {
    const { ctx, router, pushed } = setup();
    await router.execute('terminal.create term-3 20 6', { sender: 'ctrl-7' });
    const grid = ctx.terminals.get('term-3');
    expect(ctx.registry.get('term-3').meta.owner).toBe('ctrl-7');

    // The relay restarts; the re-forked adapter for term-3 connects as ctrl-1.
    pushed.length = 0;
    const r = await router.execute('terminal.create term-3 20 6', { sender: 'ctrl-1' });
    expect(r.data).toMatchObject({ id: 'term-3', existed: true, owner: 'ctrl-1' });
    expect(ctx.terminals.get('term-3')).toBe(grid);                  // the same grid, not a rebuild
    expect(ctx.registry.get('term-3').meta.owner).toBe('ctrl-1');
    expect(ctx.registry.findByMeta('owner', 'ctrl-7')).toHaveLength(0);
    expect(ctx.registry.findByMeta('owner', 'ctrl-1').map((e) => e.id)).toEqual(['term-3']);
    expect(pushed).toEqual([{ to: 'ctrl-1', event: 'terminal.refresh', data: { terminalId: 'term-3' } }]);

    pushed.length = 0;
    grid.sendInput('ls\r');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ to: 'ctrl-1', event: 'terminal.bytes', data: { terminalId: 'term-3' } });
    expect(Buffer.from(pushed[0].data.b64, 'base64').toString()).toBe('ls\r');

    // A key event and a paste ride their own pushes to the same owner, for termd to encode.
    pushed.length = 0;
    grid.sendKey({ code: 'Enter', key: 'Enter', mods: ['Shift'], text: '', action: 'press' });
    grid.paste('one\ntwo');
    expect(pushed).toEqual([
        { to: 'ctrl-1', event: 'terminal.key', data: { terminalId: 'term-3', code: 'Enter', key: 'Enter', mods: ['Shift'], text: '', action: 'press' } },
        { to: 'ctrl-1', event: 'terminal.paste', data: { terminalId: 'term-3', text: 'one\ntwo' } },
    ]);

    pushed.length = 0;
    await router.execute('terminal.resize term-3 30 8');
    await router.execute('terminal.kill term-3');
    expect(pushed.map((p) => `${p.to} ${p.event}`)).toEqual(['ctrl-1 terminal.resize', 'ctrl-1 terminal.shutdown']);
});

test('a local re-create (no sender) keeps the owner and its input route', async () => {
    const { ctx, router, pushed } = setup();
    await router.execute('terminal.create term-4 20 6', { sender: 'ctrl-2' });
    const r = await router.execute('terminal.create term-4 20 6');
    expect(r.data).toEqual({ id: 'term-4', existed: true });
    expect(ctx.registry.get('term-4').meta.owner).toBe('ctrl-2');
    pushed.length = 0;
    ctx.terminals.get('term-4').sendInput('x');
    expect(pushed[0]).toMatchObject({ to: 'ctrl-2', event: 'terminal.bytes' });
});
