// plane-oblique.test.mjs — the orthographic plane endpoint's FAN moves the layer pages and nothing
// else (DESIGN §4.6, slice 10b): entered through the real controller (ViewerCameraController.
// enterPlane with `ortho`), a real LayerStack of 20 history pages stands behind a member placed on
// an angled plane at an odd world scale, and the controller's fan (setPlaneFan → its plane fan
// listener → LayerStack.setFan, as LayerStacks wires it) slides them. Everything is projected
// through three's own projection (PlaneCamera at λ = 0), at odd viewports and dpr 1 / 2.
//
//   bun tools/plane-oblique.test.mjs
//
// Locks:
//   - unfanned, every page's cell origins land on whole device px, page i exactly i rows up
//   - fanned by n, page i's cell origins AND its backing's corners slide exactly i·n device px right
//     (whole px), rigidly — the backing keeps its place under its text — and none moves vertically
//   - what stands at the member's own depth doesn't move AT ALL: its text plane, its backdrop
//     (behind it), the `now` backing, a focus-border-like frame in front of it
//   - the camera doesn't move (bit for bit), and the slide doesn't depend on the stack's pitch
//   - a negative n fans left, the same whole px; off folds every page back exactly
//   - teeth: a projection SHEAR (clip x += h·(z + d₀), h for a whole-px layer
//     step) slides the member's backdrop by a fraction of its step and a page's backing off its own
//     text — the member checks fail under it; a 2.5 px fan leaves the odd pages between pixels

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import PlaneCamera from '../packages/glyph3d-core/src/services/camera/PlaneCamera.js';
import LayerStack from '../packages/glyph3d-core/src/collections/LayerStack.js';
import { LAYER_BAND, getBandDistance } from '../packages/glyph3d-core/src/core/layerBands.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const CELL_PX = 8;                       // device px per column when entered
const CW = 0.6, LS = 1.2;                // the member's cell, in its own units (a row = 2 columns = 16 px)
const S = 0.37;                          // the member's world scale (odd: the slide must not care)
const BG = getBandDistance(LAYER_BAND.GRID_BACKGROUND);

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

// The plane: a desk standing at an angle; the member on it at plane coords (ox, oy).
const yaw = -0.45;
const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
const center = new THREE.Vector3(-120, 40, -300);
const ox = -21.3377, oy = 6.10913;

/**
 * The member (an Object3D squared to the plane, its text at z = 0, its backdrop BG behind, a frame
 * BG in front) and a real LayerStack of 20 history pages on it. @param {number} pitchRows
 */
function member(pitchRows) {
    const scene = new THREE.Scene();
    const m = new THREE.Object3D();
    m.position.copy(center).addScaledVector(right, ox).add(new THREE.Vector3(0, oy, 0));
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, new THREE.Vector3(0, 1, 0), normal));
    m.scale.setScalar(S);
    scene.add(m);
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(80 * CW, 30 * LS));
    backdrop.position.set(40 * CW, -15 * LS, -BG);
    const border = new THREE.Mesh(new THREE.PlaneGeometry(81 * CW, 31 * LS));
    border.position.set(40 * CW, -15 * LS, BG);
    m.add(backdrop, border);
    const metrics = { charWidth: CW, charHeight: LS * 0.9, lineSpacing: LS, emWorld: CW, worldScale: 1 };
    const stack = new LayerStack(null, { metrics, originY: -LS / 2, cols: 80, rows: 30, titleHeight: 0 }, { pitchRows });
    stack.setLayers(Array.from({ length: 20 }, (_, i) => ({ id: `rev${i + 1}`, kind: 'history', rows: [] })));
    m.add(stack);
    scene.updateMatrixWorld(true);
    return { scene, m, stack, backdrop, border };
}

/** Device px of a world point. */
const px = (camera, P, Wd, Hd) => { const v = P.clone().project(camera); return { x: (v.x + 1) / 2 * Wd, y: (1 - v.y) / 2 * Hd }; };
const corners = (mesh) => {
    const g = mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    return [[b.min.x, b.min.y], [b.max.x, b.min.y], [b.min.x, b.max.y], [b.max.x, b.max.y]].map(([x, y]) => mesh.localToWorld(new THREE.Vector3(x, y, 0)));
};
const isWhole = (v) => Math.abs(v - Math.round(v)) <= 1e-6;

/**
 * Every tracked point on screen: per page, its cell origins (in its group) and its backing's
 * corners; the member's text cells, its backdrop, its frame, the `now` backing.
 */
function measure(camera, rigM, Wd, Hd) {
    rigM.scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const cells = [[0, 0], [1, 0], [37, 4], [79, 29]];
    const at = (obj, c, r) => px(camera, obj.localToWorld(new THREE.Vector3(c * CW, -r * LS, 0)), Wd, Hd);
    return {
        pages: rigM.stack.pages.map((l) => ({ cells: cells.map(([c, r]) => at(l.group, c, r)), back: corners(l.back).map((P) => px(camera, P, Wd, Hd)) })),
        text: cells.map(([c, r]) => at(rigM.m, c, r)),
        own: [...corners(rigM.backdrop), ...corners(rigM.border), ...(rigM.stack._now ? corners(rigM.stack._now.back) : [])].map((P) => px(camera, P, Wd, Hd)),
    };
}
const maxMove = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

