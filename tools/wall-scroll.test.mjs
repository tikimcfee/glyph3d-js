// wall-scroll.test.mjs — proportional sub-line accumulation and discrete-notch momentum stepping
// (wall/terminalScroll.js + WallPointer + WallKeys): trackpad pixel deltas accumulate proportionally
// to the terminal's rendered row height and preserve OS momentum tails without clamping 1 px events
// to ±1 line; horizontal drift (dy = 0) emits nothing; line/page deltaModes and scrollMultiplier scale
// cleanly; direction reversals and idle gaps clear stale remainders; discrete mouse wheel notches emit
// an immediate lead line then glide the rest across step(dt) with exact line conservation, halting on
// keypress, focus change, or reversal. Run: bun test tools/wall-scroll.test.mjs
import { test, expect } from 'bun:test';
import TerminalScroller, { WheelStreamGate, wheelDeltaLines, STREAM_IDLE_MS } from '../wall/terminalScroll.js';
import WallPointer from '../wall/WallPointer.js';
import WallKeys from '../wall/WallKeys.js';
import { WALL_CONFIG, checkConfig } from '../wall/wallConfig.js';

test('wheelDeltaLines scales pixel, line and page modes and clamps extreme rowPx', () => {
    expect(wheelDeltaLines(0, 0, { rowPx: 18 })).toBe(0);
    expect(wheelDeltaLines(-18, 0, { rowPx: 18 })).toBe(1);
    expect(wheelDeltaLines(9, 0, { rowPx: 18 })).toBeCloseTo(-0.5);
    expect(wheelDeltaLines(-18, 0, { rowPx: 18, multiplier: 2 })).toBe(2);
    // Clamped to [12, 36] px/line so zoomed-out micro-terminals don't rocket.
    expect(wheelDeltaLines(-12, 0, { rowPx: 2 })).toBe(1);
    expect(wheelDeltaLines(-36, 0, { rowPx: 90 })).toBe(1);
    // deltaMode 1 (lines) and 2 (pages of rows - 2).
    expect(wheelDeltaLines(-3, 1, { multiplier: 1.5 })).toBeCloseTo(4.5);
    expect(wheelDeltaLines(1, 2, { rows: 24 })).toBe(-22);
    // checkConfig validates scrollMultiplier > 0 and <= 10.
    expect(checkConfig('scrollMultiplier', '1.5')).toBe(1.5);
    expect(() => checkConfig('scrollMultiplier', '0')).toThrow(/scrollMultiplier/);
});

test('trackpad streams accumulate sub-line fractions proportionally and taper OS momentum tails cleanly', () => {
    const events = [];
    const scroller = new TerminalScroller((id, lines, cell) => events.push({ id, lines, x: cell.x, y: cell.y }));
    const cell = { x: 4, y: 5 };
    let now = 1000;

    // Slow 3 px nudges at rowPx = 18: 5 nudges (15 px) emit nothing yet; the 6th (18 px) steps +1 line!
    for (let i = 0; i < 5; i++) {
        expect(scroller.wheel('t1', -3, 0, cell, { rowPx: 18, now: (now += 8), glide: true })).toBe(0);
    }
    expect(events).toEqual([]);
    expect(scroller.wheel('t1', -3, 0, cell, { rowPx: 18, now: (now += 8), glide: true })).toBe(1);
    expect(events).toEqual([{ id: 't1', lines: 1, x: 4, y: 5 }]);

    // Fast trackpad flick + OS momentum tail (including peak > 80 px mid-stream): stays direct, zero synthetic lag,
    // and tapers smoothly at the tail instead of firing 1 line per 1 px event.
    events.length = 0;
    const flick = [-20, -96, -54, -18, -8, -5, -3, -2];   // sum = -206 px → 206 / 18 = 11.444 lines → 11 whole lines
    for (const dy of flick) {
        scroller.wheel('t1', dy, 0, cell, { rowPx: 18, now: (now += 8), glide: true });
    }
    expect(scroller.gliding).toBe(false);
    const total = events.reduce((s, e) => s + e.lines, 0);
    expect(total).toBe(11);
    // Last two tiny tail events (-3, -2 px after 11*18 = 198 px already crossed at -8/-5) do not over-fire.
    expect(events.every((e) => e.lines > 0)).toBe(true);

    // Idle gap > STREAM_IDLE_MS clears leftover 0.444 remainder so a fresh 12 px nudge (< 18 px) doesn't jump early.
    events.length = 0;
    expect(scroller.wheel('t1', -12, 0, cell, { rowPx: 18, now: now + STREAM_IDLE_MS + 20, glide: true })).toBe(0);
    expect(events).toEqual([]);
});

