/**
 * MonospaceShapeCache - Per-codepoint glyph lookup table for monospace fonts.
 *
 * For monospace fonts, HarfBuzz shaping is a pure function: each Unicode
 * codepoint maps to exactly one glyph ID with a fixed advance width. This
 * class caches those mappings after a single priming pass, eliminating all
 * runtime WASM calls.
 *
 * Unknown codepoints (emoji, combining marks, CJK) fall back to HarfBuzz on
 * first encounter and are cached for subsequent hits, so correctness is
 * preserved for any character encountered in practice.
 *
 * Memory: ~256 entries x ~50 bytes (Map entry overhead) ≈ 12KB. Trivial.
 *
 * Worker transfer: toTransferArray() / fromTransferArray() pack the cache as
 * a flat Uint32Array for zero-copy Transferable transfer to workers. Layout:
 *   [codepoint0, glyphId0, advance0,  codepoint1, glyphId1, advance1, ...]
 * advance values are raw HarfBuzz font units (signed integers stored as
 * unsigned; negative advances are extremely rare and excluded from the current
 * ASCII/Latin-1 probe set).
 */

export default class MonospaceShapeCache {
    /**
     * @param {import('./HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     */
    constructor(shaper = null) {
        /** @private @type {Map<number, {g: number, ax: number}>} codepoint → {glyphId, xAdvance} */
        this._map = new Map();
        /** @private — null in worker-side instances (no WASM available there) */
        this._shaper = shaper;
        /** @private — miss fallback advance when there's no shaper (worker side) */
        this._defaultAdvance = 0;
    }

    /** @returns {number} Number of cached codepoints */
    get size() { return this._map.size; }

    /** @returns {Iterable<number>} the cached working set (primed + encountered so far) */
    codepoints() { return this._map.keys(); }

    /**
     * Prime the cache by shaping a representative string once.
     *
     * Call after HarfBuzzShaper.init() and before any rendering begins.
     * One HarfBuzz WASM call for the entire probe string; all subsequent
     * lookups are O(1) Map reads.
     *
     * The probe string should contain every character the app commonly renders.
     * Codepoints not in the probe string fall back to HarfBuzz automatically
     * on first use.
     *
     * @param {string} probeText - Representative characters (order unimportant)
     */
    prime(probeText) {
        const shaped = this._shaper.shape(probeText);
        for (let i = 0; i < shaped.length; i++) {
            const cluster = shaped[i].cl;   // UTF-16 code unit index in probeText
            const cp = probeText.codePointAt(cluster);
            if (cp !== undefined && !this._map.has(cp)) {
                this._map.set(cp, { g: shaped[i].g, ax: shaped[i].ax });
            }
        }
    }

    /**
     * Look up a single codepoint. Falls back to HarfBuzz on cache miss and
     * caches the result so the miss only occurs once per codepoint.
     *
     * @param {number} codepoint - Unicode codepoint (full code point, not UTF-16 code unit)
     * @returns {{g: number, ax: number}} Glyph ID and x-advance in font units
     */
    lookup(codepoint) {
        let entry = this._map.get(codepoint);
        if (entry !== undefined) return entry;

        if (this._shaper) {
            // Main-thread miss: resolve the single character via HarfBuzz, cache it.
            const ch = String.fromCodePoint(codepoint);
            const shaped = this._shaper.shape(ch);
            entry = shaped.length > 0
                ? { g: shaped[0].g, ax: shaped[0].ax }
                : { g: 0, ax: 0 };
        } else {
            // Worker-side miss: no WASM here. An unprimed codepoint has no Slug
            // curve encoded at boot, so it could not render as a real glyph on the
            // main-thread path either — fall back to a blank cell of the monospace
            // width (g:0) so columns stay aligned. Cached so the miss is one-time.
            entry = { g: 0, ax: this._defaultAdvance };
        }
        this._map.set(codepoint, entry);
        return entry;
    }

    /**
     * Shape an entire line using cached lookups.
     *
     * Returns an array compatible with the builder's inner loop, which reads
     * sg.g, sg.ax, sg.dx, sg.dy from each shaped glyph. dx and dy are always
     * 0 for a monospace font (no positioning offsets), so they are set to 0
     * here rather than adding them to the cache entries.
     *
     * Surrogate pairs (supplementary plane, U+10000+) are handled correctly:
     * codePointAt() returns the full code point; the loop advances by 2 for
     * those characters.
     *
     * @param {string} lineText - Single line of text, no newlines
     * @returns {Array<{g: number, ax: number, dx: number, dy: number}>}
     */
    shapeLine(lineText) {
        // Pre-allocate at lineText.length — may be slightly over for surrogate pairs,
        // trimmed at the end if needed.
        const result = new Array(lineText.length);
        let outIdx = 0;
        for (let i = 0, len = lineText.length; i < len; ) {
            const cp = lineText.codePointAt(i);
            const entry = this.lookup(cp);
            result[outIdx++] = { g: entry.g, ax: entry.ax, dx: 0, dy: 0 };
            i += cp > 0xFFFF ? 2 : 1;
        }
        // Trim to actual glyph count (handles surrogate pairs reducing the output length)
        if (outIdx < result.length) result.length = outIdx;
        return result;
    }

    /**
     * Export the cache as a flat Uint32Array for Transferable worker transfer.
     *
     * Advances are HarfBuzz font units (typically 0-2048). The full int32 range
     * is not required for normal font data but storing as Uint32 is safe for
     * positive advances. The Uint32Array transfers with zero copy via postMessage.
     *
     * @returns {Uint32Array} Flat array: [cp0, g0, ax0, cp1, g1, ax1, ...]
     */
    toTransferArray() {
        const arr = new Uint32Array(this._map.size * 3);
        let i = 0;
        for (const [cp, entry] of this._map) {
            arr[i++] = cp;
            arr[i++] = entry.g;
            arr[i++] = entry.ax;
        }
        return arr;
    }

    /**
     * Rebuild a shaper-less cache instance from a transferred Uint32Array
     * (worker-side). Inverse of toTransferArray(). The returned instance has a
     * working shapeLine()/lookup() with no WASM — misses fall back to a blank
     * cell of the monospace width (see lookup()).
     *
     * @param {Uint32Array} arr - Flat array from toTransferArray()
     * @returns {MonospaceShapeCache} worker-side cache (no shaper)
     */
    static fromTransferArray(arr) {
        const cache = new MonospaceShapeCache(null);
        for (let i = 0; i < arr.length; i += 3) {
            cache._map.set(arr[i], { g: arr[i + 1], ax: arr[i + 2] });
        }
        // Monospace: every advance is equal, so the first entry's advance is the
        // correct fallback width for any unprimed codepoint.
        cache._defaultAdvance = arr.length >= 3 ? arr[2] : 0;
        return cache;
    }

    /**
     * Clear the cache. Call if the font changes (e.g. font switching feature).
     * After invalidating, call prime() again with the new font loaded.
     */
    invalidate() {
        this._map.clear();
    }
}
