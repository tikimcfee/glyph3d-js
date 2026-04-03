/**
 * Shaping module - HarfBuzz text shaping + outline extraction.
 *
 * Phase 1: HarfBuzzShaper wraps harfbuzzjs WASM for text shaping and
 * glyph outline extraction. shapeText provides line-by-line shaping.
 *
 * Phase 2 will add SlugEncoder here for curve/band/glyphMap textures.
 */

export { default as HarfBuzzShaper } from './HarfBuzzShaper.js';
export { shapeText, collectUniqueGlyphIds } from './shapeText.js';
