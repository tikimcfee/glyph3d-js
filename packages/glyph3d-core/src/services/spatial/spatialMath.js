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
