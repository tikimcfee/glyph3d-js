/**
 * Scene commands: scene.info, scene.memory, scene.textures, scene.transforms, scene.render, scene.clear_grids
 * Uses registry as source of truth for scene object counts.
 */

import { box, kvLines } from '../formatResponse.js';
import { verifyTransforms } from '@glyph3d/core/collections/SceneTransforms.js';
import { pathOf } from '@glyph3d/core/collections/FlatRenderRoot.js';

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerSceneCommands(router) {
    router.register('scene.info', (args, ctx) => {
        const gridEntries = ctx.registry.findByType('grid');
        const loose = ctx.registry.findLoose('grid').length;
        let totalGlyphs = 0;
        for (const e of gridEntries) totalGlyphs += e.grid.getGlyphCount();

        const data = {
            'grids': gridEntries.length === loose
                ? String(loose)
                : `${loose} loose + ${gridEntries.length - loose} carried`,
            'glyphs': totalGlyphs.toLocaleString(),
            'registry total': String(ctx.registry.size),
            'scene children': String(ctx.scene.children.length),
        };

        if (ctx.renderer.info) {
            const info = ctx.renderer.info;
            data['draw calls'] = String(info.render?.calls || 'N/A');
            data['triangles'] = String(info.render?.triangles || 'N/A');
            data['textures'] = String(info.memory?.textures || 'N/A');
        }

        return {
            text: box('SCENE', kvLines(data), 50) + '\nOK: scene info',
            data: {
                gridCount: gridEntries.length,
                glyphCount: totalGlyphs,
                registryTotal: ctx.registry.size,
                sceneChildren: ctx.scene.children.length,
            }
        };
    }, { description: 'Show scene details' });

    // Where the CPU-side render memory sits: every geometry attribute's array (counted once — an
    // interleaved buffer or a shared array is one), by owner (the nearest registered ancestor's
    // kind), largest first. The heap's render share; a heap snapshot names the rest.
    router.register('scene.memory', (args, ctx) => {
        const arrays = new Map();   // ArrayBuffer view → owner
        const objects = {};
        const ownerOf = (obj) => {
            for (let o = obj; o; o = o.parent) {
                const id = ctx.registry?.getIdByGrid?.(o);
                if (id) { const e = ctx.registry.get(id); return `${e?.type ?? 'registered'}${e?.role ? `:${e.role}` : ''}`; }
            }
            return obj.type || 'Object3D';
        };
        ctx.scene.traverse((obj) => {
            const g = obj.geometry;
            if (!g?.attributes) return;
            const owner = ownerOf(obj);
            objects[owner] = (objects[owner] || 0) + 1;
            const attrs = [...Object.values(g.attributes), ...(g.index ? [g.index] : [])];
            for (const a of attrs) {
                const arr = a?.data?.array ?? a?.array;   // interleaved → its buffer's array
                if (arr?.buffer && !arrays.has(arr)) arrays.set(arr, owner);
            }
        });
        const by = {};
        let total = 0;
        for (const [arr, owner] of arrays) {
            const b = arr.byteLength;
            total += b;
            const r = (by[owner] ||= { bytes: 0, arrays: 0 });
            r.bytes += b; r.arrays++;
        }
        const rows = Object.entries(by).sort((a, b) => b[1].bytes - a[1].bytes);
        const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
        const heap = typeof performance !== 'undefined' ? performance.memory?.usedJSHeapSize ?? null : null;
        return {
            text: `OK: ${mb(total)} in ${arrays.size} geometry arrays${heap != null ? ` (JS heap ${mb(heap)})` : ''}\n`
                + rows.map(([o, r]) => `  ${mb(r.bytes).padStart(9)}  ${String(r.arrays).padStart(6)} arrays  ${String(objects[o] ?? 0).padStart(5)} objects  ${o}`).join('\n'),
            data: { total, arrays: arrays.size, heap, by },
        };
    }, { description: 'CPU-side geometry memory by owner — where the render share of the heap sits', returns: '{ total, arrays, heap, by }' });

    // GPU textures against what the scene still references — the gap is textures alive on the GPU
    // that nothing draws with (render targets, the overlay's, and anything never disposed). Run it
    // twice and compare: a gap that grows at a constant scene is a leak. Owners are the nearest
    // registered ancestor (its registry id's kind), else the object's own type.
    router.register('scene.textures', (args, ctx) => {
        const gpu = ctx.renderer?.info?.memory?.textures ?? null;
        const seen = new Map();   // texture → owner
        const ownerOf = (obj) => {
            for (let o = obj; o; o = o.parent) {
                const id = ctx.registry?.getIdByGrid?.(o);
                if (id) {
                    const e = ctx.registry.get(id);
                    return `${e?.type ?? 'registered'}${e?.role ? `:${e.role}` : ''}`;
                }
            }
            return obj.type || obj.constructor?.name || 'Object3D';
        };
        const take = (v, owner) => {
            if (!v) return;
            if (Array.isArray(v)) { for (const x of v) take(x, owner); return; }
            if (v.isTexture && !seen.has(v)) seen.set(v, owner);
        };
        const visit = (obj) => {
            const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
            if (!mats.length) return;
            const owner = ownerOf(obj);
            for (const m of mats) {
                for (const k of Object.keys(m)) take(m[k], owner);
                if (m.uniforms) for (const u of Object.values(m.uniforms)) take(u?.value, owner);
            }
        };
        ctx.scene.traverse(visit);
        take(ctx.scene.background, 'scene.background');
        take(ctx.scene.environment, 'scene.environment');
        const byOwner = {}, byKind = {};
        let bytes = 0;
        for (const [tex, owner] of seen) {
            byOwner[owner] = (byOwner[owner] || 0) + 1;
            const img = tex.image || {};
            const b = img.data?.byteLength ?? 0;
            bytes += b;
            const kind = `${tex.constructor?.name || 'Texture'} ${img.width ?? '?'}×${img.height ?? '?'}${tex.name ? ` '${tex.name}'` : ''}`;
            const k = (byKind[kind] ||= { n: 0, bytes: 0 });
            k.n++; k.bytes += b;
        }
        const rows = Object.entries(byOwner).sort((a, b) => b[1] - a[1]);
        const kinds = Object.entries(byKind).sort((a, b) => b[1].bytes - a[1].bytes || b[1].n - a[1].n).slice(0, 15);
        const gap = gpu == null ? null : gpu - seen.size;
        const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
        return {
            text: `OK: ${gpu ?? '?'} textures on the GPU, ${seen.size} referenced by the scene (gap ${gap ?? '?'}), ${mb(bytes)} of CPU-side texel data\n`
                + rows.map(([o, n]) => `  ${String(n).padStart(5)}  ${o}`).join('\n')
                + '\n by kind (CPU bytes):\n' + kinds.map(([k, v]) => `  ${String(v.n).padStart(5)}  ${mb(v.bytes).padStart(9)}  ${k}`).join('\n'),
            data: { gpu, referenced: seen.size, gap, bytes, byOwner, byKind },
        };
    }, { description: 'GPU textures vs what the scene references, by owner — a gap that grows at a constant scene is a leak', returns: '{ gpu, referenced, gap, byOwner }' });

    // The world-matrix walk: what the last frame's walk visited and recomputed, then a check of
    // every world matrix against a recompute from scratch. A stale node is a change the walk never
    // saw — matrixAutoUpdate switched off, a pivot set or Object3D.copy onto a node already in the
    // scene, or a quaternion write that skips three's hook (SceneTransforms' header lists them).
    router.register('scene.transforms', async (args, ctx) => {
        const st = ctx.sceneTransforms;
        if (!st) throw new Error('scene.transforms: no SceneTransforms on this scene');
        if (args[0] === 'who') {
            const ms = Math.max(50, Number(args[1]) || 500);
            const t = await st.tallyFor(ms);
            const total = t.reduce((n, x) => n + x.nodes, 0);
            return {
                text: `OK: over ${ms} ms the walks recomputed ${total} world matrices, started by ${t.length} moving node(s):\n` + t.slice(0, 25).map((x) => `  ${String(x.nodes).padStart(6)}  ${x.origin}`).join('\n'),
                data: { total, origins: t },
            };
        }
        const last = st.stats;
        st.update();
        const { checked, stale } = verifyTransforms(ctx.scene);
        const lines = kvLines({
            'last walk': `${last.visited} visited · ${last.recomputed} recomputed · ${last.three} by three`,
            'verified': `${checked} world matrices`,
            'stale': String(stale.length),
        });
        const list = stale.slice(0, 20).map((n) => `  ${n.path}  (off by ${n.maxErr.toExponential(2)})`).join('\n');
        return {
            text: box('TRANSFORMS', lines, 60) + (stale.length ? `\n${list}\nFAIL: ${stale.length} stale world matrices` : '\nOK: every world matrix current'),
            data: { last, checked, stale },
        };
    }, { description: "World-matrix walk stats, and a check of every world matrix against a fresh recompute; 'who [ms]' names the moving nodes that started the recomputes over the next ms (500)", usage: '[who [ms]]' });

    // The view's render list (collections/FlatRenderRoot.js): whether it serves, how often it was
    // rebuilt, what it holds — and a check of the list against a fresh walk of the scene now.
    router.register('scene.render', async (args, ctx) => {
        const flat = ctx.flatRoot;
        if (!flat) throw new Error('scene.render: no flat render root on this scene');
        if (args[0] === 'time') {
            // The frame rendered n times each way, interleaved (the same pixels — tools/flat-root-check.mjs):
            // the render call's JS cost, flat list vs three's full walk. A one-off hitch of ~2n renders.
            const n = Math.max(3, Math.min(200, Number(args[1]) || 30));
            if (!flat.enabled || flat.refused) throw new Error(`scene.render time: the flat root doesn't serve (${!flat.enabled ? 'render.flatRoot is off' : 'refused'})`);
            const r = ctx.renderer, ms = { flat: [], full: [] };
            for (let k = 0; k < n; k++) {
                let t = performance.now(); r.render(flat.target(ctx.camera), ctx.camera); ms.flat.push(performance.now() - t);
                t = performance.now(); r.render(ctx.scene, ctx.camera); ms.full.push(performance.now() - t);
            }
            const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
            const out = { n, flatMs: med(ms.flat), fullMs: med(ms.full), served: !flat.refused };
            // A pick at the canvas center, every channel, each way (PickingSystem.flatLists): its passes' CPU.
            const ps = ctx.pickingSystem;
            if (ps) {
                const was = ps.flatLists, size = r.getSize(ctx.camera.position.clone());
                const pk = { flat: [], full: [] }, CH = ['grid', 'handle', 'group', 'glyph'];
                try {
                    for (let k = 0; k < n; k++) {
                        ps.flatLists = true; await ps.pick(CH, ctx.camera, ctx.scene, size.x / 2, size.y / 2); pk.flat.push(ps._lastRenderMs);
                        ps.flatLists = false; await ps.pick(CH, ctx.camera, ctx.scene, size.x / 2, size.y / 2); pk.full.push(ps._lastRenderMs);
                    }
                } finally { ps.flatLists = was; }
                out.pickFlatMs = med(pk.flat); out.pickFullMs = med(pk.full);
            }
            const pickText = out.pickFlatMs != null ? ` · a pick (4 channels) ${out.pickFlatMs.toFixed(2)} ms flat · ${out.pickFullMs.toFixed(2)} ms full` : '';
            return { text: `OK: render JS (median of ${n}) — flat list ${out.flatMs.toFixed(2)} ms · full walk ${out.fullMs.toFixed(2)} ms${out.served ? '' : ' (REFUSED: both walk the scene)'}${pickText}`, data: out };
        }
        const { missing, extra, refused } = flat.verify(ctx.camera);
        const st = flat.stats;
        const lines = kvLines({
            'flat root': !flat.enabled ? 'off (render.flatRoot) — three walks the scene' : refused ? 'REFUSED — three walks the scene' : 'serving',
            'list': `${st.drawables} drawables · ${st.carried} walked whole by three`,
            'rebuilds': `${st.rebuilds} · refusals ${st.refusals}`,
            'stale': refused ? '—' : `${missing.length} missing · ${extra.length} extra`,
        });
        // The pick channels' lists (PickingSystem.flatLists), each checked the same way.
        const ps = ctx.pickingSystem, picks = [];
        for (const [ch, root] of ps?.flatRoots ?? []) {
            const v = root.verify();
            picks.push({ ch, root, v });
        }
        const pickLines = picks.map(({ ch, root, v }) => `  pick ${ch}: ${!ps.flatLists ? 'off (pick.flatRoot)' : v.refused ? `REFUSED — ${v.refused.reason}: ${v.refused.object}` : 'serving'} · ${root.stats.drawables} meshes · ${root.stats.rebuilds} rebuilds · ${v.missing.length} missing · ${v.extra.length} extra`);
        const pickStale = picks.reduce((n, { v }) => n + v.missing.length + v.extra.length, 0);
        // The frame's passes (FramePasses.js): the owner, its passes in order, each pass's ms.
        const rp = ctx.renderPasses;
        const passStats = rp ? rp.stats() : [];
        const passLines = rp ? [
            rp.fault ? `  FAIL owner: a second render-loop owner beside RenderPasses — ${rp.fault.offenders.join(' | ')}` : `  owner: RenderPasses (the one render-loop owner) · ${rp.frames} frames · order ${rp.order().join(' → ')}`,
            ...passStats.map((p) => `  ${p.frame ? 'pass' : 'off-frame'} ${p.name.padEnd(8)} p50 ${p.p50.toFixed(2)} ms · p95 ${p.p95.toFixed(2)} ms · last ${p.last.toFixed(2)} ms · ${p.count} timed`),
        ] : [];
        const name = (o) => `  ${pathOf(o)}`;
        const detail = [
            refused ? `  refused: ${refused.reason}: ${refused.object}` : '',
            ...missing.slice(0, 10).map((o) => name(o) + '  (missing)'),
            ...extra.slice(0, 10).map((o) => name(o) + '  (extra)'),
        ].filter(Boolean).join('\n');
        const stale = missing.length + extra.length + pickStale;
        return {
            text: box('RENDER LIST', lines, 60) + (detail ? '\n' + detail : '') + (pickLines.length ? '\n' + pickLines.join('\n') : '')
                + (passLines.length ? '\n' + passLines.join('\n') : '')
                + (stale ? `\nFAIL: a list is stale (${stale})` : rp?.fault ? '\nFAIL: a second render-loop owner' : '\nOK: every list matches a fresh walk'),
            data: {
                enabled: flat.enabled, refused, stats: { ...st }, missing: missing.map(pathOf), extra: extra.map(pathOf),
                passes: { order: rp?.order() ?? [], fault: rp?.fault ?? null, frames: rp?.frames ?? 0, stats: passStats },
                picks: Object.fromEntries(picks.map(({ ch, root, v }) => [ch, { enabled: ps.flatLists, refused: v.refused, stats: { ...root.stats }, missing: v.missing.map(pathOf), extra: v.extra.map(pathOf) }])),
            },
        };
    }, { description: "The view's flat render list and each pick channel's: serving or refused (and why), rebuild counts, and a check against a fresh walk of the scene; 'time [n]' renders the frame n times each way and reports the render call's JS cost, flat vs full, and a center pick's passes each way (30)", usage: '[time [n]]' });

    // Clear all CONTENT grids (the open code files). Leaves terminals alone — those
    // are live/owned and torn down explicitly (terminal.kill). Reuses ctx.removeGrid
    // (the canonical dispose path used by grid.remove): geometry freed, removed from
    // scene, unregistered.
    router.register('scene.clear_grids', (args, ctx) => {
        // Loose grids only — a grid carried as a book's page is the book's,
        // and clearing the field must never reach inside a book.
        const grids = ctx.registry.findLoose('grid');
        if (grids.length === 0) return { text: 'OK: no grids to clear', data: { cleared: 0 } };
        // removeGrids: the canonical bulk-dispose path — zero intermediate re-packs,
        // one world settle at the end.
        const cleared = ctx.removeGrids(grids.map((e) => e.id));
        ctx.fieldSources = []; // no content grids left — the session has no field to restore
        return {
            text: `OK: cleared ${cleared} grid(s)`,
            data: { cleared }
        };
    }, { description: 'Remove all code grids (open files); leaves terminals' });
}
