// wall-snap.test.mjs — the drafting grid's math (wall/wallSnap.js) and the pointer's use of it, headless:
// which levels draw at a zoom (a hard switch at gridMinPx), the step a drag snaps to, a move landing the
// body's top-left on a crossing, a border drag landing the dragged edge on or just inside its line in
// whole cells (the opposite edge still), and the pointer on a stand-in wall: a title-bar drag snaps, Ctrl
// held inverts it (and pressing or letting go of Ctrl mid-drag re-places the terminal), snap off doesn't
// snap, a tiled member doesn't, a resize snaps its edge, a group's header drag lands its corner.
// Run: bun test tools/wall-snap.test.mjs
import { test, expect } from 'bun:test';
import { gridLevels, snapStep, snapTo, snapMove, snapResize } from '../wall/wallSnap.js';
import { resizeFromDrag } from '../wall/wallLayout.js';
import { WALL_CONFIG } from '../wall/wallConfig.js';
import WallPointer from '../wall/WallPointer.js';

const G = { gridMinor: 4, gridMajorEvery: 5, gridMinPx: 6 };
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('levels: each draws only while its spacing on screen is at least gridMinPx — a hard switch', () => {
    expect(gridLevels(G, 4)).toMatchObject({ minor: true, major: true, minorPx: 16, majorPx: 80 });
    expect(gridLevels(G, 1.5)).toMatchObject({ minor: true, major: true });            // 6 px: exactly the floor draws
    expect(gridLevels(G, 1.49)).toMatchObject({ minor: false, major: true });          // just under: minor gone, no fade
    expect(gridLevels(G, 0.3)).toMatchObject({ minor: false, major: true });           // major at 6 px
    expect(gridLevels(G, 0.29)).toMatchObject({ minor: false, major: false });
    expect(gridLevels({ ...G, gridMajorEvery: 1 }, 4)).toMatchObject({ minor: false, major: true });   // every line major
    expect(gridLevels({ ...G, gridMinPx: 0 }, 0.05)).toMatchObject({ minor: true, major: true });
});

test('the snap step is the minor spacing while minor lines draw, else the major', () => {
    expect(snapStep(G, 4)).toBe(4);
    expect(snapStep(G, 1.5)).toBe(4);
    expect(snapStep(G, 1)).toBe(20);
    expect(snapStep(G, 0.01)).toBe(20);
});

test('a move puts the body\'s top-left on the nearest crossing; the size is untouched', () => {
    expect(snapTo(5.9, 4)).toBe(4);
    expect(snapTo(6.1, 4)).toBe(8);
    expect(Object.is(snapTo(-1, 4), 0)).toBe(true);   // never −0
    const r = { minX: 13.1, maxX: 113.1, maxY: -9.7, minY: -59.7 };
    const s = snapMove(r, 4);
    expect(near(r.minX + s.x, 12) && near(r.maxY + s.y, -8)).toBe(true);
    expect(snapMove({ minX: 8, maxX: 50, maxY: -4, minY: -30 }, 4)).toEqual({ x: 0, y: 0 });
});

// A body: 80 × 24 cells of 1.2 × 2.4 plus 0.6 of panel padding each way, its top-left on a crossing.
const stride = { x: 1.2, y: 2.4 };
const start = { cols: 80, rows: 24 };
const body = { minX: 0, maxX: 80 * 1.2 + 0.6, maxY: 0, minY: -(24 * 2.4 + 0.6) };
const MIN = { minCols: 20, minRows: 5 };
const widthOf = (cols) => cols * stride.x + 0.6, heightOf = (rows) => rows * stride.y + 0.6;

test('resize by the right edge: the edge goes to the nearest line and lands on or inside it, in whole cells', () => {
    for (const dx of [-30, -7.3, -1, 0, 0.4, 3.3, 9.99, 25]) {
        const r = snapResize({ right: true }, body, start, stride, dx, 0, MIN, 4);
        const line = snapTo(body.maxX + dx, 4);
        const edge = body.minX + widthOf(r.cols);
        expect(Number.isInteger(r.cols)).toBe(true);
        expect(edge).toBeLessThanOrEqual(line + 1e-9);   // at or inside the line…
        expect(line - edge).toBeLessThan(stride.x);       // …by less than a cell
        expect(r).toMatchObject({ rows: 24, shiftX: 0, shiftY: 0 });
    }
});

test('resize by the left / top edge: the dragged edge on or inside its line, the opposite edge still', () => {
    for (const dx of [-13, -4.1, 2, 11]) {
        const r = snapResize({ left: true }, body, start, stride, dx, 0, MIN, 4);
        const line = snapTo(body.minX + dx, 4);
        const left = body.minX + r.shiftX;                 // the position moves by the shift…
        expect(near(left + widthOf(r.cols), body.maxX)).toBe(true);   // …so the right edge stays
        expect(left).toBeGreaterThanOrEqual(line - 1e-9);
        expect(left - line).toBeLessThan(stride.x);
    }
    for (const dy of [-9, 3, 14]) {
        const r = snapResize({ top: true }, body, start, stride, 0, dy, MIN, 4);
        const line = snapTo(body.maxY + dy, 4);
        const top = body.maxY + r.shiftY;
        expect(near(top - heightOf(r.rows), body.minY)).toBe(true);   // the bottom stays
        expect(top).toBeLessThanOrEqual(line + 1e-9);
        expect(line - top).toBeLessThan(stride.y);
    }
    const b = snapResize({ bottom: true }, body, start, stride, 0, -10, MIN, 4);
    const bottomLine = snapTo(body.minY - 10, 4);
    expect(body.maxY - heightOf(b.rows)).toBeGreaterThanOrEqual(bottomLine - 1e-9);
    expect(b.shiftY).toBe(0);
});

