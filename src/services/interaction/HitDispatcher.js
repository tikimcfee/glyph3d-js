/**
 * HitDispatcher -- capture-phase mousedown interceptor for window dragging.
 *
 * Registers mousedown on the canvas in capture phase (fires before VCC's
 * bubble-phase handler). On hit against a grid/agent background mesh:
 *   - stopPropagation() suppresses camera drag
 *   - mousemove applies world-space delta to the target grid (or group)
 *   - mouseup under 5px displacement re-emits as 'canvas-click'
 *   - mouseup over 5px checks for drop-target overlap (30% threshold)
 *
 * Never touches DOM events after detach(). Never owns group semantics.
 */

import * as THREE from 'three';
import { screenToWorldDelta } from '../spatial/spatialMath.js';
import { createLogger } from '../../utils/Logger.js';

const log = createLogger('hitDispatch', 0);
const CLICK_THRESHOLD_PX = 5;
const DROP_OVERLAP_THRESHOLD = 0.30;

export class HitDispatcher {
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
    }

    /**
     * Attach DOM listeners. Call once after construction.
     */
    attach() {
        this.canvas.addEventListener('mousedown', this._onMouseDown, { capture: true });
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
    }

    /**
     * Remove all DOM listeners. Call on teardown.
     */
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
        const hit = this._raycastDraggable(e.clientX, e.clientY);
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

        // Pin grid in virtualizer during drag
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

        // Check displacement threshold for click/drag disambiguation
        const totalDx = e.clientX - this._dragStartX;
        const totalDy = e.clientY - this._dragStartY;
        if (!this._hasMoved && Math.sqrt(totalDx * totalDx + totalDy * totalDy) >= CLICK_THRESHOLD_PX) {
            this._hasMoved = true;
        }

        if (!this._hasMoved) return;

        // Convert pixel delta to world-space delta at the grid's Z depth
        const grid = this._dragTarget.grid;
        const delta = screenToWorldDelta(dx, dy, grid.position.z, this.camera, this.canvas);

        // Check if grid is in a group
        const groupName = this.spatialManager?.getGroupForGrid(this._dragTarget.registryId);
        if (groupName && this.spatialManager) {
            this.spatialManager.moveGroupByDelta(groupName, delta.x, delta.y);
        } else {
            // Move single grid
            grid.position.x += delta.x;
            grid.position.y += delta.y;
        }
    }

    /** @private */
    _handleMouseUp(e) {
        if (!this._dragging || !this._dragTarget) return;

        const grid = this._dragTarget.grid;

        // Unpin from virtualizer
        if (grid.userData) {
            grid.userData._dragPinned = false;
        }

        // Refresh virtualizer bounds for the dragged grid (and group siblings)
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
            // Displacement under threshold -> re-emit as canvas-click
            this.canvas.dispatchEvent(new CustomEvent('canvas-click', {
                detail: {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                },
                bubbles: true,
            }));
        } else if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd + drag-release: check for drop-to-group
            this._checkDropTarget(grid, this._dragTarget.registryId);
        }

        this._dragging = false;
        this._dragTarget = null;
        this.canvas.style.cursor = 'grab';
    }

    // ============ Raycasting ============

    /**
     * Raycast against grid and agent background meshes.
     * Uses registry.findByType() (NOT registry.list()).
     *
     * @private
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{ grid: Object, registryId: string, entry: Object }|null}
     */
    _raycastDraggable(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );

        this._raycaster.setFromCamera(mouse, this.camera);

        // Collect background meshes from grid + agent entries
        const meshToEntry = new Map();
        const types = ['grid', 'agent'];

        for (const type of types) {
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
        };
    }

    // ============ Drop Target Detection ============

    /**
     * Check if dragged grid overlaps enough with another grid to form a group.
     * Uses Box3 min/max for area computation (never .width/.height).
     *
     * @private
     * @param {Object} draggedGrid
     * @param {string} draggedId
     */
    _checkDropTarget(draggedGrid, draggedId) {
        if (!this.spatialManager) return;

        // Already in a group -- skip auto-grouping
        if (this.spatialManager.getGroupForGrid(draggedId)) return;

        const dragBounds = draggedGrid.getBounds?.();
        if (!dragBounds || dragBounds.isEmpty()) return;

        const dragArea = (dragBounds.max.x - dragBounds.min.x) * (dragBounds.max.y - dragBounds.min.y);
        if (dragArea <= 0) return;

        // Find the best overlap target
        let bestTarget = null;
        let bestOverlapRatio = 0;

        const types = ['grid', 'agent'];
        for (const type of types) {
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
            // Auto-create a group or add to existing group
            const targetGroupName = this.spatialManager.getGroupForGrid(bestTarget.id);
            if (targetGroupName) {
                // Target is already grouped -- add dragged to that group
                this.spatialManager.addToGroup(targetGroupName, draggedId);
            } else {
                // Neither is grouped -- create new group with both
                const groupName = `group-${Date.now().toString(36)}`;
                this.spatialManager.createGroup(groupName);
                this.spatialManager.addToGroup(groupName, bestTarget.id);
                this.spatialManager.addToGroup(groupName, draggedId);
            }
        }
    }

    /**
     * Compute intersection area of two Box3 projections (XY plane).
     * Uses min/max only (no .width/.height).
     *
     * @private
     * @param {THREE.Box3} a
     * @param {THREE.Box3} b
     * @returns {number} overlap area (0 if no overlap)
     */
    _computeOverlap(a, b) {
        const xMin = Math.max(a.min.x, b.min.x);
        const xMax = Math.min(a.max.x, b.max.x);
        const yMin = Math.max(a.min.y, b.min.y);
        const yMax = Math.min(a.max.y, b.max.y);

        if (xMax <= xMin || yMax <= yMin) return 0;
        return (xMax - xMin) * (yMax - yMin);
    }
}

export default HitDispatcher;
