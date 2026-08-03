import * as THREE from 'three';

/**
 * BoundedObject3D — the on-demand bounds contract for grid primitives.
 *
 * One thin base that lifts the (previously triplicated) world-bounds derivation
 * into a single place. It is deliberately stateless about the world box:
 * getBounds() recomputes the world AABB FRESH on every call (local content box ×
 * current matrixWorld). There is NO validity cache, NO dirty flag, and NO
 * transform observation here — by design.
 *
 * Why on-demand rather than cached/observed (the conclusion of a long design arc,
 * proved against the real consumers and the codebase's own rationale):
 *   - The local content box is already content-cached by the subclass
 *     (getLocalBounds()), so getBounds() is cheap: copy a box + transform 8 corners.
 *   - World bounds depend on the full matrixWorld chain (every ancestor transform).
 *     A world-bounds cache would have to observe that whole chain to stay correct;
 *     the consumers (e.g. OcclusionCuller sampling on demand) already call getBounds
 *     exactly when they need a current answer, so recomputing is both correct and
 *     simplest. See CodeGrid.layoutBounds()'s note on why setFromObject is unusable
 *     for instanced content.
 *
 * The Measurable contract — three boxes, three frames:
 *   - getLocalBounds()  → local content AABB (in the object's OWN frame, no world
 *                         transform). Subclasses MUST implement this. It is the
 *                         orientation-stable box and is expected to be content-cached
 *                         by the subclass (recomputed only when content changes).
 *   - getBounds(target) → world AABB, recomputed on demand here from getLocalBounds()
 *                         applied by the current matrixWorld. Provided by this base.
 *   - layoutBounds()    → local box suited to composable layout containers. Optional;
 *                         subclass-provided where layout needs it.
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
     * World-space AABB of this object's content, recomputed fresh on every call.
     *
     * Formula (behavior-preserving — the box the old per-grid getBounds produced):
     *   updateWorldMatrix(true, false); getLocalBounds().applyMatrix4(matrixWorld)
     *
     * matrixWorld is refreshed first because getBounds is called from pointer /
     * useFrame paths that run before r3f renders, so the matrix can otherwise lag a
     * just-applied move.
     *
     * The default target is a reusable scratch Box3 — that is an output buffer, NOT a
     * cache of the world box: it is overwritten from scratch every call. Callers must
     * not hold the returned box across calls. Pass your own `target` to opt out.
     *
     * @param {THREE.Box3} [target] - Box to write into (default: shared scratch)
     * @returns {THREE.Box3} Bounding box in world coordinates
     */
    getBounds(target = this._worldBoundsScratch || (this._worldBoundsScratch = new THREE.Box3())) {
        this.updateWorldMatrix(true, false);
        target.copy(this.getLocalBounds());
        if (target.isEmpty()) return target;
        target.applyMatrix4(this.matrixWorld); // world box re-derived from current matrix
        return target;
    }
}
