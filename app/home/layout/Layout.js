/**
 * Layout — base class for layout containers.
 *
 * Extends THREE.Object3D so layouts compose into a scene graph naturally:
 *
 *     scene.add(Center(VStack({ gap: 12 }, [a, b, c])));
 *     root.layout();
 *
 * Subclasses override `_layoutSelf()` to position their direct children.
 * The public `layout()` method drives a recursive pass: it first calls
 * `layout()` on every layout-aware descendant, then runs the local pass.
 * Children that aren't Layouts are left alone — they're treated as
 * already-positioned content (e.g. CodeGrid clusters).
 *
 * A Layout also exposes `layoutBounds()` so its own parent can measure
 * it without re-traversing every leaf. After `_layoutSelf()` runs we
 * cache the AABB of all our children.
 */

import * as THREE from 'three';
import { measureLocalBounds } from './measure.js';

const _scratchBox = new THREE.Box3();

export default class Layout extends THREE.Object3D {
    constructor() {
        super();
        /** @type {THREE.Box3 | null} */
        this._bounds = null;
    }

    /**
     * Run a layout pass over this subtree.
     * Recurses into children first (so their bounds are valid when we
     * measure them), then positions our own children.
     */
    layout() {
        for (const child of this.children) {
            if (child instanceof Layout) child.layout();
        }
        this._layoutSelf();
        this._recomputeBounds();
        return this;
    }

    /** Override in subclasses. Default: no-op. */
    _layoutSelf() {}

    /**
     * Cache the AABB of our laid-out children, in our local space.
     * @private
     */
    _recomputeBounds() {
        const out = new THREE.Box3();
        out.makeEmpty();
        for (const child of this.children) {
            const childBox = measureLocalBounds(child);
            // Shift childBox by child.position to get child-in-parent coords.
            _scratchBox.copy(childBox);
            _scratchBox.min.add(child.position);
            _scratchBox.max.add(child.position);
            out.union(_scratchBox);
        }
        if (out.isEmpty()) {
            out.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
        }
        this._bounds = out;
    }

    /**
     * Provide our cached bounds to outer layouts that ask. Falls back to
     * the generic measurement if layout() hasn't been called yet.
     * @returns {THREE.Box3}
     */
    layoutBounds() {
        if (this._bounds) return this._bounds.clone();
        return measureLocalBounds(this);
    }
}
