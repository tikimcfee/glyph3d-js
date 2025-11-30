/**
 * textToGlyphs - Pure function to convert text + positions to glyph objects
 *
 * Takes positioned text and maps each character to UV coordinates.
 * No side effects, no DOM, no WebGL - pure computation.
 *
 * Extracted from GlyphRendererV15._textToGlyphs() for Web Worker usage.
 */

/**
 * Convert text and positions to glyph objects with UV coordinates
 *
 * PURE FUNCTION: Same input always produces same output.
 * No side effects, no state mutation.
 *
 * @param {string} text - Original text
 * @param {Array<{x: number, y: number, z: number}>} positions - From layoutText()
 * @param {Object<number, {u0: number, v0: number, u1: number, v1: number}>} uvMap - charCode → UV coords
 * @param {{charWidth: number, charHeight: number}} metrics - Font metrics for sizing
 * @param {{r: number, g: number, b: number}} color - Glyph color (0-1 range)
 * @param {number} [scale=1.0] - Scale factor
 * @returns {Array<{position: Object, size: Object, uv: Object, color: Object, charCode: number}>}
 */
export function textToGlyphs(text, positions, uvMap, metrics, color, scale = 1.0) {
    const glyphs = [];
    let posIndex = 0;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        // Newlines are not in positions array - skip without incrementing posIndex
        if (char === '\n') continue;

        // Spaces are in positions array but we don't render them
        if (char === ' ') {
            posIndex++;
            continue;
        }

        const pos = positions[posIndex++];
        if (!pos) continue; // Safety check

        // Lookup UV from serialized map
        const charCode = char.charCodeAt(0);
        const uv = uvMap[charCode] || uvMap[63]; // Fallback to '?' (charCode 63)
        if (!uv) continue; // Skip if no UV available

        glyphs.push({
            position: pos,
            size: {
                width: metrics.charWidth * scale,
                height: metrics.charHeight * scale
            },
            uv: uv,
            color: color,
            charCode: charCode
        });
    }

    return glyphs;
}

export default textToGlyphs;
