/**
 * Interaction modes: explorer (free camera, hover hints) and reader
 * (camera snapped + attention locked on one grid).
 *
 * Commands: mode.reader <id|index|name>, mode.explorer, mode.info,
 *           mode.next, mode.prev, mode.toggle
 *
 * All mode transitions go through these commands, even when triggered by
 * a keyboard shortcut — so the WebSocket protocol and the local keybinds
 * are always in sync.
 */

import {
    resolveGridByIdOrIndex,
    getWorldBounds,
    frameBounds,
    computeBoundsFocus,
    animateCamera,
} from './spatialHelpers.js';

const READER_ANIMATE_MS = 350;

/**
 * Apply reader state for a resolved grid (camera ease + attention lock).
 *
 * Works for both file-grids (type 'grid', in ctx.getGrids()) and agent
 * windows (type 'agent', which aren't in getGrids() — regIdx will be -1).
 * Files use cameraController.computeGridFocus for reader-friendly top-alignment;
 * agent windows use computeBoundsFocus for center-framing. Either path eases
 * the camera over READER_ANIMATE_MS when {animate: true} (the default).
 */
function enterReader(ctx, grid, regIdx, registryId, { animate = true } = {}) {
    if (!grid) return false;
    ctx._cancelCameraAnimation?.();

    let target = null;
    if (regIdx >= 0) {
        target = ctx.cameraController.computeGridFocus(regIdx);
    } else {
        const aabb = getWorldBounds(grid);
        if (aabb) target = computeBoundsFocus(ctx.camera, aabb, 1.0);
    }

    const cc = ctx.cameraController;
    if (target) {
        // Zero pitch/yaw immediately so the camera eases along a clean,
        // axis-aligned trajectory — otherwise the single-drain _applyRotation
        // would fight the animation each frame.
        if (cc) {
            cc.pitch = 0;
            cc.yaw = 0;
        }
        if (animate) {
            animateCamera(ctx, target.x, target.y, target.z, READER_ANIMATE_MS);
        } else {
            ctx.camera.position.set(target.x, target.y, target.z);
        }
    } else if (regIdx >= 0) {
        // Fall back to the snap path if target math returned null.
        cc?.focusOnGrid?.(regIdx);
    } else {
        const aabb = getWorldBounds(grid);
        if (aabb) frameBounds(ctx, aabb, 1.0);
    }

    const focus = cc?.input?.focus;
    if (focus) {
        focus.attendedId = registryId || null;
        focus.locked = true;
    }
    ctx.mode.state = 'reader';
    ctx.mode.readerGridId = registryId || null;

    if (ctx.readerCompass) {
        // Reader compass considers grid/agent/terminal entries. L0 widened
        // this filter; once L2 lands `dock.*`, camera-docked terminals should
        // be excluded here (compass arrow pointing at something glued to the
        // camera is incoherent).
        const entries = ctx.registry
            ? ctx.registry.list().filter(e => e.type === 'grid' || e.type === 'agent' || e.type === 'terminal')
            : [];
        ctx.readerCompass.update({ currentId: ctx.mode.readerGridId, entries });
        ctx.readerCompass.setVisible(true);
    }
    return true;
}

/** Drop reader lock and attention override. */
function enterExplorer(ctx) {
    const focus = ctx.cameraController?.input?.focus;
    if (focus) {
        focus.attendedId = null;
        focus.locked = false;
    }
    ctx.mode.state = 'explorer';
    ctx.mode.readerGridId = null;
    if (ctx.readerCompass) ctx.readerCompass.setVisible(false);
}

/**
 * For reader mode: find the nearest adjacent grid in each of the four
 * screen-space directions. Since reader mode always has pitch=yaw=0, screen
 * axes map straight to world XY — no camera-basis projection needed.
 *
 * For each candidate, the axis with the larger |delta| component decides
 * which direction "bucket" it belongs to; within each bucket we pick the
 * smallest Euclidean distance.
 *
 * @returns {{ up: RegistryEntry|null, down: RegistryEntry|null, left: RegistryEntry|null, right: RegistryEntry|null }}
 */
