/**
 * Layer commands — DEPTH AS TIME (slice 10a): a member's past as pages behind it, registered on
 * its cell grid (LayerStack; sources in client/layerSources.js — a file's revisions, an agent
 * scroll's turns, a terminal's screens of scrollback).
 *
 *   layer.show <id> [n]              stand a member's last n layers behind it (default layers.count);
 *                                    again re-reads them
 *   layer.hide <id>                  take them away
 *   layer.list [id]                  a member's layers front to back (every member with a stack, bare)
 *   layer.where <id>                 where its pages stand in the world (in the scene, shown, camera layers)
 *   pane.layer <id> <n|now|label>    bring a layer to z = 0 (1 = the newest history page; a label or
 *                                    id prefix; `now` = the member itself) — shows the stack first
 *   pane.blink <id> <a> <b>|off      alternate two layers at z = 0 every layers.blinkMs
 *   grid.history <id> [--at n]       a file grid's revisions (newest first); --at n brings revision n
 *                                    to z = 0
 *
 * The fan is the plane's lens (plane.fov — wider spreads the layers by depth); these verbs never
 * move the camera.
 */

import * as THREE from 'three';
import { layerStacksOf } from '../../client/LayerStacks.js';
import { rootOf, isShown } from '@glyph3d/core/collections/SceneTransforms.js';

const J = (v) => JSON.stringify(v);

const stacksOf = layerStacksOf;

/** A registry entry by any id the registry or a book answers to. */
function entryOf(ctx, id) {
    const reg = ctx.registry;
    let e = id ? reg?.get?.(String(id)) : null;
    if (!e && id) {
        const lane = ctx.agentBooks?.resolveLane?.(String(id))?.[1];
        if (lane) e = reg?.get?.(lane.groupId) ?? null;
    }
    return e ?? null;
}

