// plane-camera.test.mjs — the camera's PLANE VIEW (ViewerCameraController.enterPlane / leavePlane /
// setPlaneFov), driven frame by frame through applyCamera with three's real projection.
//
//   bun tools/plane-camera.test.mjs
//
// Locks (the felt properties of entering a plane):
//   - entering starts where you are (no jump on the first frame) and the plane is never clipped
//     on the way in or out
//   - landed, the plane shows at exactly pxPerUnit CSS px per unit, its origin on a device-pixel
//     corner (dpr 1 and 2), and whatever stands in front of it is clipped
//   - a still plane view is still (frames after landing leave the camera bit-identical)
//   - drag pans 1:1 (a point under the cursor follows it), the wheel scrolls the plane unless a
//     surface under the cursor takes it, flight keys do nothing, and every rest is pixel-snapped
//   - setPlaneFov keeps the scale and fans layers off the plane by exactly the parallax law
//   - leaving lands on the entered-from pose and lens exactly; getState answers with that pose
//     the whole time (a save mid-plane restores to the open world); a flyTo drops the plane lens

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import { parallaxPx } from '../packages/glyph3d-core/src/services/camera/planeView.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);

const W = 1600, H = 942;

function rig({ dpr = 1, scrollTaker = null } = {}) {
    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 20000);
    const canvas = { parentElement: { clientWidth: W, clientHeight: H }, width: W * dpr, height: H * dpr, style: {} };
    const ctx = { camera, THREE, canvas, getGrids: () => [], tryScrollHovered: scrollTaker };
    const cc = new ViewerCameraController(ctx);
    cc.settings.softBounds = false;
    // An arbitrary open-world pose: off to the side, looking somewhat at the plane.
    camera.position.set(140, 60, 420);
    cc.yaw = 0.35; cc.pitch = -0.12;
    cc._applyRotation();
    camera.updateMatrixWorld(true);
    return { cc, camera, dpr };
}
const frame = (cc, camera, dt = 1 / 60) => { cc.applyCamera(dt); camera.updateMatrixWorld(true); };
const proj = (camera, p) => {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, z: v.z };
};

// The plane: a wall at z = -50 facing +z, rotated a little about y so nothing is axis-aligned.
const yawPlane = 0.3;
const normal = { x: Math.sin(yawPlane), y: 0, z: Math.cos(yawPlane) };
const center = { x: 12, y: 30, z: -50 };
const right = { x: Math.cos(yawPlane), y: 0, z: -Math.sin(yawPlane) };
const onPlane = (x, y, d = 0) => ({
    x: center.x + right.x * x + normal.x * d, y: center.y + y, z: center.z + right.z * x + normal.z * d,
});
const PLANE = { center, normal, up: { x: 0, y: 1, z: 0 }, pxPerUnit: 10.689655, fovDeg: 1, front: 6, back: 40, origin: { x: -60.013, y: 33.37 } };

