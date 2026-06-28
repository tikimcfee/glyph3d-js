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

// LARGE CORE — ~everything a code IDE + terminal actually renders, encoded up front so the
// live atlas rarely has to grow mid-session (growth = a main-thread encode + a field hot-swap).
// Codepoints the font chain doesn't cover resolve to .notdef (glyph 0) and are skipped by the
// encoder, so this list is generous without waste — only font-covered glyphs cost anything.
// Deliberately bounded: NO full CJK (DejaVu doesn't cover it) and NO giant Nerd-Font icon PUA
// (thousands of rarely-used icons — those stay cheap live-encodes). Serializing this core to a
// prebaked blob (the next step) is what would let us go to literal full-coverage for free.
const LARGE_CORE_RANGES = [
  [0x0020, 0x007e], // ASCII printable
  [0x00a0, 0x024f], // Latin-1 Supplement + Latin Extended-A/B
  [0x0250, 0x02ff], // IPA + spacing modifiers
  [0x0300, 0x036f], // combining diacriticals
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // general punctuation
  [0x2070, 0x20cf], // super/subscripts + currency
  [0x2100, 0x218f], // letterlike + number forms
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // mathematical operators
  [0x2300, 0x23ff], // miscellaneous technical
  [0x2400, 0x24ff], // control pictures + enclosed alphanumerics
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes
  [0x2600, 0x26ff], // miscellaneous symbols
  [0x2700, 0x27bf], // dingbats
  [0x2800, 0x28ff], // braille patterns
  [0x2900, 0x297f], // supplemental arrows-B
  [0x2a00, 0x2aff], // supplemental mathematical operators
  [0x2b00, 0x2bff], // misc symbols & arrows
  [0xe0a0, 0xe0d4], // powerline (private use)
  [0xfff0, 0xffff], // specials (replacement char U+FFFD)
];

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

/** Monospace cell size FROM THE SHAPER — the single metrics source, replacing GlyphAtlas's
 *  Canvas2D 'M' measure. width = the 'M' advance (= the forced monospace cell, what the builder
 *  lays out to); height = fontSize × 1.15 (byte-identical to the old glyphHeight formula). */
const deriveCharSize = (shaper, fontSize) => {
  const upem = shaper.upem || 2048;
  const shaped = shaper.shape ? shaper.shape('M') : null;
  const ax = (shaped && shaped[0]) ? shaped[0].ax : upem * 0.6;
  return { width: Math.ceil(ax / upem * fontSize), height: fontSize * 1.15 };
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
  // charSize from the SHAPER now (was GlyphAtlas's Canvas2D 'M' measure) — step 1 of retiring
  // the bitmap rasterization. Logs both so we can confirm they match before pulling generate().
  const _csOld = atlas.getCharSize();
  atlas._charSize = deriveCharSize(shaper, opts.fontSize);
  console.log(`[glyphEngine] charSize: canvas=${_csOld.width}x${_csOld.height} → shaper=${atlas._charSize.width}x${atlas._charSize.height}`);
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
