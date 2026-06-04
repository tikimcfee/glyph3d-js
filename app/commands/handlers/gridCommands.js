/**
 * Grid commands: grid.list, grid.info, grid.color, grid.visibility
 * All grid resolution goes through the registry via resolveGridByIdOrIndex.
 */

import { box, table, kvLines } from '../formatResponse.js';
import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';
import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { decodeBase64 } from '@glyph3d/core/utils/encoding.js';
import { flowLayout } from './layoutCommands.js';

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
        const renderer = grid.getRenderer();
        if (renderer && renderer.setGroupColor) {
            renderer.setGroupColor(0, { r, g, b });
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
            // Path-shaped names double as the sourcePath so file.save and
            // the registry's sourcePath meta resolve without an explicit URI.
            if (name.includes('/')) {
                grid.userData.sourcePath = name;
            }
        }
        grid.loadText(text);

        // Single registration via addGrid -- no double-register
        const registryId = ctx.addGrid(grid, { id: name || undefined });

        // Make the new grid the primary attention target so subsequent
        // no-arg verbs (file.save, mode.reader, etc.) target what the
        // user just made. Matches canvas-click semantics.
        ctx.attentionManager?.set('primary', registryId, { registry: ctx.registry });

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

    router.register('grid.close', (args, ctx) => {
        // Default to the focused grid (attention.primary) — the HUD's "close" fires
        // with no arg; the CLI can pass an id/index.
        const target = args[0] ?? ctx.attentionManager?.get('primary')?.id;
        if (!target) return { text: 'ERR: usage: grid.close <id|index> (or focus a grid first)', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, String(target));
        if (resolved.error) return { text: resolved.error, data: null };
        const id = resolved.registryId;
        const name = resolved.grid.getFilename?.() || id || '(unnamed)';

        // If a workspace sheet renders this panel, closing the SHEET is the full path
        // (derender + drop the tab + clear attention) — delegate so tab and grid agree.
        const ws = ctx.workspace;
        const sheet = ws ? [...ws.sheets.values()].find((s) => s.panelId === id) : null;
        if (sheet) return router.execute(['sheet.close', sheet.id]);

        // A bare field grid (not a tab): clear attention if it points here so focus/key
        // don't dangle on a removed panel, then remove. No reflow — keep the field layout.
        const am = ctx.attentionManager;
        if (am?.get?.('key')?.id === id) am.set('key', null, { registry: ctx.registry });
        if (am?.get?.('primary')?.id === id) am.set('primary', null, { registry: ctx.registry });
        const removed = ctx.removeGrid(id);
        if (!removed) return { text: 'ERR: removal failed', data: null };
        return { text: `OK: closed "${name}"`, data: { removedId: id, name } };
    }, { description: 'Close a grid: sheet.close if it backs a tab, else remove it from the field', usage: '[id|index]' });

    router.register('grid.move', (args, ctx) => {
        if (args.length < 4) return { text: 'ERR: usage: grid.move <id|index> <x> <y> <z>', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].some(isNaN)) return { text: 'ERR: x, y, z must be numbers', data: null };

        // Terminals (if ever resolved here) mirror to their group texture; code
        // grids move via the Object3D transform.
        if (typeof resolved.grid.setWorldPosition === 'function') resolved.grid.setWorldPosition({ x, y, z });
        else resolved.grid.position.set(x, y, z);

        return {
            text: `OK: moved grid #${resolved.idx} to (${x}, ${y}, ${z})`,
            data: { id: resolved.registryId, index: resolved.idx, position: { x, y, z } }
        };
    }, { description: 'Move a grid in 3D space', usage: '<id|index> <x> <y> <z>' });

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

    router.register('grid.rotation', (args, ctx) => {
        if (args.length < 4) return { text: 'ERR: usage: grid.rotation <id|index> <rx> <ry> <rz> (radians)', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };

        const [rx, ry, rz] = args.slice(1, 4).map(Number);
        if ([rx, ry, rz].some(isNaN)) return { text: 'ERR: rx, ry, rz must be numbers (radians)', data: null };
        resolved.grid.rotation.set(rx, ry, rz);
        return {
            text: `OK: grid #${resolved.idx} rotation = (${rx}, ${ry}, ${rz})`,
            data: { index: resolved.idx, rotation: { x: rx, y: ry, z: rz } }
        };
    }, { description: 'Set grid rotation (radians, Euler XYZ)', usage: '<id|index> <rx> <ry> <rz>' });

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

    // grid.window <id|index> <cols> <rows> [firstLine] — turn a code grid into a fixed
    // cols×rows scrollable viewport over its file (opt-in; whole-file is the baseline),
    // then re-flow neighbors around the new footprint. The optional firstLine scrolls the
    // window to an absolute line (used by session restore to reproduce the saved view).
    // The await ensures the rebuilt bounds are fresh before flowLayout measures them.
    router.register('grid.window', async (args, ctx) => {
        if (args.length < 3) return { text: 'ERR: usage: grid.window <id|index> <cols> <rows> [firstLine]', data: null };

        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };
        if (!(resolved.grid instanceof CodeGrid) || typeof resolved.grid.setWindow !== 'function') {
            return { text: 'ERR: grid.window applies only to code grids', data: null };
        }

        const cols = parseInt(args[1], 10);
        const rows = parseInt(args[2], 10);
        if (isNaN(cols) || isNaN(rows) || cols < 1 || rows < 1) {
            return { text: 'ERR: cols and rows must be positive integers', data: null };
        }

        await resolved.grid.setWindow(cols, rows);
        // setWindow leaves firstLine where it was (0 on a fresh grid); an absolute
        // scroll from there reproduces a saved offset. scrollLines clamps internally.
        if (args[3] != null) {
            const firstLine = parseInt(args[3], 10);
            if (!isNaN(firstLine) && firstLine > 0) await resolved.grid.scrollLines(firstLine);
        }
        flowLayout(ctx.getGrids());

        const win = resolved.grid.getWindow();
        return {
            text: `OK: grid #${resolved.idx} windowed to ${cols}x${rows}${win?.firstLine ? ` @line ${win.firstLine}` : ''}`,
            data: { index: resolved.idx, cols, rows, firstLine: win?.firstLine ?? 0 },
        };
    }, { description: 'Window a code grid to a scrollable cols×rows viewport and re-flow', usage: '<id|index> <cols> <rows> [firstLine]' });

    // grid.layout <id|index> [preset] [--flag value ...] — refold a code grid in place
    // (Step 3a). Source + camera stay put; only how the file folds into space changes. A
    // preset is a params bundle; --flags override on top. No params after the id → report
    // current. Re-flows neighbors after (footprint changes). Modes are params, not branches.
    // Presets are COMPLETE fold bundles (every one sets axis) so switching modes always
    // resets the fold — e.g. z-pages → newspaper must clear axis:'z', not inherit it.
    const LAYOUT_PRESETS = {
        newspaper:     { wrapWidth: 200, pageHeight: 150, pagesWide: 5,  axis: 'xy' },  // fan into columns (default)
        'long-column': { wrapWidth: 200, pageHeight: 0,   pagesWide: 1,  axis: 'xy' },  // one tall column; long lines z-wrap
        'no-wrap':     { wrapWidth: 0,   pageHeight: 0,   pagesWide: 1,  axis: 'xy' },  // lines run off right; rows = line count
        wall:          { wrapWidth: 200, pageHeight: 150, pagesWide: 32, axis: 'xy' },  // wide wall of columns marching right
        'z-pages':     { wrapWidth: 200, pageHeight: 150, pagesWide: 1,  axis: 'z'  },  // pages stack in depth (later behind earlier)
    };
    const LAYOUT_FLAGS = {
        '--wrap': 'wrapWidth', '--page-height': 'pageHeight', '--pages-wide': 'pagesWide',
        '--z-spacing': 'zWrapSpacing', '--gap-x': 'pageGapX', '--gap-y': 'pageGapY',
        '--page-depth': 'pageDepth', '--axis': 'axis',  // axis z = pages stack in depth (Step 3b)
    };
    const COUNT_FLAGS = new Set(['wrapWidth', 'pageHeight', 'pagesWide']);  // integer counts → floored
    router.register('grid.layout', async (args, ctx) => {
        const presetNames = Object.keys(LAYOUT_PRESETS).join('|');
        if (args.length < 1) {
            return { text: `ERR: usage: grid.layout <id|index> [${presetNames}] [--wrap N --page-height H --pages-wide W --z-spacing Z --gap-x X --gap-y Y --page-depth D --axis xy|z]`, data: null };
        }
        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };
        if (!(resolved.grid instanceof CodeGrid) || typeof resolved.grid.setLayout !== 'function') {
            return { text: 'ERR: grid.layout applies only to code grids', data: null };
        }

        // No params → report the grid's current layout.
        if (args.length === 1) {
            const cur = resolved.grid.getLayout();
            const kv = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, String(v)]));
            return { text: box(`GRID #${resolved.idx} LAYOUT`, kvLines(kv), 50) + '\nOK: layout', data: { index: resolved.idx, layout: cur } };
        }

        // Build the param patch: an optional leading preset, then --flag overrides.
        const patch = {};
        let i = 1;
        if (!args[1].startsWith('--')) {
            const preset = LAYOUT_PRESETS[args[1]];
            if (!preset) return { text: `ERR: unknown preset "${args[1]}" (${presetNames})`, data: null };
            Object.assign(patch, preset);
            i = 2;
        }
        for (; i < args.length; i += 2) {
            const key = LAYOUT_FLAGS[args[i]];
            if (!key) return { text: `ERR: unknown flag "${args[i]}" (${Object.keys(LAYOUT_FLAGS).join(' ')})`, data: null };
            const raw = args[i + 1];
            if (raw === undefined) return { text: `ERR: ${args[i]} needs a value`, data: null };
            if (key === 'axis') {
                if (raw !== 'xy' && raw !== 'z') return { text: 'ERR: --axis must be xy or z', data: null };
                patch.axis = raw;
                continue;
            }
            const n = Number(raw);
            // Reject Infinity/NaN/negatives — the params struct uses 0 as its off-sentinel,
            // never Infinity (keeps it clean + structured-clone-safe). Counts floor to ints.
            if (!Number.isFinite(n) || n < 0) return { text: `ERR: ${args[i]} must be a finite number ≥ 0`, data: null };
            patch[key] = COUNT_FLAGS.has(key) ? Math.floor(n) : n;
        }

        await resolved.grid.setLayout(patch);
        flowLayout(ctx.getGrids());

        return {
            text: `OK: grid #${resolved.idx} relaid (${resolved.grid.getGlyphCount()} glyphs, ${resolved.grid.getLineCount()} lines)`,
            data: { index: resolved.idx, layout: resolved.grid.getLayout() },
        };
    }, { description: 'Refold a code grid in place: preset or --flags, then re-flow', usage: '<id|index> [preset] [--wrap N ...]' });

    // grid.scroll <id|index> <±rows|top|bottom> — scroll a code grid's content THROUGH the
    // fold (Step 3c, the conveyor). scrollOffset shifts content up by N visual rows; the
    // camera stays put. Folded modes (newspaper/z-pages) flow content between columns/planes.
    // No 2nd arg → report. Re-folds in place; no neighbor reflow (scroll is a frame op).
    router.register('grid.scroll', async (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: grid.scroll <id|index> <±rows|top|bottom>', data: null };
        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };
        const g = resolved.grid;
        if (!(g instanceof CodeGrid) || typeof g.setScrollOffset !== 'function') {
            return { text: 'ERR: grid.scroll applies only to code grids', data: null };
        }

        const report = () => ({
            text: `OK: grid #${resolved.idx} scroll ${g.getScrollOffset()} / ${g.getTotalVisualRows()} rows`,
            data: { index: resolved.idx, scrollOffset: g.getScrollOffset(), totalRows: g.getTotalVisualRows() },
        });

        if (args.length === 1) return report();   // no amount → just report current

        const arg = args[1];
        if (arg === 'top')         await g.setScrollOffset(0);
        else if (arg === 'bottom') await g.setScrollOffset(g.getTotalVisualRows());
        else {
            const delta = parseInt(arg, 10);
            if (isNaN(delta)) return { text: 'ERR: scroll must be an integer (±rows) or top|bottom', data: null };
            await g.scrollBy(delta);
        }
        return report();
    }, { description: 'Scroll a code grid through the fold (the conveyor)', usage: '<id|index> <±rows|top|bottom>' });

    // grid.frame <id|index> <rows|off> — clip a code grid to a fixed window of N visual rows
    // (Step 3c.2, clean-frame-first). A shader vertex cull hides content outside the window;
    // grid.scroll then flows content THROUGH it (the "monitor"). 0/off = no frame (full content).
    router.register('grid.frame', async (args, ctx) => {
        if (args.length < 2) return { text: 'ERR: usage: grid.frame <id|index> <rows|off>', data: null };
        const resolved = resolveGridByIdOrIndex(ctx, args[0]);
        if (resolved.error) return { text: resolved.error, data: null };
        const g = resolved.grid;
        if (!(g instanceof CodeGrid) || typeof g.setFrameRows !== 'function') {
            return { text: 'ERR: grid.frame applies only to code grids', data: null };
        }
        const arg = args[1];
        const rows = (arg === 'off') ? 0 : parseInt(arg, 10);
        if (isNaN(rows) || rows < 0) return { text: 'ERR: frame rows must be a non-negative integer, or off', data: null };
        await g.setFrameRows(rows);
        return {
            text: rows > 0
                ? `OK: grid #${resolved.idx} framed to ${rows} rows (grid.scroll to move content through it)`
                : `OK: grid #${resolved.idx} frame off (full content)`,
            data: { index: resolved.idx, frameRows: g.getFrameRows(), scrollOffset: g.getScrollOffset(), totalRows: g.getTotalVisualRows() },
        };
    }, { description: 'Clip a code grid to a scrollable frame of N visual rows (0/off = full)', usage: '<id|index> <rows|off>' });
}
