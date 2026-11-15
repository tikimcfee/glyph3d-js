// wall-mouse.test.mjs — the pointer for a program that hears the mouse, headless.
//
// Core: a real TerminalGrid's cells under a point (the slot geometry computeCellGridLayout lays out:
// a slot's position is its cell's LEFT edge and vertical CENTRE), the tracking its emulator reads
// off the program's DECSETs, and the verbs that carry the pointer to the adapter: terminal.mouse
// (→ a `terminal.mouse` push, termd's `mouse` op as is) and terminal.scroll with the pointer's cell.
// The wall: who a press belongs to (WallMouse.programGets: the FOCUSED body of a reporting program,
// no Shift, no Alt on the left button) and, on a stand-in wall, what WallPointer + WallMouse send —
// a click's press and release at its cell, a drag once per cell and only when the program tracks
// drags, chorded buttons, a drag that leaves the terminal clamped to its edge until the release, a
// cancel releasing what is held, any-event hover once per cell, an unfocused terminal's click
// focusing it and sending nothing, Shift keeping the wall's, a double-click the program's, and the
// wheel's terminal.scroll carrying the pointer's cell.
//
//   bun test tools/wall-mouse.test.mjs

import { test, expect } from 'bun:test';

globalThis.window ??= { location: { hostname: 'localhost' }, addEventListener() {}, removeEventListener() {} };
await import('./headless-canvas.mjs');
const { HEADLESS_ATLAS } = await import('./headless-atlas.mjs');
const THREE = await import('three');
const { default: CommandRouter } = await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
const { default: WebSocketBridge } = await import('../packages/glyph3d-core/src/services/orchestration/WebSocketBridge.js');
const { default: SceneRegistry } = await import('../packages/glyph3d-core/src/services/SceneRegistry.js');
const { default: registerTerminalCommands } = await import('../packages/glyph3d-core/src/services/terminal/terminalCommands.js');
const { assertTerminalHost } = await import('../packages/glyph3d-core/src/services/terminal/TerminalHost.js');
const { computeCellGridLayout, cellAtPoint } = await import('../packages/glyph3d-core/src/collections/grid/GridBackground.js');
const { default: WallPointer } = await import('../wall/WallPointer.js');
const { programGets, buttonOf, heldButton, modsOf } = await import('../wall/WallMouse.js');

