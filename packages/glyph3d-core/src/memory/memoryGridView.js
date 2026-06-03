/**
 * memoryGridView — apply the memory viewer's two visualization channels to a
 * CodeGrid already loaded with a hexdump: color = meaning (per byte) and
 * pointers = edges (intra-window references).
 *
 * Core + reusable: the pager calls this once per window-fault. It owns none of
 * the lifecycle — the caller creates/updates the grid and owns the
 * ConnectionRenderer; this just maps bytes onto glyph highlights + edges.
 * Pure of app/DOM deps (THREE only via the grid's matrix the caller built).
 */

import { hexCellSpan } from './hexView.js';
import { byteColor, findPointers } from './memoryViz.js';

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

/**
 * Decorate a hexdump-loaded memory grid with per-byte color + pointer edges.
 * @param {import('../collections/CodeGrid.js').default} grid - already loadText'd with the dump
 * @param {import('../annotations/ConnectionRenderer.js').default} connectionRenderer
 * @param {Uint8Array} bytes - the same window passed to bytesToHexView
 * @param {Object} [opts]
 * @param {number} [opts.cols=16] - bytes per row (must match the dump)
 * @param {number} [opts.windowOffset=0] - address of bytes[0]
 * @param {string} [opts.idPrefix='memptr'] - edge id namespace (pager uses per-grid prefixes)
 * @returns {{ colored: number, edges: number }}
 */
export function decorateMemoryGrid(grid, connectionRenderer, bytes, opts = {}) {
    const cols = opts.cols ?? 16;
    const windowOffset = opts.windowOffset ?? 0;
    const idPrefix = opts.idPrefix ?? 'memptr';

    for (let k = 0; k < bytes.length; k++) {
        const { line, startCol, endCol } = hexCellSpan(k, cols);
        grid.highlightRange(line, startCol, line, endCol, byteColor(bytes[k]));
    }

    grid.updateMatrixWorld(true);
    const elements = grid.matrixWorld.elements;
    let edges = 0;
    for (const { from, to } of findPointers(bytes, { windowOffset, minValue: windowOffset + 16 })) {
        const a = cellAnchor(grid, elements, from, cols);
        const b = cellAnchor(grid, elements, to, cols);
        if (!a || !b) continue;
        connectionRenderer.set(`${idPrefix}:${windowOffset}:${from}`, a, b, EDGE_COLOR, { fromGrid: grid, toGrid: grid });
        edges++;
    }
    connectionRenderer.refreshVisibility?.();
    return { colored: bytes.length, edges };
}
