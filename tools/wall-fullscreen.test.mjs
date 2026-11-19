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
const { default: WallFullscreen, backdropClipPath, backdropColor } = await import('../wall/WallFullscreen.js');
const { WALL_CONFIG } = await import('../wall/wallConfig.js');
const { DOCK_WIDTHS } = await import('../wall/dockLayout.js');
const { FULLSCREEN_Z } = await import('../wall/wallLayout.js');
const { default: WallPointer } = await import('../wall/WallPointer.js');
const { default: WallGroups } = await import('../wall/WallGroups.js');
globalThis.location ??= /** @type {any} */ ({ hostname: 'localhost', origin: 'http://localhost:5180' });
const { default: TerminalWall } = await import('../wall/TerminalWall.js');

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
        nameOf: (id) => `name-${id}`,
        notices: [],
        notify(text) { this.notices.push(text); },
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
    expect(next.wall.notices).toEqual([]);
    next.fs.adopt('a');
    expect(next.fs.id).toBe('a');
    expect(next.fs.state.canvas).toEqual({ cols: 80, rows: 24, x: 0, y: 0 });
    // The page loaded with one terminal on screen and the wall's chrome hidden: it says why, and the way out.
    expect(next.wall.notices.length).toBe(1);
    expect(next.wall.notices[0]).toMatch(/^fullscreen: name-a — .*↵ shows the whole wall again$/);
    expect(first.wall.notices).toEqual([]);   // entering it by hand says nothing
    next.fs.gone('a');
    expect(next.fs.id).toBe(null);
    expect(next.wall.store.fullscreen()).toBe(null);
    expect(next.eased.at(-1)).toEqual({ x: 5, y: -3, zoom: 15 });
});

test('canvasBodyRect preserves the pre-fullscreen canvas rect; backdrop cuts out the terminal at 90% opacity', () => {
    const { wall, fs } = standIn();
    const before = wall.terminalRect('a');
    fs.enter('a');
    expect(wall.terminalRect('a').maxX).toBeGreaterThan(before.maxX);
    const cb = fs.canvasBodyRect();
    expect(cb.minX).toBeCloseTo(before.minX, 9);
    expect(cb.maxX).toBeCloseTo(before.maxX, 9);
    expect(cb.minY).toBeCloseTo(before.minY, 9);
    expect(cb.maxY).toBeCloseTo(before.maxY, 9);
    expect(backdropColor('#07080b')).toBe('rgba(7, 8, 11, 0.9)');
    const clip = backdropClipPath({ left: 6, right: 994, top: 8, bottom: 592 }, { w: 1000, h: 600 });
    expect(clip).toContain('6.0px 8.0px, 6.0px 592.0px, 994.0px 592.0px, 994.0px 8.0px');
    // Wholly off-screen at the start of a long glide: veil the whole viewport until the pane arrives.
    expect(backdropClipPath({ left: 1200, right: 1800, top: 0, bottom: 600 }, { w: 1000, h: 600 })).toBe('none');
});

