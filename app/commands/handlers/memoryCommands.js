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
import ConnectionRenderer from '@glyph3d/core/annotations/ConnectionRenderer.js';
import { bytesToHexView } from '@glyph3d/core/memory/hexView.js';
import { decorateMemoryGrid } from '@glyph3d/core/memory/memoryGridView.js';

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerMemoryCommands(router) {
    // mem.view <path> [offset] [length] [cols]
    router.register('mem.view', async (args, ctx) => {
        const path = args[0];
        if (!path) return { text: 'ERR: usage: mem.view <path> [offset] [length] [cols]', data: null };
        if (!ctx.fileProvider) return { text: 'ERR: no fileProvider — relay bridge not connected', data: null };

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

        const _t0 = performance.now(); // [PERF-PROBE temp — remove after optimization]
        const dump = bytesToHexView(res.bytes, { cols, baseOffset: res.offset });
        const _t1 = performance.now();

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
        grid.loadText(dump);
        const _t2 = performance.now();

        const registryId = ctx.addGrid(grid, { id: `mem:${path}:${offset}` });
        ctx.attentionManager?.set('primary', registryId, { registry: ctx.registry });

        // No frame defer: loadText populates the instancePosition CPU array
        // synchronously, so positionAt resolves immediately — saves ~16ms/call
        // latency that would otherwise compound per window-fault in the pager.
        const cr = ctx.connectionRenderer || (ctx.connectionRenderer = new ConnectionRenderer(ctx.scene));
        const viz = decorateMemoryGrid(grid, cr, res.bytes, { cols, windowOffset: res.offset });
        const _t3 = performance.now();
        console.log(`[mem-perf] bytes=${res.length} glyphs=${grid.getGlyphCount?.() ?? '?'} | hexview=${(_t1 - _t0).toFixed(1)} build=${(_t2 - _t1).toFixed(1)} decorate=${(_t3 - _t2).toFixed(1)} | total=${(_t3 - _t0).toFixed(1)}ms`); // [PERF-PROBE temp]

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
