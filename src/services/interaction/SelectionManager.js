/**
 * SelectionManager — canvas-based file selection with raycasting
 *
 * Single source of truth for which CodeGrid(s) are selected.
 * Selection is keyed by sourcePath (stable across layout switches).
 *
 * Responsibilities:
 * - Raycast against CodeGrid background meshes on canvas click
 * - Maintain primary + multi-select state
 * - Write `selected` boolean to FileStateManager (drives CodeColorManager)
 * - Apply Z-pop to selected grids (lifts entire grid above neighbors)
 * - Emit `file-selected` CustomEvent for tree panel sync
 * - Expose clear() for Escape-key deselect
 *
 * GPU cost per select/deselect:
 * - 1 DataTexture write (color tint via CodeColorManager reading FileStateManager)
 * - Object3D position.z delta (lifts grid + background together)
 * - Zero additional draw calls, no shader changes
 */

const Z_POP_AMOUNT = 3;

export class SelectionManager {
    /**
     * @param {THREE} THREE - Three.js module
     * @param {FileStateManager} fileStateManager
     */
    constructor(THREE, fileStateManager) {
        this._THREE = THREE;
        this._fileStateManager = fileStateManager;

        /** @type {string|null} Primary (focused) selection */
        this._primary = null;

        /** @type {Set<string>} All selected source paths */
        this._selected = new Set();

        /**
         * Map from sourcePath → original z position before Z-pop.
         * Used to restore position on deselect.
         * @type {Map<string, number>}
         */
        this._originalZ = new Map();

        /** @type {Set<Function>} Internal listeners: (eventType, sourcePath, state) => void */
        this._listeners = new Set();

        this._raycaster = new THREE.Raycaster();
    }

    // ============ Public API ============

    /**
     * Select a file by sourcePath.
     * @param {string} sourcePath
     * @param {Object} [opts]
     * @param {boolean} [opts.additive=false] - Cmd/Ctrl multi-select
     * @param {Array} [opts.grids] - Current grids array for Z-pop
     */
    select(sourcePath, { additive = false, grids = [] } = {}) {
        if (!additive) {
            // Deselect all current before selecting new
            this._clearSelection(grids);
        }

        if (this._selected.has(sourcePath)) {
            // Already selected — clicking again is a no-op for single select
            return;
        }

        this._selected.add(sourcePath);
        this._primary = sourcePath;

        // Write to FileStateManager so CodeColorManager's selection layer fires
        this._fileStateManager.setProperty(sourcePath, 'selected', true);

        // Apply Z-pop to the corresponding grid
        const grid = this._findGrid(sourcePath, grids);
        if (grid) {
            this._applyZPop(sourcePath, grid);
        }

        this._notify('select', sourcePath);
        this._dispatchEvent(sourcePath);
    }

    /**
     * Deselect a single file.
     * @param {string} sourcePath
     * @param {Array} [grids]
     */
    deselect(sourcePath, { grids = [] } = {}) {
        if (!this._selected.has(sourcePath)) return;

        this._selected.delete(sourcePath);

        if (this._primary === sourcePath) {
            this._primary = this._selected.size > 0
                ? this._selected.values().next().value
                : null;
        }

        this._fileStateManager.setProperty(sourcePath, 'selected', false);
        this._restoreZPop(sourcePath, grids);

        this._notify('deselect', sourcePath);
    }

    /**
     * Clear all selections.
     * @param {Array} [grids]
     */
    clear(grids = []) {
        if (this._selected.size === 0) return;

        this._clearSelection(grids);
        this._notify('clear', null);
    }

    /**
     * Handle a canvas click event via raycasting.
     * Call this from GitHubRepoViewer when the `canvas-click` event fires.
     *
     * @param {number} clientX - Mouse clientX from the click event
     * @param {number} clientY - Mouse clientY from the click event
     * @param {HTMLCanvasElement} canvas - The WebGL canvas
     * @param {THREE.Camera} camera
     * @param {Array} grids - Current CodeGrid array
     * @param {boolean} additive - True when Cmd/Ctrl held
     */
    handleClick(clientX, clientY, canvas, camera, grids, additive = false) {
        const rect = canvas.getBoundingClientRect();
        const mouse = new this._THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );

        this._raycaster.setFromCamera(mouse, camera);

