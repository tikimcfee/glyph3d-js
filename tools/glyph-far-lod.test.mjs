#!/usr/bin/env bun
// glyph-far-lod — GlyphFarLod's near/far decision, its backdrop stream, and the backdrop tint
// (InstancedField.farTint), headless: real fields and real three math, no GL context.
//
//   - the threshold: a field's tallest row in px at its box's nearest view DEPTH (perspective
//     and orthographic), exactly at the boundary; 0 = glyphs always
//   - a long field the camera stands at the end of keeps its glyphs (nearest depth, not centre)
//   - off-axis: a field at the view's edge measures as it projects (depth, not distance)
//   - far: the view layer leaves the mesh, `visible` is untouched, one backdrop quad is staged
//     over the laid-out box through the field's world matrix
//   - the tint: mean LINEAR ink colour (the shader's decode, through the group tint), ink cover
//     × group alpha; cached until the slot or group buffer version moves
//   - opt-outs (frustumCulled false), hidden ancestors, a grow past capacity, dispose

import * as THREE from 'three';
import InstancedField, { liveInstancedFields } from '../packages/glyph3d-core/src/collections/InstancedField.js';
import GlyphFarLod, { FAR_LOD_DEFAULTS } from '../packages/glyph3d-core/src/collections/GlyphFarLod.js';
import { packRgba8 } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL: ${m}`); } };
const close = (a, b, m, eps = 1e-6) => ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${m} (got ${a}, want ${b})`);

const H = 1000;   // viewport height, CSS px
const FOV = 50;
const pxPerUnit = H / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));

const scene = new THREE.Scene();
const lod = new GlyphFarLod(scene);
const camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.1, 1e7);
const lookFrom = (x, y, z) => { camera.position.set(x, y, z); camera.lookAt(x, y, 0); camera.updateMatrixWorld(); };

const field = new InstancedField(scene, null, { maxInstances: 400 });
field.loadText('alpha beta\ngamma delta epsilon\nzeta');
scene.updateMatrixWorld();
const L = field.layoutBounds;
const row = field.rowHeight;
ok(L && row > 0, `a laid-out field states its box and row height (row ${row})`);
eq(FAR_LOD_DEFAULTS.showGlyphsPx, 1, 'default threshold is 1 px per row (glyph3d-rs show_glyphs_px)');
function eq(a, b, m) { ok(a === b, `${m} (got ${a}, want ${b})`); }

const viewOn = (f) => f.instanceMesh.layers.isEnabled(0);
const cx = (L.min.x + L.max.x) / 2, cy = (L.min.y + L.max.y) / 2;

// ── the boundary: rowPx = row · pxPerUnit / nearest view depth ───────────────────────────
{
    const atPx = (px) => row * pxPerUnit / px;          // the distance at which a row measures px
    lookFrom(cx, cy, L.max.z + atPx(1) * 0.999);        // a hair nearer than 1 px/row
    let st = lod.update(camera, H);
    ok(viewOn(field) && st.far === 0, 'just above 1 px/row: glyphs drawn');
    ok(lod.mesh.visible === false && lod.mesh.count === 0, 'no far field → the backdrop mesh draws nothing');

    lookFrom(cx, cy, L.max.z + atPx(1) * 1.001);        // a hair farther
    st = lod.update(camera, H);
    ok(!viewOn(field) && st.far === 1 && st.backdrops === 1, 'just below 1 px/row: far, one backdrop');
    ok(field.instanceMesh.visible === true, 'far-LOD never touches the mesh\'s own visible flag');
    ok(lod.mesh.visible && lod.mesh.count === 1, 'the backdrop mesh draws one quad');

    // The quad is the laid-out box at the front of its depth, through the field's world matrix.
    const m = new THREE.Matrix4(); lod.mesh.getMatrixAt(0, m);
    const c00 = new THREE.Vector3(0, 0, 0).applyMatrix4(m), c11 = new THREE.Vector3(1, 1, 0).applyMatrix4(m);
    close(c00.x, L.min.x, 'backdrop corner (0,0) → layout min.x'); close(c00.y, L.min.y, 'backdrop corner (0,0) → layout min.y');
    close(c11.x, L.max.x, 'backdrop corner (1,1) → layout max.x'); close(c11.y, L.max.y, 'backdrop corner (1,1) → layout max.y');
    close(c00.z, L.max.z, 'backdrop sits at the front of the layout depth');

    lod.setParam('showGlyphsPx', 0);
    st = lod.update(camera, H);
    ok(viewOn(field) && st.far === 0, 'threshold 0: glyphs always, the view layer comes back');
    lod.setParam('showGlyphsPx', 4);
    lookFrom(cx, cy, L.max.z + atPx(4) * 1.001);
    ok(lod.update(camera, H).far === 1, 'the threshold dial moves the boundary (4 px/row)');
    lookFrom(cx, cy, L.max.z + atPx(4) * 0.999);
    ok(lod.update(camera, H).far === 0, '…and just inside it the glyphs return');
    lod.setParam('showGlyphsPx', 1);
    let threw = false; try { lod.setParam('showGlyphPx', 1); } catch { threw = true; }
    ok(threw, 'an unknown param throws (fail loud at the seam)');
}

