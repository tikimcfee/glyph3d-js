/**
 * Plane commands — READING a flat surface pixel-exact: the camera squares to it and eases (a dolly
 * zoom) to a narrow fov at the depth where its text cells are a whole number of device pixels wide,
 * the surface's top-left on a device-pixel corner, everything in front of it clipped. The math is
 * core `services/camera/planeView.js`; the camera side is ViewerCameraController.enterPlane.
 *
 *   plane.enter <target> [cellPx]   a registry id (a grid, terminal, book, `carrel:<name>`) or a grid
 *                                   index/name; cellPx = device px per text column (Settings ▸ Planes)
 *   plane.leave                     back to where you entered from
 *   plane.fov <deg|default>         the parallax fan: wider spreads layers off the plane with depth
 *   plane.aim <x> <y>               the plane point at the view center (plane coords, world units)
 *   plane.state                     the plane view, for gates: aim, scale, lens, viewport, tweening
 */

import * as THREE from 'three';
import { getSetting } from '../../client/settings.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';

/**
 * Resolve a plane target: a grid first, through the ONE grid resolver and as a live actor (a
 * restored file can still be a lightweight row that draws nothing until it materializes), else any
 * registered surface by its registry id (a terminal, a book, `carrel:<name>`).
 */
function resolveTarget(ctx, arg) {
    const r = resolveGridByIdOrIndex(ctx, String(arg), 'surface', { actor: true });
    if (r?.grid) return { obj: r.grid, id: r.registryId ?? String(arg) };
    const e = ctx.registry?.get?.(String(arg));
    if (e?.grid) return { obj: e.grid, id: String(arg) };
    return { error: r?.error ?? `ERR: no surface '${arg}'` };
}

/**
 * The world width of one text column ON this object: its own cell metrics × its world scale, else
 * the atlas cell at the default glyph world scale (a desk, a book: mixed content).
 */
function columnWorldWidth(ctx, obj) {
    const sx = Math.abs(obj.getWorldScale?.(new THREE.Vector3())?.x ?? 1);
    const own = obj.metrics?.charWidth;
    if (Number.isFinite(own) && own > 0) return own * sx;
    const cs = ctx.atlas?.getCharSize?.();
    if (!cs?.width) throw new Error('plane: no atlas char size to scale by');
    return cs.width * Number(getSetting('plane.defaultWorldScale')) * sx;
}

