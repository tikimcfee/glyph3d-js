/**
 * measure — derive an axis-aligned bounding box for a layout child.
 *
 * Layout containers need to know "how big are you?" to place siblings
 * relative to each other. We support two interfaces, in priority order:
 *
 *   1. obj.layoutBounds() → Box3   — explicit, container-friendly opt-in
 *   2. THREE.Box3.setFromObject(obj) → world-space AABB derived from
 *      the object's rendered meshes
 *
 * Layout containers should call layout() on their children BEFORE
 * measuring — children may need a layout pass to position their own
 * subtree before their bounds are meaningful.
 *
 * All bounds are returned in the *local* space of the child (i.e. as
 * if the child were at the origin), so containers can position the
 * child by setting `child.position` directly without double-counting.
 */

import * as THREE from 'three';

const SCRATCH_BOX = new THREE.Box3();

/**
 * Measure an Object3D's local-space bounds.
 *
 * If the object exposes layoutBounds() we trust it. Otherwise we
 * temporarily zero its transform, ask THREE for the world-space box,
 * and restore the transform. (Pulling the transform out is cheaper
 * than asking THREE for a child-relative box on every measure.)
 *
 * @param {THREE.Object3D} obj
 * @returns {THREE.Box3}
 */
export function measureLocalBounds(obj) {
    if (!obj) return new THREE.Box3();
    if (typeof obj.layoutBounds === 'function') {
        return obj.layoutBounds();
    }

    // Save + zero the transform so setFromObject's world-AABB is in
    // the object's own coordinate space. We need to updateMatrixWorld
    // *forced* since some of obj's children may be lazily updated.
    const px = obj.position.x, py = obj.position.y, pz = obj.position.z;
    const rx = obj.rotation.x, ry = obj.rotation.y, rz = obj.rotation.z;
    const sx = obj.scale.x,    sy = obj.scale.y,    sz = obj.scale.z;
    obj.position.set(0, 0, 0);
    obj.rotation.set(0, 0, 0);
    obj.scale.set(1, 1, 1);
    obj.updateMatrixWorld(true);

    const box = new THREE.Box3();
    box.setFromObject(obj);

    // Restore.
    obj.position.set(px, py, pz);
    obj.rotation.set(rx, ry, rz);
    obj.scale.set(sx, sy, sz);
    obj.updateMatrixWorld(true);

    // setFromObject returns +Infinity bounds for empty hierarchies —
    // collapse that to a zero box so downstream math doesn't NaN.
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
        return new THREE.Box3(
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 0),
        );
    }
    return box;
}

/**
 * Convenience: get the {width, height, depth} of a child as plain numbers.
 * @param {THREE.Object3D} obj
 * @returns {{ width: number, height: number, depth: number }}
 */
export function measureSize(obj) {
    const b = measureLocalBounds(obj);
    return {
        width:  b.max.x - b.min.x,
        height: b.max.y - b.min.y,
        depth:  b.max.z - b.min.z,
    };
}