function setup() {
    const terminalHost = assertTerminalHost({
        theme: () => ({}), place: () => {}, landed: () => 'landed', focus: () => ({ ok: true }),
        release: () => {}, resizing: () => '',
        surfaces: { get: () => null, set: () => {}, remove: () => {} },
    }, 'mouse-test');
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

// ── core ──────────────────────────────────────────────────────────────────────

test('the cell under a point is the slot geometry\'s: a slot at its cell\'s left edge and vertical centre', () => {
    const m = { charWidth: 0.6, letterSpacing: 0.1, lineSpacing: 1.5 };
    const L = computeCellGridLayout(10, 4, m);
    // Cell (c, r)'s slot is at (c·strideX, −r·strideY): its left edge, its vertical centre.
    for (const [c, r] of [[0, 0], [3, 2], [9, 3]]) {
        const slot = { x: c * L.strideX, y: -r * L.strideY };
        expect(cellAtPoint(10, 4, m, slot.x + 0.01, slot.y)).toMatchObject({ col: c, row: r });
        expect(cellAtPoint(10, 4, m, slot.x + L.strideX * 0.99, slot.y + L.strideY * 0.49)).toMatchObject({ col: c, row: r });
        expect(cellAtPoint(10, 4, m, slot.x + 0.01, slot.y - L.strideY * 0.51).row).toBe(Math.min(r + 1, 3));
    }
    const mid = cellAtPoint(10, 4, m, 3.5 * L.strideX, L.strideY / 2 - 2.25 * L.strideY);
    expect(mid.x).toBeCloseTo(3.5, 9);
    expect(mid.y).toBeCloseTo(2.25, 9);
    // Off the grid: its nearest edge, as a drag that left the terminal goes on reporting.
    expect(cellAtPoint(10, 4, m, -5, 50)).toEqual({ x: 0, y: 0, col: 0, row: 0 });
    expect(cellAtPoint(10, 4, m, 500, -500)).toEqual({ x: 10, y: 4, col: 9, row: 3 });
});

test('a grid reads its program\'s tracking off the DECSETs; its cellAt is its own geometry', async () => {
    const { ctx, router } = setup();
    await router.execute('terminal.create term-1 20 6', { sender: 'ctrl-1' });
    const grid = ctx.terminals.get('term-1');
    const parsed = () => new Promise((r) => grid._emulator._term.write('', r));
    expect(grid.mouseTracking).toBe('none');
    for (const [seq, want] of [['\x1b[?9h', 'x10'], ['\x1b[?1000h', 'normal'], ['\x1b[?1002h', 'button'], ['\x1b[?1003h', 'any'], ['\x1b[?1003l', 'none']]) {
        grid.writeBytes(seq);
        await parsed();
        expect(grid.mouseTracking).toBe(want);
        expect(grid.mouseReporting).toBe(want !== 'none');
    }
    const L = computeCellGridLayout(grid.cols, grid.rows, grid._metrics);
    expect(grid.cellAt(4.5 * L.strideX, -3 * L.strideY)).toMatchObject({ col: 4, row: 3, x: 4.5 });
});

test('terminal.mouse pushes termd\'s mouse op to the owning adapter; terminal.scroll carries the pointer\'s cell', async () => {
    const { ctx, router, pushed } = setup();
    await router.execute('terminal.create term-2 20 6', { sender: 'ctrl-4' });
    pushed.length = 0;
    let r = await router.execute('terminal.mouse term-2 press left 3.5 1 Control');
    expect(r.text).toStartWith('OK:');
    r = await router.execute('terminal.mouse term-2 press 8 0 0');
    r = await router.execute('terminal.scroll term-2 -2 4.25 3');
    r = await router.execute('terminal.scroll term-2 5');
    expect(pushed).toEqual([
        { to: 'ctrl-4', event: 'terminal.mouse', data: { terminalId: 'term-2', action: 'press', button: 'left', col: 3.5, row: 1, mods: ['Control'] } },
        { to: 'ctrl-4', event: 'terminal.mouse', data: { terminalId: 'term-2', action: 'press', button: 8, col: 0, row: 0 } },
        { to: 'ctrl-4', event: 'terminal.scroll', data: { terminalId: 'term-2', lines: -2, col: 4.25, row: 3 } },
        { to: 'ctrl-4', event: 'terminal.scroll', data: { terminalId: 'term-2', lines: 5 } },
    ]);
    for (const bad of ['terminal.mouse term-2 click left 0 0', 'terminal.mouse term-2 press left x 0', 'terminal.mouse term-2 press left', 'terminal.scroll term-2 1 2', 'terminal.scroll term-2 1 a b']) {
        expect((await router.execute(bad)).text).toStartWith('ERR:');
    }
    expect((await router.execute('terminal.mouse nope press left 0 0')).text).toStartWith('ERR: no terminal');
});

// ── the wall's rule ───────────────────────────────────────────────────────────

test('a press is the program\'s on the focused body of a reporting program, with no Shift and no Alt on the left button', () => {
    const on = { part: 'body', focused: true, tracking: 'normal' };
    const e = (button, mods = {}) => ({ button, shiftKey: false, altKey: false, ...mods });
    expect(programGets(e(0), on)).toBe(true);
    expect(programGets(e(1), on)).toBe(true);
    expect(programGets(e(2), on)).toBe(true);
    expect(programGets(e(3), on)).toBe(true);
    expect(programGets(e(0, { shiftKey: true }), on)).toBe(false);       // the wall's: lasso, ⇧-click
    expect(programGets(e(2, { shiftKey: true }), on)).toBe(false);       // our menu (contextMenu.js)
    expect(programGets(e(0, { altKey: true }), on)).toBe(false);         // the wall's ⌥-drag move
    expect(programGets(e(2, { altKey: true }), on)).toBe(true);
    expect(programGets(e(0), { ...on, focused: false })).toBe(false);    // unfocused: the click focuses it
    expect(programGets(e(0), { ...on, tracking: 'none' })).toBe(false);
    expect(programGets(e(0), { ...on, part: 'title' })).toBe(false);
    expect(programGets(e(0), { ...on, part: 'edge' })).toBe(false);
    expect(programGets(e(5), on)).toBe(false);
    expect([0, 1, 2, 3, 4, 5].map(buttonOf)).toEqual(['left', 'middle', 'right', 8, 9, null]);
    expect([0, 1, 2, 4, 3, 8, 16].map(heldButton)).toEqual(['none', 'left', 'right', 'middle', 'left', 8, 9]);
    expect(modsOf({ shiftKey: true, ctrlKey: true, altKey: false, metaKey: true })).toEqual(['Shift', 'Control', 'Meta']);
});

// ── the pointer, on a stand-in wall ───────────────────────────────────────────

/**
 * A wall with one terminal 't' (80 × 24 cells of 1 × 2 world units, its slot origin at world (0, 0))
 * seen at 10 px a unit: client x = 10·world x, client y = −10·world y. Cell (c, r) spans client
 * x ∈ [10c, 10c + 10), y ∈ [20r − 10, 20r + 10).
 */
function standIn({ tracking = 'button', focused = 't' } = {}) {
    const sent = [];
    const ran = [];
    const focusCalls = [];
    const m = { charWidth: 1, letterSpacing: 0, lineSpacing: 2 };
    const grid = {
        cols: 80, rows: 24, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, mouseTracking: tracking,
        cellAt: (x, y) => cellAtPoint(80, 24, m, x, y),
        sendMouse: (ev) => { sent.push(ev); return true; },
    };
    const body = { minX: 0, maxX: 80, minY: -47, maxY: 1 };
    const wall = {
        focusedId: focused,
        terminal: (id) => (id === 't' ? grid : null),
        terminalRect: () => body,
        hit: (p) => (p.x >= body.minX && p.x <= body.maxX && p.y >= body.minY && p.y <= body.maxY ? { id: 't', part: 'body' }
            : p.x >= body.minX && p.x <= body.maxX && p.y > body.maxY && p.y <= body.maxY + 3 ? { id: 't', part: 'title' } : null),
        focus: (id) => { focusCalls.push(id); wall.focusedId = id; },
        setHovered: () => {},
        run: (cmd) => ran.push(cmd),
        router: { execute: (cmd) => ran.push(cmd) },
        selectionOverlay: { setLasso: () => {} },
    };
    const captured = new Set();
    const canvas = {
        style: {},
        setPointerCapture: (id) => captured.add(id), releasePointerCapture: (id) => captured.delete(id), hasPointerCapture: (id) => captured.has(id),
    };
    const camera = { canvas, zoom: 10, camera: { position: { x: 0, y: 0 } }, toWorld: (x, y) => ({ x: x / 10, y: -y / 10 }) };
    const pointer = new WallPointer(wall, camera);
    return { wall, grid, pointer, sent, ran, focusCalls, captured };
}
/** The client point inside cell (c, r), at fraction (fx, fy) of it. */
const at = (c, r, fx = 0.5, fy = 0.5) => ({ clientX: 10 * (c + fx), clientY: 20 * (r + fy) - 10 });
const ev = (pos, more = {}) => ({ pointerId: 1, button: 0, buttons: 1, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {}, ...pos, ...more });

test('a click on the focused body: press and release at its cell, the fraction kept; nothing of the wall\'s', () => {
    const s = standIn({ tracking: 'normal' });
    s.pointer._onDown(ev(at(3, 5, 0.5, 0.25)));
    expect(s.pointer._drag.kind).toBe('program');
    expect(s.captured.has(1)).toBe(true);
    s.pointer._onUp(ev(at(3, 5, 0.5, 0.25), { buttons: 0 }));
    expect(s.sent).toEqual([
        { action: 'press', button: 'left', col: 3.5, row: 5.25 },
        { action: 'release', button: 'left', col: 3.5, row: 5.25 },
    ]);
    expect(s.focusCalls).toEqual([]);
    expect(s.captured.has(1)).toBe(false);
    // Control rides; a right press with it too.
    s.sent.length = 0;
    s.pointer._onDown(ev(at(0, 0), { button: 2, buttons: 2, ctrlKey: true }));
    s.pointer._onUp(ev(at(0, 0), { button: 2, buttons: 0, ctrlKey: true }));
    expect(s.sent.map((x) => `${x.action} ${x.button} ${x.mods}`)).toEqual(['press right Control', 'release right Control']);
});

test('a drag: moves once per cell with the button held, clamped to the terminal off its edge, then the release', () => {
    const s = standIn({ tracking: 'button' });
    s.pointer._onDown(ev(at(1, 1)));
    s.pointer._onMove(ev(at(1, 1, 0.9, 0.9)));           // same cell: nothing
    s.pointer._onMove(ev(at(2, 1, 0.1)));                // next cell
    s.pointer._onMove(ev(at(2, 1, 0.8)));                // same again: nothing
    s.pointer._onMove(ev({ clientX: 2000, clientY: -500 }));   // off the terminal, up and right: its edge
    s.pointer._onUp(ev({ clientX: 2000, clientY: -500 }, { buttons: 0 }));
    expect(s.sent.map((x) => `${x.action} ${x.button} ${Math.floor(x.col)},${Math.floor(x.row)}`)).toEqual([
        'press left 1,1', 'move left 2,1', 'move left 80,0', 'release left 80,0',
    ]);
    expect(s.sent[2]).toMatchObject({ col: 80, row: 0 });   // the right edge: the last cell's (termd clamps the pixel)
});

test('normal tracking hears no drag; a chord presses and releases its second button inside the gesture', () => {
    const s = standIn({ tracking: 'normal' });
    s.pointer._onDown(ev(at(1, 1)));
    s.pointer._onMove(ev(at(4, 2)));
    expect(s.sent.map((x) => x.action)).toEqual(['press']);
    s.pointer._onMove(ev(at(4, 2), { button: 2, buttons: 3 }));    // right joins: a pointermove, not a pointerdown
    s.pointer._onMove(ev(at(4, 2), { button: 2, buttons: 1 }));    // right lets go
    s.pointer._onUp(ev(at(4, 2), { buttons: 0 }));
    expect(s.sent.map((x) => `${x.action} ${x.button} ${Math.floor(x.col)},${Math.floor(x.row)}`)).toEqual([
        'press left 1,1', 'press right 4,2', 'release right 4,2', 'release left 4,2',
    ]);
});

test('a cancelled gesture releases what it held, where it was last heard', () => {
    const s = standIn({ tracking: 'any' });
    s.pointer._onDown(ev(at(6, 7)));
    s.pointer._onCancel(ev(at(6, 7)));
    expect(s.sent.map((x) => `${x.action} ${x.button} ${Math.floor(x.col)},${Math.floor(x.row)}`)).toEqual(['press left 6,7', 'release left 6,7']);
    expect(s.pointer._drag).toBe(null);
});

test('any-event tracking hears the hover over the focused body, once per cell; button tracking doesn\'t', () => {
    const s = standIn({ tracking: 'any' });
    s.pointer._onMove(ev(at(2, 2), { buttons: 0 }));
    s.pointer._onMove(ev(at(2, 2, 0.9), { buttons: 0 }));
    s.pointer._onMove(ev(at(3, 2), { buttons: 0 }));
    s.pointer._onMove(ev({ clientX: 2000, clientY: 2000 }, { buttons: 0 }));   // off it: nothing
    s.pointer._onMove(ev(at(3, 2), { buttons: 0 }));                            // back: heard again
    s.pointer._onMove(ev(at(4, 2), { buttons: 0, shiftKey: true }));            // Shift: the wall's
    expect(s.sent.map((x) => `${x.action} ${x.button} ${Math.floor(x.col)},${Math.floor(x.row)}`)).toEqual([
        'move none 2,2', 'move none 3,2', 'move none 3,2',
    ]);
    expect(s.pointer.canvas.style.cursor).not.toBe('default');   // Shift held: the wall's cursor
    s.pointer._onMove(ev(at(5, 2), { buttons: 0 }));
    expect(s.pointer.canvas.style.cursor).toBe('default');       // the program's pointer
    const b = standIn({ tracking: 'button' });
    b.pointer._onMove(ev(at(2, 2), { buttons: 0 }));
    expect(b.sent).toEqual([]);
});

test('an unfocused terminal\'s click focuses it and sends nothing; Shift, Alt and the title bar keep the wall\'s', () => {
    const s = standIn({ tracking: 'any', focused: null });
    s.pointer._onDown(ev(at(1, 1)));
    s.pointer._onUp(ev(at(1, 1), { buttons: 0 }));
    expect(s.focusCalls).toEqual(['t']);
    s.pointer._onMove(ev(at(9, 9), { buttons: 0 }));   // now focused: hover is heard from here on
    expect(s.sent.map((x) => x.action)).toEqual(['move']);
    s.sent.length = 0;
    s.pointer._onDown(ev(at(1, 1), { shiftKey: true }));
    expect(s.pointer._drag.kind).toBe('shift');
    s.pointer._onUp(ev(at(1, 1), { buttons: 0, shiftKey: true }));
    s.pointer._onDown(ev(at(1, 1), { altKey: true }));
    expect(s.pointer._drag.kind).toBe('press');
    s.pointer._onUp(ev(at(1, 1), { buttons: 0, altKey: true }));
    s.pointer._onDown(ev({ clientX: 50, clientY: -20 }));   // the title bar
    expect(s.pointer._drag.kind).toBe('press');
    s.pointer._onUp(ev({ clientX: 50, clientY: -20 }, { buttons: 0 }));
    expect(s.sent).toEqual([]);
});

test('a double-click on the program\'s body is the program\'s; the wheel\'s terminal.scroll carries the pointer\'s cell', () => {
    const s = standIn({ tracking: 'normal' });
    s.pointer._onDouble({ ...at(2, 2), shiftKey: false, altKey: false, button: 0 });
    expect(s.focusCalls).toEqual([]);                    // no focus + frame: the program had both clicks
    s.pointer._onWheel({ ...at(7, 3, 0.5, 0.5), deltaX: 0, deltaY: -60, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {} });
    expect(s.ran).toEqual([['terminal.scroll', 't', '2', '7.5', '3.5']]);
});