/** The aim y that opens a surface of `height` world units at its top, or centered if it fits. */
function openAimY(height, pxPerUnit, viewportH) {
    const viewH = viewportH / pxPerUnit;
    if (height <= viewH) return 0;
    const margin = Number(getSetting('plane.topMarginPx')) / pxPerUnit;
    return height / 2 - viewH / 2 + margin;
}

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerPlaneCommands(router) {
    router.register('plane.enter', (args, ctx) => {
        const cc = ctx.cameraController;
        if (!cc?.enterPlane) return { text: 'ERR: no camera controller', data: null };
        if (!args[0]) return { text: 'ERR: usage: plane.enter <target> [cellPx]', data: null };
        const t = resolveTarget(ctx, args[0]);
        if (t.error) return { text: t.error, data: null };
        const plane = cc.planeOf(t.obj);
        if (!plane) return { text: `ERR: '${t.id}' has no surface to read (no local bounds)`, data: null };
        const cellPx = args[1] != null ? Number(args[1]) : Number(getSetting('plane.cellPx'));
        if (!(Number.isFinite(cellPx) && cellPx > 0)) return { text: `ERR: cellPx must be a positive number (got ${args[1]})`, data: null };
        const vp = cc.planeViewport();
        const dpr = vp.dpr;
        // Columns land on whole DEVICE pixels: cellPx device px per column = cellPx/dpr CSS px.
        const pxPerUnit = (cellPx / dpr) / columnWorldWidth(ctx, t.obj);
        const depth = plane.depth ?? 0;
        // The point to pixel-snap: the surface's cell-grid origin when it states one (text), else
        // its top-left corner — in plane coordinates (world units from the plane center, +y up).
        const po = t.obj.pixelOrigin?.();
        let origin = { x: -plane.width / 2, y: plane.height / 2 };
        if (po) {
            t.obj.updateWorldMatrix(true, false);
            const d = t.obj.localToWorld(new THREE.Vector3(po.x, po.y, 0)).sub(plane.center);
            const right = new THREE.Vector3().crossVectors(plane.up, plane.normal).normalize();
            origin = { x: d.dot(right), y: d.dot(plane.up) };
        }
        // Space-layer chrome (the tree's ownership traces) steps aside for exactly the plane view's
        // life — the camera says when it ends, however it ends (a leave, a fly, a restore).
        cc.onPlaneChange = (on) => {
            ctx.contentTreeArrows?.setSuppressed?.(on);
            if (!on) ctx.planeTarget = null;
        };
        cc.enterPlane({
            center: plane.center, normal: plane.normal, up: plane.up,
            pxPerUnit, fovDeg: Number(getSetting('plane.fov')),
            front: depth / 2 + Number(getSetting('plane.front')), back: depth / 2 + Number(getSetting('plane.back')),
            // A surface taller than the view opens at its top (a page is read from its head), the
            // top edge `plane.topMarginPx` below the view's; a shorter one centers.
            aim: { x: 0, y: openAimY(plane.height, pxPerUnit, vp.height) },
            origin,
        }, { ms: Number(getSetting('plane.enterMs')) });
        ctx.planeTarget = t.id;
        const s = cc.planeState();
        return {
            text: `OK: reading '${t.id}' at ${cellPx} device px per column (${s.pxPerUnit.toFixed(4)} CSS px/unit, fov ${s.fovDeg}°)`,
            data: { target: t.id, cellPx, ...s },
        };
    }, { description: 'Square to a surface and ease into a pixel-exact flat view (text columns on whole device pixels)', usage: '<target> [cellPx]', returns: '{ target, cellPx, aim, pxPerUnit, fovDeg, camera, viewport, tweening }' });

    router.register('plane.leave', (_args, ctx) => {
        const cc = ctx.cameraController;
        if (!cc?.leavePlane) return { text: 'ERR: no camera controller', data: null };
        const was = ctx.planeTarget ?? null;
        if (!cc.leavePlane({ ms: Number(getSetting('plane.leaveMs')) })) return { text: 'ERR: not in a plane view', data: null };
        return { text: `OK: leaving '${was}'`, data: { target: was } };
    }, { description: 'Ease back from a plane view to where it was entered from', returns: '{ target }' });

    router.register('plane.fov', (args, ctx) => {
        const cc = ctx.cameraController;
        const raw = String(args[0] ?? '');
        const fov = raw === 'default' ? Number(getSetting('plane.fov')) : Number(raw);
        if (!(fov > 0 && fov < 179)) return { text: 'ERR: usage: plane.fov <degrees in (0,179)|default>', data: null };
        if (!cc?.setPlaneFov?.(fov, { ms: Number(getSetting('plane.fanMs')) })) return { text: 'ERR: not in a plane view', data: null };
        return { text: `OK: plane fov → ${fov}° (scale held)`, data: { fovDeg: fov } };
    }, { description: 'Set the plane view fov keeping its scale — the parallax fan (wider spreads layers by depth)', usage: '<deg|default>', returns: '{ fovDeg }' });

    router.register('plane.aim', (args, ctx) => {
        const cc = ctx.cameraController;
        const x = Number(args[0]), y = Number(args[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { text: 'ERR: usage: plane.aim <x> <y>', data: null };
        if (!cc?.setPlaneAim?.(x, y)) return { text: 'ERR: not in a plane view', data: null };
        return { text: `OK: plane aim → (${cc.planeState().aim.x.toFixed(3)}, ${cc.planeState().aim.y.toFixed(3)}) (snapped)`, data: cc.planeState() };
    }, { description: 'Move the plane view center (plane coordinates, world units), pixel-snapped', usage: '<x> <y>', returns: 'plane.state' });

    router.register('plane.state', (_args, ctx) => {
        const s = ctx.cameraController?.planeState?.() ?? null;
        if (!s) return { text: 'OK: open world (no plane view)', data: null };
        return {
            text: `OK: plane '${ctx.planeTarget}' · ${s.pxPerUnit.toFixed(4)} px/unit · fov ${s.camera.fov.toFixed(3)}° · near ${s.camera.near.toFixed(1)} far ${s.camera.far.toFixed(1)} · ${s.viewport.width}×${s.viewport.height}@${s.viewport.dpr}${s.tweening ? ' · tweening' : ''}`,
            data: { target: ctx.planeTarget ?? null, ...s },
        };
    }, { description: 'The plane view: aim, scale, lens, viewport, whether a tween runs (null in the open world)', returns: '{ target, aim, pxPerUnit, fovDeg, camera, viewport, tweening } | null' });
}
