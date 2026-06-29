/**
 * GlyphAtlas — the runtime handle the glyph pipeline hangs off of.
 *
 * Historically this rasterized a Canvas2D bitmap atlas: one cell per glyph, a
 * grapheme→UV map, shelf packing, a codepoint→UV DataTexture, and a prebake
 * export/import path. That whole machinery is retired. Text now renders from
 * Slug vector curves (HarfBuzz outlines → GPU curve textures, encoded live by
 * LiveSlugAtlas) — nothing samples a bitmap cell anymore, so there is no canvas,
 * no UV map, and no packing here.
 *
 * What survives is the role this object still plays: the single, renderer-
 * independent place the pipeline stashes its shared handles and answers two
 * layout questions. bootGlyphEngine() constructs one, attaches the shaper, the
 * shape cache, the emoji atlas, the live Slug atlas, and the slug textures, then
 * hands it to every CodeGrid / GlyphField / TreemapLabelManager. They read:
 *
 *   getCharSize()     — the monospace cell (width = the 'M' advance, height =
 *                       fontSize × 1.15). Set from the SHAPER by bootGlyphEngine
 *                       (`atlas._charSize`); the fontSize-derived value is only a
 *                       pre-boot fallback that never fires in the live pipeline.
 *   getAtlasTexture() — { width, height } of the nominal atlas square — the
 *                       layout constant the instance builder carries through.
 *
 * Stashed handles (set externally, listed here so they're discoverable):
 *   _shaper · _shapeCache · _emojiAtlas · _live (LiveSlugAtlas) · _slugData ·
 *   _charSize.
 */

class GlyphAtlas {
    /**
     * @param {string} fontFamily - CSS font stack (kept for diagnostics/labels).
     * @param {number} fontSize   - cell font size in px; backs the charSize fallback.
     * @param {number} atlasSize  - nominal atlas square dimension (layout constant).
     */
    constructor(fontFamily = 'Monaco, Menlo, Courier New, monospace', fontSize = 48, atlasSize = 2048) {
        this.fontFamily = fontFamily;
        this.fontSize = fontSize;
        this.atlasSize = atlasSize;
        /** @private layout constant returned by getAtlasTexture() */
        this._atlasSize = atlasSize;
        // Monospace cell — set from the shaper by bootGlyphEngine (atlas._charSize).
        // Until then, getCharSize() derives a sane default from fontSize.
        /** @private @type {{width:number,height:number}|null} */
        this._charSize = null;
    }

    /**
     * Monospace cell size { width, height }. Set from the shaper at boot; falls
     * back to a fontSize-derived guess (0.6em advance, 1.15em line) pre-boot.
     * @returns {{width:number, height:number}}
     */
    getCharSize() {
        if (this._charSize) return this._charSize;
        return { width: Math.ceil(this.fontSize * 0.6), height: this.fontSize * 1.15 };
    }

    /**
     * Nominal atlas square — the instance builder carries `.width` as a layout
     * constant. No bitmap backs it anymore.
     * @returns {{width:number, height:number}}
     */
    getAtlasTexture() {
        return { width: this._atlasSize, height: this._atlasSize };
    }
}

export default GlyphAtlas;
