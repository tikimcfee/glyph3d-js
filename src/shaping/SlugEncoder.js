/**
 * SlugEncoder — Converts HarfBuzz glyph outlines into GPU-ready DataTextures
 * for the Slug vector text rendering algorithm.
 *
 * Takes a HarfBuzzShaper instance, extracts outlines for each unique glyph,
 * converts all segments to quadratic beziers, normalizes coordinates to [0,1]
 * within each glyph's advance-width cell, organizes curves into horizontal
 * bands for early-exit ray testing, and packs everything into three RGBA16UI
 * DataTextures.
 *
 * Runs on the main thread, once per font load, before any rendering begins.
 * Workers never touch SlugEncoder — they only do shaping + buffer packing.
 *
 * Three output textures:
 *   curveTexture    — 2 texels per curve: [P0.x, P0.y, P1.x, P1.y] [P2.x, P2.y, _, _]
 *   bandTexture     — flat layout: band headers [curveTexelOffset, curveCount, _, _]
 *                     followed by curve entries [curveIndex, _, _, _] per band
 *   glyphMapTexture — 1 texel per glyph: [curveStart, curveCount, bandHeaderStart, bandCount]
 *
 * All coordinates normalized to [0,1] then packed as uint16 (0-65535).
 * All textures use RGBA16UI / usampler2D / texelFetch.
 */

