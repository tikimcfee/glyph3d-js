#!/usr/bin/env bun
// scene-transforms — SceneTransforms keeps every world matrix three's walk would, visiting only
// what moved. Headless: a random tree, real three math.
//
//   - THE INVARIANT: after the walk, every world matrix equals three's own forced walk, bit for
//     bit — after each kind of pose write (vector writes, rotations, three's transform helpers,
//     reparenting, a detached subtree, a hand-written matrix, a camera's inverse, a pivot)
//   - at rest the walk visits the root and stops; a write visits its chain, not the tree;
//     writing an unchanged value isn't a change
//   - a node with a hand-written matrix (or a camera, or a pivot) is three's every walk;
//     verifyTransforms names matrixAutoUpdate switched off on a node already in the scene
//   - a vector held from before its node joined throws on write
//   - reach: rootOf / isShown follow visible flips (an ancestor's, the root's, an own `visible`
//     converted at join) and the tree's shape; poses and walks leave the show generation alone
//   - force recomputes everything; dispose hands the walk back; a tracked vector serializes

import * as THREE from 'three';
import SceneTransforms, { verifyTransforms, TrackedVector3, rootOf, isShown, isTracked, showGeneration } from '../packages/glyph3d-core/src/collections/SceneTransforms.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL: ${m}`); } };

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const randomPose = (o) => {
    o.position.set(rnd() * 40 - 20, rnd() * 40 - 20, rnd() * 10 - 5);
    o.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    o.scale.setScalar(0.5 + rnd());
};

// a random tree: 400 nodes, groups and meshes, up to ~10 deep
const scene = new THREE.Scene();
const nodes = [scene];
const geo = new THREE.PlaneGeometry(1, 1), mat = new THREE.MeshBasicMaterial();
for (let i = 0; i < 400; i++) {
    const parent = nodes[Math.floor(rnd() ** 0.5 * nodes.length)];
    const o = i % 3 === 0 ? new THREE.Mesh(geo, mat) : new THREE.Group();
    randomPose(o);
    parent.add(o);
    nodes.push(o);
}
const held = nodes[200].position;   // a reference taken before tracking: a write through it must not vanish

const all = () => { const a = []; scene.traverse((o) => a.push(o)); return a; };
const snap = () => all().map((o) => o.matrixWorld.elements.slice());
/** ours, then three's forced walk over an untracked clone of the tree: the two must agree exactly */
function agrees(label) {
    const ours = snap();
    const copy = scene.clone();
    THREE.Object3D.prototype.updateMatrixWorld.call(copy, true);
    const ref = []; copy.traverse((o) => ref.push(o.matrixWorld.elements.slice()));
    ok(ref.length === ours.length, `${label}: the clone has the tree's shape`);
    let bad = 0;
    ours.forEach((e, i) => { if (e.some((v, j) => v !== ref[i][j])) bad++; });
    ok(bad === 0, `${label}: ${bad} world matrices differ from three's walk`);
}

const st = new SceneTransforms(scene);
{
    let threw = false; try { new SceneTransforms(scene); } catch { threw = true; }
    ok(threw, 'a second SceneTransforms on one scene throws');
    threw = false; try { new SceneTransforms(new THREE.Group()); } catch { threw = true; }
    ok(threw, 'SceneTransforms needs a Scene');
}

scene.updateMatrixWorld();
ok(st.stats.recomputed === nodes.length, `the first walk recomputes every node (${st.stats.recomputed}/${nodes.length})`);
agrees('first walk');

scene.updateMatrixWorld();
ok(st.stats.visited === 1 && st.stats.recomputed === 0, `at rest the walk visits the root only (visited ${st.stats.visited}, recomputed ${st.stats.recomputed})`);

const depthOf = (o) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; };
const deep = nodes.filter((o) => depthOf(o) >= 4 && o.children.length > 0);
ok(deep.length > 5, `the tree has deep interior nodes (${deep.length})`);
const pick = () => deep[Math.floor(rnd() * deep.length)];
const subtreeSize = (o) => { let n = 0; o.traverse(() => n++); return n; };

