/**
 * memoryLegend — the companion legend/data-mapping for the memory viewer.
 *
 * Builds the text + per-token color spec for a small CodeGrid that sits beside
 * the memory grid: a color key (what each byte hue means), an accent key
 * (pointer source/target), the window stats, and a live "inspect" slot the
 * hover handler rewrites with the byte under the cursor. Dogfoods the substrate
 * — the legend is itself a glyph field.
 *
 * Pure: returns data; the app renders it into a grid via highlightRange.
 */

import { byteColor } from './memoryViz.js';

// Display swatches for the pointer accents (match decorateMemoryGrid's ACCENT_*).
const SRC = { r: 0.9, g: 0.6, b: 0.1 };
const DST = { r: 0.2, g: 0.7, b: 1.0 };
const EDGE = { r: 0.3, g: 0.85, b: 1.0 };

// The inspect section's line offset within the legend text — the hover handler
// rewrites from here down. Exported so the app doesn't hardcode it.
export const INSPECT_HEADER = 'inspect:';
export const INSPECT_PLACEHOLDER = '(hover a byte)';

/**
 * @param {Object} meta
 * @param {string} meta.path
 * @param {number} meta.offset
 * @param {number} meta.length
 * @param {number} meta.totalSize
 * @param {number} meta.edges
 * @returns {{ text: string, colorings: Array<{line:number,startCol:number,endCol:number,color:{r,g,b}}>, inspectLine: number }}
 */
export function buildMemoryLegend(meta = {}) {
    const { path = '?', offset = 0, length = 0, totalSize = 0, edges = 0 } = meta;
    const lines = [];
    const colorings = [];
    const row = (text, color, tokLen) => {
        const line = lines.length;
        lines.push(text);
        if (color) colorings.push({ line, startCol: 0, endCol: tokLen, color });
    };

    row('legend:');
    row('00  zero',    byteColor(0x00), 2);
    row('01  control', byteColor(0x01), 2);
    row('6e  text',    byteColor(0x6e), 2);
    row('ff  high',    byteColor(0xff), 2);
    row('src pointer', SRC, 3);
    row('dst target',  DST, 3);
    row('cone = tgt',  EDGE, 4);
    row('');
    row('window:');
    row(path);
    row(`@0x${offset.toString(16)} +${length}B`);
    row(`of 0x${totalSize.toString(16)}`);
    row(`${edges} pointers`);
    row('');
    const inspectLine = lines.length;
    row(INSPECT_HEADER);
    row(INSPECT_PLACEHOLDER);

    return { text: lines.join('\n'), colorings, inspectLine };
}
