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
     * @param {Iterable<number>} [opts.initialGlyphIds] - Glyph IDs to encode at boot (the encoder
     *           does the initial encode and stashes the result on atlas._slugData).
     * @param {Object}   [opts.initialDescriptor] - A prebaked SlugBuffer descriptor (from the
     *           slug-core cache). When present the encoder HYDRATES from it — skipping the boot
     *           encode entirely — and `initialGlyphIds` is ignored. The buffer stays live (growth
     *           appends from the hydrated set).
     */
    constructor({ atlas, shaper, initialGlyphIds = [], initialDescriptor = null }) {
        /** @private */ this._atlas    = atlas;
        /** @private */ this._shaper   = shaper;
        /** @private */ this._encoder  = new SlugEncoder(shaper);
        /** @private @type {Set<Object>} live GlyphFields */ this._fields = new Set();
        // The encoder that GROWS the atlas is the same one that holds the boot glyphs, so growth
        // APPENDS instead of re-encoding the whole set. Boot either HYDRATES from a prebaked
        // descriptor (cache hit → skip the encode) or encodes the glyph set from scratch (miss).
        /** @private */ this._slugData = initialDescriptor
            ? this._encoder.loadSerialized(initialDescriptor)
            : this._encoder.encode(initialGlyphIds);
        if (atlas) atlas._slugData = this._slugData;
        /** @private bumped on every growth; lets callers detect staleness */
        this._version = 0;
    }

    /** Snapshot the encoded core as a serializable descriptor (for the slug-core cache). */
    serialize() {
        return this._encoder.serialize();
    }

    /** @returns {Object|null} the current { curveTexture, glyphMapTexture } */
    get slugData() { return this._slugData; }

    /** @returns {number} number of distinct glyph IDs currently encoded */
    get size() { return this._encoder.size; }

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
        // The encoder skips .notdef + already-encoded internally and APPENDS only the new glyphs
        // (each extracted exactly once — no full re-encode). It returns the rebuilt textures and
        // whether anything grew.
        const res = this._encoder.appendGlyphs(glyphIds);
        if (!res.grew) return { grew: false, added: 0, total: this._encoder.size };

        this._slugData = res;            // { curveTexture, glyphMapTexture, stats }
        this._version++;
        if (this._atlas) this._atlas._slugData = this._slugData;

        let updated = 0;
        for (const field of this._fields) {
            if (field && typeof field.setSlugData === 'function') {
                field.setSlugData(this._slugData, this._shaper);
                // A growth may have allocated new emoji cells (bitmap slots); refresh the
                // color-emoji atlas texture so the shader's bitmap branch sees them.
                if (typeof field.setEmojiTexture === 'function') field.setEmojiTexture();
                updated++;
            }
        }

        // Name the new glyphs so it's visible WHAT grew (→ decide if it belongs in the boot core).
        const ids = res.addedIds || [];
        const names = ids.slice(0, 24).map((id) => (this._shaper.glyphName?.(id)) || id).join(', ');
        const more = ids.length > 24 ? ` …+${ids.length - 24}` : '';
        console.log(
            `[LiveSlugAtlas] grew v${this._version}: +${res.added} → ${this._encoder.size} glyphs ` +
            `[${names}${more}], ${updated}/${this._fields.size} fields hot-swapped`
        );
        return { grew: true, added: res.added, total: this._encoder.size };
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

}
