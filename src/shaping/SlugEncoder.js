/**
 * SlugEncoder — Wraps GPU-agnostic slug buffer packing in THREE.DataTextures
 *
 * Delegates all typed-array computation to buildSlugBuffers() (slugData.js),
 * then wraps the returned Uint16Arrays in THREE.DataTexture instances for the
 * existing WebGL render path.
 *
 * Two output textures:
 *   curveTexture    — 2 texels per curve: [P0.x, P0.y, P1.x, P1.y] [P2.x, P2.y, _, _]
 *   glyphMapTexture — 1 texel per glyph: [curveStart, curveCount, _, _]
 *
 * All coordinates normalized to [0,1] then packed as uint16 (0-65535).
 * Both textures use RGBA16UI / usampler2D / texelFetch.
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
     * Encode a set of glyph IDs into two GPU-ready DataTextures.
     *
     * @param {Set<number>|Array<number>} glyphIds - Glyph IDs to encode
     * @returns {{
     *   curveTexture: THREE.DataTexture,
     *   glyphMapTexture: THREE.DataTexture,
     *   stats: {
     *     glyphCount: number,
     *     totalCurves: number,
     *     curveTextureSizeKB: number,
     *     glyphMapTextureSizeKB: number
     *   }
     * }}
     */
    encode(glyphIds) {
        const startTime = performance.now();

        // Phases 1-3: pure typed-array computation, no THREE dependency
        const {
            curveData,
            glyphMapData,
            curveTexWidth,
            curveTexHeight,
            glyphMapTexWidth,
            glyphMapTexHeight,
            stats,
        } = buildSlugBuffers(this._shaper, glyphIds);

        // Phase 4: wrap typed arrays in THREE.DataTexture for the WebGL path
        const curveTexture    = this._createSlugTexture(curveData,    curveTexWidth,    curveTexHeight);
        const glyphMapTexture = this._createSlugTexture(glyphMapData, glyphMapTexWidth, glyphMapTexHeight);

        const totalKB = +(stats.curveTextureSizeKB + stats.glyphMapTextureSizeKB).toFixed(2);
        const elapsed = (performance.now() - startTime).toFixed(1);

        console.log(
            `[SlugEncoder] Textures built: ` +
            `curves=${stats.totalCurves * 2} texels (${stats.curveTextureSizeKB}KB), ` +
            `glyphMap=${glyphMapTexHeight * glyphMapTexWidth} entries (${stats.glyphMapTextureSizeKB}KB)`
        );
        console.log(`[SlugEncoder] Total: ${totalKB}KB (${elapsed}ms)`);

        return {
            curveTexture,
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
