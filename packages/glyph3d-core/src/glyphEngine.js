// glyphEngine — boot the renderer-independent glyph pipeline (atlas handle +
// HarfBuzz shaper + Slug curve encoding). Returns a ready GlyphAtlas with the
// shaper and slug textures stashed on it (the convention CodeGrid auto-discovers).

import GlyphAtlas from './GlyphAtlas.js';
import EmojiAtlas from './EmojiAtlas.js';
import TextureUploads from './core/TextureUploads.js';
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
  slugGrowthKey,
  loadSlugGrowth,
  saveSlugGrowth,
} from './shaping/index.js';
import SlugEncodeClient from './workers/SlugEncodeClient.js';
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
 * @property {boolean}  [cache]      - Set false to bypass the slug-core cache AND the persisted
 *   runtime growth (neither is read nor written).
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
 *
 * The ladder: the core (the encode ranges' glyphs) hydrates from the local cache, else the
 * served bake, else is encoded in the encode worker and cached; then the runtime growth a
 * previous session learned on this font chain hydrates on top. The encode worker (outline
 * extraction) and the emoji raster worker start here; growth after boot runs through them.
 *
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
  // The encode worker loads the same fonts into its own HarfBuzz while the main thread primes.
  const encoder = new SlugEncodeClient({ fonts: shaper.fontSources(), wasmUrl: opts.wasmUrl, wasmBinary: opts.wasmBinary });

  // The atlas textures' bytes go through one queue the renderer seam flushes (SceneSystems):
  // only what changed, as rectangles; a texture that grows has its old rows copied on the GPU.
  const uploads = new TextureUploads();
  const emojiAtlas = new EmojiAtlas({ uploads });
  shaper.setEmojiAtlas(emojiAtlas);

  const shapeCache = new MonospaceShapeCache(shaper);
  shapeCache.prime(codepointsFromRanges(opts.primeRanges));

  getWorkerBridge().setShaper(shaper, shapeCache);

  stage('slug');
  atlas._shaper = shaper;
  atlas._charSize = deriveCharSize(shaper, opts.fontSize);
  atlas._shapeCache = shapeCache;
  atlas._emojiAtlas = emojiAtlas;
  atlas._textureUploads = uploads;

  const useCache = opts.cache !== false;
  const cacheKey = slugCoreKey({ fonts: fontSpecs, encodeRanges: opts.encodeRanges });
  const growthKey = slugGrowthKey({ fonts: fontSpecs });
  const chain = { fontCount: shaper.fontCount };
  const persist = useCache ? { save: (growth) => saveSlugGrowth(growthKey, growth, chain) } : null;
  const cachedDescriptor = useCache
    ? (await loadSlugCore(cacheKey)) || (await loadServedSlugCore(cacheKey, opts.coreAssetBase ?? '/'))
    : null;

  let live = null;
  if (cachedDescriptor) {
    try {
      live = new LiveSlugAtlas({ atlas, shaper, encoder, uploads, emojiAtlas, persist, initialDescriptor: cachedDescriptor });
    } catch (err) {
      console.warn(`[glyphEngine] slug-core hydrate failed (${err.message}) → recompute`);
      await discardSlugCore(cacheKey);
      live = null;
    }
  }
  if (!live) {
    const shaped = shapeText(shapeCache, codepointsFromRanges(opts.encodeRanges));
    live = new LiveSlugAtlas({ atlas, shaper, encoder, uploads, emojiAtlas, persist });
    await live.encodeCore(collectUniqueGlyphIds(shaped.lines));
    if (useCache) await saveSlugCore(cacheKey, live.serialize());
  }
  // What earlier sessions learned beyond the core, back before the first frame. After the
  // prime (it fixes the core's slots); each grown glyph takes the next slot through the chain.
  if (useCache) {
    const growth = await loadSlugGrowth(growthKey, chain);
    if (growth) {
      const t0 = performance.now();
      const added = live.hydrateGrowth(growth);
      console.log(`[glyphEngine] hydrated ${added}/${growth.gid.length} grown glyph(s) in ${(performance.now() - t0).toFixed(1)}ms`);
    }
  }
  atlas._live = live;

  stage('ready');
  return atlas;
}

/**
 * Release a booted engine's workers and textures (a boot whose result nobody will use — e.g.
 * a React effect that was cancelled while booting). The shaper stays: the worker bridge may
 * hold it.
 * @param {GlyphAtlas} atlas
 */
export function disposeGlyphEngine(atlas) {
  atlas._live?.dispose();
  atlas._emojiAtlas?.dispose();
}