// ── every kind of write ──────────────────────────────────────────────────────────────────
const writes = {
    'position.x =': (o) => { o.position.x += 1.5; },
    'position.set': (o) => { o.position.set(o.position.x, o.position.y + 2, o.position.z); },
    'position.copy': (o) => { o.position.copy(new THREE.Vector3(3, 4, 5)); },
    'position.add': (o) => { o.position.add(new THREE.Vector3(0.25, 0, 0)); },
    'position.lerp': (o) => { o.position.lerp(new THREE.Vector3(9, 9, 9), 0.3); },
    'scale.setScalar': (o) => { o.scale.setScalar(1.75); },
    'scale.y =': (o) => { o.scale.y *= 0.5; },
    'rotation.y +=': (o) => { o.rotation.y += 0.2; },
    'rotation.set': (o) => { o.rotation.set(0.1, 0.2, 0.3); },
    'quaternion.setFromAxisAngle': (o) => { o.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4); },
    'quaternion.slerp': (o) => { o.quaternion.slerp(new THREE.Quaternion(0, 1, 0, 0), 0.25); },
    'lookAt': (o) => { o.lookAt(10, -3, 7); },
    'translateX': (o) => { o.translateX(0.6); },
    'rotateOnAxis': (o) => { o.rotateOnAxis(new THREE.Vector3(1, 0, 0), 0.3); },
    'applyMatrix4': (o) => { o.applyMatrix4(new THREE.Matrix4().makeRotationY(0.5).setPosition(1, 2, 3)); },
    'applyQuaternion': (o) => { o.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3)); },
};
for (const [name, write] of Object.entries(writes)) {
    const o = pick();
    write(o);
    scene.updateMatrixWorld();
    const sub = subtreeSize(o);
    ok(st.stats.recomputed === sub, `${name}: recomputes the node's subtree (${st.stats.recomputed}, want ${sub})`);
    ok(st.stats.visited < nodes.length, `${name}: the walk doesn't visit the whole tree (${st.stats.visited}/${nodes.length})`);
    agrees(name);
}

{
    let threw = false; try { held.x += 4; } catch { threw = true; }   // through a reference taken before tracking
    ok(threw, 'a write through a vector held from before the node joined throws');
    ok(nodes[200].position !== held && nodes[200].position.x === held.x, 'the node carries the same values in its tracked vector');
}
{
    const o = pick();
    o.position.x = o.position.x;            // unchanged value
    o.position.set(o.position.x, o.position.y, o.position.z);
    scene.updateMatrixWorld();
    ok(st.stats.visited === 1, `writing an unchanged position isn't a change (visited ${st.stats.visited})`);
    o.rotation.set(o.rotation.x, o.rotation.y, o.rotation.z);   // three's hook fires on every write
    o.quaternion.copy(o.quaternion.clone());
    scene.updateMatrixWorld();
    ok(st.stats.visited === 1, `nor an unchanged rotation or quaternion (visited ${st.stats.visited})`);
    o.rotation.y += 0.3;                     // the euler moves the quaternion silently; a later
    scene.updateMatrixWorld();               // quaternion write back to the old value is a change
    const before = o.quaternion.clone();
    o.rotation.y -= 0.3;
    scene.updateMatrixWorld();
    o.quaternion.copy(before);
    scene.updateMatrixWorld();
    ok(st.stats.recomputed >= 1, 'a quaternion write back to an earlier pose is a change');
    agrees('rotation and quaternion interleaved');
}

