#!/usr/bin/env bun
// panel-batch — PanelBatch draws every enrolled panel as an instance, headless: real meshes,
// real panel materials, real three math, no GL context.
//
//   - enrollPanel takes only a 1×1 single-segment plane wearing a panel material (fails loud);
//     membership follows the mesh's own add/remove and its material's dispose
//   - a refresh runs from scene.onBeforeRender for cameras that see layer 0 (never pick passes)
//   - an instance carries the panel's uniforms and its world matrix, eye-relative, with the
//     bucket mesh posed at the eye; members leave layer 0, hidden ones draw nothing
//   - buckets split by render state; a bucket draws half a step before its render order
//   - a translucent bucket sorts the way three sorts objects (projected depth far→near, id)
//   - real producers: GridBackground and a flat page face enroll, a warp face doesn't
//   - box fills and box outlines: colour × opacity per instance, a fill draws before its outline,
//     outlines draw as lines; under fog they draw themselves
//   - a grow past capacity, another scene's panels, dispose

import * as THREE from 'three';
import PanelBatch, { enrollPanel, enrolledPanels } from '../packages/glyph3d-core/src/collections/PanelBatch.js';
import { createPanelMaterial, BORDER_FLAGS } from '../packages/glyph3d-core/src/collections/panelMaterial.js';
import { createBackgroundMesh } from '../packages/glyph3d-core/src/collections/grid/GridBackground.js';
import { addPanelSurface } from '../packages/glyph3d-core/src/collections/layouts/panelSurface.js';
import { RENDER_ORDER } from '../packages/glyph3d-core/src/core/renderOrder.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL: ${m}`); } };
const close = (a, b, m, eps = 1e-5) => ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${m} (got ${a}, want ${b})`);
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (did not throw)`); } catch (e) { ok(re.test(e.message), `${m} (${e.message})`); } };

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1e6);
camera.position.set(1000, 2000, 500);
camera.lookAt(1000, 2000, 0);
camera.updateMatrixWorld();
const viewOn = (m) => m.layers.isEnabled(0);

/** A panel: own plane + own panel material, scaled + placed, under `parent`. */
function panel(parent, { x = 0, y = 0, z = 0, w = 4, h = 2, opacity = 0.5, color = 0x336699, renderOrder = 0 } = {}) {
    const handle = createPanelMaterial({ color, opacity });
    const mesh = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), handle.material));
    mesh.scale.set(w, h, 1);
    mesh.position.set(x, y, z);
    mesh.renderOrder = renderOrder;
    parent.add(mesh);
    return { mesh, handle };
}

// ── enrollPanel fails loud on what it can't batch ───────────────────────────────────────
{
    const mat = createPanelMaterial().material;
    throws(() => enrollPanel(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)), /MeshBasicMaterial/, 'a box in a panel material is refused');
    throws(() => enrollPanel(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshBasicMaterial())), /1×1×1/, 'a 2×1×1 box is refused');
    throws(() => enrollPanel(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }))), /map/, 'a textured box is refused');
    throws(() => enrollPanel(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 2, 1)), new THREE.LineBasicMaterial())), /unit BoxGeometry/, 'the edges of a non-unit box are refused');
    throws(() => enrollPanel(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.MeshBasicMaterial())), /LineBasicMaterial/, 'edges in a mesh material are refused');
    throws(() => enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(2, 1), mat)), /1×1/, 'a 2×1 plane is refused');
    throws(() => enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 1), mat)), /single-segment/, 'a segmented plane is refused');
    throws(() => enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial())), /createPanelMaterial/, 'a non-panel material is refused');
    throws(() => new PanelBatch(new THREE.Group()), /Scene/, 'a batch needs a Scene');
}

