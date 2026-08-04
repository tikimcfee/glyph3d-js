/**
 * Memory commands: mem.view — render a file's raw bytes as a hexdump glyph field.
 *
 * The first OS-in-3D artifact (project_memory_viewer): bytes faulted in via the
 * fs/readRange tap, formatted by bytesToHexView, dropped into a CodeGrid through
 * the EXISTING text path. Proves the substrate renders literal machine bytes,
 * not just source text. Color-by-entropy and pointer-edges come next; this is
 * the on-screen proof first.
 */

import CodeGrid from '@glyph3d/core/collections/CodeGrid.js';
import { bytesToHexView } from '@glyph3d/core/memory/hexView.js';
import { decorateMemoryGrid } from '@glyph3d/core/memory/memoryGridView.js';
import { buildMemoryLegend } from '@glyph3d/core/memory/memoryLegend.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerMemoryCommands(router) {
    // mem.view <path> [offset] [length] [cols]
    router.register('mem.view', async (args, ctx) => {
        const path = args[0];
        if (!path) return { text: 'ERR: usage: mem.view <path> [offset] [length] [cols]', data: null };
        if (typeof ctx.fileProvider?.readRange !== 'function') {
            return { text: 'ERR: mem.view needs the local relay (byte-range reads); not available for a GitHub repo', data: null };
        }

        const offset = Math.max(0, parseInt(args[1] ?? '0', 10) || 0);
        const length = Math.max(1, parseInt(args[2] ?? '512', 10) || 512);
        const cols = Math.max(1, parseInt(args[3] ?? '16', 10) || 16);

        const uri = `file:///${String(path).replace(/^\/+/, '')}`;
        let res;
        try {
            res = await ctx.fileProvider.readRange(uri, offset, length);
        } catch (err) {
            return { text: `ERR: readRange failed for ${path}: ${err?.message || err}`, data: null };
        }

        const dump = bytesToHexView(res.bytes, { cols, baseOffset: res.offset });

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: `${path} @0x${offset.toString(16)}`,
            showBackground: true,
            showFilename: true,
            // Hexdump is ~3.7 chars/byte; default 50k cap truncates windows past ~13KB.
            maxChars: Math.max(50000, dump.length + 1024),
            // Neutral dark base: per-byte highlight color is ADDITIVE, so a green
            // base would tint every byte green (zeros included). A dim slate base
            // lets byteColor read true while keeping address/ascii gutters legible.
            textColor: { r: 0.22, g: 0.26, b: 0.32 },
        });
        await grid.loadText(dump);

        const registryId = ctx.addGrid(grid, { id: `mem:${path}:${offset}` });
        ctx.attentionManager?.set('primary', registryId, { registry: ctx.registry });

        // The awaited load guarantees buffers + the LayoutDescription exist, so
        // positionAt resolves immediately. decorateMemoryGrid draws its own
        // grid-parented edges, so no renderer arg.
        const viz = decorateMemoryGrid(grid, res.bytes, { cols, windowOffset: res.offset });

        // Companion legend grid: color/accent/edge key + window stats + an
        // inspect slot (rewritten on hover once interactive inspect lands).
        const legend = buildMemoryLegend({
            path, offset: res.offset, length: res.length, totalSize: res.totalSize, edges: viz.edges,
        });
        const legendGrid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: 'mem-legend', showBackground: true, showFilename: false,
            textColor: { r: 0.55, g: 0.6, b: 0.66 },
        });
        await legendGrid.loadText(legend.text);
        for (const c of legend.colorings) {
            legendGrid.highlightRange(c.line, c.startCol, c.line, c.endCol, c.color);
        }
        const legendId = ctx.addGrid(legendGrid, { id: `mem-legend:${path}:${offset}` });
        // Place to the LEFT of the memory grid, top-aligned (bounds are world-space
        // at position 0,0,0 → shift right edge to mem.min.x and top to mem.max.y).
        legendGrid.position.set(0, 0, 0);
        legendGrid.updateMatrixWorld(true);
        const lb = legendGrid.getBounds();
        const mb = grid.getBounds();
        const gap = Math.max(2, (mb.max.x - mb.min.x) * 0.05);
        legendGrid.position.set(mb.min.x - gap - lb.max.x, mb.max.y - lb.max.y, grid.position.z);
        legendGrid.updateMatrixWorld(true);
        grid._legendGrid = legendGrid;          // for interactive inspect (next batch)
        grid._memInspectMeta = { cols, baseOffset: res.offset, bytes: res.bytes, inspectLine: legend.inspectLine };

        const sizeHex = `0x${(res.totalSize ?? 0).toString(16)}`;
        return {
            text: `OK: mem.view ${path} — ${res.length} bytes @0x${offset.toString(16)} of ${sizeHex} total, ${viz.edges} pointer edges (id "${registryId}")`,
            data: { id: registryId, path, offset: res.offset, length: res.length, totalSize: res.totalSize, edges: viz.edges },
        };
    }, {
        description: 'Render a file\'s raw bytes as a hexdump glyph field',
        usage: '<path> [offset=0] [length=512] [cols=16]',
        returns: '{ id, path, offset, length, totalSize }',
    });
}
