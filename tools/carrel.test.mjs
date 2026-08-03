// carrel.test.mjs — headless, GPU-free unit test for the Carrel (the CameraDock's
// world-anchored mirror).
//
// The invariants under test are the ownership law and the table grammar:
//   - lock captures home and reparents world-preservingly; release restores it
//   - members ring the cylinder at `radius`; row 0 RESTS on the tabletop (y=0)
//   - the doorway arc stays open; facing 'in' turns every member toward the axis
//   - grid mode is the ring's 0-curvature limit: a flat semi-grid wall at z=−R
//     facing the doorway, centered on the axis; setMode toggles live
//   - a BORROWED member (parent elsewhere) is never touched; its return re-seats
//   - dock → carrel adoption hands the HOME RECORD over (homeOf), so release
//     from the carrel returns to the TREE, never to the bar
//   - dissolve drains homeward slides before the desk dies
//
//   bun tools/carrel.test.mjs
//
// Pure three (Object3D/Box3/Quaternion) — no WebGPU.

import * as THREE from 'three';
import Carrel from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import WorldLayout from '../packages/glyph3d-core/src/collections/WorldLayout.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m} (got ${a}, want ${b}±${eps})`);

/** A mock window: local content box W wide × H tall, TOP-anchored (origin at content top),
 *  like a CodeGrid. getBounds is the world box. `_dims` is mutable (a growing book);
 *  `_dims.empty` simulates a transient mid-mutation empty measure. */
const makeGrid = (w = 10, h = 6, d = 0.3) => {
    const g = new THREE.Object3D();
    g._dims = { w, h, d, empty: false };
    g.getLocalBounds = (t = new THREE.Box3()) => g._dims.empty
        ? t.makeEmpty()
        : t.set(new THREE.Vector3(-g._dims.w / 2, -g._dims.h, -g._dims.d / 2), new THREE.Vector3(g._dims.w / 2, 0, g._dims.d / 2));
    g.getBounds = (t = new THREE.Box3()) => {
        g.updateWorldMatrix(true, false);
        return g.getLocalBounds(t).applyMatrix4(g.matrixWorld);
    };
    return g;
};

/** Drive a carrel/dock's animators past animDur. */
const settle = (c, n = 8) => { for (let i = 0; i < n; i++) c.update(0.05); };

// ---- lock: capture + reparent; ring + rest; contain-fit; doorway; facing ----
{
    const scene = new THREE.Scene();
    const treeNode = new THREE.Group();
    scene.add(treeNode);
    const carrel = new Carrel({ name: 't', radius: 20, boxH: 9, boxAspect: 1.15, maxArcDeg: 300 });
    scene.add(carrel);

    const grids = [];
    for (let i = 0; i < 5; i++) {
        const g = makeGrid();
        g.position.set(100 + i, 7, -30);
        treeNode.add(g);
        grids.push(g);
        ok(carrel.lock(`g${i}`, g), `lock g${i} accepted`);
    }
    ok(grids.every((g) => g.parent === carrel), 'members reparented under the carrel');
    const e0 = carrel.entries.get('g0');
    ok(e0.homeParent === treeNode, 'home parent captured (the tree node)');
    near(e0.home.pos.x, 100, 1e-9, 'home position captured');

    settle(carrel);

    const boxW = 9 * 1.15, boxH = 9;
    const wantEff = Math.min(boxW / 10, boxH / 6);
    for (const g of grids) {
        near(Math.hypot(g.position.x, g.position.z), 20, 0.5, 'member sits on the ring radius');
        near(g.scale.x, wantEff, 1e-6, 'contain-fit scale');
        // rest: content bottom (origin is content top → bottom = y − h·eff) on the table
        near(g.position.y - 6 * g.scale.x, 0, 1e-6, 'row-0 content RESTS on the tabletop');
        // doorway: azimuth measured from the back (−z); the gap (|az| > 150°) stays empty
        const az = Math.atan2(g.position.x, -g.position.z) * 180 / Math.PI;
        ok(Math.abs(az) <= 150 + 1e-6, `member inside the 300° arc (az ${az.toFixed(1)}°)`);
        // facing 'in': the member's +z (after slerp) points at the axis
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion);
        const toAxis = new THREE.Vector3(-g.position.x, 0, -g.position.z).normalize();
        ok(f.dot(toAxis) > 0.99, 'member faces the center (stand-at-center mirror)');
    }

    // ---- release: home restored ----
    carrel.release('g0');
    settle(carrel);
    ok(grids[0].parent === treeNode, 'release reparents home');
    near(grids[0].position.x, 100, 1e-3, 'release restores home position');
    near(grids[0].scale.x, 1, 1e-3, 'release restores home scale');
    ok(!carrel.has('g0'), 'entry dropped');

    // ---- borrowed: hands off while ridden; return re-seats ----
    const rider = new THREE.Group();
    scene.add(rider);
    const g1 = grids[1];
    settle(carrel);
    rider.attach(g1);                      // stolen (docked, parked — any rider)
    const frozen = g1.position.clone();
    carrel.update(0.05);                   // notices the borrow
    carrel._relayout();                    // survivors re-seat around the hole
    settle(carrel);
    ok(g1.position.distanceTo(frozen) < 1e-9, 'borrowed member untouched by the carrel');
    ok(carrel.has('g1'), 'borrowed member keeps its seat (membership survives the ride)');
    carrel.attach(g1);                     // the ride ends — it comes home
    settle(carrel);
    near(Math.hypot(g1.position.x, g1.position.z), 20, 0.5, 'returned member re-seated on the ring');

    // ---- dismiss: orphan lifted, survivors re-packed ----
    carrel.dismiss('g2');
    ok(!carrel.has('g2') && grids[2].parent === null, 'dismiss lifts the orphan out');

    // ---- dissolve: drain, then die ----
    carrel.dissolve();
    ok(carrel._dissolving, 'dissolving');
    settle(carrel, 12);
    ok(carrel.entries.size === 0 && carrel._releasing.size === 0, 'dissolve drained');
    ok(carrel._dead && carrel.parent === null, 'desk dead + removed after draining');
    ok(grids[3].parent === treeNode, 'dissolved members went home');
}

