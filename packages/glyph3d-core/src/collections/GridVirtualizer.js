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
// Raised from 10 to 15 to give a larger safe zone between the frustum edge
// (hysteresis band) and the eviction boundary. This reduces the probability
// of a grid oscillating across the eviction threshold.
const EVICTION_DISTANCE_FACTOR = 15.0;

// How long (ms) a grid must continuously sit beyond the eviction distance before
// its GPU buffers are released. Prevents thrashing at the boundary.
const EVICTION_DELAY_MS = 5000;

// After a reload completes, how many milliseconds before the grid is eligible
// for eviction again. Prevents a rapid frustum-edge oscillation from spawning
// back-to-back reload + evict cycles. 8 seconds gives enough time for the user
// to confirm intent before the grid is evicted again.
const RELOAD_COOLDOWN_MS = 8000;

// Per-frame reload pacing. reloadContent() does some synchronous main-thread work
// before it yields (renderer alloc + shaping prefix). Firing all re-entering grids
// at once on a wide camera pan would stall the frame, so we reload the closest
// first, only as many as fit in a small wall-clock budget per update() — this
// self-tunes to the machine and to how heavy each reload currently is (after the
// worker-shaping + content-sized-renderer work, the synchronous kickoff is ~0.1ms,
// so this admits dozens per frame instead of a hand-tuned constant). A hard cap
// keeps a pathological frame bounded. Deferred grids stay evicted+active and are
// re-collected next frame, filling in over a few frames.
const RELOAD_MS_BUDGET = 2;        // ms of synchronous reload kickoff per update()
const RELOAD_MAX_PER_FRAME = 24;   // hard ceiling regardless of the time budget

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

        /** @type {Map<CodeGrid, {bounds: THREE.Box3, active: boolean, distance: number, evicted: boolean, _evictionTimer: number|null, _reloadCooldownUntil: number, _reloadInFlight: boolean}>} */
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
            _evictionTimer: null,
            // Timestamp (performance.now()) after which eviction is allowed again.
            // Set to 0 on first registration so newly-registered grids can evict
            // normally after EVICTION_DELAY_MS without waiting for a full cooldown.
            _reloadCooldownUntil: 0,
            // True while an async reloadContent() Promise is outstanding. Guards
            // against starting a second reload before the first one completes.
            _reloadInFlight: false,
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

            // Re-entering grids needing a reload are collected here, then reloaded
            // closest-first within a per-frame time budget (see below). Deferred ones
            // stay evicted+active and get re-collected next frame, so the whole set
            // fills in over a few frames instead of stalling on one.
            const reloadCandidates = [];

            for (const [grid, entry] of this._entries) {
                if (entry.active) {
                    // Grid is visible — cancel any pending eviction timer.
                    entry._evictionTimer = null;

                    if (entry.evicted && !entry._reloadInFlight) {
                        reloadCandidates.push({ grid, entry });
                    }
                } else if (!entry.evicted && entry.distance > evictionDistance) {
                    // Inactive and far: only proceed if past the post-reload cooldown.
                    // A grid that was just reloaded (camera briefly panned across it)
                    // is protected from immediate re-eviction for RELOAD_COOLDOWN_MS.
                    if (now < entry._reloadCooldownUntil) {
                        // Still in cooldown — reset timer but don't evict yet
                        entry._evictionTimer = null;
                        continue;
                    }

                    // Start or continue the eviction countdown
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

            // Reload only the closest few re-entering grids this frame; the rest
            // stay evicted+active and are re-collected next frame. Bounds the
            // synchronous reload cost per frame regardless of how many grids the
            // camera just swept back into view.
            if (reloadCandidates.length > 1) {
                reloadCandidates.sort((a, b) => a.entry.distance - b.entry.distance);
            }
            // Reload closest-first, as many as fit in the per-frame time budget,
            // hard-capped. Each reloadContent() runs synchronously up to its first
            // await (renderer alloc + shaping prefix); we stop once that synchronous
            // work has consumed RELOAD_MS_BUDGET so the frame stays smooth.
            const reloadStart = performance.now();
            for (let i = 0; i < reloadCandidates.length && i < RELOAD_MAX_PER_FRAME; i++) {
                const { grid, entry } = reloadCandidates[i];
                // Restore GPU buffers asynchronously. _reloadInFlight guards against
                // a rapid frustum oscillation queueing overlapping reloads.
                entry.evicted = false;
                entry._reloadInFlight = true;
                grid.reloadContent(this._atlas)
                    .then(() => {
                        entry._reloadInFlight = false;
                        // Cooldown: cannot be evicted again for RELOAD_COOLDOWN_MS,
                        // preventing evict → reload → evict churn at the frustum edge.
                        entry._reloadCooldownUntil = performance.now() + RELOAD_COOLDOWN_MS;
                    })
                    .catch(() => {
                        // On failure, leave not-evicted so we don't retry every frame
                        // (grid stays blank until the next visibility transition).
                        entry._reloadInFlight = false;
                    });
                if (performance.now() - reloadStart >= RELOAD_MS_BUDGET) break;
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