export function resolveAdjacencies(ctx, currentId) {
    const empty = { up: null, down: null, left: null, right: null };
    if (!ctx.registry) return empty;
    const entries = ctx.registry.list().filter(
        e => e.type === 'grid' || e.type === 'agent' || e.type === 'terminal'
    );
    const currentEntry = entries.find(e => e.id === currentId);
    if (!currentEntry) return empty;
    const centerOf = (entry) => {
        const aabb = getWorldBounds(entry.grid);
        return aabb ? aabb.center : null;
    };
    const origin = centerOf(currentEntry);
    if (!origin) return empty;
    const best = { ...empty };
    const bestDist = { up: Infinity, down: Infinity, left: Infinity, right: Infinity };
    for (const entry of entries) {
        if (entry.id === currentId) continue;
        const c = centerOf(entry);
        if (!c) continue;
        const dx = c.x - origin.x;
        const dy = c.y - origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-3) continue;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        const dir = absDx > absDy
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'up'    : 'down');
        if (dist < bestDist[dir]) {
            best[dir] = entry;
            bestDist[dir] = dist;
        }
    }
    return best;
}

function resolveByNameOrFallback(ctx, target) {
    const resolved = resolveGridByIdOrIndex(ctx, target);
    if (!resolved.error) return resolved;
    const grids = ctx.getGrids();
    const matchIdx = grids.findIndex(g => {
        const name = g.getFilename?.() || g.getSourcePath?.() || '';
        return name.toLowerCase().includes(target.toLowerCase());
    });
    if (matchIdx >= 0) {
        const grid = grids[matchIdx];
        const registryId = ctx.registry ? ctx.registry.getIdByGrid(grid) : null;
        return { grid, idx: matchIdx, registryId };
    }
    return { error: `ERR: no grid matching '${target}'` };
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerModeCommands(router) {
    router.register('mode.reader', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: mode.reader <index|id|name>', data: null };
        const target = args.join(' ');
        const resolved = resolveByNameOrFallback(ctx, target);
        if (resolved.error) return { text: resolved.error, data: null };
        if (!enterReader(ctx, resolved.grid, resolved.idx, resolved.registryId)) {
            return { text: `ERR: could not frame grid '${target}'`, data: null };
        }
        return {
            text: `OK: reader "${resolved.registryId || `#${resolved.idx}`}"`,
            data: { mode: 'reader', readerGridId: ctx.mode.readerGridId, index: resolved.idx },
        };
    }, { description: 'Enter reader mode on a grid', usage: '<index|id|name>' });

    router.register('mode.explorer', (args, ctx) => {
        enterExplorer(ctx);
        return {
            text: 'OK: explorer',
            data: { mode: 'explorer', readerGridId: null },
        };
    }, { description: 'Leave reader and return to free-camera explorer' });

    router.register('mode.toggle', (args, ctx) => {
        if (ctx.mode.state === 'reader') {
            enterExplorer(ctx);
            return { text: 'OK: explorer', data: { mode: 'explorer' } };
        }
        // explorer → reader requires a target
        if (args.length < 1) return { text: 'ERR: usage: mode.toggle <index|id|name> (when entering reader)', data: null };
        const target = args.join(' ');
        const resolved = resolveByNameOrFallback(ctx, target);
        if (resolved.error) return { text: resolved.error, data: null };
        if (!enterReader(ctx, resolved.grid, resolved.idx, resolved.registryId)) {
            return { text: `ERR: could not frame grid '${target}'`, data: null };
        }
        return {
            text: `OK: reader "${resolved.registryId || `#${resolved.idx}`}"`,
            data: { mode: 'reader', readerGridId: ctx.mode.readerGridId, index: resolved.idx },
        };
    }, { description: 'Toggle reader ↔ explorer (reader needs a target arg)' });

    router.register('mode.info', (args, ctx) => {
        const focus = ctx.cameraController?.input?.focus;
        return {
            text: `OK: mode=${ctx.mode.state} readerGridId=${ctx.mode.readerGridId ?? 'null'}`,
            data: {
                mode: ctx.mode.state,
                readerGridId: ctx.mode.readerGridId,
                focus: focus
                    ? { attendedId: focus.attendedId, locked: focus.locked }
                    : null,
            },
        };
    }, { description: 'Show current interaction mode' });

    // Reader-only navigation: step to prev/next grid in registry order.
    // In explorer mode these return an error so keybindings can safely fall
    // through without accidentally scrolling the scene.
    const step = (ctx, delta) => {
        if (ctx.mode.state !== 'reader') {
            return { text: 'ERR: mode.next/prev only valid in reader mode', data: null };
        }
        // Walk file-grids, agent windows, and terminals — reader mode frames any.
        const entries = ctx.registry
            ? ctx.registry.list().filter(e => e.type === 'grid' || e.type === 'agent' || e.type === 'terminal')
            : [];
        if (entries.length === 0) return { text: 'ERR: no readable entries', data: null };
        const currentId = ctx.mode.readerGridId;
        let currentIdx = entries.findIndex(e => e.id === currentId);
        if (currentIdx < 0) currentIdx = 0;
        const nextIdx = ((currentIdx + delta) % entries.length + entries.length) % entries.length;
        const nextEntry = entries[nextIdx];
        const grids = ctx.getGrids();
        const gridIdx = grids.indexOf(nextEntry.grid); // -1 for agent windows
        enterReader(ctx, nextEntry.grid, gridIdx, nextEntry.id);
        return {
            text: `OK: reader "${nextEntry.id}" (${currentIdx}→${nextIdx})`,
            data: { mode: 'reader', readerGridId: nextEntry.id, index: nextIdx },
        };
    };
    router.register('mode.next', (args, ctx) => step(ctx, +1),
        { description: 'Reader mode: advance to next grid' });
    router.register('mode.prev', (args, ctx) => step(ctx, -1),
        { description: 'Reader mode: back to previous grid' });

    router.register('mode.jump', (args, ctx) => {
        if (ctx.mode.state !== 'reader') {
            return { text: 'ERR: mode.jump only valid in reader mode', data: null };
        }
        if (args.length < 1) return { text: 'ERR: usage: mode.jump <up|down|left|right>', data: null };
        const dir = args[0].toLowerCase();
        if (!['up', 'down', 'left', 'right'].includes(dir)) {
            return { text: `ERR: invalid direction '${dir}' (up|down|left|right)`, data: null };
        }
        const adj = resolveAdjacencies(ctx, ctx.mode.readerGridId);
        const entry = adj[dir];
        if (!entry) {
            return { text: `OK: no grid ${dir} of current`, data: { direction: dir, target: null } };
        }
        const grids = ctx.getGrids();
        const gridIdx = grids.indexOf(entry.grid);
        enterReader(ctx, entry.grid, gridIdx, entry.id);
        return {
            text: `OK: reader "${entry.id}" (${dir})`,
            data: { mode: 'reader', readerGridId: entry.id, direction: dir },
        };
    }, { description: 'Reader mode: jump to adjacent grid', usage: '<up|down|left|right>' });

    router.register('mode.adjacencies', (args, ctx) => {
        if (!ctx.mode.readerGridId) {
            return { text: 'OK: no current reader target', data: { adjacencies: {} } };
        }
        const adj = resolveAdjacencies(ctx, ctx.mode.readerGridId);
        const summary = {};
        for (const dir of ['up', 'down', 'left', 'right']) {
            summary[dir] = adj[dir] ? adj[dir].id : null;
        }
        return {
            text: `OK: up=${summary.up} down=${summary.down} left=${summary.left} right=${summary.right}`,
            data: { adjacencies: summary },
        };
    }, { description: 'Reader mode: show N/S/E/W neighbors' });
}