// ---- grid mode: the 0-curvature shelf — flat wall at z=−R, semi-grid wrap ----
{
    const scene = new THREE.Scene();
    // Use tableFrac=1.0 so the shadow is a strip (z < x), not a square
    const carrel = new Carrel({ name: 'shelf', radius: 20, boxH: 9, boxAspect: 1.15, mode: 'grid', tableFrac: 1.0 });
    scene.add(carrel);
    const grids = [];
    for (let i = 0; i < 4; i++) {
        const g = makeGrid();
        scene.add(g);
        grids.push(g);
        carrel.lock(`g${i}`, g);
    }
    settle(carrel);

    const rowPitch = 9 + 9 * 0.9;   // boxH + gap — where row 1 rests
    for (const g of grids) {
        near(g.position.z, -20, 0.5, 'grid member stands on the back wall (z=−R)');
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion);
        ok(f.z > 0.99, 'grid member faces the doorway (+z)');
        // The mock is top-anchored (origin at top), and the Carrel positions by
        // content center. The content center for row 0 is at y≈3 (h/2), and for
        // row 1 at y≈17.1 (rowPitch + h/2). But the mock's origin is at the top,
        // so position.y = center_y + h/2. This gives row 0 at y≈6 and row 1 at y≈20.1.
        const h = 6;
        const centerY = h / 2;
        const row0Origin = centerY + centerY;  // center at y=3, origin at y=6
        const row1Origin = h + 9 * 0.9 + h;  // row 1 bottom at 14.1, origin at 20.1
        ok(Math.abs(g.position.y - row0Origin) < 0.5 || Math.abs(g.position.y - row1Origin) < 0.5,
           `content origin at row-0 or row-1 line (y=${g.position.y.toFixed(2)})`);
    }
    // squareWrap balances 4 uniform boxes into 2 columns → 2 rows (the semi-grid)
    const rows = new Set(grids.map((g) => Math.round(g.position.y * 10)));
    ok(rows.size === 2, `semi-grid wraps upward (want 2 rows, got ${rows.size})`);
    // the wall is centered on the carrel axis
    const xs = grids.map((g) => g.position.x);
    near(Math.max(...xs) + Math.min(...xs), 0, 0.5, 'wall centered on the axis');

    // live toggle: back to the ring re-seats the arc; to grid flattens again
    ok(carrel.setMode('ring'), 'setMode ring accepted');
    settle(carrel);
    for (const g of grids) near(Math.hypot(g.position.x, g.position.z), 20, 0.5, 'setMode ring re-seats the ring radius');
    ok(carrel.setMode('grid'), 'setMode grid accepted');
    settle(carrel);
    for (const g of grids) near(g.position.z, -20, 0.5, 'setMode grid re-flattens the wall');
    ok(!carrel.setMode('spiral'), 'unknown mode refused');
    ok(carrel.serialize().params.mode === 'grid', 'mode serializes');
}

