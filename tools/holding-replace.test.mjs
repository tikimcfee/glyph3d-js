// holding-replace.test.mjs — a window whose object is replaced (a FileRow materialized into its
// CodeGrid actor, fileLoader.materializeActor) stays where its holders hold it (Holding.replace).
//
//   bun tools/holding-replace.test.mjs
//
// The regression: a row seated at a PLANE desk was materialized when attention reached it (a
// carrel.enter focuses its member); the swap re-homed the actor into the content tree's book and
// the desk kept the row — then disposed — so the pin drew nothing (the desk read blank, unpickable).
// Locks, on a real Carrel (plane mode) and CameraDock:
//   - seated: after replace the desk holds the NEW object under the same id, parented to the desk,
//     standing exactly in the old seat (same order, same seat position, no slide), and its home is
//     the row's home (the tree), so a later release lands it there — teeth: the bare tree swap (the
//     old path) leaves the desk holding the old object and the new one off the desk
//   - docked: the ride carries the new object in the same order, its home the row's
//   - borrowed (seated AND docked): the desk keeps the seat, the dock keeps the ride, the ride's
//     home is the seat
//   - loose: nothing to do (no holder)
//   - the durable facts (view.carrel / view.docked) are untouched: the window is the same

import './headless-canvas.mjs';
import { HEADLESS_ATLAS } from './headless-atlas.mjs';
import * as THREE from 'three';
import Carrel from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import Holding from '../app/client/Holding.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

/** A window: W × H content box, top-anchored (like a CodeGrid). */
const makeGrid = (name, w = 10, h = 6) => {
    const g = new THREE.Object3D();
    g.name = name;
    g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(-w / 2, -h, -0.15), new THREE.Vector3(w / 2, 0, 0.15));
    g.getBounds = (t = new THREE.Box3()) => { g.updateWorldMatrix(true, false); return g.getLocalBounds(t).applyMatrix4(g.matrixWorld); };
    return g;
};
const settle = (c, n = 10) => { for (let i = 0; i < n; i++) c.update(0.05, null); };

function world(mode = 'plane') {
    const scene = new THREE.Scene();
    const tree = new THREE.Group(); tree.name = 'tree-mount';
    scene.add(tree);
    const desk = new Carrel({ name: 'reading', radius: 20, mode });
    scene.add(desk);
    const dock = new CameraDock({ atlas: HEADLESS_ATLAS });
    scene.add(dock);
    const facts = [];
    const ctx = {
        carrels: new Map([['reading', desk]]),
        cameraDock: dock,
        registry: { get: () => null },
        workspace: { setSurfaceView: (id, _t, patch) => facts.push([id, patch]) },
    };
    const holding = new Holding(ctx);
    const rows = ['a', 'b', 'c'].map((id, i) => {
        const r = makeGrid(`row-${id}`, 10 + i * 3, 6 + i);
        r.position.set(40 + i * 20, 12, -8);
        tree.add(r);
        return r;
    });
    return { scene, tree, desk, dock, holding, rows, facts };
}

/** What materializeActor's tree swap does: the actor into the row's tree mount, at the row's local pose. */
function treeSwap(w, row, actor) {
    actor.position.copy(row.position);
    actor.quaternion.copy(row.quaternion);
    w.tree.add(actor);
}

// ── Seated (a plane desk, and a ring desk — where seating slides unless it lands immediately).
for (const [mode, fixed] of [['plane', true], ['ring', true], ['plane', false]]) {
    const w = world(mode);
    w.rows.forEach((r, i) => w.desk.lock('abc'[i], r, { immediate: true }));
    settle(w.desk);
    const seatB = w.desk.entries.get('b');
    const order = seatB.order, pos = w.rows[1].position.clone();
    const actor = makeGrid('actor-b', 13, 7);
    treeSwap(w, w.rows[1], actor);
    w.facts.length = 0;
    if (fixed) w.holding.replace('b', actor);
    const e = w.desk.entries.get('b');
    if (fixed) {
        ok(e?.grid === actor && actor.parent === w.desk, `${mode} seated: the desk holds the actor under the same id, parented to the desk`);
        ok(e.order === order, `${mode} seated: the same order (${e.order} vs ${order})`);
        ok(actor.position.distanceTo(pos) < 1e-6, `${mode} seated: it stands in the old seat, no slide (${actor.position.toArray().map((x) => x.toFixed(2))} vs ${pos.toArray().map((x) => x.toFixed(2))})`);
        ok(w.facts.length === 0, `seated: no durable fact touched (${JSON.stringify(w.facts)})`);
        ok(w.desk.homeOf('b')?.parent === w.tree, 'seated: its home is the row\'s home (the tree)');
        w.desk.release('b');
        settle(w.desk);
        ok(actor.parent === w.tree && actor.position.distanceTo(new THREE.Vector3(60, 12, -8)) < 1e-3, 'released: it lands at the row\'s home in the tree');
    } else {
        ok(e?.grid === w.rows[1] && actor.parent !== w.desk, 'teeth: the bare tree swap leaves the desk holding the old row and the actor off the desk');
    }
}

// ── Riding the dock (not seated).
{
    const w = world();
    w.dock.lock('a', w.rows[0]);
    w.dock.lock('c', w.rows[2]);
    settle(w.dock);
    const order = w.dock.entries.get('c').order;
    const actor = makeGrid('actor-c');
    treeSwap(w, w.rows[2], actor);
    w.holding.replace('c', actor);
    const e = w.dock.entries.get('c');
    ok(e?.grid === actor && e.order === order && w.dock.tiles.has(actor) && !w.dock.tiles.has(w.rows[2]), 'docked: the ride carries the actor in the same slot');
    ok(w.dock.homeOf('c')?.parent === w.tree && Math.abs(w.dock.homeOf('c').pos.x - 80) < 1e-6, 'docked: its home is the row\'s home');
}

// ── Borrowed: seated AND riding the dock.
{
    const w = world();
    w.desk.lock('a', w.rows[0], { immediate: true });
    settle(w.desk);
    const seat = w.rows[0].position.clone();
    w.dock.lock('a', w.rows[0]);          // borrow: the ride's home is the seat
    settle(w.dock);
    const actor = makeGrid('actor-a');
    treeSwap(w, w.rows[0], actor);
    w.holding.replace('a', actor);
    ok(w.desk.entries.get('a')?.grid === actor && w.dock.entries.get('a')?.grid === actor, 'borrowed: desk and dock both hold the actor');
    ok(actor.parent === w.dock, 'borrowed: it rides (parented to the dock)');
    const rideHome = w.dock.homeOf('a');
    ok(rideHome?.parent === w.desk && rideHome.pos && Math.hypot(rideHome.pos.x - seat.x, rideHome.pos.y - seat.y, rideHome.pos.z - seat.z) < 1e-6, 'borrowed: the ride\'s home is the seat');
    w.dock.release('a');
    settle(w.dock); settle(w.desk);
    ok(actor.parent === w.desk && actor.position.distanceTo(seat) < 1e-3, 'borrowed: released from the dock, it returns to its seat');
}

// ── Loose: nothing holds it.
{
    const w = world();
    const actor = makeGrid('actor');
    const r = w.holding.replace('a', actor);
    ok(!r.desk && !r.docked && !actor.parent, 'loose: no holder, nothing moves');
}

console.log(`${fails ? 'FAIL' : 'ok'} holding-replace: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
