/**
 * GridVirtualizer — frustum-based scene graph virtualization for CodeGrids.
 *
 * At 1500+ grids, rendering every grid every frame is wasteful: most are
 * off-screen. The virtualizer adds/removes grids from the Three.js scene
 * based on camera frustum intersection, eliminating draw calls for
 * invisible grids without touching the rendering pipeline.
 *
 * Usage:
 *   const virtualizer = new GridVirtualizer(scene, camera);
 *   virtualizer.register(grid);          // after grid is positioned
 *   // in animate loop:
 *   virtualizer.update();                // before renderer.render()
 *
 * CodeGrid extends THREE.Object3D, so scene.add/remove works directly.
 * Grid GPU resources remain allocated — this is draw-call elimination,
 * not memory reclamation. For memory savings, pair with unloadContent().
 */

import * as THREE from 'three';

export default class GridVirtualizer {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {Object} [options]
     * @param {number} [options.budget=500] - Max simultaneously visible grids
     * @param {number} [options.hysteresis=50] - World-unit margin before removing a grid
     *   that just left the frustum. Prevents popping during small camera movements.
     */
    constructor(scene, camera, { budget = Infinity, hysteresis = 50 } = {}) {
        this.scene = scene;
        this.camera = camera;
        this.budget = budget;
        this.hysteresis = hysteresis;

        /** @type {Map<CodeGrid, {bounds: THREE.Box3, active: boolean, distance: number}>} */
        this._entries = new Map();

        /** @type {Set<CodeGrid>} grids currently in the scene */
        this._active = new Set();

        // Reusable scratch objects (zero-alloc per frame)
        this._frustum = new THREE.Frustum();
        this._projScreenMatrix = new THREE.Matrix4();
        this._camPos = new THREE.Vector3();

        // Dirty flag: force next update to run fully (set by register/unregister)
        this._dirty = false;

        // Throttle: don't re-evaluate every frame if camera hasn't moved much
        this._lastCamX = NaN;
        this._lastCamY = NaN;
        this._lastCamZ = NaN;
        this._frameSkip = 0;

        this._stats = { active: 0, total: 0, lastUpdateMs: 0 };
    }

    /**
     * Register a grid for virtualization. Call after the grid is positioned
     * and flushed (so getBounds() returns valid world-space Box3).
     * The grid is NOT automatically added to the scene — call update() to
     * evaluate visibility.
     * @param {CodeGrid} grid
     */
    register(grid) {
        if (this._entries.has(grid)) return;
        // Ensure matrixWorld is current before computing world-space bounds
        grid.updateWorldMatrix(true, false);
        const bounds = grid.getBounds();
        // Mark as active if the grid is already in the scene (has a parent).
        // This is critical — grids added via scene.add() before registration
        // must be tracked as active, otherwise the virtualizer never removes them.
        const alreadyInScene = grid.parent != null;
        if (alreadyInScene) this._active.add(grid);
        this._entries.set(grid, { bounds, active: alreadyInScene, distance: Infinity });
        this._dirty = true; // force next update() to run fully (bypass movement check)
    }

    /**
     * Unregister a grid. Removes from scene if active.
     * @param {CodeGrid} grid
     */
    unregister(grid) {
        const entry = this._entries.get(grid);
        if (!entry) return;
        if (entry.active) {
            this.scene.remove(grid);
            this._active.delete(grid);
        }
        this._entries.delete(grid);
    }

    /**
     * Register multiple grids at once.
     * @param {CodeGrid[]} grids
     */
    registerAll(grids) {
        for (const g of grids) this.register(g);
    }

    /**
     * Refresh a grid's cached bounds (call after layout changes).
     * @param {CodeGrid} grid
     */
    refreshBounds(grid) {
        const entry = this._entries.get(grid);
        if (entry) {
            grid.updateWorldMatrix(true, false);
            entry.bounds = grid.getBounds();
        }
    }

    /**
     * Refresh bounds for all registered grids.
     */
    refreshAllBounds() {
        for (const [grid, entry] of this._entries) {
            grid.updateWorldMatrix(true, false);
            entry.bounds = grid.getBounds();
        }
    }

