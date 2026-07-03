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
 *
 * window.pin raises a window into the CameraDock's root VIEW-FRAME — camera-front-locked,
 * contain-fit to a configurable rect of the drawing frame (margin + offset), recomputed
 * live. Pin and dock-spotlight are the SAME state; pin just ensures the window is docked
 * first. It carries NO zoom of its own — the frame owns the size (see CameraDock._placePane).
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
        // The model owns the zoom (the persisted decider; the grid's scaleModel is the live cache we
        // just told). Capture serializes it; the dock reconcile re-applies it as a tile re-adopts.
        ctx.workspace?.setSurfaceView?.(r.id, ctx.registry?.get?.(r.id)?.type, { zoom: z });
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
        const dock = ctx.cameraDock;
        if (!dock) return { text: 'ERR: camera dock not ready', data: null };
        const id = r.id;

        // Pin = OCCUPY THE ROOT VIEW-FRAME: the window rides the camera front and contain-fits the
        // drawing frame (margin + offset, recomputed live from frustum + grid state). It IS the
        // dock's frame-occupant state — pin and dock-spotlight are one thing — so pinning a loose
        // window first docks it, then raises it into the frame. The Pin button is driven by
        // CameraDock.spotlight, so it stays truthful whoever set the occupancy (button, click, CLI).
        const kind = ctx.registry?.get?.(id)?.type;
        const isFramed = dock.isFramed?.(id) ?? false;
        // Explicit on|off is the idempotent state-setter (CLI/RPC); no arg toggles (the button).
        const arg = String(args[1] ?? '').toLowerCase();
        const want = ['on', 'true', '1'].includes(arg) ? true
                   : ['off', 'false', '0'].includes(arg) ? false
                   : !isFramed;
        if (want === isFramed) {
            return { text: `OK: '${id}' already ${want ? 'pinned' : 'unpinned'}`, data: { id, pinned: want } };
        }

        if (want) {
            // Pin/unpin is a reversible toggle: if pin had to dock a LOOSE window, remember that so
            // unpin sends it back HOME — a window already in the bar stays in the bar on unpin.
            const wasDocked = dock.has(id);
            if (!wasDocked) router.execute(['dock.lock', id]); // frame occupancy is a dock state
            router.execute(['dock.spotlight', id]);            // raise into the frame (+ focus/keyboard)
            if (!wasDocked) ctx.workspace?.setSurfaceView?.(id, kind, { pinAutoDocked: true });
        } else {
            router.execute(['dock.spotlight', id]);            // toggle off → vacate the frame
            if (ctx.workspace?.getSurface?.(id)?.view?.pinAutoDocked) {
                ctx.workspace?.setSurfaceView?.(id, kind, { pinAutoDocked: false });
                router.execute(['dock.release', id]);          // pin docked it → unpin sends it home
            }
        }
        ctx.session?.scheduleSave?.();
        return {
            text: `OK: ${want ? `pinned '${id}' → frame` : `unpinned '${id}'`}`,
            data: { id, pinned: want },
        };
    }, {
        description: 'Pin a window into the root view-frame (camera-front, contain-fit to the drawing frame); toggle',
        usage: '<id|index> [on|off]',
        returns: '{ id, pinned }',
    });
}
