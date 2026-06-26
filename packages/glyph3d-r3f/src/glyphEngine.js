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

import { GlyphAtlas, EmojiAtlas, collectUniqueGlyphIds } from '@glyph3d/core';
import { MonospaceShapeCache, shapeText, LiveSlugAtlas, FontChain } from '@glyph3d/core/shaping';
import { getWorkerBridge } from '@glyph3d/core/workers';

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
  const encodeText = codepointsFromRanges(opts.encodeRanges);
  const shaped = shapeText(shapeCache, encodeText);
  const glyphIds = collectUniqueGlyphIds(shaped.lines);

  // CodeGrid (and GlyphField) auto-discover these off the atlas.
  atlas._shaper = shaper;
  // atlas._slugData is set by LiveSlugAtlas below — it now owns the initial encode (one encoder
  // for boot AND growth, so growth appends instead of re-encoding the whole set).
  // TerminalGrid maps codepoint→glyphId through this primed cache (its glyph IDs
  // are the same ones the Slug glyphMapTexture is keyed by).
  atlas._shapeCache = shapeCache;
  // Color-emoji bitmap atlas — GlyphField discovers this for its bitmap branch.
  atlas._emojiAtlas = emojiAtlas;
  // Live, growable Slug atlas: glyphs encountered after boot (box-drawing, the
  // Claude Code spinner stars, rounded box corners, …) get encoded on demand and
  // hot-swapped into every live field. Seed it with the boot-encoded glyph IDs +
  // textures so the first frame is already warm. Fields self-register here.
  atlas._live = new LiveSlugAtlas({
    atlas,
    shaper,
    initialGlyphIds: glyphIds,
  });

  stage('ready');
  return atlas;
}
