import * as THREE from 'three';

const _origin = new THREE.Vector3(0, 0, 0);

/**
 * BoundedObject3D — the on-demand bounds contract for grid primitives.
 *
 * One thin base that lifts the (previously triplicated) world-bounds derivation
 * into a single place. It is deliberately stateless about the WORLD box:
 * getBounds() recomputes the world AABB FRESH on every call (local content box ×
 * current matrixWorld). There is NO validity cache, NO dirty flag, and NO
 * transform observation for the world box — by design.
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
 * The Extent — a Three.js-standard `boundingBox` + `boundingSphere` in LOCAL space,
 * the single source of truth for the object's size:
 *   - The renderer culls off-screen DRAWS via the field mesh's geometry.boundingSphere
 *     (the per-instance extent, written in GlyphField). THIS is the OBJECT-level
 *     Extent — the bound the layout measures, picking/occlusion frames, and (under
 *     ECS) the `Extent` component IS. Every bounded object is a Three.js bounding-
 *     volume citizen: one bound, sourced from getLocalBounds(), refreshed on read.
 *   - `refreshExtent()` derives it from getLocalBounds(); getBounds() refreshes it
 *     alongside the world box so the consumers that already poll getBounds (the
 *     occlusion culler, the layout's measure pass) keep it current for free.
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
     *
     * DIRTINESS-GATED: the Extent is LOCAL, so it changes ONLY when the content box
     * changes — a transform move (the common per-frame case) leaves it untouched.
     * So if the local box hasn't moved since the last refresh, the sphere is still
     * valid and we skip the `getBoundingSphere` recompute: a 6-float equality check,
     * not a fresh sphere derivation. getBounds() runs on a hot path (the camera
     * soft-bounds sweep calls it per surface per frame), so the full work fires only
     * on actual content change. `boundingBox`/`boundingSphere` are (re)assigned every
     * call — cheap pointer writes that keep the properties current for any reader.
     * @returns {THREE.Box3} the local Extent box (reused; do not hold across calls)
     */
    refreshExtent() {
        const local = this.getLocalBounds();
        const box = this._extentBox || (this._extentBox = new THREE.Box3());
        const sphere = this._extentSphere || (this._extentSphere = new THREE.Sphere());
        this.boundingBox = box;
        this.boundingSphere = sphere;
        // Unchanged local box ⇒ sphere still valid. Skip the recompute (value-equality
        // on the 6 extents; robust whether or not the subclass reuses its box object).
        if (this._extentValid
            && local.min.x === box.min.x && local.min.y === box.min.y && local.min.z === box.min.z
            && local.max.x === box.max.x && local.max.y === box.max.y && local.max.z === box.max.z) {
            return box;
        }
        box.copy(local);
        if (box.isEmpty()) sphere.set(_origin, 0);
        else box.getBoundingSphere(sphere);
        this._extentValid = true;
        return box;
    }

    /**
     * World-space AABB of this object's content, recomputed fresh on every call.
     *
     * Formula (behavior-preserving — the box the old per-grid getBounds produced):
     *   updateWorldMatrix(true, false); getLocalBounds().applyMatrix4(matrixWorld)
     *
     * matrixWorld is refreshed first because getBounds is called from pointer /
     * useFrame paths that run before r3f renders, so the matrix can otherwise lag a
     * just-applied move. The local Extent (boundingBox/Sphere) is refreshed here too,
     * so every consumer that polls the world box keeps the object-level Extent current
     * for free.
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
        const local = this.refreshExtent();          // keep the object Extent fresh alongside
        target.copy(local);
        if (target.isEmpty()) return target;
        target.applyMatrix4(this.matrixWorld); // world box re-derived from current matrix
        return target;
    }
}
