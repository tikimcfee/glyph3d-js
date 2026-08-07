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
 * Monospace cell size FROM THE SHAPER — the single metrics source. width = the 'M'
 * advance (the forced monospace column the builder lays out to); height = the PRIMARY
 * font's REAL vertical em (ascender − descender from fontExtents), the SAME range
 * encodeGlyph normalizes each glyph's Y into. Anchoring the cell on the real metric —
 * not the old fontSize × 1.15 guess — makes a glyph fill its cell, so full-height
 * box-drawing tiles row-to-row and a highlight hugs the text instead of carrying a
 * dead band. Shared by the boot path (glyphEngine) and the headless bake — one
 * expression, so baked advances are bit-identical to the runtime's.
 * @param {{upem?:number, shape?:Function, fontExtents?:Function}} shaper
 * @param {number} fontSize - atlas glyph cell font size in px
 * @returns {{width:number, height:number}}
 */
export function deriveCharSize(shaper, fontSize) {
    const upem = shaper.upem || 2048;
    const shaped = shaper.shape ? shaper.shape('M') : null;
    const ax = (shaped && shaped[0]) ? shaped[0].ax : upem * 0.6;
    const ext = shaper.fontExtents ? shaper.fontExtents() : null;        // primary font's hExtents
    const emHeight = ext ? (ext.ascender - ext.descender) / upem : 1.15; // real em, fallback to the old guess
    return { width: Math.ceil(ax / upem * fontSize), height: emHeight * fontSize };
}

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
