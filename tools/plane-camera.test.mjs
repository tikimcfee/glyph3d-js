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
// The orthographic endpoint (PlaneCamera, DESIGN §4.6 — slice 10b):
//   - λ = 1 is three's PerspectiveCamera bit for bit, view offset included, and the OPEN WORLD stays
//     bit-identical with a PlaneCamera as the view camera (teeth: a camera that always uses the blend
//     formula differs in the last bits); the formula at λ = 1 is three's to 1e-12; λ = 0 is
//     OrthographicCamera (× the homogeneous d₀) element for element; the plane at d₀ keeps its NDC
//     size for every λ; z_ndc is monotonic over [near, far]; the NDC crop is setViewOffset at λ = 1;
//     pxPerUnitAt agrees with projecting two points; copy carries λ and d₀; what isn't
//     written below λ = 1 throws by name; rayFromCamera's ray passes through what projects there
//   - the controller: an orthographic enter keeps the open-world fov and lands at λ = 0 at
//     d₀ = e₅·Hd/(2k), the plane exact and snapped, the referent held < 1 px every frame of the
//     blend, layers behind the plane 1:1; the fan moves NO camera — its listeners hear it eased
//     0 → n (and the plane's px per unit), back to 0 on off, a leave or a restore; a leave lands
//     home with the matrix bit-identical; a switch cuts; the blend handle holds the scale
//   - picking at λ = 0: the pick camera's one-pixel window centres the world point
//     under that pixel
//   - the fov-trig gate: no file derives a scale from a fov but the helper, the camera itself and
//     the pure endpoint math

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import { parallaxPx, planeDistance } from '../packages/glyph3d-core/src/services/camera/planeView.js';
import { enterPlaneView } from '../app/commands/handlers/planeCommands.js';
import PlaneCamera from '../packages/glyph3d-core/src/services/camera/PlaneCamera.js';
import { pxPerUnitAt, viewHeightAt, clipW, rayFromCamera, zDistanceForFit } from '../packages/glyph3d-core/src/services/spatial/spatialMath.js';

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