// ── membership follows add / remove / material dispose ──────────────────────────────────
{
    const handle = createPanelMaterial();
    const m = enrollPanel(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), handle.material));
    ok(!enrolledPanels().has(m), 'an unattached enrolled panel is not live yet');
    const g = new THREE.Group();
    g.add(m);
    ok(enrolledPanels().has(m), 'added → live');
    m.layers.disable(0);
    g.remove(m);
    ok(!enrolledPanels().has(m) && viewOn(m), 'removed → not live, and its own view layer is back');
    g.add(m);
    ok(enrolledPanels().has(m), 're-added → live again');
    m.layers.disable(0);
    handle.material.dispose();
    ok(!enrolledPanels().has(m) && viewOn(m), 'material disposed → not live, view layer back');
    g.remove(m);
}

const batch = new PanelBatch(scene);
const root = new THREE.Group();
root.position.set(1000, 2000, 0);
scene.add(root);
scene.updateMatrixWorld();

// ── the hook: view cameras refresh, pick cameras don't ──────────────────────────────────
const a = panel(root, { x: -3, y: 1, z: -5, w: 4, h: 2, opacity: 0.5, color: 0xff8800 });
scene.updateMatrixWorld();
{
    const pick = camera.clone();
    pick.layers.set(8);
    scene.onBeforeRender(null, scene, pick, null);
    ok(viewOn(a.mesh) && batch.stats.drawn === 0, 'a pick camera (no layer 0) does not refresh the batch');
    scene.onBeforeRender(null, scene, camera, null);
    ok(!viewOn(a.mesh) && batch.stats.drawn === 1, 'the view camera refreshes it: the panel leaves layer 0, one instance drawn');
}

// ── an instance carries the panel: uniforms + eye-relative world matrix ─────────────────
{
    a.handle.setBorder({ color: 0x00ff00, width: 2.5, intensity: 0.75 });
    a.handle.setBorderFlag(BORDER_FLAGS.FOCUSED, true);
    a.handle.setStateColors({ hover: 0x112233, focus: 0x445566, input: 0x778899, capture: 0xaabbcc });
    batch.update(camera);
    const b = [...batch._buckets.values()].find((x) => x.members.includes(a.mesh));
    const im = b.mesh, i = b.members.indexOf(a.mesh);
    const u = a.mesh.material.uniforms, at = im.geometry.attributes;
    close(at.aFill.getX(i), u.uFill.value.r, 'fill r'); close(at.aFill.getZ(i), u.uFill.value.b, 'fill b');
    close(at.aFill.getW(i), 0.5, 'opacity');
    close(at.aBorder.getY(i), u.uBorderColor.value.g, 'border g'); close(at.aBorder.getW(i), 2.5, 'border width');
    close(at.aMisc.getX(i), 0.75, 'border intensity'); close(at.aMisc.getY(i), BORDER_FLAGS.FOCUSED, 'flags');
    close(at.aHover.getX(i), u.uHoverColor.value.r, 'hover r'); close(at.aFocus.getY(i), u.uFocusColor.value.g, 'focus g');
    close(at.aInput.getZ(i), u.uInputColor.value.b, 'input b'); close(at.aCapture.getX(i), u.uCaptureColor.value.r, 'capture r');
    const mi = new THREE.Matrix4().fromArray(at.aInstance.array, i * 16);
    const world = new THREE.Matrix4().multiplyMatrices(im.matrixWorld, mi);
    let maxErr = 0;
    for (let k = 0; k < 16; k++) maxErr = Math.max(maxErr, Math.abs(world.elements[k] - a.mesh.matrixWorld.elements[k]));
    ok(maxErr < 1e-3, `bucket pose × instance matrix = the panel's matrixWorld (max err ${maxErr})`);
    close(mi.elements[12], a.mesh.matrixWorld.elements[12] - camera.position.x, 'instance translation is eye-relative (x)');
    close(im.matrixWorld.elements[13], camera.position.y, 'the bucket mesh sits at the eye (y)');
    ok(im.renderOrder === -0.5, `a render-order-0 bucket draws at -0.5 (got ${im.renderOrder})`);
    ok(im.geometry.instanceCount === 1 && im.visible, 'one instance, visible');
}

