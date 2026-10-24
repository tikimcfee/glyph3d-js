#!/usr/bin/env bun
// glyph-batch — GlyphBatch draws enrolled glyph fields (labels) as ranges of one arena field,
// headless: real fields, real three math, no GL context.
//
//   - membership follows add / remove; a batched field leaves the view layer, the arena doesn't
//   - the arena holds every member's glyphs, each range in its member's own group row, every
//     other lane copied verbatim
//   - THE POSE: a batched glyph lands where its own mesh would put it (group row + the arena's
//     eye translation == mesh.localToWorld), under rotation, scale and a far-off world position
//   - hidden (the mesh or an ancestor) and out-of-frustum labels go to group alpha 0
//   - a text change repacks; an unchanged frame doesn't
//   - refusals draw themselves: a glyph outside group 0, a shear the group row can't hold
//   - GlyphFarLod leaves batched fields' layers alone; pick passes don't refresh; dispose

import * as THREE from 'three';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import GlyphBatch, { enrollGlyphField, enrolledGlyphFields, isBatchedGlyphField } from '../packages/glyph3d-core/src/collections/GlyphBatch.js';
import GlyphFarLod from '../packages/glyph3d-core/src/collections/GlyphFarLod.js';
import { SLOT_FLOATS, LANE_GROUP_ID, LANE_POS_X } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';
import { GROUP_STRIDE } from '../packages/glyph3d-core/src/core/glyphMaterial.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL: ${m}`); } };
const close = (a, b, m, eps = 1e-4) => ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${m} (got ${a}, want ${b})`);
const ROW = GROUP_STRIDE * 4;

const atlas = {};   // the arena takes its slug data from the atlas; none headless
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1e7);
const look = (x, y, z, tx = x, ty = y, tz = 0) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld(); };

// ── refusals at enrolment ────────────────────────────────────────────────────────────────
{
    let threw = false; try { enrollGlyphField({}); } catch { threw = true; }
    ok(threw, 'enrolling something without an instanceMesh throws');
    threw = false; try { new GlyphBatch(new THREE.Object3D(), atlas); } catch { threw = true; }
    ok(threw, 'a batch needs a Scene');
    threw = false; try { new GlyphBatch(scene, null); } catch { threw = true; }
    ok(threw, 'a batch needs the atlas');
}

const label = (text) => {
    const f = enrollGlyphField(new InstancedField(null, null, { maxInstances: 256 }));
    f.loadText(text);
    return f;
};

// Two labels on a posed chain: a rotated, scaled holder far from the origin.
const holder = new THREE.Object3D();
holder.position.set(25000, -18000, 40000);
holder.rotation.set(0.3, -0.7, 0.2);
holder.scale.setScalar(2.5);
scene.add(holder);
const a = label('alpha beta'), b = label('gamma\ndelta');
const anchorB = new THREE.Object3D(); anchorB.position.set(4, -3, 1); anchorB.rotation.y = 0.4; anchorB.scale.setScalar(0.5);
holder.add(a.instanceMesh); holder.add(anchorB); anchorB.add(b.instanceMesh);
scene.updateMatrixWorld();

const batch = new GlyphBatch(scene, atlas);
ok(isBatchedGlyphField(a) && isBatchedGlyphField(b), 'enrolled fields report batched');
ok(enrolledGlyphFields().has(a.instanceMesh) && enrolledGlyphFields().has(b.instanceMesh), 'attached fields are members');

const centre = new THREE.Vector3(); new THREE.Box3().setFromObject(holder).getCenter(centre);
look(centre.x, centre.y, centre.z + 400, centre.x, centre.y, centre.z);
let st = batch.update(camera);
const arena = batch.arena;
ok(arena && arena.instanceMesh.parent === scene, 'the arena field lives in the scene');
ok(st.drawn === 2 && st.glyphs === a.getGlyphCount() + b.getGlyphCount(), `both labels drawn from the arena (${JSON.stringify(st)})`);
ok(!a.instanceMesh.layers.isEnabled(0) && !b.instanceMesh.layers.isEnabled(0), 'batched fields leave the view layer');
ok(arena.instanceMesh.layers.isEnabled(0), 'the arena draws on the view layer');
ok(arena.getGlyphCount() === a.getGlyphCount() + b.getGlyphCount(), 'the arena holds every member glyph');

// ── the ranges: own group row each, other lanes verbatim ─────────────────────────────────
{
    const d = arena.slotBuffer.f32;
    let lanes = true, groups = true, at = 0;
    batch._members.forEach((m, gi) => {
        const src = m.field.slotBuffer.f32;
        for (let j = 0; j < m.count; j++, at++) {
            for (let k = 0; k < SLOT_FLOATS; k++) {
                if (k === LANE_GROUP_ID) { if (d[at * SLOT_FLOATS + k] !== gi + 1) groups = false; }
                else if (d[at * SLOT_FLOATS + k] !== src[j * SLOT_FLOATS + k]) lanes = false;
            }
        }
    });
    ok(groups, 'member i\'s range points at group row i + 1');
    ok(lanes, 'every other lane is the member\'s, verbatim');
    ok(arena._groupData[11] === 0, 'group 0 is dark (no glyph points at it)');
}

// ── THE POSE: arena glyph world position == the glyph's own mesh's ────────────────────────
const rowOf = (field) => batch._members.findIndex((m) => m.mesh === field.instanceMesh) + 1;
function poseError(field) {
    const G = arena._groupData, r = rowOf(field) * ROW;
    const off = new THREE.Vector3(G[r], G[r + 1], G[r + 2]);
    const q = new THREE.Quaternion(G[r + 4], G[r + 5], G[r + 6], G[r + 7]);
    const s = new THREE.Vector3(G[r + 12], G[r + 13], G[r + 14]);
    let worst = 0;
    const f32 = field.slotBuffer.f32;
    for (let i = 0; i < field.getGlyphCount(); i++) {
        const p = new THREE.Vector3(f32[i * SLOT_FLOATS + LANE_POS_X], f32[i * SLOT_FLOATS + LANE_POS_X + 1], f32[i * SLOT_FLOATS + LANE_POS_X + 2]);
        const want = field.instanceMesh.localToWorld(p.clone());
        const got = p.clone().multiply(s).applyQuaternion(q).add(off).applyMatrix4(arena.instanceMesh.matrixWorld);
        worst = Math.max(worst, got.distanceTo(want));
    }
    return worst;
}
{
    const ea = poseError(a), eb = poseError(b);
    ok(ea < 1e-6 * 40000 && eb < 1e-6 * 40000, `batched glyphs land where their own meshes put them (worst ${ea.toExponential(2)}, ${eb.toExponential(2)} at |p| ≈ 5e4)`);
    const G = arena._groupData;
    ok(Math.hypot(G[ROW], G[ROW + 1], G[ROW + 2]) < 1000, 'group offsets are camera-relative (small), not world');
    close(arena.instanceMesh.matrixWorld.elements[12], camera.position.x, 'the arena sits at the eye');
}

// ── hiding and culling ────────────────────────────────────────────────────────────────────
{
    const G = arena._groupData, ra = () => rowOf(a) * ROW + 11, rb = () => rowOf(b) * ROW + 11;
    a.instanceMesh.visible = false;
    st = batch.update(camera);
    ok(G[ra()] === 0 && st.hidden === 1 && G[rb()] > 0, 'a hidden mesh goes to alpha 0, the other label stays');
    a.instanceMesh.visible = true;
    anchorB.visible = false;
    st = batch.update(camera);
    ok(G[rb()] === 0 && st.hidden === 1, 'a hidden ancestor hides its label');
    anchorB.visible = true;
    look(centre.x, centre.y, centre.z + 400, centre.x + 1e5, centre.y, centre.z);   // looking away
    st = batch.update(camera);
    ok(st.culled === 2 && G[ra()] === 0 && G[rb()] === 0, 'labels outside the frustum go to alpha 0');
    look(centre.x, centre.y, centre.z + 400, centre.x, centre.y, centre.z);
    st = batch.update(camera);
    ok(st.drawn === 2 && G[ra()] === 1, 'back in view: drawn again');
}

// ── slot order = three's transparent order (far → near): overlapping labels composite alike ──
{
    const depthOf = (f) => f.geometry.boundingSphere.center.clone().applyMatrix4(f.instanceMesh.matrixWorld)
        .applyMatrix4(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)).z;
    const ds = batch._members.map((m) => depthOf(m.field));
    ok(ds.every((d, i) => i === 0 || ds[i - 1] >= d), `ranges run far → near (${ds.map((d) => d.toFixed(4)).join(', ')})`);
    // swing round so the other label is farther: the order flips, and the arena repacks into it
    const first = batch._members[0].mesh;
    const back = new THREE.Vector3(); first.getWorldPosition(back);
    const toFirst = back.clone().sub(centre).normalize();
    look(centre.x + toFirst.x * 600, centre.y + toFirst.y * 600, centre.z + toFirst.z * 600, centre.x, centre.y, centre.z);
    batch.update(camera);
    ok(batch._members[0].mesh !== first, 'from the other side the order flips');
    ok(poseError(a) < 1e-6 * 40000 && poseError(b) < 1e-6 * 40000, '…and every label still lands where its mesh puts it');
    look(centre.x, centre.y, centre.z + 400, centre.x, centre.y, centre.z);
    batch.update(camera);
}

// ── repack only when glyphs change ───────────────────────────────────────────────────────
{
    let repacks = 0;
    const orig = batch._repack.bind(batch);
    batch._repack = () => { repacks++; orig(); };
    batch.update(camera); batch.update(camera);
    ok(repacks === 0, 'an unchanged frame does not repack');
    b.loadText('gamma\ndelta\nepsilon');
    st = batch.update(camera);
    ok(repacks === 1 && arena.getGlyphCount() === a.getGlyphCount() + b.getGlyphCount(), 'a text change repacks with the new glyph count');
    ok(poseError(b) < 1e-6 * 40000, 'the repacked label still lands where its mesh puts it');
    a.setGlyphColorRange(0, a.getGlyphCount(), { r: 1, g: 0, b: 0 });
    batch.update(camera);
    ok(repacks === 2, 'a colour write repacks (the slot version moved)');
    batch._repack = orig;
}

// ── membership: remove / re-add ──────────────────────────────────────────────────────────
{
    holder.remove(a.instanceMesh);
    ok(a.instanceMesh.layers.isEnabled(0), 'a removed field gets its view layer back');
    st = batch.update(camera);
    ok(st.drawn === 1 && arena.getGlyphCount() === b.getGlyphCount(), 'membership drops it from the arena');
    holder.add(a.instanceMesh); scene.updateMatrixWorld();
    st = batch.update(camera);
    ok(st.drawn === 2, 're-added: batched again');
}

// ── refusals draw themselves ─────────────────────────────────────────────────────────────
{
    const c = label('grouped');
    c.slotBuffer.f32[LANE_GROUP_ID] = 1;   // a glyph in another group
    c.setSlots(c.slotBuffer, c.getGlyphCount());
    holder.add(c.instanceMesh); scene.updateMatrixWorld();
    const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
    st = batch.update(camera); batch.update(camera);
    console.warn = warn;
    ok(st.own === 1 && c.instanceMesh.layers.isEnabled(0) && warned === 1, 'a glyph outside group 0: it draws itself, one warning');
    holder.remove(c.instanceMesh); c.dispose();

    const shear = new THREE.Object3D(); shear.scale.set(3, 1, 1);
    const tilt = new THREE.Object3D(); tilt.rotation.z = 0.6;
    const d = label('sheared');
    holder.add(shear); shear.add(tilt); tilt.add(d.instanceMesh); scene.updateMatrixWorld();
    st = batch.update(camera);
    ok(st.own === 1 && d.instanceMesh.layers.isEnabled(0), 'a sheared pose (non-uniform scale above a rotation) draws itself');
    tilt.rotation.z = 0; scene.updateMatrixWorld();
    st = batch.update(camera);
    ok(st.own === 0 && !d.instanceMesh.layers.isEnabled(0) && poseError(d) < 1e-6 * 40000, 'unsheared again: batched, and posed right');
    holder.remove(shear); d.dispose();
}

// ── far-LOD leaves batched fields alone; pick passes don't refresh ───────────────────────
{
    const lod = new GlyphFarLod(scene);
    look(centre.x, centre.y, centre.z + 4e6, centre.x, centre.y, centre.z);   // sub-pixel
    batch.update(camera);
    lod.update(camera, 1000);
    ok(!a.instanceMesh.layers.isEnabled(0) && lod.stats.far === 0, 'far-LOD neither swaps nor re-layers a batched field');
    lod.dispose();
    ok(!a.instanceMesh.layers.isEnabled(0), 'far-LOD dispose leaves batched fields off the view layer');

    let calls = 0; const orig = batch.update.bind(batch);
    batch.update = (cam) => { calls++; return orig(cam); };
    const pickCam = camera.clone(); pickCam.layers.set(7);
    scene.onBeforeRender(null, scene, pickCam, null);
    ok(calls === 0, 'a pick camera (no view layer) does not refresh the batch');
    scene.onBeforeRender(null, scene, camera, null);
    ok(calls === 1, 'the view camera does');
    batch.update = orig;
}

// ── dispose ──────────────────────────────────────────────────────────────────────────────
{
    const arenaMesh = batch.arena.instanceMesh;
    batch.dispose();
    ok(a.instanceMesh.layers.isEnabled(0) && b.instanceMesh.layers.isEnabled(0), 'dispose hands every field its own draw back');
    ok(!arenaMesh.parent, 'dispose removes the arena');
}

console.log(`glyph-batch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
