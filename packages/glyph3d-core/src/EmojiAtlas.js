/**
 * EmojiAtlas — a color-bitmap atlas for emoji.
 *
 * Slug renders monochrome bezier OUTLINES. Color emoji fonts (NotoColorEmoji on this box) are
 * CBDT/CBLC bitmaps with no outlines, so Slug can't touch them. But the browser can: Canvas2D
 * `fillText('🎉')` rasterizes full-color emoji via the platform emoji font. This class keeps a
 * grid of fixed square cells, one emoji each, as one RGBA texture; the glyph shader samples a
 * cell for any glyph flagged "bitmap mode" (see InstancedField + FontChain) instead of running
 * the bezier-coverage path.
 *
 * Cell index → (col, row) → UV is pure arithmetic in the shader (it divides U by cols and V by
 * rows), so no per-glyph UV table. A cell's INDEX is allocated synchronously on first sight
 * (`ensure`, the monotonic counter the slug core and the bake's stub agree on); its PIXELS
 * arrive later:
 *
 *   raster   the codepoints sighted in one task go to EmojiRasterWorker as one run of
 *            consecutive cells; it draws them with an OffscreenCanvas and answers with the
 *            band of pixel rows they occupy. Until it lands a cell is transparent (the shader
 *            draws only the cell's background).
 *   upload   the pixels live in a CPU array the texture wraps (a DataTexture); a landed run is
 *            copied in and only its pixel rows are queued as update ranges — the texture
 *            object stays, nothing re-uploads whole.
 *   growth   the column count is FIXED, so a cell never moves; when the cells run out the rows
 *            grow (×EMOJI_ATLAS.rowGrowth, up to MAX_ATLAS_DIM_PX tall): the array is
 *            reallocated with the old one as its prefix and the texture is reborn at the new
 *            size — the one case every field rebinds (the 'replaced' event).
 *
 * Listeners (`onChange`) hear { kind: 'rasterized', cells, codepoints } when a run's pixels are
 * in, and { kind: 'replaced' } when the texture was reborn. With no rasterizer (no Worker or no
 * OffscreenCanvas — a headless run) `ensure` returns -1 and emoji fall back to outlines.
 */

import WorkerRpc from './workers/WorkerRpc.js';

/** Atlas height cap. Well below the browser's ~16384px limit to keep the texture bounded:
 *  9216 / 72px cells = 128 rows × EMOJI_ATLAS.cols. */
const MAX_ATLAS_DIM_PX = 9216;

/**
 * The atlas's shape, born configurable (constructor options override each).
 *   cellPx     pixel size of a square cell
 *   cols       cells per row — fixed for the atlas's life, so cells never move
 *   rows       rows the atlas is born with (cols × rows cells)
 *   rowGrowth  factor the rows grow by when the cells run out
 * 48 × 72 px = a 3456 px wide texture. The core's ~900 boot emoji grow it to 24 rows before
 * any texture exists (a growth before the first getTexture costs one array copy).
 */
export const EMOJI_ATLAS = Object.freeze({ cellPx: 72, cols: 48, rows: 16, rowGrowth: 1.5 });

/** The worker-backed rasterizer, where this environment can run one. */
function defaultRasterizer() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    const rpc = new WorkerRpc(
        new Worker(new URL('./workers/EmojiRasterWorker.js', import.meta.url), { type: 'module' }),
        'EmojiRasterWorker',
    );
    return {
        raster: (req) => rpc.request({ type: 'raster', ...req }),
        dispose: () => rpc.dispose(),
    };
}

/**
 * @typedef {Object} EmojiRasterizer
 * @property {(req:{cps:Uint32Array, firstIdx:number, cols:number, cellPx:number, fontFamily:string}) =>
 *   Promise<{row0:number, rows:number, col0:number, wCells:number, band:Uint8Array|Uint8ClampedArray}>} raster
 * @property {() => void} dispose
 */