// ── structure ────────────────────────────────────────────────────────────────────────────
{
    const o = pick(), other = pick();
    if (!o.getObjectById(other.id) && !other.getObjectById(o.id)) {
        other.attach(o);                       // reparent, keeping the world pose
        scene.updateMatrixWorld();
        agrees('attach');
    }
    const a = pick(), b = nodes[1];
    if (!a.getObjectById(b.id)) { b.add(a); scene.updateMatrixWorld(); agrees('add to another parent (new world)'); }
}
{
    const o = pick(), parent = o.parent;
    parent.remove(o);
    o.position.x += 2; o.rotation.z += 0.5;   // moved while detached
    scene.updateMatrixWorld();
    parent.add(o);
    scene.updateMatrixWorld();
    agrees('removed, moved while detached, re-added');
}
{
    const root = new THREE.Group(); randomPose(root);
    let at = root;
    for (let i = 0; i < 6; i++) { const g = new THREE.Group(); randomPose(g); at.add(g); at = g; }
    pick().add(root);                          // built off-scene, then joined
    scene.updateMatrixWorld();
    agrees('a subtree built detached, then added');
    at.position.y += 3;                        // its leaf, tracked since it joined
    scene.updateMatrixWorld();
    ok(st.stats.recomputed === 1, `a node that joined later is tracked (recomputed ${st.stats.recomputed})`);
    agrees('write inside a joined subtree');
}

// ── the hand-written matrix contract ─────────────────────────────────────────────────────
{
    const m = new THREE.Mesh(geo, mat);
    m.matrixAutoUpdate = false;
    pick().add(m);
    scene.updateMatrixWorld();
    m.matrix.makeTranslation(5, 6, 7);
    m.matrixWorldNeedsUpdate = true;          // three's contract for a hand-written matrix
    scene.updateMatrixWorld();
    agrees('hand-written matrix with its flag');
    m.matrix.makeTranslation(8, 8, 8);        // and without it: three's walk redrew it anyway, so does this one
    scene.updateMatrixWorld();
    agrees('hand-written matrix without its flag');
    ok(st.stats.three >= 1, 'a hand-written matrix is handed to three every walk');
    ok(verifyTransforms(scene).stale.length === 0 && verifyTransforms(scene).checked > nodes.length, 'verifyTransforms checks every node, none stale');
    // what the walk can't see: matrixAutoUpdate switched off on a node already in the scene
    const late = pick();
    late.matrixAutoUpdate = false;
    late.matrix.makeTranslation(1, 2, 3);
    scene.updateMatrixWorld();
    const v = verifyTransforms(scene);
    ok(v.stale.length >= 1 && v.stale.some((n) => n.path.endsWith(late.name || late.type)), `verifyTransforms names it (${v.stale.length} stale)`);
    late.matrixAutoUpdate = true;
    late.position.x += 1;                     // a pose write brings it back
    scene.updateMatrixWorld();
    ok(verifyTransforms(scene).stale.length === 0, 'and clears once the pose is written');
}

// ── what the walk hands to three ─────────────────────────────────────────────────────────
{
    const cam = new THREE.PerspectiveCamera();   // overrides updateMatrixWorld (its inverse)
    const holder = pick();
    holder.add(cam);
    scene.updateMatrixWorld();
    holder.position.x += 1;
    scene.updateMatrixWorld();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    cam.matrixWorld.decompose(p, q, sc);
    const inv = new THREE.Matrix4().compose(p, q, sc.set(1, 1, 1)).invert();   // three's view matrix drops scale
    ok(cam.matrixWorldInverse.elements.every((v, i) => Math.abs(v - inv.elements[i]) < 1e-9), 'a camera in the tree keeps its inverse current');
    ok(st.stats.three >= 1, 'the camera is handed to three');
    agrees('camera in the tree');
    scene.updateMatrixWorld();
    ok(st.stats.three >= 1, 'every walk');
    cam.parent.remove(cam);
}
{
    const o = new THREE.Group();
    o.pivot = new THREE.Vector3(1, 0, 0);
    o.rotation.z = 0.5;
    pick().add(o);                               // a pivot node joins: handed to three
    scene.updateMatrixWorld();
    agrees('pivot node');
    o.pivot.x = 3;                               // the pivot's own components aren't tracked
    scene.updateMatrixWorld();
    agrees('pivot moved');
}

