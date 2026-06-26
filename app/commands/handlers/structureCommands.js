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
import StrataLayout from '@glyph3d/core/collections/StrataLayout.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';

const KINDS = new Set(['function', 'method', 'class', 'interface', 'enum', 'type', 'variable', 'field']);

/** Per-grid controllers, keyed weakly so they die with the grid. */
const _controllers = new WeakMap();
function controllerFor(grid) {
    let c = _controllers.get(grid);
    if (!c) { c = new StructureLayout(grid); _controllers.set(grid, c); }
    return c;
}

/** Per-grid strata controllers (the nested Z-depth view), separate from the lens above. */
const _strata = new WeakMap();
function strataFor(grid) {
    let c = _strata.get(grid);
    if (!c) { c = new StrataLayout(grid); _strata.set(grid, c); }
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

        const res = await controllerFor(grid).grid(kind);
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

    router.register('structure.inspect', async (args, ctx) => {
        // structure.inspect [grid] [kind] — dump AST-vs-slot boundaries to find offsets.
        let gridArg = null, kind = null;
        if (args.length === 1) { if (KINDS.has(args[0])) kind = args[0]; else gridArg = args[0]; }
        else if (args.length >= 2) { gridArg = args[0]; kind = args[1]; }
        const resolved = resolveGrid(ctx, gridArg);
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const grid = resolved.grid;
        if (typeof grid.ensureSemantics === 'function') await grid.ensureSemantics();
        const res = controllerFor(grid).inspect(kind);
        if (!res.ok) return { text: `ERR: ${res.reason}`, data: null };
        const rows = res.blocks.map((b, i) =>
            `[${i}] ${b.kind} ${b.name || '·'}\n` +
            `    node  ${b.node}   slots ${b.slots}\n` +
            `    head  ${JSON.stringify(b.head)}  →slotHead ${JSON.stringify(b.slotHead?.ch)} @${b.slotHead?.at}\n` +
            `    tail  ${JSON.stringify(b.tail)}  →slotTail ${JSON.stringify(b.slotTail?.ch)} @${b.slotTail?.at}`,
        );
        return { text: `STRUCTURE INSPECT — ${res.count} block(s):\n${rows.join('\n')}`, data: res };
    }, {
        description: 'Debug: dump each AST block\'s claimed boundaries vs the slot range it moves',
        usage: '[grid] [kind]',
        returns: '{ count, blocks }',
    });

    router.register('structure.strata', async (args, ctx) => {
        // structure.strata [grid] — TOGGLE a nested Z-depth strata view: every AST node
        // floats forward by its nesting level and gets a border box, text staying readable
        // in X/Y. Toggling keeps it a single self-contained verb.
        const resolved = resolveGrid(ctx, args[0] ?? null);
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const grid = resolved.grid;
        if (typeof grid.ensureSemantics !== 'function') {
            return { text: 'ERR: grid has no semantic model (not a code grid?)', data: null };
        }
        await grid.ensureSemantics();

        const ctrl = strataFor(grid);
        if (ctrl.active) {
            await ctrl.reset();
            return { text: `OK: ${resolved.registryId} strata off`, data: { registryId: resolved.registryId, active: false } };
        }
        const res = await ctrl.start();
        if (!res.ok) return { text: `ERR: ${res.reason}`, data: null };
        return {
            text: `OK: strata on — ${res.count} node(s), depth 0..${res.maxDepth}`,
            data: { registryId: resolved.registryId, active: true, ...res },
        };
    }, {
        description: 'Toggle a nested Z-depth strata view: AST nodes float forward by nesting level + get border boxes (text stays readable in X/Y)',
        usage: '[grid]',
        returns: '{ ok, active, count, maxDepth }',
    });

    router.register('structure.reset', async (args, ctx) => {
        const resolved = resolveGrid(ctx, args[0] ?? null);
        if (resolved.error) return { text: `ERR: ${resolved.error}`, data: null };
        const res = await controllerFor(resolved.grid).reset();
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
