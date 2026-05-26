/**
 * EntityInputRouter — capture-phase canvas mousedown interceptor with
 * per-entity-type dispatch.
 *
 * Renamed from HitDispatcher in editable-3d-ide L1-A. The rename carries
 * two structural changes, both scaffolded in this pass:
 *
 *   1. `registerType(type, handlers)` — each registered entity type
 *      (today: 'grid', 'agent', 'terminal') owns its pointer semantics
 *      instead of being baked into a hardcoded filter. The default
 *      handlers reproduce the pre-L1 drag-and-group behavior so nothing
 *      visible changes from this commit. Later phases can override
 *      `onPointerDown`/`onPointerMove`/`onPointerUp` per type, or add
 *      new types (e.g. HUD compass markers as a registered type rather
 *      than a bespoke listener in GitHubRepoViewer.js).
 *
 *   2. The default hit-test returns enough information for sub-region
 *      resolution (entry, gridId, world point). The UV→pixel conversion
 *      that the convergence docs call out as "done once at the router
 *      boundary" lands here when chrome handles are added — for L1-A
 *      there's nothing to sub-region against.
 *
 * Drag / click / drop-target semantics are unchanged from HitDispatcher:
 *   - mousedown HIT (raycast against registered types' backgrounds)
 *       → stopPropagation (suppresses camera drag)
 *       → drag state primed
 *   - mousemove while dragging → world-space delta to the target
 *     (or spatial group), pixel → world via screenToWorldDelta
 *   - mouseup < 5px displacement → re-emit `canvas-click` with gridId
 *   - mouseup > 5px with ctrl/meta → _checkDropTarget for auto-grouping
 *   - raycastAtClient(x, y) is public (camera focus probe, external
 *     callers like app/ide.html's click-to-attention path).
 */

import * as THREE from 'three';
import { screenToWorldDelta } from '../spatial/spatialMath.js';
import { createLogger } from '../../utils/Logger.js';

const log = createLogger('entityInputRouter', 0);
const CLICK_THRESHOLD_PX = 5;
const DROP_OVERLAP_THRESHOLD = 0.30;

/**
 * Default per-type handler set used when no explicit registration exists.
 * Callers that want to override behavior for a given type pass a partial
 * object to registerType and whatever keys they omit fall back to these.
 */
const DEFAULT_TYPE_HANDLERS = Object.freeze({
    // Hit-testable by the raycaster. A type with hitTestable=false is
    // registered but not included in the mousedown raycast pool.
    hitTestable: true,

    // Default drag semantics: translate in world XY at the grid's Z.
    // Future types (e.g. camera-docked) will override this.
    translate: true,

    // Include in drop-target candidate pool for auto-grouping.
    dropTargetCandidate: true,
});

export class EntityInputRouter {
    /**
     * @param {Object} opts
     * @param {HTMLCanvasElement} opts.canvas
     * @param {THREE.PerspectiveCamera} opts.camera
     * @param {THREE.Scene} opts.scene
     * @param {SceneRegistry} opts.registry
     * @param {SpatialWindowManager} [opts.spatialManager]
     * @param {GridVirtualizer} [opts.virtualizer]
     */
    constructor({ canvas, camera, scene, registry, spatialManager = null, virtualizer = null }) {
        this.canvas = canvas;
        this.camera = camera;
        this.scene = scene;
        this.registry = registry;
        this.spatialManager = spatialManager;
        this.virtualizer = virtualizer;

        this._raycaster = new THREE.Raycaster();

        /** @private @type {Map<string, Object>} */
        this._typeHandlers = new Map();

        // Drag state
        this._dragging = false;
        this._dragTarget = null;     // { grid, registryId, entry }
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragPrevX = 0;
        this._dragPrevY = 0;
        this._hasMoved = false;

        // Bound handlers for cleanup
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);

