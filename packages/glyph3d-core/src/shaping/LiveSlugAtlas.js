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
 * an OUTLINE glyph that hasn't been encoded yet, it calls ensureGlyphsEncoded();
 * if the set grows, we re-encode and hot-swap the new textures into every live field in
 * one shot (covering both SceneContext topologies — every field registers here
 * regardless of which context owns its grid). BITMAP (emoji) slots are NOT encoded —
 * their curve entry is empty by construction; a new emoji cell only refreshes the
 * shared emoji texture, never the curve atlas. Every growth logs its source
 * (codepoint → font:glyph) so a missing core glyph is bakeable, not a mystery.
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
import { loadStats } from '../core/loadStats.js';

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
     * blank cell. BITMAP (emoji) slots are skipped too — their curve entry would
     * be empty by construction (the bitmap branch renders them), so they only get
     * an emoji-texture refresh, NOT a curve re-encode + per-field hot-swap (the
     * recurring '+1 [.blank]' growths were emoji sightings paying full growth
     * price for an empty entry). Re-encodes + broadcasts only when the encoded
     * set actually grew.
     *
     * @param {Iterable<number>} glyphIds
     * @param {Map<number, number>} [provenance] - slot → codepoint that sighted it (log detail)
     * @returns {{ grew: boolean, added: number, total: number }}
     */
    ensureGlyphsEncoded(glyphIds, provenance) {
        // Partition: bitmap slots to the emoji refresh, outline slots to the encoder.
        let outlineIds = glyphIds;
        const emojiSlots = [];
        if (typeof this._shaper.isBitmapSlot === 'function') {
            outlineIds = [];
            for (const id of glyphIds) {
                if (this._shaper.isBitmapSlot(id)) emojiSlots.push(id);
                else outlineIds.push(id);
            }
        }
        if (emojiSlots.length) this._refreshEmojiTextures(emojiSlots, provenance);

        // Bitmap slots ALSO need their glyph-MAP entries (mode 1 + cell): without one
        // the texel is all-zero — mode 0, curveCount 0 — and the slug branch discards
        // the glyph as empty (the invisible-emoji bug). Map-only append; the outline
        // append below rebuilds the full map from the same accumulator when IT grows.
        const bitmapRes = emojiSlots.length ? this._encoder.appendBitmapSlots(emojiSlots) : null;

        // The encoder skips .notdef + already-encoded internally and APPENDS only the new glyphs
        // (each extracted exactly once — no full re-encode). It returns the rebuilt textures and
        // whether anything grew.
        const t0 = performance.now();
        const res = this._encoder.appendGlyphs(outlineIds);
        if (!res.grew && !bitmapRes?.grew) return { grew: false, added: 0, total: this._encoder.size };

        const prev = this._slugData;   // orphaned by the swap — disposed after it lands
        this._slugData = res.grew
            ? res            // full rebuild — includes the bitmap entries from the accumulator
            : { ...this._slugData, glyphMapTexture: bitmapRes.glyphMapTexture };
        this._version++;
        if (this._atlas) this._atlas._slugData = this._slugData;

        let updated = 0;
        for (const field of this._fields) {
            if (field && typeof field.setSlugData === 'function') {
                field.setSlugData(this._slugData, this._shaper);
                // (No setEmojiTexture here: emoji cells are bitmap slots, and those
                // never reach the encoder — _refreshEmojiTextures owns the refresh.)
                updated++;
            }
        }

        // Every live field now reads the NEW pair (registration is construction-time
        // and unregister is dispose-time, so nothing live still points at the old
        // one). The old pair's GPUTextures only die on texture.dispose() — without
        // this, each growth leaks a pair until page unload (VRAM pressure on the
        // bulk-load path: 7 growths in 2s preceded the 2026-08-04 device OOM).
        if (prev) {
            if (res.grew && prev.curveTexture && prev.curveTexture !== this._slugData.curveTexture) {
                prev.curveTexture.dispose();
            }
            if (prev.glyphMapTexture && prev.glyphMapTexture !== this._slugData.glyphMapTexture) {
                prev.glyphMapTexture.dispose();
            }
        }

        // Name the new glyphs WITH their source so a growth is readable (and bakeable):
        // U+XXXX 'c' → Font:gid 'name'. Bitmap slots never reach here (see above).
        const ids = res.addedIds || [];
        const desc = (id) => {
            const d = this._shaper.describeSlot?.(id);
            const cp = provenance?.get(id);
            const src = cp != null
                ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(String.fromCodePoint(cp))}`
                : `slot ${id}`;
            return d ? `${src}→${d.font}:${d.gid} "${d.name}"` : `${src}→${id}`;
        };
        const names = ids.slice(0, 24).map(desc).join(', ');
        const more = ids.length > 24 ? ` …+${ids.length - 24}` : '';
        const blanks = ids.filter((id) => this._shaper.describeSlot?.(id)?.name === '.blank').length;
        const ms = performance.now() - t0;
        // The load path's atlas cost, counted for the load trace (core/loadStats.js).
        loadStats.atlasGrows++;
        loadStats.atlasMs += ms;
        loadStats.atlasFieldsSwapped += updated;
        loadStats.atlasBlanks += blanks;
        loadStats.atlasGlyphsAdded += res.added;
        console.log(
            `[LiveSlugAtlas] grew v${this._version}: +${res.added} → ${this._encoder.size} glyphs ` +
            `[${names}${more}]${blanks ? ` (${blanks} blank)` : ''}, ` +
            `${updated}/${this._fields.size} fields hot-swapped in ${ms.toFixed(1)}ms`
        );
        return { grew: true, added: res.added, total: this._encoder.size };
    }

    /**
     * A new bitmap (emoji) slot needs NO curve work — but its atlas cell was just
     * drawn, so every field's shared emoji texture wants its dims + dirty flag.
     * Logged with the same provenance detail as a growth, at debug: emoji are an
     * expected, cheap sighting, not an atlas event.
     * @private
     */
    _refreshEmojiTextures(slots, provenance) {
        let n = 0;
        for (const field of this._fields) {
            if (typeof field?.setEmojiTexture === 'function') { field.setEmojiTexture(); n++; }
        }
        const desc = (id) => {
            const cp = provenance?.get(id);
            const cell = this._shaper.describeSlot?.(id)?.name ?? id;
            return cp != null
                ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(String.fromCodePoint(cp))}→${cell}`
                : String(id);
        };
        console.debug(
            `[LiveSlugAtlas] emoji: +${slots.length} cell(s) [${slots.slice(0, 12).map(desc).join(', ')}` +
            `${slots.length > 12 ? ` …+${slots.length - 12}` : ''}], ${n}/${this._fields.size} fields refreshed`
        );
    }

    /**
     * Convenience: ensure encoding for a list of Unicode codepoints, resolving
     * each to its glyph ID through the shape cache (HarfBuzz fallback on miss).
     * Passes the codepoint → slot provenance through to the growth log.
     * @param {Iterable<number>} codepoints
     * @param {{lookup:(cp:number)=>{g:number}}} shapeCache
     * @returns {{ grew: boolean, added: number, total: number }}
     */
    ensureCodepoints(codepoints, shapeCache) {
        const gids = [];
        const provenance = new Map();
        for (const cp of codepoints) {
            const entry = shapeCache.lookup(cp);
            if (entry && entry.g > 0) {
                gids.push(entry.g);
                if (!provenance.has(entry.g)) provenance.set(entry.g, cp);
            }
        }
        return this.ensureGlyphsEncoded(gids, provenance);
    }

}