test('fullscreen pointer guardrails: camera zoom and pan are disallowed; bezel clicks keep focus; Alt-drag and dblclick stay put', () => {
    const { wall, terminals, ran, fs } = standIn();
    fs.enter('a');
    let zoomed = 0, panned = 0, fitted = 0;
    wall.fitAll = () => { fitted++; };
    wall.setHovered = () => {};
    wall.hit = (p) => {
        const r = wall.terminalRect('a');
        return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY ? { id: 'a', part: 'body' } : null;
    };
    const captured = new Set();
    const canvas = {
        style: {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
        setPointerCapture: (id) => captured.add(id),
        releasePointerCapture: (id) => captured.delete(id),
        hasPointerCapture: (id) => captured.has(id),
    };
    const camera = {
        canvas, view: { w: 1000, h: 600 }, zoom: 15, camera: { position: { x: 40, y: -20 }, zoom: 15 },
        toWorld: (cx, cy) => ({ x: 40 + (cx - 500) / 15, y: -20 - (cy - 300) / 15 }),
        toWorldInto(cx, cy, out) { const p = this.toWorld(cx, cy); out.x = p.x; out.y = p.y; return out; },
        measure() {},
        zoomAt: () => { zoomed++; },
        wheelZoomAt: () => { zoomed++; },
        panBy: () => { panned++; },
        moveTo: () => { panned++; },
    };
    terminals.get('a').scale = { x: 1, y: 1 };
    terminals.get('a').cellAt = (_x, _y, out = {}) => Object.assign(out, { x: 2, y: 3, col: 2, row: 3 });
    terminals.get('a').clearSelection = () => {};
    const ptr = new WallPointer(/** @type {any} */ (wall), /** @type {any} */ (camera));

    // Ctrl+wheel (pinch), Alt+wheel and Meta+wheel all preventDefault without zooming the camera.
    for (const mods of [{ ctrlKey: true, deltaY: 12 }, { ctrlKey: true, deltaY: 120 }, { altKey: true, deltaY: -80 }, { metaKey: true, deltaY: 60 }]) {
        let prevented = false;
        ptr._onWheel({ deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 500, clientY: 300, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods, preventDefault() { prevented = true; } });
        expect(prevented).toBe(true);
    }
    expect(zoomed).toBe(0);

    // Plain wheel — even in the outer bezel (clientX: 1, outside the panel) — scrolls 'a', never pans.
    ran.length = 0;
    ptr._onWheel({ deltaX: 10, deltaY: 48, deltaMode: 0, clientX: 1, clientY: 1, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} });
    expect(panned).toBe(0);
    expect(ran.at(-1)?.[0]).toBe('terminal.scroll');
    expect(ran.at(-1)?.[1]).toBe('a');

    // Bezel click & drag: never drops focus to null, never pans.
    const bezel = { pointerId: 1, button: 0, buttons: 1, clientX: 999, clientY: 599, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} };
    ptr._onDown(bezel);
    ptr._onMove({ ...bezel, clientX: 950, clientY: 550 });
    ptr._onUp({ ...bezel, buttons: 0 });
    expect(wall.focusedId).toBe('a');
    expect(panned).toBe(0);

    // Alt+drag inside the fullscreen body does not move the terminal.
    const startPos = { ...terminals.get('a').position };
    const mid = { pointerId: 2, button: 0, buttons: 1, clientX: 200, clientY: 200, shiftKey: false, ctrlKey: false, altKey: true, metaKey: false, preventDefault() {} };
    ptr._onDown(mid);
    ptr._onMove({ ...mid, clientX: 320, clientY: 280 });
    ptr._onUp({ ...mid, buttons: 0 });
    expect(terminals.get('a').position).toEqual(startPos);

    // Double-click in the bezel does not fitAll / exit fullscreen.
    ptr._onDouble({ clientX: 999, clientY: 599, button: 0, shiftKey: false, altKey: false });
    expect(fitted).toBe(0);
    expect(fs.id).toBe('a');
});

