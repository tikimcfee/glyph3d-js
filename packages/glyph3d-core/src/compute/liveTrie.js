/**
 * liveTrie — the byte-in pipeline's GlyphTrie, sourced from the LIVE atlas.
 *
 * The pipeline's decode kernel resolves codepoint → (glyphId, advance, height) with two
 * dependent loads, no CPU shaping per load. That only works if the trie's values are the
 * app's REAL ones: the glyph id is the FontChain global slot (the id the vertex shader's
 * glyph-map texture is keyed by), the advance uses the builder's exact font-units→world
 * conversion (ax/upem × worldScale × pixelHeight — ~12% wider than the ceil'd charWidth,
 * deliberately), and the height is the constant charHeight every glyph carries today.
 *
 * Two codepoint fates:
 *   - resolved: the shape cache knows it (primed at boot or seen since). glyphId may be 0
 *     (the blank slot) for codepoints no font covers — those resolve WITHOUT the missing
 *     flag, so they never spam the miss ring.
 *   - missing: never seen. The trie's missing block still occupies an advance (the layout
 *     stays right), the kernel reports it on the miss ring, and encodeMisses() does the
 *     CPU side: shape → allocate slot → Slug-encode → the next trie build maps it.
 *
 * Growth is a rebuild + re-upload, tens of KB — the same "full rebuild is fine" philosophy
 * as LiveSlugAtlas. The blockIndex is fixed-size (4352 slots) by construction.
 */

import { buildGlyphTrie } from './GlyphTrie.js';

/**
 * Build the pipeline trie from the live atlas's shape cache.
 * @param {Object} atlas - the booted GlyphAtlas (needs _shapeCache, _shaper, getCharSize)
 * @param {number} worldScale - the grid's world scale (charWidth / pixelWidth)
 * @returns {{blockIndex: Uint32Array, blocks: Float32Array}} the trie buffers
 */
export function buildLiveTrie(atlas, worldScale) {
    const cache = atlas?._shapeCache;
    const shaper = atlas?._shaper;
    if (!cache || !shaper) throw new Error('buildLiveTrie: atlas has no shape cache/shaper');
    const upem = shaper.upem;
    const charSize = atlas.getCharSize();
    const ws = worldScale * charSize.height;           // the builder's font-units→world factor
    const hWorld = charSize.height * worldScale;       // the constant per-glyph height
    const mAx = shaper.shape('M')[0]?.ax ?? Math.round(upem * 0.6);
    const cellAdv = (mAx / upem) * ws;                 // the missing/blank cell advance
    return buildGlyphTrie(
        cache.codepoints(),
        (cp) => {
            const e = cache.lookup(cp);
            if (!e) return null;                       // never shaped → missing block
            if (!e.g) return { glyphId: 0, advance: cellAdv, height: hWorld };  // uncoverable: blank, not missing
            return { glyphId: e.g, advance: (e.ax / upem) * ws, height: hWorld };
        },
        { missingAdvance: cellAdv, missingHeight: hWorld },
    );
}

/**
 * The CPU side of a miss: shape each codepoint (allocates its slot; emoji draw rides the
 * FontChain bitmap path), then Slug-encode the new glyphs and hot-swap the live fields.
 * @param {Object} atlas - the booted GlyphAtlas (uses _shapeCache and _live)
 * @param {number[]} misses - codepoints from GlyphPipelineKernels.readMisses()
 * @returns {{grew: boolean}} whether the atlas encoded new glyphs
 */
export function encodeMisses(atlas, misses) {
    if (!misses?.length) return { grew: false };
    const cache = atlas?._shapeCache;
    if (!cache) return { grew: false };
    const gids = [];
    for (const cp of misses) {
        const e = cache.lookup(cp);
        if (e && e.g > 0) gids.push(e.g);
    }
    if (!gids.length || typeof atlas._live?.ensureGlyphsEncoded !== 'function') return { grew: false };
    return atlas._live.ensureGlyphsEncoded(gids);
}
