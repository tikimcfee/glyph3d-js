/**
 * Shared spatial math utilities for pixel-to-world conversion.
 *
 * Lives in src/ so both src/ and app/ consumers can import without
 * crossing module boundaries the wrong direction.
 */

import * as THREE from 'three';

/**
 * THE CAMERA'S SCALE, read from its projection matrix — the one truth every site that asks "how
 * big is a world unit on screen at this depth" reads (DESIGN §4.6). Any projection whose w row is
 * (0, 0, e₁₁, e₁₅) — three's perspective (e₁₁ = −1, e₁₅ = 0), an orthographic camera (0, 1), a
 * PlaneCamera at any blend — answers truthfully; no site derives a scale from `fov` itself.
 * For a camera without a view offset (the view camera; a pick camera's window rescales e₅).
 */

/**
 * The clip w of a point `depth` world units ahead of `camera` (along its view axis).
 * @param {THREE.Camera} camera @param {number} depth @returns {number}
 */
export function clipW(camera, depth) {
    const e = camera.projectionMatrix.elements;
    return -e[11] * depth + e[15];
}

/**
 * Pixels per world unit at view depth `depth`, for a viewport `viewportHeight` px tall (CSS or
 * device px — the answer is in the same px).
 * @param {THREE.Camera} camera @param {number} depth @param {number} viewportHeight @returns {number}
 */
export function pxPerUnitAt(camera, depth, viewportHeight) {
    return camera.projectionMatrix.elements[5] * viewportHeight / (2 * clipW(camera, depth));
}

const _ppuEye = new THREE.Vector3(), _ppuFwd = new THREE.Vector3();

/**
 * Pixels per world unit at a WORLD point: pxPerUnitAt at that point's view depth (floored at
 * 1e-3, so a point at or behind the eye answers the near-eye scale, never a sign flip).
 * @param {THREE.Camera} camera @param {{x:number, y:number, z:number}} worldPos
 * @param {number} viewportHeight @returns {number}
 */
export function pxPerUnitAtPoint(camera, worldPos, viewportHeight) {
    camera.getWorldPosition(_ppuEye);
    camera.getWorldDirection(_ppuFwd);
    const depth = (worldPos.x - _ppuEye.x) * _ppuFwd.x + (worldPos.y - _ppuEye.y) * _ppuFwd.y + (worldPos.z - _ppuEye.z) * _ppuFwd.z;
    return pxPerUnitAt(camera, Math.max(1e-3, depth), viewportHeight);
}

/**
 * The world height the view spans at view depth `depth`.
 * @param {THREE.Camera} camera @param {number} depth @returns {number}
 */
export function viewHeightAt(camera, depth) {
    return 2 * clipW(camera, depth) / camera.projectionMatrix.elements[5];
}

/**
 * World units spanned by one screen pixel at a given VIEW-AXIS depth (distance
 * along the camera's forward direction). The single conversion behind every
 * drag/pan/dolly so they can't drift: the caller supplies the depth — egocentric,
 * "how far down my own view axis is the thing I'm moving toward / looking at" —
 * and applies the camera's right/up basis to the scalar this returns.
 *
 * @param {THREE.Camera} camera
 * @param {number} depth - distance along the camera forward axis
 * @param {number} viewportHeight - canvas height in CSS pixels
 * @returns {number} world units per pixel
 */
export function worldPerPixel(camera, depth, viewportHeight) {
    return viewHeightAt(camera, depth) / viewportHeight;
}

/**
 * Z distance at which a `width`×`height` world-space region fills `fillFraction`
 * of the viewport, accounting for FOV and aspect. The single source of truth for
 * "how far back to sit to frame this box" — VCC focus helpers, command-handler
 * framing, and the groups panel all use this (no per-call-site FOV math).
 *
 * A fit is a PERSPECTIVE notion: it answers for the camera's own perspective lens — its fov and
 * aspect, what a PlaneCamera is at blend 1 — which is the lens a fly flies with (a fly leaves a
 * plane view first). Read from the fov exactly as it always was, so every open-world fly lands
 * where it did bit for bit (a fit through e₅ differs in the last bits).
 *
 * @param {{fov:number, aspect:number}} camera
 * @param {number} width
 * @param {number} height
 * @param {number} [fillFraction=0.85] - <1 leaves margin around the region.
 * @returns {number}
 */