test('TerminalWall Z-stacking, Z-elevated fullscreen directional moves, group/pane cycling, focus history and close/hide recovery', async () => {
    const cam = { isOrthographicCamera: true, zoom: 10, position: { x: 60, y: -20, z: 500 }, updateProjectionMatrix() {} };
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) };
    const w = new TerminalWall({ scene: {}, camera: /** @type {any} */ (cam), gl: { domElement: canvas }, atlas: null, registry: {}, relayPort: 8098 });
    w.viewport.setView(1200, 800);
    w.names = /** @type {any} */ ({ attach() {}, prune() {}, barHeight: () => 2, setBarRoom() {} });
    w.groups = new WallGroups(w, { atlas: null, scene: /** @type {any} */ ({ add() {} }) });
    // Override router terminal.resize + terminal.kill for synchronous headless grids.
    w.router.register('terminal.resize', ([id, c, r]) => {
        const g = w.terminal(id);
        g.cols = +c; g.rows = +r;
        return { text: 'OK', data: null };
    });
    w.router.register('terminal.kill', ([id]) => {
        w.ctx.terminals.delete(id);
        w._syncTerminals();
        return { text: 'OK', data: null };
    });

    const mkGrid = (id, cols, rows, x, y) => ({
        terminalId: id, cols, rows, visible: true,
        position: { x, y, z: 0 }, scale: { x: 2, y: 2, z: 2 },
        cellStride: { x: 1.2, y: 2.4 },
        getLocalBounds() { return { min: { x: 0, y: -(this.rows * 1.2 + 0.6) }, max: { x: this.cols * 0.6 + 0.6, y: 0 } }; },
        setBorder() {}, setBorderFlag() {}, setControlVisible() {}, setCursorFocused() {},
        onResize() {}, onWindowTitle() {},
    });
    // Spawn in scrambled arrival order: d (bottom-right), b (top-right), a (top-left), c (bottom-left).
    w.ctx.terminals.set('d', /** @type {any} */ (mkGrid('d', 80, 20, 70, -40)));
    w.ctx.terminals.set('b', /** @type {any} */ (mkGrid('b', 80, 20, 70, 0)));
    w.ctx.terminals.set('a', /** @type {any} */ (mkGrid('a', 80, 20, 0, 0)));
    w.ctx.terminals.set('c', /** @type {any} */ (mkGrid('c', 80, 20, 0, -40)));
    w._syncTerminals();

    // Every terminal gets its own distinct Z-slot clearing its neighbour's gridScale=2 (-1.0..+0.1) sandwich,
    // and focusing raises to top without dropping unfocused neighbours' background clearance.
    expect(new Set(['a', 'b', 'c', 'd'].map((id) => w.terminal(id).position.z)).size).toBe(4);
    w.focus('a');
    const topZ = w.terminal('a').position.z;
    for (const other of ['b', 'c', 'd']) {
        expect(topZ - 1.0).toBeGreaterThan(w.terminal(other).position.z + 0.1);
    }
    // Shifting focus from 'a' to 'c' keeps 'a' (now unfocused) strictly occluding 'b' and 'd' below it.
    w.focus('c');
    expect(w.terminal('a').position.z - 1.0).toBeGreaterThan(w.terminal('b').position.z + 0.1);
    w.focus(null);
    expect(w.terminal('c').position.z).toBe(topZ);   // dropping focus keeps the window stacking order intact

    // Unshifted cycleFocus walks spatial reading order (a → b → c → d), NOT arrival order (d, b, a, c).
    w.focus('a');
    expect(w.cycleFocus(+1)).toBe('b');
    expect(w.cycleFocus(+1)).toBe('c');
    expect(w.cycleFocus(+1)).toBe('d');
    expect(w.cycleFocus(+1)).toBe('a');
    expect(w.cycleFocus(-1)).toBe('d');

    // Focus history (Ctrl+, / Ctrl+.): jump a → c → d, step back through c → a (and earlier stops), then forward again.
    w._focusHistory = []; w._focusIndex = -1;
    w.focus('a');
    w.focus('c');
    w.focus('d');
    expect(w.stepFocusHistory(-1)).toBe('c');
    expect(w.stepFocusHistory(-1)).toBe('a');
    expect(w.stepFocusHistory(-1)).toBe(null);
    expect(w.stepFocusHistory(+1)).toBe('c');
    expect(w.stepFocusHistory(+1)).toBe('d');
    expect((await w.run(['wall.focus.history', 'back'])).data.id).toBe('c');
    expect((await w.run(['wall.focus.history', 'forward'])).data.id).toBe('d');

    // Group [a, b] as a split: unshifted cycleFocus stays within [a, b]; shifted cycleGroupFocus steps between [group(a,b), c, d].
    const gid = w.groups.create(['a', 'b'], { layout: 'split', columns: 2 });
    w.focus('a');
    expect(w.cycleFocus(+1)).toBe('b');
    expect(w.cycleFocus(+1)).toBe('a');             // wraps inside the split
    w.focus('b');                                   // remember 'b' as last focused in this group
    expect(w.cycleGroupFocus(+1)).toBe('c');        // next unit in reading order
    expect(w.cycleGroupFocus(+1)).toBe('d');
    expect(w.cycleGroupFocus(+1)).toBe('b');        // back to the split, resuming last-focused pane 'b'

    // Fullscreen via Z-elevation: 'a' rises to FULLSCREEN_Z while 'b', 'c', 'd' stay visible on the canvas below,
    // and directional focusPane ('right' / 'down') glides fullscreen across the canvas layout!
    w.focus('a');
    expect(w.fullscreen.enter('a')).toBe(true);
    expect(w.terminal('a').position.z).toBe(FULLSCREEN_Z);
    expect(w.terminal('b').visible).toBe(true);
    expect(w.terminal('c').visible).toBe(true);
    expect(w.terminal('b').position.z).toBeLessThan(FULLSCREEN_Z);
    expect(w.focusPane('right')).toBe('b');         // reads a's pre-fullscreen canvas rect → finds 'b'!
    expect(w.fullscreen.id).toBe('b');
    expect(w.terminal('b').position.z).toBe(FULLSCREEN_Z);
    expect(w.terminal('a').position.z).toBeLessThan(FULLSCREEN_Z);
    w.fullscreen.exit();

    // Hiding or closing the focused pane hands focus back to its split sibling / history instead of null.
    w.focus('b');
    w.hide('b');
    expect(w.focusedId).toBe('a');
    w.show('b');
    w.groups.add(gid, ['b']);
    w.focus('b');
    w.kill('b');
    expect(w.focusedId).toBe('a');

    // Group frame & title depth + Z-interleaved hit-testing:
    // Re-add 'b' so split gid = ['a', 'b'], create overlapping group g2 = ['c'], and overlap loose 'd' across both.
    w.ctx.terminals.set('b', /** @type {any} */ (mkGrid('b', 80, 20, 70, 0)));
    w._syncTerminals();
    w.groups.add(gid, ['b']);
    const g2 = w.groups.create(['c'], { layout: 'freeform' });
    // Stub frame objects on WallGroups so headerRect(gid, zoom) returns a 3-unit-tall header strip above frameRect.
    for (const id of [gid, g2]) w.groups._frames.set(id, /** @type {any} */ ({ headerHeight: () => 3, position: { z: 0 }, layout() {}, dispose() {} }));
    // Move g2 ('c') and loose 'd' so 'd' body and g2 header overlap gid's header AND gid's split divider!
    const h1 = w.groups.headerRect(gid, w.viewport.zoom);
    const sr = w.groups.splitRect(gid);
    const prA = w.groups.paneRects(gid).get('a');
    // Place 'c' so g2's header overlaps h1's midpoint.
    const hMidX = (h1.minX + h1.maxX) / 2, hMidY = (h1.minY + h1.maxY) / 2;
    const cRect = w.terminalRect('c');
    w.placeBody('c', { x: hMidX - 10, y: h1.minY - 2 - w.config.groupPad });
    void cRect;
    const h2 = w.groups.headerRect(g2, w.viewport.zoom);
    expect(hMidY >= h2.minY && hMidY <= h2.maxY).toBe(true);
    // Stretch 'd' over both headers and over gid's vertical split divider (prA.maxX + splitGap/2).
    const divPt = { x: prA.maxX + w.config.splitGap / 2, y: (sr.minY + sr.maxY) / 2 };
    w.terminal('d').cols = 200;
    w.terminal('d').rows = 60;
    w.placeBody('d', { x: sr.minX - 5, y: h1.maxY + 5 });

    // 1. Focus 'a' (in gid): gid rises in front of both 'd' and g2 — gid's frame+header occludes 'd' and g2,
    //    gid's header wins at (hMidX, hMidY), and gid's split divider wins at divPt.
    w.focus('a');
    expect(w.groups.depthOf(gid)).toBeGreaterThan(w.terminal('d').position.z + 0.1);
    expect(w.groups.depthOf(gid)).toBeGreaterThan(w.groups.depthOf(g2) + 0.25);
    expect(w.terminal('a').position.z - 1.0).toBeGreaterThan(w.groups.depthOf(gid) + 0.25);
    expect(w.hit({ x: hMidX, y: hMidY })).toEqual({ group: gid, part: 'header' });
    expect(w.hit(divPt)).toMatchObject({ group: gid, part: 'divider' });

    // 2. Bring g2 to front: g2's header now sits above gid's members & header, winning (hMidX, hMidY).
    w.bringGroupToFront(g2);
    expect(w.groups.depthOf(g2)).toBeGreaterThan(w.terminal('a').position.z + 0.1);
    expect(w.groups.depthOf(g2)).toBeGreaterThan(w.groups.depthOf(gid) + 0.25);
    expect(w.hit({ x: hMidX, y: hMidY })).toEqual({ group: g2, part: 'header' });

    // 3. Focus loose 'd': 'd' rises above both groups, so its body occludes both headers AND gid's buried divider.
    w.focus('d');
    expect(w.terminal('d').position.z - 1.0).toBeGreaterThan(w.terminal('c').position.z + 0.1);
    expect(w.hit({ x: hMidX, y: hMidY })).toEqual({ id: 'd', part: 'body' });
    expect(w.hit(divPt)).toEqual({ id: 'd', part: 'body' });
});
