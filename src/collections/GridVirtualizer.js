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

// Distance factor beyond which an inactive grid is eligible for GPU eviction.
// A grid must be at least (hysteresis * EVICTION_DISTANCE_FACTOR) world units
// from the camera before eviction is considered.
const EVICTION_DISTANCE_FACTOR = 10.0;

// How long (ms) a grid must continuously sit beyond the eviction distance before
// its GPU buffers are released. Prevents thrashing at the boundary.
const EVICTION_DELAY_MS = 5000;

export default class GridVirtualizer {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {Object} [options]
     * @param {number} [options.budget=500] - Max simultaneously visible grids
     * @param {number} [options.hysteresis=50] - World-unit margin before removing a grid
     *   that just left the frustum. Prevents popping during small camera movements.
     * @param {GlyphAtlas|null} [options.atlas=null] - Atlas passed to reloadContent().
     *   Required if memory reclamation (GPU eviction) is desired.
     * @param {boolean} [options.enableEviction=false] - Enable GPU buffer eviction for
     *   far-away grids. When true, grids beyond (hysteresis * EVICTION_DISTANCE_FACTOR)
     *   for EVICTION_DELAY_MS milliseconds will have unloadContent() called on them,
     *   and reloadContent() called when they re-enter the frustum.
     */
    constructor(scene, camera, { budget = Infinity, hysteresis = 50, atlas = null, enableEviction = true } = {}) {
        this.scene = scene;
        this.camera = camera;
        this.budget = budget;
        this.hysteresis = hysteresis;

        // Memory reclamation
        this._atlas = atlas;
        this._enableEviction = enableEviction;

        /** @type {Map<CodeGrid, {bounds: THREE.Box3, active: boolean, distance: number, evicted: boolean, _evictionTimer: number|null}>} */
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
        this._entries.set(grid, {
            bounds,
            active: alreadyInScene,
            distance: Infinity,
            evicted: false,
            _evictionTimer: null
        });
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

        // Memory reclamation: evict GPU buffers for grids far from the camera
        if (this._enableEviction) {
            const evictionDistance = this.hysteresis * EVICTION_DISTANCE_FACTOR;
            const now = performance.now();

            for (const [grid, entry] of this._entries) {
                if (entry.active) {
                    // Grid is visible — cancel any pending eviction timer and reload
                    // if it had previously been evicted.
                    entry._evictionTimer = null;

                    if (entry.evicted) {
                        // Re-entering visibility: restore GPU buffers asynchronously.
                        // Grid renders empty for at most one worker round-trip, which is
                        // acceptable. The reload is fire-and-forget; errors are logged by
                        // the collection internals.
                        entry.evicted = false;
                        grid.reloadContent(this._atlas).catch(() => {
                            // If reload fails, mark as not evicted so we don't retry
                            // every frame (the grid will just stay blank until the next
                            // visibility transition).
                        });
                    }
                } else if (!entry.evicted && entry.distance > evictionDistance) {
                    // Inactive and far: start or continue the eviction countdown
                    if (entry._evictionTimer === null) {
                        entry._evictionTimer = now;
                    } else if (now - entry._evictionTimer >= EVICTION_DELAY_MS) {
                        // Sustained absence — release GPU buffers
                        grid.unloadContent();
                        entry.evicted = true;
                        entry._evictionTimer = null;
                    }
                } else {
                    // Inactive but close enough, or already evicted — reset timer
                    if (!entry.evicted) {
                        entry._evictionTimer = null;
                    }
                }
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
     * Update the atlas reference used by reloadContent().
     * Call this if the GlyphAtlas is regenerated after virtualizer construction.
     * @param {GlyphAtlas} atlas
     */
    setAtlas(atlas) {
        this._atlas = atlas;
    }

    /**
     * Enable or disable GPU buffer eviction at runtime.
     * @param {boolean} enabled
     */
    setEvictionEnabled(enabled) {
        this._enableEviction = enabled;
        if (!enabled) {
            // Cancel all pending timers so disabled state is clean
            for (const entry of this._entries.values()) {
                entry._evictionTimer = null;
            }
        }
    }

    /**
     * @returns {{ active: number, total: number, evicted: number, lastUpdateMs: number }}
     */
    getStats() {
        let evicted = 0;
        for (const entry of this._entries.values()) {
            if (entry.evicted) evicted++;
        }
        return { ...this._stats, evicted };
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
