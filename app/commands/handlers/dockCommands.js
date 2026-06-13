/**
 * dock.* commands — the camera-locked HUD bar of window tiles (CameraDock).
 *
 * Distinct from panel.* (the DOM dockview side panels, ctx.dock): these drive the
 * 3D bar in the canvas (ctx.cameraDock). A docked window is the SAME live grid /
 * terminal, dimensionally scaled into a tile that rides the camera. lock/release
 * animate the slide + resize; the bar re-packs itself.
 *
 * State of record is AttentionManager.docks (CameraDock writes it), so attention.info
 * and the session store see docked membership for free.
 */

function getDock(ctx) {
    return ctx.cameraDock && typeof ctx.cameraDock.lock === 'function' ? ctx.cameraDock : null;
}

/**
 * Resolve a registry id OR a surface index (grids + terminals) to { id, grid }.
 * Unlike resolveGridByIdOrIndex (code grids only), the dock takes any framed
 * surface — a terminal docks exactly like a file.
 */
function resolveSurface(ctx, arg) {
    const key = String(arg ?? '');
    const entry = ctx.registry?.get?.(key);
    if (entry) return { id: entry.id, grid: entry.grid };

    if (/^\d+$/.test(key)) {
        const surfaces = ctx.getSurfaces?.() || ctx.getGrids?.() || [];
        const i = parseInt(key, 10);
        const grid = surfaces[i];
        if (grid) {
            const id = ctx.registry?.getIdByGrid?.(grid);
            if (id) return { id, grid };
        }
    }
    return null;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerDockCommands(router) {
    router.register('dock.lock', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = resolveSurface(ctx, args[0]);
        if (!r) return { text: `ERR: no surface for "${args[0]}" (registry id or surface index)`, data: null };
        if (dock.has(r.id)) return { text: `OK: '${r.id}' already docked`, data: { id: r.id, docked: true } };
        dock.lock(r.id, r.grid);
        return { text: `OK: docked '${r.id}'`, data: { id: r.id, docked: true } };
    }, { description: 'Dock a surface into the camera-locked HUD bar', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.release', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = resolveSurface(ctx, args[0]);
        const id = r?.id ?? String(args[0] ?? '');
        if (!dock.has(id)) return { text: `ERR: '${id}' is not docked`, data: null };
        dock.release(id);
        return { text: `OK: released '${id}'`, data: { id, docked: false } };
    }, { description: 'Release a docked surface back into the world', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.toggle', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = resolveSurface(ctx, args[0]);
        if (!r) return { text: `ERR: no surface for "${args[0]}" (registry id or surface index)`, data: null };
        const state = dock.toggle(r.id, r.grid);
        return { text: `OK: ${state} '${r.id}'`, data: { id: r.id, docked: state === 'locked' } };
    }, { description: 'Dock a surface if loose, release it if docked', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.list', (_args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const tiles = dock.list();
        const summary = tiles.length
            ? tiles.map((t) => `[${t.slot}] ${t.id}`).join('  ')
            : '(empty)';
        return { text: `OK: dock (${dock.layoutMode}) — ${summary}`, data: { tiles, layout: dock.layoutMode } };
    }, { description: 'List the docked tiles and the bar layout', returns: '{ tiles:[{id,slot}], layout }' });

    router.register('dock.layout', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const mode = String(args[0] ?? '').toLowerCase();
        if (!dock.setLayout(mode)) return { text: 'ERR: usage: dock.layout <linear|radial>', data: null };
        return { text: `OK: dock layout ${mode}`, data: { layout: mode } };
    }, { description: 'Set the dock tile arrangement', usage: '<linear|radial>', returns: '{ layout }' });

    router.register('dock.focus', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = resolveSurface(ctx, args[0]);
        const id = r?.id ?? String(args[0] ?? '');
        if (!dock.has(id)) return { text: `ERR: '${id}' is not docked`, data: null };
        // Frame the captured HOME bounds (stable) — read BEFORE release drops the entry —
        // then release the tile back home and make it the focus. Window slides home while
        // the camera flies to meet it.
        const box = dock.homeBounds(id);
        dock.release(id);
        if (box) ctx.cameraController?.focusOnBox?.(box);
        ctx.attentionManager?.set('primary', id, { registry: ctx.registry });
        return { text: `OK: focused '${id}'`, data: { id, docked: false } };
    }, { description: 'Release a docked surface and fly to frame it', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.clear', (_args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const n = dock.list().length;
        dock.releaseAll();
        return { text: `OK: released ${n} tile(s)`, data: { released: n } };
    }, { description: 'Release every docked surface', returns: '{ released }' });

    router.register('dock.set', (args, ctx) => {
        const dock = getDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const key = String(args[0] ?? '');
        const value = parseFloat(args[1]);
        if (!dock.setParam(key, value)) {
            return { text: 'ERR: usage: dock.set <distance|tileFrac|bottomFrac> <number>', data: null };
        }
        return { text: `OK: dock ${key} = ${value}`, data: { key, value } };
    }, { description: 'Tune a dock layout parameter live', usage: '<distance|tileFrac|bottomFrac> <number>', returns: '{ key, value }' });
}
