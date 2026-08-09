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
 * → UV is pure arithmetic in the shader, no per-glyph UV table needed. The grid GROWS
 * SQUARELY: when it fills, both cols and rows double (256 → 1024 → 4096 → 16384 cells),
 * so capacity quadruples per step and there's no fixed emoji limit — it holds every
 * standardized emoji + symbols with room to spare. Each emoji's cell INDEX is stable
 * (the monotonic counter), so the encoded core never changes; only its on-canvas
 * (col,row) layout moves on growth. The shader divides U by cols and V by rows. Growth
 * RE-CREATES the backing texture (the canvas resized — a needsUpdate re-copy into the
 * old-size GPUTexture garbles every cell past the old side), and the fields' next
 * setEmojiTexture re-fetches it, mirroring the live Slug atlas.
 *
 * Renderer-independent: the canvas + cell map are built with no Three.js; the
 * texture is created lazily once a THREE namespace is handed in.
 */

/** Atlas-canvas dimension cap. Square growth makes the texture AREA grow as side², so this sits
 *  WELL BELOW the browser's ~16384px hard limit to keep the worst-case texture bounded:
 *  9216 / 72px cells = a 128×128 grid = 16384 cells — far more than every standardized emoji +
 *  symbols (which realistically settles the atlas around 64² ≈ 4k cells). */
const MAX_ATLAS_DIM_PX = 9216;

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
     * Ensure an emoji codepoint has a cell, drawing it on first sight. Grows the atlas
     * SQUARELY when it fills, so there is no fixed emoji limit — only the (high) capacity
     * ceiling (~16k cells), well past every standardized emoji.
     * @param {number} codepoint
     * @returns {number} cell index, or -1 only if there's no canvas (headless) or the
     *   capacity ceiling is hit (then the glyph falls back to a mono outline).
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
     * Grow capacity by doubling the side — SQUARE growth, so capacity quadruples per step
     * (256 → 1024 → 4096 → 16384 cells) and we exhaust 2D area instead of just height.
     * The cell INDEX per emoji is unchanged (it's the monotonic `_next`); only its canvas
     * (col,row) = (idx % cols, idx / cols) moves, so the encoded core never changes — but
     * resizing the canvas clears it, so every cell is re-laid-out + repainted at the new
     * cols. The shader divides U by cols and V by rows, so a square grid Just Works. Capped
     * at MAX_ATLAS_DIM_PX. Rare: only when a new emoji crosses the current capacity. The
     * backing texture re-uploads on the next setEmojiTexture.
     * @private
     * @returns {boolean} whether it actually grew
     */
    _grow() {
        const maxSide = Math.max(this.cols, Math.floor(MAX_ATLAS_DIM_PX / this.cellPx));
        if (this.cols >= maxSide) return false;
        const prev = this.cols;
        const side = Math.min(this.cols * 2, maxSide);
        this.cols = side;
        this.rows = side;                                // stay SQUARE — area grows, not just height
        const px = this.cellPx * side;
        this._canvas.width  = px;
        this._canvas.height = px;                        // resize → CLEARS the canvas + resets ctx state
        this._ctx.textAlign = 'center';
        this._ctx.textBaseline = 'middle';
        for (const [cp, idx] of this._byCp) this._draw(cp, idx);   // re-lay-out + repaint at the new cols
        // The canvas RESIZED, so the GPUTexture must be BORN again, not updated:
        // three's WebGPU backend creates the texture once (at first-bind size) and
        // needsUpdate only re-copies into it — a copy from a larger canvas into a
        // smaller GPUTexture clips/garbles every cell past the old side (the
        // "wrong emoji everywhere after the 1024th sighting" bug). Dispose + null
        // forces the next getTexture() to create a fresh CanvasTexture at the new
        // size; every field re-fetches it in setEmojiTexture (the miss-flow's
        // _refreshEmojiTextures reaches all registered fields).
        if (this._texture) {
            this._texture.dispose();
            this._texture = null;
        }
        console.log(`[EmojiAtlas] grew ${prev}²→${side}² grid (${this.capacity} cells)`);
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
