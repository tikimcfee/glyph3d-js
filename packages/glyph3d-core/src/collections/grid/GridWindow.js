/**
 * GridWindow — pure windowing math, slice extraction, and frame scrolling calculations.
 */

/**
 * Clamp the first line index of a window viewport within [0, totalLines - winRows].
 * @param {number} firstLine
 * @param {number} totalLines
 * @param {number} winRows
 * @returns {number}
 */
export function clampWindow(firstLine, totalLines, winRows) {
    const max = Math.max(0, totalLines - winRows);
    return Math.max(0, Math.min(Math.round(firstLine || 0), max));
}

/**
 * Slice a window from an array of source lines.
 * Truncates each line to winCols and joins with '\n'.
 * @param {string[]} sourceLines
 * @param {number} firstLine
 * @param {number} winRows
 * @param {number} winCols
 * @returns {string}
 */
export function sliceWindowText(sourceLines, firstLine, winRows, winCols) {
    if (!sourceLines || sourceLines.length === 0) return '';
    const first = clampWindow(firstLine, sourceLines.length, winRows);
    return sourceLines
        .slice(first, first + winRows)
        .map((line) => line.slice(0, winCols))
        .join('\n');
}

/**
 * Compute the maximum allowed scroll offset in visual rows.
 * @param {number} totalVisualRows
 * @param {number} frameRows - 0 for unbounded/frameless
 * @returns {number}
 */
export function computeMaxScroll(totalVisualRows, frameRows = 0) {
    const total = Math.max(0, totalVisualRows || 0);
    return frameRows > 0 ? Math.max(0, total - frameRows) : total;
}

/**
 * Clamp a requested scroll row count to [0, maxScroll].
 * @param {number} rows
 * @param {number} maxScroll
 * @returns {number}
 */
export function clampScroll(rows, maxScroll) {
    return Math.max(0, Math.min(Math.round(rows || 0), Math.max(0, maxScroll)));
}

/**
 * Compute shader vertical clipping bounds for a framed window.
 * @param {number} originY
 * @param {number} frameRows
 * @param {number} lineHeight
 * @returns {{ top: number, bottom: number }}
 */
export function computeFrameClip(originY, frameRows, lineHeight) {
    const top = (originY ?? 0) + 0.5 * lineHeight;
    const bottom = (originY ?? 0) - (frameRows - 0.5) * lineHeight;
    return { top, bottom };
}
