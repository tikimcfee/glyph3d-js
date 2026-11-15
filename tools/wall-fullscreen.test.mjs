// wall-fullscreen.test.mjs — one terminal fullscreen (wall/WallFullscreen.js) on a stand-in wall with
// the real WallStore: entering keeps the canvas text size (so it shows more text; floored at
// fullscreenMinLinePx from far out) and re-wraps the terminal to fill the canvas the docked panels
// leave, less fullscreenPad, its body's top-left placed with the leftover split evenly; leaving
// gives back its canvas cols × rows and spot and the camera its canvas pose; the text keys step the
// size, re-wrap, and are remembered per terminal until reset; focusing another moves fullscreen to it
// (the first is given back, the canvas pose kept); a window change re-fits once it settles; a reload
// takes a saved fullscreen up again when its terminal registers; a terminal that goes ends it.
// Run: bun test tools/wall-fullscreen.test.mjs
import { test, expect, beforeEach } from 'bun:test';

const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
};
const { default: WallStore } = await import('../wall/WallStore.js');
const { default: WallFullscreen } = await import('../wall/WallFullscreen.js');
const { WALL_CONFIG } = await import('../wall/wallConfig.js');
const { DOCK_WIDTHS } = await import('../wall/dockLayout.js');

beforeEach(() => mem.clear());

/** A terminal grid: a cell 0.6 × 1.2 world units, its panel's top-left at its position. */
function grid(cols, rows, x, y) {
    return { cols, rows, position: { x, y }, cellStride: { x: 0.6, y: 1.2 } };
}

/** A wall holding terminals a and b, the camera at zoom 15 (18 px a row), the view 1000 × 600. */
function standIn() {
    const terminals = new Map([['a', grid(80, 24, 0, 0)], ['b', grid(100, 30, 100, 0)]]);
    const ran = [], eased = [];
    const wall = {
        store: new WallStore(8099),
        config: { ...WALL_CONFIG },
        focusedId: 'a',
        viewport: { view: { w: 1000, h: 600 }, zoom: 15, camera: { position: { x: 5, y: -3 }, zoom: 15 }, easeTo: (t) => eased.push(t) },
        terminal: (id) => terminals.get(id),
        isShown: (id) => terminals.has(id),
        focus(id) { this.focusedId = id; },
        applyCanvas() {},
        _emit() {},
        groups: { relayoutOf() {} },
        // The panel: the cells plus PAD world units of the grid's own padding on every side, as
        // TerminalGrid.getLocalBounds has it (computeCellGridLayout).
        terminalRect: (id) => { const g = terminals.get(id); return { minX: g.position.x, maxX: g.position.x + g.cols * 0.6 + 2 * PAD, minY: g.position.y - g.rows * 1.2 - 2 * PAD, maxY: g.position.y }; },
        // terminal.resize as termd would land it (the size comes back at once here).
        router: { execute: (cmd) => { ran.push(cmd); if (cmd[0] === 'terminal.resize') { const g = terminals.get(cmd[1]); g.cols = +cmd[2]; g.rows = +cmd[3]; } } },
    };
    wall.fullscreen = new WallFullscreen(/** @type {any} */ (wall));
    return { wall, terminals, ran, eased, fs: wall.fullscreen };
}

/** The grid's own padding round its cells, world units (TerminalGrid's background padding). */
const PAD = 0.3;

/** What a fit at `linePx` makes of a W × H area: cols, rows, and where the panel's top-left goes. */
function fitOf(linePx, { left = 0, width = 1000, height = 600, pad = WALL_CONFIG.fullscreenPad } = {}) {
    const zoom = linePx / 1.2, cellW = 0.6 * zoom, frame = 2 * PAD * zoom;
    const cols = Math.floor((width - 2 * pad - frame) / cellW), rows = Math.floor((height - 2 * pad - frame) / linePx);
    return { cols, rows, left: left + (width - cols * cellW - frame) / 2, top: (height - rows * linePx - frame) / 2, zoom, frame };
}

test('entering keeps the canvas text size and fills the canvas: cols × rows, the corner placed, only it drawn', () => {
    const { wall, terminals, ran, eased, fs } = standIn();
    expect(fs.enter('a')).toBe(true);
    const f = fitOf(18);
    expect(ran).toEqual([['terminal.resize', 'a', String(f.cols), String(f.rows)]]);
    expect(fs.state.linePx).toBe(18);
    // The camera puts the body's top-left (world 0, 0) at screen (f.left, f.top).
    const pose = eased.at(-1);
    expect(pose.zoom).toBeCloseTo(f.zoom);
    expect((0 - pose.x) * pose.zoom + 500).toBeCloseTo(f.left);
    expect((pose.y - 0) * pose.zoom + 300).toBeCloseTo(f.top);
    expect(wall.store.fullscreen().id).toBe('a');
    expect(terminals.get('a').cols).toBe(f.cols);
    // The whole panel — cells and the grid's padding — lands inside the area, less the pad.
    const right = f.left + f.cols * 0.6 * f.zoom + f.frame, bottom = f.top + f.rows * 18 + f.frame;
    expect(right).toBeLessThanOrEqual(1000 - WALL_CONFIG.fullscreenPad);
    expect(bottom).toBeLessThanOrEqual(600 - WALL_CONFIG.fullscreenPad);
    expect(f.left).toBeGreaterThanOrEqual(WALL_CONFIG.fullscreenPad);
});