        // Collect background meshes from all grids
        const backgroundMeshes = [];
        for (const grid of grids) {
            if (grid._background && grid._background.visible) {
                backgroundMeshes.push(grid._background);
            }
        }

        const intersects = this._raycaster.intersectObjects(backgroundMeshes, false);

        if (intersects.length === 0) {
            // Click on empty space — deselect all
            if (!additive) {
                this.clear(grids);
            }
            return;
        }

        // Find which grid owns the hit background mesh
        const hitMesh = intersects[0].object;
        const hitGrid = grids.find(g => g._background === hitMesh);
        if (!hitGrid) return;

        const sourcePath = hitGrid.userData?.sourcePath;
        if (!sourcePath) return;

        if (additive && this._selected.has(sourcePath)) {
            // Cmd+click on already-selected file deselects it
            this.deselect(sourcePath, { grids });
        } else {
            this.select(sourcePath, { additive, grids });
        }
    }

    /**
     * Get the primary (focused) source path.
     * @returns {string|null}
     */
    get primary() {
        return this._primary;
    }

    /**
     * Get all selected source paths.
     * @returns {Set<string>}
     */
    getSelected() {
        return new Set(this._selected);
    }

    /**
     * Check if a path is selected.
     * @param {string} sourcePath
     * @returns {boolean}
     */
    isSelected(sourcePath) {
        return this._selected.has(sourcePath);
    }

    /**
     * Subscribe to selection events.
     * @param {Function} callback - (eventType, sourcePath, state) => void
     *   eventType: 'select' | 'deselect' | 'clear'
     *   state: { primary, selected: string[] }
     */
    on(callback) {
        this._listeners.add(callback);
    }

    /**
     * Unsubscribe from selection events.
     * @param {Function} callback
     */
    off(callback) {
        this._listeners.delete(callback);
    }

    /**
     * Clean up all selection state. Call on repo clear.
     * Does NOT restore Z positions (caller should clear grids anyway).
     */
    dispose() {
        this._selected.clear();
        this._primary = null;
        this._originalZ.clear();
        this._listeners.clear();
    }

    // ============ Private ============

    /**
     * Clear all selection state and restore Z positions.
     * @private
     * @param {Array} grids
     */
    _clearSelection(grids) {
        for (const sourcePath of this._selected) {
            this._fileStateManager.setProperty(sourcePath, 'selected', false);
            this._restoreZPop(sourcePath, grids);
        }
        this._selected.clear();
        this._primary = null;
    }

    /**
     * Apply Z-pop to a grid, saving its original Z for later restoration.
     * @private
     * @param {string} sourcePath
     * @param {THREE.Object3D} grid
     */
    _applyZPop(sourcePath, grid) {
        if (!this._originalZ.has(sourcePath)) {
            this._originalZ.set(sourcePath, grid.position.z);
        }
        grid.position.z = this._originalZ.get(sourcePath) + Z_POP_AMOUNT;
    }

    /**
     * Restore a grid's Z position after deselection.
     * @private
     * @param {string} sourcePath
     * @param {Array} grids
     */
    _restoreZPop(sourcePath, grids) {
        const originalZ = this._originalZ.get(sourcePath);
        if (originalZ === undefined) return;

        const grid = this._findGrid(sourcePath, grids);
        if (grid) {
            grid.position.z = originalZ;
        }
        this._originalZ.delete(sourcePath);
    }

    /**
     * Find a grid by sourcePath from the grids array.
     * @private
     * @param {string} sourcePath
     * @param {Array} grids
     * @returns {THREE.Object3D|null}
     */
    _findGrid(sourcePath, grids) {
        return grids.find(g => g.userData?.sourcePath === sourcePath) || null;
    }

    /**
     * Fire internal listeners.
     * @private
     */
    _notify(eventType, sourcePath) {
        const state = {
            primary: this._primary,
            selected: [...this._selected]
        };
        for (const cb of this._listeners) {
            try {
                cb(eventType, sourcePath, state);
            } catch (err) {
                console.error('SelectionManager listener error:', err);
            }
        }
    }

    /**
     * Dispatch window CustomEvent for external consumers (tree panel sync).
     * @private
     * @param {string} sourcePath
     */
    _dispatchEvent(sourcePath) {
        window.dispatchEvent(new CustomEvent('file-selected', {
            detail: {
                sourcePath,
                primary: this._primary,
                selected: [...this._selected]
            }
        }));
    }
}

export default SelectionManager;
