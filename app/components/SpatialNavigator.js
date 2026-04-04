/**
 * SpatialNavigator — Keyboard-driven grid navigation in 3D space.
 *
 * Two modes:
 *   GRID mode  — hjkl/arrows move focus between grids by spatial proximity
 *   LINE mode  — j/k scroll lines within the focused grid (future)
 *
 * Enter "dives into" the focused grid (GRID → LINE mode).
 * Escape "pops out" (LINE → GRID mode, or clears focus).
 *
 * The navigator doesn't own the camera — it calls cameraController.focusOnGrid()
 * and lets the existing camera animation handle the movement.
 */

export default class SpatialNavigator {
    /**
     * @param {Object} opts
     * @param {Function} opts.getGrids - Returns array of CodeGrid instances
     * @param {Object} opts.cameraController - ViewerCameraController
     * @param {HTMLElement} [opts.statusEl] - Element to show focused grid name
     */
    constructor({ getGrids, cameraController, statusEl }) {
        this._getGrids = getGrids;
        this._cam = cameraController;
        this._statusEl = statusEl;

        /** @type {number} Index of focused grid, -1 = none */
        this._focusIndex = -1;

        /** @type {'grid'|'line'} */
        this._mode = 'grid';

        this._wireKeyboard();
    }

    /** @returns {number} Currently focused grid index */
    get focusIndex() { return this._focusIndex; }

    /** @returns {'grid'|'line'} Current navigation mode */
    get mode() { return this._mode; }

    /**
     * Focus a specific grid by index.
     * @param {number} index
     */
    /**
     * Focus a specific grid by index.
     * @param {number} index
     * @param {boolean} [moveCamera=true] - Set false when camera already moved (e.g. from camera.focus command)
     */
    focusGrid(index, moveCamera = true) {
        const grids = this._getGrids();
        if (index < 0 || index >= grids.length) return;
        this._focusIndex = index;
        if (moveCamera) this._cam.focusOnGrid(index);
        this._updateStatus();
    }

    /** Clear focus */
    clearFocus() {
        this._focusIndex = -1;
        this._mode = 'grid';
        this._updateStatus();
    }

    /**
     * Navigate to the nearest grid in a direction.
     * Direction is relative to the current camera view:
     *   left/right = -X/+X, up/down = +Y/-Y
     *
     * @param {'left'|'right'|'up'|'down'} direction
     */
    navigate(direction) {
        const grids = this._getGrids();
        if (grids.length === 0) return;

        // If no focus, pick the grid nearest to camera
        if (this._focusIndex < 0) {
            this._focusIndex = this._nearestToCamera(grids);
            if (this._focusIndex >= 0) {
                this.focusGrid(this._focusIndex);
            }
            return;
        }

        const current = grids[this._focusIndex];
        if (!current) return;

        const next = this.findNearest(grids, current, direction);
        if (next >= 0 && next !== this._focusIndex) {
            this.focusGrid(next);
        }
    }

    /**
     * Find the nearest grid to the current camera position.
     * @private
     */
    _nearestToCamera(grids) {
        const cam = this._cam.ctx.camera;
        let bestIdx = -1;
        let bestDist = Infinity;

        for (let i = 0; i < grids.length; i++) {
            const g = grids[i];
            if (!g.visible || !g.parent) continue; // skip unloaded/hidden
            const dx = g.position.x - cam.position.x;
            const dy = g.position.y - cam.position.y;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    /**
     * Find the nearest grid in a given direction from the current grid.
     *
     * Uses a cone-based search: candidates must be in the correct half-plane
     * (e.g. +X for 'right') and within a 90° cone from the direction axis.
     * Among candidates, picks the closest by distance.
     *
     * @param {Array} grids
     * @param {Object} current - Current focused grid
     * @param {'left'|'right'|'up'|'down'} direction
     * @returns {number} Index of nearest grid in direction, or -1
     */
    findNearest(grids, current, direction) {
        const cx = current.position.x;
        const cy = current.position.y;

        let bestIdx = -1;
        let bestScore = Infinity;

        for (let i = 0; i < grids.length; i++) {
            if (i === this._focusIndex) continue;
            const g = grids[i];
            if (!g.visible || !g.parent) continue;

            const dx = g.position.x - cx;
            const dy = g.position.y - cy;

            // Check direction — candidate must be in the correct half-plane
            let inDirection = false;
            let primaryDist = 0;
            let secondaryDist = 0;

            switch (direction) {
                case 'right':
                    inDirection = dx > 0;
                    primaryDist = dx;
                    secondaryDist = Math.abs(dy);
                    break;
                case 'left':
                    inDirection = dx < 0;
                    primaryDist = -dx;
                    secondaryDist = Math.abs(dy);
                    break;
                case 'up':
                    inDirection = dy > 0;
                    primaryDist = dy;
                    secondaryDist = Math.abs(dx);
                    break;
                case 'down':
                    inDirection = dy < 0;
                    primaryDist = -dy;
                    secondaryDist = Math.abs(dx);
                    break;
            }

            if (!inDirection) continue;

            // Cone filter: secondary distance must be less than primary
            // (within 45° of the direction axis)
            if (secondaryDist > primaryDist) continue;

            // Score: heavily penalize off-axis to prefer aligned neighbors.
            // A grid directly left at 557px beats one at 281px that's also 262px down.
            const score = primaryDist + secondaryDist * 2.0;
            if (score < bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        return bestIdx;
    }

    /** @private */
    _updateStatus() {
        if (!this._statusEl) return;
        if (this._focusIndex < 0) {
            this._statusEl.textContent = '';
            return;
        }
        const grids = this._getGrids();
        const g = grids[this._focusIndex];
        if (!g) return;
        const name = g.getFilename?.() || g.getSourcePath?.() || `grid #${this._focusIndex}`;
        this._statusEl.textContent = name;
    }

    /** @private */
    _wireKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Don't capture when typing in inputs/textareas/command bar
            if (this._isInputFocused(e)) return;

            // Grid navigation: hjkl or arrows (without modifiers)
            if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                switch (e.key) {
                    case 'h':
                    case 'ArrowLeft':
                        if (this._mode === 'grid') {
                            e.preventDefault();
                            this.navigate('left');
                        }
                        return;
                    case 'l':
                    case 'ArrowRight':
                        if (this._mode === 'grid') {
                            e.preventDefault();
                            this.navigate('right');
                        }
                        return;
                    case 'k':
                    case 'ArrowUp':
                        if (this._mode === 'grid') {
                            e.preventDefault();
                            this.navigate('up');
                        }
                        return;
                    case 'j':
                    case 'ArrowDown':
                        if (this._mode === 'grid') {
                            e.preventDefault();
                            this.navigate('down');
                        }
                        return;
                    case 'Enter':
                        if (this._focusIndex >= 0 && this._mode === 'grid') {
                            e.preventDefault();
                            this._mode = 'line';
                            this._updateStatus();
                        }
                        return;
                    case 'Escape':
                        if (this._mode === 'line') {
                            e.preventDefault();
                            this._mode = 'grid';
                            this._updateStatus();
                        } else if (this._focusIndex >= 0) {
                            e.preventDefault();
                            this.clearFocus();
                        }
                        return;
                }
            }
        });
    }

    /**
     * Check if an input element has focus (don't capture keystrokes).
     * @private
     */
    _isInputFocused(e) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (e.target.contentEditable === 'true') return true;
        // Command bar input
        if (e.target.closest?.('#command-input')) return true;
        return false;
    }
}
