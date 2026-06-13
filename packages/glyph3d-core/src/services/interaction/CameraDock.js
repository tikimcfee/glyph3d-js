/**
 * CameraDock — a camera-locked HUD bar that holds windows (code grids /
 * terminals) as live, dimensionally-scaled tiles.
 *
 * This is the L2 the AttentionManager.docks map was stubbed for. A docked
 * window is the SAME live Object3D — not a proxy or snapshot — reparented under
 * this node and scaled down via its Object3D transform. An 80×80 terminal keeps
 * its 80×80 buffer; only its `scale` shrinks, so it reads as a tidy box without
 * losing a cell. ("Shrunk dimensionally, not re-windowed.")
 *
 * How it rides the camera: this node is itself a THREE.Object3D added to the
 * scene. Each frame `update(dt, camera)` parks it a fixed `distance` ahead of
 * the camera, matching the camera's orientation — the sky-follow trick with an
 * offset. Tiles are CHILDREN, so they inherit that transform for free and the
 * whole bar travels with the view. Slot positions are laid out in dock-LOCAL
 * space (a strip near the bottom of the frame), so a `SpatialAnimator` only ever
 * animates local position/scale — the camera-follow and the slide compose.
 *
 * Reparenting uses THREE.Object3D.attach() (world-transform preserving) so a
 * window doesn't jump when it docks or releases. The window's ORIGINAL parent
 * (a ContentTree dir node for code grids, the scene for terminals) and local
 * transform are captured on lock and restored on release — we never assume the
 * scene is the home.
 *
 * State of record lives in the shared AttentionManager.docks map (passed in), so
 * command handlers and the session store read one place, not a second service.
 *
 * @typedef {Object} DockEntry
 * @property {string} id
 * @property {Object} grid        - the live Object3D (CodeGrid / TerminalGrid)
 * @property {Object|null} homeParent
 * @property {{pos:{x,y,z}, scale:number, quat:THREE.Quaternion}} home
 * @property {number} naturalH    - world height at scale 1 (for tile-scale math)
 * @property {number} slot
 * @property {THREE.Quaternion} quatTarget - orientation the tile slerps toward
 */

import * as THREE from 'three';
import { SpatialAnimator } from '../spatial/SpatialAnimator.js';

const _forward = new THREE.Vector3();

/** Walk up the parent chain to confirm an object still reaches a live Scene. */
function reachesScene(obj) {
    let o = obj;
    while (o) {
        if (o.isScene) return true;
        o = o.parent;
    }
    return false;
}

export class CameraDock extends THREE.Object3D {
    /**
     * @param {Object} [opts]
     * @param {Object} [opts.attentionManager] - shared AttentionManager (its .docks map is the record of truth)
     * @param {number} [opts.distance=40]   - world units ahead of the camera the bar sits
     * @param {number} [opts.tileFrac=0.16] - tile height as a fraction of the visible height
     * @param {number} [opts.bottomFrac=0.74] - row depth: 0 = view center, 1 = bottom edge
     * @param {'linear'|'radial'} [opts.layout='linear']
     */
    constructor({ attentionManager = null, distance = 40, tileFrac = 0.18, bottomFrac = 0.66, layout = 'linear' } = {}) {
        super();
        this.name = 'camera-dock';
        this.attentionManager = attentionManager;
        this.distance = distance;
        this.tileFrac = tileFrac;
        this.bottomFrac = bottomFrac;
        this.layoutMode = layout;

        this.animator = new SpatialAnimator();

        /** @type {Map<string, DockEntry>} locked tiles */
        this.entries = new Map();
        /** @type {Map<string, DockEntry>} tiles mid-release (kept for the slerp-home) */
        this._releasing = new Map();
        /** Identity set of docked grid objects — the camera reads this (ctx.dockTiles)
         *  to skip dock chrome in its per-frame look-distance sampling, an O(1) has()
         *  with no array allocation. @type {Set<Object>} */
        this.tiles = new Set();

        // Visible extents at `distance`, refreshed each frame from the camera.
        this._viewH = 100;
        this._viewW = 160;

        // The dock itself is structural — invisible, never picked. Tiles carry the pixels.
        this.renderOrder = 0;
    }

