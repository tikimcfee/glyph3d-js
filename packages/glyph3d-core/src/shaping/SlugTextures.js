/**
 * SlugTextures — the GPU side of the Slug atlas: a SlugBuffer's two arrays as
 * THREE.DataTextures, kept in step with the buffer at the cost of what changed.
 *
 *   curveTexture    — 2 texels per curve: [P0.x,P0.y,P1.x,P1.y] [P2.x,P2.y,_,_]
 *   glyphMapTexture — 1 texel per glyph slot: [curveStart, curveCount, mode, emojiCell]
 *   (RGBA32Uint / usampler / texelFetch)
 *
 * Each texture wraps its array at the array's CAPACITY, so a glyph appended into spare rows
 * lands in the texture that already exists: `sync()` queues the touched texels as update
 * ranges (one per texture row — three's WebGL upload sends each range as a one-row
 * texSubImage2D) and every field keeps the texture object it holds. Only when the buffer
 * reallocated an array (it doubles when full) is that texture REBORN: a new object, uploaded
 * whole, which the caller hands to every field. The bytes each sync asks to upload are
 * counted in `stats`.
 *
 * A texture not yet uploaded queues nothing: its first upload sends the whole live array.
 * Ranges are cleared once the upload lands (`onUpdate`) — three's WebGL backend consumes them
 * itself; its WebGPU backend ignores them and uploads the texture whole.
 */

import * as THREE from 'three';
import { SlugBuffer } from './slugData.js';

const BYTES_PER_TEXEL = 16;   // RGBA × Uint32

export default class SlugTextures {
    /** @param {SlugBuffer} [buffer] - the backing arrays (a fresh, empty buffer by default) */
    constructor(buffer = new SlugBuffer()) {
        /** @private */ this._buffer = buffer;
        /** @type {THREE.DataTexture|null} */ this.curveTexture = null;
        /** @type {THREE.DataTexture|null} */ this.glyphMapTexture = null;
        /** @private the buffer generation each texture wraps */
        this._curveGen = -1;
        this._mapGen = -1;
        /** Upload accounting: bytes asked of the GPU, split by how. */
        this.stats = { syncs: 0, rangeBytes: 0, ranges: 0, rebornBytes: 0, reborn: 0 };
        this.sync();
    }

    /**
     * Hydrate from a serialized descriptor (the slug-core cache). Throws if the descriptor is
     * structurally invalid — the boot ladder catches and encodes instead.
     * @param {ReturnType<SlugBuffer['serialize']>} descriptor
     * @returns {SlugTextures}
     */
    static hydrate(descriptor) {
        return new SlugTextures(SlugBuffer.deserialize(descriptor));
    }

    /** @returns {SlugBuffer} */
    get buffer() { return this._buffer; }

    /** @returns {{ curveTexture: THREE.DataTexture, glyphMapTexture: THREE.DataTexture }} */
    get pair() { return { curveTexture: this.curveTexture, glyphMapTexture: this.glyphMapTexture }; }

    /**
     * Bring the textures up to the buffer. A reallocated array gets a new texture (`reborn`;
     * the old one is returned in `retired` for the caller to dispose once no field holds it);
     * otherwise the written spans are queued as update ranges on the texture every field
     * already holds.
     * @returns {{ reborn: boolean, bytes: number, retired: THREE.DataTexture[] }}
     */
    sync() {
        const buf = this._buffer;
        const dirty = buf.takeDirty();
        const retired = [];
        let reborn = false, bytes = 0;

        if (buf.curveGeneration !== this._curveGen) {
            if (this.curveTexture) retired.push(this.curveTexture);
            const c = buf.curveTexture();
            this.curveTexture = createSlugTexture(c.data, c.width, c.height);
            this._curveGen = buf.curveGeneration;
            bytes += c.data.byteLength; this.stats.rebornBytes += c.data.byteLength; this.stats.reborn++;
            reborn = true;
        } else if (dirty.curve) {
            bytes += this._queue(this.curveTexture, dirty.curve);
        }

        if (buf.mapGeneration !== this._mapGen) {
            if (this.glyphMapTexture) retired.push(this.glyphMapTexture);
            const g = buf.glyphMapTexture();
            this.glyphMapTexture = createSlugTexture(g.data, g.width, g.height);
            this._mapGen = buf.mapGeneration;
            bytes += g.data.byteLength; this.stats.rebornBytes += g.data.byteLength; this.stats.reborn++;
            reborn = true;
        } else if (dirty.map) {
            bytes += this._queue(this.glyphMapTexture, dirty.map);
        }

        this.stats.syncs++;
        return { reborn, bytes, retired };
    }

    /** @private queue the texel span [lo, hi) as one update range per texture row */
    _queue(texture, { lo, hi }) {
        if (!texture.userData.uploaded) return 0;   // the pending first upload sends it all
        const w = texture.image.width;
        for (let row = Math.floor(lo / w); row * w < hi; row++) {
            const s = Math.max(lo, row * w), e = Math.min(hi, (row + 1) * w);
            texture.addUpdateRange(s * 4, (e - s) * 4);
            this.stats.ranges++;
        }
        texture.needsUpdate = true;
        const bytes = (hi - lo) * BYTES_PER_TEXEL;
        this.stats.rangeBytes += bytes;
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
        this.curveTexture?.dispose();
        this.glyphMapTexture?.dispose();
    }
}

/**
 * A RGBA32Uint DataTexture over `data`, marking itself uploaded once its first upload lands.
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
    texture.userData.uploaded = false;
    texture.onUpdate = () => {
        texture.userData.uploaded = true;
        texture.clearUpdateRanges();   // WebGL consumed them already; WebGPU uploads whole
    };
    texture.needsUpdate = true;
    return texture;
}
