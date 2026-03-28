/**
 * Grid commands: grid.list, grid.info, grid.color, grid.visibility
 * Migrated from stale WebSocket branch to use context bag.
 */

import { box, table, kvLines } from '../TUIFormatter.js';
import CodeGrid from '../../../../src/collections/CodeGrid.js';

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

    // ============ Grid CRUD ============

    router.register('grid.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: grid.create <base64-text> [name]', data: null };
        }

        let text;
        try { text = atob(args[0]); } catch { return { text: 'ERR: invalid base64 content', data: null }; }
        const name = args[1] || null;

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: name || `cli-grid-${Date.now()}`,
            showBackground: true,
            showFilename: !!name,
        });

        if (name) {
            grid.filename = name;
        }
        grid.loadText(text);

        // Register in registry before addGrid (which auto-registers with generated ID)
        const registryId = name || grid.name;
        ctx.registry.register(registryId, grid, { type: 'grid', name });

        ctx.addGrid(grid);

        const idx = ctx.getGrids().length - 1;
        return {
            text: `OK: created grid #${idx} "${registryId}" (${grid.getGlyphCount()} glyphs, ${grid.getLineCount()} lines)`,
            data: { index: idx, registryId, name: name || grid.name, glyphs: grid.getGlyphCount(), lines: grid.getLineCount() }
        };
    }, { description: 'Create a grid with text content', usage: '<text> [name]' });

    router.register('grid.remove', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 1) return { text: 'ERR: usage: grid.remove <index>', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]} (0-${grids.length - 1})`, data: null };
        }

        const grid = grids[idx];
        const name = grid.getFilename() || grid.name || '(unnamed)';
        ctx.removeGrid(idx);

        return {
            text: `OK: removed grid #${idx} "${name}"`,
            data: { removedIndex: idx, name, remaining: grids.length }
        };
    }, { description: 'Remove a grid from the scene', usage: '<index>' });

    router.register('grid.text', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) return { text: 'ERR: usage: grid.text <index> <base64-text>', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]}`, data: null };
        }
        let text;
        try { text = atob(args[1]); } catch { return { text: 'ERR: invalid base64 content', data: null }; }
        grids[idx].loadText(text);
        return {
            text: `OK: grid #${idx} text updated (${grids[idx].getGlyphCount()} glyphs, ${grids[idx].getLineCount()} lines)`,
            data: { index: idx, glyphs: grids[idx].getGlyphCount(), lines: grids[idx].getLineCount() }
        };
    }, { description: 'Replace grid text content', usage: '<index> <text>' });

    router.register('grid.position', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 4) return { text: 'ERR: usage: grid.position <index> <x> <y> <z>', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]}`, data: null };
        }
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };
        grids[idx].position.set(x, y, z);
        return {
            text: `OK: grid #${idx} position = (${x}, ${y}, ${z})`,
            data: { index: idx, position: { x, y, z } }
        };
    }, { description: 'Set grid world position', usage: '<index> <x> <y> <z>' });

    router.register('grid.scale', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) return { text: 'ERR: usage: grid.scale <index> <factor>', data: null };
        const idx = parseInt(args[0]);
        if (isNaN(idx) || idx < 0 || idx >= grids.length) {
            return { text: `ERR: invalid grid index ${args[0]}`, data: null };
        }
        const scale = parseFloat(args[1]);
        if (isNaN(scale)) return { text: 'ERR: scale must be a number', data: null };
        grids[idx].scale.setScalar(scale);
        return {
            text: `OK: grid #${idx} scale = ${scale}`,
            data: { index: idx, scale }
        };
    }, { description: 'Set grid uniform scale', usage: '<index> <factor>' });
}