// ── The orthographic endpoint: PlaneCamera's matrix ─────────────────────────────────────────────
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
const LENSES = [];
for (const fov of [70, 1, 33.3]) for (const asp of [1.6, 1.698, 0.75]) for (const [n, f] of [[1, 20000], [50, 90], [0.1, 1000]]) LENSES.push({ fov, asp, n, f });
const OFFSET = [1600, 942, 812.5, 300.5, 1, 1];
{
    // λ = 1: three's own matrix, bit for bit (view offset included).
    let bitDiff = 0, formulaDiff = 0, formulaMax = 0;
    for (const L of LENSES) for (const off of [null, OFFSET]) {
        const p = new THREE.PerspectiveCamera(L.fov, L.asp, L.n, L.f), c = new PlaneCamera(L.fov, L.asp, L.n, L.f);
        if (off) { p.setViewOffset(...off); c.setViewOffset(...off); }
        const m = c._blendMatrix(new THREE.Matrix4());
        for (let i = 0; i < 16; i++) {
            if (p.projectionMatrix.elements[i] !== c.projectionMatrix.elements[i]) bitDiff++;
            if (p.projectionMatrixInverse.elements[i] !== c.projectionMatrixInverse.elements[i]) bitDiff++;
            const r = rel(p.projectionMatrix.elements[i], m.elements[i]);
            if (r > 0) formulaDiff++;
            formulaMax = Math.max(formulaMax, r);
        }
    }
    ok(bitDiff === 0, `λ = 1 is PerspectiveCamera bit for bit, offset or not (${bitDiff} elements differ)`);
    ok(formulaMax <= 1e-12, `the blend formula at λ = 1 is three's to 1e-12 (max rel ${formulaMax.toExponential(2)})`);
    ok(formulaDiff > 0, `teeth: the formula is NOT bit-identical (${formulaDiff} elements differ) — why λ = 1 is three's own`);

    // λ = 0: OrthographicCamera at the scale of d₀, × the homogeneous d₀.
    let orthoMax = 0;
    for (const L of LENSES) for (const d0 of [69.9, 7000, 3]) {
        const c = new PlaneCamera(L.fov, L.asp, L.n, L.f);
        c.blend = 0; c.planeDepth = d0; c.updateProjectionMatrix();
        const sy = c.projectionMatrix.elements[5], sx = c.projectionMatrix.elements[0];
        const o = new THREE.OrthographicCamera(-d0 / sx, d0 / sx, d0 / sy, -d0 / sy, L.n, L.f);
        for (let i = 0; i < 16; i++) orthoMax = Math.max(orthoMax, Math.abs(c.projectionMatrix.elements[i] / d0 - o.projectionMatrix.elements[i]) / Math.max(Math.abs(o.projectionMatrix.elements[i]), 1));
    }
    ok(orthoMax <= 1e-12, `λ = 0 is OrthographicCamera × d₀ element for element (max ${orthoMax.toExponential(2)})`);

    // d₀ keeps its NDC size for all λ; z_ndc monotonic over [near, far] with near → −1, far → +1.
    const c = new PlaneCamera(70, 1.698, 50, 90), d0 = 69.9;
    c.planeDepth = d0;
    const ndcOf = (cam, x, y, z) => new THREE.Vector4(x, y, z, 1).applyMatrix4(cam.projectionMatrix);
    let sizeMax = 0, monoBad = 0, endBad = 0;
    for (let k = 0; k <= 10; k++) {
        c.blend = k / 10; c.updateProjectionMatrix();
        for (const [x, y] of [[13.7, -8.2], [-40, 25], [0.5, 0.25]]) {
            const v = ndcOf(c, x, y, -d0), ref = ndcOf(new THREE.PerspectiveCamera(70, 1.698, 50, 90), x, y, -d0);
            sizeMax = Math.max(sizeMax, Math.abs(v.x / v.w - ref.x / ref.w), Math.abs(v.y / v.w - ref.y / ref.w));
        }
        let prev = -Infinity;
        for (let i = 0; i <= 400; i++) {
            const d = 50 + 40 * i / 400, v = ndcOf(c, 3, 2, -d), z = v.z / v.w;
            if (!(z > prev)) monoBad++;
            prev = z;
        }
        const zn = ndcOf(c, 0, 0, -50), zf = ndcOf(c, 0, 0, -90);
        if (Math.abs(zn.z / zn.w + 1) > 1e-9 || Math.abs(zf.z / zf.w - 1) > 1e-9) endBad++;
    }
    ok(sizeMax <= 1e-12, `the plane at d₀ keeps its NDC size for every λ (max ${sizeMax.toExponential(2)})`);
    ok(monoBad === 0, `z_ndc is monotonic in depth for every λ (${monoBad} inversions)`);
    ok(endBad === 0, `near → −1 and far → +1 for every λ (${endBad} off)`);

    // The NDC crop at λ = 1 is setViewOffset; below 1 it crops the blended view the same way.
    const full = new PlaneCamera(70, 1600 / 942, 50, 90), win = new PlaneCamera(70, 1600 / 942, 50, 90);
    for (const cam of [full, win]) { cam.blend = 0.35; cam.planeDepth = d0; }
    win.setViewOffset(1600, 942, 700, 200, 64, 32);
    full.updateProjectionMatrix();
    let cropMax = 0;
    for (const [x, y, z] of [[3, 2, -60], [-10, 5, -75], [1, -1, -d0]]) {
        const a = ndcOf(full, x, y, z), b = ndcOf(win, x, y, z);
        const fx = (a.x / a.w + 1) / 2 * 1600, fy = (1 - a.y / a.w) / 2 * 942;   // full-view px
        const wx = (b.x / b.w + 1) / 2 * 64 + 700, wy = (1 - b.y / b.w) / 2 * 32 + 200;   // window px, back to full
        cropMax = Math.max(cropMax, Math.abs(fx - wx), Math.abs(fy - wy));
    }
    ok(cropMax <= 1e-9, `below λ = 1 the crop windows the blended view exactly (max ${cropMax.toExponential(2)} px)`);

    // pxPerUnitAt agrees with projecting two points (any λ, any depth); OrthographicCamera too.
    let ppuMax = 0;
    for (const lam of [0, 0.25, 0.5, 1]) for (const d of [d0, 55, 88]) {
        const cam = new PlaneCamera(70, 1.6, 50, 90);
        cam.blend = lam; cam.planeDepth = d0; cam.updateProjectionMatrix();
        const a = ndcOf(cam, 0, 0, -d), b = ndcOf(cam, 0, 1, -d);
        const px = (b.y / b.w - a.y / a.w) / 2 * 942;
        ppuMax = Math.max(ppuMax, rel(px, pxPerUnitAt(cam, d, 942)), rel(viewHeightAt(cam, d), 942 / px));
    }
    const oc = new THREE.OrthographicCamera(-80, 80, 50, -50, 0.1, 100);
    ppuMax = Math.max(ppuMax, rel(pxPerUnitAt(oc, 37, 942), 942 / 100));
    ok(ppuMax <= 1e-12, `pxPerUnitAt / viewHeightAt agree with projecting two points (max rel ${ppuMax.toExponential(2)})`);
    ok(clipW(new THREE.PerspectiveCamera(70, 1, 1, 100), 42) === 42, 'clipW under perspective is the depth');

    // copy / clone / the pick path's new constructor().copy carry λ and d₀.
    const src = new PlaneCamera(70, 1.6, 50, 90);
    src.blend = 0.2; src.planeDepth = 61; src.updateProjectionMatrix();
    for (const [what, cc] of [['copy', new PlaneCamera().copy(src)], ['clone', src.clone()], ['new constructor().copy', new src.constructor().copy(src, false)]]) {
        ok(cc.isPlaneCamera && cc.blend === 0.2 && cc.planeDepth === 61, `${what} carries λ and d₀`);
        cc.updateProjectionMatrix();
        ok(cc.projectionMatrix.equals(src.projectionMatrix), `${what}: the same matrix`);
    }

    // What isn't written below λ = 1 throws by name; λ = 1 still takes them (three's own).
    for (const [what, set, word] of [
        ['zoom', (cam) => { cam.zoom = 2; }, 'zoom'], ['filmOffset', (cam) => { cam.filmOffset = 1; }, 'filmOffset'],
        ['WebGPU coordinates', (cam) => { cam.coordinateSystem = THREE.WebGPUCoordinateSystem; }, 'coordinate system'],
        ['reversed depth', (cam) => { cam._reversedDepth = true; }, 'reversed depth'],   // three sets it from the renderer
        ['blend 1.5', (cam) => { cam.blend = 1.5; }, 'blend'], ['planeDepth 0', (cam) => { cam.planeDepth = 0; }, 'planeDepth'],
    ]) {
        const cam = new PlaneCamera(70, 1.6, 1, 100);
        cam.blend = 0.5; cam.planeDepth = 50;
        set(cam);
        let msg = '';
        try { cam.updateProjectionMatrix(); } catch (e) { msg = e.message; }
        ok(msg.includes(word), `below λ = 1, ${what} throws by name (${msg || 'no throw'})`);
    }

    // rayFromCamera: the ray under a projected point passes through it, at every λ; at λ = 1 it is
    // three's ray (from the eye).
    const eye = new PlaneCamera(70, 1.6, 50, 90);
    eye.position.set(10, 20, 30); eye.rotation.set(0.2, -0.4, 0); eye.updateMatrixWorld(true);
    eye.planeDepth = d0;
    let rayMax = 0;
    for (const lam of [1, 0.5, 0]) {
        eye.blend = lam; eye.updateProjectionMatrix();
        for (const P of [new THREE.Vector3(5, 10, -40), new THREE.Vector3(-20, 30, -35), new THREE.Vector3(8, 25, -50)]) {
            const ndc = P.clone().project(eye);
            const r = rayFromCamera(new THREE.Raycaster(), ndc, eye);
            rayMax = Math.max(rayMax, r.ray.distanceToPoint(P));
        }
    }
    ok(rayMax <= 1e-6, `rayFromCamera passes through what projects there, every λ (max miss ${rayMax.toExponential(2)})`);
    eye.blend = 1; eye.updateProjectionMatrix();
    const ndc = new THREE.Vector2(0.3, -0.2);
    const mine = rayFromCamera(new THREE.Raycaster(), ndc, eye), three = new THREE.Raycaster();
    three.setFromCamera(ndc, eye);
    ok(mine.ray.origin.distanceTo(three.ray.origin) <= 1e-9 && mine.ray.direction.angleTo(three.ray.direction) <= 1e-9, 'at λ = 1 it is three\'s ray, from the eye');
    eye.blend = 0; eye.updateProjectionMatrix();
    const r0 = rayFromCamera(new THREE.Raycaster(), new THREE.Vector2(0.9, 0.8), eye), r1 = rayFromCamera(new THREE.Raycaster(), new THREE.Vector2(-0.7, 0.1), eye);
    ok(r0.ray.direction.angleTo(r1.ray.direction) <= 1e-9, 'at λ = 0 the rays are parallel');
    ok(zDistanceForFit(eye, 10, 10, 1) === zDistanceForFit(new THREE.PerspectiveCamera(70, 1.6, 50, 90), 10, 10, 1), 'a fit answers for the perspective lens at any λ');
}