// ---- restore fill: immediate seating + expected-complement pre-shape ----
{
    const scene = new THREE.Scene();
    const carrel = new Carrel({ name: 'r', radius: 20, boxH: 9, boxAspect: 1.15, mode: 'grid' });
    scene.add(carrel);
    carrel.expect(4);                       // the saved membership announces 4

    // First arrival LANDS in its seat — no slide from where the loader built it —
    // and lands in its FINAL slot (the wall wraps and centers for 4 from the start).
    const a = makeGrid();
    a.position.set(500, 500, 500);
    scene.add(a);
    carrel.lock('a', a, { order: 0, immediate: true });
    ok(carrel.animator._active.size === 0, 'immediate lock issues no tweens');
    near(a.position.z, -20, 1e-6, 'immediate member stands on the wall this tick');
    const firstSeat = a.position.clone();

    const rest = [];
    for (let i = 1; i < 4; i++) {
        const g = makeGrid();
        scene.add(g);
        rest.push(g);
        carrel.lock(`g${i}`, g, { order: i, immediate: true });
    }
    ok(a.position.distanceTo(firstSeat) < 1e-9, 'first member never moved as the wall filled');
    ok(carrel._expected === 0, 'expectation self-clears when the complement arrives');
    const rows = new Set([a, ...rest].map((g) => Math.round(g.position.y * 10)));
    ok(rows.size === 2, 'filled wall holds the 2×2 semi-grid it pre-shaped for');
}

// ---- refit churn: seat-diff, last-good extent hold, aura ease ----
{
    const scene = new THREE.Scene();
    const carrel = new Carrel({ name: 'calm', radius: 20, boxH: 9 });
    scene.add(carrel);
    const a = makeGrid(10, 6, 0.3), b = makeGrid(10, 6, 0.3);
    scene.add(a); scene.add(b);
    carrel.lock('a', a);
    carrel.lock('b', b);
    settle(carrel, 12);
    ok(carrel.animator._active.size === 0, 'settled: no live tweens');

    carrel.refit();
    ok(carrel.animator._active.size === 0, 'refit with unchanged content re-tweens NOTHING (seat-diff)');

    const posB = b.position.clone();
    a._dims.h = 9;                        // `a` grows — a book paged in sheets
    carrel.refit();
    ok(carrel.animator._active.size === 2, 'only the grown member re-tweens (pos+scale)');
    settle(carrel, 12);
    ok(b.position.distanceTo(posB) < 1e-9, 'the neighbor never moved');

    a._dims.empty = true;                 // transient mid-mutation empty measure
    carrel.refit();
    ok(carrel.animator._active.size === 0, 'transient empty read holds last-good form (no flash)');
    a._dims.empty = false;

    // chrome: the base-shadow hugs the footprint — the tabletop square under a
    // ring, a strip under the grid wall (centered where the wall stands). With
    // only 2 members in this test, the grid layout is 1×2, so the shadow is
    // narrow in X and deep in Z — check that the grid mode changed the shape.
    near(carrel._shadow.scale.x, 2 * 20 * carrel.tableFrac, 1e-6, 'ring shadow spans the tabletop square');
    near(carrel._shadow.position.z, 0, 1e-9, 'ring shadow centers on the axis');
    carrel.setMode('grid');
    near(carrel._shadow.position.z, -20, 1e-9, 'grid shadow lies under the wall (z=−R)');
    ok(carrel._shadow.scale.x !== carrel._shadow.scale.z, 'grid shadow changed shape from the square ring shadow');
    carrel.setMode('ring');
}

// ---- occupancy handoff: dock → carrel adopts the HOME RECORD, not the bar pose ----
{
    const scene = new THREE.Scene();
    const treeNode = new THREE.Group();
    scene.add(treeNode);
    const g = makeGrid();
    g.position.set(40, 12, -8);
    treeNode.add(g);

    const dock = new CameraDock();
    scene.add(dock);
    dock.lock('a', g);
    for (let i = 0; i < 8; i++) dock.update(0.05, null);   // tile slides into the bar

    const carrel = new Carrel({ name: 'h', radius: 15 });
    scene.add(carrel);
    const home = dock.homeOf('a');
    ok(home && home.parent === treeNode, 'homeOf exposes the captured residence');
    dock.release('a');
    ok(carrel.lock('a', g, { home }), 'carrel adopts with the handed-over home');
    settle(carrel); settle(dock);          // both animators run; carrel owns the tweens (last-write-wins)
    ok(g.parent === carrel, 'adopted member seated at the carrel');

    carrel.release('a');
    settle(carrel);
    ok(g.parent === treeNode, 'release from the carrel returns to the TREE, not the bar');
    near(g.position.x, 40, 1e-3, 'original home position restored through the handoff');
}

console.log(`\ncarrel.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
