/**
 * HeatmapProvider — per-file heat metric computation
 *
 * Computes normalized (0..1) metrics for each file and writes them
 * to FileStateManager. CodeColorManager reacts to these properties
 * and applies colors to grids.
 *
 * Must be called after all grids are flushed and laid out
 * (i.e., after `await loadRepository()` completes).
 *
 * Uses grid.getLineCount() and grid.getMaxLineWidth() which trigger
 * lazy line splitting for async-loaded grids — do NOT read
 * grid.lines.length directly.
 */

/**
 * Default color ramp: cool blue → warm red
 * @param {number} t - 0..1 value
 * @returns {{r: number, g: number, b: number}}
 */
function heatColorRamp(t) {
    // Blue (0.3, 0.5, 1.0) → Green (0.3, 1.0, 0.3) → Yellow (1.0, 1.0, 0.3) → Red (1.0, 0.3, 0.2)
    if (t < 0.33) {
        const s = t / 0.33;
        return {
            r: 0.3,
            g: 0.5 + 0.5 * s,
            b: 1.0 - 0.7 * s,
        };
    } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        return {
            r: 0.3 + 0.7 * s,
            g: 1.0,
            b: 0.3,
        };
    } else {
        const s = (t - 0.66) / 0.34;
        return {
            r: 1.0,
            g: 1.0 - 0.7 * s,
            b: 0.3 - 0.1 * s,
        };
    }
}

export class HeatmapProvider {
    /**
     * @param {SceneContext} ctx
     * @param {FileStateManager} fileStateManager
     */
    constructor(ctx, fileStateManager) {
        this.ctx = ctx;
        this.fileStateManager = fileStateManager;
    }

    /**
     * Compute heat metrics for all loaded grids and write to FileStateManager.
     * Must be called after grids are fully loaded and laid out.
     */
    computeMetrics() {
        const grids = this.ctx.getGrids();
        if (grids.length === 0) return;

        // Phase 1: Gather raw metrics
        const rawMetrics = [];
        for (const grid of grids) {
            const sourcePath = grid.userData?.sourcePath;
            if (!sourcePath) continue;

            const lineCount = grid.getLineCount();
            const fileSize = grid.content ? grid.content.length : 0;
            const maxLineWidth = grid.getMaxLineWidth();

            rawMetrics.push({ sourcePath, lineCount, fileSize, maxLineWidth });
        }

        if (rawMetrics.length === 0) return;

        // Phase 2: Find min/max for normalization
        let minLines = Infinity, maxLines = 0;
        let minSize = Infinity, maxSize = 0;
        let minWidth = Infinity, maxWidth = 0;

        for (const m of rawMetrics) {
            minLines = Math.min(minLines, m.lineCount);
            maxLines = Math.max(maxLines, m.lineCount);
            minSize = Math.min(minSize, m.fileSize);
            maxSize = Math.max(maxSize, m.fileSize);
            minWidth = Math.min(minWidth, m.maxLineWidth);
            maxWidth = Math.max(maxWidth, m.maxLineWidth);
        }

        // Phase 3: Normalize and compute weighted heat metric
        const rangeLines = maxLines - minLines || 1;
        const rangeSize = maxSize - minSize || 1;
        const rangeWidth = maxWidth - minWidth || 1;

        const updates = new Map();
        for (const m of rawMetrics) {
            const normLines = (m.lineCount - minLines) / rangeLines;
            const normSize = (m.fileSize - minSize) / rangeSize;
            const normWidth = (m.maxLineWidth - minWidth) / rangeWidth;

            // Weighted average: 50% line count, 30% size, 20% width
            const heatMetric = normLines * 0.5 + normSize * 0.3 + normWidth * 0.2;

            updates.set(m.sourcePath, {
                lineCount: m.lineCount,
                fileSize: m.fileSize,
                maxLineWidth: m.maxLineWidth,
                heatMetric,
            });
        }

        // Phase 4: Batch write to FileStateManager
        const metrics = [...updates.values()].map(u => u.heatMetric);
        console.debug(`[HeatmapProvider] ${updates.size} files, heat range: ${Math.min(...metrics).toFixed(3)}..${Math.max(...metrics).toFixed(3)}`);
        this.fileStateManager.batchSetProperties(updates);
    }

    /**
     * Get the heat metric for a file.
     * @param {string} sourcePath
     * @returns {number} 0..1 heat value, or 0 if not computed
     */
    getMetric(sourcePath) {
        return this.fileStateManager.getProperty(sourcePath, 'heatMetric') || 0;
    }

    /**
     * Create a color function suitable for CodeColorManager.registerLayer().
     * Maps heatMetric → color via the heat color ramp.
     * @returns {Function} (sourcePath, fileProps) => {r,g,b} | null
     */
    static createColorFn() {
        return (sourcePath, fileProps) => {
            if (!fileProps || fileProps.heatMetric === undefined) return null;
            return heatColorRamp(fileProps.heatMetric);
        };
    }

    /**
     * No-op — stateless after compute.
     */
    dispose() {}
}

export default HeatmapProvider;
