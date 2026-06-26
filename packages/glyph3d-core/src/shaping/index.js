/**
 * Shaping module - HarfBuzz text shaping + outline extraction + Slug encoding.
 *
 * Phase 1: HarfBuzzShaper wraps harfbuzzjs WASM for text shaping and
 * glyph outline extraction. shapeText provides line-by-line shaping.
 *
 * Phase 2: SlugEncoder converts glyph outlines into GPU-ready DataTextures
 * (curveTexture, glyphMapTexture) for vector text rendering.
 */

export { default as HarfBuzzShaper } from './HarfBuzzShaper.js';
export { default as FontChain, BLANK_SLOT } from './FontChain.js';
export { default as MonospaceShapeCache } from './MonospaceShapeCache.js';
export { shapeText, collectUniqueGlyphIds } from './shapeText.js';
export { default as SlugEncoder } from './SlugEncoder.js';
export { default as LiveSlugAtlas } from './LiveSlugAtlas.js';
export { SlugBuffer, encodeGlyph } from './slugData.js';
