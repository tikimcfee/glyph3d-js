/**
 * TUI text formatting utilities.
 * Box-drawing, tables, padding - all return plain strings.
 */

const BOX = { tl: '\u2554', tr: '\u2557', bl: '\u255a', br: '\u255d', h: '\u2550', v: '\u2551' };
const BOX_THIN = { tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518', h: '\u2500', v: '\u2502' };

/**
 * Right-pad string to width
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function pad(str, width) {
    if (str.length >= width) return str.slice(0, width);
    return str + ' '.repeat(width - str.length);
}

/**
 * Truncate string with ellipsis
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function truncate(str, width) {
    if (str.length <= width) return str;
    return str.slice(0, width - 1) + '\u2026';
}

/**
 * Horizontal rule
 * @param {number} width
 * @param {string} [char='\u2550']
 * @returns {string}
 */
export function hr(width, char = '\u2550') {
    return char.repeat(width);
}

/**
 * Draw a box around content lines
 * @param {string} title
 * @param {string[]} lines
 * @param {number} [minWidth=40]
 * @param {object} [chars=BOX]
 * @returns {string}
 */
export function box(title, lines, minWidth = 40, chars = BOX) {
    const contentWidth = Math.max(
        minWidth - 4,
        title.length + 2,
        ...lines.map(l => l.length)
    );
    const inner = contentWidth + 2;
    const top = `${chars.tl}${chars.h}${chars.h} ${title} ${chars.h.repeat(Math.max(0, inner - title.length - 3))}${chars.tr}`;
    const bottom = `${chars.bl}${chars.h.repeat(inner)}${chars.br}`;
    const body = lines.map(l => `${chars.v} ${pad(l, contentWidth)} ${chars.v}`);
    return [top, ...body, bottom].join('\n');
}

/**
 * Format a simple table with aligned columns
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function table(headers, rows) {
    const widths = headers.map((h, i) => {
        const dataMax = rows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
        return Math.max(h.length, dataMax);
    });

    const headerLine = headers.map((h, i) => pad(h, widths[i])).join('  ');
    const separator = widths.map(w => '\u2500'.repeat(w)).join('\u2500\u2500');
    const bodyLines = rows.map(row =>
        row.map((cell, i) => pad(cell || '', widths[i])).join('  ')
    );

    return [headerLine, separator, ...bodyLines].join('\n');
}

/**
 * Format a key-value list
 * @param {Object<string, string>} obj
 * @param {number} [keyWidth=12]
 * @returns {string[]}
 */
export function kvLines(obj, keyWidth = 12) {
    return Object.entries(obj).map(([k, v]) => `${pad(k + ':', keyWidth)} ${v}`);
}

export { BOX, BOX_THIN };

export default { pad, truncate, hr, box, table, kvLines, BOX, BOX_THIN };
