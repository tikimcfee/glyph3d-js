// verifyCommands — layout.verify: assert the LIVE scene against the byte pipeline's oracle.
//
// The engine's contract: the GPU's laid-out slots equal the CPU mirror (the reference
// pipeline's output) exactly on the integer lanes and within f32 tolerance on positions.
// This verb checks that contract on a real grid in the running app — GPU slot readback vs
// the mirror the grid already holds, plus the GPU-atomics bounds vs the mirror's bounds.
// Zero divergence is the only PASS. Run it the moment a scene looks wrong —
// `glyph3d-cli layout.verify <grid>` — and the verdict separates "engine math broke"
// from "the inputs/app state broke".

import { resolveGridByIdOrIndex } from './spatialHelpers.js';

export default function registerVerifyCommands(router) {
    router.register('layout.verify', async (args, ctx) => {
        const target = String(args[0] ?? ctx.attention?.primary?.id ?? '');
        if (!target) return { text: 'ERR: no grid — pass <grid> or focus one', data: null };
        const resolved = resolveGridByIdOrIndex(ctx, target, 'grid', { byName: true });
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const grid = resolved.grid;
        const pipeline = grid._pipeline;
        if (!pipeline) {
            return { text: 'layout.verify — no byte pipeline on this grid (terminal/frame/label?); nothing to verify', data: { ok: null, engine: 'none' } };
        }

        const v = await pipeline.verify();
        const b = pipeline.mirror?.bounds;
        const name = grid.filename || target;
        const span = b ? `x ${b.min.x.toFixed(1)}…${b.max.x.toFixed(1)} y ${b.min.y.toFixed(1)}…${b.max.y.toFixed(1)} z ${b.min.z.toFixed(1)}…${b.max.z.toFixed(1)} rows ${b.totalRows}` : 'no bounds';
        const text = v.ok
            ? `layout.verify ✓ ${name}: ${pipeline.byteLength} byte-slots, GPU == mirror (worst ${(v.worst ?? 0).toExponential(1)}); ${span}`
            : `layout.verify ✗ ${name}: ${v.badRows} integer-lane divergences, worst position |Δ| ${(v.worst ?? NaN).toExponential(2)}${v.reason ? ' — ' + v.reason : ''}`;
        return { text, data: { ok: v.ok, engine: 'byte-pipeline', ...v } };
    });
}
