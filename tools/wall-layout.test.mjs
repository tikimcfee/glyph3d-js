// wall-layout.test.mjs — the wall's pure geometry: flow placement, framing, border grabs, cycling,
// border-drag resize, group tiling, tile drops and lasso hit-testing. Run: bun test tools/wall-layout.test.mjs
import { test, expect } from 'bun:test';
import {
    freeFlowSlot, fitRect, unionRect, edgesAt, hitTest, cycle, resizeFromDrag, overlaps, FLOW_GAP, FLOW_COLUMNS,
    tileLayout, nearestPlace, lassoTouches, pointInPolygon, padRect, BAR_ROOM, FULLSCREEN_Z,
    normalizeZOrder, zStackLayout, zPositions, readingOrder,
} from '../wall/wallLayout.js';

const rect = (x, y, w, h) => ({ minX: x, maxX: x + w, maxY: y, minY: y - h });

test('flow fills a row left to right, then wraps', () => {
    const taken = [];
    const slots = [];
    for (let i = 0; i < FLOW_COLUMNS + 1; i++) {
        const s = freeFlowSlot(100, 50, taken);
        slots.push(s);
        taken.push(rect(s.x, s.y, 100, 50));
    }
    expect(slots[0]).toEqual({ x: 0, y: 0 });
    expect(slots[1]).toEqual({ x: 100 + FLOW_GAP, y: 0 });
    expect(slots[FLOW_COLUMNS]).toEqual({ x: 0, y: -(50 + FLOW_GAP) });
});

test('a terminal the person moved is flowed around, never overlapped', () => {
    const moved = rect(10, -5, 100, 50);   // sits across slot 0 and slot 1
    const s = freeFlowSlot(100, 50, [moved]);
    expect(overlaps(rect(s.x, s.y, 100, 50), moved)).toBe(false);
});

test('freeFlowSlot scans from a custom viewport origin and keeps zero coordinates +0', () => {
    const origin = { x: 800, y: -600 };
    const taken = [rect(800, -600, 100, 50)];   // occupies slot 0 at the viewport origin
    const s1 = freeFlowSlot(100, 50, taken, origin);
    expect(s1).toEqual({ x: 800 + 100 + FLOW_GAP, y: -600 });
    taken.push(rect(s1.x, s1.y, 100, 50));
    const s2 = freeFlowSlot(100, 50, taken, origin);
    taken.push(rect(s2.x, s2.y, 100, 50));
    const s3 = freeFlowSlot(100, 50, taken, origin);
    expect(s3).toEqual({ x: 800, y: -600 - (50 + FLOW_GAP) });
    // Row 1 landing exactly at y = 0 produces +0, never -0.
    const z = freeFlowSlot(100, 50, [rect(0, 50 + FLOW_GAP, 400, 50)], { x: -0, y: 50 + FLOW_GAP });
    expect(Object.is(z.x, 0)).toBe(true);
    expect(Object.is(z.y, 0)).toBe(true);
});

test('fitRect centers and fits the tighter axis', () => {
    const f = fitRect(rect(0, 0, 200, 100), 1000, 1000, 1);
    expect(f).toEqual({ x: 100, y: -50, zoom: 5 });
});

test('fitRect with a ceiling: a small rect frames centred at the cap, a big one still fits', () => {
    expect(fitRect(rect(0, 0, 200, 100), 1000, 1000, 1, 3)).toEqual({ x: 100, y: -50, zoom: 3 });
    expect(fitRect(rect(0, 0, 2000, 1000), 1000, 1000, 1, 3).zoom).toBe(0.5);   // under the cap: fit wins
});

test('unionRect spans all rects; empty → null', () => {
    expect(unionRect([])).toBeNull();
    expect(unionRect([rect(0, 0, 10, 10), rect(20, 5, 10, 10)])).toEqual({ minX: 0, maxX: 30, minY: -10, maxY: 5 });
});