test('a corner drags both edges; the smallest size holds even past the line', () => {
    const r = snapResize({ right: true, bottom: true }, body, start, stride, 10, -10, MIN, 4);
    expect(r.cols).toBeGreaterThan(80);
    expect(r.rows).toBeGreaterThan(24);
    expect(snapResize({ right: true }, body, start, stride, -500, 0, MIN, 4).cols).toBe(20);
    // The unsnapped drag rounds to the nearest cell, wherever that is.
    expect(resizeFromDrag({ right: true }, start, stride, 1.3, 0, MIN).cols).toBe(81);
});

// ── the pointer, on a stand-in wall ─────────────────────────────────────────

/** A wall with one 100 × 50 terminal whose position is its body's top-left, at zoom 4 px per unit. */
function standIn({ snap = true, tiled = false } = {}) {
    const grid = { position: { x: 1, y: -1 }, cols: 80, rows: 24 };
    const resizes = [];
    const groupMoves = [];
    const wall = {
        config: { ...WALL_CONFIG, snap },
        terminal: (id) => (id === 't' ? grid : null),
        terminalRect: () => ({ minX: grid.position.x, maxX: grid.position.x + widthOf(grid.cols), maxY: grid.position.y, minY: grid.position.y - heightOf(grid.rows) }),
        groups: {
            tiles: () => tiled,
            shownMembers: () => ['t'],
            dragTo: (_start, dx, dy) => groupMoves.push({ dx, dy }),
        },
        store: { group: () => ({}) },
        router: { execute: (cmd) => { resizes.push(cmd); } },
    };
    const camera = {
        canvas: {}, zoom: 4, camera: { position: { x: 0, y: 0 } },
        toWorld: (x, y) => ({ x: x / 4, y: -y / 4 }),
    };
    const pointer = new WallPointer(wall, camera);
    return { wall, grid, pointer, resizes, groupMoves };
}
const press = (p, gesture) => {
    p.pointer._drag = { pointerId: 1, startX: 0, startY: 0, startWorld: { x: 0, y: 0 }, moved: false, ...gesture };
};
const move = (p, clientX, clientY, ctrlKey = false) => p.pointer._onMove({ clientX, clientY, ctrlKey });

test('a title-bar drag snaps the body\'s top-left to the grid; Ctrl held inverts it, live', () => {
    const p = standIn();
    press(p, { kind: 'press', id: 't', startPos: { x: 1, y: -1 } });
    move(p, 41, 0);                                 // 10.25 world units right: the corner to (12, 0)
    expect(p.grid.position).toEqual({ x: 12, y: 0 });
    move(p, 41, 0, true);                           // Ctrl held: free
    expect(p.grid.position).toEqual({ x: 11.25, y: -1 });
    p.pointer._snapKey({ key: 'Control', ctrlKey: false });   // Ctrl let go, the pointer still: snapped again
    expect(p.grid.position).toEqual({ x: 12, y: 0 });
    p.pointer._snapKey({ key: 'Control', ctrlKey: true });
    expect(p.grid.position).toEqual({ x: 11.25, y: -1 });
});

test('snap off: no snap — and Ctrl held snaps', () => {
    const p = standIn({ snap: false });
    press(p, { kind: 'press', id: 't', startPos: { x: 1, y: -1 } });
    move(p, 41, 0);
    expect(p.grid.position).toEqual({ x: 11.25, y: -1 });
    move(p, 41, 0, true);
    expect(p.grid.position).toEqual({ x: 12, y: 0 });
});

test("a tiled member's drag never snaps (its spot is its tile's)", () => {
    const p = standIn({ tiled: true });
    press(p, { kind: 'press', id: 't', startPos: { x: 1, y: -1 } });
    move(p, 41, 0);
    expect(p.grid.position).toEqual({ x: 11.25, y: -1 });
});

test('a border drag resizes to the snapped edge; a wobble inside the slop resizes nothing', () => {
    const p = standIn();
    press(p, { kind: 'resize', id: 't', edges: { right: true }, stride, start: { cols: 80, rows: 24 }, last: { cols: 80, rows: 24 }, startPos: { x: 1, y: -1 } });
    move(p, 2, 0);
    expect(p.resizes).toEqual([]);
    move(p, 30, 0);                                 // 7.5 units right: the edge (97.6 → 105.1) to the line at 104
    const cols = Number(p.resizes.at(-1)[2]);
    expect(p.resizes.at(-1).slice(0, 2)).toEqual(['terminal.resize', 't']);
    const edge = 1 + widthOf(cols);
    expect(edge).toBeLessThanOrEqual(104 + 1e-9);
    expect(104 - edge).toBeLessThan(stride.x);
    move(p, 30, 0, true);                           // Ctrl: the plain cell rounding
    expect(Number(p.resizes.at(-1)[2])).toBe(resizeFromDrag({ right: true }, { cols: 80, rows: 24 }, stride, 7.5, 0, MIN).cols);
});

test("a group's header drag lands the group's top-left body corner on the grid", () => {
    const p = standIn();
    press(p, { kind: 'group', group: 'g-1', groupDrag: {} });
    move(p, 41, -9);                                // (10.25, 2.25): the corner (1, -1) → (12, 0)
    expect(p.groupMoves.at(-1)).toEqual({ dx: 11, dy: 1 });
    move(p, 41, -9, true);
    expect(p.groupMoves.at(-1)).toEqual({ dx: 10.25, dy: 2.25 });
});
