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
//     the whole time (a save mid-plane restores to the open world)
//   - the lens: the eye is solved so a referent holds its screen spot (< 1 px) at exactly the
//     eased scale k(t) (teeth: the pre-solve stepping fails both)
//   - plane life is a listener set; a fly while entered leaves to home first, then flies (teeth:
//     drop-in-place); a second enter is a cut (pixel-exact in the same call), home kept
//   - the viewport reports whether the drawing buffer is the canvas's device-pixel box

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import { parallaxPx } from '../packages/glyph3d-core/src/services/camera/planeView.js';
import { enterPlaneView } from '../app/commands/handlers/planeCommands.js';

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

    // Scale (DEVICE px per unit — the drawing buffer) and snapping, through three's projection.
    const a = proj(camera, onPlane(-30, 10)), b = proj(camera, onPlane(-29, 9));
    near((b.x - a.x) * dpr, PLANE.pxPerUnit, 1e-4, `dpr ${dpr}: x scale (device px)`);
    near((b.y - a.y) * dpr, PLANE.pxPerUnit, 1e-4, `dpr ${dpr}: y scale (device px)`);
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
    near((c2.x - c1.x) * dpr, PLANE.pxPerUnit, 1e-4, `dpr ${dpr}: the fan keeps the plane's scale`);
    const st = cc.planeState();
    const flat = proj(camera, onPlane(40, 0)), lifted = proj(camera, onPlane(40, 0, 4));
    const offsetPx = (flat.x - W / 2) * dpr;   // device px
    near((lifted.x - flat.x) * dpr, parallaxPx({ fovDeg: 25, viewportH: H * dpr, pxPerUnit: PLANE.pxPerUnit, depth: 4, offsetPx }), 0.05, `dpr ${dpr}: a layer fans out by the parallax law`);
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

// A surface under the cursor takes the wheel; re-entering keeps the first home.
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
}