// ── visibility: the mesh, every ancestor, the material ─────────────────────────────────
{
    root.visible = false;
    batch.update(camera);
    ok(batch.stats.drawn === 0 && batch.stats.hidden === 1 && !viewOn(a.mesh), 'a hidden ancestor: no instance, panel still off layer 0');
    root.visible = true;
    a.mesh.visible = false;
    batch.update(camera);
    ok(batch.stats.drawn === 0, 'mesh.visible false: no instance');
    a.mesh.visible = true;
    a.mesh.material.visible = false;
    batch.update(camera);
    ok(batch.stats.drawn === 0, 'material.visible false: no instance');
    a.mesh.material.visible = true;
    batch.update(camera);
    ok(batch.stats.drawn === 1, 'all visible again: drawn');
    const b = [...batch._buckets.values()].find((x) => x.members.includes(a.mesh));
    root.visible = false; batch.update(camera); root.visible = true;
    ok(!b.mesh.visible && b.mesh.geometry.instanceCount === 0, 'an emptied bucket draws nothing');
}

// ── frustum: an instance outside the view is culled, as three culls the object ──────────
{
    const off = panel(root, { x: 0, y: 0, z: 800, opacity: 0.5 });   // behind the camera
    const wide = panel(root, { x: 3000, y: 0, z: -5, w: 8000, h: 2, opacity: 0.5 });   // centre far off-screen, its span crosses the view
    scene.updateMatrixWorld();
    batch.update(camera);
    const inBatch = (m) => [...batch._buckets.values()].some((x) => x.members.includes(m));
    ok(!inBatch(off.mesh) && batch.stats.culled >= 1 && !viewOn(off.mesh), 'a panel behind the camera is culled (and stays off layer 0)');
    ok(inBatch(wide.mesh), 'a panel centred off-screen whose span crosses the view is kept');
    root.remove(off.mesh); root.remove(wide.mesh);
}

// ── buckets split by render state ───────────────────────────────────────────────────────
const opaque = panel(root, { x: 6, z: -5, opacity: 1 });
const back = panel(root, { z: -9, opacity: 0.85, renderOrder: RENDER_ORDER.GRID_BACKGROUND });
scene.updateMatrixWorld();
{
    batch.update(camera);
    const bucketOf = (m) => [...batch._buckets.values()].find((x) => x.members.includes(m));
    ok(bucketOf(opaque.mesh) !== bucketOf(a.mesh), 'opaque and translucent panels draw in different buckets');
    ok(bucketOf(opaque.mesh).mesh.material.transparent === false, 'the opaque bucket is not transparent');
    ok(bucketOf(back.mesh).mesh.renderOrder === RENDER_ORDER.GRID_BACKGROUND - 0.5, 'a GRID_BACKGROUND bucket draws at -1.5');
    a.handle.setFill(null, 1);
    batch.update(camera);
    ok(bucketOf(a.mesh) === bucketOf(opaque.mesh), 'setFill to opacity 1 moves a panel to the opaque bucket next frame');
    a.handle.setFill(null, 0.5);
    batch.update(camera);
    ok(bucketOf(a.mesh) !== bucketOf(opaque.mesh), '…and back');
    a.mesh.renderOrder = RENDER_ORDER.GRID_BACKGROUND;
    batch.update(camera);
    ok(bucketOf(a.mesh) === bucketOf(back.mesh), 'a render-order change re-buckets the panel next frame');
    a.mesh.renderOrder = 0;
    batch.update(camera);
}