    // ===================== membership =====================

    /** @param {string} id @returns {boolean} */
    has(id) { return this.entries.has(id); }

    /** @returns {Array<{id:string, slot:number, layout:string}>} */
    list() {
        return [...this.entries.values()].map((e) => ({ id: e.id, slot: e.slot, layout: this.layoutMode }));
    }

    /**
     * The HOME position a docked window will return to on release (in its home
     * parent's space) — NOT its current tile-local position. Persistence reads this
     * so a docked window's saved position is its world home, not the tile coordinate.
     * @param {string} id
     * @returns {{x:number,y:number,z:number}|null}
     */
    homePosition(id) {
        const e = this.entries.get(id);
        return e ? { x: e.home.pos.x, y: e.home.pos.y, z: e.home.pos.z } : null;
    }

    /**
     * Dock a window: capture its home, reparent it under the bar (world-preserving),
     * and animate it into its slot at tile scale.
     * @param {string} id  registry id
     * @param {Object} grid live Object3D with getBounds()
     * @returns {boolean}
     */
    lock(id, grid) {
        if (!grid || this.entries.has(id)) return false;

        // World bounds BEFORE reparent/scale: tile scale is computed against the
        // window's natural size (getBounds is world-space, includes current scale).
        const b = grid.getBounds?.();
        const homeScale = grid.scale.x || 1;
        const hasBounds = b && !b.isEmpty?.();
        const worldH = hasBounds ? (b.max.y - b.min.y) : 10;

        // Grids are top-anchored (origin at top-left; content flows down/right), so the
        // origin is NOT the visual center. Capture the origin→bounds-center vector in the
        // window's own units (scale 1) so _relayout can place the tile's CENTER in its slot
        // at any scale: targetOrigin = slotCenter − centerOffset·tileScale.
        let centerOffset = { x: 0, y: 0, z: 0 };
        if (hasBounds) {
            const origin = grid.getWorldPosition(new THREE.Vector3());
            const center = b.getCenter(new THREE.Vector3());
            centerOffset = {
                x: (center.x - origin.x) / homeScale,
                y: (center.y - origin.y) / homeScale,
                z: (center.z - origin.z) / homeScale,
            };
        }

        const entry = {
            id,
            grid,
            homeParent: grid.parent || null,
            home: {
                pos: { x: grid.position.x, y: grid.position.y, z: grid.position.z },
                scale: homeScale,
                quat: grid.quaternion.clone(),
            },
            naturalH: Math.max(worldH / homeScale, 1e-3),
            centerOffset,
            slot: this.entries.size,
            quatTarget: new THREE.Quaternion(),
        };

        // Reparent preserving world transform — the tile stays put for this frame,
        // then the animator slides it to its slot while the bar carries it cameraward.
        this.attach(grid);

        // Register as chrome so the camera's dynamic-speed / fit-all sampling skips it
        // (a tile pinned ahead of the camera would otherwise brake every move).
        this.tiles.add(grid);

        this.entries.set(id, entry);
        this.attentionManager?.docks?.set(id, {
            anchor: 'camera',
            offset: { slot: entry.slot },
            ts: (typeof performance !== 'undefined' ? performance.now() : 0),
        });

        this._relayout();
        return true;
    }

    /**
     * Undock a window: reparent it back to its home (world-preserving) and animate
     * it back to its home transform. Re-packs the remaining tiles.
     * @param {string} id
     * @returns {boolean}
     */
    release(id) {
        const e = this.entries.get(id);
        if (!e) return false;

        this.entries.delete(id);
        this.tiles.delete(e.grid); // back to world content for the camera the moment it heads home
        this.attentionManager?.docks?.delete(id);

        // Home parent may have been pruned (file closed while docked) — fall back to
        // the scene (this bar's own parent) so the window is never orphaned.
        const parent = (e.homeParent && reachesScene(e.homeParent)) ? e.homeParent : this.parent;
        (parent || this.parent)?.attach?.(e.grid);

        e.quatTarget.copy(e.home.quat);
        this._releasing.set(id, e);

        this.animator.animateTo(e.grid, 'position', e.home.pos, { duration: 0.45 });
        this.animator.animateTo(e.grid, 'scale', e.home.scale, {
            duration: 0.45,
            onComplete: () => { this._releasing.delete(id); },
        });

        this._relayout();
        return true;
    }