// ── The lens (§4.3): the eye is SOLVED each frame so a referent sits exactly at its eased screen
// spot at exactly the eased scale k(t) (planeView.dollyAt). Two cases: HOLD (a plane point well off
// the view center stays where it is on screen through the square-up) and GLIDE (an explicit aim:
// the view-center point slides to it). Everything is measured through three's projection. Teeth
// live in the test: the same checks run on the pre-solve stepping (aim / log-distance / fov lerped
// separately) and must FAIL there.
const devPx = (camera, p, dpr) => { const q = proj(camera, p); return { x: q.x * dpr, y: q.y * dpr }; };
// Device px per world unit at a point, measured: it and a point one unit along the camera's right
// (a fronto-parallel step at the same depth), both projected.
const scaleAt = (camera, P, dpr) => {
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const a = devPx(camera, P, dpr), b = devPx(camera, { x: P.x + r.x, y: P.y + r.y, z: P.z + r.z }, dpr);
    return Math.hypot(b.x - a.x, b.y - a.y);
};
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// The pre-solve stepping on the new lens record: the view-center point lerps from where the camera
// looked to the landing aim, the distance log-lerps, the fov lerps — the swim.
function preSolveStep(from) {
    return function (dt) {
        const L = this._lens;
        L.elapsed += dt * 1000;
        const t = Math.min(L.elapsed / L.ms, 1);
        if (t >= 1) { this._setLens(L.to); this._lens = null; L.onDone?.(); return; }
        const e = easeIO(t), lerp = (x, y) => x + (y - x) * e, b = L.to;
        const dist = Math.exp(Math.log(from.dist) + (Math.log(b.dist) - Math.log(from.dist)) * e);
        this._setLens({
            aim: from.aim.clone().lerp(b.aim, e), dist, pitch: lerp(from.pitch, b.pitch), yaw: L.yaw0 + L.dyaw * e,
            fov: lerp(from.fov, b.fov), near: Math.max(dist * 1e-3, dist - lerp(from.dist - from.near, b.dist - b.near)),
            far: Math.max(dist + lerp(from.far - from.dist, b.far - b.dist), dist * 1.001),
        });
    };
}
// The plane point the camera sees at NDC (nx, ny), in plane coordinates.
function planePointAtNdc(camera, nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const n = new THREE.Vector3(normal.x, normal.y, normal.z), c = new THREE.Vector3(center.x, center.y, center.z);
    const d = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, c), new THREE.Vector3()).sub(c);
    return { x: d.x * right.x + d.z * right.z, y: d.y };
}
function lensRun({ dpr, mode, presolve = false }) {
    const { cc, camera } = rig({ dpr });
    camera.updateProjectionMatrix();
    const ref = planePointAtNdc(camera, mode === 'hold' ? -0.45 : 0, mode === 'hold' ? -0.3 : 0);
    const P = onPlane(ref.x, ref.y);
    const s0 = devPx(camera, P, dpr), k0 = scaleAt(camera, P, dpr);
    const from = cc._lensNow(new THREE.Vector3(center.x, center.y, center.z), new THREE.Vector3(normal.x, normal.y, normal.z));
    // HOLD is given an aim too: a holdable referent wins (the aim is only the fallback).
    cc.enterPlane(mode === 'hold' ? { ...PLANE, referent: ref, aim: { x: -20, y: 12 } } : { ...PLANE, aim: { x: -20, y: 12 } }, { ms: 700 });
    if (presolve) cc._stepLens = preSolveStep(from);
    const L = cc._lens;
    let drift = 0, scaleErr = 0;
    for (let i = 0; i < 100; i++) {
        const t = Math.min((L.elapsed + 1000 / 60) / L.ms, 1);
        frame(cc, camera);
        if (!cc.planeState().tweening) break;
        const e = easeIO(t);
        const want = Math.exp(Math.log(L.k0) + (Math.log(L.k1) - Math.log(L.k0)) * e);
        // HOLD tracks the referent at its start spot; GLIDE the gliding point at the view center.
        const Q = mode === 'hold' ? P : L.P0.clone().lerp(L.P1, e);
        const spot = mode === 'hold' ? s0 : { x: W * dpr / 2, y: H * dpr / 2 };
        scaleErr = Math.max(scaleErr, Math.abs(scaleAt(camera, Q, dpr) / want - 1));
        const s = devPx(camera, Q, dpr);
        drift = Math.max(drift, Math.hypot(s.x - spot.x, s.y - spot.y));
    }
    const sEnd = devPx(camera, P, dpr);
    return { camera, k0, L, drift, scaleErr, endDrift: Math.hypot(sEnd.x - s0.x, sEnd.y - s0.y), s0 };
}
for (const dpr of [1, 2]) {
    const h = lensRun({ dpr, mode: 'hold' });
    ok(h.s0.x < W * dpr * 0.4 && h.s0.y > H * dpr * 0.55, `dpr ${dpr} hold: the referent starts well off-center (${h.s0.x.toFixed(0)}, ${h.s0.y.toFixed(0)})`);
    near(h.L.k0, h.k0, h.k0 * 1e-9, `dpr ${dpr} hold: k0 is the scale the camera saw at the referent`);
    ok(h.scaleErr < 1e-4, `dpr ${dpr} hold: the scale at the referent is k(t) every frame (worst rel. err ${h.scaleErr.toExponential(2)})`);
    ok(h.drift < 1, `dpr ${dpr} hold: the referent drifts < 1 device px through the square-up (${h.drift.toFixed(4)} px)`);
    ok(h.endDrift < 1, `dpr ${dpr} hold: it lands < 1 device px from where it was (the snap: ${h.endDrift.toFixed(4)} px)`);
    const o = proj(h.camera, onPlane(PLANE.origin.x, PLANE.origin.y));
    near(o.x * dpr, Math.round(o.x * dpr), 2e-3, `dpr ${dpr} hold: landed, the origin is on a device-pixel corner (x)`);
    near(o.y * dpr, Math.round(o.y * dpr), 2e-3, `dpr ${dpr} hold: landed, the origin is on a device-pixel corner (y)`);
    const g = lensRun({ dpr, mode: 'glide' });
    ok(g.scaleErr < 1e-4, `dpr ${dpr} glide: the scale at the view center is k(t) every frame (worst rel. err ${g.scaleErr.toExponential(2)})`);
    ok(g.drift < 1e-3, `dpr ${dpr} glide: the gliding point stays at the view center (${g.drift.toExponential(2)} px)`);
    // Teeth: the pre-solve stepping fails both.
    const hp = lensRun({ dpr, mode: 'hold', presolve: true });
    ok(hp.drift > 1, `dpr ${dpr} teeth: without the solve the referent drifts > 1 px (${hp.drift.toFixed(1)} px)`);
    ok(hp.scaleErr > 1e-2, `dpr ${dpr} teeth: without the solve the scale is not k(t) (${hp.scaleErr.toExponential(2)})`);
}