        // Register the built-in types. Callers can add more via
        // registerType() after construction.
        this.registerType('grid');
        this.registerType('agent');
        this.registerType('terminal');
    }

    // ============ Type Registration ============

    /**
     * Register an entity type as hit-testable / draggable.
     * @param {string} type - matches registry entry.type (e.g. 'grid', 'terminal')
     * @param {Object} [handlers] - partial override of DEFAULT_TYPE_HANDLERS
     */
    registerType(type, handlers = {}) {
        this._typeHandlers.set(type, { ...DEFAULT_TYPE_HANDLERS, ...handlers });
    }

    /**
     * Unregister a type. Useful for test teardown or runtime reconfig.
     * @param {string} type
     */
    unregisterType(type) {
        this._typeHandlers.delete(type);
    }

    /**
     * Introspection: return the list of currently-registered types.
     * @returns {string[]}
     */
    getRegisteredTypes() {
        return [...this._typeHandlers.keys()];
    }

    // ============ Attach / Detach ============

    attach() {
        this.canvas.addEventListener('mousedown', this._onMouseDown, { capture: true });
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
    }

    detach() {
        this.canvas.removeEventListener('mousedown', this._onMouseDown, { capture: true });
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        this._dragging = false;
        this._dragTarget = null;
    }

    // ============ Event Handlers ============

    /** @private */
    _handleMouseDown(e) {
        const hit = this._raycast(e.clientX, e.clientY);
        if (!hit) return; // Miss: let event bubble to VCC for camera drag

        log.debug(`mousedown HIT: ${hit.registryId}`);

        // Hit: suppress camera drag
        e.stopPropagation();

        this._dragging = true;
        this._dragTarget = hit;
        this._dragStartX = e.clientX;
        this._dragStartY = e.clientY;
        this._dragPrevX = e.clientX;
        this._dragPrevY = e.clientY;
        this._hasMoved = false;

        if (hit.grid.userData) {
            hit.grid.userData._dragPinned = true;
        }

        this.canvas.style.cursor = 'grabbing';
    }

    /** @private */
    _handleMouseMove(e) {
        if (!this._dragging || !this._dragTarget) return;

        const dx = e.clientX - this._dragPrevX;
        const dy = e.clientY - this._dragPrevY;
        this._dragPrevX = e.clientX;
        this._dragPrevY = e.clientY;

        const totalDx = e.clientX - this._dragStartX;
        const totalDy = e.clientY - this._dragStartY;
        if (!this._hasMoved && Math.sqrt(totalDx * totalDx + totalDy * totalDy) >= CLICK_THRESHOLD_PX) {
            this._hasMoved = true;
        }

        if (!this._hasMoved) return;

        // Per-type translate flag decides whether the default world-space
        // drag applies. L1-A registers all built-in types with translate=true;
        // L2 will introduce dock-aware types whose translate handler differs.
        const type = this._dragTarget.entry?.type;
        const handlers = type ? this._typeHandlers.get(type) : null;
        if (handlers && handlers.translate === false) return;

        const grid = this._dragTarget.grid;
        const delta = screenToWorldDelta(dx, dy, grid.position.z, this.camera, this.canvas);

        const groupName = this.spatialManager?.getGroupForGrid(this._dragTarget.registryId);
        if (groupName && this.spatialManager) {
            this.spatialManager.moveGroupByDelta(groupName, delta.x, delta.y);
        } else {
            grid.position.x += delta.x;
            grid.position.y += delta.y;
        }
    }

    /** @private */
    _handleMouseUp(e) {
        if (!this._dragging || !this._dragTarget) return;

        const grid = this._dragTarget.grid;

        if (grid.userData) {
            grid.userData._dragPinned = false;
        }

        if (this._hasMoved && this.virtualizer) {
            const groupName = this.spatialManager?.getGroupForGrid(this._dragTarget.registryId);
            if (groupName) {
                const group = this.spatialManager.getGroup(groupName);
                if (group) {
                    for (const id of group.memberIds) {
                        const entry = this.registry.get(id);
                        if (entry?.grid) this.virtualizer.refreshBounds(entry.grid);
                    }
                }
            } else {
                this.virtualizer.refreshBounds(grid);
            }
        }

        if (!this._hasMoved) {
            log.debug(`mouseup: click (no drag) on ${this._dragTarget.registryId}`);
            this.canvas.dispatchEvent(new CustomEvent('canvas-click', {
                detail: {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                    gridId: this._dragTarget.registryId || null,
                },
                bubbles: true,
            }));
        } else if (e.ctrlKey || e.metaKey) {
            this._checkDropTarget(grid, this._dragTarget.registryId);
        }

        this._dragging = false;
        this._dragTarget = null;
        this.canvas.style.cursor = 'grab';
    }

    // ============ Raycasting ============

    /**
     * Public raycast at client coords. Used by the camera focus probe,
     * the app/ide.html click-to-attention path, and anyone else who needs
     * "what entity is under this pixel?"
     *
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{ grid: Object, registryId: string, entry: Object, point: THREE.Vector3 }|null}
     */
    raycastAtClient(clientX, clientY) {
        return this._raycast(clientX, clientY);
    }

    /** @private */
    _raycast(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );

        this._raycaster.setFromCamera(mouse, this.camera);

        // Walk registered types and collect their hit-testable backgrounds.
        // Only entries with a visible _background mesh are considered — a
        // hidden background (e.g. explicitly `.visible = false`) opts the
        // entity out of hit-testing for this frame.
        const meshToEntry = new Map();
        for (const [type, handlers] of this._typeHandlers) {
            if (!handlers.hitTestable) continue;
            const entries = this.registry.findByType(type);
            for (const entry of entries) {
                const bg = entry.grid?._background;
                if (bg && bg.visible) {
                    meshToEntry.set(bg, entry);
                }
            }
        }

        const meshes = [...meshToEntry.keys()];
        if (meshes.length === 0) return null;

        const intersects = this._raycaster.intersectObjects(meshes, false);
        if (intersects.length === 0) return null;

        const hitMesh = intersects[0].object;
        const entry = meshToEntry.get(hitMesh);
        if (!entry) return null;

        return {
            grid: entry.grid,
            registryId: entry.id,
            entry,
            point: intersects[0].point,
        };
    }

    // ============ Drop Target Detection ============

    /** @private */
    _checkDropTarget(draggedGrid, draggedId) {
        if (!this.spatialManager) return;

        if (this.spatialManager.getGroupForGrid(draggedId)) return;

        const dragBounds = draggedGrid.getBounds?.();
        if (!dragBounds || dragBounds.isEmpty()) return;

        const dragArea = (dragBounds.max.x - dragBounds.min.x) * (dragBounds.max.y - dragBounds.min.y);
        if (dragArea <= 0) return;

        let bestTarget = null;
        let bestOverlapRatio = 0;

        // Walk registered types whose handlers flag them as drop-target
        // candidates. A future `pin.*` namespace can register types that
        // opt out of auto-grouping (e.g. a docked terminal shouldn't
        // implicitly join a spatial group of grids).
        for (const [type, handlers] of this._typeHandlers) {
            if (!handlers.dropTargetCandidate) continue;
            const entries = this.registry.findByType(type);
            for (const entry of entries) {
                if (entry.id === draggedId) continue;
                const targetBounds = entry.grid?.getBounds?.();
                if (!targetBounds || targetBounds.isEmpty()) continue;

                const overlap = this._computeOverlap(dragBounds, targetBounds);
                if (overlap <= 0) continue;

                const ratio = overlap / dragArea;
                if (ratio > bestOverlapRatio) {
                    bestOverlapRatio = ratio;
                    bestTarget = entry;
                }
            }
        }

        if (bestOverlapRatio >= DROP_OVERLAP_THRESHOLD && bestTarget) {
            const targetGroupName = this.spatialManager.getGroupForGrid(bestTarget.id);
            if (targetGroupName) {
                this.spatialManager.addToGroup(targetGroupName, draggedId);
            } else {
                const groupName = `group-${Date.now().toString(36)}`;
                this.spatialManager.createGroup(groupName);
                this.spatialManager.addToGroup(groupName, bestTarget.id);
                this.spatialManager.addToGroup(groupName, draggedId);
            }
        }
    }

    /** @private */
    _computeOverlap(a, b) {
        const xMin = Math.max(a.min.x, b.min.x);
        const xMax = Math.min(a.max.x, b.max.x);
        const yMin = Math.max(a.min.y, b.min.y);
        const yMax = Math.min(a.max.y, b.max.y);

        if (xMax <= xMin || yMax <= yMin) return 0;
        return (xMax - xMin) * (yMax - yMin);
    }
}

export default EntityInputRouter;