test('discrete mouse wheel notches step 1 immediate line, glide the rest with exact conservation, and cancel on reversal', () => {
    const events = [];
    const scroller = new TerminalScroller((id, lines) => events.push({ id, lines }));
    const cell = { x: 2, y: 3 };

    // A -108 px mouse notch at rowPx = 18 asks for +6 lines: +1 immediately, +5 paced across step(dt) frames.
    const lead = scroller.wheel('t1', -108, 0, cell, { rowPx: 18, now: 100, glide: true });
    expect(lead).toBe(1);
    expect(scroller.gliding).toBe(true);
    expect(events.map((e) => e.lines)).toEqual([1]);

    let safety = 0;
    while (scroller.gliding && safety++ < 60) scroller.step(1 / 60);
    expect(scroller.gliding).toBe(false);
    expect(events.length).toBeGreaterThan(2);   // paced across multiple frames, not dumped at once
    expect(events.reduce((s, e) => s + e.lines, 0)).toBe(6);

    // Stacking two rapid notches (+4 lines each in deltaMode=1) builds momentum and lands at exact +8 lines.
    events.length = 0;
    scroller.wheel('t1', -4, 1, cell, { now: 500, glide: true });
    scroller.step(1 / 60);
    scroller.wheel('t1', -4, 1, cell, { now: 520, glide: true });
    safety = 0;
    while (scroller.gliding && safety++ < 60) scroller.step(1 / 60);
    expect(events.reduce((s, e) => s + e.lines, 0)).toBe(8);

    // Reversing direction mid-glide drops pending upward momentum immediately and steps downward.
    events.length = 0;
    scroller.wheel('t1', -6, 1, cell, { now: 900, glide: true });
    expect(scroller.gliding).toBe(true);
    const rev = scroller.wheel('t1', 4, 1, cell, { now: 910, glide: true });
    expect(rev).toBe(-1);
    while (scroller.gliding) scroller.step(1 / 60);
    expect(events.slice(1).reduce((s, e) => s + e.lines, 0)).toBe(-4);
});

test('WallPointer + WallKeys integration: dy = 0 horizontal swipe emits nothing, and typing halts wheel momentum', () => {
    const ran = [];
    const grid = {
        cols: 80, rows: 24, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
        cellStride: { x: 1, y: 2 },
        cellAt: (_x, _y, out = {}) => Object.assign(out, { x: 5, y: 6, col: 5, row: 6 }),
        sendKey: () => true,
        clearSelection() {},
    };
    const body = { minX: 0, maxX: 80, minY: -48, maxY: 0 };
    const wall = {
        _running: true,
        focusedId: 't1',
        config: { ...WALL_CONFIG },
        selection: new Set(),
        fullscreen: { id: null },
        isShown: (id) => id === 't1',
        terminal: (id) => (id === 't1' ? grid : null),
        terminalRect: () => body,
        router: { execute: (cmd) => ran.push(cmd) },
    };
    const camera = {
        canvas: { style: {}, addEventListener() {}, removeEventListener() {} },
        view: { w: 1000, h: 600 }, zoom: 10,
        camera: { position: { x: 0, y: 0 }, zoom: 10 },
        toWorld: (cx, cy) => ({ x: cx / 10, y: -cy / 10 }),
        panBy() {},
    };
    const pointer = new WallPointer(/** @type {any} */ (wall), /** @type {any} */ (camera));
    wall.pointer = pointer;
    const keys = new WallKeys(/** @type {any} */ (wall));

    // Pure horizontal wheel over focused terminal (deltaY = 0) never scrolls it up into history.
    pointer._onWheel({ clientX: 100, clientY: 100, deltaX: 25, deltaY: 0, deltaMode: 0, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} });
    expect(ran).toEqual([]);

    // Discrete notch starts gliding (+1 immediate, +4 pending at rowPx = 2 * 10 = 20); typing a key cancels the rest!
    pointer._onWheel({ clientX: 100, clientY: 100, deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} });
    expect(ran).toEqual([['terminal.scroll', 't1', '1', '5', '6']]);
    keys._key({ type: 'keydown', key: 'a', code: 'KeyA', repeat: false, isComposing: false, target: null, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, getModifierState: () => false, preventDefault() {}, stopPropagation() {} });
    for (let i = 0; i < 10; i++) pointer.step(1 / 60);
    expect(ran.length).toBe(1);   // no lingering scroll lines after typing!
});

