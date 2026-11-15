// wall-select.test.mjs — selecting a terminal's text on the wall, headless.
//
// On a stand-in wall holding one REAL TerminalGrid (its emulator, its cells): a drag on the body
// selects the text between the press and the pointer (the press focuses the terminal, the same drag
// selects); a click with no travel clears it; presses within clickRepeatMs count up to a word (two)
// and a line (three), a fourth starts again; ⇧-drag on the body selects (⇧-click still toggles the
// terminal in the wall's selection, ⇧-drag off the body still lassoes); a focused program that
// reports the mouse gets the plain drag and ⇧-drag selects anyway (Ghostty's rule); Ctrl+Alt-drag
// selects a block, Alt-drag still moves; a middle-click on a body pastes the wall's selection
// clipboard, a middle drag pans; a double-click on a body frames nothing (the title bar's does).
// On a page-less TerminalWall: copyOnSelect (true: the selection clipboard; clipboard: the system
// clipboard too; false: neither), wall.copy and wall.paste through a stand-in Clipboard API, and a
// refused clipboard answering ERR with the reason and putting up the wall's notice.
//
//   bun test tools/wall-select.test.mjs

import { test, expect } from 'bun:test';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
globalThis.location ??= /** @type {any} */ ({ hostname: 'localhost', origin: 'http://localhost:5180' });
globalThis.window ??= /** @type {any} */ ({ location: globalThis.location, addEventListener() {}, removeEventListener() {} });
await import('./headless-canvas.mjs');
const THREE = await import('three');
const { HEADLESS_ATLAS } = await import('./headless-atlas.mjs');
const { WALL_CONFIG } = await import('../wall/wallConfig.js');
const { default: TerminalGrid } = await import('../packages/glyph3d-core/src/collections/TerminalGrid.js');
const { default: TerminalScreenQueue } = await import('../packages/glyph3d-core/src/collections/TerminalScreenQueue.js');
const { default: WallPointer } = await import('../wall/WallPointer.js');
const { default: TerminalWall } = await import('../wall/TerminalWall.js');

/** CSS px per world unit: the stand-in camera's zoom (a cell is some 20 px wide). */
const Z = 100;

/**
 * A wall with one terminal 't' — a real 30 × 6 grid at the origin — seen at Z px a unit: client
 * x = Z·world x, client y = −Z·world y. Its title bar is the strip just above its body.
 */
async function standIn({ focused = null, text = 'hello world foo\r\nsecond (line) here\r\n  indented line' } = {}) {
    const scene = new THREE.Scene();
    new TerminalScreenQueue(scene);
    const grid = new TerminalGrid(scene, HEADLESS_ATLAS, { id: 't', cols: 30, rows: 6, depthMax: 0 });
    const show = async (bytes) => { grid.writeBytes(bytes); await new Promise((r) => grid._emulator._term.write('', r)); grid.applyPendingScreen(); };
    await show(text);
    const lb = grid.getLocalBounds();
    const body = { minX: lb.min.x, maxX: lb.max.x, minY: lb.min.y, maxY: lb.max.y };
    const ran = [], focusCalls = [], made = [];
    const wall = {
        focusedId: focused,
        terminal: (id) => (id === 't' ? grid : null),
        terminalRect: () => body,
        hit: (p) => (p.x >= body.minX && p.x <= body.maxX && p.y >= body.minY && p.y <= body.maxY ? { id: 't', part: 'body' }
            : p.x >= body.minX && p.x <= body.maxX && p.y > body.maxY && p.y <= body.maxY + 1 ? { id: 't', part: 'title' } : null),
        focus: (id, o) => { focusCalls.push(o?.frame ? `${id} framed` : id); wall.focusedId = id; },
        setHovered: () => {},
        run: (cmd) => ran.push(cmd),
        router: { execute: (cmd) => ran.push(cmd) },
        selectionOverlay: { setLasso: () => {} },
        selectionMade: (id) => made.push([id, grid.selectionText()]),
        selectionClipboard: '',
        config: { ...WALL_CONFIG },
        fitAll: () => {},
        groups: { tiles: () => false, splits: () => false },
        shownOrder: () => ['t'], canvasOrder: () => ['t'], windowRect: () => ({ ...body, maxY: body.maxY + 1 }),
    };
    const captured = new Set();
    const canvas = { style: {}, setPointerCapture: (id) => captured.add(id), releasePointerCapture: (id) => captured.delete(id), hasPointerCapture: (id) => captured.has(id) };
    const camera = {
        canvas, zoom: Z, camera: { position: { x: 0, y: 0 } },
        toWorld: (x, y) => ({ x: x / Z, y: -y / Z }),
        moveTo() {}, measure() {}, toWorldInto: (x, y, out) => { out.x = x / Z; out.y = -y / Z; return out; },
    };
    const pointer = new WallPointer(/** @type {any} */ (wall), /** @type {any} */ (camera));
    const m = grid._metrics, sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing;
    /** The client point at fraction (fx, fy) of cell (c, r) — its middle rounds to the boundary after it. */
    const at = (c, r, fx = 0.5, fy = 0.5) => ({ clientX: Z * (c + fx) * sx, clientY: -Z * (sy / 2 - (r + fy) * sy) });
    return { grid, wall, pointer, ran, focusCalls, made, show, at, body };
}
let clock = 1000;
/** A pointer event; each press is later than the last by `dt` ms (default: well past a double-click). */
const ev = (pos, more = {}) => ({ pointerId: 1, button: 0, buttons: 1, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, timeStamp: clock, preventDefault() {}, ...pos, ...more });
const press = (s, pos, more = {}, dt = 2000) => { clock += dt; s.pointer._onDown(ev(pos, more)); };
const move = (s, pos, more = {}) => s.pointer._onMove(ev(pos, more));
const up = (s, pos, more = {}) => s.pointer._onUp(ev(pos, { buttons: 0, ...more }));
/** Press, drag to `to`, let go. */
const drag = (s, from, to, more = {}) => { press(s, from, more); move(s, to, more); up(s, to, more); };