    /**
     * Dock if loose, release if docked.
     * @param {string} id @param {Object} grid @returns {'locked'|'released'}
     */
    toggle(id, grid) {
        if (this.entries.has(id)) { this.release(id); return 'released'; }
        this.lock(id, grid); return 'locked';
    }

    /** @param {'linear'|'radial'} mode */
    setLayout(mode) {
        if (mode !== 'linear' && mode !== 'radial') return false;
        this.layoutMode = mode;
        this._relayout();
        return true;
    }

    // ===================== layout & tick =====================

    /** Re-pack every docked tile into a slot and animate it there. */
    _relayout() {
        const tiles = [...this.entries.values()];
        const n = tiles.length;
        if (n === 0) return;

        const tileH = this._viewH * this.tileFrac;
        const rowY = -this._viewH * 0.5 * this.bottomFrac; // tile-CENTER row

        // Per-tile scale (uniform height) and resulting world width (centerOffset.x is
        // the half-width in window units, so width = 2·|cx|·scale).
        const scales = tiles.map((e) => tileH / e.naturalH);
        const widths = tiles.map((e, i) => Math.max(2 * Math.abs(e.centerOffset.x) * scales[i], tileH * 0.4));

        // Slot CENTERS: pack left→right with a gap, centered on x=0. Radial bends the
        // same packed centers onto a gentle downward arc.
        const gap = tileH * 0.3;
        const totalW = widths.reduce((a, w) => a + w, 0) + gap * (n - 1);
        const centers = [];
        let cx = -totalW * 0.5;
        for (let i = 0; i < n; i++) { centers.push(cx + widths[i] * 0.5); cx += widths[i] + gap; }

        tiles.forEach((e, i) => {
            e.slot = i;
            const scale = scales[i];
            let sx = centers[i];
            let sy = rowY;
            if (this.layoutMode === 'radial' && n > 1) {
                const half = totalW * 0.5;
                const t = half > 0 ? sx / half : 0;       // -1..1 across the bar
                const dip = this._viewH * 0.10;            // how far the ends rise
                sy = rowY + dip * (t * t);                 // parabola: ends up, middle low
            }

            // Place the tile's CENTER at the slot; origin = center − centerOffset·scale.
            const target = {
                x: sx - e.centerOffset.x * scale,
                y: sy - e.centerOffset.y * scale,
                z: 0 - e.centerOffset.z * scale,
            };
            this.animator.animateTo(e.grid, 'position', target, { duration: 0.4 });
            this.animator.animateTo(e.grid, 'scale', scale, { duration: 0.4 });
            e.quatTarget.identity(); // square up to the bar (which faces the camera)

            const d = this.attentionManager?.docks?.get(e.id);
            if (d) d.offset = { slot: i };
        });
    }

    /**
     * Per-frame: park the bar ahead of the camera, advance animations, and slerp
     * each tile toward its target orientation. Call from the render loop.
     * @param {number} dt seconds
     * @param {Object} camera active THREE camera
     */
    update(dt, camera) {
        if (camera) {
            const fov = (camera.fov || 70) * Math.PI / 180;
            this._viewH = 2 * this.distance * Math.tan(fov * 0.5);
            this._viewW = this._viewH * (camera.aspect || 1.6);

            _forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
            this.position.copy(camera.position).addScaledVector(_forward, this.distance);
            this.quaternion.copy(camera.quaternion);
        }

        this.animator.update(dt);

        const rate = Math.min(1, dt * 8);
        for (const e of this.entries.values()) e.grid.quaternion.slerp(e.quatTarget, rate);
        for (const e of this._releasing.values()) e.grid.quaternion.slerp(e.quatTarget, rate);
    }

    dispose() {
        this.animator.dispose();
        this.entries.clear();
        this._releasing.clear();
        this.tiles.clear();
    }
}

export default CameraDock;