test('exiting or entering fullscreen mid-flick (including opt+fling -> cmd+enter zoomies) quenches all leftover momentum', () => {
    const scrolled = [], panned = [], zoomed = [];
    const grid = {
        cols: 80, rows: 24, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
        cellStride: { x: 1, y: 2 },
        cellAt: (_x, _y, out = {}) => Object.assign(out, { x: 3, y: 4, col: 3, row: 4 }),
    };
    const body = { minX: 0, maxX: 80, minY: -48, maxY: 0 };
    const wall = {
        _running: true,
        focusedId: 't1',
        config: { ...WALL_CONFIG },
        selection: new Set(),
        fullscreen: { id: 't1' },
        isShown: (id) => id === 't1',
        terminal: (id) => (id === 't1' ? grid : null),
        terminalRect: () => body,
        router: { execute: (cmd) => { if (cmd[0] === 'terminal.scroll') scrolled.push(cmd); } },
    };
    const camera = {
        canvas: { style: {}, addEventListener() {}, removeEventListener() {} },
        view: { w: 1000, h: 600 }, zoom: 10,
        target: null,
        camera: { position: { x: 0, y: 0 }, zoom: 10 },
        toWorld: (cx, cy) => ({ x: cx / 10, y: -cy / 10 }),
        panBy(dx, dy) { this.target = null; panned.push([dx, dy]); },
        zoomAt(_cx, _cy, f) { this.target = null; zoomed.push(f); },
        wheelZoomAt(_cx, _cy, dy) { this.target = null; zoomed.push(dy); },
        easeTo(t) { this.target = t; },
    };
    const pointer = new WallPointer(/** @type {any} */ (wall), /** @type {any} */ (camera));
    const wheel = (dx, dy, now, cx = 900, cy = 400, more = {}) => pointer._onWheel({
        clientX: cx, clientY: cy, deltaX: dx, deltaY: dy, deltaMode: 0, _now: now,
        ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {}, ...more,
    });

    // Exact user repro: (opt + mousepad fling in fullscreen) -> (cmd + enter exit while fling crests & decays)!
    let t = 1000;
    wheel(0, -14, (t += 8), 900, 400, { altKey: true });   // opt+fling starts accelerating
    wheel(0, -28, (t += 8), 900, 400, { altKey: true });
    expect(zoomed).toEqual([]);                            // fullscreen disallowed zoom, AND gate recorded the stream!

    // cmd+enter exits fullscreen while fling is STILL cresting upward (-28 -> -75 -> -90 -> decay),
    // with metaKey (from cmd+enter) and/or altKey still riding the inertial wheel events!
    wall.fullscreen.id = null;
    camera.easeTo({ x: 0, y: 0, zoom: 10 });
    pointer.quenchWheel(t);

    for (const [dy, mods] of [
        [-75, { altKey: true, metaKey: true }],
        [-90, { metaKey: true }],
        [-64, { metaKey: true }],
        [-42, { altKey: true }],
        [-24, {}],
        [-10, {}],
        [-3, {}],
    ]) {
        wheel(0, dy, (t += 8), 900, 400, mods);
    }
    expect(zoomed).toEqual([]);                            // ZERO zoomies!
    expect(panned).toEqual([]);                            // ZERO stray pan!
    expect(scrolled).toEqual([]);
    expect(camera.target).toEqual({ x: 0, y: 0, zoom: 10 });

    // After >120ms, a deliberate fresh flick in the opposite direction (+40) releases quench immediately.
    t += 130;
    wheel(0, 40, t);
    expect(panned).toEqual([[0, 40]]);

    // Plain fling on canvas, then pressing ⌘ (metaKey) 40ms BEFORE hitting ↵: holding ⌘ mid-momentum
    // does NOT turn the coasting scroll into zoomies, while genuine Ctrl+wheel pinch still zooms!
    panned.length = 0;
    zoomed.length = 0;
    t += STREAM_IDLE_MS + 50;
    wheel(0, 30, (t += 8));                                // plain pan starts
    wheel(0, 24, (t += 8), 900, 400, { metaKey: true });   // thumb presses ⌘ on the way to ⌘↵: NO zoomies!
    expect(zoomed).toEqual([]);
    expect(panned.length).toBe(2);
    wheel(0, -20, (t += 8), 900, 400, { ctrlKey: true });  // genuine trackpad pinch (ctrlKey) DOES zoom!
    expect(zoomed.length).toBe(1);

    // After STREAM_IDLE_MS of quiet, normal scrolling in fullscreen works right away.
    wall.fullscreen.id = 't1';
    scrolled.length = 0;
    wheel(0, -40, (t += STREAM_IDLE_MS + 20));
    expect(scrolled.length).toBe(1);
});

test('canvas wheel target latching keeps pan vs terminal scroll bound across sliding content and focus loss', () => {
    const gate = new WheelStreamGate();
    let t = 500;
    // Start a pan on empty canvas at (300, 300).
    expect(gate.accept(0, 30, { now: (t += 8) }).ok).toBe(true);
    expect(gate.canvasTarget(300, 300, null)).toEqual({ kind: 'pan', x: 300, y: 300 });
    // Focused terminal 't1' slides underneath stationary cursor (300, 300) mid-pan: stays 'pan'!
    expect(gate.accept(0, 24, { now: (t += 8) }).ok).toBe(true);
    expect(gate.canvasTarget(300, 300, 't1').kind).toBe('pan');
    // Physically moving the mouse pointer > 24 px onto 't1' re-evaluates immediately!
    expect(gate.accept(0, 20, { now: (t += 8) }).ok).toBe(true);
    expect(gate.canvasTarget(340, 300, 't1')).toEqual({ kind: 'terminal', id: 't1', x: 340, y: 300 });
});
