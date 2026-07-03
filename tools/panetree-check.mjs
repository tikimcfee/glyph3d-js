// panetree-check.mjs — headless lock for the PaneTree binary-BSP compositor substrate.
//
// The tree is pure data (no THREE/DOM), so this needs no browser. It asserts the load-bearing
// invariants: leaves TILE the rect exactly (areas sum to 1, no pairwise overlap), splits cut at
// the ratio with y-UP (first = top), close COLLAPSES the sibling up (ratios preserved), resize
// nudges the nearest ancestor split on the axis (clamped), directional neighbor picks the
// geometric nearest, swap exchanges bindings in place, and serialize round-trips.
//
//   bun tools/panetree-check.mjs
//
// Per the debug-into-tools practice; sibling of dock-refresh-check / camera-billboard-check.

import { PaneTree } from '../packages/glyph3d-core/src/services/interaction/PaneTree.js';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (c) pass++; else fail++; };
const near = (a, b, m, eps = 1e-9) => ok(Math.abs(a - b) <= eps, `${m} (got ${a} want ${b})`);
const rectEq = (r, x, y, w, h, m) => ok(
    Math.abs(r.x - x) < 1e-9 && Math.abs(r.y - y) < 1e-9 && Math.abs(r.w - w) < 1e-9 && Math.abs(r.h - h) < 1e-9,
    `${m} (got ${JSON.stringify(r)} want {x:${x},y:${y},w:${w},h:${h}})`);

// TILING invariant: leaf rects fill the unit rect exactly with no overlap.
function assertTiles(tree, label) {
    const rects = [...tree.rects().values()];
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    near(area, 1, `${label}: leaf areas tile the rect (Σ area = 1)`);
    let overlap = false;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (ox * oy > 1e-9) overlap = true;
    }
    ok(!overlap, `${label}: no two leaves overlap`);
}

// ---- single leaf ----
{
    const t = PaneTree.leaf('a');
    ok(!t.isEmpty() && t.has('a') && t.count() === 1, 'single leaf: has/count');
    rectEq(t.rects().get('a'), 0, 0, 1, 1, 'single leaf fills the unit rect');
    assertTiles(t, 'single');
}

// ---- x split: side by side, first = left ----
{
    const t = PaneTree.leaf('a');
    ok(t.split('a', 'x', 'b'), 'x-split returns true');
    rectEq(t.rects().get('a'), 0, 0, 0.5, 1, 'x-split: a = left half');
    rectEq(t.rects().get('b'), 0.5, 0, 0.5, 1, 'x-split: b = right half');
    ok(!t.split('a', 'x', 'b'), 'split rejects a duplicate windowId');
    assertTiles(t, 'x-split');
}

// ---- y split: stacked, first = TOP (y-up) ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'y', 'c', { ratio: 0.5 });
    rectEq(t.rects().get('a'), 0, 0.5, 1, 0.5, 'y-split: a = TOP half (higher y)');
    rectEq(t.rects().get('c'), 0, 0, 1, 0.5, 'y-split: c = bottom half');
    assertTiles(t, 'y-split');
}

// ---- nested: {a | (b top / c bottom)} tiles cleanly ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'x', 'r', { ratio: 0.4 });   // a=left 0.4, r=right 0.6
    t.split('r', 'y', 'c', { ratio: 0.7 });   // r→ b(top 0.7)/c(bottom 0.3) — wait: 'r' leaf splits into r(top)/c(bottom)
    // r is still the top leaf after the split (existing pane keeps its slot); rename mental model: top=r, bottom=c.
    rectEq(t.rects().get('a'), 0, 0, 0.4, 1, 'nested: a left column full height');
    rectEq(t.rects().get('r'), 0.4, 0.3, 0.6, 0.7, 'nested: r = right-top (0.7 of height)');
    rectEq(t.rects().get('c'), 0.4, 0, 0.6, 0.3, 'nested: c = right-bottom (0.3 of height)');
    assertTiles(t, 'nested');
}

