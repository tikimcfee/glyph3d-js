/**
 * Pick commands — "what is at this point on screen", the probe under pointing (deixis) and the
 * pixel loop's way to name what it sees.
 *
 *   pick.at <x> <y>    the GPU pick (the same multi-channel ID pass hover uses — the truth for
 *                      what a person's cursor would land on): the registry entry under the CSS-px
 *                      point (canvas top-left origin), plus any control handle / container.
 *   scene.at <x> <y>   a three raycast through the point: EVERY object whose geometry the ray meets,
 *                      nearest first, with its parent chain and whether it is pickable — it finds what
 *                      the pick channels can't (unregistered chrome, camera-locked UI).
 */

import * as THREE from 'three';
import { entryForGrid } from '../../client/CanvasInteraction.jsx';
import { rayFromCamera } from '@glyph3d/core/services/spatial/spatialMath.js';

const parsePoint = (args) => {
    const x = Number(args[0]), y = Number(args[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};

/** A readable path for an object: its own name/type and up to 4 ancestors. */
function chainOf(obj) {
    const parts = [];
    for (let o = obj, i = 0; o && i < 5; o = o.parent, i++) {
        parts.push(o.name || o.userData?.name || o.constructor?.name || o.type);
    }
    return parts.join(' ← ');
}

/** @param {import('../../client/CommandProvider.jsx').AppRouter} router */
export default function registerPickCommands(router) {
    router.register('pick.at', async (args, ctx) => {
        const p = parsePoint(args);
        if (!p) return { text: 'ERR: usage: pick.at <x> <y>   (CSS px from the canvas top-left)', data: null };
        const ps = ctx.pickingSystem;
        if (!ps) return { text: 'ERR: no picking system', data: null };
        const hits = await ps.pick(['grid', 'handle', 'group', 'glyph'], ctx.camera, ctx.scene, p.x, p.y);
        const tok = hits.grid?.token;
        const owner = tok && typeof tok.ownerOf === 'function' ? tok.ownerOf(hits.grid.slotIndex) : tok;
        const entry = owner ? entryForGrid(ctx.registry, owner) : null;
        const data = {
            x: p.x, y: p.y,
            id: entry?.id ?? null, type: entry ? (entry.role || entry.type) : null,
            handle: hits.handle?.token ? (hits.handle.token.kind ?? hits.handle.token.button?.name ?? 'handle') : null,
            group: hits.group?.token ? (hits.group.token.name || hits.group.token.userData?.name || 'group') : null,
            glyph: hits.glyph ? { slot: hits.glyph.slotIndex ?? null } : null,
        };
        const text = data.id
            ? `OK: (${p.x}, ${p.y}) → ${data.id} [${data.type}]${data.handle ? ` · handle ${data.handle}` : ''}${data.group ? ` · in ${data.group}` : ''}`
            : `OK: (${p.x}, ${p.y}) → nothing pickable${data.group ? ` (container ${data.group})` : ''}`;
        return { text, data };
    }, { description: 'GPU-pick the point (CSS px, canvas top-left): the registry entry a cursor there would hover', usage: '<x> <y>', returns: '{ x, y, id, type, handle, group, glyph }' });

    router.register('scene.at', (args, ctx) => {
        const p = parsePoint(args);
        if (!p) return { text: 'ERR: usage: scene.at <x> <y>   (CSS px from the canvas top-left)', data: null };
        const canvas = ctx.renderer?.domElement;
        const rect = canvas?.getBoundingClientRect?.();
        if (!rect?.width) return { text: 'ERR: no canvas to raycast through', data: null };
        const ndc = new THREE.Vector2((p.x / rect.width) * 2 - 1, -(p.y / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        rayFromCamera(ray, ndc, ctx.camera);
        ray.near = ctx.camera.near;
        ray.far = ctx.camera.far;
        ray.layers.enableAll();   // batched panels/labels draw from instances, off layer 0 — still name them
        const seen = new Set();
        const rows = [];
        for (const h of ray.intersectObjects(ctx.scene.children, true)) {
            if (seen.has(h.object)) continue;
            seen.add(h.object);
            if (!h.object.visible) continue;
            const id = ctx.registry?.getIdByGrid?.(h.object) ?? null;
            rows.push({ distance: +h.distance.toFixed(2), chain: chainOf(h.object), id, type: h.object.type });
            if (rows.length >= 20) break;
        }
        const text = rows.length
            ? `OK: (${p.x}, ${p.y}) — ${rows.length} object(s), nearest first:\n` + rows.map((r) => `  ${r.distance}  ${r.chain}${r.id ? `  [${r.id}]` : ''}`).join('\n')
            : `OK: (${p.x}, ${p.y}) — the ray meets nothing between near and far`;
        return { text, data: { x: p.x, y: p.y, hits: rows } };
    }, { description: 'Raycast the point (CSS px, canvas top-left) between near and far: every object hit, nearest first, with its parent chain', usage: '<x> <y>', returns: '{ x, y, hits:[{distance, chain, id, type}] }' });
}
