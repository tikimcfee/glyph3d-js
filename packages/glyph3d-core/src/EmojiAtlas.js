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
 * → UV is pure arithmetic in the shader, no per-glyph UV table needed. cols is FIXED
 * and rows GROW: when the grid fills, it doubles its row count (taller canvas), so the
 * cell→(col,row) mapping never moves and there's no fixed emoji limit — only the
 * browser canvas-size ceiling (thousands of cells). The shader divides U by cols and
 * V by rows (the grid is non-square once it has grown). Growth re-uploads the backing
 * texture (rare — only on first sighting of an emoji past capacity), mirroring the live
 * Slug atlas.
 *
 * Renderer-independent: the canvas + cell map are built with no Three.js; the
 * texture is created lazily once a THREE namespace is handed in.
 */

/** Browser 2D-canvas dimension ceiling — rows stop growing before the canvas would exceed it. */
const MAX_CANVAS_PX = 16384;

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
     * Ensure an emoji codepoint has a cell, drawing it on first sight. Grows the
     * atlas (more rows) when it fills, so there is no fixed emoji limit — only the
     * browser canvas-size ceiling (thousands of cells).
     * @param {number} codepoint
     * @returns {number} cell index, or -1 only if there's no canvas (headless) or the
     *   canvas-size ceiling is hit (then the glyph falls back to a mono outline).
     */
    ensure(codepoint) {
        let idx = this._byCp.get(codepoint);
        if (idx !== undefined) return idx;
        if (!this._ctx) return -1;                                  // no canvas → can't rasterize
        if (this._next >= this.capacity && !this._grow()) return -1; // full AND at the size ceiling
        idx = this._next++;
        this._draw(codepoint, idx);
        this._byCp.set(codepoint, idx);
        this._dirty = true;
        return idx;
    }

    /**
     * Grow capacity by doubling ROWS — cols stays fixed, so every cell's
     * (col = idx % cols, row = idx / cols) mapping is unchanged and only the canvas
     * height grows. Resizing the canvas clears it, so existing cells are repainted.
     * Capped at the browser canvas-size ceiling. Rare: only when a new emoji crosses
     * the current capacity. The backing texture re-uploads on the next setEmojiTexture
     * (driven by the same growth that grew the live Slug atlas).
     * @private
     * @returns {boolean} whether it actually grew
     */
    _grow() {
        const maxRows = Math.max(this.cols, Math.floor(MAX_CANVAS_PX / this.cellPx));
        if (this.rows >= maxRows) return false;
        const prevRows = this.rows;
        this.rows = Math.min(this.rows * 2, maxRows);
        this._canvas.height = this.cellPx * this.rows;   // resize → CLEARS the canvas + resets ctx state
        this._ctx.textAlign = 'center';
        this._ctx.textBaseline = 'middle';
        for (const [cp, idx] of this._byCp) this._draw(cp, idx);   // repaint existing cells
        if (this._texture) this._texture.needsUpdate = true;
        console.log(`[EmojiAtlas] grew ${prevRows}→${this.rows} rows (${this.capacity} cells)`);
        return true;
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