// ── Plane life is a LISTENER SET: every listener hears true once on enter and false once when the
// view ends (a landed leave, a fly's leave, a restore's cut); a switch says nothing; removal works.
{
    const { cc, camera } = rig();
    const a = [], b = [];
    const fa = (on) => a.push(on), fb = (on) => b.push(on);
    cc.addPlaneListener(fa);
    cc.addPlaneListener(fb);
    cc.enterPlane(PLANE, { ms: 100 });
    while (cc.planeState().tweening) frame(cc, camera);
    cc.enterPlane({ ...PLANE, center: { x: 0, y: 0, z: -10 } }, { ms: 100 });
    ok(a.join() === 'true' && b.join() === 'true', `enter, switch → [true] for both (got [${a}] [${b}])`);
    cc.leavePlane({ ms: 100 });
    frame(cc, camera, 0.05);
    ok(a.join() === 'true', 'mid-leave: still entered');
    while (cc._lens) frame(cc, camera);
    ok(a.join() === 'true,false' && b.join() === 'true,false', `a landed leave → false for both (got [${a}] [${b}])`);
    cc.removePlaneListener(fb);
    cc.enterPlane(PLANE, { ms: 100 });
    cc.flyTo({ position: { x: 0, y: 0, z: 50 }, pitch: 0, yaw: 0 }, { ms: 10 });
    ok(a.join() === 'true,false,true', `a fly while entered: still entered until its leave lands (got [${a}])`);
    for (let i = 0; i < 60 && cc.planeState(); i++) frame(cc, camera);
    ok(a.join() === 'true,false,true,false', `the fly's leave lands → false (got [${a}])`);
    ok(b.join() === 'true,false', `a removed listener hears nothing more (got [${b}])`);
    cc.enterPlane(PLANE, { ms: 100 });
    cc.applyState({ pos: { x: 1, y: 2, z: 3 }, pitch: 0, yaw: 0 });
    ok(a.join() === 'true,false,true,false,true,false', `a restore cuts home → false (got [${a}])`);
    ok(cc.planeState() === null && camera.fov === 70 && camera.position.x === 1, 'a restore: open world, the home lens, the restored pose');
    let threw = false;
    try { cc.addPlaneListener(null); } catch { threw = true; }
    ok(threw, 'a non-function listener throws');
}

