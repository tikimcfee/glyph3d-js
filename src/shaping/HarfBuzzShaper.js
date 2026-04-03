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
    }

    /**
     * Initialize WASM and load a font from an ArrayBuffer.
     * @param {ArrayBuffer} fontBuffer - Raw .ttf/.otf font file bytes
     * @param {string} [wasmUrl] - Override path to hb.wasm (for workers)
     * @returns {Promise<void>}
     */
    async init(fontBuffer, wasmUrl) {
        const wasmStart = performance.now();
        this._hb = await initHarfBuzz(wasmUrl);
        const wasmMs = (performance.now() - wasmStart).toFixed(1);

        // The WASM binary is already loaded inside initHarfBuzz;
        // log approximate size from the font buffer as a reference
        console.log(`[HarfBuzz] WASM loaded (${wasmMs}ms)`);

        this._blob = this._hb.createBlob(fontBuffer);
        this._face = this._hb.createFace(this._blob, 0);
        this._font = this._hb.createFont(this._face);
        this._upem = this._face.upem;

        // Collect supported unicodes to get glyph count
        const unicodes = this._face.collectUnicodes();
        this._glyphCount = unicodes.length;

        console.log(
            `[HarfBuzz] Font loaded: Cousine-Regular, ${this._glyphCount} glyphs, upem=${this._upem}`
        );

        this._ready = true;
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
            const result = buffer.json();

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
     * Extract outline curves for a glyph (for SlugEncoder in Phase 2).
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
     * Get font horizontal extents (ascender, descender, lineGap) in font units.
     * @returns {{ascender: number, descender: number, lineGap: number}}
     */
    fontExtents() {
        return this._font.hExtents();
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
        if (this._face) { this._face.destroy(); this._face = null; }
        if (this._blob) { this._blob.destroy(); this._blob = null; }
        this._hb = null;
        this._ready = false;
    }
}
