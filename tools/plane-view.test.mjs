// plane-view.test.mjs — the plane-view camera math (core services/camera/planeView.js), checked
// against three's OWN projection, not against itself.
//
//   bun tools/plane-view.test.mjs
//
// Locks:
//   - a camera squared to a plane at planeDistance shows it at exactly pxPerUnit CSS px per unit,
//     everywhere on screen (no foreshortening), at any fov
//   - the dolly (fov narrowing, depth growing) keeps the plane's scale fixed at every step
//   - parallaxPx predicts the real drift of a point off the plane; at orthoFov it is ≤ tol at the edge
//   - snapAim puts a pane's origin on a device-pixel corner, at any dpr and any start aim, and the
//     real projection agrees
//   - planeSlab brackets the plane (a point in front of the slab is clipped, the plane is not)

import * as THREE from 'three';
import {
    planeDistance, planeScale, parallaxPx, orthoFov, snapAim, planeToDevice, planeSlab, dollyAt,
} from '../packages/glyph3d-core/src/services/camera/planeView.js';

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.error(`FAIL ${msg}`); } };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

const W = 1600, H = 1000;

// A camera at (aim.x, aim.y, D) looking down −z at the plane z = 0; project a plane point to CSS px.
function project(cam, p) {
    const v = new THREE.Vector3(p.x, p.y, p.z ?? 0).project(cam);
    return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, z: v.z };
}
function cameraAt({ fovDeg, distance, aim, slab }) {
    const cam = new THREE.PerspectiveCamera(fovDeg, W / H, slab?.near ?? 0.1, slab?.far ?? 1e7);
    cam.position.set(aim.x, aim.y, distance);
    cam.lookAt(aim.x, aim.y, 0);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
}

// 1. scale is exact across the screen, any fov
for (const fovDeg of [60, 30, 5, 1, 0.25]) {
    const pxPerUnit = 11.034;
    const distance = planeDistance({ fovDeg, viewportH: H, pxPerUnit });
    const cam = cameraAt({ fovDeg, distance, aim: { x: 3, y: -2 } });
    for (const [x, y] of [[3, -2], [40, 20], [-60, -40], [70, 44]]) {
        const a = project(cam, { x, y }), b = project(cam, { x: x + 1, y: y - 1 });
        near(b.x - a.x, pxPerUnit, 1e-6 * pxPerUnit * 100, `fov ${fovDeg} x-scale at (${x},${y})`);
        near(b.y - a.y, pxPerUnit, 1e-6 * pxPerUnit * 100, `fov ${fovDeg} y-scale at (${x},${y})`);
    }
    near(planeScale({ fovDeg, viewportH: H, distance }), pxPerUnit, 1e-9, `planeScale inverts planeDistance at fov ${fovDeg}`);
}

// 2. the dolly keeps the scale fixed when fromScale == toScale, and lands on toScale
for (let i = 0; i <= 10; i++) {
    const s = dollyAt({ fromFov: 50, toFov: 0.5, fromScale: 8, toScale: 8, viewportH: H, t: i / 10 });
    near(planeScale({ fovDeg: s.fovDeg, viewportH: H, distance: s.distance }), 8, 1e-9, `dolly t=${i / 10} holds scale`);
}
{
    const end = dollyAt({ fromFov: 50, toFov: 0.5, fromScale: 2, toScale: 11, viewportH: H, t: 1 });
    near(end.pxPerUnit, 11, 1e-9, 'dolly lands on the target scale');
    near(end.fovDeg, 0.5, 1e-12, 'dolly lands on the target fov');
}

// 3. parallax prediction matches the projection; orthoFov bounds it
{
    const fovDeg = 20, pxPerUnit = 10, depth = 3, aim = { x: 0, y: 0 };
    const distance = planeDistance({ fovDeg, viewportH: H, pxPerUnit });
    const cam = cameraAt({ fovDeg, distance, aim });
    const px = 50;                                          // a point 50 units right of center
    const onPlane = project(cam, { x: px, y: 0, z: 0 });
    const lifted = project(cam, { x: px, y: 0, z: depth });
    const predicted = parallaxPx({ fovDeg, viewportH: H, pxPerUnit, depth, offsetPx: onPlane.x - W / 2 });
    near(lifted.x - onPlane.x, predicted, 1e-6, 'parallaxPx predicts the real drift');

    const edgePx = Math.hypot(W, H) / 2, tolPx = 0.25;
    const f = orthoFov({ viewportH: H, pxPerUnit, depth, edgePx, tolPx });
    const worst = parallaxPx({ fovDeg: f, viewportH: H, pxPerUnit, depth, offsetPx: edgePx });
    ok(worst <= tolPx + 1e-9, `orthoFov(${f.toFixed(3)}°) keeps the edge drift ≤ ${tolPx} px (got ${worst})`);
    const wider = parallaxPx({ fovDeg: f * 1.5, viewportH: H, pxPerUnit, depth, offsetPx: edgePx });
    ok(wider > tolPx, 'a wider fov than orthoFov drifts more than the tolerance (the bound is tight)');
}

// 4. snapAim: the origin lands on a device-pixel corner, by the formula and by three
for (const dpr of [1, 1.25, 2]) {
    for (const start of [{ x: 0.123, y: 0.987 }, { x: -7.31, y: 2.002 }, { x: 0, y: 0 }]) {
        const pxPerUnit = 10.7, origin = { x: -40.017, y: 25.333 };
        const aim = snapAim({ aim: start, origin, viewportW: W, viewportH: H, dpr, pxPerUnit });
        const d = planeToDevice({ p: origin, aim, viewportW: W, viewportH: H, dpr, pxPerUnit });
        near(d.x, Math.round(d.x), 1e-6, `snap x @dpr ${dpr} from (${start.x},${start.y})`);
        near(d.y, Math.round(d.y), 1e-6, `snap y @dpr ${dpr} from (${start.x},${start.y})`);
        ok(Math.hypot(aim.x - start.x, aim.y - start.y) <= Math.SQRT2 / (dpr * pxPerUnit), 'snap moves the aim by under a device pixel');
        const fovDeg = 1;
        const cam = cameraAt({ fovDeg, distance: planeDistance({ fovDeg, viewportH: H, pxPerUnit }), aim });
        const real = project(cam, origin);
        near(real.x * dpr, d.x, 1e-3, `three agrees on the snapped x @dpr ${dpr}`);
        near(real.y * dpr, d.y, 1e-3, `three agrees on the snapped y @dpr ${dpr}`);
    }
}

// 5. the slab clips what stands in front of the plane, not the plane
{
    const fovDeg = 1, pxPerUnit = 10;
    const distance = planeDistance({ fovDeg, viewportH: H, pxPerUnit });
    const slab = planeSlab({ distance, front: 5, back: 50 });
    const cam = cameraAt({ fovDeg, distance, aim: { x: 0, y: 0 }, slab });
    const inside = (p) => { const z = project(cam, p).z; return z >= -1 && z <= 1; };
    ok(inside({ x: 0, y: 0, z: 0 }), 'the plane is inside the slab');
    ok(inside({ x: 0, y: 0, z: 4 }), 'a layer 4 units in front is inside');
    ok(!inside({ x: 0, y: 0, z: 20 }), 'an occluder 20 units in front is clipped');
    ok(!inside({ x: 0, y: 0, z: -80 }), 'a wall 80 units behind is clipped');
}

console.log(`${fails ? 'FAIL' : 'ok'} plane-view: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
