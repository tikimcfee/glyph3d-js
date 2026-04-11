/**
 * SlugEncoder — Wraps GPU-agnostic slug buffer packing in THREE.DataTextures
 *
 * Delegates all typed-array computation to buildSlugBuffers() (slugData.js),
 * then wraps the returned Uint16Arrays in THREE.DataTexture instances for the
 * existing WebGL render path.
 *
 * Three output textures:
 *   curveTexture    — 2 texels per curve: [P0.x, P0.y, P1.x, P1.y] [P2.x, P2.y, _, _]
 *   bandTexture     — flat layout: band headers [curveTexelOffset, curveCount, _, _]
 *                     followed by curve entries [curveIndex, _, _, _] per band
 *   glyphMapTexture — 1 texel per glyph: [curveStart, curveCount, bandHeaderStart, bandCount]
 *
 * All coordinates normalized to [0,1] then packed as uint16 (0-65535).
 * All textures use RGBA16UI / usampler2D / texelFetch.
 *
 * Runs on the main thread, once per font load, before any rendering begins.
 * Workers never touch SlugEncoder — they only do shaping + buffer packing.
 */

import * as THREE from 'three';
import { buildSlugBuffers } from './slugData.js';

export default class SlugEncoder {
    /**
     * @param {import('./HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     */
    constructor(shaper) {
        /** @private */
        this._shaper = shaper;
    }

    /**
     * Encode a set of glyph IDs into three GPU-ready DataTextures.
     *
     * @param {Set<number>|Array<number>} glyphIds - Glyph IDs to encode
     * @returns {{
     *   curveTexture: THREE.DataTexture,
     *   bandTexture: THREE.DataTexture,
     *   glyphMapTexture: THREE.DataTexture,
     *   stats: {
     *     glyphCount: number,
     *     totalCurves: number,
     *     totalBandEntries: number,
     *     curveTextureSizeKB: number,
     *     bandTextureSizeKB: number,
     *     glyphMapTextureSizeKB: number
     *   }
     * }}
     */
    encode(glyphIds) {
        const startTime = performance.now();

        // Phases 1-3: pure typed-array computation, no THREE dependency
        const {
            curveData,
            bandData,
            glyphMapData,
            curveTexWidth,
            curveTexHeight,
            bandTexWidth,
            bandTexHeight,
            glyphMapTexWidth,
            glyphMapTexHeight,
            stats,
        } = buildSlugBuffers(this._shaper, glyphIds);

        // Phase 4: wrap typed arrays in THREE.DataTexture for the WebGL path
        const curveTexture    = this._createSlugTexture(curveData,    curveTexWidth,    curveTexHeight);
        const bandTexture     = this._createSlugTexture(bandData,     bandTexWidth,     bandTexHeight);
        const glyphMapTexture = this._createSlugTexture(glyphMapData, glyphMapTexWidth, glyphMapTexHeight);

        const totalKB = +(stats.curveTextureSizeKB + stats.bandTextureSizeKB + stats.glyphMapTextureSizeKB).toFixed(2);
        const elapsed = (performance.now() - startTime).toFixed(1);

        console.log(
            `[SlugEncoder] Textures built: ` +
            `curves=${stats.totalCurves * 2} texels (${stats.curveTextureSizeKB}KB), ` +
            `bands=${stats.totalBandEntries} entries (${stats.bandTextureSizeKB}KB), ` +
            `glyphMap=${glyphMapTexHeight * glyphMapTexWidth} entries (${stats.glyphMapTextureSizeKB}KB)`
        );
        console.log(`[SlugEncoder] Total: ${totalKB}KB (${elapsed}ms)`);

        return {
            curveTexture,
            bandTexture,
            glyphMapTexture,
            stats,
        };
    }

    /**
     * Create a RGBA16UI DataTexture for Slug rendering.
     *
     * @private
     * @param {Uint16Array} data - Texture data
     * @param {number} width
     * @param {number} height
     * @returns {THREE.DataTexture}
     */
    _createSlugTexture(data, width, height) {
        const texture = new THREE.DataTexture(
            data,
            width,
            height,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedShortType
        );
        texture.internalFormat = 'RGBA16UI';
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        return texture;
    }
}
