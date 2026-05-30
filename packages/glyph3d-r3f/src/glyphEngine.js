// glyphEngine — boot the renderer-independent glyph pipeline (atlas + HarfBuzz
// shaper + Slug curve encoding). Returns a ready GlyphAtlas with the shaper and
// slug textures stashed on it (the convention CodeGrid auto-discovers).
//
// Design note: this deliberately takes EVERYTHING as explicit options — the font
// URL, family, sizes, and which codepoint ranges to prime/encode. Nothing about
// "Cousine at 48px in a 2048 atlas" is baked in here; those are the consumer's
// decisions. The keystone (and later apps) pass their own. This is GPU/renderer
// independent: GlyphAtlas is Canvas2D, the shaper is WASM, SlugEncoder is data —
// so it can run before any WebGPU device exists.

import { GlyphAtlas, HarfBuzzShaper, SlugEncoder, collectUniqueGlyphIds } from '@glyph3d/core';
import { MonospaceShapeCache, shapeText } from '@glyph3d/core/shaping';
import { getWorkerBridge } from '@glyph3d/core/workers';

/**
 * @typedef {Object} GlyphEngineOptions
 * @property {string}   fontUrl      - URL to the .ttf/.otf font file (required).
 * @property {string}   [fontFamily] - CSS font stack for the Canvas2D atlas.
 * @property {number}   [fontSize]   - Atlas glyph cell font size in px.
 * @property {number}   [atlasSize]  - Atlas texture dimension in px (square).
 * @property {Array<[number, number]>} [primeRanges] - Inclusive codepoint ranges
 *           to prime in the shape cache (shaping warm-up).
 * @property {Array<[number, number]>} [encodeRanges] - Inclusive codepoint ranges
 *           to encode into Slug curve textures up front.
 * @property {(stage: string) => void} [onStage] - Progress callback.
 */

/** Sensible defaults — explicit, overridable, and documented (not hidden). */
export const DEFAULT_ENGINE_OPTIONS = {
  fontFamily: 'Cousine, Monaco, Menlo, Courier New, monospace',
  fontSize: 48,
  atlasSize: 2048,
  // ASCII + Latin-1 + box-drawing. The consumer can widen this for other scripts.
  primeRanges: [[0x20, 0x7e], [0xa0, 0xff], [0x2500, 0x257f]],
  // Up-front Slug encode covers printable ASCII; atlas/slug auto-grow for the rest.
  encodeRanges: [[0x20, 0x7e]],
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
 * @returns {Promise<GlyphAtlas>} atlas with `_shaper` and `_slugData` attached.
 */
export async function bootGlyphEngine(options) {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  if (!opts.fontUrl) throw new Error('bootGlyphEngine: `fontUrl` is required.');
  const stage = opts.onStage ?? (() => {});

  stage('atlas');
  const atlas = new GlyphAtlas(opts.fontFamily, opts.fontSize, opts.atlasSize);
  await atlas.generate();

  stage('shaper');
  const fontBuffer = await (await fetch(opts.fontUrl)).arrayBuffer();
  const shaper = new HarfBuzzShaper();
  await shaper.init(fontBuffer);

  const shapeCache = new MonospaceShapeCache(shaper);
  shapeCache.prime(codepointsFromRanges(opts.primeRanges));

  // Workers reuse the same shaper + cache (main-thread fallback if no workers).
  getWorkerBridge().setShaper(shaper, shapeCache);

  stage('slug');
  const encodeText = codepointsFromRanges(opts.encodeRanges);
  const shaped = shapeText(shapeCache, encodeText);
  const glyphIds = collectUniqueGlyphIds(shaped.lines);
  const slugData = new SlugEncoder(shaper).encode(glyphIds);

  // CodeGrid (and GlyphField) auto-discover these off the atlas.
  atlas._shaper = shaper;
  atlas._slugData = slugData;
  // TerminalGrid maps codepoint→glyphId through this primed cache (its glyph IDs
  // are the same ones the Slug glyphMapTexture is keyed by).
  atlas._shapeCache = shapeCache;

  stage('ready');
  return atlas;
}