test('edgesAt grabs the border band from both sides, corners grab two edges', () => {
    const r = rect(0, 0, 100, 50);
    expect(edgesAt(r, 101, -25, 2)).toEqual({ left: false, right: true, top: false, bottom: false });
    expect(edgesAt(r, 99, -25, 2)?.right).toBe(true);
    expect(edgesAt(r, 50, -25, 2)).toBeNull();           // body, not border
    expect(edgesAt(r, 200, -25, 2)).toBeNull();          // far outside
    const corner = edgesAt(r, 100, -50, 2);
    expect(corner.right && corner.bottom).toBe(true);
});

test('hitTest: the terminal on top keeps its body where another\'s border band reaches under it', () => {
    // b (focused, on top) overlaps a's right edge: a's band at x=100 lies inside b's body.
    const a = { id: 'a', body: rect(0, 0, 100, 50), window: rect(0, 4, 100, 54) };
    const b = { id: 'b', body: rect(80, -10, 100, 30), window: rect(80, -6, 100, 34) };
    expect(hitTest([b, a], 100, -20, 2)).toEqual({ id: 'b', part: 'body' });
    // Beneath order, a's edge wins the same point — stacking order is the whole rule.
    expect(hitTest([a, b], 100, -20, 2)).toMatchObject({ id: 'a', part: 'edge' });
    // Off b, a's edge is a's.
    expect(hitTest([b, a], 100, -45, 2)).toMatchObject({ id: 'a', part: 'edge', edges: { right: true } });
    // The window above the body is the title bar; the top of the window is an edge.
    expect(hitTest([b, a], 40, 2, 1)).toEqual({ id: 'a', part: 'title' });
    expect(hitTest([b, a], 40, 4, 1)).toMatchObject({ id: 'a', part: 'edge', edges: { top: true } });
    expect(hitTest([b, a], 500, 500, 2)).toBeNull();
});

test('cycle wraps both ways and starts sensibly with no focus', () => {
    const o = ['a', 'b', 'c'];
    expect(cycle(o, 'c', +1)).toBe('a');
    expect(cycle(o, 'a', -1)).toBe('c');
    expect(cycle(o, null, +1)).toBe('a');
    expect(cycle(o, null, -1)).toBe('c');
    expect(cycle([], null, 1)).toBeNull();
    // next then previous lands where you started — cycling is reversible by construction
    for (const id of o) expect(cycle(o, cycle(o, id, +1), -1)).toBe(id);
});

test('right/bottom drags grow away from the origin; left/top drags shift to keep the far edge still', () => {
    const stride = { x: 1, y: 2 };
    const start = { cols: 80, rows: 24 };
    const min = { minCols: 20, minRows: 5 };
    expect(resizeFromDrag({ right: true }, start, stride, 10.4, 0, min)).toEqual({ cols: 90, rows: 24, shiftX: 0, shiftY: 0 });
    expect(resizeFromDrag({ bottom: true }, start, stride, 0, -8, min)).toEqual({ cols: 80, rows: 28, shiftX: 0, shiftY: 0 });
    const left = resizeFromDrag({ left: true }, start, stride, -5, 0, min);
    expect(left).toEqual({ cols: 85, rows: 24, shiftX: -5, shiftY: 0 });
    const top = resizeFromDrag({ top: true }, start, stride, 0, 4, min);
    expect(top).toEqual({ cols: 80, rows: 26, shiftX: 0, shiftY: 4 });
    expect(resizeFromDrag({ right: true }, start, stride, -500, 0, min).cols).toBe(20);   // clamped
});

test('a tiling packs members row-major in N columns, edge to edge, a bar of room above each row', () => {
    const sizes = [{ w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 50 }];
    const { places, extent } = tileLayout(sizes, { origin: { x: 10, y: 20 }, columns: 2, gap: 2, barRoom: 8 });
    expect(places).toEqual([
        { x: 10, y: 12 },                 // first body: under its bar's room
        { x: 112, y: 12 },                // + width + gap
        { x: 10, y: 20 - 58 - 2 - 8 },    // next row: down a window (body + bar) and a gap
    ]);
    expect(extent).toEqual({ minX: 10, maxX: 212, maxY: 20, minY: 20 - 2 * 58 - 2 });
    // Every window (body + bar room) is disjoint from the others: nothing overlaps.
    const wins = places.map((p, i) => ({ minX: p.x, maxX: p.x + sizes[i].w, maxY: p.y + 8, minY: p.y - sizes[i].h }));
    for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) expect(overlaps(wins[i], wins[j])).toBe(false);
});

