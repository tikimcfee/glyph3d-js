/**
 * EmojiAtlas — a Canvas2D color-bitmap atlas for emoji.
 *
 * Slug renders monochrome bezier OUTLINES. Color emoji fonts (NotoColorEmoji on
 * this box) are CBDT/CBLC bitmaps with no outlines, so Slug can't touch them.
 * But the browser can: Canvas2D `fillText('🎉')` rasterizes full-color emoji via
 * the platform emoji font for free. This class draws each emoji into a fixed-cell
 * grid on a 2D canvas and exposes it as one RGBA texture; the glyph shader samples
 * a cell for any glyph flagged "bitmap mode" (see GlyphField + FontChain), instead
 * of running the bezier-coverage path.
 *
 * Fixed square cells (not shelf-packed): one emoji per cell, cell index → (col,row)
 * → UV is pure arithmetic in the shader, no per-glyph UV table needed. Grows by
 * appending cells; the backing texture is re-uploaded on growth (rare — only on
 * first sighting of a new emoji), mirroring the live Slug atlas.
 *
 * Renderer-independent: the canvas + cell map are built with no Three.js; the
 * texture is created lazily once a THREE namespace is handed in.
 */

export default class EmojiAtlas {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.cellPx=72]  Pixel size of each square cell.
     * @param {number} [opts.cols=16]    Cells per row (cols×cols capacity).
     * @param {string} [opts.fontFamily] CSS emoji font stack.
     */
    constructor({ cellPx = 72, cols = 16, fontFamily } = {}) {
        this.cellPx = cellPx;
        this.cols = cols;
        this.rows = cols; // square grid → cols*cols capacity
        this.fontFamily = fontFamily
            || '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji","Twemoji Mozilla",sans-serif';

        /** @private codepoint → cell index */
        this._byCp = new Map();
        /** @private next free cell */
        this._next = 0;
        /** @private set on draw, cleared by checkAndClearDirty() */
        this._dirty = false;

        const px = this.cellPx * this.cols;
        this._canvas = (typeof document !== 'undefined')
            ? document.createElement('canvas')
            : null;
        if (this._canvas) {
            this._canvas.width = px;
            this._canvas.height = px;
            this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
            this._ctx.textAlign = 'center';
            this._ctx.textBaseline = 'middle';
        }
        /** @private THREE.CanvasTexture, lazily created */
        this._texture = null;
    }

    /** @returns {number} total cells (cols²) */
    get capacity() { return this.cols * this.rows; }

    /** @returns {number} number of emoji drawn so far */
    get size() { return this._byCp.size; }

    /** @param {number} cp @returns {boolean} */
    has(cp) { return this._byCp.has(cp); }

    /**
     * Ensure an emoji codepoint has a cell, drawing it on first sight.
     * @param {number} codepoint
     * @returns {number} cell index, or -1 if the atlas is full or has no canvas.
     */
    ensure(codepoint) {
        let idx = this._byCp.get(codepoint);
        if (idx !== undefined) return idx;
        if (!this._ctx || this._next >= this.capacity) return -1;
        idx = this._next++;
        this._draw(codepoint, idx);
        this._byCp.set(codepoint, idx);
        this._dirty = true;
        return idx;
    }

    /** @private draw one emoji centered in its cell */
    _draw(codepoint, idx) {
        const col = idx % this.cols;
        const row = (idx / this.cols) | 0;
        const x = col * this.cellPx;
        const y = row * this.cellPx;
        const ctx = this._ctx;
        ctx.clearRect(x, y, this.cellPx, this.cellPx);
        // 0.82 leaves a little padding so bilinear sampling at the cell edge doesn't
        // bleed a neighbour in. Emoji metrics vary; centered baseline is the robust default.
        ctx.font = `${Math.round(this.cellPx * 0.82)}px ${this.fontFamily}`;
        ctx.fillText(String.fromCodePoint(codepoint), x + this.cellPx / 2, y + this.cellPx / 2);
    }

    /**
     * Lazily create / return the RGBA texture backing the atlas canvas.
     * colorSpace is left unmanaged: the canvas holds sRGB-encoded display pixels,
     * and the glyph fragment decodes to linear by hand (pow 2.2) exactly like the
     * Slug path, so three must not also inject a decode. flipY=false to match the
     * WebGPU top-left origin the rest of the glyph pipeline assumes.
     * @param {typeof import('three')} THREE
     * @returns {import('three').CanvasTexture|null}
     */
    getTexture(THREE) {
        if (!this._canvas) return null;
        if (!this._texture) {
            this._texture = new THREE.CanvasTexture(this._canvas);
            this._texture.colorSpace = THREE.NoColorSpace;
            this._texture.minFilter = THREE.LinearFilter;
            this._texture.magFilter = THREE.LinearFilter;
            this._texture.generateMipmaps = false;
            this._texture.flipY = false;
            this._texture.premultiplyAlpha = false;
            this._texture.needsUpdate = true;
        }
        return this._texture;
    }

    /**
     * Whether the canvas changed since the last call (a new emoji was drawn). The
     * caller flags `texture.needsUpdate` so the GPU copy is refreshed.
     * @returns {boolean}
     */
    checkAndClearDirty() {
        const d = this._dirty;
        this._dirty = false;
        return d;
    }
}
