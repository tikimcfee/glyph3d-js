/**
 * Plane commands — READING a flat surface pixel-exact: the camera squares to it at the depth where
 * its text cells are a whole number of device pixels wide, the surface's top-left on a device-pixel
 * corner, everything in front of it clipped. Two endpoints (`plane.ortho`, the A/B): ORTHOGRAPHIC —
 * the camera keeps the open-world fov, stops where that lens shows the plane at its scale, and
 * blends to an orthographic projection (core `services/camera/PlaneCamera.js`): every layer behind
 * the plane stays 1:1; or PERSPECTIVE — a dolly zoom to the narrow `plane.fov`. The math is core
 * `services/camera/planeView.js`; the camera side is ViewerCameraController.enterPlane.
 *
 *   plane.enter <target> [cellPx]   a registry id (a grid, terminal, book, `carrel:<name>`) or a grid
 *                                   index/name; cellPx = device px per text column (Settings ▸ Planes)
 *   plane.leave                     back to where you entered from
 *   plane.fan <on|off|toggle|px>    the depth-as-time fan: orthographic, the layer pages slide whole
 *                                   device px per rank (`on` = layers.fanPx); perspective, `on` widens the
 *                                   lens to layers.fanFov (no px form). off folds it back; toggle flips it
 *   plane.fov <deg|default>         the perspective endpoint's lens (wider spreads layers with depth)
 *   plane.blend <0..1|default>      the raw blend handle (1 perspective, 0 orthographic), for gates
 *   plane.aim <x> <y>               the plane point at the view center (plane coords, world units)
 *   plane.state                     the plane view, for gates: aim, scale, lens, blend, fan, viewport
 *                                   (and whether its pixels are exact), tweening
 */

import * as THREE from 'three';
import { getSetting } from '../../client/settings.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { layerStacksOf } from '../../client/LayerStacks.js';

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
    return atlasColumnWorld(ctx) * sx;
}

/**
 * A plane desk's unit, from the ATLAS and Settings — never the viewport: its one text column (world
 * units), the device px per column when entered (`plane.cellPx`), and a row's height over a column's
 * width (the atlas cell's). Carrel.setPlaneUnit takes it.
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx
 * @returns {{column:number, cellPx:number, rowRatio:number}}
 */
export function planeUnitOf(ctx) {
    const cs = ctx.atlas?.getCharSize?.();
    if (!cs?.width || !cs?.height) throw new Error('plane: no atlas char size for a plane unit');
    return { column: atlasColumnWorld(ctx), cellPx: Number(getSetting('plane.cellPx')), rowRatio: cs.height / cs.width };
}

/**
 * The atlas's text column at the default glyph world scale, in world units — the one column a
 * plane desk normalizes its members to.
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx @returns {number}
 */
export function atlasColumnWorld(ctx) {
    const cs = ctx.atlas?.getCharSize?.();
    if (!cs?.width) throw new Error('plane: no atlas char size to scale by');
    return cs.width * Number(getSetting('plane.defaultWorldScale'));
}

/** The controllers whose plane life this module already listens to (one listener each). */
const listening = new WeakSet();

/**
 * Space-layer chrome (the tree's ownership traces) steps aside for exactly a plane view's life —
 * the camera says when it ends, however it ends (a leave, a fly's leave, a restore) — and the
 * view's target and entered desk are forgotten with it. Installed once per controller.
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx
 */
function listenToPlaneLife(ctx) {
    const cc = ctx.cameraController;
    if (listening.has(cc)) return;
    listening.add(cc);
    cc.addPlaneListener((on) => {
        ctx.contentTreeArrows?.setSuppressed?.(on);
        if (!on) { ctx.planeTarget = null; ctx.enteredCarrel = null; }
    });
}

/**
 * Enter a plane view — the ONE path (plane.enter on any surface, carrel.enter on a plane desk).
 * Entering while entered is a switch (a cut, or a `plane.switchMs` slide). The view's target is
 * recorded for the verbs that report it. On a canvas whose drawing buffer isn't its device-pixel
 * box 1:1 the view still enters, but the pixels it promises can't reach the screen: the returned
 * `notice` says so with the numbers (a verb puts it in its OK line) and the console hears it too.
 * @param {import('../../client/CommandProvider.jsx').AppContext} ctx
 * @param {string} target  the registry id read (`carrel:<name>` for a desk)
 * @param {{center:Object, normal:Object, up:Object, pxPerUnit:number, depth:number,
 *          aim?:{x:number,y:number}, referent?:{x:number,y:number}, origin:{x:number,y:number}}} p
 *   referent: a plane point held where it is on screen through the ease (the end aim follows from
 *   it); aim: where the view lands when there is no referent to hold — ViewerCameraController.enterPlane
 * @returns {Object} the camera's planeState, plus `notice` (a string when the box is inexact, else null)
 */
