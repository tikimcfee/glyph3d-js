/**
 * slugData.js — GPU-agnostic slug buffer packing
 *
 * Pure computation layer for the Slug vector text rendering algorithm.
 * NO Three.js dependency — SlugBuffer holds raw typed arrays; SlugEncoder wraps them in
 * THREE.DataTextures.
 *
 * Entry point: SlugBuffer — a GROWABLE accumulator. Append glyphs incrementally (each
 * extracted EXACTLY ONCE); the curve + glyph-map arrays grow like dynamic arrays. This
 * replaced the old full-rebuild `buildSlugBuffers`, which re-encoded the entire glyph set
 * on every atlas growth (the hot path that also re-spammed the overhang warnings).
 */

import {
    CURVE_TEXELS_PER_CURVE,
    TEXTURE_WIDTH,
    packUint16,
} from './slug-constants.js';

/**
 * On-the-wire format version for {@link SlugBuffer#serialize}. Bump on ANY layout
 * change to the descriptor (field add/remove, packing change) — the cache layer
 * folds this into its key so a stale blob misses → falls back to live encode.
 */
export const SLUG_BUFFER_FORMAT = 1;

/**
 * SlugBuffer — growable backing for the two Slug textures (RGBA32Uint, 4 channels/texel).
 *
 *   curve texture    — 2 texels per curve: [P0.x,P0.y,P1.x,P1.y] [P2.x,P2.y,_,_]
 *   glyph-map texture — 1 texel per glyph slot: [curveStart, curveCount, mode, emojiCell]
 *
 * Append-only within a generation: `addGlyphs` extracts + packs each NEW glyph once and
 * advances a write cursor; the arrays double on overflow. `reset` starts a fresh generation
 * (the from-scratch encode path). `curveTexture()` / `glyphMapTexture()` hand SlugEncoder
 * exact-size views to wrap as DataTextures.
 */
export class SlugBuffer {
    constructor() {
        // Start with headroom so the boot set rarely reallocates; double on overflow.
        this._curve = new Uint32Array(TEXTURE_WIDTH * 64 * 4); // ~64 rows of curve texels
        this._curveTexels = 0;   // texels written so far (the write cursor)
        this._curveCount = 0;    // curves written (= _curveTexels / CURVE_TEXELS_PER_CURVE)
        this._map = new Uint32Array(TEXTURE_WIDTH * 4 * 4);    // ~4 rows of glyph slots
        this._maxGlyphId = -1;
        this._encoded = new Set();
    }

    get size() { return this._encoded.size; }
    get totalCurves() { return this._curveCount; }
    has(glyphId) { return this._encoded.has(glyphId); }

    /** Start a fresh generation (the from-scratch encode path resets, then re-adds). */
    reset() {
        this._curveTexels = 0;
        this._curveCount = 0;
        // Zero the used glyph-map region so a re-used glyphId can't point at stale curves.
        if (this._maxGlyphId >= 0) this._map.fill(0, 0, (this._maxGlyphId + 1) * 4);
        this._maxGlyphId = -1;
        this._encoded.clear();
    }

    /**
     * Append glyphs not already encoded (skips glyph 0/.notdef + dupes). Each survivor is
     * extracted + packed EXACTLY ONCE. Logs ONE aggregated note for any new overhangers.
     * @param {import('./HarfBuzzShaper.js').default} shaper
     * @param {Iterable<number>} glyphIds
     * @returns {{ added: number }}
     */
    addGlyphs(shaper, glyphIds) {
        let overhangCount = 0, worstFrac = 0, worstId = -1, worstName = '';
        const addedIds = [];
        for (const glyphId of glyphIds) {
            if (glyphId <= 0 || this._encoded.has(glyphId)) continue; // .notdef has no curves; dupes are done
            const data = encodeGlyph(shaper, glyphId);
            this._append(shaper, glyphId, data);
            this._encoded.add(glyphId);
            addedIds.push(glyphId);
            if (data.overhang) {
                overhangCount++;
                if (data.overhang.frac > worstFrac) {
                    worstFrac = data.overhang.frac; worstId = glyphId; worstName = data.overhang.name;
                }
            }
        }
        const added = addedIds.length;
        // One aggregated note for the NEW overhangers (ink clipped at the cell edge — benign for a
        // clean monospace). Replaces the per-glyph console.warn that re-fired on every re-encode.
        if (overhangCount > 0) {
            console.log(
                `[SlugEncoder] ${overhangCount}/${added} new glyph(s) overhang the advance cell ` +
                `(ink clipped at the edge; benign for monospace) — worst: ${worstId} ("${worstName}") +${(worstFrac * 100).toFixed(1)}%`
            );
        }
        return { added, addedIds };
    }

