/**
 * slugData.js — GPU-agnostic slug buffer packing
 *
 * Pure computation layer for the Slug vector text rendering algorithm.
 * NO Three.js dependency — returns raw typed arrays so that both the
 * existing WebGL path (SlugEncoder → THREE.DataTexture) and the future
 * WebGPU path (GlyphField → GPUTexture) can share the same packing logic.
 *
 * Entry point: buildSlugBuffers(shaper, glyphIds)
 *
 * Internal helpers mirror the private methods that previously lived on
 * SlugEncoder: _encodeGlyph, _parseSegments, _computeBBox.
 */

import {
    CURVE_TEXELS_PER_CURVE,
    TEXTURE_WIDTH,
    packUint16,
} from './slug-constants.js';

/**
 * Build the two raw Uint16Arrays that back the Slug DataTextures.
 *
 * Phases 1-3 of the Slug encoding pipeline (phase 4 — wrapping in
 * THREE.DataTexture — lives in SlugEncoder.js):
 *   1. Extract each glyph's outline and convert to quadratic beziers
 *   2. Compute global texture dimensions
 *   3. Pack curves and the glyph map into Uint16Arrays
 *
 * @param {import('./HarfBuzzShaper.js').default} shaper - Initialized shaper
 * @param {Set<number>|Array<number>} glyphIds - Glyph IDs to encode
 * @returns {{
 *   curveData: Uint16Array,
 *   glyphMapData: Uint16Array,
 *   curveTexWidth: number,
 *   curveTexHeight: number,
 *   glyphMapTexWidth: number,
 *   glyphMapTexHeight: number,
 *   stats: {
 *     glyphCount: number,
 *     totalCurves: number,
 *     curveTextureSizeKB: number,
 *     glyphMapTextureSizeKB: number
 *   }
 * }}
 */
export function buildSlugBuffers(shaper, glyphIds) {
    const ids = Array.from(glyphIds);
    console.log(`[SlugEncoder] Encoding ${ids.length} glyphs...`);

    // Phase 1: Extract and process all glyph outlines
    const glyphDataMap = new Map();
    let totalCurves = 0;

    for (const glyphId of ids) {
        const data = _encodeGlyph(shaper, glyphId);
        glyphDataMap.set(glyphId, data);
        totalCurves += data.curves.length;
    }

    // Phase 2: Compute global offsets and size texture arrays
    const maxGlyphId = ids.length > 0 ? Math.max(...ids) : 0;
    const glyphMapEntries = maxGlyphId + 1; // one texel per possible glyphId slot

    // Curve texture: 2 texels per curve
    const totalCurveTexels = totalCurves * CURVE_TEXELS_PER_CURVE;
    const curveTexHeight = Math.max(1, Math.ceil(totalCurveTexels / TEXTURE_WIDTH));
    const curveTexSize = TEXTURE_WIDTH * curveTexHeight * 4; // 4 channels (RGBA)
    const curveData = new Uint16Array(curveTexSize);

    // GlyphMap texture: 1 texel per glyph slot
    const glyphMapTexHeight = Math.max(1, Math.ceil(glyphMapEntries / TEXTURE_WIDTH));
    const glyphMapTexSize = TEXTURE_WIDTH * glyphMapTexHeight * 4;
    const glyphMapData = new Uint16Array(glyphMapTexSize);

    // Phase 3: Pack data into texture arrays
    let curveTexelOffset = 0; // current texel write position in curveTexture
    let curveIndex = 0;       // current curve index (= curveTexelOffset / 2)
    let loggedCount = 0;

    for (const glyphId of ids) {
        const data = glyphDataMap.get(glyphId);
        const curveStart = curveIndex;         // curve index, not texel offset

        // Pack curves into curveData
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

        // Pack glyphMap entry: [curveStart, curveCount, _, _]
        // curveStart = curve index (not texel offset); shader computes texel as curveStart * 2.
        // The fragment shader iterates all of a glyph's curves directly, so no
        // acceleration structure is stored — the per-curve y-reject is enough.
        const gmIdx = glyphId * 4;
        glyphMapData[gmIdx + 0] = curveStart;
        glyphMapData[gmIdx + 1] = data.curves.length;
        glyphMapData[gmIdx + 2] = 0;
        glyphMapData[gmIdx + 3] = 0;

        // Log first 3 glyphs
        if (loggedCount < 3) {
            const name = shaper.glyphName(glyphId) || '?';
            console.log(
                `[SlugEncoder] Glyph ${glyphId} ("${name}"): ${data.curves.length} curves`
            );
            loggedCount++;
        }
    }

    const curveTextureSizeKB = +(curveData.byteLength / 1024).toFixed(2);
    const glyphMapTextureSizeKB = +(glyphMapData.byteLength / 1024).toFixed(2);

    return {
        curveData,
        glyphMapData,
        curveTexWidth: TEXTURE_WIDTH,
        curveTexHeight,
        glyphMapTexWidth: TEXTURE_WIDTH,
        glyphMapTexHeight,
        stats: {
            glyphCount: ids.length,
            totalCurves,
            curveTextureSizeKB,
            glyphMapTextureSizeKB,
        },
    };
}

// ---------------------------------------------------------------------------
// Internal helpers (pure math — no Three.js, no DOM)
// ---------------------------------------------------------------------------

/**
 * Encode a single glyph: extract outline, convert to quadratic beziers,
 * normalize to [0,1] within the advance-width cell.
 *
 * @param {import('./HarfBuzzShaper.js').default} shaper
 * @param {number} glyphId
 * @returns {{
 *   curves: Array<{p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number}>
 * }}
 */
function _encodeGlyph(shaper, glyphId) {
    const segments = shaper.glyphOutline(glyphId);

    // Empty glyph (space, .notdef, etc.)
    if (!segments || segments.length === 0) {
        return { curves: [] };
    }

    // Step 1: Parse segments into quadratic beziers (in font units)
    const rawCurves = _parseSegments(glyphId, segments);

    if (rawCurves.length === 0) {
        return { curves: [] };
    }

    // Step 2: Get advance width and font extents for normalization
    const advance = shaper.glyphAdvance(glyphId);
    const fontExt = shaper.fontExtents();
    const ascender = fontExt.ascender;
    const descender = fontExt.descender; // Typically negative

    // Step 3: Compute bbox from raw curves for validation
    const bbox = _computeBBox(rawCurves);

    // Build-time assertion: warn if glyph extends beyond advance width
    if (bbox.xMax > advance * 1.01) { // 1% tolerance for rounding
        const name = shaper.glyphName(glyphId) || '?';
        console.warn(
            `[SlugEncoder] Glyph ${glyphId} ("${name}") bbox.xMax (${bbox.xMax}) > advance (${advance})`
        );
    }
    if (bbox.xMin < -advance * 0.01) {
        const name = shaper.glyphName(glyphId) || '?';
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

    return { curves: normalized };
}

/**
 * Parse outline segments into quadratic bezier curves.
 * L segments become degenerate quadratics (control point at midpoint).
 * Z segments emit a closing line if current point differs from contour start.
 * C segments (cubics) throw — TrueType fonts only emit quadratics.
 *
 * @param {number} glyphId - For error reporting
 * @param {Array<{type: string, values: number[]}>} segments
 * @returns {Array<{p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number}>}
 */
function _parseSegments(glyphId, segments) {
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
 * Compute axis-aligned bounding box from quadratic bezier curves.
 * Uses control-point hull (conservative but fast).
 *
 * @param {Array<{p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number}>} curves
 * @returns {{xMin: number, yMin: number, xMax: number, yMax: number}}
 */
function _computeBBox(curves) {
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
