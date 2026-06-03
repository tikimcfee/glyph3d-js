/**
 * LiveSlugAtlas — the live, growable Slug curve atlas.
 *
 * The renderer (GlyphField) draws glyphs from two textures: a curve texture
 * (quadratic beziers) and a glyph-map texture (glyphId → curve range). Those
 * are produced by SlugEncoder. Historically they were encoded ONCE at boot for
 * a fixed codepoint range (printable ASCII), so any glyph encountered later —
 * box-drawing, the Claude Code spinner stars, rounded box corners — indexed an
 * empty glyph-map slot and rendered blank.
 *
 * This class makes that encoding LIVE: it owns the set of encoded glyph IDs, the
 * current slug textures, and the set of live GlyphFields. When a grid encounters
 * a glyph that hasn't been encoded yet, it calls ensureGlyphsEncoded(); if the
 * set grows, we re-encode and hot-swap the new textures into every live field in
 * one shot (covering both SceneContext topologies — every field registers here
 * regardless of which context owns its grid).
 *
 * Boot seeds this with the up-front-encoded glyph IDs + their slug data so the
 * first frame is already warm; growth from there is incremental at the call site
 * and a (currently) full re-encode under the hood. Re-encode is a few ms and
 * growth is rare (only on first sighting of a new glyph), so the simple full
 * rebuild is the right tradeoff until profiling says otherwise.
 *
 * Step 1 will back this with a multi-font chain (the glyph IDs become dense
 * global slots spanning several fonts); Step 3 will persist/restore the encoded
 * set + textures to disk. The field-registry + ensure/re-encode/broadcast core
 * here stays the same through both.
 */

import SlugEncoder from './SlugEncoder.js';

export default class LiveSlugAtlas {
    /**
     * @param {Object}   opts
     * @param {Object}   opts.atlas        - GlyphAtlas the fields read `_slugData` off of.
     * @param {Object}   opts.shaper       - HarfBuzzShaper (or chain, later) for outline extraction.
     * @param {Iterable<number>} [opts.initialGlyphIds] - Glyph IDs already encoded at boot.
     * @param {Object}   [opts.initialSlugData]          - Boot slug data ({ curveTexture, glyphMapTexture }).
     */
    constructor({ atlas, shaper, initialGlyphIds = [], initialSlugData = null }) {
        /** @private */ this._atlas    = atlas;
        /** @private */ this._shaper   = shaper;
        /** @private */ this._encoder  = new SlugEncoder(shaper);
        /** @private @type {Set<number>} */ this._encoded = new Set(initialGlyphIds);
        /** @private @type {Set<Object>} live GlyphFields */ this._fields = new Set();
        /** @private */ this._slugData = initialSlugData;
        /** @private bumped on every re-encode; lets callers detect staleness */
        this._version = 0;
    }

    /** @returns {Object|null} the current { curveTexture, glyphMapTexture } */
    get slugData() { return this._slugData; }

    /** @returns {number} number of distinct glyph IDs currently encoded */
    get size() { return this._encoded.size; }

    /** @returns {number} monotonically increasing re-encode counter */
    get version() { return this._version; }

    /**
     * Register a live GlyphField so it receives texture hot-swaps on growth.
     * Idempotent. Newly registered fields keep whatever slug data they were
     * constructed with (the atlas's current `_slugData`), which is always the
     * latest — no catch-up needed.
     * @param {Object} field - a GlyphField with setSlugData()
     */
    registerField(field) {
        if (field) this._fields.add(field);
    }

    /** @param {Object} field */
    unregisterField(field) {
        this._fields.delete(field);
    }

    /**
     * Ensure every glyph ID in `glyphIds` has its curves encoded into the live
     * textures. Glyph 0 (.notdef) is skipped — it has no curves and renders as a
     * blank cell. Re-encodes + broadcasts only when the encoded set actually grew.
     *
     * @param {Iterable<number>} glyphIds
     * @returns {{ grew: boolean, added: number, total: number }}
     */
    ensureGlyphsEncoded(glyphIds) {
        let added = 0;
        for (const g of glyphIds) {
            if (g > 0 && !this._encoded.has(g)) { this._encoded.add(g); added++; }
        }
        if (added === 0) return { grew: false, added: 0, total: this._encoded.size };
        this._reencode();
        return { grew: true, added, total: this._encoded.size };
    }

    /**
     * Convenience: ensure encoding for a list of Unicode codepoints, resolving
     * each to its glyph ID through the shape cache (HarfBuzz fallback on miss).
     * @param {Iterable<number>} codepoints
     * @param {{lookup:(cp:number)=>{g:number}}} shapeCache
     * @returns {{ grew: boolean, added: number, total: number }}
     */
    ensureCodepoints(codepoints, shapeCache) {
        const gids = [];
        for (const cp of codepoints) {
            const entry = shapeCache.lookup(cp);
            if (entry && entry.g > 0) gids.push(entry.g);
        }
        return this.ensureGlyphsEncoded(gids);
    }

    /**
     * Re-encode the full encoded set and hot-swap the result into every live
     * field. Also updates the atlas's `_slugData` so any field constructed AFTER
     * this point starts with the current textures.
     * @private
     */
    _reencode() {
        const t0 = performance.now();
        this._slugData = this._encoder.encode(this._encoded);
        this._version++;

        if (this._atlas) this._atlas._slugData = this._slugData;

        let updated = 0;
        for (const field of this._fields) {
            if (field && typeof field.setSlugData === 'function') {
                field.setSlugData(this._slugData, this._shaper);
                // A re-encode may have allocated new emoji cells (bitmap slots); refresh
                // the color-emoji atlas texture so the shader's bitmap branch sees them.
                if (typeof field.setEmojiTexture === 'function') field.setEmojiTexture();
                updated++;
            }
        }

        console.log(
            `[LiveSlugAtlas] re-encode v${this._version}: ${this._encoded.size} glyphs, ` +
            `${updated}/${this._fields.size} fields hot-swapped (${(performance.now() - t0).toFixed(1)}ms)`
        );
    }
}