export function enterPlaneView(ctx, target, p) {
    const cc = ctx.cameraController;
    listenToPlaneLife(ctx);
    cc.enterPlane({
        center: p.center, normal: p.normal, up: p.up,
        pxPerUnit: p.pxPerUnit, fovDeg: Number(getSetting('plane.fov')), ortho: !!getSetting('plane.ortho'),
        front: p.depth / 2 + Number(getSetting('plane.front')), back: p.depth / 2 + Number(getSetting('plane.back')),
        aim: p.aim, referent: p.referent, origin: p.origin,
    }, {
        ms: Number(getSetting('plane.enterMs')), leaveMs: Number(getSetting('plane.leaveMs')),
        switchMs: Number(getSetting('plane.switchMs')),
    });
    ctx.planeTarget = target;
    if (!String(target).startsWith('carrel:')) ctx.enteredCarrel = null;
    const s = cc.planeState();
    const vp = s.viewport;
    let notice = null;
    if (!vp.exact) {
        notice = `NOT pixel-exact: ${vp.why} (buffer ${vp.width}×${vp.height} @ dpr ${vp.dpr})`;
        console.warn(`[plane] entering '${target}' on an inexact canvas — ${notice}`);
    }
    return { ...s, notice };
}

/**
 * The aim that opens a surface of `width` × `height` world units where it is read from: wider
 * than the view, at its left edge (`plane.leftMarginPx` in); taller, at its top
 * (`plane.topMarginPx` down); an axis that fits centers; a left-edge overlay (`leftInsetPx`
 * device px wide — the strip) never covers the surface's left edge.
 * @returns {{x:number, y:number}}
 */
