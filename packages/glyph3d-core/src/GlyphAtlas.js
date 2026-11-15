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
 * independent place the pipeline stashes its shared handles and answers one
 * layout question. bootGlyphEngine() constructs one, attaches the shaper, the
 * shape cache, the emoji atlas, the live Slug atlas, and the slug textures, then
 * hands it to every CodeGrid / GlyphField / TreemapLabelManager. They read:
 *
 *   getCharSize()     — the monospace cell (width = the 'M' advance, height =
 *                       fontSize × 1.15). Set from the SHAPER by bootGlyphEngine
 *                       (`atlas._charSize`); the fontSize-derived value is only a
 *                       pre-boot fallback that never fires in the live pipeline.
 *
 *   fontFamily(id)    — one of the chain's font families as a field draws in it: its shape
 *                       cache (cell content → slot), its cell and its line metrics. The
 *                       default family's are the atlas's own (_shapeCache, getCharSize()).
 *
 * Stashed handles (set externally, listed here so they're discoverable):
 *   _shaper · _shapeCache · _emojiAtlas · _live (LiveSlugAtlas) · _slugData ·
 *   _charSize.
 */

import MonospaceShapeCache from './shaping/MonospaceShapeCache.js';
import { deriveCharSize } from './core/cellMetrics.js';

/**
 * A font family as a field draws in it.
 * @typedef {Object} AtlasFontFamily
 * @property {string|null} id      the family's id (null: a chain that names no families)
 * @property {number} index        its index in the chain (0: the default family)
 * @property {MonospaceShapeCache} shapeCache  cell content → slot, routed for this family
 * @property {{width:number, height:number}} charSize  its cell (as getCharSize's)
 * @property {{underlineY:number, strikeY:number, thickness:number}} lineMetrics  where its cell
 *   draws its lines (FontChain.lineMetrics)
 */

class GlyphAtlas {
    /**
     * @param {string} fontFamily - CSS font stack (kept for diagnostics/labels).
     * @param {number} fontSize   - cell font size in px; backs the charSize fallback.
     */
    constructor(fontFamily = 'Monaco, Menlo, Courier New, monospace', fontSize = 48) {
        /** The CSS font stack the atlas was booted with (diagnostics only; the fonts drawn are the chain's — see fontFamily()). */
        this.cssFontFamily = fontFamily;
        this.fontSize = fontSize;
        // Monospace cell — set from the shaper by bootGlyphEngine (atlas._charSize).
        // Until then, getCharSize() derives a sane default from fontSize.
        /** @private @type {{width:number,height:number}|null} */
        this._charSize = null;
        /** @private @type {Map<number, AtlasFontFamily>} by the family's index in the chain */
        this._families = new Map();
    }

    /**
     * A font family of the booted chain (FontChain's `family` fonts), by id; no id is the default
     * family. Made on first ask and kept: every field drawing in a family shares its shape cache.
     * An unknown id throws, naming the families.
     * @param {string|null} [id]
     * @returns {AtlasFontFamily}
     */
    fontFamily(id) {
        const shaper = this._shaper;
        if (typeof shaper?.view !== 'function') throw new Error('GlyphAtlas.fontFamily: the atlas has no font chain yet (bootGlyphEngine attaches it)');
        const view = shaper.view(id);
        let family = this._families.get(view.index);
        if (!family) {
            const own = view.index === 0;   // the default family: the atlas's own cache and cell
            family = {
                id: view.id,
                index: view.index,
                shapeCache: own && this._shapeCache ? this._shapeCache : new MonospaceShapeCache(view),
                charSize: own ? this.getCharSize() : deriveCharSize(view, this.fontSize),
                lineMetrics: view.lineMetrics(),
            };
            this._families.set(view.index, family);
        }
        return family;
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
}

export default GlyphAtlas;
