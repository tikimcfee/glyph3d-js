/**
 * shapeText - Line-by-line text shaping using HarfBuzzShaper or MonospaceShapeCache.
 *
 * Worker-safe: no DOM or Three.js dependencies.
 * Splits text on newlines, shapes each line independently, and returns
 * structured results suitable for buffer builders.
 */

/**
 * Shape a multi-line text block, returning per-line glyph arrays.
 *
 * HarfBuzz does not handle newlines — it treats them as control characters.
 * This function splits on '\n', shapes each line, and tracks line offsets
 * for lineSlotOffsets bookkeeping.
 *
 * Accepts either a HarfBuzzShaper or a MonospaceShapeCache. The cache path
 * (duck-typed via the presence of shapeLine()) is the fast path: O(n) Map
 * lookups with no WASM calls. The shaper path calls HarfBuzz per line and is
 * used as a fallback when the cache is not available.
 *
 * @param {import('./HarfBuzzShaper.js').default|import('./MonospaceShapeCache.js').default} shaperOrCache
 * @param {string} text - Text to shape (may contain newlines)
 * @param {string} [features] - Comma-separated OpenType features (shaper path only)
 * @returns {{
 *   lines: Array<{
 *     shaped: Array<{g: number, ax: number, dx: number, dy: number}>,
 *     text: string
 *   }>,
 *   totalGlyphs: number
 * }}
 */
export function shapeText(shaperOrCache, text, features) {
    const rawLines = text.split('\n');
    const lines = [];
    let totalGlyphs = 0;

    // MonospaceShapeCache exposes shapeLine(); HarfBuzzShaper exposes shape().
    const useCache = typeof shaperOrCache.shapeLine === 'function';

    for (const lineText of rawLines) {
        if (lineText.length === 0) {
            lines.push({ shaped: [], text: lineText });
            continue;
        }
        const shaped = useCache
            ? shaperOrCache.shapeLine(lineText)
            : shaperOrCache.shape(lineText, features);
        lines.push({ shaped, text: lineText });
        totalGlyphs += shaped.length;
    }

    return { lines, totalGlyphs };
}

/**
 * Collect unique glyph IDs from shaped results.
 *
 * Useful for Phase 2's SlugEncoder, which needs to process each unique glyph
 * exactly once to build curve/glyphMap textures.
 *
 * @param {Array<{shaped: Array<{g: number}>}>} shapedLines - Output from shapeText().lines
 * @returns {Set<number>} Set of unique glyph IDs
 */
export function collectUniqueGlyphIds(shapedLines) {
    const ids = new Set();
    for (const line of shapedLines) {
        for (const glyph of line.shaped) {
            ids.add(glyph.g);
        }
    }
    return ids;
}
