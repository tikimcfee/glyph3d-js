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
import { bytesToHexView, hexCellSpan } from '@glyph3d/core/memory/hexView.js';
import { byteColor, findPointers } from '@glyph3d/core/memory/memoryViz.js';

const EDGE_COLOR = { r: 0.25, g: 0.85, b: 1.0 }; // cyan — stands out from the byte colors

// Transform a grid-local {x,y,z} by a column-major mat4 (grid.matrixWorld.elements).
function mat4Apply(e, x, y, z) {
    return {
        x: e[0] * x + e[4] * y + e[8] * z + e[12],
        y: e[1] * x + e[5] * y + e[9] * z + e[13],
        z: e[2] * x + e[6] * y + e[10] * z + e[14],
    };
}

// World-space anchor for a byte's hex pair: hexCellSpan → (line, startCol) →
// the glyph's grid-local instancePosition → world via matrixWorld.
function cellAnchor(grid, elements, localIndex, cols) {
    const { line, startCol } = hexCellSpan(localIndex, cols);
    const p = grid._layout?.positionAt(line, startCol);
    if (!p) return null;
    return mat4Apply(elements, p.x, p.y, p.z);
}

// Apply the two visualization channels to a freshly-loaded memory grid:
// color = meaning (per byte), pointers = edges (intra-window references).
function decorateMemoryGrid(ctx, grid, bytes, windowOffset, cols) {
    for (let k = 0; k < bytes.length; k++) {
        const { line, startCol, endCol } = hexCellSpan(k, cols);
        grid.highlightRange(line, startCol, line, endCol, byteColor(bytes[k]));
    }

    grid.updateMatrixWorld(true);
    const elements = grid.matrixWorld.elements;
    const cr = ctx.connectionRenderer || (ctx.connectionRenderer = new ConnectionRenderer(ctx.scene));
    let edges = 0;
    for (const { from, to } of findPointers(bytes, { windowOffset, minValue: windowOffset + 16 })) {
        const a = cellAnchor(grid, elements, from, cols);
        const b = cellAnchor(grid, elements, to, cols);
        if (!a || !b) continue;
        cr.set(`memptr:${windowOffset}:${from}`, a, b, EDGE_COLOR, { fromGrid: grid, toGrid: grid });
        edges++;
    }
    cr.refreshVisibility?.();
    return { colored: bytes.length, edges };
}

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

        const dump = bytesToHexView(res.bytes, { cols, baseOffset: res.offset });

        const grid = new CodeGrid(ctx.scene, ctx.atlas, {
            name: `${path} @0x${offset.toString(16)}`,
            showBackground: true,
            showFilename: true,
            // Neutral dark base: per-byte highlight color is ADDITIVE, so a green
            // base would tint every byte green (zeros included). A dim slate base
            // lets byteColor read true while keeping address/ascii gutters legible.
            textColor: { r: 0.22, g: 0.26, b: 0.32 },
        });
        grid.loadText(dump);

        const registryId = ctx.addGrid(grid, { id: `mem:${path}:${offset}` });
        ctx.attentionManager?.set('primary', registryId, { registry: ctx.registry });

        // Defer one frame so the builder's instancePosition buffer is materialized
        // before we anchor per-byte colors + pointer edges to specific glyphs.
        await new Promise((r) => requestAnimationFrame(r));
        const viz = decorateMemoryGrid(ctx, grid, res.bytes, res.offset, cols);

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
