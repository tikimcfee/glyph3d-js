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
 * A cell dimension rounded to 10 significant bits (it moves by under 0.1 %). Cell edges are then
 * EXACT in the float32 the GPU poses quads in: column k's right edge (k·w + w) and column k+1's
 * left edge ((k+1)·w) are the same number for every k below 16384, and so are a row's bottom
 * and the next row's top — neighbours share their edge to the bit, and the rasterizer gives every
 * pixel on it to exactly one of them. No crack, no overlap, at any zoom.
 * @param {number} v  a world-space cell width or height (> 0)
 * @returns {number}
 */
export function snapCellDimension(v) {
    if (!(v > 0) || !Number.isFinite(v)) return v;
    const q = 2 ** (Math.floor(Math.log2(v)) - 9);
    return Math.round(v / q) * q;
}

/**
 * World-space cell metrics from the atlas char size + world scale. The cell's width and height
 * are snapped (snapCellDimension), so every cell edge laid out as a multiple of them is exact.
 * @param {{width:number, height:number}} charSize - atlas.getCharSize()
 * @param {number} worldScale
 * @returns {{ charWidth:number, charHeight:number, lineSpacing:number, letterSpacing:number,
 *             pixelWidth:number, pixelHeight:number }}
 */
export function computeCellMetrics(charSize, worldScale) {
    const charWidth  = snapCellDimension(charSize.width  * worldScale);
    const charHeight = snapCellDimension(charSize.height * worldScale);
    return {
        charWidth,
        charHeight,
        lineSpacing:   charHeight * LINE_PITCH,
        letterSpacing: charWidth  * LETTER_SPACING,
        pixelWidth:    charSize.width,
        pixelHeight:   charSize.height,
    };
}