// ── The orthographic endpoint: the controller ───────────────────────────────────────────────────
function orthoRig({ dpr = 1, Cam = PlaneCamera } = {}) {
    const r = rig({ dpr });
    const camera = new Cam(70, W / H, 1, 20000);
    camera.position.copy(r.camera.position);
    r.cc.ctx.camera = camera;
    r.cc._applyRotation();
    camera.updateMatrixWorld(true);
    return { cc: r.cc, camera, dpr };
}
const ORTHO = { ...PLANE, ortho: true };
for (const dpr of [1, 2]) {
    const { cc, camera } = orthoRig({ dpr });
    const homeMatrix = camera.projectionMatrix.clone(), homePos = camera.position.clone();
    // Enter holding a referent OFF the view centre (where a scale error shows as drift): it stays
    // where it is on screen, every frame of the blend.
    const look0 = cc.planePointAtView(PLANE);
    const look = { x: look0.x + 200, y: look0.y - 80 };
    const P = onPlane(look.x, look.y);
    const start = proj(camera, P);
    ok(Math.abs(start.x - W / 2) > 100 && start.x > 0 && start.x < W && start.y > 0 && start.y < H, `ortho dpr ${dpr}: the referent starts on screen, off centre (${start.x.toFixed(0)}, ${start.y.toFixed(0)})`);
    cc.enterPlane({ ...ORTHO, referent: look }, { ms: 700 });
    let held = 0, clipped = 0, lam = [];
    while (cc.planeState().tweening) {
        frame(cc, camera);
        const q = proj(camera, P);
        held = Math.max(held, Math.hypot(q.x - start.x, q.y - start.y) * dpr);
        const z = proj(camera, onPlane(0, 0)).z;
        if (!(z > -1 && z < 1)) clipped++;
        lam.push(camera.blend);
    }
    ok(held < 1, `ortho dpr ${dpr}: the referent holds its spot every frame of the blend (worst ${held.toFixed(3)} device px)`);
    ok(clipped === 0, `ortho dpr ${dpr}: the plane is never clipped on the way in`);
    ok(lam.every((v, i) => i === 0 || v <= lam[i - 1]) && lam.some((v) => v > 0 && v < 1), `ortho dpr ${dpr}: λ eases 1 → 0 with the dolly`);
    const st = cc.planeState();
    const d0 = planeDistance({ fovDeg: 70, viewportH: H * dpr, pxPerUnit: PLANE.pxPerUnit });
    ok(camera.blend === 0 && camera.fov === 70, `ortho dpr ${dpr}: lands orthographic, the open-world fov kept (λ ${camera.blend}, fov ${camera.fov})`);
    near(camera.planeDepth, d0, 1e-9, `ortho dpr ${dpr}: d₀ = e₅·Hd/(2k)`);
    near(camera.projectionMatrix.elements[5] * H * dpr / (2 * camera.planeDepth), PLANE.pxPerUnit, 1e-9, `ortho dpr ${dpr}: e₅·Hd/(2d₀) is the plane scale`);
    ok(st.ortho === true && st.camera.blend === 0, `ortho dpr ${dpr}: planeState says so`);
    const a = proj(camera, onPlane(-30, 10)), b = proj(camera, onPlane(-29, 9));
    near((b.x - a.x) * dpr, PLANE.pxPerUnit, 1e-6, `ortho dpr ${dpr}: x scale (device px)`);
    near((b.y - a.y) * dpr, PLANE.pxPerUnit, 1e-6, `ortho dpr ${dpr}: y scale (device px)`);
    const o = proj(camera, onPlane(PLANE.origin.x, PLANE.origin.y));
    near(o.x * dpr, Math.round(o.x * dpr), 1e-6, `ortho dpr ${dpr}: origin x on a device-pixel corner`);
    near(o.y * dpr, Math.round(o.y * dpr), 1e-6, `ortho dpr ${dpr}: origin y on a device-pixel corner`);
    const deep = proj(camera, onPlane(55, -12, -30)), flat = proj(camera, onPlane(55, -12));
    ok(Math.abs(deep.x - flat.x) <= 1e-9 && Math.abs(deep.y - flat.y) <= 1e-9, `ortho dpr ${dpr}: a layer 30 units behind lands exactly on the plane's pixel (${(deep.x - flat.x).toExponential(1)})`);
    const snap = [...camera.position.toArray(), ...camera.projectionMatrix.elements];
    for (let i = 0; i < 20; i++) frame(cc, camera);
    ok([...camera.position.toArray(), ...camera.projectionMatrix.elements].every((v, i) => v === snap[i]), `ortho dpr ${dpr}: a still view is bit-identical frame to frame`);

    // The fan: the camera doesn't move (bit for bit); its listeners hear it eased 0 → 4 with the
    // plane's px per unit; off eases it back to 0. (LayerStack.setFan moves the pages —
    // plane-oblique.test.)
    let msg = '';
    try { cc.setPlaneFov(25); } catch (e) { msg = e.message; }
    ok(/orthographic/.test(msg), `ortho dpr ${dpr}: setPlaneFov is refused, naming the fan (${msg})`);
    const pitch = 2.5;
    const heard = [];
    const hear = (px, ppu) => heard.push({ px, ppu });
    cc.addPlaneFanListener(hear);
    const still = [...camera.position.toArray(), ...camera.projectionMatrix.elements];
    cc.setPlaneFan(4, { ms: 300 });
    let moved = 0;
    while (cc.planeState().tweening) {
        frame(cc, camera);
        if (![...camera.position.toArray(), ...camera.projectionMatrix.elements].every((v, i) => v === still[i])) moved++;
    }
    ok(moved === 0, `ortho dpr ${dpr}: the fan moves no camera — position and matrix bit-identical every frame (${moved} moved)`);
    ok(heard.length > 2 && heard.every((h, i) => h.ppu === PLANE.pxPerUnit && (i === 0 || h.px > heard[i - 1].px)) && heard.at(-1).px === 4,
        `ortho dpr ${dpr}: its listeners hear it eased 0 → 4 at the plane's px per unit (${heard.length} steps, last ${heard.at(-1)?.px})`);
    ok(cc.planeState().fan?.px === 4 && cc.planeState().fanPx === 4 && cc.planeFanPx() === 4, `ortho dpr ${dpr}: planeState reports the fan`);
    // Picking at λ = 0: the pick camera's one-pixel window centres what is under that pixel.
    let pickMax = 0;
    for (const Q of [onPlane(10, 5), onPlane(-20, 3, -2 * pitch), onPlane(40, -8, -pitch)]) {
        const q = proj(camera, Q);
        const pc = new camera.constructor().copy(camera, false);
        pc.setViewOffset(W, H, q.x - 0.5, q.y - 0.5, 1, 1);
        const v = new THREE.Vector3(Q.x, Q.y, Q.z).project(pc);
        pickMax = Math.max(pickMax, Math.abs(v.x), Math.abs(v.y));
    }
    ok(pickMax <= 1e-6, `ortho dpr ${dpr}: a pick window centres the point under its pixel at λ = 0 (max ${pickMax.toExponential(2)} NDC)`);
    cc.setPlaneFan(0, { ms: 300 });
    while (cc.planeState().tweening) frame(cc, camera);
    ok(heard.at(-1).px === 0 && cc.planeState().fan === null && cc.planeFanPx() === 0, `ortho dpr ${dpr}: plane.fan off folds the layers (heard ${heard.at(-1).px})`);
    cc.setPlaneFan(4, { ms: 0 });
    frame(cc, camera);
    ok(heard.at(-1).px === 4, `ortho dpr ${dpr}: fanned again before leaving`);

    // The raw blend handle: the plane's scale held at any λ.
    cc.setPlaneBlend(0.5);
    ok(camera.blend === 0.5, `ortho dpr ${dpr}: the blend handle sets λ`);
    const h1 = proj(camera, onPlane(-30, 10)), h2 = proj(camera, onPlane(-29, 9));
    near((h2.x - h1.x) * dpr, PLANE.pxPerUnit, 1e-6, `ortho dpr ${dpr}: at λ 0.5 the plane keeps its scale`);
    cc.setPlaneBlend(null);
    ok(camera.blend === 0, `ortho dpr ${dpr}: default hands λ back to the endpoint`);

    // A switch cuts to the other plane's endpoint, still orthographic.
    cc.enterPlane({ ...ORTHO, center: { x: 300, y: 0, z: -80 }, normal: { x: 0, y: 0, z: 1 } });
    ok(!cc.planeState().tweening && camera.blend === 0, `ortho dpr ${dpr}: a switch is a cut, still λ = 0`);

    // Leave: λ back to 1, home exactly — the matrix bit-identical.
    cc.leavePlane({ ms: 600 });
    while (cc._lens) frame(cc, camera);
    ok(camera.blend === 1 && heard.at(-1).px === 0 && cc.planeFanPx() === 0, `ortho dpr ${dpr}: left, λ = 1 and the fan folded (heard ${heard.at(-1).px})`);
    cc.removePlaneFanListener(hear);
    ok(camera.projectionMatrix.equals(homeMatrix) && camera.position.equals(homePos), `ortho dpr ${dpr}: left, the home matrix and pose bit-identical`);
}
{
    // A restore while entered orthographic cuts home: λ = 1, the fan folded, the home matrix exactly.
    const { cc, camera } = orthoRig();
    const homeMatrix = camera.projectionMatrix.clone();
    cc.enterPlane(ORTHO, { ms: 100 });
    while (cc.planeState().tweening) frame(cc, camera);
    let last = null;
    cc.addPlaneFanListener((px) => { last = px; });
    cc.setPlaneFan(3, { ms: 0 });
    frame(cc, camera);
    ok(camera.blend === 0 && last === 3, 'entered orthographic and fanned');
    cc.applyState(cc.getState());
    ok(camera.blend === 1 && last === 0 && camera.projectionMatrix.equals(homeMatrix), `a restore cuts home: λ = 1, the fan folded, the home matrix (λ ${camera.blend}, fan ${last})`);
}
{
    // ortho needs a PlaneCamera; the fan needs ortho.
    const { cc } = rig();
    let msg = '';
    try { cc.enterPlane(ORTHO); } catch (e) { msg = e.message; }
    ok(/PlaneCamera/.test(msg) && cc.planeState() === null, `an orthographic enter on a plain PerspectiveCamera is refused by name (${msg})`);
    cc.enterPlane(PLANE);
    msg = '';
    try { cc.setPlaneFan(4); } catch (e) { msg = e.message; }
    ok(/perspective/.test(msg), `the px fan on the perspective endpoint is refused by name (${msg})`);
}