for (const [W, H, dpr] of [[2200, 1380, 1], [1601, 943, 1], [1123, 777, 2]]) for (const pitchRows of [1, 1.37]) {
    const Wd = W * dpr, Hd = H * dpr;
    const tag = `${W}×${H}@${dpr} pitch ${pitchRows}`;
    const { cc, camera } = rig(W, H, dpr);
    const M = member(pitchRows);
    cc.addPlaneFanListener((n, ppu) => M.stack.setFan(n, ppu));   // as LayerStacks wires it
    const pxPerUnit = CELL_PX / (CW * S);
    cc.enterPlane({ center, normal, up: { x: 0, y: 1, z: 0 }, pxPerUnit, fovDeg: 1, front: 20, back: 200, origin: { x: ox, y: oy }, ortho: true });
    settle(cc, camera);
    ok(camera.blend === 0, `${tag}: entered orthographic`);
    const flat = measure(camera, M, Wd, Hd);
    const rowPx = LS * S * pxPerUnit;
    ok(flat.text.every((p) => isWhole(p.x) && isWhole(p.y)), `${tag}: the member's cell origins are whole device px`);
    ok(flat.pages.every((L, i) => L.cells.every((p, j) => Math.abs(p.x - flat.text[j].x) <= 1e-6 && Math.abs(p.y - (flat.text[j].y - (i + 1) * rowPx)) <= 1e-6)),
        `${tag}: unfanned, page i stands exactly i rows up, no sideways drift (1:1 behind the member)`);
    const cam0 = [...camera.position.toArray(), ...camera.projectionMatrix.elements];

    for (const n of [16, 1, -3]) {
        cc.setPlaneFan(n, { ms: 200 });
        settle(cc, camera);
        const F = measure(camera, M, Wd, Hd);
        let notWhole = 0, offBad = 0, rigidBad = 0;
        F.pages.forEach((L, k) => {
            const i = k + 1;
            L.cells.forEach((p, j) => {
                if (!isWhole(p.x) || !isWhole(p.y)) notWhole++;
                if (Math.abs(p.x - flat.pages[k].cells[j].x - i * n) > 1e-6 || Math.abs(p.y - flat.pages[k].cells[j].y) > 1e-6) offBad++;
            });
            L.back.forEach((p, j) => { if (Math.abs(p.x - flat.pages[k].back[j].x - i * n) > 1e-6 || Math.abs(p.y - flat.pages[k].back[j].y) > 1e-6) rigidBad++; });
        });
        ok(notWhole === 0, `${tag} fan ${n}: every page's cells land on whole device px (${notWhole} off)`);
        ok(offBad === 0, `${tag} fan ${n}: page i's cells slide exactly i·${n} px, none vertically (${offBad} off)`);
        ok(rigidBad === 0, `${tag} fan ${n}: each page's backing slides with its text, rigidly (${rigidBad} corners off)`);
        ok(maxMove(F.text, flat.text) <= 1e-9 && maxMove(F.own, flat.own) <= 1e-9,
            `${tag} fan ${n}: the member — its text, backdrop, frame, now backing — doesn't move (${Math.max(maxMove(F.text, flat.text), maxMove(F.own, flat.own)).toExponential(1)} px)`);
        ok([...camera.position.toArray(), ...camera.projectionMatrix.elements].every((v, i) => v === cam0[i]), `${tag} fan ${n}: the camera doesn't move`);
    }

    // Teeth 1: a projection shear (16 px a layer step at this stack's world pitch) moves
    // the member's own backdrop and frame, and a page's backing off its text.
    cc.setPlaneFan(0, { ms: 0 });
    settle(cc, camera);
    const worldPitch = M.stack.pitch() * S, d0 = camera.planeDepth;
    const h = -2 * 16 * d0 / (Wd * worldPitch);
    const e = camera.projectionMatrix.elements;   // column-major: row 0 is e[0], e[4], e[8], e[12]
    e[8] += h; e[12] += h * d0;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const sheared = measure(camera, M, Wd, Hd);
    const ownMoved = maxMove(sheared.own, flat.own);
    const pageGap = (L) => L.back[0].x - L.cells[0].x;
    const tornPx = Math.abs(pageGap(sheared.pages[0]) - pageGap(flat.pages[0]));
    ok(ownMoved > 1 && tornPx > 1, `${tag} teeth: a projection shear slides the member's backdrop/frame ${ownMoved.toFixed(2)} px and tears page 1's backing ${tornPx.toFixed(2)} px off its text`);
    camera.updateProjectionMatrix();

    // Teeth 2: a non-integer n puts the odd pages between pixels.
    cc.setPlaneFan(2.5, { ms: 0 });
    settle(cc, camera);
    const half = measure(camera, M, Wd, Hd);
    const halfOff = half.pages.filter((L, k) => (k + 1) % 2 === 1 && L.cells.some((p) => !isWhole(p.x))).length;
    ok(halfOff === 10, `${tag} teeth: a 2.5 px fan leaves the 10 odd pages off whole px (${halfOff})`);

    // Off folds back exactly; leaving folds it too.
    cc.setPlaneFan(0, { ms: 100 });
    settle(cc, camera);
    const back = measure(camera, M, Wd, Hd);
    ok(back.pages.every((L, k) => maxMove(L.cells, flat.pages[k].cells) <= 1e-9 && maxMove(L.back, flat.pages[k].back) <= 1e-9), `${tag}: off folds every page back exactly`);
    cc.setPlaneFan(16, { ms: 0 });
    cc.leavePlane({ ms: 100 });
    settle(cc, camera);
    ok(M.stack._fanDx === 0, `${tag}: a leave folds the pages`);
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-oblique: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
