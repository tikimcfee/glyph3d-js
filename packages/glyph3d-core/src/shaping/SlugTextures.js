/**
 * SlugTextures — the GPU side of the Slug atlas: a SlugBuffer's two arrays as
 * THREE.DataTextures, kept in step with the buffer at the cost of what changed.
 *
 *   curveTexture    — 2 texels per curve: [P0.x,P0.y,P1.x,P1.y] [P2.x,P2.y,_,_]
 *   glyphMapTexture — 1 texel per glyph slot: [curveStart, curveCount, mode, emojiCell]
 *   (RGBA32Uint / usampler / texelFetch)
 *
 * Each texture wraps its array at the array's CAPACITY, so a glyph appended into spare rows
 * lands in the texture that already exists: `sync()` queues the touched texel span on the
 * atlas's TextureUploads (at most three rectangles: a row's tail, whole rows, a row's head) and
 * every field keeps the texture object it holds. Only when the buffer reallocated an array (it
 * doubles when full) is that texture REBORN: a new object the caller hands to every field, whose
 * old rows are copied GPU-side from the texture it replaces (TextureUploads.grow) — no byte of
 * them crosses the bus again. The bytes each sync asks to upload are counted in `stats`.
 *
 * A texture three hasn't uploaded yet queues nothing: its first upload sends the live array.
 */

import * as THREE from 'three';
import { SlugBuffer } from './slugData.js';

export default class SlugTextures {
    /**
     * @param {import('../core/TextureUploads.js').default} uploads - the queue the renderer flushes
     * @param {SlugBuffer} [buffer] - the backing arrays (a fresh, empty buffer by default)
     */
    constructor(uploads, buffer = new SlugBuffer()) {
        if (!uploads) throw new Error('[SlugTextures] needs the atlas\'s TextureUploads (the renderer seam flushes it)');
        /** @private */ this._uploads = uploads;
        /** @private */ this._buffer = buffer;
        /** @type {THREE.DataTexture|null} */ this.curveTexture = null;
        /** @type {THREE.DataTexture|null} */ this.glyphMapTexture = null;
        /** @private the buffer generation each texture wraps */
        this._curveGen = -1;
        this._mapGen = -1;
        /** Upload accounting: bytes queued as rects (and the rects), and rebirths (whose old rows the GPU copies). */
        this.stats = { syncs: 0, rectBytes: 0, rects: 0, reborn: 0 };
        this.sync();
    }

    /**
     * Hydrate from a serialized descriptor (the slug-core cache). Throws if the descriptor is
     * structurally invalid — the boot ladder catches and encodes instead.
     * @param {import('../core/TextureUploads.js').default} uploads
     * @param {ReturnType<SlugBuffer['serialize']>} descriptor
     * @returns {SlugTextures}
     */
    static hydrate(uploads, descriptor) {
        return new SlugTextures(uploads, SlugBuffer.deserialize(descriptor));
    }

    /** @returns {SlugBuffer} */
    get buffer() { return this._buffer; }

    /** @returns {{ curveTexture: THREE.DataTexture, glyphMapTexture: THREE.DataTexture }} */
    get pair() { return { curveTexture: this.curveTexture, glyphMapTexture: this.glyphMapTexture }; }

    /**
     * Bring the textures up to the buffer. A reallocated array gets a new texture (`reborn`) that
     * the caller hands to every field; the old one is copied into it GPU-side and disposed by the
     * uploads queue. Otherwise the written span is queued on the texture every field already holds.
     * @returns {{ reborn: boolean, bytes: number }} bytes = what this sync queued to cross the bus
     */
    sync() {
        const buf = this._buffer;
        const dirty = buf.takeDirty();
        let reborn = false, bytes = 0;

        if (buf.curveGeneration !== this._curveGen) {
            this.curveTexture = this._born(this.curveTexture, buf.curveTexture());
            this._curveGen = buf.curveGeneration;
            reborn = true;
        }
        if (dirty.curve) bytes += this._queue(this.curveTexture, dirty.curve);

        if (buf.mapGeneration !== this._mapGen) {
            this.glyphMapTexture = this._born(this.glyphMapTexture, buf.glyphMapTexture());
            this._mapGen = buf.mapGeneration;
            reborn = true;
        }
        if (dirty.map) bytes += this._queue(this.glyphMapTexture, dirty.map);

        this.stats.syncs++;
        return { reborn, bytes };
    }

    /** @private a texture over a (re)allocated array: grown from `prev` when there is one */
    _born(prev, { data, width, height }) {
        const t = createSlugTexture(data, width, height);
        this.stats.reborn += prev ? 1 : 0;
        return prev ? this._uploads.grow(prev, t) : this._uploads.adopt(t);
    }

    /** @private queue the texel span [lo, hi) — nothing while the texture's first upload is pending */
    _queue(texture, { lo, hi }) {
        const before = this._uploads.stats.rects;
        const bytes = this._uploads.span(texture, lo, hi);
        this.stats.rects += this._uploads.stats.rects - before;
        this.stats.rectBytes += bytes;
        return bytes;
    }

    /** Stats for logs and probes. */
    describe() {
        const buf = this._buffer;
        return {
            glyphCount: buf.size,
            totalCurves: buf.totalCurves,
            curveTextureSizeKB: +(this.curveTexture.image.data.byteLength / 1024).toFixed(2),
            glyphMapTextureSizeKB: +(this.glyphMapTexture.image.data.byteLength / 1024).toFixed(2),
        };
    }

    dispose() {
        for (const t of [this.curveTexture, this.glyphMapTexture]) {
            if (!t) continue;
            this._uploads.forget(t);
            t.dispose();
        }
    }
}

/**
 * A RGBA32Uint DataTexture over `data` (the uploads queue marks its upload state).
 * @param {Uint32Array} data @param {number} width @param {number} height
 * @returns {THREE.DataTexture}
 */
function createSlugTexture(data, width, height) {
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    // No internalFormat string: that's a WebGL2 hint, and the WebGPU backend passes it
    // through verbatim as a GPUTextureFormat (invalid). Let three derive RGBA32Uint from
    // RGBAIntegerFormat + UnsignedIntType.
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return texture;
}
