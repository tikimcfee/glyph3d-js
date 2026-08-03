/**
 * Shared grid visual state save/restore helpers.
 *
 * Used by annotationCommands (highlight.grid / highlight.clear) to save and
 * restore a grid's pre-emphasis visual state without conflicting modifications.
 *
 * State is stored in ctx.gridVisualState (Map<string, SavedState>), keyed by
 * registry ID (not index) so registry reorders don't corrupt state.
 * First-writer-wins: once a grid's state is saved, subsequent saves
 * are no-ops until the state is restored.
 */

import { COLORS } from './colorConstants.js';

/**
 * Save a grid's visual state before modification. First-writer-wins.
 * @param {Object} ctx - command context with gridVisualState Map, getGrids(), and registry
 * @param {number} gridIndex
 */
export function saveGridState(ctx, gridIndex) {
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return;
    // Key by registry ID, not index — registry reorders can corrupt index-keyed state.
    const id = ctx.registry?.getIdByGrid?.(grid);
    if (!id) return;
    if (ctx.gridVisualState.has(id)) return;
    ctx.gridVisualState.set(id, {
        originalZ: grid.position.z,
        originalScale: grid.scale.x,
        originalColor: { ...COLORS.IDENTITY },
    });
}

/**
 * Restore a grid to its saved visual state.
 * @param {Object} ctx - command context
 * @param {number} gridIndex
 * @returns {boolean} true if state was restored
 */
export function restoreGridState(ctx, gridIndex) {
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return false;
    const id = ctx.registry?.getIdByGrid?.(grid);
    if (!id) return false;
    const saved = ctx.gridVisualState.get(id);
    if (!saved) return false;
    grid.position.z = saved.originalZ;
    grid.scale.setScalar(saved.originalScale);
    const coll = grid.getRenderer?.();
    if (coll?.setGroupColor) {
        coll.setGroupColor(0, saved.originalColor);
    }
    ctx.gridVisualState.delete(id);
    return true;
}

/**
 * Restore all modified grids to their saved visual state.
 * @param {Object} ctx - command context
 * @returns {number} count of restored grids
 */
export function restoreAllGridStates(ctx) {
    const keys = [...ctx.gridVisualState.keys()];
    let count = 0;
    for (const idx of keys) {
        if (restoreGridState(ctx, idx)) count++;
    }
    return count;
}
