/**
 * CodeColorManager — data → glyph visual mapping
 *
 * The "property shader" — translates FileStateManager properties into
 * per-file glyph color updates. Uses layered color resolution: multiple
 * active layers (heatmap, search highlight, focus accent) resolve to
 * one final color per file.
 *
 * Uses group-level coloring: grid.getCollection().setGroupColor(0, color)
 * which is O(1) per file via the GPU DataTexture group color system.
 * The async glyph loading path produces ONE text ID per file, so
 * group 0 is always the correct target for file-level coloring.
 *
 * Color blend mode: uses setGroupColorBlend(0, 1.0) to REPLACE instance
 * colors rather than multiply. This is necessary because instance colors
 * are the default text color (green), and multiplying green × heatmap
 * kills the R and B channels. Replace mode lets the heatmap color show
 * through directly.
 */

export class CodeColorManager {
    /**
     * @param {SceneContext} ctx
     * @param {FileStateManager} fileStateManager
     */
    constructor(ctx, fileStateManager) {
        this.ctx = ctx;
        this.fileStateManager = fileStateManager;

        /**
         * Registered color layers, sorted by priority (highest first).
         * @type {Array<{ name: string, priority: number, colorFn: Function, enabled: boolean }>}
         */
        this._layers = [];

        /** @private */
        this._onPropertyChanged = this._handlePropertyChanged.bind(this);
        this.fileStateManager.onPropertyChanged(this._onPropertyChanged);
    }

    /**
     * Register a color layer.
     * @param {string} name - Layer identifier
     * @param {Object} opts
     * @param {number} opts.priority - Higher priority layers override lower ones
     * @param {Function} opts.colorFn - (sourcePath, fileProps) => {r,g,b} | null
     *                                  Return null to pass through to lower layers
     * @param {string[]} [opts.watchProperties=[]] - FileStateManager property names that
     *   should trigger color re-resolution for the affected file. When a watched property
     *   changes, _handlePropertyChanged re-resolves and applies the color immediately
     *   without waiting for a full updateAllColors() call.
     */
    registerLayer(name, { priority, colorFn, watchProperties = [] }) {
        // Remove existing layer with same name
        this._layers = this._layers.filter(l => l.name !== name);

        this._layers.push({ name, priority, colorFn, enabled: true, watchProperties });
        // Keep sorted by priority descending (highest first)
        this._layers.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Toggle a color layer on/off.
     * @param {string} name - Layer identifier
     * @param {boolean} enabled
     */
    setLayerEnabled(name, enabled) {
        const layer = this._layers.find(l => l.name === name);
        if (layer) {
            layer.enabled = enabled;
            this.updateAllColors();
        }
    }

    /**
     * Check if a layer is currently enabled.
     * @param {string} name
     * @returns {boolean}
     */
    isLayerEnabled(name) {
        const layer = this._layers.find(l => l.name === name);
        return layer ? layer.enabled : false;
    }

    /**
     * Recompute and apply colors to all grids.
     * Call this after bulk property changes or layer toggles.
     */
    updateAllColors() {
        const grids = this.ctx.getGrids();
        const hasActiveLayers = this._layers.some(l => l.enabled);

        for (const grid of grids) {
            const sourcePath = grid.userData?.sourcePath;
            if (!sourcePath) continue;

            const color = this._resolveColor(sourcePath);
            if (color) {
                this._applyColorToGrid(grid, color, hasActiveLayers);
            }
        }
    }

    /**
     * Revert all grids to default (white) coloring with multiply mode.
     */
    resetAllColors() {
        const grids = this.ctx.getGrids();
        const white = { r: 1, g: 1, b: 1 };
        for (const grid of grids) {
            this._applyColorToGrid(grid, white, false);
        }
    }

    /**
     * Clean up — unsubscribe from FileStateManager.
     */
    dispose() {
        this.fileStateManager.offPropertyChanged(this._onPropertyChanged);
        this._layers = [];
    }

    // ============ Private ============

    /**
     * Called when a file property changes. Recomputes color for that file
     * if any enabled layer watches the changed property.
     * @private
     */
    _handlePropertyChanged(sourcePath, propName, newValue, oldValue) {
        // Only react to property changes that at least one enabled layer cares about.
        // Layers declare their watched properties via watchProperties in registerLayer().
        // Layers with an empty watchProperties array are skipped for reactive updates
        // (they still participate in updateAllColors() calls).
        const anyLayerWatches = this._layers.some(
            l => l.enabled && l.watchProperties && l.watchProperties.includes(propName)
        );
        if (!anyLayerWatches) return;

        const grids = this.ctx.getGrids();
        const grid = grids.find(g => g.userData?.sourcePath === sourcePath);
        if (!grid) return;

        const hasActiveLayers = this._layers.some(l => l.enabled);
        const color = this._resolveColor(sourcePath);
        if (color) {
            this._applyColorToGrid(grid, color, hasActiveLayers);
        }
    }

    /**
     * Walk layers by priority, return first non-null color.
     * @private
     * @param {string} sourcePath
     * @returns {{r: number, g: number, b: number} | null}
     */
    _resolveColor(sourcePath) {
        const fileProps = this.fileStateManager.getProperties(sourcePath);

        for (const layer of this._layers) {
            if (!layer.enabled) continue;

            const color = layer.colorFn(sourcePath, fileProps);
            if (color) return color;
        }

        // No layer produced a color — return white (neutral)
        return { r: 1, g: 1, b: 1 };
    }

    /**
     * Apply a color to a grid via group coloring.
     * Uses replace blend mode (1.0) when layers are active so the heatmap
     * color fully replaces the default instance color (green).
     * Reverts to multiply mode (0.0) when no layers are active.
     * @private
     * @param {CodeGrid} grid
     * @param {{r: number, g: number, b: number}} color
     * @param {boolean} useReplaceMode - true to use replace blend, false for multiply
     */
    _applyColorToGrid(grid, color, useReplaceMode) {
        const collection = grid.getCollection();
        if (!collection) return;

        collection.setGroupColor(0, color);
        collection.setGroupColorBlend(0, useReplaceMode ? 1.0 : 0.0);
    }
}

export default CodeColorManager;
