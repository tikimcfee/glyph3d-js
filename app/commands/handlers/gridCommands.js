/**
 * Grid commands: grid.list, grid.info, grid.color, grid.visibility
 * All grid resolution goes through the registry via resolveGridByIdOrIndex.
 */

import { box, table, kvLines } from '../formatResponse.js';
import CodeGrid from '../../../src/collections/CodeGrid.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { decodeBase64 } from '../../../src/utils/encoding.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerGridCommands(router) {
    router.register('grid.list', (args, ctx) => {
        const entries = ctx.registry.findByType('grid');
        if (entries.length === 0) {
            return {
                text: box('GRIDS', ['(no grids loaded)'], 50) + '\nOK: 0 grids',
                data: { grids: [], count: 0 }
            };
        }

        const headers = ['#', 'id', 'filename', 'glyphs', 'lines'];
        const rows = entries.map((e, i) => {
            const g = e.grid;
            const name = g.getFilename() || g.getSourcePath() || '(unnamed)';
            return [
                String(i),
                e.id.length > 35 ? '\u2026' + e.id.slice(-34) : e.id,
                name.length > 25 ? '\u2026' + name.slice(-24) : name,
                String(g.getGlyphCount()),
                String(g.getLineCount()),
            ];
        });

        const gridData = entries.map((e, i) => ({
            index: i,
            id: e.id,
            filename: e.grid.getFilename(),
            sourcePath: e.grid.getSourcePath(),
            glyphs: e.grid.getGlyphCount(),
            lines: e.grid.getLineCount(),
        }));

        return {
            text: table(headers, rows) + `\nOK: ${entries.length} grids`,
            data: { grids: gridData, count: entries.length }
        };
    }, { description: 'List all loaded grids' });

    router.register('grid.info', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: grid.info <id|index>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const g = resolved.grid;
        const pos = g.position;

        const data = {
            'index': String(resolved.idx),
            'registryId': resolved.registryId || '(none)',
            'filename': g.getFilename() || '(none)',
            'sourcePath': g.getSourcePath() || '(none)',
            'glyphs': String(g.getGlyphCount()),
            'lines': String(g.getLineCount()),
            'maxWidth': String(g.getMaxLineWidth()),
            'position': `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
            'visible': String(g.visible),
        };

        return {
            text: box(`GRID #${resolved.idx}`, kvLines(data), 50) + '\nOK: grid info',
            data: {
                index: resolved.idx,
                registryId: resolved.registryId,
                filename: g.getFilename(),
                sourcePath: g.getSourcePath(),
                glyphs: g.getGlyphCount(),
                lines: g.getLineCount(),
                position: { x: pos.x, y: pos.y, z: pos.z },
                visible: g.visible,
            }
        };
    }, { description: 'Show grid details', usage: '<id|index>' });

    router.register('grid.color', (args, ctx) => {
        if (args.length < 4) return { text: 'ERR: usage: grid.color <id|index> <r> <g> <b> (0-1 floats)', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const [r, g, b] = args.slice(1, 4).map(Number);
        if ([r, g, b].some(isNaN)) return { text: 'ERR: r, g, b must be numbers (0-1)', data: null };

        const grid = resolved.grid;
        const collection = grid.getCollection();
        if (collection && collection.setGroupColor) {
            collection.setGroupColor(0, { r, g, b });
        }
        return {
            text: `OK: grid ${resolved.idx} color set to (${r}, ${g}, ${b})`,
            data: { index: resolved.idx, color: { r, g, b } }
        };
    }, { description: 'Set grid text color', usage: '<id|index> <r> <g> <b>' });

    router.register('grid.visibility', (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: grid.visibility <id|index> <true|false>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const visible = args[1].toLowerCase() === 'true' || args[1] === '1';
        resolved.grid.visible = visible;
        return {
            text: `OK: grid ${resolved.idx} visibility = ${visible}`,
            data: { index: resolved.idx, visible }
        };
    }, { description: 'Show/hide a grid', usage: '<id|index> <true|false>' });

    // ============ Grid CRUD ============

    router.register('grid.create', (args, ctx) => {
        if (args.length < 1) {
            return { text: 'ERR: usage: grid.create <base64-text> [name]', data: null };
        }

        let text;
        try { text = decodeBase64(args[0]); } catch { return { text: 'ERR: invalid base64 content', data: null }; }
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

        // Single registration via addGrid -- no double-register
        const registryId = ctx.addGrid(grid, { id: name || undefined });

        const idx = ctx.getGrids().length - 1;
        return {
            text: `OK: created grid #${idx} "${registryId}" (${grid.getGlyphCount()} glyphs, ${grid.getLineCount()} lines)`,
            data: { index: idx, registryId, name: name || grid.name, glyphs: grid.getGlyphCount(), lines: grid.getLineCount() }
        };
    }, { description: 'Create a grid with text content', usage: '<text> [name]' });

    router.register('grid.remove', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: grid.remove <id|index>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const name = resolved.grid.getFilename?.() || resolved.registryId || '(unnamed)';
        const removedEntry = ctx.removeGrid(resolved.registryId || resolved.idx);
        if (!removedEntry) return { text: 'ERR: removal failed', data: null };

        return {
            text: `OK: removed "${name}" (was #${resolved.idx})`,
            data: { removedId: resolved.registryId, removedIndex: resolved.idx, name }
        };
    }, { description: 'Remove a grid from the scene', usage: '<id|index>' });

    router.register('grid.text', (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: grid.text <id|index> <base64-text>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        let text;
        try { text = decodeBase64(args[1]); } catch { return { text: 'ERR: invalid base64 content', data: null }; }
        resolved.grid.loadText(text);
        return {
            text: `OK: grid #${resolved.idx} text updated (${resolved.grid.getGlyphCount()} glyphs, ${resolved.grid.getLineCount()} lines)`,
            data: { index: resolved.idx, glyphs: resolved.grid.getGlyphCount(), lines: resolved.grid.getLineCount() }
        };
    }, { description: 'Replace grid text content', usage: '<id|index> <text>' });

    router.register('grid.position', (args, ctx) => {
        if (args.length < 4) return { text: 'ERR: usage: grid.position <id|index> <x> <y> <z>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };
        resolved.grid.position.set(x, y, z);
        return {
            text: `OK: grid #${resolved.idx} position = (${x}, ${y}, ${z})`,
            data: { index: resolved.idx, position: { x, y, z } }
        };
    }, { description: 'Set grid world position', usage: '<id|index> <x> <y> <z>' });

    router.register('grid.scale', (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: grid.scale <id|index> <factor>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const scale = parseFloat(args[1]);
        if (isNaN(scale)) return { text: 'ERR: scale must be a number', data: null };
        resolved.grid.scale.setScalar(scale);
        return {
            text: `OK: grid #${resolved.idx} scale = ${scale}`,
            data: { index: resolved.idx, scale }
        };
    }, { description: 'Set grid uniform scale', usage: '<id|index> <factor>' });
}
