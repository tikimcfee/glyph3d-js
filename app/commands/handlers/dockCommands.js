/** @import { AppContext } from '../../client/CommandProvider.jsx' */

/**
 * dock.* commands — the camera-locked HUD bar of window tiles (CameraDock).
 *
 * Distinct from panel.* (the DOM dockview side panels, ctx.dock): these drive the
 * 3D bar in the canvas (ctx.cameraDock). A docked window is the SAME live grid /
 * terminal / book, dimensionally scaled into a tile that rides the camera. lock/release
 * animate the slide + resize; the bar re-packs itself.
 *
 * The dock is a VEHICLE: docking a carrel-seated window borrows it, and releasing puts
 * it back in its seat. Membership of record is the workspace model's `view.docked`
 * fact, written only through ctx.holding.dock; the CameraDock is its live projection.
 */

/** The live 3D dock, or null before it's built. @param {AppContext} ctx */
function cameraDock(ctx) {
    return ctx.holding?.dock.live ?? null;
}

/** Resolve a dock verb's address through the one holdable resolver. @param {AppContext} ctx */
function target(ctx, arg) {
    const r = ctx.holding?.resolve(arg);
    if (!r) return { error: 'holding not ready' };
    return r;
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerDockCommands(router) {
    router.register('dock.lock', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = target(ctx, args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        if (dock.has(r.id)) return { text: `OK: '${r.id}' already docked`, data: { id: r.id, docked: true } };
        // Order: an explicit hint, else the next bar slot from the model (the order authority —
        // it persists, and the reconcile reads it back on reload). The fact and the live tile are
        // written together, so the verb is correct by construction.
        const hint = parseFloat(args[1]);
        ctx.holding.dock.lock(r, { order: Number.isFinite(hint) ? hint : undefined });
        return { text: `OK: docked '${r.id}'`, data: { id: r.id, docked: true } };
    }, { description: 'Dock a surface into the camera-locked HUD bar', usage: '<id|index> [order]', returns: '{ id, docked }' });

    router.register('dock.release', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = target(ctx, args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        const id = r.id;
        if (!dock.has(id)) return { text: `ERR: '${id}' is not docked`, data: null };
        ctx.holding.dock.release(id);
        return { text: `OK: released '${id}'`, data: { id, docked: false } };
    }, { description: 'Release a docked window home (a borrowed carrel member goes back to its seat)', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.toggle', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = target(ctx, args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        if (dock.has(r.id)) {
            ctx.holding.dock.release(r.id);
            return { text: `OK: released '${r.id}'`, data: { id: r.id, docked: false } };
        }
        ctx.holding.dock.lock(r);
        return { text: `OK: locked '${r.id}'`, data: { id: r.id, docked: true } };
    }, { description: 'Dock a surface if loose, release it if docked', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.list', (_args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const tiles = dock.list();
        const summary = tiles.length
            ? tiles.map((t) => `[${t.slot}] ${t.id}`).join('  ')
            : '(empty)';
        return { text: `OK: dock (${dock.layoutMode}) — ${summary}`, data: { tiles, layout: dock.layoutMode } };
    }, { description: 'List the docked tiles and the bar layout', returns: '{ tiles:[{id,slot}], layout }' });

    router.register('dock.layout', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const mode = String(args[0] ?? '').toLowerCase();
        if (!dock.setLayout(mode)) return { text: 'ERR: usage: dock.layout <linear|radial>', data: null };
        return { text: `OK: dock layout ${mode}`, data: { layout: mode } };
    }, { description: 'Set the dock tile arrangement', usage: '<linear|radial>', returns: '{ layout }' });

    router.register('dock.focus', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = target(ctx, args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        const id = r.id;
        if (!dock.has(id)) return { text: `ERR: '${id}' is not docked`, data: null };
        // Frame the captured HOME bounds (stable) — read BEFORE release drops the entry —
        // then release the tile back home and make it the focus. Window slides home while
        // the camera flies to meet it.
        const box = dock.homeBounds(id);
        ctx.holding.dock.release(id);
        if (box) ctx.cameraController?.focusOnBox?.(box);
        ctx.attentionManager?.set('primary', id, { registry: ctx.registry });
        return { text: `OK: focused '${id}'`, data: { id, docked: false } };
    }, { description: 'Release a docked surface and fly to frame it', usage: '<id|index>', returns: '{ id, docked }' });

    router.register('dock.spotlight', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const r = target(ctx, args[0]);
        if ('error' in r) return { text: `ERR: ${r.error}`, data: null };
        const id = r.id;
        if (!dock.has(id)) return { text: `ERR: '${id}' is not docked`, data: null };
        const state = dock.spotlight(id); // 'spotlit' | 'returned'
        // Selecting a tile is also a focus gesture, but with NO camera move (it's
        // already in view): set primary + route the keyboard (terminal → key, grid →
        // none) so a docked terminal goes keyboard-live. Lives HERE in the verb — not
        // composed in the click handler — so click, CLI, and RPC behave identically.
        const type = ctx.registry?.get?.(id)?.type;
        ctx.attentionManager?.set('primary', id, { registry: ctx.registry });
        ctx.attentionManager?.set('key', type === 'terminal' ? id : null, { registry: ctx.registry });
        return { text: `OK: ${state} '${id}'`, data: { id, spotlit: state === 'spotlit' } };
    }, { description: 'Spotlight a docked tile (focus area) and focus it (keyboard-live for terminals)', usage: '<id|index>', returns: '{ id, spotlit }' });

    router.register('dock.clear', (_args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const n = dock.list().length;
        ctx.holding.dock.releaseAll();
        return { text: `OK: released ${n} tile(s)`, data: { released: n } };
    }, { description: 'Release every docked surface', returns: '{ released }' });

    router.register('dock.set', (args, ctx) => {
        const dock = cameraDock(ctx);
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const key = String(args[0] ?? '');
        const value = parseFloat(args[1]);
        if (!dock.setParam(key, value)) {
            return { text: 'ERR: usage: dock.set <distance|boxFrac|boxAspect|gapFrac|maxColumns|fillFrac|maxArcDeg|maxRiseDeg|bottomFrac|frameW|frameH|frameX|frameY|frameMarginLeft|frameMarginRight|frameMarginTop|frameMarginBottom|frameDistFrac|animDur|yawRate|borderWidth|borderStrength|ghostOpacity|ghostPulseHz> <number>', data: null };
        }
        return { text: `OK: dock ${key} = ${value}`, data: { key, value } };
    }, { description: 'Tune a dock layout parameter live (also exposed in Settings ▸ Dock)', usage: '<param> <number>', returns: '{ key, value }' });
}
