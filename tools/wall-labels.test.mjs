// wall-labels.test.mjs — map-style label placement: no label overlaps another, preferred side
// first, sticky choice, strict-then-relaxed, hidden when nowhere fits, leader lines only when
// detached. Run: bun test tools/wall-labels.test.mjs
import { test, expect } from 'bun:test';
import { placeLabels, candidateBox, leaderFor, boxesOverlap, CANDIDATES } from '../wall/labelPlacement.js';

const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });
const view = { w: 1000, h: 800, margin: 4, gap: 4 };

test('a lone label sits above its target, touching (no leader)', () => {
    const t = box(100, 100, 50, 30);
    const p = placeLabels([{ id: 'a', target: t, w: 80, h: 16 }], view).get('a');
    expect(p.cand).toBe('above');
    expect(p.box).toEqual(candidateBox('above', t, 80, 16, 4));
    expect(p.leader).toBeNull();
});

test('crowded targets: no two labels ever overlap, and the first keeps its preferred side', () => {
    // A tight row of tiny targets — every "above" slot collides with a neighbour's label.
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, target: box(200 + i * 30, 300, 20, 14), w: 70, h: 16 }));
    const out = placeLabels(items, view);
    expect(out.get('t0').cand).toBe('above');
    const boxes = [...out.values()].filter(Boolean).map((p) => p.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(boxes[i], boxes[j])).toBe(false);
    for (const p of out.values()) if (p) for (const b of [p.box]) expect(b.left >= 4 && b.right <= 996 && b.top >= 4 && b.bottom <= 796).toBe(true);
});

test('the choice is sticky: last frame\'s side is retried first while it stays free', () => {
    const t = box(100, 100, 50, 30);
    const p = placeLabels([{ id: 'a', target: t, w: 80, h: 16 }], view, new Map([['a', 'right']])).get('a');
    expect(p.cand).toBe('right');
});

test('strict pass avoids covering other targets; relaxed pass allows it before hiding', () => {
    // Target b fills the space above a; a's label must avoid b if any other side is free.
    const a = box(100, 100, 50, 30), b = box(90, 60, 200, 36);
    const out = placeLabels([{ id: 'a', target: a, w: 80, h: 16 }], view, new Map(), [a, b]);
    expect(boxesOverlap(out.get('a').box, b)).toBe(false);
    // Boxed in on every side by the viewport → relaxed placement still finds nothing → hidden.
    const tiny = { w: 60, h: 40, margin: 4, gap: 4 };
    const hidden = placeLabels([{ id: 'x', target: box(10, 10, 40, 20), w: 200, h: 16 }], tiny);
    expect(hidden.get('x')).toBeNull();
});

test('relaxed fallback prefers the detached ring (with a trace line) over hugging a neighbour', () => {
    // A tight 3×3 grid: the middle target's every adjacent slot sits on a neighbour.
    const targets = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) targets.push(box(300 + c * 70, 300 + r * 50, 60, 40));
    const mid = targets[4];
    const out = placeLabels([{ id: 'mid', target: mid, w: 90, h: 16 }], view, new Map(), targets);
    const p = out.get('mid');
    expect(['above2', 'below2']).toContain(p.cand);
    expect(p.leader).not.toBeNull();
});

test('leader runs from the label edge to the nearest point on the target border', () => {
    const t = box(100, 100, 50, 30);
    const far = { left: 300, top: 110, right: 360, bottom: 126 };   // to the right, detached
    const l = leaderFor(far, t);
    expect(l).toEqual({ x1: 300, y1: 118, x2: 150, y2: 118 });
    expect(leaderFor(candidateBox('above', t, 80, 16, 0), t)).toBeNull();   // touching → none
});

test('every candidate is reachable and known', () => {
    for (const c of CANDIDATES) expect(() => candidateBox(c, box(0, 0, 1, 1), 1, 1, 1)).not.toThrow();
    expect(() => candidateBox('nope', box(0, 0, 1, 1), 1, 1, 1)).toThrow();
});
