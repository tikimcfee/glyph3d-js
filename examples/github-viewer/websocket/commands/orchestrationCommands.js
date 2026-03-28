/**
 * Orchestration commands: window.track, window.untrack, window.track.list
 *
 * Bridges TUI windows (agent output) with code grids (source files) in 3D space.
 * Positions agent windows adjacent to tracked code grids and highlights them.
 *
 * Tracking state lives on ctx.windowTracking (Map<windowId, TrackEntry>).
 */

import { getWorldBounds } from './spatialHelpers.js';

/**
 * @typedef {Object} TrackEntry
 * @property {number} gridIndex - index of the tracked code grid
 * @property {number} agentGridIndex - index of the agent's grid
 * @property {number} originalBgColor - original background color hex for restore
 * @property {number} originalBgOpacity - original background opacity for restore
 */

const TRACKING_COLOR = 0x4de680;      // Soft green highlight
const TRACKING_OPACITY = 0.92;
const TRACKING_GAP = 5;               // World units gap between target and agent grid
const TRACKING_Z_FORWARD = 2;         // Slight Z-forward for agent window

/**
 * Ensure ctx.windowTracking Map exists.
 * @param {Object} ctx
 * @returns {Map<string, TrackEntry>}
 */
function ensureTrackingMap(ctx) {
    if (!ctx.windowTracking) {
        ctx.windowTracking = new Map();
    }
    return ctx.windowTracking;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerOrchestrationCommands(router) {

    // ────────────────────────────────────────────────────────
    //  window.track <window-id> <grid-index>
    // ────────────────────────────────────────────────────────

    router.register('window.track', (args, ctx) => {
        if (args.length < 2) {
            return { text: 'ERR: usage: window.track <window-id> <grid-index>', data: null };
        }

        const windowId = args[0];
        const gridIdx = parseInt(args[1]);
        const grids = ctx.getGrids();
        const tracking = ensureTrackingMap(ctx);

        // Validate target grid index
        if (isNaN(gridIdx) || gridIdx < 0 || gridIdx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[1]} (0-${grids.length - 1})`, data: null };
        }

        // Look up the window grid via the scene registry
        const registryEntry = ctx.registry.get(windowId);
        const agentGrid = registryEntry ? registryEntry.grid : null;

        if (!agentGrid) {
            return { text: `ERR: no registered scene object for '${windowId}'`, data: null };
        }

        // Grid may not be in the content grids array (TUI windows aren't)
        const agentGridIdx = grids.indexOf(agentGrid);

        // Clear previous tracking for this window if any
        if (tracking.has(windowId)) {
            _restoreHighlight(grids, tracking.get(windowId));
            tracking.delete(windowId);
        }

        const targetGrid = grids[gridIdx];

        // Get target grid bounds for positioning
        const targetBounds = getWorldBounds(targetGrid);
        if (!targetBounds) {
            return { text: `ERR: grid ${gridIdx} has no bounds`, data: null };
        }

        // Position agent grid to the right of the target grid
        agentGrid.position.set(
            targetBounds.max.x + TRACKING_GAP,
            targetBounds.max.y,
            targetBounds.center.z + TRACKING_Z_FORWARD
        );

        // Save original background state and apply highlight
        const entry = {
            gridIndex: gridIdx,
            agentGridIndex: agentGridIdx,
            originalBgColor: null,
            originalBgOpacity: null,
        };

        if (targetGrid._background) {
            entry.originalBgColor = targetGrid._background.material.color.getHex();
            entry.originalBgOpacity = targetGrid._background.material.opacity;
            targetGrid._background.material.color.set(TRACKING_COLOR);
            targetGrid._background.material.opacity = TRACKING_OPACITY;
        }

        tracking.set(windowId, entry);

        return {
            text: `OK: window '${windowId}' tracking grid #${gridIdx}`,
            data: { windowId, gridIndex: gridIdx, agentGridIndex: agentGridIdx },
        };
    }, { description: 'Attach agent window near a code grid', usage: '<window-id> <grid-index>' });

    // ────────────────────────────────────────────────────────
    //  window.untrack <window-id>
    // ────────────────────────────────────────────────────────

    router.register('window.untrack', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: window.untrack <window-id>', data: null };
        }

        const windowId = args[0];
        const tracking = ensureTrackingMap(ctx);
        const entry = tracking.get(windowId);

        if (!entry) {
            return { text: `ERR: window '${windowId}' is not tracking`, data: null };
        }

        const grids = ctx.getGrids();
        _restoreHighlight(grids, entry);
        tracking.delete(windowId);

        return {
            text: `OK: window '${windowId}' untracked`,
            data: { windowId },
        };
    }, { description: 'Detach agent window from tracked grid', usage: '<window-id>' });

    // ────────────────────────────────────────────────────────
    //  window.track.list
    // ────────────────────────────────────────────────────────

    router.register('window.track.list', (args, ctx) => {
        const tracking = ensureTrackingMap(ctx);

        if (tracking.size === 0) {
            return { text: 'OK: 0 tracked windows', data: { tracked: [], count: 0 } };
        }

        const tracked = [];
        const lines = [];

        for (const [windowId, entry] of tracking) {
            tracked.push({
                windowId,
                gridIndex: entry.gridIndex,
                agentGridIndex: entry.agentGridIndex,
            });
            lines.push(`  ${windowId}: tracking grid #${entry.gridIndex} (agent grid #${entry.agentGridIndex})`);
        }

        return {
            text: lines.join('\n') + `\nOK: ${tracked.length} tracked windows`,
            data: { tracked, count: tracked.length },
        };
    }, { description: 'List all active window tracking pairs' });
}

/**
 * Restore a tracked grid's background to its original state.
 * @param {Array} grids
 * @param {TrackEntry} entry
 */
function _restoreHighlight(grids, entry) {
    const grid = grids[entry.gridIndex];
    if (!grid || !grid._background) return;

    if (entry.originalBgColor !== null) {
        grid._background.material.color.set(entry.originalBgColor);
    }
    if (entry.originalBgOpacity !== null) {
        grid._background.material.opacity = entry.originalBgOpacity;
    }
}