export function zDistanceForFit(camera, width, height, fillFraction = 0.85) {
    const halfTan = Math.tan((camera.fov * Math.PI / 180) / 2);
    const dH = (height / fillFraction) / (2 * halfTan);
    const dW = (width / fillFraction) / (2 * camera.aspect * halfTan);
    return Math.max(dH, dW);
}

/**
 * The distance at which a sphere of radius `radius` just fits the view's height, for a
 * perspective camera (the minimap's overview): r / sin(φ/2) = r·√(e₅² + 1).
 * @param {THREE.Camera} camera @param {number} radius @returns {number}
 */
export function sphereFitDistance(camera, radius) {
    const e = camera.projectionMatrix.elements;
    if (e[11] !== -1 || e[15] !== 0) throw new Error('sphereFitDistance: needs a perspective projection (w = −z)');
    return radius * Math.sqrt(e[5] * e[5] + 1);
}

const _rayA = new THREE.Vector3(), _rayB = new THREE.Vector3();

/**
 * Point `raycaster` along the view ray under `ndc` — for ANY projection (three's setFromCamera
 * takes the perspective branch for a PlaneCamera at every blend, wrong below 1): the ray through
 * the unprojected near (z = −1) and far (z = +1) points, its origin where it crosses the eye plane
 * (view z = 0: the eye itself under perspective; under an orthographic blend, the rays are
 * parallel). Sets `raycaster.camera` as setFromCamera does.
 * @param {THREE.Raycaster} raycaster @param {{x:number, y:number}} ndc @param {THREE.Camera} camera
 * @returns {THREE.Raycaster}
 */
export function rayFromCamera(raycaster, ndc, camera) {
    const a = _rayA.set(ndc.x, ndc.y, -1).applyMatrix4(camera.projectionMatrixInverse);
    const b = _rayB.set(ndc.x, ndc.y, 1).applyMatrix4(camera.projectionMatrixInverse);
    b.sub(a);                                   // view-space direction
    a.addScaledVector(b, -a.z / b.z);           // slide to view z = 0
    raycaster.ray.origin.copy(a).applyMatrix4(camera.matrixWorld);
    raycaster.ray.direction.copy(b).transformDirection(camera.matrixWorld);
    raycaster.camera = camera;
    return raycaster;
}

/**
 * Cubic ease-in-out over a normalized parameter.
 * @param {number} t - 0..1
 * @returns {number} eased 0..1
 */
export function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Cubic ease-OUT — fast start, gentle settle. The "comfortably snappy" curve for camera
 * flies. Clamped to [0,1]: easeOutCubic(0)=0, easeOutCubic(1)=1, monotonic.
 * @param {number} t - 0..1
 * @returns {number} eased 0..1
 */
export function easeOutCubic(t) {
    const u = 1 - Math.min(Math.max(t, 0), 1);
    return 1 - u * u * u;
}

/**
 * The signed yaw step from `a` to `b` the short way round: in [−π, π).
 * @param {number} a @param {number} b @returns {number}
 */
export function shortYaw(a, b) {
    const d = b - a;
    return d - 2 * Math.PI * Math.floor((d + Math.PI) / (2 * Math.PI));
}

/**
 * Sample a camera "pose" (position + pitch + yaw) eased from `from` to `to` at normalized
 * time t. Pure — the camera tween's whole interpolation lives here so it's unit-testable
 * away from THREE/the renderer. t=0 → from, t=1 → to exactly, ease-out between. Yaw turns the
 * short way round (across ±π it never spins the long way).
 *
 * @param {{position:{x,y,z}, pitch:number, yaw:number}} from
 * @param {{position:{x,y,z}, pitch:number, yaw:number}} to
 * @param {number} t - 0..1 (clamped)
 * @returns {{position:{x:number,y:number,z:number}, pitch:number, yaw:number}}
 */
export function tweenPose(from, to, t) {
    const e = easeOutCubic(t);
    const lerp = (a, b) => a + (b - a) * e;
    return {
        position: {
            x: lerp(from.position.x, to.position.x),
            y: lerp(from.position.y, to.position.y),
            z: lerp(from.position.z, to.position.z),
        },
        pitch: lerp(from.pitch, to.pitch),
        yaw: e >= 1 ? to.yaw : from.yaw + shortYaw(from.yaw, to.yaw) * e,
    };
}
