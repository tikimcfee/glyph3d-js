// plane-follow.test.mjs — a plane that MOVES while it's read carries the view with it
// (ViewerCameraController.enterPlane `track`, _followPlane; carrel.enter's track: the desk's getPlaneRect).
//
//   bun tools/plane-follow.test.mjs
//
// The live bug: a team desk nested in the hub ring (gomux/<agent>) entered — by the reload's
// re-entry or by hand — then the ring re-seated it (its radius floor grew, the hub was re-placed), and
// the camera stayed where the board HAD been: nothing on screen, pick.at and scene.at empty.
// Locks, through the controller frame by frame with three's real projection:
//   - control: with no track, a moved plane leaves the view (its origin far off its pixel)
//   - with a track: translated + turned, grown from its fixed top-left, and rescaled (a nested desk's
//     world scale), the board's top-left stays on the SAME device pixel and the board point under the
//     view centre stays put (in device px) — every rest still pixel-snapped
//   - a still plane with a track is bit-identical frame to frame, and the track is the only reader
//   - moved mid-ease: the ease lands on the moved plane in its own time
//   - a track that throws stops following, said once; the view stays
// And end to end, through the real `carrel.enter` and real Carrels: a plane team desk nested in a
// ring hub, entered; then more members join the hub (the ring re-seats it) and the hub is re-placed —
// every pin's cell origin stays on its pixel, on screen and inside the slab (each pin draws).
// Teeth: the carrel.enter without the track (8eb8076's) leaves every pin off screen after the move.
//   CARREL_COMMANDS=<path> runs the end-to-end part against another carrelCommands.js.

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';

const { default: registerCarrelCommands } = await import(process.env.CARREL_COMMANDS || '../app/commands/handlers/carrelCommands.js');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const W = 1600, H = 942;