// ── A fly while entered LEAVES FIRST (§3.2): the lens eases back to home — the pose and lens the
// plane was entered from — and the fly starts from there: frame for frame the same fly as an
// explicit leave and then flyTo. Teeth: dropping the plane in place (keep the plane pose, restore
// only the lens) starts the fly thousands of units out.
{
    const target = { position: { x: -40, y: 25, z: 160 }, pitch: 0.1, yaw: -0.4 };
    const entered = () => {
        const r = rig();
        r.home = { pos: r.camera.position.clone(), pitch: r.cc.pitch, yaw: r.cc.yaw };
        r.cc.enterPlane(PLANE, { ms: 100, leaveMs: 200 });
        while (r.cc.planeState().tweening) frame(r.cc, r.camera);
        return r;
    };
    // The frames of a fly, from the first frame after the camera stood at home.
    const flyFrames = (r) => {
        const out = [];
        let atHome = false;
        for (let i = 0; i < 200 && (r.cc.planeState() || r.cc._tween); i++) {
            const wasPlane = !!r.cc.planeState();
            frame(r.cc, r.camera);
            if (atHome) out.push(r.camera.position.clone());
            if (wasPlane && !r.cc.planeState()) {
                atHome = r.camera.position.equals(r.home.pos) && r.cc.pitch === r.home.pitch && r.cc.yaw === r.home.yaw
                    && r.camera.fov === 70 && r.camera.near === 1 && r.camera.far === 20000;
                r.landedHome = atHome;
            }
        }
        return out;
    };
    const A = entered();
    A.cc.flyTo(target, { ms: 300 });
    ok(A.cc.planeState()?.leaving === true, 'flyTo while entered starts the leave');
    const flyA = flyFrames(A);
    ok(A.landedHome, 'the leave lands on home bit-exact (pose and lens) before the fly');
    near(A.camera.position.distanceTo(new THREE.Vector3(target.position.x, target.position.y, target.position.z)), 0, 1e-9, 'and the fly lands on its target');
    const B = entered();
    B.cc.leavePlane();
    while (B.cc.planeState()) frame(B.cc, B.camera);
    ok(B.camera.position.equals(B.home.pos), 'an explicit leave lands home');
    B.cc.flyTo(target, { ms: 300 });
    const flyB = [];
    while (B.cc._tween) { frame(B.cc, B.camera); flyB.push(B.camera.position.clone()); }
    ok(flyA.length > 10 && flyA.length === flyB.length && flyA.every((p, i) => p.equals(flyB[i])),
        `a fly while entered == leave, then fly (${flyA.length} vs ${flyB.length} frames)`);
    // Teeth: the old drop-in-place.
    const C = entered();
    const h = C.cc._plane.home;
    C.cc._lens = null; C.cc._plane = null;
    C.camera.fov = h.fov; C.camera.near = h.near; C.camera.far = h.far; C.camera.updateProjectionMatrix();
    C.cc.flyTo(target, { ms: 300 });
    frame(C.cc, C.camera);
    ok(C.camera.position.distanceTo(flyB[0]) > 100, `teeth: drop-in-place starts the fly from the plane pose (${C.camera.position.distanceTo(flyB[0]).toFixed(0)} units off)`);

    // camera.focus's framing while entered is the open world's: the pose is computed at the home
    // lens, not the plane's 1° (which would stand the camera ~70× farther off).
    const obj = new THREE.Object3D();
    obj.position.set(30, 10, -20);
    obj.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(-20, -10, 0), new THREE.Vector3(20, 10, 0));
    obj.updateMatrixWorld(true);
    const D = rig();
    D.cc.focusOnObject(obj);
    while (D.cc._tween) frame(D.cc, D.camera);
    const E = entered();
    E.cc.focusOnObject(obj);
    for (let i = 0; i < 200 && (E.cc.planeState() || E.cc._tween); i++) frame(E.cc, E.camera);
    near(E.camera.position.distanceTo(D.camera.position), 0, 1e-6, 'camera.focus while entered lands where it lands from the open world');
    ok(E.camera.fov === 70, 'and on the open-world lens');
}