    /** @private Pack one glyph's curves at the cursor + write its glyph-map entry. */
    _append(shaper, glyphId, data) {
        const isBitmap = typeof shaper.isBitmapSlot === 'function' && shaper.isBitmapSlot(glyphId);
        const curveStart = this._curveCount;

        if (!isBitmap && data.curves.length > 0) {
            this._growCurves(this._curveTexels + data.curves.length * CURVE_TEXELS_PER_CURVE);
            const buf = this._curve;
            for (const curve of data.curves) {
                const t0 = this._curveTexels * 4;       // texel 0: [P0.x, P0.y, P1.x, P1.y]
                buf[t0 + 0] = packUint16(curve.p0x);
                buf[t0 + 1] = packUint16(curve.p0y);
                buf[t0 + 2] = packUint16(curve.p1x);
                buf[t0 + 3] = packUint16(curve.p1y);
                const t1 = (this._curveTexels + 1) * 4; // texel 1: [P2.x, P2.y, _, _]
                buf[t1 + 0] = packUint16(curve.p2x);
                buf[t1 + 1] = packUint16(curve.p2y);
                buf[t1 + 2] = 0;
                buf[t1 + 3] = 0;
                this._curveTexels += CURVE_TEXELS_PER_CURVE;
                this._curveCount += 1;
            }
        }

        // Glyph-map entry at glyphId*4. mode 0 = Slug bezier (curveStart/count valid); mode 1 =
        // color-emoji bitmap (count 0; emojiCell indexes the emoji atlas — the shader samples it
        // instead of the coverage loop; it branches on mode BEFORE the count==0 discard).
        this._growMap(glyphId);
        const gm = glyphId * 4;
        this._map[gm + 0] = isBitmap ? 0 : curveStart;
        this._map[gm + 1] = isBitmap ? 0 : data.curves.length;
        this._map[gm + 2] = isBitmap ? 1 : 0;
        this._map[gm + 3] = isBitmap ? shaper.emojiCellOf(glyphId) : 0;
        if (glyphId > this._maxGlyphId) this._maxGlyphId = glyphId;
    }

    /** @private Grow the curve array (doubling) to hold at least `texels`. */
    _growCurves(texels) {
        const need = texels * 4;
        if (need <= this._curve.length) return;
        let cap = this._curve.length;
        while (cap < need) cap *= 2;
        const grown = new Uint32Array(cap);
        grown.set(this._curve);
        this._curve = grown;
    }

    /** @private Grow the glyph-map array (doubling) to hold `glyphId`. */
    _growMap(glyphId) {
        const need = (glyphId + 1) * 4;
        if (need <= this._map.length) return;
        let cap = this._map.length;
        while (cap < need) cap *= 2;
        const grown = new Uint32Array(cap);
        grown.set(this._map);
        this._map = grown;
    }

    /** Exact-size view of the curve texture data + its dims (a view, not a copy). */
    curveTexture() {
        const height = Math.max(1, Math.ceil(this._curveTexels / TEXTURE_WIDTH));
        return { data: this._curve.subarray(0, TEXTURE_WIDTH * height * 4), width: TEXTURE_WIDTH, height };
    }

    /** Exact-size view of the glyph-map texture data + its dims. */
    glyphMapTexture() {
        const entries = Math.max(1, this._maxGlyphId + 1);
        const height = Math.max(1, Math.ceil(entries / TEXTURE_WIDTH));
        return { data: this._map.subarray(0, TEXTURE_WIDTH * height * 4), width: TEXTURE_WIDTH, height };
    }

    /**
     * Snapshot the buffer as a GPU-agnostic descriptor — the serializable core that
     * a prebaked blob ships and boot hydrates instead of re-encoding. Pairs with the
     * static {@link SlugBuffer.deserialize}.
     *
     * The arrays are COPIES, row-aligned exactly as the textures want them (so the
     * descriptor is independent of this buffer's future growth, and a hydrate yields
     * byte-identical textures). `encodedIds` is stored explicitly — it is NOT
     * reconstructable from the sparse glyph-map, because an encoded-but-empty glyph
     * writes a `[start,0,0,0]` entry indistinguishable from an unencoded slot — and
     * sorted ascending so the snapshot is order-stable (serialize twice → identical
     * bytes) regardless of insertion order.
     *
     * Stays pure: no hashing, no compression, no font identity. The cache/serving
     * layer wraps this descriptor in a versioned, hashed, gzipped envelope.
     *
     * @returns {{ v:number, curveCount:number, maxGlyphId:number,
     *             encodedIds:Uint32Array, curve:Uint32Array, map:Uint32Array }}
     */
    serialize() {
        const c = this.curveTexture();    // row-aligned views
        const g = this.glyphMapTexture();
        const encodedIds = Uint32Array.from(this._encoded).sort((a, b) => a - b);
        return {
            v: SLUG_BUFFER_FORMAT,
            curveCount: this._curveCount,
            maxGlyphId: this._maxGlyphId,
            encodedIds,
            curve: c.data.slice(),        // slice() a view → owns its buffer
            map: g.data.slice(),
        };
    }