// ── reach: in the scene, and shown — walked once per show generation ─────────────────────
{
    ok(isTracked(scene) && !isTracked(new THREE.Scene()), 'isTracked: the scene a SceneTransforms serves');
    const leaf = nodes.find((o) => depthOf(o) >= 5 && o.children.length === 0);
    const mid = leaf.parent.parent;
    ok(rootOf(leaf) === scene && isShown(leaf), 'a leaf in the scene is shown');
    const g0 = showGeneration();
    scene.updateMatrixWorld(); leaf.position.x += 1; scene.updateMatrixWorld();
    ok(showGeneration() === g0, 'walks and pose writes leave the show generation alone');
    leaf.visible = leaf.visible;
    ok(showGeneration() === g0, 'an unchanged visible is not a change');
    mid.visible = false;
    ok(showGeneration() > g0 && !isShown(leaf), 'an ancestor hidden: the leaf is not shown');
    mid.visible = true;
    ok(isShown(leaf), 'and shown again');
    scene.visible = false;
    ok(!isShown(leaf), 'the root counts too');
    scene.visible = true;
    ok(isShown(leaf) && rootOf(leaf) === scene, 'shown, in the scene (cached)');
    const parent = mid.parent;
    parent.remove(mid);
    ok(rootOf(leaf) === mid, `removed from the tree: its root is the detached subtree's (${rootOf(leaf).type})`);
    parent.add(mid);
    ok(rootOf(leaf) === scene && isShown(leaf), 'added back: in the scene again');
    // an object carrying its own `visible` (made before the module loaded) is converted as it joins
    const old = new THREE.Group();
    Object.defineProperty(old, 'visible', { value: true, writable: true, enumerable: true, configurable: true });
    const kid = new THREE.Group(); old.add(kid);
    pick().add(old);
    ok(!Object.prototype.hasOwnProperty.call(old, 'visible') && old.visible === true, 'an own `visible` is converted as it joins');
    ok(isShown(kid), 'its child is shown');
    old.visible = false;
    ok(!isShown(kid), 'and its flip is seen');
    const g1 = showGeneration();
    const off = new THREE.Group(); off.add(new THREE.Group());
    ok(showGeneration() === g1, 'building outside the scene is not a show change');
    pick().add(off);
    ok(showGeneration() > g1, 'joining is');
}

// ── force, serialization, dispose ────────────────────────────────────────────────────────
{
    const total = all().length;
    scene.updateMatrixWorld(true);
    ok(st.stats.recomputed + st.stats.three === total, `force recomputes every node (${st.stats.recomputed} + ${st.stats.three} by three / ${total})`);
    ok(pick().position instanceof TrackedVector3, 'a tracked node carries tracked vectors');
    const j = JSON.parse(JSON.stringify(pick().position));
    ok(Object.keys(j).join() === 'x,y,z' && typeof j.x === 'number', `a tracked vector serializes as x, y, z (${Object.keys(j)})`);
    const n = pick(), c = n.position.clone();
    ok(c.constructor === THREE.Vector3 && c.x === n.position.x && c.y === n.position.y && c.z === n.position.z, `a tracked vector clones to a plain Vector3 with its values (${c.constructor.name} ${c.x},${c.y},${c.z})`);
    scene.updateMatrixWorld();
    c.x += 9;
    scene.updateMatrixWorld();
    ok(st.stats.recomputed === 0, `writing the clone moves nothing (recomputed ${st.stats.recomputed})`);
    ok(n.position.constructor === THREE.Vector3, 'a tracked vector reports Vector3 as its constructor (r3f copies into it)');
    const z = pick(); z.position.x = 0; scene.updateMatrixWorld();
    z.position.x = -0;
    ok(Object.is(z.position.x, -0), 'writing -0 over 0 lands');
    const made = new TrackedVector3(1, 2, 3);
    ok(made.x === 1 && made.y === 2 && made.z === 3, 'TrackedVector3 takes Vector3\'s (x, y, z)');
    ok(n.position.toArray().join() === [n.position.x, n.position.y, n.position.z].join() && n.position.distanceTo(c) === 9, 'a tracked vector still does Vector3 math');
    st.dispose();
    ok(scene.updateMatrixWorld === THREE.Object3D.prototype.updateMatrixWorld, 'dispose hands the walk back to three');
    const o = pick(); o.position.x += 1;
    scene.updateMatrixWorld();
    agrees('three walking a tracked tree');
}

console.log(`scene-transforms: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