// ── The SWITCH (§3.2): entering another plane while entered is a CUT to its endpoint — pixel-exact
// in the same call, no lens out and back in — or a slide over switchMs; home stays the first enter's.
{
    const { cc, camera } = rig({ dpr: 2 });
    const start = { pos: camera.position.clone(), pitch: cc.pitch, yaw: cc.yaw, fov: camera.fov, near: camera.near, far: camera.far };
    cc.enterPlane(PLANE, { ms: 700 });
    while (cc.planeState().tweening) frame(cc, camera);
    const yawB = -0.7;   // another wall, turned the other way
    const B = {
        ...PLANE, center: { x: -200, y: 15, z: -120 }, normal: { x: Math.sin(yawB), y: 0, z: Math.cos(yawB) },
        origin: { x: -33.3, y: 21.7 }, pxPerUnit: 9.5,
    };
    const rightB = { x: Math.cos(yawB), z: -Math.sin(yawB) };
    const onB = (x, y) => ({ x: B.center.x + rightB.x * x, y: B.center.y + y, z: B.center.z + rightB.z * x });
    cc.enterPlane(B, { ms: 700, switchMs: 0 });
    camera.updateMatrixWorld(true);
    ok(!cc.planeState().tweening, 'switchMs 0: no tween — a cut');
    const a = proj(camera, onB(-10, 5)), b = proj(camera, onB(-9, 4));
    near((b.x - a.x) * 2, B.pxPerUnit, 1e-4, 'the cut lands at the new scale in the same call (x)');
    near((b.y - a.y) * 2, B.pxPerUnit, 1e-4, 'the cut lands at the new scale in the same call (y)');
    const o = proj(camera, onB(B.origin.x, B.origin.y));
    near(o.x * 2, Math.round(o.x * 2), 2e-3, 'the cut: origin on a device-pixel corner (x)');
    near(o.y * 2, Math.round(o.y * 2), 2e-3, 'the cut: origin on a device-pixel corner (y)');
    const snap = [camera.position.x, camera.position.y, camera.position.z, camera.fov, ...camera.quaternion.toArray()];
    frame(cc, camera);
    const now = [camera.position.x, camera.position.y, camera.position.z, camera.fov, ...camera.quaternion.toArray()];
    ok(now.every((v, i) => v === snap[i]), 'the frame after the cut is bit-identical (it landed)');
    near(cc.getState().pos.x, start.pos.x, 0, 'the switch keeps the first home');

    // A switch can't hold a referent (it isn't on this screen): it lands on the aim it was given.
    cc.enterPlane({ ...B, aim: { x: 5, y: -3 }, referent: { x: -40, y: 20 } }, { switchMs: 0 });
    camera.updateMatrixWorld(true);
    const ctr = proj(camera, onB(cc.planeState().aim.x, cc.planeState().aim.y));
    ok(Math.abs(cc.planeState().aim.x - 5) < 0.1 && Math.abs(cc.planeState().aim.y + 3) < 0.1, `a switch lands on its aim, not the referent (${cc.planeState().aim.x.toFixed(3)}, ${cc.planeState().aim.y.toFixed(3)})`);
    near(ctr.x, W / 2, 1e-6, 'and the aim is the view center');

    // A slide when switchMs > 0, landing on the same kind of endpoint.
    cc.enterPlane(PLANE, { ms: 700, switchMs: 200 });
    ok(cc.planeState().tweening, 'switchMs > 0: a slide');
    let n = 0;
    while (cc.planeState().tweening && n < 100) { frame(cc, camera); n++; }
    ok(n >= 11 && n <= 13, `the slide takes its 200 ms (${n} frames)`);
    const c = proj(camera, onPlane(-30, 10)), d = proj(camera, onPlane(-29, 9));
    near((d.x - c.x) * 2, PLANE.pxPerUnit, 1e-4, 'the slide lands at the plane scale');

    // Leave lands on the ORIGINAL home, bit-exact.
    cc.leavePlane({ ms: 300 });
    while (cc._lens) frame(cc, camera);
    ok(camera.position.equals(start.pos) && cc.pitch === start.pitch && cc.yaw === start.yaw, 'leave after switches lands on the original home pose bit-exact');
    ok(camera.fov === start.fov && camera.near === start.near && camera.far === start.far, 'and the original lens');
}