// ── The OPEN WORLD is bit-identical with a PlaneCamera at λ = 1 (teeth: always-formula) ──────────
{
    class FormulaCamera extends PlaneCamera {
        updateProjectionMatrix() { if (!this.isPlaneCamera) return super.updateProjectionMatrix(); this._blendMatrix(this.projectionMatrix); this.projectionMatrixInverse.copy(this.projectionMatrix).invert(); }
    }
    /** Drive one rig through the open world (flight, a perspective plane enter/leave, a resize). */
    const run = (Cam) => {
        const r = Cam ? orthoRig({ Cam }) : rig();
        const out = [];
        const rec = () => out.push(...r.camera.position.toArray(), ...r.camera.quaternion.toArray(), ...r.camera.projectionMatrix.elements);
        r.cc.input.keys.add('KeyW');
        for (let i = 0; i < 20; i++) { frame(r.cc, r.camera); rec(); }
        r.cc.input.keys.delete('KeyW');
        r.cc.enterPlane(PLANE, { ms: 300 });
        while (r.cc.planeState().tweening) { frame(r.cc, r.camera); rec(); }
        r.cc.leavePlane({ ms: 300 });
        while (r.cc._lens) { frame(r.cc, r.camera); rec(); }
        r.camera.aspect = 1.25; r.camera.updateProjectionMatrix(); frame(r.cc, r.camera); rec();
        return out;
    };
    const base = run(null), plane = run(PlaneCamera), formula = run(FormulaCamera);
    const diffs = (a, b) => a.length !== b.length ? Infinity : a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
    ok(diffs(base, plane) === 0, `the open world with a PlaneCamera at λ = 1 is bit-identical to a PerspectiveCamera (${diffs(base, plane)} of ${base.length} values differ)`);
    ok(diffs(base, formula) > 0, `teeth: a camera that always uses the blend formula differs (${diffs(base, formula)} values)`);
}

