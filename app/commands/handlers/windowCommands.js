/**
 * window.* commands — window-level spatial transforms that are independent of a
 * window's CONTENT (cols/rows, layout) and of whether it is docked.
 *
 * window.scale sets the user ZOOM: the Object3D readability scale, orthogonal to
 * terminal.resize (which reshapes the PTY) and to the dock's tile-fit. It composes
 * through each window's ScaleModel (placement · user), so the single transform
 * authority stays one place. A docked window contain-fits a FIXED slot box, so zoom never
 * changes its bar FOOTPRINT (the box wins) — it shows when the tile is spotlit or returns
 * home; we re-place a docked target so its bar tile stays box-fit as the zoom moves.
 */

import { resolveSurface } from './dockCommands.js';

/** Parse a zoom arg: "1.5" → uniform 1.5; "1.5,1.5,1" → the deliberate stretch tuple. */
function parseZoom(arg) {
    const s = String(arg ?? '').trim();
    if (s.includes(',')) {
        const [x, y, z] = s.split(',').map((v) => parseFloat(v));
        if (![x, y, z].every(Number.isFinite)) return null;
        return { x, y, z };
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerWindowCommands(router) {
    router.register('window.scale', (args, ctx) => {
        const r = resolveSurface(ctx, args[0]);
        if (!r) return { text: `ERR: no surface for "${args[0]}" (registry id or surface index)`, data: null };
        if (typeof r.grid.setZoom !== 'function') {
            return { text: `ERR: '${r.id}' is not scalable`, data: null };
        }
        const zoom = parseZoom(args[1]);
        if (zoom === null) return { text: 'ERR: usage: window.scale <id|index> <factor | x,y,z>', data: null };

        r.grid.setZoom(zoom);

        // A docked tile renders box-fit in the bar (zoom divided out of its placement) and
        // zoom-applied in the focus area. setZoom moved `user`, so re-place the tile to fold
        // the new zoom back through: a bar tile stays box-fit, the spotlit tile free-grows.
        // Loose windows already updated via setZoom→resolve.
        const dock = ctx.cameraDock;
        if (dock?.has?.(r.id)) dock.reflowTile(r.id);

        const z = r.grid.zoom;
        ctx.session?.scheduleSave?.();
        return { text: `OK: scaled '${r.id}' → ${z.toFixed?.(3) ?? z}`, data: { id: r.id, zoom: z } };
    }, {
        description: 'Set a window\'s readability zoom (Object3D scale; independent of resize/PTY)',
        usage: '<id|index> <factor | x,y,z>',
        returns: '{ id, zoom }',
    });

    router.register('window.pin', (args, ctx) => {
        const r = resolveSurface(ctx, args[0]);
        if (!r) return { text: `ERR: no surface for "${args[0]}" (registry id or surface index)`, data: null };
        if (typeof r.grid.setZoom !== 'function') return { text: `ERR: '${r.id}' is not pinnable`, data: null };
        const id = r.id;
        const kind = ctx.registry?.get?.(id)?.type || 'surface';
        // Pin state is a per-surface view field — the durable "verb mutates state idempotently"
        // home (WorkspaceModel.surfaces[id].view): { pinned, prePinZoom }. The live size IS the
        // zoom; pin snaps it to the max and remembers the prior value to restore on unpin.
        const view = ctx.workspace?.getSurface?.(id)?.view || {};
        const isPinned = !!view.pinned;
        // Explicit on|off is the idempotent state-setter (CLI/RPC); no arg toggles (the button).
        const arg = String(args[1] ?? '').toLowerCase();
        const want = ['on', 'true', '1'].includes(arg) ? true
                   : ['off', 'false', '0'].includes(arg) ? false
                   : !isPinned;
        const maxPinZoom = ctx.windowConfig?.maxPinZoom ?? 3;

        if (want) {
            // Capture the pre-pin zoom only on the 0→1 edge, so re-pinning an already-pinned
            // window re-asserts the max without clobbering the saved restore value (idempotent).
            const prePinZoom = isPinned ? (view.prePinZoom ?? 1) : (r.grid.zoom ?? 1);
            ctx.workspace?.setSurfaceView?.(id, kind, { pinned: true, prePinZoom });
            router.execute(['window.scale', id, String(maxPinZoom)]); // saves + reflows a docked tile
        } else {
            const restore = view.prePinZoom ?? (r.grid.zoom ?? 1);
            ctx.workspace?.setSurfaceView?.(id, kind, { pinned: false, prePinZoom: null });
            if (isPinned) router.execute(['window.scale', id, String(restore)]);
        }
        // Reflect the pinned state on the window's Pin button (any caller — button, CLI, palette).
        if (typeof r.grid.setControlActive === 'function') r.grid.setControlActive('pin', want);
        ctx.session?.scheduleSave?.();
        return {
            text: `OK: ${want ? `pinned '${id}' → ×${maxPinZoom}` : `unpinned '${id}'`}`,
            data: { id, pinned: want },
        };
    }, {
        description: 'Maximize a window to the max pin zoom (toggle); unpin restores the prior zoom',
        usage: '<id|index> [on|off]',
        returns: '{ id, pinned }',
    });
}
