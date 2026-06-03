/**
 * hexView — raw bytes → a hexdump string the glyph substrate renders as-is.
 *
 * This is slice 2 of the memory viewer ([[project_memory_viewer]]): it proves
 * a file's raw bytes render as a glyph field through the EXISTING text path
 * (CodeGrid.addText), with zero builder changes. Each line is one row of the
 * dump; the whole string goes straight into a grid.
 *
 * The "byte is a glyph" purity (direct Uint8Array → glyphId injection, color
 * by entropy, pointer edges) is slice 3 — this string path is the fastest
 * possible on-screen proof first.
 *
 * Layout (cols=16):
 *   00000000  7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00  |.ELF............|
 *
 * Pure, dependency-free, worker/node-safe.
 */

const HEX = '0123456789abcdef';

/** Lowercase 2-char hex for a byte (0-255), allocation-light. */
function hex2(b) {
    return HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
}

/** Zero-padded hex address of `width` chars. */
function addr(n, width) {
    let s = n.toString(16);
    while (s.length < width) s = '0' + s;
    return s;
}

/**
 * Format a byte window as a classic hexdump string.
 *
 * @param {Uint8Array} bytes - the byte window (e.g. from provider.readRange)
 * @param {Object} [opts]
 * @param {number} [opts.cols=16]       - bytes per row
 * @param {number} [opts.baseOffset=0]  - address of bytes[0] (so windows show true file offsets)
 * @param {number} [opts.addrWidth=8]   - hex digits in the address gutter
 * @param {boolean} [opts.ascii=true]   - append the |ascii| gutter
 * @returns {string} newline-joined dump (no trailing newline)
 */
export function bytesToHexView(bytes, opts = {}) {
    const cols = opts.cols ?? 16;
    const baseOffset = opts.baseOffset ?? 0;
    const addrWidth = opts.addrWidth ?? 8;
    const wantAscii = opts.ascii ?? true;

    const lines = [];
    for (let row = 0; row < bytes.length; row += cols) {
        const end = Math.min(row + cols, bytes.length);

        let hexPart = '';
        let asciiPart = '';
        for (let i = row; i < end; i++) {
            const b = bytes[i];
            hexPart += hex2(b) + ' ';
            // Printable ASCII range 0x20–0x7E renders literally; everything
            // else collapses to '.' (the canonical hexdump convention).
            asciiPart += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.';
        }
        // Pad a short final row so the ascii gutter stays column-aligned.
        for (let i = end; i < row + cols; i++) hexPart += '   ';

        let line = addr(baseOffset + row, addrWidth) + '  ' + hexPart;
        if (wantAscii) line += ' |' + asciiPart + '|';
        lines.push(line);
    }
    return lines.join('\n');
}
