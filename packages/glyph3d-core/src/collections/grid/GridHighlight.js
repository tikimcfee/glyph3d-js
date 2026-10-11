/**
 * GridHighlight — slot highlight ranges and line clearing helpers for 3D glyph fields.
 */

/**
 * Highlight a 2D text range (startLine, startCol) to (endLine, endCol) with additive color and fill.
 * @param {Object} renderer - InstancedField renderer
 * @param {Object} layout - LayoutDescription
 * @param {number} startLine
 * @param {number} startCol
 * @param {number} endLine
 * @param {number} endCol
 * @param {{r:number, g:number, b:number}} color
 * @param {number} [fillOpacity=0]
 */
export function applyRangeHighlight(renderer, layout, startLine, startCol, endLine, endCol, color, fillOpacity = 0) {
    if (!renderer || !layout) return;

    for (let line = startLine; line <= endLine; line++) {
        const cStart = (line === startLine) ? startCol : 0;
        const lineCount = layout.lineSlotCount?.(line) ?? 0;
        const cEnd   = (line === endLine)   ? endCol   : lineCount;
        for (let col = cStart; col < cEnd; col++) {
            const slot = layout.slotForChar(line, col);
            if (slot >= 0) renderer.setGlyphHighlight(slot, color, fillOpacity);
        }
    }
}

/**
 * Clear all glyph highlights on a specific line.
 * @param {Object} renderer - InstancedField renderer
 * @param {Object} layout - LayoutDescription
 * @param {number} line
 */
export function clearLineHighlight(renderer, layout, line) {
    if (!renderer || !layout) return;
    const count = layout.lineSlotCount?.(line) ?? 0;
    for (let i = 0; i < count; i++) {
        const slot = layout.slotForChar(line, i);
        if (slot >= 0) renderer.setGlyphHighlight(slot, null);
    }
}

/**
 * Clear all glyph highlights across all lines on the grid.
 * @param {Object} renderer - InstancedField renderer
 * @param {Object} layout - LayoutDescription
 * @param {number} lineCount
 */
export function clearAllHighlights(renderer, layout, lineCount) {
    if (!renderer || !layout) return;
    for (let line = 0; line < lineCount; line++) {
        clearLineHighlight(renderer, layout, line);
    }
}
