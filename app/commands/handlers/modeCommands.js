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
    resolveAdjacencies,
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
        // Reader frames the file SQUARED to its face: computeGridFocus carries the reverse-billboard
        // pitch/yaw, so the ease tweens orientation alongside position (a rotated file reads head-on,
        // not as a sliver). The agent/bounds path leaves pitch/yaw undefined → the axis-aligned ease.
        const tp = Number.isFinite(target.pitch) ? target.pitch : undefined;
        const ty = Number.isFinite(target.yaw) ? target.yaw : undefined;
        if (animate) {
            animateCamera(ctx, target.x, target.y, target.z, READER_ANIMATE_MS, tp, ty);
        } else {
            ctx.camera.position.set(target.x, target.y, target.z);
            if (cc && tp !== undefined) { cc.pitch = tp; cc.yaw = ty; cc._applyRotation?.(); }
        }
    } else if (regIdx >= 0) {
        // Fall back to the snap path if target math returned null.
        cc?.focusOnGrid?.(regIdx);
    } else {
        const aabb = getWorldBounds(grid);
        if (aabb) frameBounds(ctx, aabb, 1.0);
    }

    // Attention: write primary through AttentionManager (single writer).
    // Reader mode's "sticky" focus falls out of having attention.primary set —
    // the GPU hover pick (CanvasPicker) is the single hover writer.
    ctx.attentionManager.set('primary', registryId || null,
        { entity: ctx.registry?.get?.(registryId) || null });
    ctx.mode.state = 'reader';

    if (ctx.readerCompass) {
        // Reader compass considers grid/agent/terminal entries. L0 widened
        // this filter; once L2 lands `dock.*`, camera-docked terminals should
        // be excluded here (compass arrow pointing at something glued to the
        // camera is incoherent).
        const entries = ctx.registry
            ? ctx.registry.list().filter(e => e.type === 'grid' || e.type === 'agent' || e.type === 'terminal')
            : [];
        ctx.readerCompass.update({ currentId: ctx.attention.primary?.id ?? null, entries });
        ctx.readerCompass.setVisible(true);
    }
    return true;
}

/** Drop reader lock and attention override. */
function enterExplorer(ctx) {
    ctx.attentionManager.clear('primary');
    ctx.mode.state = 'explorer';
    if (ctx.readerCompass) ctx.readerCompass.setVisible(false);
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
            data: { mode: 'reader', primaryId: ctx.attention.primary?.id ?? null, index: resolved.idx },
        };
    }, { description: 'Enter reader mode on a grid', usage: '<index|id|name>' });

    router.register('mode.explorer', (args, ctx) => {
        enterExplorer(ctx);
        return {
            text: 'OK: explorer',
            data: { mode: 'explorer', primaryId: null },
        };
    }, { description: 'Leave reader and return to free-camera explorer' });

    router.register('mode.toggle', (args, ctx) => {
        if (ctx.mode.state === 'reader') {
            enterExplorer(ctx);
            return { text: 'OK: explorer', data: { mode: 'explorer', primaryId: null } };
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
            data: { mode: 'reader', primaryId: ctx.attention.primary?.id ?? null, index: resolved.idx },
        };
    }, { description: 'Toggle reader ↔ explorer (reader needs a target arg)' });

    router.register('mode.info', (args, ctx) => {
        const a = ctx.attention;
        return {
            text: `OK: mode=${ctx.mode.state} primary=${a.primary?.id ?? 'null'} hover=${a.hover?.id ?? 'null'} key=${a.key?.id ?? 'null'}`,
            data: {
                mode: ctx.mode.state,
                primaryId: a.primary?.id ?? null,
                hoverId:   a.hover?.id ?? null,
                keyId:     a.key?.id ?? null,
            },
        };
    }, { description: 'Show current interaction mode and attention snapshot' });

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
        const currentId = ctx.attention.primary?.id ?? null;
        let currentIdx = entries.findIndex(e => e.id === currentId);
        if (currentIdx < 0) currentIdx = 0;
        const nextIdx = ((currentIdx + delta) % entries.length + entries.length) % entries.length;
        const nextEntry = entries[nextIdx];
        const grids = ctx.getGrids();
        const gridIdx = grids.indexOf(nextEntry.grid); // -1 for agent windows
        enterReader(ctx, nextEntry.grid, gridIdx, nextEntry.id);
        return {
            text: `OK: reader "${nextEntry.id}" (${currentIdx}→${nextIdx})`,
            data: { mode: 'reader', primaryId: nextEntry.id, index: nextIdx },
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
        const adj = resolveAdjacencies(ctx, ctx.attention.primary?.id ?? null);
        const entry = adj[dir];
        if (!entry) {
            return { text: `OK: no grid ${dir} of current`, data: { direction: dir, target: null } };
        }
        const grids = ctx.getGrids();
        const gridIdx = grids.indexOf(entry.grid);
        enterReader(ctx, entry.grid, gridIdx, entry.id);
        return {
            text: `OK: reader "${entry.id}" (${dir})`,
            data: { mode: 'reader', primaryId: entry.id, direction: dir },
        };
    }, { description: 'Reader mode: jump to adjacent grid', usage: '<up|down|left|right>' });

    router.register('mode.adjacencies', (args, ctx) => {
        const primaryId = ctx.attention.primary?.id ?? null;
        if (!primaryId) {
            return { text: 'OK: no current reader target', data: { adjacencies: {} } };
        }
        const adj = resolveAdjacencies(ctx, primaryId);
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