export default class EmojiAtlas {
    /**
     * @param {Object} [options]
     * @param {number} [options.cellPx]     pixel size of each square cell
     * @param {number} [options.cols]       cells per row (fixed)
     * @param {number} [options.rows]       rows to start with
     * @param {number} [options.rowGrowth]  row growth factor when full
     * @param {string} [options.fontFamily] CSS emoji font stack
     * @param {EmojiRasterizer|null} [options.rasterizer] who draws cells (default: the worker;
     *   null = none, every `ensure` answers -1)
     */
    constructor(options = {}) {
        this.cellPx = options.cellPx ?? EMOJI_ATLAS.cellPx;
        this.cols = options.cols ?? EMOJI_ATLAS.cols;
        this.rows = options.rows ?? EMOJI_ATLAS.rows;
        this.rowGrowth = options.rowGrowth ?? EMOJI_ATLAS.rowGrowth;
        this.maxRows = Math.max(this.rows, Math.floor(MAX_ATLAS_DIM_PX / this.cellPx));
        this.fontFamily = options.fontFamily
            || '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji","Twemoji Mozilla",sans-serif';

        /** @private @type {EmojiRasterizer|null} */
        this._rasterizer = options.rasterizer !== undefined ? options.rasterizer : defaultRasterizer();
        /** @private codepoint → cell index */
        this._byCp = new Map();
        /** @private next free cell */
        this._next = 0;
        /** @private the atlas pixels (RGBA, row-major, cols·cellPx wide) — the texture's backing */
        this._pixels = this._rasterizer ? new Uint8Array(this.widthPx * this.heightPx * 4) : null;
        /** @private cells allocated but not yet sent to the rasterizer (one consecutive run) */
        this._queued = [];
        /** @private */ this._flushScheduled = false;
        /** @private raster runs awaiting the worker */ this._inFlight = 0;
        /** @private resolvers waiting for the atlas to go quiet */ this._idleWaiters = [];
        /** @private THREE namespace + the texture, created lazily by getTexture */
        this._THREE = null;
        this._texture = null;
        /** @private */ this._listeners = new Set();
        /** Upload accounting: bytes queued as ranges, and whole-texture rebirths. */
        this.stats = { rasterRuns: 0, rasterCells: 0, rangeBytes: 0, ranges: 0, reborn: 0, rasterMs: 0 };
    }

    /** @returns {number} total cells (cols × rows) */
    get capacity() { return this.cols * this.rows; }
    /** @returns {number} number of emoji with a cell */
    get size() { return this._byCp.size; }
    get widthPx() { return this.cols * this.cellPx; }
    get heightPx() { return this.rows * this.cellPx; }
    /** @returns {number} cells whose pixels are still being drawn */
    get pending() { return this._queued.length + this._inFlight; }

    /** @param {number} cp @returns {boolean} */
    has(cp) { return this._byCp.has(cp); }

    /**
     * Listen for landed pixels ({ kind: 'rasterized', cells, codepoints }) and texture rebirths
     * ({ kind: 'replaced' }).
     * @param {(e:{kind:string, cells?:number[], codepoints?:number[]}) => void} cb
     * @returns {() => void} unsubscribe
     */
    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    /**
     * The cell for an emoji codepoint, allocated on first sight (its pixels are drawn off the
     * main thread and land later). Grows the rows when the cells run out.
     * @param {number} codepoint
     * @returns {number} cell index, or -1 with no rasterizer or at the size ceiling (the glyph
     *   then falls back to a mono outline)
     */
    ensure(codepoint) {
        let idx = this._byCp.get(codepoint);
        if (idx !== undefined) return idx;
        if (!this._rasterizer) return -1;
        if (this._next >= this.capacity && !this._grow()) return -1;
        idx = this._next++;
        this._byCp.set(codepoint, idx);
        this._queued.push(codepoint);
        if (!this._flushScheduled) {
            this._flushScheduled = true;
            queueMicrotask(() => this._flush());
        }
        return idx;
    }

    /**
     * Resolves once every allocated cell's pixels have landed.
     * @returns {Promise<void>}
     */
    whenIdle() {
        if (this.pending === 0) return Promise.resolve();
        return new Promise((res) => this._idleWaiters.push(res));
    }

    /**
     * Grow the rows (cols stay, so no cell moves): reallocate the pixels with the old array
     * as the prefix and rebirth the texture at the new size.
     * @private
     * @returns {boolean} whether it grew
     */
    _grow() {
        if (this.rows >= this.maxRows) return false;
        const prev = this.rows;
        this.rows = Math.min(this.maxRows, Math.max(prev + 1, Math.ceil(prev * this.rowGrowth)));
        const grown = new Uint8Array(this.widthPx * this.heightPx * 4);
        grown.set(this._pixels);
        this._pixels = grown;
        if (this._texture) {
            const old = this._texture;
            this._texture = this._makeTexture();
            this.stats.reborn++;
            this._emit({ kind: 'replaced' });   // every field rebinds to the new texture …
            old.dispose();                      // … so the old one is free
        }
        console.log(`[EmojiAtlas] grew ${this.cols}×${prev} → ${this.cols}×${this.rows} cells (${this.capacity})`);
        return true;
    }