const fmtOrder = (stack) => stack.order().map((l) => `${l.front ? '▶' : ' '} ${l.kind === 'now' ? 'now' : l.kind === 'suggest' ? `+${-l.rank}` : `-${l.rank}`}  ${l.label}`);

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerLayerCommands(router) {
    router.register('layer.show', async (args, ctx) => {
        const e = entryOf(ctx, args[0]);
        if (!e) return { text: args[0] ? `ERR: nothing named '${args[0]}'` : 'ERR: usage: layer.show <id> [n]', data: null };
        const n = args[1] != null ? Number(args[1]) : undefined;
        if (n != null && !(Number.isInteger(n) && n > 0)) return { text: 'ERR: n is a positive whole number', data: null };
        try {
            const stack = await stacksOf(ctx).show(e, n != null ? { n } : undefined);
            const order = stack.order();
            return { text: `OK: ${e.id} — ${order.length - 1} layer(s)\n${fmtOrder(stack).join('\n')}`, data: { id: e.id, layers: order } };
        } catch (err) {
            return { text: `ERR: ${err?.message || err}`, data: null };
        }
    }, { description: "Stand a member's last n layers (its past) behind it — revisions, turns, or screens of scrollback", usage: '<id> [n]' });

    router.register('layer.hide', (args, ctx) => {
        const e = entryOf(ctx, args[0]);
        const id = e?.id ?? args[0];
        return stacksOf(ctx).hide(id) ? { text: `OK: ${id} — layers taken away`, data: { id } } : { text: `ERR: '${args[0] ?? ''}' has no layers shown`, data: null };
    }, { description: "Take a member's layers away", usage: '<id>' });

    router.register('layer.list', (args, ctx) => {
        const st = stacksOf(ctx);
        if (!args[0]) {
            const ids = [...st.byId.keys()];
            return { text: ids.length ? `OK: ${ids.length} member(s) with layers: ${ids.join(', ')}` : 'OK: no layers shown', data: { ids } };
        }
        const e = entryOf(ctx, args[0]);
        const stack = st.get(e?.id ?? args[0]);
        if (!stack) return { text: `ERR: '${args[0]}' has no layers shown (layer.show)`, data: null };
        return { text: `OK: ${e?.id ?? args[0]}\n${fmtOrder(stack).join('\n')}`, data: { id: e?.id ?? args[0], layers: stack.order() } };
    }, { description: "A member's layers, front to back", usage: '[id]', returns: '{ id, layers:[{id,label,kind,rank,y,z,front}] }' });

    router.register('layer.where', (args, ctx) => {
        const e = entryOf(ctx, args[0]);
        const stack = stacksOf(ctx).get(e?.id ?? args[0]);
        if (!stack) return { text: `ERR: '${args[0] ?? ''}' has no layers shown (layer.show)`, data: null };
        let root = stack; while (root.parent) root = root.parent;
        const at = (o) => { const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]; };
        const rows = [{ id: 'stack', world: at(stack), visible: stack.visible, parent: stack.parent?.name ?? null, inScene: root === ctx.scene }];
        const panel = (m) => ({ at: at(m), inScene: rootOf(m) === ctx.scene, shown: isShown(m), mask: m.layers.mask, opacity: m.material?.opacity });
        const field = (f) => f && ({ glyphs: f.getGlyphCount(), mask: f.instanceMesh.layers.mask, sphere: f.geometry.boundingSphere ? +f.geometry.boundingSphere.radius.toFixed(1) : null, rowHeight: +f.rowHeight.toFixed(3), culled: f.instanceMesh.frustumCulled });
        if (stack._now) rows.push({ id: 'now-back', ...panel(stack._now.back) });
        if (e.grid._background) rows.push({ id: 'member-back', ...panel(e.grid._background) });
        for (const l of stack.pages) rows.push({ id: l.id, world: at(l.group), back: panel(l.back), field: field(l.field) });
        return { text: `OK: ${e?.id ?? args[0]} — member at ${J(at(e.grid))}\n${rows.map((r) => J(r)).join('\n')}`, data: { rows } };
    }, { description: "Where a member's layer pages stand in the world (in the scene? visible? on which camera layers?) — a diagnostic", usage: '<id>' });

    router.register('pane.layer', async (args, ctx) => {
        const e = entryOf(ctx, args[0]);
        if (!e || args[1] == null) return { text: 'ERR: usage: pane.layer <id> <n|now|label>', data: null };
        const st = stacksOf(ctx);
        if (!st.get(e.id)) {
            try { await st.show(e); } catch (err) { return { text: `ERR: ${err?.message || err}`, data: null }; }
        }
        const layer = st.resolveLayer(e.id, args[1]);
        if (layer === undefined) return { text: `ERR: no layer '${args[1]}' on ${e.id} (layer.list ${e.id})`, data: null };
        st.front(e.id, layer);
        return { text: `OK: ${e.id} — ${layer ?? 'now'} at z = 0`, data: { id: e.id, layer } };
    }, { description: 'Bring one of a member\'s layers to z = 0 (1 = the newest past page, now = the member)', usage: '<id> <n|now|label>' });

    router.register('pane.blink', (args, ctx) => {
        const e = entryOf(ctx, args[0]);
        const st = stacksOf(ctx);
        if (!e || !st.get(e.id)) return { text: `ERR: '${args[0] ?? ''}' has no layers shown (layer.show)`, data: null };
        if (args[1] === 'off') { st.unblink(e.id); return { text: `OK: ${e.id} — blink off`, data: { id: e.id } }; }
        if (args[2] == null) return { text: 'ERR: usage: pane.blink <id> <a> <b> | off', data: null };
        const a = st.resolveLayer(e.id, args[1]), b = st.resolveLayer(e.id, args[2]);
        if (a === undefined || b === undefined) return { text: `ERR: no layer '${a === undefined ? args[1] : args[2]}' on ${e.id}`, data: null };
        st.blink(e.id, a, b);
        return { text: `OK: ${e.id} — blinking ${a ?? 'now'} ↔ ${b ?? 'now'}`, data: { id: e.id, a, b } };
    }, { description: 'Alternate two of a member\'s layers at z = 0 (layers.blinkMs) — off stops', usage: '<id> <a> <b> | off' });

    router.register('grid.history', async (args, ctx) => {
        const at = args.indexOf('--at');
        const n = at >= 0 ? Number(args[at + 1]) : null;
        const id = args.find((a, i) => i !== at && i !== at + 1);
        const e = entryOf(ctx, id);
        if (!e || typeof e.grid?.getSourcePath !== 'function' || !e.grid.getSourcePath()) return { text: `ERR: '${id ?? ''}' is not a file grid`, data: null };
        if (at >= 0 && !(Number.isInteger(n) && n >= 0)) return { text: 'ERR: usage: grid.history <id> [--at n]', data: null };
        const st = stacksOf(ctx);
        let stack = st.get(e.id);
        if (!stack) {
            try { stack = await st.show(e); } catch (err) { return { text: `ERR: ${err?.message || err}`, data: null }; }
        }
        const revs = stack.pages.filter((l) => l.kind === 'history').sort((a, b) => a.rank - b.rank);
        if (at >= 0) {
            const layer = n === 0 ? null : revs[n - 1]?.id;
            if (layer === undefined) return { text: `ERR: ${e.id} has ${revs.length} revision(s) shown`, data: null };
            st.front(e.id, layer);
        }
        const lines = revs.map((l, i) => `${stack.frontId === l.id ? '▶' : ' '} ${i + 1}  ${l.label}`);
        return { text: `OK: ${e.id} — ${revs.length} revision(s)\n${[`${stack.frontId === null ? '▶' : ' '} 0  now`, ...lines].join('\n')}`,
            data: { id: e.id, revisions: revs.map((l) => ({ id: l.id, label: l.label })), front: stack.frontId } };
    }, { description: "A file grid's revisions, newest first — --at n brings revision n to z = 0 (0 = now)", usage: '<id> [--at n]' });
}
