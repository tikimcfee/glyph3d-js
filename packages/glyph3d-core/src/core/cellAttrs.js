/**
 * cellAttrs.js — a terminal cell's attributes as ONE compact flags word, and the part of it the
 * glyph shader draws.
 *
 * A cell is { codepoint, fg, bg, attrs, underline colour }. `attrs` is a u16, one bit per SGR
 * attribute, laid out so a packed wire cell (termd's TCEL) maps onto it 1:1 — the reader copies
 * the word, it never re-derives it:
 *
 *   bit  0      BOLD          SGR 1
 *   bit  1      DIM           SGR 2   (faint)
 *   bit  2      ITALIC        SGR 3
 *   bit  3      BLINK         SGR 5/6 (held, not drawn)
 *   bit  4      INVERSE       SGR 7
 *   bit  5      CONCEAL       SGR 8   (invisible)
 *   bit  6      STRIKE        SGR 9
 *   bit  7      OVERLINE      SGR 53
 *   bits 8..10  UNDERLINE     SGR 4 / 4:n / 21 — 0 none · 1 single · 2 double · 3 curly · 4 dotted · 5 dashed
 *   bit  11     UNDERLINE_COLOR   SGR 58 named a colour for the underline (else it takes the text's)
 *   bits 12..15 free
 *
 * What each attribute becomes:
 *   - INVERSE and CONCEAL are resolved where the cell is READ (TerminalEmulator): inverse swaps the
 *     drawn fg and bg, conceal draws the text in its own background's colour.
 *   - BOLD and ITALIC pick the glyph's FACE (`cellFace`): the bold, italic or bold-italic face's
 *     slot for the codepoint (FontChain.lookupFace), no shader bit. Whether bold also changes the
 *     colour is the reader's `boldIsBright` (TerminalEmulator; off by default).
 *   - DIM, STRIKE, OVERLINE and the UNDERLINE style ride to the GPU as the slot's STYLE BYTE
 *     (`cellStyle`), in the spare high bits of the slot's group lane (InstancedSlotBuffer); an
 *     underline's own colour goes in the field's decoration texel (InstancedField.decorWords).
 *
 * The style byte (what core/glyphMaterial.js decodes):
 *   bit  0      DIM
 *   bit  1      STRIKE
 *   bit  2      OVERLINE
 *   bits 3..5   UNDERLINE style (as above)
 *   bit  6      UNDERLINE_COLOR — the underline takes the slot's decoration texel, not the ink
 *   bit  7      free
 */

export const CELL_BOLD = 1 << 0;
export const CELL_DIM = 1 << 1;
export const CELL_ITALIC = 1 << 2;
export const CELL_BLINK = 1 << 3;
export const CELL_INVERSE = 1 << 4;
export const CELL_CONCEAL = 1 << 5;
export const CELL_STRIKE = 1 << 6;
export const CELL_OVERLINE = 1 << 7;
export const CELL_UNDERLINE_SHIFT = 8;
export const CELL_UNDERLINE_MASK = 7 << CELL_UNDERLINE_SHIFT;
export const CELL_UNDERLINE_COLOR = 1 << 11;

/**
 * A glyph's face, two bits: which of a font's four faces draws it. FACE_BOLD | FACE_ITALIC is the
 * bold-italic face. (FontChain.lookupFace routes it; a font with no such face draws its upright.)
 */
export const FACE_REGULAR = 0;
export const FACE_BOLD = 1;
export const FACE_ITALIC = 2;
export const FACE_BOLD_ITALIC = FACE_BOLD | FACE_ITALIC;
/** Faces a font can have, the regular included. */
export const FACE_COUNT = 4;

/**
 * The face a cell's attrs ask for: bold → FACE_BOLD, italic → FACE_ITALIC, both → both.
 * @param {number} attrs  a cell's attrs word
 * @returns {number} 0..3
 */
export function cellFace(attrs) {
    // CELL_BOLD is bit 0 (= FACE_BOLD); CELL_ITALIC is bit 2, FACE_ITALIC bit 1.
    return (attrs & CELL_BOLD) | ((attrs & CELL_ITALIC) >> 1);
}

/** Underline styles (the value in a cell's UNDERLINE bits, and in the style byte's). */
export const UNDERLINE = Object.freeze({ NONE: 0, SINGLE: 1, DOUBLE: 2, CURLY: 3, DOTTED: 4, DASHED: 5 });

export const STYLE_DIM = 1 << 0;
export const STYLE_STRIKE = 1 << 1;
export const STYLE_OVERLINE = 1 << 2;
export const STYLE_UNDERLINE_SHIFT = 3;
export const STYLE_UNDERLINE_MASK = 7 << STYLE_UNDERLINE_SHIFT;
export const STYLE_UNDERLINE_COLOR = 1 << 6;
/** The style bits that draw a line (a blank cell carrying one still draws). */
export const STYLE_LINES = STYLE_STRIKE | STYLE_OVERLINE | STYLE_UNDERLINE_MASK;

/**
 * A cell's attrs word from its parts.
 * @param {{ bold?: boolean, dim?: boolean, italic?: boolean, blink?: boolean, inverse?: boolean,
 *   conceal?: boolean, strike?: boolean, overline?: boolean, underline?: number, underlineColor?: boolean }} a
 * @returns {number} u16
 */
export function packCellAttrs(a) {
    const ul = a.underline ?? 0;
    if (!Number.isInteger(ul) || ul < 0 || ul > UNDERLINE.DASHED) throw new Error(`packCellAttrs: underline style ${ul} (0 none … 5 dashed)`);
    return (a.bold ? CELL_BOLD : 0) | (a.dim ? CELL_DIM : 0) | (a.italic ? CELL_ITALIC : 0) | (a.blink ? CELL_BLINK : 0)
        | (a.inverse ? CELL_INVERSE : 0) | (a.conceal ? CELL_CONCEAL : 0) | (a.strike ? CELL_STRIKE : 0)
        | (a.overline ? CELL_OVERLINE : 0) | (ul << CELL_UNDERLINE_SHIFT) | (ul && a.underlineColor ? CELL_UNDERLINE_COLOR : 0);
}

/**
 * The style byte the shader draws for a cell's attrs: dim, strike, overline, the underline style
 * and whether the underline has its own colour. (Inverse and conceal are in the colours already;
 * bold and italic are in the glyph's face.)
 * @param {number} attrs  a cell's attrs word
 * @returns {number} 0..127
 */
export function cellStyle(attrs) {
    const ul = (attrs & CELL_UNDERLINE_MASK) >> CELL_UNDERLINE_SHIFT;
    return ((attrs & CELL_DIM) ? STYLE_DIM : 0)
        | ((attrs & CELL_STRIKE) ? STYLE_STRIKE : 0)
        | ((attrs & CELL_OVERLINE) ? STYLE_OVERLINE : 0)
        | (ul << STYLE_UNDERLINE_SHIFT)
        | (ul && (attrs & CELL_UNDERLINE_COLOR) ? STYLE_UNDERLINE_COLOR : 0);
}