// ── The fov-trig gate: a scale comes from the projection matrix (spatialMath), never from a fov ──
{
    const out = Bun.spawnSync(['rg', '-n', '--no-heading', String.raw`getEffectiveFOV|isPerspectiveCamera|setFromCamera\(|Math\.(tan|sin|atan)\(.*(\.fov\b|\bfovDeg\b)|(\.fov\b|\bfovDeg\b).*Math\.PI`, 'packages', 'app', '-g', '!**/node_modules/**', '-g', '!**/dist/**'], { cwd: new URL('..', import.meta.url).pathname });
    const ALLOWED = {
        'packages/glyph3d-core/src/services/spatial/spatialMath.js': 'the helper (its doc names setFromCamera)',
        'packages/glyph3d-core/src/services/camera/PlaneCamera.js': 'the camera derives sx/sy from its fov exactly as three does',
        'packages/glyph3d-core/src/services/camera/planeView.js': 'pure endpoint math: the depth at which a chosen fov shows a scale',
    };
    const lines = out.stdout.toString().split('\n').filter(Boolean);
    const stray = lines.filter((l) => !ALLOWED[l.split(':')[0]]);
    ok(out.exitCode === 0 || out.exitCode === 1, `the fov-trig rg ran (exit ${out.exitCode})`);
    ok(stray.length === 0, `no fov-trig outside the helper, the camera and planeView:\n    ${stray.join('\n    ')}`);
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-camera: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
