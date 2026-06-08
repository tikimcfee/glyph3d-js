/**
 * Shared spatial math utilities for pixel-to-world conversion.
 *
 * Lives in src/ so both src/ and app/ consumers can import without
 * crossing module boundaries the wrong direction.
 */

import * as THREE from 'three';
import { getCanvasViewportSize } from '../../core/canvasSize.js';

/**
 * Convert screen-pixel deltas to world-space deltas at a given Z depth.
 * Quaternion-aware: works at any camera orientation.
 *
 * @param {number} dx - screen pixels rightward
 * @param {number} dy - screen pixels downward
 * @param {number} objectZ - world Z of the target plane
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLCanvasElement} canvas
 * @returns {{ x: number, y: number }}
 */
export function screenToWorldDelta(dx, dy, objectZ, camera, canvas) {
    const { height } = getCanvasViewportSize(canvas);
    const depth = Math.abs(camera.position.z - objectZ);
    const fovRad = camera.fov * Math.PI / 180;
    const pixelScale = (2 * depth * Math.tan(fovRad / 2)) / height;

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

    return {
        x:  dx * pixelScale * right.x + (-dy) * pixelScale * up.x,
        y:  dx * pixelScale * right.y + (-dy) * pixelScale * up.y,
    };
}

/**
 * World units spanned by one screen pixel at a given VIEW-AXIS depth (distance
 * along the camera's forward direction). The single conversion behind every
 * drag/pan/dolly so they can't drift: the caller supplies the depth — egocentric,
 * "how far down my own view axis is the thing I'm moving toward / looking at" —
 * and applies the camera's right/up basis to the scalar this returns.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {number} depth - distance along the camera forward axis
 * @param {number} viewportHeight - canvas height in CSS pixels
 * @returns {number} world units per pixel
 */
export function worldPerPixel(camera, depth, viewportHeight) {
    return (2 * depth * Math.tan((camera.fov * Math.PI / 180) / 2)) / viewportHeight;
}

/**
 * Z distance at which a `width`×`height` world-space region fills `fillFraction`
 * of the viewport, accounting for FOV and aspect. The single source of truth for
 * "how far back to sit to frame this box" — VCC focus helpers, command-handler
 * framing, and the groups panel all use this (no per-call-site FOV math).
 *
 * @param {THREE.PerspectiveCamera} camera
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
 * Sample a camera "pose" (position + pitch + yaw) eased from `from` to `to` at normalized
 * time t. Pure — the camera tween's whole interpolation lives here so it's unit-testable
 * away from THREE/the renderer. t=0 → from, t=1 → to, ease-out between.
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
        yaw: lerp(from.yaw, to.yaw),
    };
}