function rig() {
    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 50000);
    const canvas = { parentElement: { clientWidth: W, clientHeight: H }, width: W, height: H, style: {} };
    const ctx = { camera, THREE, canvas, getGrids: () => [] };
    const cc = new ViewerCameraController(ctx);
    cc.settings.softBounds = false;
    cc._onDeviceBox({ devicePixelContentBoxSize: [{ inlineSize: W, blockSize: H }] });   // an exact canvas
    camera.position.set(140, 60, 420);
    cc.yaw = 0.35; cc.pitch = -0.12;
    cc._applyRotation();
    camera.updateMatrixWorld(true);
    return { cc, camera };
}
const frame = (cc, camera, dt = 1 / 60) => { cc.applyCamera(dt); camera.updateMatrixWorld(true); };
const land = (cc, camera) => { let n = 0; while (cc.planeState()?.tweening && n++ < 400) frame(cc, camera); };
const proj = (camera, p) => {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, z: v.z };
};
const pxDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const onScreen = (p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H && p.z > -1 && p.z < 1;

/**
 * A board: its top-left fixed at `tl` (world), facing `yaw`, `w` × `h` world units at `ppu` device px
 * per unit — the frame a desk's getPlaneRect states (center, normal, up, pxPerUnit, origin).
 */
function board({ tl, yaw, w, h, ppu }) {
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const up = new THREE.Vector3(0, 1, 0);
    const center = new THREE.Vector3(tl.x, tl.y, tl.z).addScaledVector(right, w / 2).addScaledVector(up, -h / 2);
    /** a board point `px` device px right / down of the top-left, in world */
    const at = (px, py) => new THREE.Vector3(tl.x, tl.y, tl.z).addScaledVector(right, px / ppu).addScaledVector(up, -py / ppu);
    return { frame: { center, normal, up, pxPerUnit: ppu, origin: { x: -w / 2, y: h / 2 } }, at };
}
const SPEC = { fovDeg: 1, front: 6, back: 40 };

// ── control: no track — a moved plane leaves the view
{
    const { cc, camera } = rig();
    const b0 = board({ tl: { x: -40, y: 50, z: -60 }, yaw: 0.3, w: 120, h: 80, ppu: 10 });
    cc.enterPlane({ ...b0.frame, ...SPEC, aim: { x: 0, y: 0 } });
    land(cc, camera);
    const p0 = proj(camera, b0.at(0, 0));
    const b1 = board({ tl: { x: 260, y: 90, z: -10 }, yaw: 0.55, w: 120, h: 80, ppu: 10 });
    frame(cc, camera);
    const p1 = proj(camera, b1.at(0, 0));
    ok(pxDist(p0, p1) > 1000, `control: with no track the moved board's top-left leaves its pixel (${pxDist(p0, p1).toFixed(0)} px)`);
}

// ── with a track: moved, grown, rescaled — the board stays on its pixels
{
    const { cc, camera } = rig();
    let cur = board({ tl: { x: -40, y: 50, z: -60 }, yaw: 0.3, w: 120, h: 80, ppu: 10 });
    let reads = 0;
    cc.enterPlane({ ...cur.frame, ...SPEC, aim: { x: 7.3, y: -4.1 }, track: () => { reads++; return cur.frame; } });
    land(cc, camera);
    const tl0 = proj(camera, cur.at(0, 0)), pt0 = proj(camera, cur.at(333, 211));
    ok(Math.abs(tl0.x - Math.round(tl0.x)) < 2e-3 && Math.abs(tl0.y - Math.round(tl0.y)) < 2e-3, `landed: the top-left on a device-pixel corner (${tl0.x.toFixed(4)}, ${tl0.y.toFixed(4)})`);

    // still: bit-identical, the track read once a frame
    const snap = () => [...camera.position.toArray(), camera.fov, camera.near, camera.far, ...camera.quaternion.toArray()];
    const s0 = snap(); reads = 0;
    for (let i = 0; i < 20; i++) frame(cc, camera);
    ok(snap().every((v, i) => v === s0[i]), 'a still tracked plane: the camera is bit-identical frame to frame');
    ok(reads === 20, `the track is read once a frame (${reads} in 20)`);

    const moves = [
        ['translated and turned', { tl: { x: 260, y: 90, z: -10 }, yaw: 0.55, w: 120, h: 80, ppu: 10 }],
        ['grown from its fixed top-left', { tl: { x: 260, y: 90, z: -10 }, yaw: 0.55, w: 300, h: 140, ppu: 10 }],
        ['rescaled (a nested desk\'s world scale)', { tl: { x: 260, y: 90, z: -10 }, yaw: 0.55, w: 150, h: 70, ppu: 20 }],
        ['moved again, a fraction of a unit', { tl: { x: 260.37, y: 89.91, z: -10.2 }, yaw: 0.55, w: 150, h: 70, ppu: 20 }],
    ];
    for (const [name, spec] of moves) {
        cur = board(spec);
        frame(cc, camera);
        const tl = proj(camera, cur.at(0, 0)), pt = proj(camera, cur.at(333, 211));
        ok(pxDist(tl, tl0) < 2e-3, `${name}: the top-left stays on its pixel (${pxDist(tl, tl0).toExponential(2)} px)`);
        ok(pxDist(pt, pt0) < 2e-3, `${name}: a board point 333,211 px in stays on its pixel (${pxDist(pt, pt0).toExponential(2)} px)`);
        ok(tl.z > -1 && tl.z < 1, `${name}: the board is inside the slab (z ${tl.z.toFixed(4)})`);
        const k = pxDist(proj(camera, cur.at(0, 0)), proj(camera, cur.at(100, 0)));
        ok(Math.abs(k - 100) < 1e-3, `${name}: 100 board px read 100 device px (${k.toFixed(5)})`);
    }
}

// ── moved mid-ease: the ease lands on the moved plane, in its own time
{
    const { cc, camera } = rig();
    let cur = board({ tl: { x: -40, y: 50, z: -60 }, yaw: 0.3, w: 120, h: 80, ppu: 10 });
    cc.enterPlane({ ...cur.frame, ...SPEC, aim: { x: 0, y: 0 }, track: () => cur.frame }, { ms: 700 });
    for (let i = 0; i < 15; i++) frame(cc, camera);
    cur = board({ tl: { x: 200, y: 20, z: -300 }, yaw: -0.4, w: 120, h: 80, ppu: 10 });
    let n = 15;
    while (cc.planeState().tweening && n < 400) { frame(cc, camera); n++; }
    ok(n >= 40 && n <= 46, `mid-ease: the ease still takes its 700 ms (${n} frames)`);
    // the aim (0,0) is the board centre: it lands at the view centre, the top-left on a pixel corner
    const c = proj(camera, cur.at(600, 400)), tl = proj(camera, cur.at(0, 0));
    ok(pxDist(c, { x: W / 2, y: H / 2 }) < 1, `mid-ease: lands centred on the MOVED board (${c.x.toFixed(2)}, ${c.y.toFixed(2)})`);
    ok(Math.abs(tl.x - Math.round(tl.x)) < 2e-3 && Math.abs(tl.y - Math.round(tl.y)) < 2e-3, 'mid-ease: landed snapped');
}

// ── a track that throws: said once, the view stays, no more reads
{
    const { cc, camera } = rig();
    const b0 = board({ tl: { x: -40, y: 50, z: -60 }, yaw: 0.3, w: 120, h: 80, ppu: 10 });
    let reads = 0, thrw = false;
    cc.enterPlane({ ...b0.frame, ...SPEC, aim: { x: 0, y: 0 }, track: () => { reads++; if (thrw) throw new Error('non-uniform scale'); return b0.frame; } });
    land(cc, camera);
    const p0 = proj(camera, b0.at(0, 0));
    const errs = [], err = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    thrw = true; reads = 0;
    for (let i = 0; i < 5; i++) frame(cc, camera);
    console.error = err;
    ok(errs.length === 1 && errs[0].includes('non-uniform scale') && errs[0].includes('no longer following'), `a throwing track is said once (${errs.length}: ${errs[0]})`);
    ok(reads === 1 && pxDist(proj(camera, b0.at(0, 0)), p0) < 1e-6, `…the view stays, and the track isn't read again (${reads})`);
    let threw = null;
    try { cc.enterPlane({ ...b0.frame, ...SPEC, track: 'no' }); } catch (e) { threw = e.message; }
    ok(threw?.includes('track must be a function'), `a track that isn't a function fails loud (${threw})`);
}

// ── end to end: a plane team desk nested in a ring hub, entered through carrel.enter
{
    const CW = 0.725, LS = 1.359375;
    const UNIT = { column: CW, cellPx: 8, rowRatio: LS / CW };
    /** a terminal-like member: cols × rows cells from its top-left origin */
    const screen = (name, cols, rows) => {
        const g = new THREE.Object3D();
        g.name = name;
        g.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS };
        g.pixelOrigin = () => ({ x: 0, y: 0 });
        g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(0, -rows * LS, -0.5), new THREE.Vector3(cols * CW, 0, 0.5));
        return g;
    };
    /** a book-like hub member, deep (a deck) */
    const deck = () => {
        const g = new THREE.Object3D();
        g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(-300, -380, -900), new THREE.Vector3(300, 380, 10));
        g.getSeatBounds = (t) => g.getLocalBounds(t);
        return g;
    };
    const scene = new THREE.Scene();
    const hub = new Carrel({ name: 'gomux', mode: 'ring', seat: 'natural', radius: 900, ringMaxRows: 2, boxH: 110, gapFrac: 1.6, animDur: 0 });
    hub.position.set(-2500, 0, 0);
    scene.add(hub);
    const team = new Carrel({ name: 'gomux/root', mode: 'plane', animDur: 0 });
    scene.add(team);
    team.setPlaneUnit(UNIT);
    const members = [['a', 40, 20], ['b', 30, 20], ['c', 50, 24]].map(([id, cols, rows]) => {
        const s = screen(id, cols, rows); scene.add(s); team.lock(id, s, { immediate: true }); return [id, s];
    });
    for (let i = 0; i < 2; i++) { const d = deck(); scene.add(d); hub.lock(`book${i}`, d, { immediate: true }); }
    hub.lock('gomux/root', team, { immediate: true });
    const settle = () => { for (let i = 0; i < 12; i++) { hub.update(0.05); team.update(0.05); } scene.updateMatrixWorld(true); };
    settle();

    const { cc, camera } = rig();
    const verbs = new Map();
    registerCarrelCommands({ register: (name, fn) => verbs.set(name, fn) });
    const ctx = {
        scene, cameraController: cc,
        carrels: new Map([['gomux', hub], ['gomux/root', team]]),
        registry: { get: () => null },
        attentionManager: { set() {}, get: () => null },
    };
    const res = verbs.get('carrel.enter')(['gomux/root'], ctx);
    ok(/^OK: entered 'gomux\/root'/.test(res.text), `carrel.enter on the nested team desk (${res.text})`);
    land(cc, camera);
    const at = (s) => { s.updateWorldMatrix(true, false); return proj(camera, new THREE.Vector3(0, 0, 0).applyMatrix4(s.matrixWorld)); };
    const before = new Map(members.map(([id, s]) => [id, at(s)]));
    for (const [id, p] of before) ok(onScreen(p), `entered: pin ${id}'s cell origin on screen and inside the slab (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, z ${p.z.toFixed(4)})`);

    // The hub re-seats the team desk (more members join its ring) and is re-placed in the world.
    const w0 = team.getWorldPosition(new THREE.Vector3());
    for (let i = 2; i < 7; i++) { const d = deck(); scene.add(d); hub.lock(`book${i}`, d, { immediate: true }); }
    hub.position.x += 400;
    settle();
    const moved = team.getWorldPosition(new THREE.Vector3()).distanceTo(w0);
    ok(moved > 100, `the ring moved the team desk (${moved.toFixed(0)} units)`);
    frame(cc, camera);
    for (const [id, s] of members) {
        const p = at(s), p0 = before.get(id);
        ok(onScreen(p), `re-seated: pin ${id} still on screen and inside the slab (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, z ${p.z.toFixed(4)})`);
        ok(pxDist(p, p0) < 2e-3, `re-seated: pin ${id} on the same pixel (${pxDist(p, p0).toExponential(2)} px)`);
    }
    // and plane.state still reads the desk: the camera faces the board
    const rect = team.getPlaneRect();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    ok(fwd.dot(rect.normal) < -0.999999, `re-seated: the camera stays square to the board (${fwd.dot(rect.normal)})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} — plane-follow: ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
