/**
 * Grid commands: grid.list, grid.info, grid.color, grid.visibility
 * Migrated from stale WebSocket branch to use context bag.
 */

import { box, table, kvLines } from '../TUIFormatter.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerGridCommands(router) {
    router.register('grid.list', (args, ctx) => {
        const grids = ctx.getGrids();
        if (grids.length === 0) {
            return {
                text: box('GRIDS', ['(no grids loaded)'], 50) + '\nOK: 0 grids',
                data: { grids: [], count: 0 }
            };
        }

        const headers = ['#', 'filename', 'glyphs', 'lines', 'position'];
        const rows = grids.map((g, i) => {
            const name = g.getFilename() || g.getSourcePath() || '(unnamed)';
            const pos = g.position;
            return [
                String(i),
                name.length > 30 ? '\u2026' + name.slice(-29) : name,
                String(g.getGlyphCount()),
                String(g.getLineCount()),
                `${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`
            ];
        });

        const gridData = grids.map((g, i) => ({
            index: i,
            filename: g.getFilename(),
            sourcePath: g.getSourcePath(),
            glyphs: g.getGlyphCount(),
            lines: g.getLineCount(),
        }));

        return {
            text: table(headers, rows) + `\nOK: ${grids.length} grids`,
            data: { grids: gridData, count: grids.length }
        };
    }, { description: 'List all loaded grids' });

    router.register('grid.info', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 1) return { text: 'ERR: usage: grid.info <index>', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
        }

        const g = grids[idx];
        const pos = g.position;

        const data = {
            'index': String(idx),
            'filename': g.getFilename() || '(none)',
            'sourcePath': g.getSourcePath() || '(none)',
            'glyphs': String(g.getGlyphCount()),
            'lines': String(g.getLineCount()),
            'maxWidth': String(g.getMaxLineWidth()),
            'position': `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
            'visible': String(g.visible),
        };

        return {
            text: box(`GRID #${idx}`, kvLines(data), 50) + '\nOK: grid info',
            data: {
                index: idx,
                filename: g.getFilename(),
                sourcePath: g.getSourcePath(),
                glyphs: g.getGlyphCount(),
                lines: g.getLineCount(),
                position: { x: pos.x, y: pos.y, z: pos.z },
                visible: g.visible,
            }
        };
    }, { description: 'Show grid details', usage: '<index>' });

    router.register('grid.color', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 4) return { text: 'ERR: usage: grid.color <index> <r> <g> <b> (0-1 floats)', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]}`, data: null };
        }
        const [r, g, b] = args.slice(1, 4).map(Number);
        if ([r, g, b].some(isNaN)) return { text: 'ERR: r, g, b must be numbers (0-1)', data: null };

        const grid = grids[idx];
        const collection = grid.getCollection();
        if (collection && collection.setGroupColor) {
            collection.setGroupColor(0, { r, g, b });
        }
        return {
            text: `OK: grid ${idx} color set to (${r}, ${g}, ${b})`,
            data: { index: idx, color: { r, g, b } }
        };
    }, { description: 'Set grid text color', usage: '<index> <r> <g> <b>' });

    router.register('grid.visibility', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) return { text: 'ERR: usage: grid.visibility <index> <true|false>', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]}`, data: null };
        }
        const visible = args[1].toLowerCase() === 'true' || args[1] === '1';
        grids[idx].visible = visible;
        return {
            text: `OK: grid ${idx} visibility = ${visible}`,
            data: { index: idx, visible }
        };
    }, { description: 'Show/hide a grid', usage: '<index> <true|false>' });
}
