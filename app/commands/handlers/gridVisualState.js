/**
 * Shared grid visual state save/restore helpers.
 *
 * Used by both annotationCommands (highlight.grid / highlight.clear)
 * and agentLayoutCommands (layout.focus / layout.undim) to avoid
 * conflicting modifications to the same grid.
 *
 * State is stored in ctx.gridVisualState (Map<number, SavedState>).
 * First-writer-wins: once a grid's state is saved, subsequent saves
 * are no-ops until the state is restored.
 */

import { COLORS } from './colorConstants.js';

/**
 * Save a grid's visual state before modification. First-writer-wins.
 * @param {Object} ctx - command context with gridVisualState Map and getGrids()
 * @param {number} gridIndex
 */
export function saveGridState(ctx, gridIndex) {
    if (ctx.gridVisualState.has(gridIndex)) return;
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return;
    ctx.gridVisualState.set(gridIndex, {
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
    const saved = ctx.gridVisualState.get(gridIndex);
    if (!saved) return false;
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) {
        ctx.gridVisualState.delete(gridIndex);
        return false;
    }
    grid.position.z = saved.originalZ;
    grid.scale.setScalar(saved.originalScale);
    const coll = grid.getCollection?.() || grid.collection || grid.glyphCollection;
    if (coll?.setGroupColor) {
        coll.setGroupColor(0, saved.originalColor);
    }
    ctx.gridVisualState.delete(gridIndex);
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
