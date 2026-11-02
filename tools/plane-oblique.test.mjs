// plane-oblique.test.mjs — the orthographic plane endpoint's FAN lands every layer on whole device
// pixels (DESIGN §4.6, slice 10b): entered through the real controller (ViewerCameraController.
// enterPlane with `ortho`, then setPlaneFan), layers 0..20 stand behind the plane one pitch apart
// and one row higher each (LayerStack's rise), every cell origin of every layer is projected
// through three's own projection (PlaneCamera at λ = 0, its shear), at odd viewports and dpr 1 / 2.
//
//   bun tools/plane-oblique.test.mjs
//
// Locks:
//   - every layer's cell origins land on integer device px (x and y), layer i exactly i·n device
//     px right of layer 0 and i rows (whole px) up; the plane itself (layer 0) doesn't move when
//     the fan opens
//   - teeth: a NON-INTEGER n (2.5 px) puts odd layers between pixels — the integer check fails;
//     an UNPINNED d₀ (the shear computed for a depth 1% off the plane's) moves the layers off
//     i·n — the offset check fails
//   - a negative n fans left, the same whole px

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import PlaneCamera, { fanShear } from '../packages/glyph3d-core/src/services/camera/PlaneCamera.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const CELL_PX = 8, ROW_PX = 15;   // the 8×15 cell: device px per column / per row when entered

/** A controller on a PlaneCamera at a CSS viewport W×H and dpr, posed somewhere in the open world. */
function rig(W, H, dpr) {
    const camera = new PlaneCamera(70, W / H, 1, 20000);
    const canvas = { parentElement: { clientWidth: W, clientHeight: H }, width: W * dpr, height: H * dpr, style: {} };
    const cc = new ViewerCameraController({ camera, THREE, canvas, getGrids: () => [] });
    cc.settings.softBounds = false;
    camera.position.set(-40, 25, 380);
    cc.yaw = -0.2; cc.pitch = 0.05;
    cc._applyRotation();
    camera.updateMatrixWorld(true);
    return { cc, camera };
}
const frame = (cc, camera) => { cc.applyCamera(1 / 60); camera.updateMatrixWorld(true); };
const settle = (cc, camera) => { frame(cc, camera); while (cc.planeState()?.tweening) frame(cc, camera); };

// A plane desk standing in the world at an angle, its cell grid's origin somewhere arbitrary.
const yaw = -0.45;
const normal = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
const center = { x: -120, y: 40, z: -300 };
const column = 0.3171;                 // world units per text column (an atlas cell × a world scale)
const pxPerUnit = CELL_PX / column;    // device px per world unit
const row = ROW_PX / pxPerUnit;        // world units per text row
const pitch = row;                     // layers.pitchRows 1
const origin = { x: -213.377, y: 61.0913 };
const world = (x, y, d = 0) => new THREE.Vector3(
    center.x + right.x * x + normal.x * d, center.y + y, center.z + right.z * x + normal.z * d);

/**
 * Device px of every layer's cell origins: layer i stands i·pitch behind, i rows up (the rise).
 * @returns {{x:number, y:number}[][]} [layer][cell]
 */
function layers(camera, Wd, Hd) {
    camera.updateMatrixWorld(true);
    const out = [];
    for (let i = 0; i <= 20; i++) {
        const cells = [];
        for (const [c, r] of [[0, 0], [1, 0], [37, 4], [119, 55], [238, 2]]) {
            const v = world(origin.x + c * column, origin.y - r * row + i * row, -i * pitch).project(camera);
            cells.push({ x: (v.x + 1) / 2 * Wd, y: (1 - v.y) / 2 * Hd });
        }
        out.push(cells);
    }
    return out;
}
const isWhole = (v) => Math.abs(v - Math.round(v)) <= 1e-6;

for (const [W, H, dpr] of [[2200, 1380, 1], [1601, 943, 1], [1123, 777, 2]]) {
    const Wd = W * dpr, Hd = H * dpr;
    const { cc, camera } = rig(W, H, dpr);
    cc.enterPlane({ center, normal, up: { x: 0, y: 1, z: 0 }, pxPerUnit, fovDeg: 1, front: 20, back: 25 * pitch, origin, ortho: true });
    settle(cc, camera);
    const flat = layers(camera, Wd, Hd);
    const tag = `${W}×${H}@${dpr}`;
    ok(camera.blend === 0, `${tag}: entered orthographic`);
    ok(flat[0].every((p) => isWhole(p.x) && isWhole(p.y)), `${tag}: the plane's cell origins are whole device px`);
    ok(flat.every((L, i) => L.every((p, j) => Math.abs(p.x - flat[0][j].x) <= 1e-6 && Math.abs(p.y - (flat[0][j].y - i * ROW_PX)) <= 1e-6)),
        `${tag}: unfanned, layer i stands exactly i rows up, no sideways drift (1:1 behind the plane)`);

    for (const n of [4, 1, -3]) {
        cc.setPlaneFan(n, pitch, { ms: 200 });
        settle(cc, camera);
        const L = layers(camera, Wd, Hd);
        let notWhole = 0, offBad = 0;
        for (let i = 0; i <= 20; i++) for (let j = 0; j < L[i].length; j++) {
            if (!isWhole(L[i][j].x) || !isWhole(L[i][j].y)) notWhole++;
            if (Math.abs(L[i][j].x - L[0][j].x - i * n) > 1e-6 || Math.abs(L[i][j].y - (L[0][j].y - i * ROW_PX)) > 1e-6) offBad++;
        }
        ok(notWhole === 0, `${tag} fan ${n}: every layer's cells land on whole device px (${notWhole} off)`);
        ok(offBad === 0, `${tag} fan ${n}: layer i sits exactly i·${n} px over and i rows up (${offBad} off)`);
        ok(L[0].every((p, j) => Math.abs(p.x - flat[0][j].x) <= 1e-6 && Math.abs(p.y - flat[0][j].y) <= 1e-6), `${tag} fan ${n}: the plane itself doesn't move`);
    }

    // Teeth 1: a non-integer n puts odd layers between pixels.
    cc.setPlaneFan(2.5, pitch, { ms: 0 });
    settle(cc, camera);
    const half = layers(camera, Wd, Hd);
    const halfOff = half.filter((L, i) => i % 2 === 1 && L.some((p) => !isWhole(p.x))).length;
    ok(halfOff === 10, `${tag} teeth: a 2.5 px fan leaves the 10 odd layers off whole px (${halfOff})`);

    // Teeth 2: the shear for an unpinned d₀ (1% off the plane's depth) moves layers off i·n.
    cc.setPlaneFan(4, pitch, { ms: 0 });
    settle(cc, camera);
    camera.shear = fanShear({ px: 4, pitch, planeDepth: camera.planeDepth * 1.01, viewportW: Wd });
    camera.planeDepth *= 1.01;
    camera.updateProjectionMatrix();
    const loose = layers(camera, Wd, Hd);
    const looseBad = loose.filter((L, i) => i > 0 && L.some((p, j) => Math.abs(p.x - loose[0][j].x - 4 * i) > 1e-6 || !isWhole(p.x) || !isWhole(p.y))).length;
    ok(looseBad > 0, `${tag} teeth: an unpinned d₀ breaks the whole-px fan (${looseBad} layers off)`);
    cc.leavePlane({ ms: 0 });
    settle(cc, camera);
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-oblique: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
