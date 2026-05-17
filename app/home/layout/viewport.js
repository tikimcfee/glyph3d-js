/**
 * viewport — frame a 3D bounding box into the camera's view.
 *
 * The basic problem: a layout produces an AABB. We want the camera
 * positioned so the whole box fits inside the visible frustum, with
 * some padding around the edges. Two constraints — vertical (FOV)
 * and horizontal (FOV × aspect) — and we take whichever requires
 * the camera to be further away.
 *
 * Camera is assumed to look along -Z toward the layout's center.
 * We move ONLY the camera distance (z), preserving rotation and
 * the x/y centering done by Center().
 */

import * as THREE from 'three';
import { measureLocalBounds } from './measure.js';

const DEFAULT_PADDING = 1.18;   // 18% margin around the box

/**
 * Compute the camera position required to frame the given box, then
 * apply it. Returns the new camera distance.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Box3} box                 world-space AABB to frame
 * @param {Object} [opts]
 * @param {number} [opts.padding]          margin multiplier (>1 = looser)
 * @param {number} [opts.minDistance]      clamp lower bound
 * @param {number} [opts.bottomReserve]    fraction of frame height to reserve
 *                                         BELOW the content (e.g. 0.33 for a
 *                                         bottom-third UI overlay). The camera
 *                                         is framed as if the box were taller
 *                                         by this fraction, then aimed below
 *                                         the box center so content occupies
 *                                         the upper portion of the frame.
 * @returns {{ distance: number, target: THREE.Vector3 }}
 */
export function frameBox(camera, box, opts = {}) {
    const padding      = opts.padding      ?? DEFAULT_PADDING;
    const minDistance  = opts.minDistance  ?? 50;
    const bottomReserve = Math.max(0, Math.min(0.6, opts.bottomReserve ?? 0));

    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // Effective box height pretends extra empty space below the content
    // so the camera frames a taller region; we then aim the camera
    // BELOW the true content center, which shifts content visually up.
    const effectiveH = size.y * (1 + bottomReserve);

    const fovY = (camera.fov * Math.PI) / 180;
    const halfH = (effectiveH / 2) * padding;
    const distH = halfH / Math.tan(fovY / 2);

    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
    const halfW = (size.x / 2) * padding;
    const distW = halfW / Math.tan(fovX / 2);

    const halfD = size.z / 2;
    const distance = Math.max(distH, distW, minDistance) + halfD;

    // The aim target shifts down so the content sits above the optical
    // axis — content appears in the upper part of the frame.
    const aimYOffset = (size.y * bottomReserve) / 2;
    const target = new THREE.Vector3(center.x, center.y - aimYOffset, center.z);

    camera.position.set(target.x, target.y, target.z + distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix?.();

    return { distance, target };
}

/**
 * Frame everything in a scene that matters for the layout (i.e. ignore
 * the ReferenceSpace floor + far-points, which would otherwise distort
 * the frame outward). Pass the explicit nodes you want to include.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Object3D[]} nodes
 * @param {Object} [opts]
 */
export function frameNodes(camera, nodes, opts = {}) {
    const box = new THREE.Box3();
    for (const n of nodes) {
        if (!n) continue;
        gatherWorldBounds(n, box);
    }
    if (box.isEmpty()) return null;
    if (opts.debug) {
        console.log(`[frame] box: x[${box.min.x.toFixed(1)}..${box.max.x.toFixed(1)}] ` +
                    `y[${box.min.y.toFixed(1)}..${box.max.y.toFixed(1)}] ` +
                    `z[${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}]`);
    }
    return frameBox(camera, box, opts);
}

/**
 * Walk an Object3D subtree and union into `out` the world-space bounds
 * of every node that exposes layoutBounds() (CodeGrid, our Layout
 * containers). This avoids THREE.Box3.setFromObject's failure mode on
 * InstancedMesh, which returns the base unit-quad instead of the
 * per-instance spread.
 *
 * @param {THREE.Object3D} node
 * @param {THREE.Box3} out  accumulator (mutated)
 */
function gatherWorldBounds(node, out) {
    node.updateWorldMatrix?.(true, true);
    if (typeof node.layoutBounds === 'function') {
        const local = node.layoutBounds();
        if (local && isFinite(local.min.x) && !local.isEmpty()) {
            const world = local.clone().applyMatrix4(node.matrixWorld);
            out.union(world);
            // A Layout's own bounds already covers its children — don't
            // descend further or we'd double-count. A CodeGrid likewise
            // represents its full text extent.
            return;
        }
    }
    if (node.children) {
        for (const ch of node.children) gatherWorldBounds(ch, out);
    }
}