import * as THREE from 'three';
import {
    MAX_BANDS,
    CURVE_TEXELS_PER_CURVE,
    TEXTURE_WIDTH,
    packUint16,
} from './slug-constants.js';

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
        const ids = Array.from(glyphIds);
        console.log(`[SlugEncoder] Encoding ${ids.length} glyphs...`);

        // Phase 1: Extract and process all glyph outlines
        // Map glyphId -> encoded glyph data
        const glyphDataMap = new Map();
        let totalCurves = 0;

        for (const glyphId of ids) {
            const data = this._encodeGlyph(glyphId);
            glyphDataMap.set(glyphId, data);
            totalCurves += data.curves.length;
        }

        // Phase 2: Compute global offsets and pack textures
        // We need to know the maximum glyphId to size the glyphMap texture
        const maxGlyphId = ids.length > 0 ? Math.max(...ids) : 0;
        const glyphMapEntries = maxGlyphId + 1; // one texel per possible glyphId slot

        // Curve texture: 2 texels per curve
        const totalCurveTexels = totalCurves * CURVE_TEXELS_PER_CURVE;
        const curveTexHeight = Math.max(1, Math.ceil(totalCurveTexels / TEXTURE_WIDTH));
        const curveTexSize = TEXTURE_WIDTH * curveTexHeight * 4; // 4 channels (RGBA)
        const curveData = new Uint16Array(curveTexSize);

        // Band texture: sized after we know total band entries
        // First pass: count total band texels needed
        let totalBandTexels = 0;
        for (const [, data] of glyphDataMap) {
            // Each glyph's bands: bandCount header texels + sum of entries
            for (const band of data.bands) {
                totalBandTexels += 1; // header texel
                totalBandTexels += band.curveIndices.length; // entry texels
            }
        }

        const bandTexHeight = Math.max(1, Math.ceil(totalBandTexels / TEXTURE_WIDTH));
        const bandTexSize = TEXTURE_WIDTH * bandTexHeight * 4;
        const bandData = new Uint16Array(bandTexSize);

        // GlyphMap texture: 1 texel per glyph slot
        const glyphMapTexHeight = Math.max(1, Math.ceil(glyphMapEntries / TEXTURE_WIDTH));
        const glyphMapTexSize = TEXTURE_WIDTH * glyphMapTexHeight * 4;
        const glyphMapData = new Uint16Array(glyphMapTexSize);

        // Phase 3: Pack data into texture arrays
        let curveTexelOffset = 0;  // current texel write position in curveTexture
        let curveIndex = 0;        // current curve index (= curveTexelOffset / 2)
        let bandTexelOffset = 0;
        let loggedCount = 0;

        for (const glyphId of ids) {
            const data = glyphDataMap.get(glyphId);
            const curveStart = curveIndex; // curve index, not texel offset
            const bandHeaderStart = bandTexelOffset;

            // Pack curves into curveTexture
            for (const curve of data.curves) {
                // Texel 0: [P0.x, P0.y, P1.x, P1.y]
                const t0 = curveTexelOffset * 4;
                curveData[t0 + 0] = packUint16(curve.p0x);
                curveData[t0 + 1] = packUint16(curve.p0y);
                curveData[t0 + 2] = packUint16(curve.p1x);
                curveData[t0 + 3] = packUint16(curve.p1y);

                // Texel 1: [P2.x, P2.y, _, _]
                const t1 = (curveTexelOffset + 1) * 4;
                curveData[t1 + 0] = packUint16(curve.p2x);
                curveData[t1 + 1] = packUint16(curve.p2y);
                curveData[t1 + 2] = 0;
                curveData[t1 + 3] = 0;

                curveTexelOffset += CURVE_TEXELS_PER_CURVE;
                curveIndex += 1;
            }

            // Pack bands into bandTexture.
            //
            // Layout per glyph: all band headers first (contiguous), then all
            // band entries. This is required because the shader addresses headers
            // as bandHeaderStart + bandIdx, so headers must be at consecutive
            // texels. Each header's entryStart points past the header block
            // into the entries region.
            //
            // Header texel: [entryStart, entryCount, _, _]
            // Entry texel:  [curveIndex, _, _, _]
            //   where curveIndex is the glyph-local curve index (shader computes
            //   absolute texel as (vCurveStart + curveIndex) * 2)

            const bandCount = data.bands.length;
            // Headers occupy bandTexelOffset .. bandTexelOffset + bandCount - 1
            // Entries start right after all headers for this glyph
            const headerBase = bandTexelOffset;
            let entryBase = headerBase + bandCount;

            for (let b = 0; b < bandCount; b++) {
                const band = data.bands[b];
                const entryCount = band.curveIndices.length;

                // Write header at headerBase + b
                const hdrIdx = (headerBase + b) * 4;
                bandData[hdrIdx + 0] = entryBase;      // entryStart
                bandData[hdrIdx + 1] = entryCount;     // entryCount
                bandData[hdrIdx + 2] = 0;
                bandData[hdrIdx + 3] = 0;

                // Write entries for this band
                for (const localCurveIdx of band.curveIndices) {
                    const entIdx = entryBase * 4;
                    bandData[entIdx + 0] = localCurveIdx;  // glyph-local curve index
                    bandData[entIdx + 1] = 0;
                    bandData[entIdx + 2] = 0;
                    bandData[entIdx + 3] = 0;
                    entryBase += 1;
                }
            }
            bandTexelOffset = entryBase;

            // Pack glyphMap entry: [curveStart, curveCount, bandHeaderStart, bandCount]
            // curveStart = curve index (not texel offset); shader computes texel as curveStart * 2
            const gmIdx = glyphId * 4;
            glyphMapData[gmIdx + 0] = curveStart;
            glyphMapData[gmIdx + 1] = data.curves.length;
            glyphMapData[gmIdx + 2] = bandHeaderStart;
            glyphMapData[gmIdx + 3] = data.bands.length;

            // Log first 3 glyphs
            if (loggedCount < 3) {
                const name = this._shaper.glyphName(glyphId) || '?';
                console.log(
                    `[SlugEncoder] Glyph ${glyphId} ("${name}"): ` +
                    `${data.curves.length} curves, ${data.bands.length} bands`
                );
                loggedCount++;
            }
        }

        // Phase 4: Create Three.js DataTexture instances
        const curveTexture = this._createSlugTexture(curveData, TEXTURE_WIDTH, curveTexHeight);
        const bandTexture = this._createSlugTexture(bandData, TEXTURE_WIDTH, bandTexHeight);
        const glyphMapTexture = this._createSlugTexture(glyphMapData, TEXTURE_WIDTH, glyphMapTexHeight);

        // Stats
        const curveTextureSizeKB = +(curveData.byteLength / 1024).toFixed(2);
        const bandTextureSizeKB = +(bandData.byteLength / 1024).toFixed(2);
        const glyphMapTextureSizeKB = +(glyphMapData.byteLength / 1024).toFixed(2);
        const totalKB = +(curveTextureSizeKB + bandTextureSizeKB + glyphMapTextureSizeKB).toFixed(2);
        const elapsed = (performance.now() - startTime).toFixed(1);

        console.log(
            `[SlugEncoder] Textures built: ` +
            `curves=${totalCurveTexels} texels (${curveTextureSizeKB}KB), ` +
            `bands=${totalBandTexels} entries (${bandTextureSizeKB}KB), ` +
            `glyphMap=${glyphMapEntries} entries (${glyphMapTextureSizeKB}KB)`
        );
        console.log(`[SlugEncoder] Total: ${totalKB}KB (${elapsed}ms)`);

        return {
            curveTexture,
            bandTexture,
            glyphMapTexture,
            stats: {
                glyphCount: ids.length,
                totalCurves,
                totalBandEntries: totalBandTexels,
                curveTextureSizeKB,
                bandTextureSizeKB,
                glyphMapTextureSizeKB,
            }
        };
    }

    /**
     * Encode a single glyph: extract outline, convert to quadratic beziers,
     * normalize to [0,1] within advance-width cell, organize into horizontal bands.
     *
     * @private
     * @param {number} glyphId
     * @returns {{
     *   curves: Array<{p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number}>,
     *   bands: Array<{curveIndices: number[]}>,
     * }}
     */
    _encodeGlyph(glyphId) {
        const segments = this._shaper.glyphOutline(glyphId);

        // Empty glyph (space, .notdef, etc.)
        if (!segments || segments.length === 0) {
            return { curves: [], bands: [] };
        }

        // Step 1: Parse segments into quadratic beziers (in font units)
        const rawCurves = this._parseSegments(glyphId, segments);

        if (rawCurves.length === 0) {
            return { curves: [], bands: [] };
        }

        // Step 2: Get advance width and font extents for normalization
        const advance = this._shaper.glyphAdvance(glyphId);
        const fontExt = this._shaper.fontExtents();
        const ascender = fontExt.ascender;
        const descender = fontExt.descender; // Typically negative

        // Step 3: Compute bbox from raw curves for validation
        const bbox = this._computeBBox(rawCurves);

        // Build-time assertion: warn if glyph extends beyond advance width
        if (bbox.xMax > advance * 1.01) { // 1% tolerance for rounding
            const name = this._shaper.glyphName(glyphId) || '?';
            console.warn(
                `[SlugEncoder] Glyph ${glyphId} ("${name}") bbox.xMax (${bbox.xMax}) > advance (${advance})`
            );
        }
        if (bbox.xMin < -advance * 0.01) {
            const name = this._shaper.glyphName(glyphId) || '?';
            console.warn(
                `[SlugEncoder] Glyph ${glyphId} ("${name}") bbox.xMin (${bbox.xMin}) < 0`
            );
        }

        // Step 4: Normalize to [0,1] within advance-width cell
        // X: [0, advance] -> [0, 1]
        // Y: [descender, ascender] -> [0, 1]
        const xScale = advance > 0 ? 1 / advance : 1;
        const yRange = ascender - descender;
        const yScale = yRange > 0 ? 1 / yRange : 1;

        const normalized = rawCurves.map(c => ({
            p0x: c.p0x * xScale,
            p0y: (c.p0y - descender) * yScale,
            p1x: c.p1x * xScale,
            p1y: (c.p1y - descender) * yScale,
            p2x: c.p2x * xScale,
            p2y: (c.p2y - descender) * yScale,
        }));

        // Step 5: Organize into horizontal bands
        const bandCount = this._computeBandCount(normalized.length);
        const bands = this._organizeBands(normalized, bandCount);

        return { curves: normalized, bands };
    }

    /**
     * Parse outline segments into quadratic bezier curves.
     * L segments become degenerate quadratics (control point at midpoint).
     * Z segments emit a closing line if current point differs from contour start.
     * C segments (cubics) throw — TrueType fonts only emit quadratics.
     *
     * @private
     * @param {number} glyphId - For error reporting
     * @param {Array<{type: string, values: number[]}>} segments
     * @returns {Array<{p0x, p0y, p1x, p1y, p2x, p2y}>} Curves in font units
     */
    _parseSegments(glyphId, segments) {
        const curves = [];
        let cx = 0, cy = 0; // current point
        let sx = 0, sy = 0; // contour start

        for (const seg of segments) {
            switch (seg.type) {
                case 'M':
                    sx = seg.values[0];
                    sy = seg.values[1];
                    cx = sx;
                    cy = sy;
                    break;

                case 'L': {
                    const ex = seg.values[0];
                    const ey = seg.values[1];
                    // Degenerate quadratic: control point at midpoint
                    curves.push({
                        p0x: cx, p0y: cy,
                        p1x: (cx + ex) / 2, p1y: (cy + ey) / 2,
                        p2x: ex, p2y: ey,
                    });
                    cx = ex;
                    cy = ey;
                    break;
                }

                case 'Q': {
                    const [cpx, cpy, ex, ey] = seg.values;
                    curves.push({
                        p0x: cx, p0y: cy,
                        p1x: cpx, p1y: cpy,
                        p2x: ex, p2y: ey,
                    });
                    cx = ex;
                    cy = ey;
                    break;
                }

                case 'C':
                    throw new Error(
                        `[SlugEncoder] Cubic bezier in glyph ${glyphId} — CFF fonts not yet supported`
                    );

                case 'Z':
                    // Close contour: emit implicit closing line if needed
                    if (Math.abs(cx - sx) > 0.01 || Math.abs(cy - sy) > 0.01) {
                        curves.push({
                            p0x: cx, p0y: cy,
                            p1x: (cx + sx) / 2, p1y: (cy + sy) / 2,
                            p2x: sx, p2y: sy,
                        });
                    }
                    cx = sx;
                    cy = sy;
                    break;
            }
        }

        return curves;
    }

    /**
     * Compute axis-aligned bounding box from a set of quadratic bezier curves.
     * Uses control point hull (conservative but fast — exact bbox requires
     * finding parametric extrema, not needed for validation).
     *
     * @private
     * @param {Array<{p0x, p0y, p1x, p1y, p2x, p2y}>} curves
     * @returns {{xMin: number, yMin: number, xMax: number, yMax: number}}
     */
    _computeBBox(curves) {
        let xMin = Infinity, yMin = Infinity;
        let xMax = -Infinity, yMax = -Infinity;

        for (const c of curves) {
            const cxMin = Math.min(c.p0x, c.p1x, c.p2x);
            const cyMin = Math.min(c.p0y, c.p1y, c.p2y);
            const cxMax = Math.max(c.p0x, c.p1x, c.p2x);
            const cyMax = Math.max(c.p0y, c.p1y, c.p2y);
            if (cxMin < xMin) xMin = cxMin;
            if (cyMin < yMin) yMin = cyMin;
            if (cxMax > xMax) xMax = cxMax;
            if (cyMax > yMax) yMax = cyMax;
        }

        return { xMin, yMin, xMax, yMax };
    }

    /**
     * Determine band count from curve count.
     * Heuristic: ceil(sqrt(curveCount)), clamped to [2, MAX_BANDS].
     *
     * @private
     * @param {number} curveCount
     * @returns {number}
     */
    _computeBandCount(curveCount) {
        if (curveCount <= 0) return 0;
        return Math.min(MAX_BANDS, Math.max(2, Math.ceil(Math.sqrt(curveCount))));
    }

    /**
     * Organize normalized curves into horizontal bands.
     *
     * Horizontal bands partition the [0,1] Y range into equal strips.
     * A curve is assigned to every band whose Y range overlaps the curve's Y bbox.
     * Within each band, curves are sorted ascending by minX for early-exit
     * in the fragment shader's +X ray test.
     *
     * Returns an array of band objects, each containing sorted curve indices.
     *
     * @private
     * @param {Array<{p0x, p0y, p1x, p1y, p2x, p2y}>} curves - Normalized [0,1]
     * @param {number} bandCount
     * @returns {Array<{curveIndices: number[]}>}
     */
    _organizeBands(curves, bandCount) {
        if (bandCount <= 0) return [];

        const bands = Array.from({ length: bandCount }, () => []);
        const bandSize = 1.0 / bandCount;

        for (let ci = 0; ci < curves.length; ci++) {
            const c = curves[ci];
            const yMin = Math.min(c.p0y, c.p1y, c.p2y);
            const yMax = Math.max(c.p0y, c.p1y, c.p2y);
            const xMin = Math.min(c.p0x, c.p1x, c.p2x);

            // Determine which bands this curve overlaps
            const bStart = Math.max(0, Math.floor(yMin / bandSize));
            const bEnd = Math.min(bandCount - 1, Math.floor(Math.min(yMax, 0.9999) / bandSize));

            for (let b = bStart; b <= bEnd; b++) {
                bands[b].push({ curveIndex: ci, minX: xMin });
            }
        }

        // Sort each band ascending by minX (early-exit key for +X ray)
        for (const band of bands) {
            band.sort((a, b) => a.minX - b.minX);
        }

        // Return as array of {curveIndices}
        return bands.map(band => ({
            curveIndices: band.map(entry => entry.curveIndex),
        }));
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
