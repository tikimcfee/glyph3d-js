import * as THREE from 'three';

const _origin = new THREE.Vector3(0, 0, 0);

/**
 * BoundedObject3D — the bounds contract for grid primitives.
 *
 * One thin base that lifts the (previously triplicated) world-bounds derivation into a
 * single place. There is no cache here, and there is nothing to invalidate: every bounded
 * object's LOCAL box is a closed form over state it already holds — a CodeGrid's is the
 * fold's extent (core/foldGeometry.foldExtent, O(1) in the line table), a TerminalGrid's
 * and a FrameGrid's are their cell dimensions — so recomputing it costs less than deciding
 * whether a cached copy is still true. The world box is then eight corners through
 * `matrixWorld`.
 *
 * (This used to cache the world box against a content version plus a 16-float matrix
 * snapshot. That machinery existed because the local box was once an O(glyphs) walk over
 * a position buffer. It isn't, so the machinery isn't either.)
 *
 * The Measurable contract — three boxes, three frames:
 *   - getLocalBounds()  → local content AABB (in the object's OWN frame, no world
 *                         transform). Subclasses MUST implement this. It is the
 *                         orientation-stable box.
 *   - getBounds(target) → world AABB, derived here from getLocalBounds() applied by the
 *                         current matrixWorld. Provided by this base.
 *   - layoutBounds()    → local box suited to composable layout containers. Optional;
 *                         subclass-provided where layout needs it.
 *
 * The Extent — a Three.js-standard `boundingBox` + `boundingSphere` in LOCAL space, so
 * every bounded object is a Three.js bounding-volume citizen: one bound, sourced from
 * getLocalBounds(). Note this is the OBJECT-level extent; the renderer culls off-screen
 * DRAWS via the field mesh's own `geometry.boundingSphere` (GlyphField.setLayoutExtent).
 *
 * @abstract getLocalBounds
 */
export default class BoundedObject3D extends THREE.Object3D {
    /**
     * Local content AABB, in this object's own frame (no world transform).
     * Subclasses MUST override. The base getBounds() builds the world box from it.
     * @abstract
     * @returns {THREE.Box3} Local-space bounds (reused; do not hold across calls)
     */
    getLocalBounds() {
        throw new Error(
            `${this.constructor.name} must implement getLocalBounds() — the Measurable contract`,
        );
    }

    /**
     * Refresh the object's Three.js-standard Extent (`boundingBox` + `boundingSphere`)
     * from getLocalBounds(). Local space — matching Three.js's geometry.boundingSphere
     * convention (consumers apply matrixWorld for a world result, as getBounds does).
     * @returns {THREE.Box3} the local Extent box (reused; do not hold across calls)
     */
    refreshExtent() {
        const local = this.getLocalBounds();
        const box = this._extentBox || (this._extentBox = new THREE.Box3());
        const sphere = this._extentSphere || (this._extentSphere = new THREE.Sphere());
        box.copy(local);
        if (box.isEmpty()) sphere.set(_origin, 0);
        else box.getBoundingSphere(sphere);
        this.boundingBox = box;
        this.boundingSphere = sphere;
        return box;
    }

    /**
     * World-space AABB of this object's content: the local Extent through the current
     * `matrixWorld`. matrixWorld is refreshed first because getBounds is called from
     * pointer / useFrame paths that run before r3f renders.
     *
     * The default target is a reusable scratch Box3 — callers must not hold the returned
     * box across calls. Pass your own `target` to opt out.
     *
     * @param {THREE.Box3} [target] - Box to write into (default: shared scratch)
     * @returns {THREE.Box3} Bounding box in world coordinates
     */
    getBounds(target = this._worldBoundsScratch || (this._worldBoundsScratch = new THREE.Box3())) {
        this.updateWorldMatrix(true, false);
        target.copy(this.refreshExtent());
        if (!target.isEmpty()) target.applyMatrix4(this.matrixWorld);
        return target;
    }
}