    /**
     * Rebuild a live SlugBuffer from a {@link SlugBuffer#serialize} descriptor. The
     * result is FULLY LIVE — it continues to grow via addGlyphs (capacity = the
     * row-aligned used size; _growCurves/_growMap double from there). Throws on any
     * structural mismatch so the cache layer can catch → fall back to live encode.
     *
     * @param {{ v:number, curveCount:number, maxGlyphId:number,
     *           encodedIds:Uint32Array, curve:Uint32Array, map:Uint32Array }} d
     * @returns {SlugBuffer}
     */
    static deserialize(d) {
        _validateDescriptor(d);
        const buf = new SlugBuffer();
        buf._curve = Uint32Array.from(d.curve);
        buf._curveCount = d.curveCount;
        buf._curveTexels = d.curveCount * CURVE_TEXELS_PER_CURVE;
        buf._map = Uint32Array.from(d.map);
        buf._maxGlyphId = d.maxGlyphId;
        buf._encoded = new Set(d.encodedIds);
        return buf;
    }
}

/**
 * Structural validation for a serialized descriptor. The array lengths are fully
 * determined by curveCount + maxGlyphId (both row-padded to TEXTURE_WIDTH), so a
 * length mismatch means corruption / a format drift the version didn't catch.
 * @param {*} d
 */
function _validateDescriptor(d) {
    if (!d || d.v !== SLUG_BUFFER_FORMAT) {
        throw new Error(`SlugBuffer.deserialize: bad/missing format version (got ${d && d.v}, want ${SLUG_BUFFER_FORMAT})`);
    }
    if (!(d.curve instanceof Uint32Array) || !(d.map instanceof Uint32Array) || !(d.encodedIds instanceof Uint32Array)) {
        throw new Error('SlugBuffer.deserialize: curve/map/encodedIds must all be Uint32Array');
    }
    if (!Number.isInteger(d.curveCount) || d.curveCount < 0 || !Number.isInteger(d.maxGlyphId) || d.maxGlyphId < -1) {
        throw new Error(`SlugBuffer.deserialize: bad counts (curveCount=${d.curveCount}, maxGlyphId=${d.maxGlyphId})`);
    }
    const curveTexels = d.curveCount * CURVE_TEXELS_PER_CURVE;
    const curveRows = Math.max(1, Math.ceil(curveTexels / TEXTURE_WIDTH));
    const wantCurve = TEXTURE_WIDTH * curveRows * 4;
    if (d.curve.length !== wantCurve) {
        throw new Error(`SlugBuffer.deserialize: curve length ${d.curve.length} != ${wantCurve} (for ${d.curveCount} curves)`);
    }
    const mapRows = Math.max(1, Math.ceil((d.maxGlyphId + 1) / TEXTURE_WIDTH));
    const wantMap = TEXTURE_WIDTH * mapRows * 4;
    if (d.map.length !== wantMap) {
        throw new Error(`SlugBuffer.deserialize: map length ${d.map.length} != ${wantMap} (for maxGlyphId ${d.maxGlyphId})`);
    }
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
 *   curves: Array<{p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number}>,
 *   overhang: {frac: number, name: string}|null
 * }}
 */
export function encodeGlyph(shaper, glyphId) {
    const segments = shaper.glyphOutline(glyphId);

    // Empty glyph (space, .notdef, etc.)
    if (!segments || segments.length === 0) {
        return { curves: [], overhang: null };
    }

    // Step 1: Parse segments into quadratic beziers (in font units)
    const rawCurves = _parseSegments(glyphId, segments);

    if (rawCurves.length === 0) {
        return { curves: [], overhang: null };
    }

    // Step 2: Get advance width and font extents for normalization. With a font
    // chain, glyphId is a global slot; fontExtents(slot) returns the metrics of
    // THAT glyph's font so fallback glyphs normalize against their own em box.
    const advance = shaper.glyphAdvance(glyphId);
    const fontExt = shaper.fontExtents(glyphId);
    const ascender = fontExt.ascender;
    const descender = fontExt.descender; // Typically negative

    // Step 3: Compute bbox from raw curves (conservative control-point hull).
    const bbox = _computeBBox(rawCurves);

    // Overhang check: ink past the advance cell ([0, advance]) clips at the advance-wide quad
    // edge (curves normalize [0,advance]→[0,1]). Common + mostly benign — the hull over-estimates
    // (control points sit outside the curve) AND fonts legitimately overhang (negative side
    // bearings, overshoots). Return the magnitude instead of warning per-glyph; SlugBuffer.addGlyphs
    // aggregates one summary so it doesn't re-spam on every atlas re-encode.
    let overhang = null;
    const over = Math.max(bbox.xMax - advance, -bbox.xMin); // worst of right-overhang / left-of-origin
    if (advance > 0 && over > advance * 0.01) {             // 1% tolerance for rounding
        overhang = { frac: over / advance, name: shaper.glyphName(glyphId) || '?' };
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

    return { curves: normalized, overhang };
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