// ── nearest point, not centre: a long file the camera stands at the end of keeps its glyphs ──
{
    const long = new InstancedField(scene, null, { maxInstances: 40000 });
    long.loadText(Array.from({ length: 2400 }, (_, i) => `line ${i}`).join('\n'));
    long.instanceMesh.position.set(10000, 0, 0);
    scene.updateMatrixWorld();
    const B = long.layoutBounds;
    const top = new THREE.Vector3((B.min.x + B.max.x) / 2, B.max.y, B.max.z).applyMatrix4(long.instanceMesh.matrixWorld);
    const d = long.rowHeight * pxPerUnit / 1.5;          // 1.5 px/row at the nearest point
    lookFrom(top.x, top.y, top.z + d);
    const centre = new THREE.Box3().copy(long.geometry.boundingBox).applyMatrix4(long.instanceMesh.matrixWorld).getCenter(new THREE.Vector3());
    const centrePx = long.rowHeight * pxPerUnit / camera.position.distanceTo(centre);
    ok(centrePx < 1, `the box centre measures under a pixel (${centrePx.toFixed(3)} px/row)…`);
    lod.update(camera, H);
    ok(viewOn(long), '…but the nearest point measures 1.5 px/row: the long file keeps its glyphs');
    long.dispose();
    ok(!liveInstancedFields().has(long), 'a disposed field leaves the live set');
}

// ── off-axis: depth, not distance — what a flat screen draws ─────────────────────────────
{
    // The field 32° off the view axis, at a view depth where its rows project to 1.1 px:
    // its distance is depth / cos 32° (0.94 px by distance), its pixels say 1.1.
    const depth = row * pxPerUnit / 1.1, side = depth * Math.tan(THREE.MathUtils.degToRad(32));
    camera.position.set(cx - side, cy, L.max.z + depth); camera.lookAt(cx - side, cy, 0); camera.updateMatrixWorld();
    const a = new THREE.Vector3(cx, cy, L.max.z).project(camera), b = new THREE.Vector3(cx, cy + row, L.max.z).project(camera);
    const projected = (b.y - a.y) * H / 2;
    close(projected, 1.1, 'the off-axis field projects at 1.1 px/row', 1e-3);
    ok(row * pxPerUnit / camera.position.distanceTo(new THREE.Vector3(cx, cy, L.max.z)) < 1, 'by distance it would measure under a pixel');
    ok(lod.update(camera, H).far === 0 && viewOn(field), 'it keeps its glyphs: the measure is the projected size');
}

// ── scale through the world matrix ────────────────────────────────────────────────────────
{
    lookFrom(cx, cy, L.max.z + row * pxPerUnit / 1 * 1.5);   // 0.67 px/row at scale 1 → far
    ok(lod.update(camera, H).far === 1, 'unscaled at 0.67 px/row: far');
    field.instanceMesh.scale.setScalar(2); scene.updateMatrixWorld();
    lookFrom(cx * 2, cy * 2, L.max.z * 2 + row * pxPerUnit / 1 * 1.5);
    ok(lod.update(camera, H).far === 0 && viewOn(field), 'scaled ×2 the same distance reads 1.33 px/row: near');
    field.instanceMesh.scale.setScalar(1); scene.updateMatrixWorld();
}

// ── orthographic: no distance, px per world unit is the view's ─────────────────────────────
{
    const ortho = new THREE.OrthographicCamera(-100, 100, 50, -50, 0.1, 1e6);
    ortho.position.set(cx, cy, 100); ortho.lookAt(cx, cy, 0); ortho.updateMatrixWorld();
    // row px = row · H · zoom / (top − bottom)
    ortho.zoom = (1 / row) * (100 / H) * 1.01; ortho.updateProjectionMatrix();
    ok(lod.update(ortho, H).far === 0 && viewOn(field), 'ortho at 1.01 px/row: near');
    ortho.zoom = (1 / row) * (100 / H) * 0.99; ortho.updateProjectionMatrix();
    ok(lod.update(ortho, H).far === 1 && !viewOn(field), 'ortho at 0.99 px/row: far');
}