export function openAim(width, height, pxPerUnit, vp, leftInsetPx = 0) {
    const viewW = vp.width / pxPerUnit, viewH = vp.height / pxPerUnit;   // device px ÷ device px per unit
    const left = Number(getSetting('plane.leftMarginPx')) * vp.dpr / pxPerUnit;   // the knobs are CSS px
    const top = Number(getSetting('plane.topMarginPx')) * vp.dpr / pxPerUnit;
    const ax0 = width <= viewW ? 0 : -width / 2 + viewW / 2 - left;
    const ax = leftInsetPx > 0 ? Math.min(ax0, -width / 2 + viewW / 2 - leftInsetPx / pxPerUnit) : ax0;
    return {
        x: ax,
        y: height <= viewH ? 0 : height / 2 - viewH / 2 + top,
    };
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
        const vp = cc.planeViewport();   // DEVICE px: the drawing buffer
        // Columns land on whole DEVICE pixels: cellPx device px per column.
        const pxPerUnit = cellPx / columnWorldWidth(ctx, t.obj);
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
        // Entering never loses your place: the surface point you are looking at stays where it is
        // on screen. Looking elsewhere (or switching from another plane), it opens where it is read
        // from: a surface wider than the view at its left edge, taller at its top (openAim), clear
        // of the strip's reserved left band.
        const look = cc.planePointAtView(plane);
        const onIt = look && Math.abs(look.x) <= plane.width / 2 && Math.abs(look.y) <= plane.height / 2;
        const forCarrel = t.id.startsWith('carrel:') ? (ctx.carrels?.get?.(t.id.slice(7)) ?? null) : null;
        const leftInset = ctx.strip?.leftInsetForCarrel?.(forCarrel) ?? 0;
        const aim = openAim(plane.width, plane.height, pxPerUnit, vp, leftInset);
        const fits = plane.width <= (vp.width - leftInset) / pxPerUnit && plane.height <= vp.height / pxPerUnit;
        const clearOfStrip = !(leftInset > 0) || (look && look.x <= aim.x);
        const s = enterPlaneView(ctx, t.id, {
            center: plane.center, normal: plane.normal, up: plane.up, pxPerUnit, depth,
            aim,
            ...(onIt && !cc.planeState() && fits && clearOfStrip ? { referent: look } : {}),
            origin,
        });
        return {
            text: `OK: reading '${t.id}' at ${cellPx} device px per column (${s.pxPerUnit.toFixed(4)} device px/unit, ${s.ortho ? 'orthographic' : `fov ${s.fovDeg}°`})${s.notice ? ` — ⚠ ${s.notice}` : ''}`,
            data: { target: t.id, cellPx, ...s },
        };
    }, { description: 'Square to a surface and ease into a pixel-exact flat view (text columns on whole device pixels)', usage: '<target> [cellPx]', returns: '{ target, cellPx, aim, pxPerUnit, fovDeg, camera, viewport, tweening, notice }' });

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
        if (cc?.planeState?.()?.ortho) return { text: 'ERR: the plane endpoint is orthographic (plane.ortho on): its lens keeps the open-world fov — the fan is plane.fan', data: null };
        if (!cc?.setPlaneFov?.(fov, { ms: Number(getSetting('plane.fanMs')) })) return { text: 'ERR: not in a plane view', data: null };
        return { text: `OK: plane fov → ${fov}° (scale held)`, data: { fovDeg: fov } };
    }, { description: 'Set the perspective plane endpoint fov keeping its scale (wider spreads layers by depth)', usage: '<deg|default>', returns: '{ fovDeg }' });

    router.register('plane.fan', (args, ctx) => {
        const cc = ctx.cameraController;
        let raw = String(args[0] ?? '');
        const s = cc?.planeState?.();
        if (!s) return { text: 'ERR: not in a plane view', data: null };
        const ms = Number(getSetting('plane.fanMs'));
        // toggle (the prefix's f — the fan without holding a key): off when fanned, else on.
        if (raw === 'toggle') {
            const fanned = s.ortho ? !!s.fan : s.fovDeg !== Number(getSetting('plane.fov'));
            raw = fanned ? 'off' : 'on';
        }
        if (!s.ortho) {
            // The perspective endpoint's fan is its lens: on widens it, off narrows it back.
            if (raw !== 'on' && raw !== 'off') return { text: `ERR: the plane endpoint is perspective (plane.ortho off): plane.fan takes on|off|toggle (a px fan needs plane.ortho on)`, data: null };
            const fov = Number(getSetting(raw === 'on' ? 'layers.fanFov' : 'plane.fov'));
            cc.setPlaneFov(fov, { ms });
            return { text: `OK: plane fan ${raw} — perspective lens ${fov}° (scale held)`, data: { fovDeg: fov } };
        }
        const px = raw === 'off' ? 0 : raw === 'on' ? Number(getSetting('layers.fanPx')) : Number(raw);
        if (!Number.isInteger(px)) return { text: `ERR: usage: plane.fan <on|off|toggle|px> — px is WHOLE device px per layer (got '${raw}')`, data: null };
        // The orthographic endpoint's fan is the pages' own slide (LayerStacks hears the camera's fan).
        layerStacksOf(ctx);
        cc.setPlaneFan(px, { ms });
        if (px === 0) return { text: 'OK: plane fan off — the layers fold back behind the page', data: { px: 0 } };
        return { text: `OK: plane fan → ${px} device px per layer (each page behind slides rigidly; the member stays)`, data: { px } };
    }, { description: 'The depth-as-time fan: orthographic, the layer pages slide whole device px per rank; perspective, the wider lens; toggle flips it (the pane prefix then f)', usage: '<on|off|toggle|px>', returns: '{ px } | { fovDeg }' });

    router.register('plane.blend', (args, ctx) => {
        const cc = ctx.cameraController;
        const raw = String(args[0] ?? '');
        const lam = raw === 'default' ? null : Number(raw);
        if (lam !== null && !(lam >= 0 && lam <= 1)) return { text: 'ERR: usage: plane.blend <0..1|default>', data: null };
        if (!cc?.planeState?.()) return { text: 'ERR: not in a plane view', data: null };
        if (!cc.setPlaneBlend(lam)) return { text: 'ERR: a plane tween is running — wait for it to land', data: null };
        const st = cc.planeState();
        return { text: `OK: plane blend → ${st.camera.blend} (plane depth ${st.camera.planeDepth?.toFixed(3)})`, data: st };
    }, { description: 'Hold the plane view at a perspective↔orthographic blend (1 perspective, 0 orthographic) — a raw test handle', usage: '<0..1|default>', returns: 'plane.state' });

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
            text: `OK: plane '${ctx.planeTarget}' · ${s.pxPerUnit.toFixed(4)} px/unit · ${s.ortho ? 'orthographic' : 'perspective'} · fov ${s.camera.fov.toFixed(3)}° · blend ${s.camera.blend}${s.fan ? ` · fan ${s.fan.px} px` : ''} · near ${s.camera.near.toFixed(1)} far ${s.camera.far.toFixed(1)} · ${s.viewport.width}×${s.viewport.height}@${s.viewport.dpr} ${s.viewport.exact ? 'exact' : `INEXACT (${s.viewport.why})`}${s.tweening ? ' · tweening' : ''}`,
            data: { target: ctx.planeTarget ?? null, ...s },
        };
    }, { description: 'The plane view: aim, scale, lens, viewport, whether a tween runs (null in the open world)', returns: '{ target, aim, pxPerUnit, fovDeg, camera, viewport:{width, height, dpr, exact, box, why}, tweening } | null' });
}
