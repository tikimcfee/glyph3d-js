// wall-layout.test.mjs — the wall's pure geometry: flow placement, framing, border grabs, cycling,
// and border-drag resize. Run: bun test tools/wall-layout.test.mjs
import { test, expect } from 'bun:test';
import {
    freeFlowSlot, fitRect, unionRect, edgesAt, hitTest, cycle, resizeFromDrag, overlaps, FLOW_GAP, FLOW_COLUMNS,
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
