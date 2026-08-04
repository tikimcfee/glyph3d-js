import * as THREE from 'three';

const _origin = new THREE.Vector3(0, 0, 0);

/**
 * Exact 16-element equality of two Matrix4s. Three.js mutates `matrixWorld` IN PLACE
 * (multiplyMatrices writes into the same Float32Array), so a reference compare is
 * always-true and useless — only a value sweep detects a real move. No epsilon: the
 * matrix multiply is deterministic, so an unchanged chain reproduces identical bits.
 * @param {THREE.Matrix4} a @param {THREE.Matrix4} b
 */
function _matrixEquals(a, b) {
    const ae = a.elements, be = b.elements;
    for (let i = 0; i < 16; i++) if (ae[i] !== be[i]) return false;
    return true;
}

/**
 * BoundedObject3D — the on-demand bounds contract for grid primitives.
 *
 * One thin base that lifts the (previously triplicated) world-bounds derivation
 * into a single place. The WORLD box is CACHED, keyed on two INTERNAL validity
 * signals — no external dirty wiring, no observation of the parent chain:
 *   - content: `_extentVersion`, bumped inside refreshExtent() when the local box
 *     actually changes (its dirtiness gate already detects that moment);
 *   - transform: a value snapshot of `matrixWorld` (Three.js mutates it in place, so
 *     a reference check is useless — see _matrixEquals).
 * getBounds() recomputes the world AABB only when one of those moved; otherwise it
 * returns the cache. matrixWorld reflects the WHOLE ancestor chain, so any move —
 * self or a parent — changes its 16 values and invalidates the cache, without the
 * cache having to observe that chain.
 *
 * Why a cache now, after "on-demand beat the cache": that held because nothing
 * tracked WHEN the world box went stale. The two keys are both internal to this
 * object and complete (content version + own matrix), so the cache cannot lie — it
 * recomputes the instant either input changes. See CodeGrid.layoutBounds()'s note on
 * why setFromObject is unusable for instanced content.
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
     *
     * Bumps `_extentVersion` on a real change — the CONTENT half of getBounds()'s
     * world-box cache key (the transform half is the matrixWorld snapshot).
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
        this._extentVersion = (this._extentVersion || 0) + 1;   // content changed → invalidate getBounds' world-box cache
        return box;
    }

    /**
     * World-space AABB of this object's content.
     *
     * CACHED on two internal validity keys — recomputed only when one moved:
     *   - content: `this._extentVersion` (bumped by refreshExtent on a real box change),
     *   - transform: a value snapshot of `matrixWorld` (any move — self or ancestor —
     *     changes its 16 values; compared by _matrixEquals, since Three.js mutates it
     *     in place and a reference check would always pass).
     * On a still/flight frame getBounds() is O(1): updateWorldMatrix (so the matrix is
     * current to compare), an int compare, a 16-float compare, then return the cache —
     * the 8-corner box transform is skipped. matrixWorld is refreshed first because
     * getBounds is called from pointer / useFrame paths that run before r3f renders.
     *
     * The local Extent (boundingBox/Sphere) is refreshed here too, so consumers that
     * poll the world box keep the object-level Extent current for free.
     *
     * The default target is a reusable scratch Box3 — an OUTPUT buffer, not the cache
     * (the cache lives in _worldBoxCache). Callers must not hold the returned box
     * across calls. Pass your own `target` to opt out.
     *
     * @param {THREE.Box3} [target] - Box to write into (default: shared scratch)
     * @returns {THREE.Box3} Bounding box in world coordinates
     */
    getBounds(target = this._worldBoundsScratch || (this._worldBoundsScratch = new THREE.Box3())) {
        this.updateWorldMatrix(true, false);
        const local = this.refreshExtent();          // refreshes the Extent; bumps _extentVersion on a content change
        const cache = this._worldBoxCache || (this._worldBoxCache = new THREE.Box3());
        if (this._worldBoxExtentVersion === this._extentVersion
            && this._worldBoxMatrix && _matrixEquals(this._worldBoxMatrix, this.matrixWorld)) {
            return target.copy(cache);               // both inputs unchanged → cache valid, skip the box transform
        }
        cache.copy(local);
        if (!cache.isEmpty()) cache.applyMatrix4(this.matrixWorld);
        (this._worldBoxMatrix || (this._worldBoxMatrix = new THREE.Matrix4())).copy(this.matrixWorld);
        this._worldBoxExtentVersion = this._extentVersion;
        return target.copy(cache);
    }
}