// ── the tint ──────────────────────────────────────────────────────────────────────────────
{
    const n = field.getGlyphCount();
    for (let s = 0; s < n; s++) field.writeColor(s, packRgba8(1, 0, 0, 1));
    let t = field.farTint();
    close(t.r, 1, 'all-red ink: mean linear r = 1'); close(t.g, 0, 'g = 0'); close(t.b, 0, 'b = 0');
    // cover = Σ advance·height / box area
    const f32 = field.slotBuffer.f32; let area = 0;
    for (let s = 0; s < n; s++) area += f32[s * 8 + 6] * f32[s * 8 + 7];
    close(t.cover, area / ((L.max.x - L.min.x) * (L.max.y - L.min.y)), 'ink cover = cell area / box area');
    ok(field.farTint() === t, 'unchanged buffers: the cached tint comes back');

    field.writeColor(0, packRgba8(0, 0, 1, 1));      // writeColor bumps the slot buffer version
    t = field.farTint();
    close(t.b, 1 / n, 'one blue glyph of n: b = 1/n (linear mean)', 1e-9);
    close(t.r, (n - 1) / n, 'r = (n-1)/n', 1e-9);

    const half = 128 / 255;                          // sRGB 128 → the shader's pow(c, 2.2)
    for (let s = 0; s < n; s++) field.writeColor(s, packRgba8(half, half, half, 1));
    close(field.farTint().r, Math.pow(128 / 255, 2.2), 'mid grey averages in LINEAR (pow 2.2), not sRGB', 1e-9);

    field.setGroupAlpha?.(0, 0.5);
    if (field.setGroupAlpha) close(field.farTint().cover, area / ((L.max.x - L.min.x) * (L.max.y - L.min.y)) * 0.5, 'group alpha 0.5 halves the cover');
    else ok(false, 'InstancedField.setGroupAlpha exists');
    field.setGroupAlpha?.(0, 1);
}

// ── opt-outs and hidden ancestors ─────────────────────────────────────────────────────────
{
    lookFrom(cx, cy, L.max.z + row * pxPerUnit * 3);     // 0.33 px/row
    ok(lod.update(camera, H).far === 1, 'far again');
    const parent = new THREE.Group(); scene.add(parent); parent.add(field.instanceMesh);
    parent.visible = false; scene.updateMatrixWorld();
    let st = lod.update(camera, H);
    ok(st.far === 1 && st.backdrops === 0, 'a far field under a hidden ancestor stages no backdrop');
    parent.visible = true; scene.add(field.instanceMesh); scene.remove(parent); scene.updateMatrixWorld();

    field.instanceMesh.frustumCulled = false;
    st = lod.update(camera, H);
    ok(viewOn(field) && st.fields === 0, 'a field that opts out of culling (untruthful bounds) opts out of far-LOD');
    field.instanceMesh.frustumCulled = true;
}

// ── grow past capacity mid-update keeps every staged backdrop ─────────────────────────────
{
    const many = [];
    for (let i = 0; i < 300; i++) {
        const f = new InstancedField(scene, null, { maxInstances: 16 });
        f.loadText(`f${i}`);
        f.instanceMesh.position.set(i * 50, 0, 0);
        many.push(f);
    }
    scene.updateMatrixWorld();
    lookFrom(0, 0, 1e6);
    const st = lod.update(camera, H);
    ok(st.backdrops === 301 && lod.mesh.count === 301, `301 far fields → 301 backdrops across a grow (got ${st.backdrops})`);
    // backdrop 0 is `field`'s, staged before the grow: its quad and tint must survive it
    // (the far corner — L.min is the origin, which an identity matrix would also hit)
    const m = new THREE.Matrix4(); lod.mesh.getMatrixAt(0, m);
    close(new THREE.Vector3(1, 1, 0).applyMatrix4(m).x, L.max.x, 'backdrop 0 (staged before the grow) keeps its quad');
    const t0 = field.farTint(), a0 = lod.mesh.geometry.getAttribute('aTint').array;
    ok(L.max.x !== 0 && a0[3] > 0 && Math.abs(a0[0] - t0.r) < 1e-6 && Math.abs(a0[3] - t0.cover) < 1e-6, 'backdrop 0 keeps its tint across the grow');
    for (const f of many) f.dispose();
}

// ── dispose restores every view layer ────────────────────────────────────────────────────
{
    lookFrom(cx, cy, 1e6);
    lod.update(camera, H);
    ok(!viewOn(field), 'far before dispose');
    lod.dispose();
    ok(viewOn(field), 'GlyphFarLod.dispose gives every field its view layer back');
    ok(!scene.children.some((c) => c.name === 'glyph-far-backdrops'), 'the backdrop mesh leaves the scene');
}

field.dispose();
console.log(`\nglyph-far-lod: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
