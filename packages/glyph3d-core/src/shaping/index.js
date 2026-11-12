/**
 * Shaping module - HarfBuzz text shaping + outline extraction + Slug encoding.
 *
 * Phase 1: HarfBuzzShaper wraps harfbuzzjs WASM for text shaping and
 * glyph outline extraction. shapeText provides line-by-line shaping.
 *
 * Phase 2: glyph outlines become Slug curves (encodeGlyphBatch, in the encode worker) held in
 * GPU-ready DataTextures (SlugTextures: curveTexture, glyphMapTexture) that LiveSlugAtlas grows.
 */

export { default as HarfBuzzShaper } from './HarfBuzzShaper.js';
export { default as FontChain, BLANK_SLOT } from './FontChain.js';
export { default as MonospaceShapeCache } from './MonospaceShapeCache.js';
export { shapeText, collectUniqueGlyphIds } from './shapeText.js';
export { default as SlugTextures } from './SlugTextures.js';
export { default as LiveSlugAtlas, ATLAS_GROWTH } from './LiveSlugAtlas.js';
export { SlugBuffer, encodeGlyph, encodeGlyphBatch, SLUG_BUFFER_FORMAT } from './slugData.js';
export { slugCoreKey, loadSlugCore, loadServedSlugCore, saveSlugCore, discardSlugCore,
         slugGrowthKey, loadSlugGrowth, saveSlugGrowth, getSlugCacheState, clearSlugCore } from './slugCoreCache.js';
