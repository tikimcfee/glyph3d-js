// verifyCommands — layout.verify: assert the LIVE scene against the fold invariant.
//
// The GPU layout engine's contract is that rendered positions equal fold + displacement,
// where every fold input is CPU-authored. This verb checks that contract on a real grid in
// the running app: read the storage attribute back, evaluate the same fold CPU-side
// (grid._engineFoldScratch → evaluateFold), add the displacement table, diff every slot.
// Zero over-epsilon is the only PASS. Run it the moment a scene looks wrong —
// `glyph3d-cli layout.verify <grid>` — and the verdict separates "engine math broke"
// (over > 0: report it, with the worst slot) from "the inputs/app state broke" (the
// engine faithfully rendered garbage inputs; look upstream at tables/arrangers/HMR).

import { resolveGridByIdOrIndex } from './spatialHelpers.js';

export default function registerVerifyCommands(router) {
    router.register('layout.verify', async (args, ctx) => {
        const target = String(args[0] ?? ctx.attention?.primary?.id ?? '');
        if (!target) return { text: 'ERR: no grid — pass <grid> or focus one', data: null };
        const resolved = resolveGridByIdOrIndex(ctx, target, 'grid', { byName: true });
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const grid = resolved.grid;
        const field = grid._renderer;
        if (!field?.instanceMesh) return { text: 'ERR: grid has no field', data: null };
        if (field.gpuLayout !== true) {
            // Grids are always engine-owned; a non-engine field here is a terminal,
            // frame, or label — CPU-buffered placement, nothing to verify against a fold.
            return { text: 'layout.verify — not an engine field (terminal/frame/label); the fold invariant does not apply', data: { ok: null, engine: 'cpu' } };
        }
        const renderer = ctx.renderer;
        if (!renderer?.getArrayBufferAsync) return { text: 'ERR: no renderer readback available', data: null };

        const attr = field.instanceMesh.geometry.attributes.instancePosition;
        const n = field.instanceMesh.geometry.instanceCount;
        const stride = attr.itemSize;
        const scratch = grid._engineFoldScratch?.();
        if (!scratch) return { text: 'ERR: could not evaluate the fold (no scratch)', data: null };
        const D = field._layoutDisplacements ?? null;

        const raw = new Float32Array(await renderer.getArrayBufferAsync(attr));
        let over = 0, worst = 0, worstSlot = -1;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 3; k++) {
                const v = raw[i * stride + k];
                if (v < mn[k]) mn[k] = v;
                if (v > mx[k]) mx[k] = v;
                const want = scratch[i * 3 + k] + (D ? D[i * 3 + k] : 0);
                const d = Math.abs(v - want);
                if (d > worst) { worst = d; worstSlot = i; }
                if (d > 1e-4) over++;
            }
        }
        // Table sanity — the inputs the fold trusts, checked for the failure shapes that
        // render "confident garbage": non-monotonic line tables, entries outside the buffer,
        // a displacement table that does not cover the field.
        const entries = [...field.renderedTexts.values()];
        const tableIssues = [];
        for (const e of entries) {
            const lso = e.lineSlotOffsets;
            if (!lso || !lso.length) { tableIssues.push(`entry ${e.id}: no line table`); continue; }
            if (lso[0] !== e.bufferStartIndex) tableIssues.push(`entry ${e.id}: line table starts at ${lso[0]}, base is ${e.bufferStartIndex}`);
            for (let i = 1; i < lso.length; i++) if (lso[i] < lso[i - 1]) { tableIssues.push(`entry ${e.id}: line table not monotonic at ${i}`); break; }
            if (e.bufferStartIndex + e.glyphCount > n) tableIssues.push(`entry ${e.id}: range exceeds buffer (${e.bufferStartIndex}+${e.glyphCount} > ${n})`);
        }
        if (D && D.length < n * 3) tableIssues.push(`displacement table short: ${D.length} < ${n * 3}`);

        const ok = over === 0 && tableIssues.length === 0;
        const span = (k) => `${mn[k].toFixed(1)}…${mx[k].toFixed(1)}`;
        const text = ok
            ? `layout.verify ✓ ${resolved.grid.filename || target}: ${n} slots, GPU == fold+D exactly (worst ${worst.toExponential(1)}); x ${span(0)} y ${span(1)} z ${span(2)}`
            : `layout.verify ✗ ${resolved.grid.filename || target}: ${over} lanes diverged (worst ${worst.toExponential(2)} at slot ${worstSlot})${tableIssues.length ? '; tables: ' + tableIssues.join(' | ') : ''}`;
        return {
            text,
            data: { ok, engine: 'gpu', count: n, over, worst, worstSlot, dispArmed: !!D,
                entries: entries.length, tableIssues, spans: { x: span(0), y: span(1), z: span(2) } },
        };
    });
}