test('a drag on the body selects from the press to the pointer; the press focuses it; a click clears it', async () => {
    const s = await standIn();
    press(s, s.at(0, 0, 0.2));
    expect(s.focusCalls).toEqual(['t']);                 // focused at the press: the same drag selects
    expect(s.pointer._drag.kind).toBe('text');
    move(s, s.at(4, 0, 0.7));
    expect(s.grid.selectionText()).toBe('hello');
    move(s, s.at(5, 1, 0.7));                            // on into the next row
    expect(s.grid.selectionText()).toBe('hello world foo\nsecond');
    up(s, s.at(5, 1, 0.7));
    expect(s.made).toEqual([['t', 'hello world foo\nsecond']]);   // copyOnSelect's moment
    // A click with no travel clears it, and selects nothing.
    press(s, s.at(2, 2));
    expect(s.grid.hasSelection).toBe(false);
    up(s, s.at(2, 2));
    expect(s.made.length).toBe(1);
    // A wobble inside the slop is still a click.
    press(s, s.at(2, 2, 0.2));
    move(s, s.at(2, 2, 0.25));
    up(s, s.at(2, 2, 0.25));
    expect(s.grid.hasSelection).toBe(false);
});

test('presses within clickRepeatMs: a word, then a line, then a single click again; slow ones stay single', async () => {
    const s = await standIn({ focused: 't' });
    press(s, s.at(7, 0)); up(s, s.at(7, 0));
    press(s, s.at(7, 0), {}, 100); up(s, s.at(7, 0));
    expect(s.grid.selectionText()).toBe('world');
    expect(s.made.at(-1)).toEqual(['t', 'world']);
    press(s, s.at(7, 0), {}, 100);
    expect(s.grid.selectionText()).toBe('hello world foo');
    up(s, s.at(7, 0));
    press(s, s.at(7, 0), {}, 100);                       // a fourth: a single click — it clears
    expect(s.grid.hasSelection).toBe(false);
    up(s, s.at(7, 0));
    // A double-click's drag grows by words.
    press(s, s.at(8, 1)); up(s, s.at(8, 1));
    press(s, s.at(8, 1), {}, 100);
    expect(s.grid.selectionText()).toBe('line');
    move(s, s.at(15, 1));
    up(s, s.at(15, 1));
    expect(s.grid.selectionText()).toBe('line) here');
    // Presses further apart in time (or place) are single clicks.
    press(s, s.at(2, 2)); up(s, s.at(2, 2));
    press(s, s.at(2, 2), {}, WALL_CONFIG.clickRepeatMs + 1); up(s, s.at(2, 2));
    expect(s.grid.hasSelection).toBe(false);
    press(s, s.at(2, 2)); up(s, s.at(2, 2));
    press(s, s.at(9, 2), {}, 50); up(s, s.at(9, 2));
    expect(s.grid.hasSelection).toBe(false);
    // The line leaves its leading blanks out.
    press(s, s.at(5, 2)); up(s, s.at(5, 2));
    press(s, s.at(5, 2), {}, 50); up(s, s.at(5, 2));
    press(s, s.at(5, 2), {}, 50); up(s, s.at(5, 2));
    expect(s.grid.selectionText()).toBe('indented line');
});