// ── The viewport's pixel truth: exact only when the drawing buffer IS the canvas's device-pixel box.
{
    const { cc } = rig({ dpr: 2 });
    let vp = cc.planeViewport();
    ok(vp.exact === false && vp.box === null && /not observed/.test(vp.why), `unobserved: not exact, says why (${vp.why})`);
    cc._onDeviceBox({ devicePixelContentBoxSize: [{ inlineSize: W * 2, blockSize: H * 2 }] });
    vp = cc.planeViewport();
    ok(vp.exact === true && vp.why === null && vp.box.width === W * 2 && vp.dpr === 2, 'buffer == device box: exact');
    cc._onDeviceBox({ devicePixelContentBoxSize: [{ inlineSize: W * 2 + 1, blockSize: H * 2 }] });
    vp = cc.planeViewport();
    ok(vp.exact === false && vp.why.includes(`${W * 2}×${H * 2}`) && vp.why.includes(`${W * 2 + 1}×${H * 2}`), `a 1 px mismatch: not exact, with both boxes (${vp.why})`);
    cc._onDeviceBox({});
    vp = cc.planeViewport();
    ok(vp.exact === false && vp.box === null && /devicePixelContentBoxSize/.test(vp.why), 'no device box reported: not exact');
    cc.enterPlane(PLANE, { ms: 10 });
    ok(cc.planeState().viewport.exact === false && typeof cc.planeState().viewport.why === 'string', 'planeState carries the viewport verdict');
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

// ── The app's ONE entry path (enterPlaneView): one plane-life listener per controller however many
// enters, the chrome suppressed for exactly the view's life, the target forgotten when it ends; on
// an inexact canvas it still enters, with a loud notice (the verb's OK line) and a console.warn.
{
    const { cc, camera } = rig({ dpr: 2 });
    const suppressed = [];
    const ctx = { cameraController: cc, contentTreeArrows: { setSuppressed: (on) => suppressed.push(on) } };
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    const p = { center, normal, up: { x: 0, y: 1, z: 0 }, pxPerUnit: 10, depth: 2, aim: { x: 0, y: 0 }, origin: PLANE.origin };
    let s = enterPlaneView(ctx, 'grid:a', p);
    console.warn = warn;
    ok(cc._planeListeners.size === 1, 'enterPlaneView installs one listener');
    ok(typeof s.notice === 'string' && s.notice.includes('NOT pixel-exact') && s.notice.includes('3200×1884'), `inexact: the notice names the box (${s.notice})`);
    ok(warns.length === 1 && warns[0].includes("'grid:a'") && warns[0].includes('not observed'), `inexact: one console.warn naming why (${warns[0]})`);
    while (cc.planeState().tweening) frame(cc, camera);
    cc._onDeviceBox({ devicePixelContentBoxSize: [{ inlineSize: W * 2, blockSize: H * 2 }] });
    s = enterPlaneView(ctx, 'grid:b', { ...p, center: { x: 0, y: 0, z: -30 } });
    ok(s.notice === null && s.viewport.exact === true, 'exact: no notice');
    ok(cc._planeListeners.size === 1, 'a second enter adds no listener');
    ok(ctx.planeTarget === 'grid:b' && suppressed.join() === 'true', `entered: the target recorded, chrome suppressed once (${suppressed})`);
    ctx.enteredCarrel = 'desk';
    cc.leavePlane({ ms: 50 });
    while (cc._lens) frame(cc, camera);
    ok(ctx.planeTarget === null && ctx.enteredCarrel === null && suppressed.join() === 'true,false', 'left: target and desk forgotten, chrome back');
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
    // A non-finite plane coordinate (an unlaid grid's cell origin was NaN) is refused by name, and a
    // refused enter leaves the view as it was — never half-entered (a later leave would throw).
    for (const [k, v] of [['origin', { x: NaN, y: 0 }], ['aim', { x: 0, y: Infinity }], ['referent', { x: NaN, y: NaN }], ['pxPerUnit', 0], ['center', { x: 0, y: NaN, z: 0 }]]) {
        let msg = '';
        try { cc.enterPlane({ ...PLANE, [k]: v }); } catch (e) { msg = e.message; }
        ok(msg.includes(k) && cc.planeState() == null && cc.leavePlane() === false, `a bad ${k} is refused by name, the view not entered (${msg})`);
    }
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-camera: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