    /** @private send the queued run to the rasterizer */
    _flush() {
        this._flushScheduled = false;
        const cps = Uint32Array.from(this._queued);
        this._queued.length = 0;
        if (cps.length === 0 || !this._rasterizer) return;
        const firstIdx = this._byCp.get(cps[0]);
        this._inFlight += cps.length;
        const t0 = performance.now();
        this._rasterizer.raster({ cps, firstIdx, cols: this.cols, cellPx: this.cellPx, fontFamily: this.fontFamily })
            .then((res) => {
                this.stats.rasterMs += performance.now() - t0;
                this._land(firstIdx, cps, res);
            })
            .catch((err) => {
                console.error(`[EmojiAtlas] raster of ${cps.length} cell(s) from #${firstIdx} failed: ${err.message} — they stay transparent`);
            })
            .finally(() => {
                this._inFlight -= cps.length;
                if (this.pending === 0) for (const res of this._idleWaiters.splice(0)) res();
            });
    }

    /**
     * Copy a rasterized run into the pixels and queue its pixel rows for upload.
     * @private
     */
    _land(firstIdx, cps, { row0, rows, col0, wCells, band }) {
        if (!this._pixels) return;   // disposed while in flight
        const cell = this.cellPx, cols = this.cols;
        const last = firstIdx + cps.length - 1;
        const atlasStride = this.widthPx * 4;
        const bandStride = wCells * cell * 4;
        const tex = this._texture && this._texture.userData.uploaded ? this._texture : null;
        const src = band instanceof Uint8Array ? band : new Uint8Array(band.buffer, band.byteOffset, band.byteLength);
        for (let r = 0; r < rows; r++) {
            const R = row0 + r;
            const cA = R === row0 ? firstIdx % cols : 0;
            const cB = R === Math.floor(last / cols) ? last % cols : cols - 1;
            const xBytes = cA * cell * 4, lenBytes = (cB - cA + 1) * cell * 4;
            const bandX = (cA - col0) * cell * 4;
            if (lenBytes === atlasStride && bandStride === atlasStride) {
                // a whole cell row: one contiguous copy
                const s = r * cell * bandStride;
                this._pixels.set(src.subarray(s, s + cell * bandStride), R * cell * atlasStride);
            } else {
                for (let y = 0; y < cell; y++) {
                    const s = (r * cell + y) * bandStride + bandX;
                    this._pixels.set(src.subarray(s, s + lenBytes), (R * cell + y) * atlasStride + xBytes);
                }
            }
            if (tex) {
                for (let y = 0; y < cell; y++) tex.addUpdateRange((R * cell + y) * atlasStride + xBytes, lenBytes);
                this.stats.ranges += cell;
                this.stats.rangeBytes += cell * lenBytes;
            }
        }
        if (tex) tex.needsUpdate = true;
        this.stats.rasterRuns++;
        this.stats.rasterCells += cps.length;
        const cells = new Array(cps.length);
        for (let i = 0; i < cps.length; i++) cells[i] = firstIdx + i;
        this._emit({ kind: 'rasterized', cells, codepoints: Array.from(cps) });
    }

    /** @private */
    _emit(e) {
        for (const cb of this._listeners) {
            try { cb(e); } catch (err) { console.error('[EmojiAtlas] listener failed:', err); }
        }
    }

    /** @private a DataTexture over the current pixels, marking itself uploaded once it is */
    _makeTexture() {
        const THREE = this._THREE;
        const t = new THREE.DataTexture(this._pixels, this.widthPx, this.heightPx, THREE.RGBAFormat, THREE.UnsignedByteType);
        // colorSpace unmanaged: the pixels are sRGB-encoded display values, and the glyph
        // fragment decodes to linear by hand (pow 2.2) exactly like the Slug path. Row 0 of the
        // pixels is the cell grid's top row, read at v = 0 (flipY off), the top-left origin the
        // rest of the glyph pipeline assumes. The pixels are straight (not premultiplied) alpha.
        t.colorSpace = THREE.NoColorSpace;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        t.flipY = false;
        t.premultiplyAlpha = false;
        t.userData.uploaded = false;
        t.onUpdate = () => {
            t.userData.uploaded = true;
            t.clearUpdateRanges();   // WebGL consumed them already; WebGPU uploads whole
        };
        t.needsUpdate = true;
        return t;
    }

    /**
     * The RGBA texture backing the atlas, created on first ask (it needs the THREE namespace).
     * Null with no rasterizer.
     * @param {typeof import('three')} THREE
     * @returns {import('three').DataTexture|null}
     */
    getTexture(THREE) {
        if (!this._pixels) return null;
        if (!this._texture) {
            this._THREE = THREE;
            this._texture = this._makeTexture();
        }
        return this._texture;
    }

    /** Release the texture, the pixels and the rasterizer's worker. */
    dispose() {
        this._texture?.dispose();
        this._texture = null;
        this._rasterizer?.dispose();
        this._rasterizer = null;
        this._byCp.clear();
        this._pixels = null;
        this._listeners.clear();
    }
}
