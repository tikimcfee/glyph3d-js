/**
 * window.* commands — window-level spatial transforms that are independent of a
 * window's CONTENT (cols/rows, layout) and of whether it is docked.
 *
 * window.scale sets the user ZOOM: the Object3D readability scale, orthogonal to
 * terminal.resize (which reshapes the PTY) and to the dock's tile-fit. It composes
 * through each window's ScaleModel (placement · user), so the single transform
 * authority stays one place. When the target is docked, we re-place its tile (its
 * effective footprint changed) so the bar re-packs / the focused tile free-grows.
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

        // Docked tiles size against their zoom — re-place so the row re-packs (or the
        // focused tile free-grows). Loose windows already updated via setZoom→resolve.
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
}