for (const dpr of [1, 2]) {
    const { cc, camera } = rig({ dpr });
    const start = { pos: camera.position.clone(), pitch: cc.pitch, yaw: cc.yaw, fov: camera.fov, near: camera.near, far: camera.far };
    cc.enterPlane(PLANE, { ms: 700 });
    frame(cc, camera, 1e-6);
    ok(camera.position.distanceTo(start.pos) < 1e-3, `dpr ${dpr}: entering starts where the camera is (moved ${camera.position.distanceTo(start.pos)})`);

    let clipped = 0, frames = 0;
    while (cc.planeState().tweening) {
        frame(cc, camera);
        frames++;
        const z = proj(camera, onPlane(0, 0)).z;
        if (!(z > -1 && z < 1)) clipped++;
    }
    ok(frames >= 40 && frames <= 44, `dpr ${dpr}: the enter takes its 700 ms (${frames} frames)`);
    ok(clipped === 0, `dpr ${dpr}: the plane is never clipped on the way in (${clipped} frames)`);

    // Scale and snapping, measured through three's projection.
    const a = proj(camera, onPlane(-30, 10)), b = proj(camera, onPlane(-29, 9));
    near(b.x - a.x, PLANE.pxPerUnit, 1e-4, `dpr ${dpr}: x scale`);
    near(b.y - a.y, PLANE.pxPerUnit, 1e-4, `dpr ${dpr}: y scale`);
    const o = proj(camera, onPlane(PLANE.origin.x, PLANE.origin.y));
    near(o.x * dpr, Math.round(o.x * dpr), 2e-3, `dpr ${dpr}: origin x on a device-pixel corner`);
    near(o.y * dpr, Math.round(o.y * dpr), 2e-3, `dpr ${dpr}: origin y on a device-pixel corner`);
    ok(proj(camera, onPlane(0, 0, 3)).z < 1 && proj(camera, onPlane(0, 0, 3)).z > -1, `dpr ${dpr}: a layer inside the slab draws`);
    ok(proj(camera, onPlane(0, 0, 20)).z < -1, `dpr ${dpr}: an occluder in front of the slab is clipped`);

    // Still is still.
    const snap = [camera.position.x, camera.position.y, camera.position.z, camera.fov, camera.near, camera.far, ...camera.quaternion.toArray()];
    for (let i = 0; i < 30; i++) frame(cc, camera);
    const now = [camera.position.x, camera.position.y, camera.position.z, camera.fov, camera.near, camera.far, ...camera.quaternion.toArray()];
    ok(now.every((v, i) => v === snap[i]), `dpr ${dpr}: a still plane view is bit-identical frame to frame`);

    // getState answers with the home pose.
    const s = cc.getState();
    near(s.pos.x, start.pos.x, 1e-9, `dpr ${dpr}: getState is the entered-from pose`);
    near(s.yaw, start.yaw, 1e-12, `dpr ${dpr}: getState yaw is home`);

    // Drag pans 1:1.
    const before = proj(camera, onPlane(5, 5));
    cc.input.drag.active = true; cc.input.drag.dx = 37; cc.input.drag.dy = -12;
    frame(cc, camera);
    cc.input.drag.active = false;
    const after = proj(camera, onPlane(5, 5));
    near(after.x - before.x, 37, 1 / dpr + 1e-3, `dpr ${dpr}: drag x follows the cursor`);
    near(after.y - before.y, -12, 1 / dpr + 1e-3, `dpr ${dpr}: drag y follows the cursor`);
    const o2 = proj(camera, onPlane(PLANE.origin.x, PLANE.origin.y));
    near(o2.x * dpr, Math.round(o2.x * dpr), 2e-3, `dpr ${dpr}: a pan rests pixel-snapped (x)`);
    near(o2.y * dpr, Math.round(o2.y * dpr), 2e-3, `dpr ${dpr}: a pan rests pixel-snapped (y)`);

    // The wheel scrolls the plane (content moves up as you scroll down); flight keys do nothing.
    const w0 = proj(camera, onPlane(5, 5));
    cc.input.wheel.dy = 100;
    cc.input.keys.add('KeyW');
    frame(cc, camera);
    cc.input.keys.delete('KeyW');
    const w1 = proj(camera, onPlane(5, 5));
    near(w1.y - w0.y, -100, 1 / dpr + 1e-3, `dpr ${dpr}: the wheel scrolls the plane by its travel`);
    near(w1.x - w0.x, 0, 1e-3, `dpr ${dpr}: the wheel and W don't move it sideways`);

    // Parallax: a wider fov keeps the plane's scale; a layer off it drifts by the law.
    cc.setPlaneFov(25, { ms: 300 });
    while (cc.planeState().tweening) frame(cc, camera);
    const c1 = proj(camera, onPlane(-30, 10)), c2 = proj(camera, onPlane(-29, 9));
    near(c2.x - c1.x, PLANE.pxPerUnit, 1e-4, `dpr ${dpr}: the fan keeps the plane's scale`);
    const st = cc.planeState();
    const flat = proj(camera, onPlane(40, 0)), lifted = proj(camera, onPlane(40, 0, 4));
    const offsetPx = flat.x - W / 2;
    near(lifted.x - flat.x, parallaxPx({ fovDeg: 25, viewportH: H, pxPerUnit: PLANE.pxPerUnit, depth: 4, offsetPx }), 0.05, `dpr ${dpr}: a layer fans out by the parallax law`);
    ok(Math.abs(lifted.x - flat.x) > 1, `dpr ${dpr}: at 25° the fan is visible (${(lifted.x - flat.x).toFixed(2)} px)`);
    ok(st.fovDeg === 25, `dpr ${dpr}: planeState reports the fan fov`);

    // Leave lands home exactly, the plane never clipped on the way out.
    cc.leavePlane({ ms: 600 });
    let outClipped = 0;
    while (cc._lens) {
        frame(cc, camera);
        const z = proj(camera, onPlane(0, 0)).z;
        if (cc._lens && !(z > -1 && z < 1)) outClipped++;
    }
    ok(cc.planeState() === null, `dpr ${dpr}: left the plane`);
    ok(outClipped === 0, `dpr ${dpr}: the plane is never clipped on the way out (${outClipped})`);
    near(camera.position.distanceTo(start.pos), 0, 1e-9, `dpr ${dpr}: leave lands on the entered-from position`);
    near(cc.pitch, start.pitch, 1e-12, `dpr ${dpr}: pitch home`);
    near(cc.yaw, start.yaw, 1e-12, `dpr ${dpr}: yaw home`);
    ok(camera.fov === start.fov && camera.near === start.near && camera.far === start.far, `dpr ${dpr}: the lens is home exactly`);
}