test('a tiling of mixed sizes lines up as a table: columns as wide as their widest, rows as tall as their tallest', () => {
    const sizes = [{ w: 80, h: 40 }, { w: 120, h: 60 }, { w: 100, h: 30 }, { w: 60, h: 20 }];
    const { places } = tileLayout(sizes, { origin: { x: 0, y: 0 }, columns: 2, gap: 0, barRoom: 10 });
    expect(places[1].x).toBe(100);                 // column 0 is 100 wide (its widest member, the third)
    expect(places[3].x).toBe(100);
    expect(places[2].y).toBe(-(60 + 10) - 10);     // row 0 is 70 tall (the second member's window)
    expect(places[0].y).toBe(places[1].y);
});

test('a tiling defaults its bar room to BAR_ROOM, clamps columns to its size, and refuses nonsense', () => {
    const { places } = tileLayout([{ w: 10, h: 10 }], { origin: { x: 0, y: 0 }, columns: 4, gap: 1 });
    expect(places).toEqual([{ x: 0, y: -BAR_ROOM }]);
    expect(tileLayout([], { origin: { x: 0, y: 0 }, columns: 2, gap: 0 })).toEqual({ places: [], extent: null });
    expect(() => tileLayout([{ w: 1, h: 1 }], { origin: { x: 0, y: 0 }, columns: 0, gap: 0 })).toThrow(/columns/);
    expect(() => tileLayout([{ w: 1, h: 1 }], { origin: { x: 0, y: 0 }, columns: 1.5, gap: 0 })).toThrow(/columns/);
    expect(() => tileLayout([{ w: 1, h: 1 }], { origin: { x: 0, y: 0 }, columns: 1, gap: -1 })).toThrow(/gap/);
});

test('a dropped tile goes to the nearest place', () => {
    const centres = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: -100 }];
    expect(nearestPlace(centres, { x: 90, y: -20 })).toBe(1);
    expect(nearestPlace(centres, { x: -5, y: -80 })).toBe(2);
    expect(nearestPlace([], { x: 0, y: 0 })).toBe(-1);
});

test('a lasso touches a rect it crosses, encloses, or reaches into — and nothing it only passes by', () => {
    const r = rect(0, 0, 10, 10);   // x 0..10, y -10..0
    const around = [{ x: -5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: -15 }, { x: -5, y: -15 }];
    expect(lassoTouches(around, r)).toBe(true);                                                  // encloses it
    expect(lassoTouches([{ x: 5, y: 20 }, { x: 5, y: -20 }, { x: 6, y: -20 }], r)).toBe(true);   // a sliver across it
    expect(lassoTouches([{ x: 2, y: -2 }, { x: 30, y: -2 }, { x: 30, y: -8 }], r)).toBe(true);   // starts inside
    expect(lassoTouches([{ x: 20, y: 5 }, { x: 40, y: 5 }, { x: 40, y: -15 }, { x: 20, y: -15 }], r)).toBe(false);
    // A concave lasso whose notch holds the rect, its outline passing it by on three sides: untouched.
    const u = [{ x: -10, y: 10 }, { x: -2, y: 10 }, { x: -2, y: -12 }, { x: 12, y: -12 }, { x: 12, y: 10 }, { x: 20, y: 10 }, { x: 20, y: -20 }, { x: -10, y: -20 }];
    expect(lassoTouches(u, r)).toBe(false);
    expect(lassoTouches([], r)).toBe(false);
    expect(lassoTouches([{ x: 1, y: -1 }], r)).toBe(true);
    expect(pointInPolygon(around, 0, 0)).toBe(true);
    expect(padRect(r, 2)).toEqual({ minX: -2, maxX: 12, minY: -12, maxY: 2 });
});

