#!/usr/bin/env bun
// stacks.itest — headless math test for the VStack/HStack/ZStack layout primitive.
// The layout MATH is the risky part; rendering we verify live. Pure node+three, no browser.
//   bun tools/stacks.itest.mjs

import * as THREE from 'three';
import StackContainer, { VStack, HStack, ZStack } from '../packages/glyph3d-core/src/collections/layouts/StackContainer.js';

let pass = 0, fail = 0;
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
function check(name, cond, got) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}  got ${JSON.stringify(got)}`); }
}

// centered mock (like a tile / userData.size fallback): box [-w/2,w/2]×[-h/2,h/2]
const mock = (w, h, d = 0) => { const o = new THREE.Object3D(); o.userData.size = { x: w, y: h, z: d }; return o; };
// top-left-anchored mock (like a CodeGrid: content hangs from origin, box.min≈0/-h, box.max≈w/0)
const topLeft = (w, h) => { const o = new THREE.Object3D(); o.layoutBounds = () => new THREE.Box3(new THREE.Vector3(0, -h, 0), new THREE.Vector3(w, 0, 0)); return o; };

// 1 — HStack: tiles +X centered on origin, children share the TOP edge (align default = top)
{
    const a = mock(10, 4), b = mock(10, 4), c = mock(10, 4);
    const size = HStack({ spacing: 2, children: [a, b, c] }).layout();
    check('HStack footprint w=34 h=4', approx(size.x, 34) && approx(size.y, 4), size);
    check('HStack tops aligned (y=-2)', approx(a.position.y, -2) && approx(b.position.y, -2) && approx(c.position.y, -2), [a.position.y, b.position.y, c.position.y]);
    check('HStack tiled+centered x', approx(a.position.x, -12) && approx(b.position.x, 0) && approx(c.position.x, 12), [a.position.x, b.position.x, c.position.x]);
}

// 2 — VStack: tiles -Y from the top, column centered on X
{
    const a = mock(10, 4), b = mock(10, 4), c = mock(10, 4);
    const size = VStack({ spacing: 1, children: [a, b, c] }).layout();
    check('VStack footprint h=14', approx(size.y, 14), size);
    check('VStack descends', approx(a.position.y, -2) && approx(b.position.y, -7) && approx(c.position.y, -12), [a.position.y, b.position.y, c.position.y]);
    check('VStack centered x', approx(a.position.x, 0) && approx(b.position.x, 0) && approx(c.position.x, 0), [a.position.x, b.position.x, c.position.x]);
}

// 3 — ZStack: decks -Z by pitch; top/center aligned on the cross axes
{
    const a = mock(10, 4), b = mock(10, 4), c = mock(10, 4);
    ZStack({ spacing: 0, zStep: 2, children: [a, b, c] }).layout();
    check('ZStack deck z=0,-2,-4', approx(a.position.z, 0) && approx(b.position.z, -2) && approx(c.position.z, -4), [a.position.z, b.position.z, c.position.z]);
    check('ZStack tops aligned', approx(a.position.y, -2) && approx(c.position.y, -2), [a.position.y, c.position.y]);
    check('ZStack centered x', approx(a.position.x, 0) && approx(c.position.x, 0), [a.position.x, c.position.x]);
}

// 4 — AABB-relative bias: a top-left-anchored child still centers (x) and top-aligns (y)
{
    const a = topLeft(10, 4);
    HStack({ children: [a] }).layout();
    check('topLeft centered x (=-5)', approx(a.position.x, -5), a.position.x);
    check('topLeft top y (=0)', approx(a.position.y, 0), a.position.y);
}

// 5 — nesting composes: a VStack measures an inner HStack via its layoutBounds()
{
    const big = mock(10, 4);
    const i1 = mock(6, 3), i2 = mock(6, 3);
    const inner = HStack({ spacing: 2, children: [i1, i2] });
    VStack({ children: [big, inner] }).layout();
    check('nested inner laid out', approx(i1.position.x, -4) && approx(i2.position.x, 4), [i1.position.x, i2.position.x]);
    check('nested outer places inner HStack at y=-4', approx(inner.position.y, -4), inner.position.y);
    check('nested centers both columns', approx(big.position.x, 0) && approx(inner.position.x, 0), [big.position.x, inner.position.x]);
}

// 5b — reverse: last-added child takes the front slot (newest-in-front deck)
{
    const a = mock(10, 4), b = mock(10, 4), c = mock(10, 4);
    ZStack({ spacing: 0, zStep: 2, reverse: true, children: [a, b, c] }).layout();
    check('ZStack reverse newest-front (c=0,a=-4)', approx(c.position.z, 0) && approx(b.position.z, -2) && approx(a.position.z, -4), [a.position.z, b.position.z, c.position.z]);
}

// 6 — scale is read: a 2× child occupies 2× the main extent
{
    const a = mock(10, 4); a.scale.setScalar(2);
    const b = mock(10, 4);
    const size = HStack({ spacing: 0, children: [a, b] }).layout();
    check('scaled child widens footprint (20+10=30)', approx(size.x, 30), size);
}

// 7 — columnWidths: child LEADS in a fixed slot; cursor advances by the slot, not the extent
{
    const a = mock(4, 4), b = mock(6, 4);
    const size = HStack({ spacing: 0, columnWidths: [20, 10], children: [a, b] }).layout();
    check('columnWidths a leads col0 (left edge 0)', approx(a.position.x - 2, 0), a.position.x);
    check('columnWidths b leads col1 (left edge 20)', approx(b.position.x - 3, 20), b.position.x);
    check('columnWidths footprint = col0 end 20 + b extent 6 = 26', approx(size.x, 26), size);
}

// 8 — childExtents reports per-child content size (the measure seam columns build on)
{
    const r = HStack({ children: [mock(4, 2), mock(8, 2)] });
    check('childExtents → [4, 8]', JSON.stringify(r.childExtents('x')) === '[4,8]', r.childExtents('x'));
}

// 9 — columnAlign (data-driven): two rows share content-sized columns (widest tool, widest content)
{
    const r1 = HStack({ spacing: 1, children: [mock(4, 2), mock(8, 2)] });   // tool 4, content 8
    const r2 = HStack({ spacing: 1, children: [mock(6, 2), mock(5, 2)] });   // tool 6, content 5
    ZStack({ spacing: 0, columnAlign: true, children: [r1, r2] }).layout();
    // col0 = max(4,6) = 6, col1 = max(8,5) = 8 → both rows lay their cells into [6,8].
    const [a1, b1] = r1.children, [a2, b2] = r2.children;
    check('columnAlign tool left edges both 0', approx(a1.position.x - 2, 0) && approx(a2.position.x - 3, 0), [a1.position.x, a2.position.x]);
    check('columnAlign content left edges both 7 (col0 6 + gap 1)', approx(b1.position.x - 4, 7) && approx(b2.position.x - 2.5, 7), [b1.position.x, b2.position.x]);
    check('track is transient — never stamped onto rows', r1.columnWidths === null && r2.columnWidths === null, [r1.columnWidths, r2.columnWidths]);
}

// 10 — toggling columnAlign OFF reverts to ragged (no sticky state)
{
    const r1 = HStack({ spacing: 1, children: [mock(4, 2), mock(8, 2)] });
    const r2 = HStack({ spacing: 1, children: [mock(6, 2), mock(5, 2)] });
    const z = ZStack({ spacing: 0, columnAlign: true, children: [r1, r2] });
    z.layout();
    const aligned = r2.children[1].position.x;          // content x while aligned
    z.columnAlign = false; z.layout();
    const ragged = r2.children[1].position.x;           // content x after toggle off
    check('columnAlign off changes content placement (reverts)', Math.abs(aligned - ragged) > 1e-6, [aligned, ragged]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
