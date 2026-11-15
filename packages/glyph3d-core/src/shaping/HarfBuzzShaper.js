/**
 * HarfBuzzShaper - Wraps harfbuzzjs WASM for text shaping + outline extraction.
 *
 * Single class that owns the WASM instance, font blob, face, and font objects.
 * Main thread and each worker each create their own HarfBuzzShaper instance
 * (WASM instances are per-thread in browsers).
 *
 * All HarfBuzz buffer objects are destroyed in finally blocks to prevent
 * WASM heap leaks.
 */

import initHarfBuzz from './vendor/harfbuzz.js';

export default class HarfBuzzShaper {
    constructor() {
        /** @private hbjs API object */
        this._hb = null;
        /** @private HarfBuzz blob */
        this._blob = null;
        /** @private HarfBuzz face */
        this._face = null;
        /** @private HarfBuzz font */
        this._font = null;
        /** @private Units per em (typically 2048 for TrueType) */
        this._upem = 0;
        /** @private Glyph count from face */
        this._glyphCount = 0;
        /** @private Initialization complete flag */
        this._ready = false;
        /** @private Track first shape call for logging */
        this._firstShapeLogged = false;
        /** @private Track first outline call for logging */
        this._firstOutlineLogged = false;
        /** @private the font's name, for logs and errors */
        this._name = 'font';
        /** @private the variation instance this font is set to (null: the file's default) */
        this._variations = null;
        /** @private whether fontExtents() takes in the font's line gap (half above, half below) */
        this._lineGap = false;
        /** @private false for an instance(): the blob and face are another shaper's to destroy */
        this._ownsFace = true;
    }

    /**
     * Initialize WASM and load a font from an ArrayBuffer.
     *
     * Pass a shared `hb` module to reuse one WASM instance across several faces
     * (a font chain) instead of spinning up a separate WASM module per font.
     *
     * @param {ArrayBuffer} fontBuffer - Raw .ttf/.otf font file bytes
     * @param {Object}  [options]
     * @param {string}  [options.wasmUrl]    - Override path to hb.wasm (for workers)
     * @param {ArrayBuffer|Uint8Array} [options.wasmBinary] - Raw WASM bytes for offline/embedded usage
     * @param {Object}  [options.hb]         - An already-initialized hbjs module to reuse
     * @param {string}  [options.name]       - Human-readable font name (logging only)
     * @param {Record<string, number>} [options.variations] - the instance of a VARIABLE font to
     *   draw and shape, by axis tag (`{ wght: 400, slnt: 0 }`); an axis the font lacks, or a value
     *   outside its range, throws
     * @param {boolean} [options.lineGap=false] - fontExtents() takes in the font's line gap
     *   (see fontExtents)
     * @returns {Promise<void>}
     */
    async init(fontBuffer, options = {}) {
        const { wasmUrl, wasmBinary, hb, name = 'font', variations = null, lineGap = false } = options;
        if (hb) {
            this._hb = hb;
        } else {
            const wasmStart = performance.now();
            this._hb = await initHarfBuzz(wasmBinary ? { wasmBinary, wasmUrl } : wasmUrl);
            console.log(`[HarfBuzz] WASM loaded (${(performance.now() - wasmStart).toFixed(1)}ms)`);
        }

        this._blob = this._hb.createBlob(fontBuffer);
        this._face = this._hb.createFace(this._blob, 0);
        this._font = this._hb.createFont(this._face);
        this._upem = this._face.upem;
        this._name = name;
        this._lineGap = !!lineGap;
        if (variations) this._setVariations(variations);

        // Collect supported unicodes to get glyph count
        const unicodes = this._face.collectUnicodes();
        this._glyphCount = unicodes.length;

        console.log(
            `[HarfBuzz] Font loaded: ${name}, ${this._glyphCount} glyphs, upem=${this._upem}`
        );

        this._ready = true;
    }

    /**
     * Another instance of this shaper's VARIABLE font — the same file and face (no second copy
     * of its bytes), drawn and shaped at other axis values: a family's bold is `{ wght: 700 }` of
     * the file its regular is `{ wght: 400 }` of. This shaper owns the face: destroy it last.
     * @param {Record<string, number>} variations  by axis tag
     * @param {string} [name]  for logs
     * @returns {HarfBuzzShaper}
     */
    instance(variations, name = `${this._name} instance`) {
        if (!this._ready) throw new Error('HarfBuzzShaper.instance: the shaper is not initialized');
        const s = new HarfBuzzShaper();
        s._hb = this._hb;
        s._blob = this._blob;
        s._face = this._face;
        s._ownsFace = false;
        s._font = this._hb.createFont(this._face);
        s._upem = this._upem;
        s._glyphCount = this._glyphCount;
        s._name = name;
        s._lineGap = this._lineGap;
        s._firstShapeLogged = s._firstOutlineLogged = true;
        s._setVariations(variations);
        s._ready = true;
        return s;
    }

    /** @returns {Record<string, number>|null} the variation instance this font is set to */
    get variations() { return this._variations; }

