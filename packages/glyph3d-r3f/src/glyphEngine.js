// glyphEngine — boot the renderer-independent glyph pipeline (atlas handle +
// HarfBuzz shaper + Slug curve encoding). Returns a ready GlyphAtlas with the
// shaper and slug textures stashed on it (the convention CodeGrid auto-discovers).
//
// Design note: this deliberately takes EVERYTHING as explicit options — the font
// URL, family, sizes, and which codepoint ranges to prime/encode. Nothing about
// "Cousine at 48px in a 2048 atlas" is baked in here; those are the consumer's
// decisions. The keystone (and later apps) pass their own. This is GPU/renderer
// independent: GlyphAtlas is a plain handle, the shaper is WASM, SlugEncoder is
// data — so it can run before any WebGPU device exists.

import { GlyphAtlas, EmojiAtlas, collectUniqueGlyphIds, deriveCharSize } from '@glyph3d/core';
import { MonospaceShapeCache, shapeText, LiveSlugAtlas, FontChain,
         slugCoreKey, loadSlugCore, loadServedSlugCore, saveSlugCore, discardSlugCore } from '@glyph3d/core/shaping';
import { getWorkerBridge } from '@glyph3d/core/workers';
import { LARGE_CORE_RANGES } from './coreRanges.js';

/**
 * @typedef {Object} GlyphEngineOptions
 * @property {string}   fontUrl      - URL to the PRIMARY .ttf/.otf font (required).
 * @property {Array<{url:string, name?:string}>} [fonts] - Full font-fallback chain
 *           in priority order. If omitted, a single-font chain is built from `fontUrl`.
 *           The first entry should be the primary monospace; later entries cover
 *           glyphs the primary lacks (symbols, braille, …); routing is per-codepoint.
 * @property {string}   [fontFamily] - CSS font stack for the Canvas2D atlas.
 * @property {number}   [fontSize]   - Atlas glyph cell font size in px.
 * @property {number}   [atlasSize]  - Atlas texture dimension in px (square).
 * @property {Array<[number, number]>} [primeRanges] - Inclusive codepoint ranges
 *           to prime in the shape cache (shaping warm-up).
 * @property {Array<[number, number]>} [encodeRanges] - Inclusive codepoint ranges
 *           to encode into Slug curve textures up front.
 * @property {(stage: string) => void} [onStage] - Progress callback.
 * @property {boolean} [cache] - Set false to bypass the prebaked slug-core cache and
 *           force a fresh encode (the default loads-else-encodes-and-self-caches).
 * @property {string} [coreAssetBase] - Base path for the served slug-core asset (default
 *           '/'); pass import.meta.env.BASE_URL so a sub-path deploy (/ide/) resolves.
 */

// LARGE_CORE_RANGES now lives in ./coreRanges.js — the single source shared with the
// build-time bake (tools/bake-slug-core.mjs) so their cache keys agree.

/** Sensible defaults — explicit, overridable, and documented (not hidden). */
export const DEFAULT_ENGINE_OPTIONS = {
  fontFamily: 'Cousine, Monaco, Menlo, Courier New, monospace',
  fontSize: 48,
  atlasSize: 2048,
  // Prime + encode the LARGE CORE up front (was ASCII-only encode → constant live growth).
  // The consumer can override either; the atlas still auto-grows for anything outside this.
  primeRanges: LARGE_CORE_RANGES,
  encodeRanges: LARGE_CORE_RANGES,
};

const codepointsFromRanges = (ranges) => {
  let s = '';
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) s += String.fromCodePoint(cp);
  }
  return s;
};

// deriveCharSize lives in @glyph3d/core cellMetrics — one expression shared with the
// headless bake, so baked advances are bit-identical to what this boot derives.

/**
 * Boot the glyph pipeline.
 * @param {GlyphEngineOptions} options
 * @returns {Promise<GlyphAtlas>} atlas with `_shaper` and `_slugData` attached.
 */