test('⇧-drag on the body selects text; ⇧-click still toggles the terminal; ⇧-drag off the body lassoes', async () => {
    const s = await standIn();
    drag(s, s.at(0, 1, 0.1), s.at(6, 1, 0.1), { shiftKey: true });
    expect(s.grid.selectionText()).toBe('second');
    expect(s.focusCalls).toEqual(['t']);                 // the drag focused it
    expect(s.ran).toEqual([]);
    press(s, s.at(3, 1), { shiftKey: true }); up(s, s.at(3, 1), { shiftKey: true });
    expect(s.ran).toEqual([['wall.select.toggle', 't']]);
    expect(s.grid.selectionText()).toBe('second');       // a ⇧-click leaves the text selection
    // From the title bar: a lasso.
    const title = { clientX: s.at(3, 0).clientX, clientY: -Z * (s.body.maxY + 0.5) };
    press(s, title, { shiftKey: true });
    move(s, { clientX: title.clientX + 80, clientY: title.clientY + 80 }, { shiftKey: true });
    expect(s.pointer._drag.kind).toBe('lasso');
    up(s, { clientX: title.clientX + 80, clientY: title.clientY + 80 }, { shiftKey: true });
    expect(s.ran.at(-1)).toEqual(['wall.select.add', 't']);
});

test('a reporting program gets the plain drag; ⇧-drag selects anyway', async () => {
    const s = await standIn({ focused: 't' });
    await s.show('\x1b[?1002h');
    const sent = [];
    s.grid.onInput = (input) => sent.push(input.mouse?.action);
    drag(s, s.at(0, 0), s.at(4, 0));
    expect(sent).toEqual(['press', 'move', 'release']);
    expect(s.grid.hasSelection).toBe(false);
    sent.length = 0;
    drag(s, s.at(0, 0, 0.1), s.at(5, 0, 0.1), { shiftKey: true });
    expect(sent).toEqual([]);
    expect(s.grid.selectionText()).toBe('hello');
});

test('Ctrl+Alt-drag selects a block; Alt-drag still moves the terminal', async () => {
    const s = await standIn();
    drag(s, s.at(1, 0, 0.1), s.at(5, 1, 0.1), { ctrlKey: true, altKey: true });
    expect(s.grid.selection).toMatchObject({ block: true, start: { col: 1, row: 0 }, end: { col: 5, row: 1 } });
    expect(s.grid.selectionText()).toBe('ello\necon');
    press(s, s.at(1, 0), { altKey: true });
    expect(s.pointer._drag.kind).toBe('press');
    up(s, s.at(1, 0), { altKey: true });
});

test('a middle-click on a body pastes the wall\'s selection clipboard; a middle drag pans', async () => {
    const s = await standIn();
    press(s, s.at(3, 3), { button: 1, buttons: 4 }); up(s, s.at(3, 3), { button: 1 });
    expect(s.ran).toEqual([]);                            // nothing in it yet: nothing pasted
    s.wall.selectionClipboard = 'echo hi';
    press(s, s.at(3, 3), { button: 1, buttons: 4 }); up(s, s.at(3, 3), { button: 1 });
    expect(s.ran).toEqual([['wall.paste', 't', 'selection']]);
    press(s, s.at(3, 3), { button: 1, buttons: 4 });
    move(s, s.at(12, 3), { buttons: 4 });
    up(s, s.at(12, 3), { button: 1 });
    expect(s.ran.length).toBe(1);
    expect(s.focusCalls).toEqual([]);                    // neither focuses
});

test('a double-click on the body frames nothing; on the title bar it frames', async () => {
    const s = await standIn();
    s.pointer._onDouble({ ...s.at(3, 1), shiftKey: false, altKey: false, button: 0 });
    expect(s.focusCalls).toEqual([]);
    s.pointer._onDouble({ clientX: s.at(3, 0).clientX, clientY: -Z * (s.body.maxY + 0.5), shiftKey: false, altKey: false, button: 0 });
    expect(s.focusCalls).toEqual(['t framed']);
});