// ── a translucent bucket sorts as three sorts objects ──────────────────────────────────
{
    const many = [];
    for (let k = 0; k < 12; k++) many.push(panel(root, { x: (k % 4) * 5 - 8, y: Math.floor(k / 4) * 3, z: -20 + ((k * 7) % 11), opacity: 0.4 }).mesh);
    // two at the same depth: the tie goes to the lower id
    many.push(panel(root, { x: 30, y: 0, z: -12, opacity: 0.4 }).mesh, panel(root, { x: -30, y: 0, z: -12, opacity: 0.4 }).mesh);
    scene.updateMatrixWorld();
    camera.position.set(1004, 1990, 40); camera.lookAt(1000, 2000, -10); camera.updateMatrixWorld();
    batch.update(camera);
    const b = [...batch._buckets.values()].find((x) => x.members.includes(many[0]));
    const proj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // three: z = boundingSphere centre (the plane's origin) → matrixWorld → projScreen; far→near, then id
    const z = (m) => {
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        return m.geometry.boundingSphere.center.clone().applyMatrix4(m.matrixWorld).applyMatrix4(proj).z;
    };
    const want = [...b.members].sort((p, q) => (z(q) - z(p)) || (p.id - q.id));
    ok(b.members.length >= 14 && b.members.every((m, i) => m === want[i]), `instances follow three's transparent order (${b.members.length} members)`);
    const n = b.members.length;
    ok(b.capacity >= n, `the bucket grew past 64 when needed (capacity ${b.capacity})`);
}

// ── a grow past capacity carries on ─────────────────────────────────────────────────────
{
    const extra = [];
    for (let k = 0; k < 150; k++) extra.push(panel(root, { x: k, z: -30, opacity: 0.3, color: 0x123456 }).mesh);
    scene.updateMatrixWorld();
    batch.update(camera);
    const b = [...batch._buckets.values()].find((x) => x.members.includes(extra[0]));
    ok(b.capacity >= b.members.length && b.mesh.geometry.instanceCount === b.members.length, `grown: ${b.mesh.geometry.instanceCount} instances in capacity ${b.capacity}`);
    ok(b.mesh.parent === scene && scene.children.filter((c) => c.name === b.mesh.name && c.renderOrder === b.mesh.renderOrder && c.material === b.material).length === 1, 'the grown mesh replaced the old one in the scene');
    for (const m of extra) root.remove(m);
}

// ── real producers ──────────────────────────────────────────────────────────────────────
{
    const { mesh } = createBackgroundMesh({ backgroundColor: 0x101020, backgroundOpacity: 0.92 }, 0.5);
    root.add(mesh);
    ok(enrolledPanels().has(mesh), 'a GridBackground mesh is enrolled');
    const node = new THREE.Group(); root.add(node);
    const opts = { surface: true, surfacePad: 0, surfaceDepth: 8, surfaceColor: 0x0a0a1e, surfaceOpacity: 0.85, surfaceBorder: true, surfaceBorderColor: 0x3a4a6a, surfaceSegments: 8 };
    const flat = addPanelSurface(node, { mode: 'flat', box: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 6, 0)) }, opts);
    ok(enrolledPanels().has(flat), 'a flat page face is enrolled');
    const warp = addPanelSurface(node, { mode: 'warp', apothem: 100, theta: 0, topY: 0, w: 20, h: 10 }, opts);
    ok(warp && !enrolledPanels().has(warp), 'a warp face (its own curved geometry) is not');
    scene.updateMatrixWorld();
    batch.update(camera);
    ok(!viewOn(flat) && viewOn(warp), 'the batch takes the flat face off layer 0 and leaves the warp face drawing itself');
}