    /**
     * @private Set the font's variation instance, checked against the file's own axes: a typo'd
     * tag or an out-of-range value would otherwise draw the default instance, silently.
     */
    _setVariations(variations) {
        const axes = this._face.getAxisInfos();
        for (const [tag, value] of Object.entries(variations)) {
            const axis = axes[tag];
            if (!axis) throw new Error(`[HarfBuzz] "${this._name}" has no '${tag}' axis (its axes: ${Object.keys(axes).join(', ') || 'none — not a variable font'})`);
            if (!Number.isFinite(value) || value < axis.min || value > axis.max) throw new Error(`[HarfBuzz] "${this._name}": ${tag} = ${value} is outside the axis (${axis.min} … ${axis.max})`);
        }
        this._font.setVariations(variations);
        this._variations = { ...variations };
    }

    /** @returns {Object} the underlying hbjs module (shareable across faces) */
    get hb() { return this._hb; }

    /**
     * The set of Unicode codepoints this font's cmap covers. Used by FontChain
     * to route each codepoint to the first font that can render it.
     * @returns {number[]} codepoints (unsorted)
     */
    collectUnicodes() {
        return this._face ? this._face.collectUnicodes() : [];
    }

    /** @returns {boolean} Whether the shaper is ready for use */
    get ready() { return this._ready; }

    /** @returns {number} Font units per em */
    get upem() { return this._upem; }

    /** @returns {number} Number of glyphs in the font */
    get glyphCount() { return this._glyphCount; }

    /**
     * Shape a text string. Returns shaped glyph array.
     *
     * The HarfBuzz buffer is always destroyed in a finally block, even if
     * shaping throws.
     *
     * @param {string} text - Text to shape
     * @param {string} [features] - Comma-separated OpenType features, e.g. "liga,kern"
     * @returns {Array<{g: number, cl: number, ax: number, ay: number, dx: number, dy: number, flags: number}>}
     *   g = glyph ID, cl = cluster index, ax/ay = advance, dx/dy = offset
     */
    shape(text, features) {
        const buffer = this._hb.createBuffer();
        try {
            buffer.addText(text);
            buffer.guessSegmentProperties();
            this._hb.shape(this._font, buffer, features);
            const result = buffer.shapeDirect();

            // Log only the first shape call
            if (!this._firstShapeLogged) {
                this._firstShapeLogged = true;
                const preview = text.length > 30 ? text.substring(0, 30) + '...' : text;
                console.log(
                    `[HarfBuzz] Shaped "${preview}" → ${result.length} glyphs`
                );
            }

            return result;
        } finally {
            buffer.destroy();
        }
    }

    /**
     * Extract outline curves for a glyph (for the Slug encode, encodeGlyphBatch).
     *
     * Returns parsed path segments from glyphToJson:
     *   M = moveTo [x, y]
     *   L = lineTo [x, y]
     *   Q = quadraticTo [cx, cy, x, y]
     *   C = cubicTo [c1x, c1y, c2x, c2y, x, y]
     *   Z = closePath []
     *
     * @param {number} glyphId - HarfBuzz glyph ID from shape() output
     * @returns {Array<{type: string, values: number[]}>}
     */
    glyphOutline(glyphId) {
        const result = this._font.glyphToJson(glyphId);

        // Log only the first outline extraction
        if (!this._firstOutlineLogged) {
            this._firstOutlineLogged = true;
            const curveCount = result.filter(s => s.type === 'Q' || s.type === 'C' || s.type === 'L').length;
            console.log(
                `[HarfBuzz] Outline extracted: glyph ${glyphId} → ${curveCount} curves`
            );
        }

        return result;
    }

    /**
     * Get the SVG path string for a glyph.
     * @param {number} glyphId - HarfBuzz glyph ID
     * @returns {string} SVG path data (e.g. "M100,200L300,400Q...")
     */
    glyphToPath(glyphId) {
        return this._font.glyphToPath(glyphId);
    }

    /**
     * Get glyph horizontal advance in font units.
     * @param {number} glyphId
     * @returns {number}
     */
    glyphAdvance(glyphId) {
        return this._font.glyphHAdvance(glyphId);
    }

    /**
     * Get glyph extents (bounding box info) in font units.
     * @param {number} glyphId
     * @returns {{xBearing: number, yBearing: number, width: number, height: number}|null}
     */
    glyphExtents(glyphId) {
        return this._font.glyphExtents(glyphId);
    }

    /**
     * The font's horizontal extents (ascender, descender, lineGap) in font units — the vertical
     * span a glyph's cell is normalized to. A font loaded with `lineGap` has its line gap taken
     * in, half above the ascender and half below the descender: its cell is then the line the
     * font was designed to be set on (ascender − descender + lineGap), as terminals lay it out.
     * @returns {{ascender: number, descender: number, lineGap: number}}
     */
    fontExtents() {
        const e = this._font.hExtents();
        if (!this._lineGap || !(e.lineGap > 0)) return e;
        const half = e.lineGap / 2;
        return { ascender: e.ascender + half, descender: e.descender - half, lineGap: e.lineGap };
    }

    /**
     * Get glyph name string.
     * @param {number} glyphId
     * @returns {string}
     */
    glyphName(glyphId) {
        return this._font.glyphName(glyphId);
    }

    /**
     * Destroy all HarfBuzz objects and free WASM memory.
     * Must be called on teardown to prevent memory leaks.
     */
    destroy() {
        if (this._font) { this._font.destroy(); this._font = null; }
        if (this._ownsFace) {
            if (this._face) this._face.destroy();
            if (this._blob) this._blob.destroy();
        }
        this._face = null;
        this._blob = null;
        this._hb = null;
        this._ready = false;
    }
}
