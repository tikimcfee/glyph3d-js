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
 *
 * window.drop sets a window down directly in front of the camera: billboard-faced
 * (computed once at the drop — never locked) at the distance where it fills a view
 * fraction, then free to move like any window. Held windows (dock tile, carrel seat)
 * are released TO that pose (the holder's own glide, re-aimed); loose windows are
 * placed directly. The undock-home path (ctrl-click, dock.release) is untouched —
 * drop is the "bring it to me" alternative, not a replacement.
 */

import * as THREE from 'three';
import { zDistanceForFit } from '@glyph3d/core/services/spatial/spatialMath.js';
import { resolveSurface } from './dockCommands.js';
import { findCarrelOwner } from './carrelCommands.js';

// Default view-height fraction a dropped window lands at (arg 2 overrides per call).
const DROP_FILL = 0.45;

/**
 * The camera-front landing pose for a window: centered on the view ray, facing the
 * camera, at the distance where its landing footprint fills `frac` of the view.
 * @param {Object} cam active perspective camera
 * @param {Object} grid live window Object3D
 * @param {{scale:number}|null} holderHome the holder's home record when held (its
 *   landing PLACEMENT scale); null when loose (current placement wins)
 * @param {number} frac view fill fraction
 * @returns {{pos:THREE.Vector3, quat:THREE.Quaternion}} world-space pose
 */
function dropPose(cam, grid, holderHome, frac) {
    const placement = holderHome ? holderHome.scale
        : (grid.scaleModel ? grid.scaleModel.placement : (grid.scale.x || 1));
    const z = grid.zoom;
    const zoom = typeof z === 'number' ? z : (z?.y ?? 1);
    const eff = (placement * zoom) || 1;

    // Landing footprint from the local bounds at the landing scale; the dock's own
    // fallback extent when a transient read comes up empty.
    const local = grid.getLocalBounds?.();
    const hasLocal = local && !local.isEmpty?.();
    const w = (hasLocal ? Math.max(local.max.x - local.min.x, 1e-3) : 16) * eff;
    const h = (hasLocal ? Math.max(local.max.y - local.min.y, 1e-3) : 10) * eff;
    const dist = Math.max(zDistanceForFit(cam, w, h, frac), (cam.near || 0.1) * 3);

    const quat = cam.quaternion.clone();
    const pos = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
        .multiplyScalar(dist).add(cam.position);
    // Land the window's CENTER on the ray — its origin is a corner, not its middle.
    if (hasLocal) {
        pos.sub(new THREE.Vector3(
            (local.min.x + local.max.x) / 2,
            (local.min.y + local.max.y) / 2,
            (local.min.z + local.max.z) / 2,
        ).multiplyScalar(eff).applyQuaternion(quat));
    }
    return { pos, quat };
}

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

    router.register('window.drop', (args, ctx) => {
        const r = resolveSurface(ctx, args[0]);
        if (!r) return { text: `ERR: no surface for "${args[0]}" (registry id or surface index)`, data: null };
        const cam = ctx.camera;
        if (!cam) return { text: 'ERR: camera not ready', data: null };
        const id = r.id;

        const fillArg = parseFloat(args[1]);
        const frac = Number.isFinite(fillArg) && fillArg > 0 ? fillArg : DROP_FILL;

        const dock = ctx.cameraDock;
        const docked = !!dock?.has?.(id);
        const carrel = findCarrelOwner(ctx, id);
        const holderHome = docked ? dock.homeOf(id) : (carrel ? carrel.homeOf(id) : null);
        const { pos, quat } = dropPose(cam, r.grid, holderHome, frac);
        const to = { parent: ctx.scene || null, pos: { x: pos.x, y: pos.y, z: pos.z }, quat };

        let from = 'loose';
        if (docked) {
            from = 'dock';
            ctx.workspace?.setSurfaceView?.(id, undefined, { docked: false });
            dock.release(id, { to });
            // A seat the dock had borrowed from goes stale the moment the window takes
            // up free residence — clear it (a borrowed release drops the entry, no motion).
            if (carrel) {
                ctx.workspace?.setSurfaceView?.(id, undefined, { carrel: null });
                carrel.release(id);
            }
        } else if (carrel) {
            from = `carrel '${carrel.carrelName}'`;
            ctx.workspace?.setSurfaceView?.(id, undefined, { carrel: null });
            carrel.release(id, { to });
        } else {
            // Loose: no holder glide to ride — place it directly, in its own parent's
            // space (a tree-resident stays a resident; the next tree relayout may
            // re-seat it — drop is at home with free-floating windows and held tiles).
            const g = r.grid;
            if (g.parent && g.parent !== ctx.scene) {
                g.position.copy(g.parent.worldToLocal(pos.clone()));
                g.quaternion.copy(g.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(quat));
            } else if (typeof g.setWorldPosition === 'function') {
                g.setWorldPosition({ x: pos.x, y: pos.y, z: pos.z }); // terminals move through their one method
                g.quaternion.copy(quat);
            } else {
                g.position.copy(pos);
                g.quaternion.copy(quat);
            }
        }
        // The landing is a MOVE, so it obeys the mover's law: record the destination in the
        // model (what terminal.move / drag-end do). Without this the next registry change
        // re-projects the STALE fact onto the grid — the dropped window teleports back.
        ctx.workspace?.setSurfaceView?.(id, ctx.registry?.get?.(id)?.type, { position: { x: pos.x, y: pos.y, z: pos.z } });
        ctx.session?.scheduleSave?.();
        return {
            text: `OK: dropped '${id}' before the camera (was ${from})`,
            data: { id, from: docked ? 'dock' : carrel ? 'carrel' : 'loose', position: { x: pos.x, y: pos.y, z: pos.z } },
        };
    }, {
        description: 'Set a window down directly in front of the camera (billboard-faced, then free); releases it from the dock/carrel holding it',
        usage: '<id|index> [fill]',
        returns: '{ id, from, position }',
    });
}
