/**
 * memoryGridView — apply the memory viewer's two visualization channels to a
 * CodeGrid already loaded with a hexdump: color = meaning (per byte) and
 * pointers = edges (intra-window references).
 *
 * Core + reusable: the pager calls this once per window-fault. Edges are drawn
 * by MemoryEdges — a grid-PARENTED mesh in grid-local coords, so they follow
 * the grid when it moves and need no world-space round-trip.
 */

import { hexCellSpan } from './hexView.js';
import { byteColor, findPointers } from './memoryViz.js';
import { MemoryEdges } from './MemoryEdges.js';

// Grid-LOCAL anchor for a byte: the midpoint of its two hex-digit glyphs, so
// the edge lands on the center of the cell (not the left digit's origin).
function cellLocalAnchor(grid, localIndex, cols) {
    const { line, startCol } = hexCellSpan(localIndex, cols);
    const p0 = grid._layout?.positionAt(line, startCol);
    if (!p0) return null;
    const p1 = grid._layout?.positionAt(line, startCol + 1) ?? p0;
    return { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5, z: (p0.z + p1.z) * 0.5 };
}

// Additive accents that brighten the cells an edge connects, so locality is
// unambiguous: amber = a pointer value lives here, cyan = it points here.
const ACCENT_SRC = { r: 0.7, g: 0.45, b: 0.0 };
const ACCENT_DST = { r: 0.0, g: 0.6, b: 0.9 };

function accentCell(grid, localIndex, cols, color) {
    const { line, startCol, endCol } = hexCellSpan(localIndex, cols);
    grid.highlightRange(line, startCol, line, endCol, color);
}

/**
 * Decorate a hexdump-loaded memory grid with per-byte color + pointer edges.
 * @param {import('../collections/CodeGrid.js').default} grid - already loadText'd with the dump
 * @param {Uint8Array} bytes - the same window passed to bytesToHexView
 * @param {Object} [opts]
 * @param {number} [opts.cols=16] - bytes per row (must match the dump)
 * @param {number} [opts.windowOffset=0] - address of bytes[0]
 * @returns {{ colored: number, edges: number }}
 */
export function decorateMemoryGrid(grid, bytes, opts = {}) {
    const cols = opts.cols ?? 16;
    const windowOffset = opts.windowOffset ?? 0;

    // color = meaning (per byte)
    for (let k = 0; k < bytes.length; k++) {
        const { line, startCol, endCol } = hexCellSpan(k, cols);
        grid.highlightRange(line, startCol, line, endCol, byteColor(bytes[k]));
    }

    // pointers = edges (+ endpoint accents to pinpoint locality)
    const pointers = findPointers(bytes, { windowOffset, minValue: windowOffset + 16 });
    const localEdges = [];
    for (const { from, to } of pointers) {
        const a = cellLocalAnchor(grid, from, cols);
        const b = cellLocalAnchor(grid, to, cols);
        if (!a || !b) continue;
        accentCell(grid, from, cols, ACCENT_SRC);
        accentCell(grid, to, cols, ACCENT_DST);
        localEdges.push({ from: a, to: b });
    }

    const edges = grid._memoryEdges || (grid._memoryEdges = new MemoryEdges(grid));
    edges.setEdges(localEdges);
    return { colored: bytes.length, edges: localEdges.length };
}