// ── box fills and outlines ───────────────────────────────────────────────────────────────
const unitBox = new THREE.BoxGeometry(1, 1, 1), unitEdges = new THREE.EdgesGeometry(unitBox);
const box = enrollPanel(new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: 0x5a7ea8, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide })));
const outline = enrollPanel(new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: 0x5a7ea8, transparent: true, opacity: 0.22, depthWrite: false })));
box.add(outline);
box.scale.set(40, 30, 20); box.position.set(5, 5, -15);
box.renderOrder = outline.renderOrder = RENDER_ORDER.BACKDROP_BASE;
root.add(box);
scene.updateMatrixWorld();
{
    batch.update(camera);
    const bucketOf = (m) => [...batch._buckets.values()].find((x) => x.members.includes(m));
    const bf = bucketOf(box), be = bucketOf(outline);
    ok(bf && be && bf !== be, 'a box fill and its outline draw in their own buckets');
    ok(!viewOn(box) && !viewOn(outline), 'both leave layer 0');
    ok(bf.mesh.isMesh && be.mesh.isLineSegments, 'the fill bucket draws a mesh, the outline bucket lines');
    close(bf.mesh.renderOrder, RENDER_ORDER.BACKDROP_BASE - 0.4, 'a fill bucket draws at band − 0.4 (after the band\'s panels)');
    close(be.mesh.renderOrder, RENDER_ORDER.BACKDROP_BASE - 0.3, 'an outline bucket at band − 0.3 (after its fills)');
    const i = bf.members.indexOf(box), c = bf.mesh.geometry.attributes.aColor;
    close(c.getX(i), box.material.color.r, 'fill colour r'); close(c.getW(i), 0.06, 'fill opacity');
    const j = be.members.indexOf(outline), ce = be.mesh.geometry.attributes.aColor;
    close(ce.getW(j), 0.22, 'outline opacity');
    const mi = new THREE.Matrix4().fromArray(be.mesh.geometry.attributes.aInstance.array, j * 16);
    const world = new THREE.Matrix4().multiplyMatrices(be.mesh.matrixWorld, mi);
    close(world.elements[0], outline.matrixWorld.elements[0], 'the outline rides its box\'s scale');
    ok(bf.mesh.geometry.index && be.mesh.geometry.attributes.position.count === 24, 'unit geometries: an indexed box, 12 edges');
    box.material.opacity = 0.3;
    batch.update(camera);
    close(bf.mesh.geometry.attributes.aColor.getW(bf.members.indexOf(box)), 0.3, 'an opacity write lands next frame');
    // fog: the basic shader draws none, so fills + outlines draw themselves while it's set
    const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
    scene.fog = new THREE.Fog(0x000000, 1, 1000);
    batch.update(camera); batch.update(camera);
    ok(viewOn(box) && viewOn(outline) && batch.stats.own >= 2, 'under fog, fills and outlines draw themselves');
    ok(!viewOn(a.mesh), '…panels stay batched');
    ok(warned === 1, `the fog fallback says why, once (${warned})`);
    console.warn = warn;
    scene.fog = null;
    batch.update(camera);
    ok(!viewOn(box) && !viewOn(outline), 'fog cleared: batched again');
}

// ── another scene's panels are not this batch's ────────────────────────────────────────
{
    const other = new THREE.Scene();
    const o = panel(other, {});
    batch.update(camera);
    ok(viewOn(o.mesh) && batch.stats.elsewhere >= 1, 'a panel in another scene keeps its own draw');
    other.remove(o.mesh);
}

// ── dispose hands every panel back its own draw ─────────────────────────────────────────
{
    const meshes = scene.children.filter((c) => c.name.startsWith('panel-batch'));
    ok(meshes.length === batch._buckets.size, `one instanced mesh per bucket in the scene (${meshes.length})`);
    batch.dispose();
    ok(viewOn(a.mesh) && viewOn(opaque.mesh) && viewOn(back.mesh), 'every panel is back on layer 0');
    ok(!scene.children.some((c) => c.name.startsWith('panel-batch')), 'the batch meshes are gone');
    ok(viewOn(box) && viewOn(outline), 'fills and outlines too');
    const before = a.mesh.layers.mask;
    scene.onBeforeRender(null, scene, camera, null);
    ok(a.mesh.layers.mask === before, 'the hook is unhooked: a render no longer touches panels');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