test('readingOrder walks horizontal row bands top to bottom and left to right within each band', () => {
    // Row 0: 'b' at x=120 y=0 and slightly nudged 'a' at x=0 y=-6 (88% vertical overlap → same band, a before b).
    // Row 1: 'd' at x=120 y=-70 and 'c' at x=0 y=-72.
    const items = [
        { id: 'd', rect: rect(120, -70, 100, 50) },
        { id: 'b', rect: rect(120, 0, 100, 50) },
        { id: 'c', rect: rect(0, -72, 100, 50) },
        { id: 'a', rect: rect(0, -6, 100, 50) },
    ];
    expect(readingOrder(items)).toEqual(['a', 'b', 'c', 'd']);
    expect(readingOrder([])).toEqual([]);
    expect(readingOrder([{ id: 'solo', rect: rect(0, 0, 10, 10) }])).toEqual(['solo']);
});

test('zPositions clears each window\'s scaled -0.5 background + +0.05 cursor sandwich, and lifts fullscreen to FULLSCREEN_Z', () => {
    const scales = { a: 2, b: 2, c: 4, d: 2 };
    const z4 = zPositions(['a', 'b', 'c', 'd'], 'b', (id) => scales[id]);
    expect(z4.get('b')).toBe(FULLSCREEN_Z);
    // Non-fullscreen order ['a', 'c', 'd']: each upper window's world background (z - 0.5*scaleZ) sits
    // strictly ahead of the lower window's frontmost cursor/label (z + 0.05*scaleZ).
    const order = ['a', 'c', 'd'];
    expect(z4.get('a') - 0.5 * scales.a).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < order.length; i++) {
        const lo = order[i - 1], hi = order[i];
        const loFront = z4.get(lo) + 0.05 * scales[lo];
        const hiBack = z4.get(hi) - 0.5 * scales[hi];
        expect(hiBack - loFront).toBeGreaterThanOrEqual(1.49);
    }
    // Even with 250 live gridScale=2 terminals, every adjacent pair keeps >= 0.25 world units of pure air
    // between their sandwiches, and stays strictly below FULLSCREEN_Z.
    const many = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const zm = zPositions(many);
    for (let i = 1; i < many.length; i++) {
        const loFront = zm.get(many[i - 1]) + 0.05 * 2;
        const hiBack = zm.get(many[i]) - 0.5 * 2;
        expect(hiBack - loFront).toBeGreaterThanOrEqual(0.249);
    }
    expect(zm.get(many.at(-1))).toBeLessThan(FULLSCREEN_Z - 10);
});

test('normalizeZOrder and zStackLayout keep group members contiguous and sandwich group frames + headers cleanly', () => {
    const groupsOf = { a: 'g1', b: 'g1', c: null, d: 'g2', e: 'g2' };
    // Focusing 'b' after 'd' pulls all of g1 ([a, b]) ahead of g2 and c, preserving [a, b] within g1.
    expect(normalizeZOrder(['a', 'c', 'd', 'e', 'b'], (id) => groupsOf[id])).toEqual(['c', 'd', 'e', 'a', 'b']);

    const { order, terminals, groups } = zStackLayout(['a', 'c', 'd', 'e', 'b'], {
        scaleOf: () => 2,
        groupOf: (id) => groupsOf[id],
    });
    expect(order).toEqual(['c', 'd', 'e', 'a', 'b']);
    // Back-to-front stack: loose 'c' < g2 frame+header < 'd' < 'e' < g1 frame+header < 'a' < 'b'.
    const cFront = terminals.get('c') + 0.1;
    const g2Back = groups.get('g2'), g2Front = g2Back + 0.25;
    const dBack = terminals.get('d') - 1.0, eFront = terminals.get('e') + 0.1;
    const g1Back = groups.get('g1'), g1Front = g1Back + 0.25;
    const aBack = terminals.get('a') - 1.0, aFront = terminals.get('a') + 0.1, bBack = terminals.get('b') - 1.0;

    expect(g2Back).toBeGreaterThan(cFront);     // g2's backdrop & header occlude loose 'c' behind it
    expect(dBack).toBeGreaterThan(g2Front);     // g2's own members sit strictly in front of g2's header/backdrop
    expect(g1Back).toBeGreaterThan(eFront);     // g1's backdrop & header occlude all of g2 (members + title)
    expect(aBack).toBeGreaterThan(g1Front);     // g1's backmost member clears g1's header
    expect(bBack).toBeGreaterThan(aFront);      // g1's frontmost member clears its sibling
});