// ---- close: sibling collapses up, OUTER ratios preserved ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'x', 'r', { ratio: 0.4 });
    t.split('r', 'y', 'c', { ratio: 0.3 });   // right column split top(r)/bottom(c)
    const next = t.close('c');                 // remove bottom-right → r fills the right column
    ok(next === 'r', 'close: returns the collapsed sibling as next focus');
    ok(!t.has('c') && t.count() === 2, 'close: c gone, 2 leaves left');
    rectEq(t.rects().get('a'), 0, 0, 0.4, 1, 'close: OUTER x-ratio 0.4 preserved');
    rectEq(t.rects().get('r'), 0.4, 0, 0.6, 1, 'close: r now fills the full right column');
    assertTiles(t, 'after-close');
}

// ---- close the root leaf empties the tree ----
{
    const t = PaneTree.leaf('solo');
    ok(t.close('solo') === null && t.isEmpty(), 'close root leaf → empty tree, null next-focus');
}

// ---- resize: nearest ancestor split on the axis, correct sign, clamped ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'x', 'b');                     // root x-split ratio 0.5 (a first/left, b second/right)
    ok(t.resize('a', 'x', 0.2), 'resize a +x found a split');
    near(t.rects().get('a').w, 0.7, 'resize: a (first) grew to 0.7');
    ok(t.resize('b', 'x', 0.2), 'resize b +x');
    near(t.rects().get('a').w, 0.5, 'resize: growing b (second) shrank a back to 0.5');
    ok(!t.resize('a', 'y', 0.2), 'resize on an axis with no matching split → false');
    t.resize('a', 'x', 5);                      // way past the edge
    near(t.rects().get('a').w, 0.95, 'resize clamps at 1 - MIN_RATIO (0.95)');
}

// ---- neighbor: geometric directional focus over a 2×2-ish layout ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'x', 'b');                     // a left, b right (full height)
    t.split('a', 'y', 'c');                     // left column: a top, c bottom
    ok(t.neighbor('a', 'right') === 'b', 'neighbor: a→right = b');
    ok(t.neighbor('a', 'down') === 'c', 'neighbor: a→down = c');
    ok(t.neighbor('c', 'up') === 'a', 'neighbor: c→up = a');
    ok(t.neighbor('c', 'right') === 'b', 'neighbor: c→right = b');
    ok(t.neighbor('b', 'left') !== null, 'neighbor: b→left hits the left column');
    ok(t.neighbor('b', 'right') === null, 'neighbor: nothing to the right of b → null');
}

// ---- swap: exchange bindings, positions unchanged ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'x', 'b');                     // a left, b right
    ok(t.swap('a', 'b'), 'swap returns true');
    rectEq(t.rects().get('b'), 0, 0, 0.5, 1, 'swap: b now occupies the LEFT slot');
    rectEq(t.rects().get('a'), 0.5, 0, 0.5, 1, 'swap: a now occupies the RIGHT slot');
    ok(!t.swap('a', 'a') && !t.swap('a', 'nope'), 'swap rejects self / missing');
}

// ---- serialize round-trips to identical layout ----
{
    const t = PaneTree.leaf('a');
    t.split('a', 'x', 'b', { ratio: 0.35 });
    t.split('b', 'y', 'd', { ratio: 0.6 });
    const clone = PaneTree.deserialize(t.serialize());
    const A = t.rects(), B = clone.rects();
    let match = A.size === B.size;
    for (const [id, r] of A) { const s = B.get(id); if (!s || Math.abs(r.x - s.x) > 1e-12 || Math.abs(r.w - s.w) > 1e-12) match = false; }
    ok(match, 'serialize → deserialize reproduces the exact layout');
    // and the clone is independent (mutating it doesn't touch the original)
    clone.close('d');
    ok(t.has('d') && !clone.has('d'), 'deserialize deep-clones (no shared refs)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