test('from far out, entry text is at least fullscreenMinLinePx', () => {
    const { wall, fs } = standIn();
    wall.viewport.zoom = 1;   // 1.2 px a row on the canvas
    fs.enter('a');
    expect(fs.state.linePx).toBe(WALL_CONFIG.fullscreenMinLinePx);
});

test('leaving gives back the canvas cols × rows and spot, and the camera its canvas pose', () => {
    const { terminals, ran, eased, fs } = standIn();
    fs.enter('a');
    terminals.get('a').position.x = 7;   // anything that moved it meanwhile
    fs.exit();
    expect(ran.at(-1)).toEqual(['terminal.resize', 'a', '80', '24']);
    expect(terminals.get('a').position).toEqual({ x: 0, y: 0 });
    expect(eased.at(-1)).toEqual({ x: 5, y: -3, zoom: 15 });
    expect(fs.id).toBe(null);
});

test('the text keys step the size, re-wrap, and are remembered for that terminal until reset', () => {
    const { wall, ran, fs } = standIn();
    fs.enter('a');
    const px = fs.text(1);
    expect(px).toBeCloseTo(18 * WALL_CONFIG.fullscreenTextStep);
    const f = fitOf(px);
    expect(ran.at(-1)).toEqual(['terminal.resize', 'a', String(f.cols), String(f.rows)]);
    expect(wall.store.fullscreenText('a')).toBeCloseTo(px);
    fs.exit();
    wall.viewport.zoom = 3;   // a different canvas size: the remembered one wins
    fs.enter('a');
    expect(fs.state.linePx).toBeCloseTo(px);
    expect(fs.text(0)).toBe(WALL_CONFIG.fullscreenMinLinePx);   // reset: the canvas's size (3.6 px, floored)
    expect(wall.store.fullscreenText('a')).toBe(null);
});

test('docked panels and the pad narrow what it fills', () => {
    const { wall, ran, fs } = standIn();
    wall.store.setSidebar({ open: true, side: 'left' });
    wall.config.fullscreenPad = 0;
    fs.enter('a');
    const f = fitOf(18, { left: DOCK_WIDTHS.sidebar, width: 1000 - DOCK_WIDTHS.sidebar, pad: 0 });
    expect(ran.at(-1)).toEqual(['terminal.resize', 'a', String(f.cols), String(f.rows)]);
});

test('focusing another moves fullscreen to it: the first given back, the canvas pose kept', () => {
    const { wall, ran, eased, fs } = standIn();
    fs.enter('a');
    wall.viewport.camera.position.x = 99;   // the camera is now on a
    fs.enter('b');
    expect(ran).toContainEqual(['terminal.resize', 'a', '80', '24']);
    expect(fs.id).toBe('b');
    expect(wall.focusedId).toBe('b');
    fs.exit();
    expect(eased.at(-1)).toEqual({ x: 5, y: -3, zoom: 15 });
    expect(ran.at(-1)).toEqual(['terminal.resize', 'b', '100', '30']);
});

test('a window change re-fits once it has settled, not before', () => {
    const { wall, ran, fs } = standIn();
    fs.enter('a');
    const n = ran.length;
    wall.viewport.view.w = 1400;
    fs.tick(1000);
    fs.tick(1100);
    expect(ran.length).toBe(n);
    fs.tick(1200);
    const f = fitOf(18, { width: 1400 });
    expect(ran.at(-1)).toEqual(['terminal.resize', 'a', String(f.cols), String(f.rows)]);
});

test('a reload takes the saved fullscreen up when its terminal registers; a terminal that goes ends it', () => {
    const first = standIn();
    first.fs.enter('a');
    const next = standIn();   // the same store keys: a reload
    expect(next.fs.id).toBe(null);
    next.fs.adopt('b');
    expect(next.fs.id).toBe(null);
    next.fs.adopt('a');
    expect(next.fs.id).toBe('a');
    expect(next.fs.state.canvas).toEqual({ cols: 80, rows: 24, x: 0, y: 0 });
    next.fs.gone('a');
    expect(next.fs.id).toBe(null);
    expect(next.wall.store.fullscreen()).toBe(null);
    expect(next.eased.at(-1)).toEqual({ x: 5, y: -3, zoom: 15 });
});
