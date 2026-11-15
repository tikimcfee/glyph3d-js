/**
 * Scene commands: scene.info, scene.transforms, scene.render, scene.clear_grids
 * Uses registry as source of truth for scene object counts.
 */

import { box, kvLines } from '@glyph3d/core/utils/formatResponse.js';
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

    // The world-matrix walk: what the last frame's walk visited and recomputed, then a check of
    // every world matrix against a recompute from scratch. A stale node is a change the walk never
    // saw — matrixAutoUpdate switched off, a pivot set or Object3D.copy onto a node already in the
    // scene, or a quaternion write that skips three's hook (SceneTransforms' header lists them).
    router.register('scene.transforms', async (args, ctx) => {
        const st = ctx.sceneSystems?.transforms;
        if (!st) throw new Error('scene.transforms: no scene systems on this scene');
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
        const flat = ctx.sceneSystems?.flatRoot;
        if (!flat) throw new Error('scene.render: no flat render root on this scene');
        if (args[0] === 'time') {
            // The frame rendered n times each way, interleaved (the same pixels — tools/flat-root-check.mjs):
            // the render call's JS cost, flat list vs three's full walk. A one-off hitch of ~2n renders.
            const n = Math.max(3, Math.min(200, Number(args[1]) || 30));
            if (!flat.enabled) throw new Error('scene.render time: render.flatRoot is off');
            const r = ctx.renderer, ms = { flat: [], full: [] };
            for (let k = 0; k < n; k++) {
                let t = performance.now(); r.render(ctx.scene, ctx.camera); ms.flat.push(performance.now() - t);
                flat.enabled = false;
                try { t = performance.now(); r.render(ctx.scene, ctx.camera); ms.full.push(performance.now() - t); } finally { flat.enabled = true; }
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
        const name = (o) => `  ${pathOf(o)}`;
        const detail = [
            refused ? `  refused: ${refused.reason}: ${refused.object}` : '',
            ...missing.slice(0, 10).map((o) => name(o) + '  (missing)'),
            ...extra.slice(0, 10).map((o) => name(o) + '  (extra)'),
        ].filter(Boolean).join('\n');
        const stale = missing.length + extra.length + pickStale;
        return {
            text: box('RENDER LIST', lines, 60) + (detail ? '\n' + detail : '') + (pickLines.length ? '\n' + pickLines.join('\n') : '')
                + (stale ? `\nFAIL: a list is stale (${stale})` : '\nOK: every list matches a fresh walk'),
            data: {
                enabled: flat.enabled, refused, stats: { ...st }, missing: missing.map(pathOf), extra: extra.map(pathOf),
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