// ── the wall's clipboards ─────────────────────────────────────────────────────

const makeWall = () => new TerminalWall({
    scene: {}, camera: /** @type {any} */ ({ isOrthographicCamera: true, zoom: 4, position: { x: 0, y: 0 } }),
    gl: { domElement: {} }, atlas: null, registry: {}, relayPort: 11,
});
/** A stand-in Clipboard API: what it holds, and whether it refuses. */
function clipboard({ refuse = false } = {}) {
    const c = {
        held: '',
        writeText: async (t) => { if (refuse) throw Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }); c.held = t; },
        readText: async () => { if (refuse) throw Object.assign(new Error('Read permission denied.'), { name: 'NotAllowedError' }); return c.held; },
    };
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: c }, configurable: true });
    return c;
}
const fakeGrid = (selected) => { const g = { pasted: [], selectionText: () => selected, paste: (t) => (g.pasted.push(t), true), hasSelection: !!selected }; return g; };

test('copyOnSelect: true fills the selection clipboard, clipboard the system one too, false neither', async () => {
    const w = makeWall();
    const clip = clipboard();
    w.ctx.terminals.set('t', /** @type {any} */ (fakeGrid('ls -la')));
    expect(w.config.copyOnSelect).toBe('true');
    w.selectionMade('t');
    expect(w.selectionClipboard).toBe('ls -la');
    expect(clip.held).toBe('');
    w.config.copyOnSelect = 'clipboard';
    w.ctx.terminals.set('t', /** @type {any} */ (fakeGrid('pwd')));
    w.selectionMade('t');
    await Promise.resolve();
    expect([w.selectionClipboard, clip.held]).toEqual(['pwd', 'pwd']);
    w.config.copyOnSelect = 'false';
    w.ctx.terminals.set('t', /** @type {any} */ (fakeGrid('date')));
    w.selectionMade('t');
    expect([w.selectionClipboard, clip.held]).toEqual(['pwd', 'pwd']);
});

test('wall.copy and wall.paste: the clipboard both ways; the selection clipboard; refusals say why and show a notice', async () => {
    const w = makeWall();
    const clip = clipboard();
    const g = fakeGrid('make test');
    w.ctx.terminals.set('t', /** @type {any} */ (g));
    w.focusedId = 't';
    let r = await w.router.execute(['wall.copy']);
    expect(r.text).toBe('OK: copied 9 characters from t');
    expect(clip.held).toBe('make test');
    clip.held = 'git status';
    r = await w.router.execute(['wall.paste', 't']);
    expect(r.text).toStartWith('OK: pasted 10 characters into t');
    w.selectionClipboard = 'echo sel';
    r = await w.router.execute(['wall.paste', 'selection']);
    expect(r.text).toStartWith('OK: pasted 8 characters into t from the selection clipboard');
    expect(g.pasted).toEqual(['git status', 'echo sel']);
    w.ctx.terminals.set('u', /** @type {any} */ (fakeGrid('')));
    expect((await w.router.execute(['wall.copy', 'u'])).text).toBe('ERR: nothing is selected in u');
    expect((await w.router.execute(['wall.copy', 'nope'])).text).toBe("ERR: no terminal 'nope'");
    // The browser refuses: the verb says why, and so does the wall's notice.
    clipboard({ refuse: true });
    const warn = console.warn; console.warn = () => {};
    try {
        r = await w.router.execute(['wall.copy', 't']);
        expect(r.text).toMatch(/^ERR: the browser refused the clipboard \(NotAllowedError: Write permission denied\.\)/);
        expect(w.notice).toMatch(/^copy: the browser refused the clipboard/);
        r = await w.router.execute(['wall.paste', 't']);
        expect(r.text).toMatch(/^ERR: the browser refused to read the clipboard/);
        expect(w.notice).toMatch(/^paste:/);
        // No Clipboard API at all (an http page off localhost): said as such.
        Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
        r = await w.router.execute(['wall.copy', 't']);
        expect(r.text).toMatch(/secure context \(https, or localhost\)/);
    } finally { console.warn = warn; clearTimeout(w._noticeTimer); }
});