export async function bootGlyphEngine(options) {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  if (!opts.fontUrl) throw new Error('bootGlyphEngine: `fontUrl` is required.');
  const stage = opts.onStage ?? (() => {});

  stage('atlas');
  // A bare handle now — no Canvas2D rasterization. It holds the shared pipeline
  // handles (shaper/cache/emoji/live) and answers charSize + atlasSize.
  const atlas = new GlyphAtlas(opts.fontFamily, opts.fontSize, opts.atlasSize);

  stage('shaper');
  // The font chain IS the shaper for the whole pipeline: it presents the same
  // method surface as a single HarfBuzzShaper, but glyph IDs are global slots
  // spanning every font. Falls back to a single-font chain from `fontUrl`.
  const fontSpecs = (opts.fonts && opts.fonts.length)
    ? opts.fonts
    : [{ url: opts.fontUrl, name: 'primary' }];
  const shaper = new FontChain();
  await shaper.init(fontSpecs);

  // Color-emoji bitmap fallback: codepoints no outline font covers (🎉 ✅ 🚀 …)
  // get a cell in this Canvas2D color atlas, rendered by the shader's bitmap branch.
  const emojiAtlas = new EmojiAtlas();
  shaper.setEmojiAtlas(emojiAtlas);

  const shapeCache = new MonospaceShapeCache(shaper);
  shapeCache.prime(codepointsFromRanges(opts.primeRanges));

  // Workers reuse the same shaper + cache (main-thread fallback if no workers).
  getWorkerBridge().setShaper(shaper, shapeCache);

  stage('slug');
  // CodeGrid (and GlyphField) auto-discover these off the atlas.
  atlas._shaper = shaper;
  // charSize from the SHAPER — the single metrics source (width = the 'M' advance =
  // the forced monospace cell; height = fontSize × 1.15). This is what GlyphAtlas's
  // retired Canvas2D 'M' measure used to provide.
  atlas._charSize = deriveCharSize(shaper, opts.fontSize);
  // TerminalGrid maps codepoint→glyphId through this primed cache (its glyph IDs
  // are the same ones the Slug glyphMapTexture is keyed by).
  atlas._shapeCache = shapeCache;
  // Color-emoji bitmap atlas — GlyphField discovers this for its bitmap branch.
  atlas._emojiAtlas = emojiAtlas;

  // Prebaked-core cache ladder. local blob store → served static asset → live encode.
  //   1. loadSlugCore        — local IndexedDB (fastest; previous boots wrote here)
  //   2. loadServedSlugCore  — the build-time baked asset, self-promoted into IndexedDB
  //                            on hit so a fresh device hydrates instead of encoding
  //   3. live encode         — the always-present fallback; self-caches for next boot
  // The key binds the font chain (by name) + ranges + buffer format, so any change misses
  // → recompute. `cache: false` bypasses it. Fail-safe throughout: a bad/absent cache never
  // breaks boot. A served/remote source is just another rung on this same ladder.
  const useCache = opts.cache !== false;
  const cacheKey = slugCoreKey({ fonts: fontSpecs, encodeRanges: opts.encodeRanges });
  const cachedDescriptor = useCache
    ? (await loadSlugCore(cacheKey)) || (await loadServedSlugCore(cacheKey, opts.coreAssetBase ?? '/'))
    : null;

  // The live, growable Slug atlas owns one encoder for BOTH boot and growth: glyphs
  // encountered after boot (box-drawing, spinner stars, …) are appended on demand and
  // hot-swapped into every live field. Boot either hydrates from the cache or encodes.
  let live = null;
  if (cachedDescriptor) {
    try {
      live = new LiveSlugAtlas({ atlas, shaper, initialDescriptor: cachedDescriptor });
    } catch (err) {
      console.warn(`[glyphEngine] slug-core hydrate failed (${err.message}) → recompute`);
      await discardSlugCore(cacheKey);
      live = null;
    }
  }
  if (!live) {
    const shaped = shapeText(shapeCache, codepointsFromRanges(opts.encodeRanges));
    const glyphIds = collectUniqueGlyphIds(shaped.lines);
    live = new LiveSlugAtlas({ atlas, shaper, initialGlyphIds: glyphIds });
    if (useCache) await saveSlugCore(cacheKey, live.serialize());
  }
  atlas._live = live;

  stage('ready');
  return atlas;
}
