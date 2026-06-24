/**
 * structure.* — AST-driven sub-layouts. Re-arrange a code grid's glyphs by
 * semantic entity (the arborist + the move/hide/measure atoms on GlyphField),
 * via a per-grid StructureLayout controller. Language-agnostic: it reads the
 * SemanticModel's normalized kinds.
 *
 *   structure.grid  [grid] [kind]   — top-level <kind> blocks → grid sorted by area
 *   structure.reset [grid]          — back to the normal flow layout
 */
import StructureLayout from '@glyph3d/core/collections/StructureLayout.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';

const KINDS = new Set(['function', 'method', 'class', 'interface', 'enum', 'type', 'variable', 'field']);

/** Per-grid controllers, keyed weakly so they die with the grid. */
const _controllers = new WeakMap();
function controllerFor(grid) {
    let c = _controllers.get(grid);
    if (!c) { c = new StructureLayout(grid); _controllers.set(grid, c); }
    return c;
}

function resolveGrid(ctx, gridArg) {
    const targetId = gridArg ?? ctx.attention?.primary?.id ?? ctx.attention?.key?.id ?? null;
    if (!targetId) return { error: 'no focused grid — open a file or pass <grid>' };
    return resolveGridByIdOrIndex(ctx, String(targetId), 'grid', { byName: true });
}

export default function registerStructureCommands(router) {
    router.register('structure.grid', async (args, ctx) => {
        // [grid] [kind]; a lone arg that's a known kind applies to the focused grid.
        // No kind → the "callable units" default (functions + methods at any depth).
        let gridArg = null, kind = null;
        if (args.length === 1) {
            if (KINDS.has(args[0])) kind = args[0]; else gridArg = args[0];
        } else if (args.length >= 2) {
            gridArg = args[0]; kind = args[1];
        }

        const resolved = resolveGrid(ctx, gridArg);
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const grid = resolved.grid;
        if (typeof grid.ensureSemantics !== 'function') {
            return { text: 'ERR: grid has no semantic model (not a code grid?)', data: null };
        }
        await grid.ensureSemantics();

        const res = controllerFor(grid).grid(kind);
        if (!res.ok) {
            const hint = res.available?.length ? ` (file has: ${res.available.join(', ')})` : '';
            return { text: `ERR: ${res.reason}${hint}`, data: null };
        }
        // Footprint changed → re-fit the scene so the grown grid flows back in among its
        // neighbours, exactly like a layout-mode change (only the caller can relayout the tree).
        ctx.contentTree?.relayoutAndRest();
        return {
            text: `OK: ${res.count} ${kind || 'callable'} block(s) → size-sorted grid`,
            data: { registryId: resolved.registryId, ...res },
        };
    }, {
        description: 'Arrange a code grid\'s top-level <kind> blocks into a grid sorted by glyph area (AST-driven, hides the rest)',
        usage: '[grid] [kind=function]',
        returns: '{ ok, count }',
    });

    router.register('structure.reset', (args, ctx) => {
        const resolved = resolveGrid(ctx, args[0] ?? null);
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const res = controllerFor(resolved.grid).reset();
        ctx.contentTree?.relayoutAndRest(); // footprint shrank back → re-fit the scene
        return res.ok
            ? { text: `OK: ${resolved.registryId} restored to flow layout`, data: { registryId: resolved.registryId } }
            : { text: 'ERR: grid has no renderer', data: null };
    }, {
        description: 'Restore a code grid from a structure.* arrangement back to its normal flow layout',
        usage: '[grid]',
        returns: '{ registryId }',
    });
}
