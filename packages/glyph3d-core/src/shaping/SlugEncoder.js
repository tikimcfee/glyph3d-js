/**
 * SlugEncoder — wraps a growable SlugBuffer in THREE.DataTextures.
 *
 * SlugBuffer (slugData.js) does the GPU-agnostic typed-array packing; this wraps its current
 * data in THREE.DataTexture instances for the render path. The encoder is STATEFUL and long-
 * lived (LiveSlugAtlas keeps one per shaper):
 *
 *   encode(glyphIds)       — from scratch: reset the buffer, add all, build textures.
 *                            (boot encode + validation)
 *   appendGlyphs(glyphIds) — incremental: add only the not-yet-seen glyphs, rebuild textures.
 *                            Each glyph is extracted EXACTLY ONCE across the encoder's life —
 *                            no full re-encode on atlas growth.
 *
 * Two output textures (RGBA32Uint / usampler / texelFetch):
 *   curveTexture    — 2 texels per curve: [P0.x,P0.y,P1.x,P1.y] [P2.x,P2.y,_,_]
 *   glyphMapTexture — 1 texel per glyph slot: [curveStart, curveCount, mode, emojiCell]
 *
 * Main-thread only — workers do shaping + instance-attribute packing, never slug curves.
 */

import * as THREE from 'three';
import { SlugBuffer } from './slugData.js';

export default class SlugEncoder {
    /**
     * @param {import('./HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     */
    constructor(shaper) {
        /** @private */ this._shaper = shaper;
        /** @private growable accumulator — encode() resets it, appendGlyphs() grows it */
        this._buffer = new SlugBuffer();
        /** @private last build, returned for no-op appends */
        this._lastTextures = null;
    }

    /** @returns {number} distinct glyph IDs currently encoded */
    get size() { return this._buffer.size; }

    /**
     * Encode a set of glyph IDs FROM SCRATCH into two GPU-ready DataTextures (resets the
     * accumulator first). Used for the initial boot encode and validation.
     *
     * @param {Set<number>|Array<number>} glyphIds
     * @returns {{ curveTexture: THREE.DataTexture, glyphMapTexture: THREE.DataTexture, stats: object }}
     */
    encode(glyphIds) {
        const t0 = performance.now();
        this._buffer.reset();
        this._buffer.addGlyphs(this._shaper, glyphIds);
        const out = this._buildTextures();
        console.log(
            `[SlugEncoder] encoded ${out.stats.glyphCount} glyphs, ` +
            `${out.stats.totalCurves} curves (${out.stats.curveTextureSizeKB}KB) ` +
            `in ${(performance.now() - t0).toFixed(1)}ms`
        );
        return out;
    }

    /**
     * Incrementally encode only the not-yet-seen glyphs (each extracted EXACTLY ONCE) and
     * rebuild the textures. Returns the textures + { added, grew } so the caller can skip the
     * hot-swap when nothing changed.
     *
     * @param {Iterable<number>} glyphIds
     * @returns {{ curveTexture, glyphMapTexture, stats, added: number, addedIds: number[], grew: boolean }}
     */
    appendGlyphs(glyphIds) {
        const { added, addedIds } = this._buffer.addGlyphs(this._shaper, glyphIds);
        if (added === 0) return { ...(this._lastTextures || this._buildTextures()), added: 0, addedIds: [], grew: false };
        return { ...this._buildTextures(), added, addedIds, grew: true };
    }

    /** @private Wrap the accumulator's current views in DataTextures + stats. */
    _buildTextures() {
        const c = this._buffer.curveTexture();
        const g = this._buffer.glyphMapTexture();
        const curveTexture    = this._createSlugTexture(c.data, c.width, c.height);
        const glyphMapTexture = this._createSlugTexture(g.data, g.width, g.height);
        const stats = {
            glyphCount: this._buffer.size,
            totalCurves: this._buffer.totalCurves,
            curveTextureSizeKB: +(c.data.byteLength / 1024).toFixed(2),
            glyphMapTextureSizeKB: +(g.data.byteLength / 1024).toFixed(2),
        };
        this._lastTextures = { curveTexture, glyphMapTexture, stats };
        return this._lastTextures;
    }

    /**
     * Create a RGBA32Uint DataTexture for Slug rendering.
     * @private
     * @param {Uint32Array} data @param {number} width @param {number} height
     * @returns {THREE.DataTexture}
     */
    _createSlugTexture(data, width, height) {
        const texture = new THREE.DataTexture(
            data,
            width,
            height,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType
        );
        // No internalFormat string: that's a WebGL2 hint, and the WebGPU backend passes it
        // through verbatim as a GPUTextureFormat (invalid). Let three derive RGBA32Uint from
        // RGBAIntegerFormat + UnsignedIntType.
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        return texture;
    }
}
