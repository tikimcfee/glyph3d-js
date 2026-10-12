// glyphEngine — boot the renderer-independent glyph pipeline (atlas handle +
// HarfBuzz shaper + Slug curve encoding). Returns a ready GlyphAtlas with the
// shaper and slug textures stashed on it (the convention CodeGrid auto-discovers).

import GlyphAtlas from './GlyphAtlas.js';
import EmojiAtlas from './EmojiAtlas.js';
import { deriveCharSize } from './core/cellMetrics.js';
import {
  MonospaceShapeCache,
  shapeText,
  collectUniqueGlyphIds,
  LiveSlugAtlas,
  FontChain,
  slugCoreKey,
  loadSlugCore,
  loadServedSlugCore,
  saveSlugCore,
  discardSlugCore,
} from './shaping/index.js';
import { getWorkerBridge } from './workers/WorkerBridge.js';
import { LARGE_CORE_RANGES } from './core/coreRanges.js';

export { LARGE_CORE_RANGES };

/**
 * @typedef {Object} GlyphEngineOptions
 * @property {string}   [fontUrl]    - URL to the PRIMARY .ttf/.otf font.
 * @property {Array<{url?:string, buffer?:ArrayBuffer|Uint8Array, name?:string}>} [fonts] - Full font-fallback chain.
 * @property {string}   [wasmUrl]    - URL to hb.wasm override.
 * @property {ArrayBuffer|Uint8Array} [wasmBinary] - Raw WASM bytes for offline/embedded usage.
 * @property {string}   [fontFamily] - CSS font stack for the Canvas2D atlas.
 * @property {number}   [fontSize]   - Atlas glyph cell font size in px.
 * @property {Array<[number, number]>} [primeRanges] - Inclusive codepoint ranges to prime in shape cache.
 * @property {Array<[number, number]>} [encodeRanges] - Inclusive codepoint ranges to encode into Slug textures.
 * @property {(stage: string) => void} [onStage] - Progress callback.
 * @property {boolean}  [cache]      - Set false to bypass prebaked slug-core cache.
 * @property {string}   [coreAssetBase] - Base path for served slug-core asset (default '/').
 */

/** Sensible defaults — explicit, overridable, and documented. */
export const DEFAULT_ENGINE_OPTIONS = {
  fontFamily: 'Cousine, Monaco, Menlo, Courier New, monospace',
  fontSize: 48,
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

/**
 * Boot the glyph pipeline.
 * @param {GlyphEngineOptions} options
 * @returns {Promise<GlyphAtlas>} atlas with `_shaper`, `_slugData`, etc. attached.
 */
export async function bootGlyphEngine(options = {}) {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  if (!opts.fontUrl && !(opts.fonts && opts.fonts.length)) {
    throw new Error('bootGlyphEngine: `fontUrl` or `fonts` array is required.');
  }
  const stage = opts.onStage ?? (() => {});

  stage('atlas');
  const atlas = new GlyphAtlas(opts.fontFamily, opts.fontSize);

  stage('shaper');
  const fontSpecs = (opts.fonts && opts.fonts.length)
    ? opts.fonts
    : [{ url: opts.fontUrl, name: 'primary' }];
  const shaper = new FontChain();
  await shaper.init(fontSpecs, {
    wasmUrl: opts.wasmUrl,
    wasmBinary: opts.wasmBinary,
  });

  const emojiAtlas = new EmojiAtlas();
  shaper.setEmojiAtlas(emojiAtlas);

  const shapeCache = new MonospaceShapeCache(shaper);
  shapeCache.prime(codepointsFromRanges(opts.primeRanges));

  getWorkerBridge().setShaper(shaper, shapeCache);

  stage('slug');
  atlas._shaper = shaper;
  atlas._charSize = deriveCharSize(shaper, opts.fontSize);
  atlas._shapeCache = shapeCache;
  atlas._emojiAtlas = emojiAtlas;

  const useCache = opts.cache !== false;
  const cacheKey = slugCoreKey({ fonts: fontSpecs, encodeRanges: opts.encodeRanges });
  const cachedDescriptor = useCache
    ? (await loadSlugCore(cacheKey)) || (await loadServedSlugCore(cacheKey, opts.coreAssetBase ?? '/'))
    : null;

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