// A surface under the cursor takes the wheel; re-entering keeps the first home; flyTo drops the plane.
{
    let taken = 0;
    const { cc, camera } = rig({ scrollTaker: () => { taken++; return true; } });
    const home = camera.position.clone();
    cc.enterPlane(PLANE, { ms: 100 });
    while (cc.planeState().tweening) frame(cc, camera);
    const p0 = proj(camera, onPlane(0, 0));
    cc.input.wheel.dy = 80;
    frame(cc, camera);
    ok(taken === 1, 'the hovered surface is offered the wheel');
    near(proj(camera, onPlane(0, 0)).y, p0.y, 1e-9, 'a surface that takes the wheel leaves the plane still');

    cc.enterPlane({ ...PLANE, center: { x: 300, y: 0, z: -80 } }, { ms: 100 });
    while (cc.planeState().tweening) frame(cc, camera);
    near(cc.getState().pos.x, home.x, 1e-9, 're-entering keeps the original home');

    cc.flyTo({ position: { x: 0, y: 0, z: 100 }, pitch: 0, yaw: 0 }, { ms: 50 });
    ok(cc.planeState() === null && camera.fov === 70 && camera.near === 1 && camera.far === 20000, 'a flyTo drops the plane and restores the lens');
    for (let i = 0; i < 10; i++) frame(cc, camera);
    near(camera.position.z, 100, 1e-6, 'and the fly lands');
}

// onPlaneChange marks exactly the plane view's life: true once on enter, false once when it ends
// (a landed leave, or a fly that drops it) — re-entering while entered says nothing.
{
    const { cc, camera } = rig();
    const calls = [];
    cc.onPlaneChange = (on) => calls.push(on);
    cc.enterPlane(PLANE, { ms: 100 });
    while (cc.planeState().tweening) frame(cc, camera);
    cc.enterPlane({ ...PLANE, center: { x: 0, y: 0, z: -10 } }, { ms: 100 });
    ok(calls.join() === 'true', `enter, re-enter → [true] (got [${calls}])`);
    cc.leavePlane({ ms: 100 });
    frame(cc, camera, 0.05);
    ok(calls.join() === 'true', 'mid-leave: still entered');
    while (cc._lens) frame(cc, camera);
    ok(calls.join() === 'true,false', `a landed leave → false (got [${calls}])`);
    cc.enterPlane(PLANE, { ms: 100 });
    cc.flyTo({ position: { x: 0, y: 0, z: 50 }, pitch: 0, yaw: 0 }, { ms: 10 });
    ok(calls.join() === 'true,false,true,false', `a fly that drops it → false (got [${calls}])`);
}

// A locked camera (camera.lock) still enters and leaves; the lock freezes panning inside.
{
    const { cc, camera } = rig();
    cc.locked = true;
    cc.enterPlane(PLANE, { ms: 200 });
    let n = 0;
    while (cc.planeState().tweening && n < 100) { frame(cc, camera); n++; }
    ok(!cc.planeState().tweening, `a locked camera still lands the enter (${n} frames)`);
    near(camera.fov, PLANE.fovDeg, 1e-12, 'locked: the lens reached the plane fov');
    const before = proj(camera, onPlane(5, 5));
    cc.input.drag.active = true; cc.input.drag.dx = 40; cc.input.drag.dy = 10;
    frame(cc, camera);
    cc.input.drag.active = false;
    near(proj(camera, onPlane(5, 5)).x, before.x, 1e-9, 'locked: a drag does not pan the plane');
    cc.leavePlane({ ms: 100 });
    n = 0;
    while (cc._lens && n < 100) { frame(cc, camera); n++; }
    ok(cc.planeState() === null && camera.fov === 70, 'locked: leave lands home');
}

// Bad input fails loud.
{
    const { cc } = rig();
    let threw = false;
    try { cc.enterPlane({ ...PLANE, pxPerUnit: NaN }); } catch { threw = true; }
    ok(threw, 'a NaN scale throws');
    threw = false;
    try { cc.enterPlane({ ...PLANE, up: { ...PLANE.normal } }); } catch { threw = true; }
    ok(threw, 'an up parallel to the normal throws');
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-camera: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
