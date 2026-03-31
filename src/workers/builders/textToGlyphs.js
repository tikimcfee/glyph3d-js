/**
 * textToGlyphs - Pure function to convert text + positions to glyph objects
 *
 * Takes positioned text and maps each grapheme cluster to UV coordinates.
 * No side effects, no DOM, no WebGL - pure computation.
 *
 * Extracted from GlyphRendererV15._textToGlyphs() for Web Worker usage.
 */

import { iterGraphemes } from '../../utils/grapheme.js';

/**
 * Convert text and positions to glyph objects with UV coordinates
 *
 * PURE FUNCTION: Same input always produces same output.
 * No side effects, no state mutation.
 *
 * @param {string} text - Original text
 * @param {Array<{x: number, y: number, z: number}>} positions - From layoutText()
 * @param {Object<string, {u0: number, v0: number, u1: number, v1: number, numericId: number}>} uvMap - graphemeString → UV coords + numericId
 * @param {{charWidth: number, charHeight: number}} metrics - Font metrics for sizing
 * @param {{r: number, g: number, b: number}} color - Glyph color (0-1 range)
 * @param {number} [scale=1.0] - Scale factor
 * @returns {Array<{position: Object, size: Object, uv: Object, color: Object, charCode: number}>}
 */
export function textToGlyphs(text, positions, uvMap, metrics, color, scale = 1.0) {
    const glyphs = [];
    let posIndex = 0;

    for (const grapheme of iterGraphemes(text)) {
        const cp = grapheme.codePointAt(0);

        // Newlines are not in positions array - skip without incrementing posIndex
        if (cp === 10) continue;

        // Spaces are in positions array but we don't render them
        if (cp === 32) {
            posIndex++;
            continue;
        }

        const pos = positions[posIndex++];
        if (!pos) continue; // Safety check

        // Lookup UV from serialized map (keyed by grapheme string)
        const entry = uvMap[grapheme] || uvMap['?']; // Fallback to '?'
        if (!entry) continue; // Skip if no UV available

        glyphs.push({
            position: pos,
            size: {
                width: metrics.charWidth * scale,
                height: metrics.charHeight * scale
            },
            uv: entry,
            color: color,
            charCode: entry.numericId  // numeric DataTexture ID stored as charCode for compat
        });
    }

    return glyphs;
}

export default textToGlyphs;
