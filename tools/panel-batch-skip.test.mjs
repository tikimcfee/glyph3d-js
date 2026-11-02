// panel-batch-skip.test.mjs — PanelBatch writes and uploads only what changed (collections/PanelBatch.js):
// a still panel (its world matrix, the camera, its clip held; its material's panelVersion unchanged)
// keeps its instance; at rest nothing is rewritten or uploaded.
//
//   bun tools/panel-batch-skip.test.mjs
//
// Locks:
//   - after EVERY kind of change, every bucket equals a FRESH batch's — same members in the same
//     order, the same instance matrix and lanes — and a model of the GPU's copy of each instance
//     attribute (uploads applied as three does: the ranges, then cleared) equals the CPU arrays
//   - changes covered: a still frame, a panel restyled through its handle (fill, a border flag),
//     a box fill recoloured directly (basic materials carry no version), a panel moved under a
//     still camera, hidden and shown, cut by a clip and uncut, a camera move, a panel joining and
//     one leaving
//   - at rest nothing uploads (no attribute version moves); teeth: the every-frame upload moves it
//   - teeth: a skip blind to the material's panelVersion leaves the restyled panel stale

import * as THREE from 'three';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import PanelBatch, { enrollPanel } from '../packages/glyph3d-core/src/collections/PanelBatch.js';
import { createPanelMaterial, BORDER_FLAGS } from '../packages/glyph3d-core/src/collections/panelMaterial.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const scene = new THREE.Scene();
new SceneTransforms(scene);
const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1e7);
camera.position.set(0, 0, 900); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
const handles = [], fills = [], objs = [];
const addPanel = (i) => {
    const h = createPanelMaterial({ color: 0x223344, opacity: i % 2 ? 1 : 0.8 });
    const o = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), h.material));
    o.position.set((i % 8) * 40 - 160, Math.floor(i / 8) * 20 - 60, (i % 3) * -2); o.scale.set(30, 12, 1);
    scene.add(o); handles.push(h); objs.push(o);
    return o;
};
for (let i = 0; i < 24; i++) addPanel(i);
for (let i = 0; i < 6; i++) {
    const o = enrollPanel(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.3 })));
    o.position.set(i * 50 - 120, 120, -5); o.scale.set(20, 20, 20); scene.add(o); fills.push(o); objs.push(o);
}
scene.updateMatrixWorld();
const batch = new PanelBatch(scene);

/** The GPU's copy of every bucket attribute, uploaded the way three's WebGLAttributes does. */
const gpu = new Map();
function render() {
    for (const b of batch._buckets.values()) {
        const g = b.mesh.geometry;
        for (const name in g.attributes) {
            const a = g.attributes[name];
            if (!a.isInstancedBufferAttribute) continue;
            let c = gpu.get(a);
            if (!c) { c = { copy: new Float32Array(a.array.length), version: -1 }; gpu.set(a, c); }
            if (c.copy.length !== a.array.length) { c.copy = new Float32Array(a.array.length); c.version = -1; }
            if (a.version === c.version) continue;
            if (c.version === -1 || !a.updateRanges.length) c.copy.set(a.array);
            else for (const r of a.updateRanges) c.copy.set(a.array.subarray(r.start, r.start + r.count), r.start);
            a.clearUpdateRanges();   // what three's renderer does after the upload
            c.version = a.version;
        }
    }
}
const frame = () => { const st = batch.update(camera); render(); return st; };
const versions = () => [...batch._buckets.values()].flatMap((b) => Object.values(b.mesh.geometry.attributes).filter((a) => a.isInstancedBufferAttribute).map((a) => a.version)).join();

/** Every bucket equals a fresh batch's, and the GPU copy equals the CPU arrays. */
function matchesFresh() {
    const fresh = new PanelBatch(scene);
    fresh.update(camera);
    let same = true;
    for (const [key, fb] of fresh._buckets) {
        const b = batch._buckets.get(key);
        const n = fb.members.length;
        if (!b || b.members.length !== n || b.members.some((p, i) => p !== fb.members[i])) { same = false; break; }
        const A = b.mesh.geometry.attributes, F = fb.mesh.geometry.attributes;
        for (const name in F) {
            if (!F[name].isInstancedBufferAttribute) continue;
            const sz = F[name].itemSize;
            for (let k = 0; k < n * sz; k++) if (!Object.is(A[name].array[k], F[name].array[k])) { same = false; break; }
            const c = gpu.get(A[name]);
            if (!c) { same = false; break; }
            for (let k = 0; k < n * sz; k++) if (!Object.is(c.copy[k], A[name].array[k])) { same = false; break; }
        }
    }
    fresh.dispose();
    batch.update(camera);   // the fresh batch's dispose handed layers back; this batch takes them again
    render();
    return same;
}

frame(); frame();
const steps = [
    ['still', () => {}],
    ['a panel restyled through its handle (fill)', () => handles[3].setFill(0x884422, 0.6)],
    ['a border flag set through the handle', () => handles[5].setBorderFlag(BORDER_FLAGS.HOVERED ?? 2, true)],
    ['a box fill recoloured directly', () => { fills[1].material.color.set(0xff0000); fills[1].material.opacity = 0.5; }],
    ['a panel moved, camera still', () => { objs[7].position.x += 11; scene.updateMatrixWorld(); }],
    ['a panel hidden', () => { objs[9].visible = false; }],
    ['shown again', () => { objs[9].visible = true; }],
    ['a panel cut by a clip', () => { objs[2].userData.panelClip = { left: -170, right: -150, top: 80, bottom: -80 }; }],
    ['uncut', () => { delete objs[2].userData.panelClip; }],
    ['the camera moved', () => { camera.position.y += 7; camera.updateMatrixWorld(); }],
    ['a panel joined', () => { addPanel(30); scene.updateMatrixWorld(); }],
    ['a panel left', () => { scene.remove(objs[4]); }],
    ['still again', () => {}],
];
for (const [what, act] of steps) {
    act();
    frame();
    ok(matchesFresh(), `${what}: every bucket equals a fresh batch's, and the GPU copy is exact`);
}

// At rest nothing uploads.
{
    frame();
    const v = versions();
    let st;
    for (let i = 0; i < 5; i++) st = frame();
    ok(versions() === v && st.uploaded === 0, `at rest: no attribute version moves in 5 frames (uploaded ${st.uploaded})`);
    // Teeth: the every-frame upload moves them.
    for (const b of batch._buckets.values()) { const a = b.mesh.geometry.attributes.aInstance; a.addUpdateRange(0, 16); a.needsUpdate = true; }
    ok(versions() !== v, 'teeth: an every-frame upload moves the versions at rest');
    render();
}

// Teeth: a skip blind to panelVersion leaves the restyle stale.
{
    handles[11].setFill(0x00ff00, 1);
    for (const b of batch._buckets.values()) {
        const i = b.members.indexOf(objs[11]);
        if (i >= 0) b.readAt[i] = handles[11].material.userData.panelVersion;   // pretend it was read
    }
    frame();
    ok(!matchesFresh(), 'teeth: a skip blind to the panel version leaves the restyled panel stale');
}

console.log(`${fails ? 'FAIL' : 'ok'} panel-batch-skip: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
