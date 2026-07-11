/**
 * WorldLayout — the top-level spatial system: the major application groupings (the file tree, the
 * agent-trail cluster, later the demo output, …) as SIBLINGS on a shared floor. It is a bottom-aligned
 * HStack of each grouping's root, rested on the world floor — the same bounds-object + controller pattern
 * the file tree and the trail already use, lifted one level so the WHOLE application is one layout.
 *
 * A grouping registers its root (with a `bounds` function, since a plain root has no `layoutBounds()`) and
 * notifies the world when its footprint changes; the world re-spaces the row and re-grounds it. Groupings
 * keep their OWN internal layout + floor-rest untouched — under the world that self-rest simply agrees with
 * the stack's shared baseline (both ground to the floor), so nothing fights.
 *
 * "Layouts everywhere": the file tree is a scheme over file/dir bounds-nodes; the trail cluster is a scheme
 * over corridor bounds-nodes; the world is a stack over grouping bounds-nodes. Same contract at every level.
 */

import * as THREE from 'three';
import { HStack } from './layouts/StackContainer.js';

export const WORLD_DEFAULTS = {
    gap: 200,     // spacing between adjacent groupings along the floor (X)
    floorY: 0,    // world floor the whole cluster's bottom rests on
};

export default class WorldLayout {
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.cfg = { ...WORLD_DEFAULTS, ...opts };
        // align 0 → every grouping's BOTTOM edge lands on a shared baseline (a floor); the row centers on X.
        this.root = new HStack({ align: 0, spacing: this.cfg.gap });
        this.root.name = 'world';
        this.scene.add(this.root);
        this._groups = new Map();   // id -> grouping root Object3D, in arrangement order
    }

    /**
     * Register a grouping's root as a world sibling. `bounds()` returns its LOCAL content box so the stack
     * can measure it (a plain grouping root has no layoutBounds()). Reparents the node from the scene under
     * the world root — the relayout below places it — and re-lays the whole world.
     * @param {string} id stable grouping id (files, trails, …)
     * @param {THREE.Object3D} node the grouping's root
     * @param {() => THREE.Box3} [bounds] the grouping's local content box (for the stack to measure)
     */
    register(id, node, bounds) {
        if (typeof bounds === 'function') node.layoutBounds = bounds;
        this._groups.set(id, node);
        this.root.add(node);   // reparent scene → world; world-preserving isn't needed (relayout re-places it)
        this.relayout();
        return this;
    }

    /** Drop a grouping from the world (leaves the node detached; caller disposes it). */
    unregister(id) {
        const node = this._groups.get(id);
        if (!node) return false;
        this._groups.delete(id);
        this.root.remove(node);
        this.relayout();
        return true;
    }

    /**
     * Re-space the groupings along the floor and re-ground the world. Each grouping wires its own onRelayout
     * to this, so the arrangement re-flows as a tree loads or a trail streams. Idempotent.
     */
    relayout() {
        if (this._groups.size === 0) return;
        this.root.layout();     // bottom-aligned HStack: groupings side by side on a shared baseline
        this._restOnFloor();
    }

    /** Lift the world so the whole cluster's bottom sits on cfg.floorY. Idempotent (once grounded → +0). */
    _restOnFloor() {
        const wb = this.root.getBounds();
        if (!wb.isEmpty()) this.root.position.y += (this.cfg.floorY - wb.min.y);
        this.root.updateMatrixWorld(true);
    }

    /** Persisted state — the grouping ORDER (placement is otherwise deterministic from it). */
    getState() {
        return { order: [...this._groups.keys()] };
    }

    /** Restore the saved grouping order; unknown ids are ignored, un-saved groupings keep their slot at the
     *  end. Re-adding a child moves it to the end, so re-adding in order reorders the row. */
    applyState(state) {
        if (!state || !Array.isArray(state.order)) return false;
        const known = new Set(this._groups.keys());
        const ordered = state.order.filter((id) => known.has(id));
        for (const id of known) if (!ordered.includes(id)) ordered.push(id);
        const remap = new Map();
        for (const id of ordered) { remap.set(id, this._groups.get(id)); this.root.add(this._groups.get(id)); }
        this._groups = remap;
        this.relayout();
        return true;
    }

    dispose() {
        this.scene.remove(this.root);
        this._groups.clear();
    }
}
