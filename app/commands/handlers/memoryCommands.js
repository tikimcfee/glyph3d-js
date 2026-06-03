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

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerMemoryCommands(router) {
    console.log('[mem] registerMemoryCommands running — registering mem.view'); // [PROBE temp — remove after first render]
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

        const dump = bytesToHexView(res.bytes, { cols, baseOffset: res.offset });

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: `${path} @0x${offset.toString(16)}`,
            showBackground: true,
            showFilename: true,
        });
        grid.loadText(dump);

        const registryId = ctx.addGrid(grid, { id: `mem:${path}:${offset}` });
        ctx.attentionManager?.set('primary', registryId, { registry: ctx.registry });

        const sizeHex = `0x${(res.totalSize ?? 0).toString(16)}`;
        return {
            text: `OK: mem.view ${path} — ${res.length} bytes @0x${offset.toString(16)} of ${sizeHex} total (id "${registryId}")`,
            data: { id: registryId, path, offset: res.offset, length: res.length, totalSize: res.totalSize },
        };
    }, {
        description: 'Render a file\'s raw bytes as a hexdump glyph field',
        usage: '<path> [offset=0] [length=512] [cols=16]',
        returns: '{ id, path, offset, length, totalSize }',
    });
}
