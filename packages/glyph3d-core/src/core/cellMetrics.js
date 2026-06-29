/**
 * Shared monospace cell metrics — ONE source of truth for the cell spacing used by CodeGrid,
 * GlyphField / TerminalGrid, and TreemapLabelManager, so the layout can't drift across them.
 *
 * The cell is the font's monospace advance × its real vertical em: atlas.getCharSize() returns
 * { width: the 'M' advance, height: ascender − descender } (from the shaper's fontExtents). The
 * multipliers below add NO fudge — anchored on the real metric, cells are contiguous (full-height
 * box-drawing tiles edge-to-edge, a highlight hugs the text) and lines sit at the true em pitch.
 * They're the single place to dial leading/tracking if that's ever wanted.
 */

/** × cell height = the line pitch. 1.0 = lines touch, so full-height box-drawing tiles row-to-row. */
export const LINE_PITCH = 1.0;

/** × cell width = the inter-glyph gap. 0 = contiguous cells, so box-drawing tiles edge-to-edge. */
export const LETTER_SPACING = 0.0;

/**
 * World-space cell metrics from the atlas char size + world scale.
 * @param {{width:number, height:number}} charSize - atlas.getCharSize()
 * @param {number} worldScale
 * @returns {{ charWidth:number, charHeight:number, lineSpacing:number, letterSpacing:number,
 *             pixelWidth:number, pixelHeight:number }}
 */
export function computeCellMetrics(charSize, worldScale) {
    const charWidth  = charSize.width  * worldScale;
    const charHeight = charSize.height * worldScale;
    return {
        charWidth,
        charHeight,
        lineSpacing:   charHeight * LINE_PITCH,
        letterSpacing: charWidth  * LETTER_SPACING,
        pixelWidth:    charSize.width,
        pixelHeight:   charSize.height,
    };
}