    /**
     * Evaluate visibility and add/remove grids from the scene.
     * Call once per frame in the animation loop, before renderer.render().
     */
    update() {
        const t0 = performance.now();

        // Quick check: has the camera moved enough to warrant re-evaluation?
        const cp = this.camera.position;
        const dx = cp.x - this._lastCamX;
        const dy = cp.y - this._lastCamY;
        const dz = cp.z - this._lastCamZ;
        const moved = dx * dx + dy * dy + dz * dz;

        // Skip re-evaluation if camera barely moved (< 0.01 world units)
        // but always evaluate at least every 10 frames, or if dirty (new registrations)
        if (!this._dirty && moved < 0.0001 && this._frameSkip < 10) {
            this._frameSkip++;
            return;
        }
        this._dirty = false;
        this._frameSkip = 0;
        this._lastCamX = cp.x;
        this._lastCamY = cp.y;
        this._lastCamZ = cp.z;

        // Ensure camera world matrix is current — we run before renderer.render()
        // which is where Three.js normally updates matrixWorld/matrixWorldInverse.
        // Without this, the frustum uses the previous frame's camera transform.
        // NOTE: do NOT call updateProjectionMatrix() here — IDEShell._onEditorResize()
        // sets the correct aspect ratio from the editor area, not window dimensions.
        this.camera.updateMatrixWorld();

        // Build frustum from camera
        this._projScreenMatrix.multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse
        );
        this._frustum.setFromProjectionMatrix(this._projScreenMatrix);
        this._camPos.copy(cp);

        // Score each grid
        const visible = [];
        for (const [grid, entry] of this._entries) {
            // User-hidden grids (minimized, group.hide) must not be added to scene
            if (grid.userData?._userHidden) {
                if (entry.active) {
                    this.scene.remove(grid);
                    entry.active = false;
                    this._active.delete(grid);
                }
                continue;
            }

            // Drag-pinned grids stay in scene regardless of frustum
            if (grid.userData?._dragPinned) {
                if (!entry.active) {
                    this.scene.add(grid);
                    entry.active = true;
                    this._active.add(grid);
                }
                continue;
            }

            const inFrustum = this._frustum.intersectsBox(entry.bounds);

            if (inFrustum) {
                entry.distance = entry.bounds.distanceToPoint(this._camPos);
                visible.push({ grid, entry });
            } else if (entry.active && this.hysteresis > 0) {
                // Hysteresis: keep recently-visible grids a bit longer
                const dist = entry.bounds.distanceToPoint(this._camPos);
                if (dist < this.hysteresis) {
                    entry.distance = dist;
                    visible.push({ grid, entry });
                    continue;
                }
                // Remove from scene
                this.scene.remove(grid);
                entry.active = false;
                this._active.delete(grid);
            } else if (entry.active) {
                // No hysteresis, remove immediately
                this.scene.remove(grid);
                entry.active = false;
                this._active.delete(grid);
            }
        }

        // Sort by distance (closest first) and apply budget
        if (visible.length > this.budget) {
            visible.sort((a, b) => a.entry.distance - b.entry.distance);
        }

        const limit = Math.min(visible.length, this.budget);
        const nowActive = new Set();

        for (let i = 0; i < limit; i++) {
            const { grid, entry } = visible[i];
            nowActive.add(grid);
            if (!entry.active) {
                this.scene.add(grid);
                entry.active = true;
                this._active.add(grid);
            }
        }

        // Remove grids that exceeded the budget
        for (let i = limit; i < visible.length; i++) {
            const { grid, entry } = visible[i];
            if (entry.active) {
                this.scene.remove(grid);
                entry.active = false;
                this._active.delete(grid);
            }
        }

        this._stats.active = this._active.size;
        this._stats.total = this._entries.size;
        this._stats.lastUpdateMs = performance.now() - t0;
    }

    /**
     * Force all registered grids into the scene (disable virtualization).
     */
    showAll() {
        for (const [grid, entry] of this._entries) {
            if (!entry.active) {
                this.scene.add(grid);
                entry.active = true;
                this._active.add(grid);
            }
        }
    }

    /**
     * @returns {{ active: number, total: number, lastUpdateMs: number }}
     */
    getStats() {
        return { ...this._stats };
    }

    /**
     * @returns {Set<CodeGrid>} Currently active (in-scene) grids
     */
    getActiveGrids() {
        return this._active;
    }

    dispose() {
        this._entries.clear();
        this._active.clear();
    }
}
