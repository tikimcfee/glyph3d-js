/**
 * Layout commands: layout.info, layout.list, layout.flow
 * Layout introspection + a bounds-aware shelf arranger.
 */

import { box, kvLines } from '../formatResponse.js';

/**
 * Flow-pack grids into a wrapping shelf using their real world bounds + a margin.
 * Top-aligned within each row; wraps to a new row when a row would exceed
 * `wrapWidth`. Grids are pure-translation Object3Ds, so local extent =
 * worldBounds − position; we place each grid's top-left at the running cursor.
 *
 * This is the shared layout primitive: layout.flow runs it on all grids, and
 * file.open runs it after adding a grid so opening never stacks them.
 *
 * @param {Array} grids - CodeGrid instances (ctx.getGrids())
 * @param {{margin?: number, wrapWidth?: number}} [opts]
 * @returns {{placed: number, rows: number, width: number, height: number}}
 */
export function flowLayout(grids, { margin = 16, wrapWidth } = {}) {
    // Measure first — local extent is independent of where we'll move things.
    const items = [];
    for (const g of grids) {
        g.updateMatrixWorld(true);
        const wb = g.getBounds?.();
        if (!wb || wb.isEmpty()) continue;
        items.push({
            g,
            w: wb.max.x - wb.min.x,
            h: wb.max.y - wb.min.y,
            localMinX: wb.min.x - g.position.x,
            localMaxY: wb.max.y - g.position.y,
        });
    }
    if (items.length === 0) return { placed: 0, rows: 0, width: 0, height: 0 };

    // Default wrap: ~3 of the widest grid per row, so the shelf adapts to content
    // scale instead of guessing world units.
    if (!wrapWidth || wrapWidth <= 0) {
        wrapWidth = Math.max(...items.map((i) => i.w)) * 3;
    }

    let cx = 0, topY = 0, rowH = 0, rows = 1, maxRowW = 0;
    for (const it of items) {
        if (cx > 0 && cx + it.w > wrapWidth) {
            maxRowW = Math.max(maxRowW, cx - margin);
            cx = 0; topY -= rowH + margin; rowH = 0; rows++;
        }
        it.g.position.x = cx - it.localMinX;   // left edge at cx
        it.g.position.y = topY - it.localMaxY; // top edge at topY
        it.g.updateMatrixWorld(true);
        it.g._markBoundsDirty?.();             // position changed → bounds cache stale
        cx += it.w + margin;
        rowH = Math.max(rowH, it.h);
    }
    maxRowW = Math.max(maxRowW, cx - margin);
    return { placed: items.length, rows, width: maxRowW, height: -topY + rowH };
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerLayoutCommands(router) {
    router.register('layout.flow', (args, ctx) => {
        const margin = args[0] != null ? parseFloat(args[0]) : undefined;
        const wrapWidth = args[1] != null ? parseFloat(args[1]) : undefined;
        const r = flowLayout(ctx.getGrids(), { margin, wrapWidth });
        if (r.placed === 0) return { text: 'OK: nothing to lay out', data: r };
        return {
            text: `OK: laid out ${r.placed} grids in ${r.rows} row(s)`,
            data: r,
        };
    }, {
        description: 'Arrange all loaded grids into a wrapping shelf (bounds + margin)',
        usage: '[margin] [wrapWidth]',
        returns: '{ placed, rows, width, height }',
    });

    router.register('layout.info', (args, ctx) => {
        const active = ctx.getActiveLayout ? ctx.getActiveLayout() : 'unknown';

        const data = {
            'active': active,
            'available': Object.keys(ctx.layoutManagers || {}).join(', ') || 'none',
        };

        return {
            text: box('LAYOUT', kvLines(data), 40),
            data: { active, available: Object.keys(ctx.layoutManagers || {}) }
        };
    }, { description: 'Show current layout details' });

    router.register('layout.list', (args, ctx) => {
        const managers = ctx.layoutManagers || {};
        const active = ctx.getActiveLayout ? ctx.getActiveLayout() : null;
        const names = Object.keys(managers);

        if (names.length === 0) {
            return { text: 'No layout managers available', data: { layouts: [] } };
        }

        const lines = names.map(n =>
            n === active ? `> ${n} (active)` : `  ${n}`
        );

        return {
            text: box('LAYOUTS', lines, 30),
            data: { layouts: names, active }
        };
    }, { description: 'List available layout modes' });
}
