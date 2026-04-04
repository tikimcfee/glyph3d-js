# Round 3: rendering convergence

## Settled

1. **RGBA16UI for all three Slug textures.** Encoding retracted RGBA16F in Round 2. Plumbing and rendering both hold RGBA16UI. One sampler type (`usampler2D` + `texelFetch`) across all Slug textures — no sampler-type heterogeneity, no `DataView.setFloat16` dependency. Precision for [0,1] normalized coordinates is better than float16. Settled.

2. **Two texels per curve.** A quadratic Bezier has 6 coordinates. They cannot fit in 4 channels. Two RGBA16UI texels: `[P0.x, P0.y, P1.x, P1.y]` and `[P2.x, P2.y, _, _]`. All three agents agreed by Round 2. Settled.

3. **One texel per glyph in glyphMapTexture.** RGBA16UI: `(curveStart, curveCount, bandHeaderStart, bandCount)`. Encoding retracted 4-texel RGBA32F in Round 2. No bbox in the shader — curves normalized to advance-width cell, `vGlyphUV = uv` maps directly. Settled.

4. **MAX_BANDS = 16, MAX_CURVES_PER_BAND = 64.** Encoding derived it from actual Cousine curve counts. All three agents agree. Settled. My Phase 0 used 32 — retracted.

5. **curveTexture width = 1024.** Encoding retracted 256 in Round 2 (conceded per round2-rendering). glyphMapTexture width = 1024, bandTexture width = 1024 for uniformity.

6. **`windingContrib` linear fallback is mandatory, not optional.** Every `L` and closing `Z` segment in `glyphToJson` produces A=0 (because the control point is the midpoint, so `a.y - 2b.y + c.y = 0` exactly). The Phase 0 shader sketch silently does division-by-zero on every line segment. The fix is a required precondition for any shipped shader, not a future optimization. Settled.

7. **Early-exit axis: `minX > p.x`, not `maxY < p.y`.** hBands partition Y; curves within a band are sorted by xMax ascending for +X ray casting. The correct break condition is `if (curveMinX > p.x) break;`. Phase 0 sketch had `maxY < p.y` — wrong axis. Retracted.

8. **`texture()` on `usampler2D` is a GLSL ES 3.0 compile error.** Phase 0 vertex shader used `texture(glyphMapTexture, vec2(tx, ty))` on a declared `usampler2D`. Must be `texelFetch(glyphMapTexture, ivec2(mapCol, mapRow), 0)`. Settled.

9. **Band texture 3-hop indirection.** glyphMapTexture → `bandHeaderStart + bandIdx` (header texel) → `entryStart + j` (entry texel, gives curveIndex) → `curveStart + curveIndex * 2` (curve texel 0) + `curveIndex * 2 + 1` (curve texel 1). The field in glyphMapTexture is named `bandHeaderStart`, not `bandStart`. Settled.

10. **`transparent: false` with explicit `discard`.** Slug computes binary winding (int), so `clamp(abs(float(winding)), 0.0, 1.0)` is either 0 or 1. `transparent: true` would break depth-sort semantics for overlapping CodeGrids with depth write enabled. Phase 3 ships with `if (coverage < 0.01) discard;`. AA deferred to Phase 4. Settled (retract `transparent: true` from Phase 0 section 8).

11. **`glyphExtents()` must be added to HarfBuzzShaper.** `shaper._font` is private. SlugEncoder needs extents for the advance-width normalization assertion. All three agents agree. Settled.

12. **ESM patching is a vendoring-time blocking step.** `hb.js` and `hbjs.js` must have `export default` appended before any import. Not a "verify later" task. Settled.

13. **`instanceCodepoint` → `instanceGlyphId` rename in one commit.** Attribute, builder output field (`codepoints` → `glyphIds`), and `applyPrebuiltBuffers` destructuring all change together. No transition period. Settled.

14. **`SLUG_FORMATS` and `SLUG_LIMITS` in `src/core/constants.js`.** Single source of truth for texture formats, widths, and loop caps. Both SlugEncoder and the GLSL shader header inject from this object. Settled.

15. **Sub-pixel AA is Phase 4.** Phase 3 ships hard-edge binary coverage. A commented-out `fwidth`-based block in the fragment shader marks the intended follow-up path. Settled.

---

## Implementation Plan

### Phase 1: Foundation (constants + HarfBuzz vendor)

**`src/core/constants.js`** — add:
```javascript
export const SLUG_LIMITS = {
    maxBandsPerGlyph: 16,
    maxCurvesPerBand: 64,
    glyphMapTextureWidth: 1024,
    curveTextureWidth: 1024,
    bandTextureWidth: 1024,
};
// Texture format contract shared with GLSL shader header.
// All integer textures use usampler2D + texelFetch.
export const SLUG_FORMATS = {
    curve:   { internalFormat: 'RGBA16UI', texelsPerCurve: 2 },
    band:    { internalFormat: 'RGBA16UI', texelsPerEntry: 1 },
    glyphMap:{ internalFormat: 'RGBA16UI', texelsPerGlyph: 1 },
};
```

**`src/vendor/hb.js`**, **`src/vendor/hbjs.js`** — create `src/vendor/` directory, copy files from CDN, append:
- `hb.js`: `export default createHarfBuzz;`
- `hbjs.js`: `export default hbjs;`

**`src/shaping/HarfBuzzShaper.js`** — add public method:
```javascript
/** @param {number} glyphId @returns {{xBearing,yBearing,width,height}} */
glyphExtents(glyphId) { return this._font.glyphExtents(glyphId); }
```

### Phase 2: SlugEncoder

**`src/slug/SlugEncoder.js`** — new file. Accepts `HarfBuzzShaper` + `SLUG_LIMITS`. Produces `{ curveTexture, bandTexture, glyphMapTexture, glyphMapWidth, glyphMapHeight }`.

Key implementation notes:
- Runs on main thread only. No worker involvement.
- For each glyph: call `shaper.glyphOutline(glyphId)` → normalize all coordinates to `[0, advance] × [descender, ascender]` in font units, then to [0,1]. Map `L` segments to degenerate quadratics (midpoint as control point).
- Band assignment: divide [0,1] Y into `bandCount = min(ceil(sqrt(curveCount)), MAX_BANDS)` equal strips. A curve spans all bands whose Y-range overlaps the curve's Y-bbox.
- Within each band: sort curves ascending by `minX` (correct early-exit key for +X ray). Write band header (entryStart, entryCount) to band texture header region, then curve indices to entry region.
- Build-time assertion: `if (bbox.xMax > advance || bbox.xMin < 0) console.warn(...)`.
- Pack uint16: `Math.round(normalizedValue * 65535)`.
- Create Three.js `DataTexture` with `type: THREE.UnsignedShortType`, `format: THREE.RGBAIntegerFormat`, `internalFormat: 'RGBA16UI'`, `magFilter: THREE.NearestFilter`, `minFilter: THREE.NearestFilter`, `generateMipmaps: false`.

### Phase 3: GlyphRenderer — shader + wiring

**`src/GlyphRenderer.js`** — changes:

*Constructor*: accept `slugData` in place of `atlas`. Remove `GlyphAtlas` import.

*Deleted code* (see Phase 0 section 7 for line-by-line list): `_createAtlasTexture`, `_syncAtlasMapDimensions`, `_ensureGlyphsInAtlas`, `atlas.checkAndClearTextureUpdate()` call in `render()`, all atlas uniform setup.

*`_createInstanceMesh()` uniform block*:
```javascript
uniforms: {
    curveTexture:       { value: slugData.curveTexture },
    bandTexture:        { value: slugData.bandTexture },
    glyphMapTexture:    { value: slugData.glyphMapTexture },
    glyphMapWidth:      { value: slugData.glyphMapWidth },
    glyphMapHeight:     { value: slugData.glyphMapHeight },
    groupTexture:       { value: this._groupTexture },
    groupTextureHeight: { value: this._maxGroups },
    highlightTexture:   { value: null },
}
// transparent: false, depthWrite: true, side: THREE.DoubleSide (unchanged)
```

*Vertex shader `_getVertexShader()`*: replace atlas block with:
```glsl
uniform usampler2D glyphMapTexture;
uniform float glyphMapWidth;
uniform float glyphMapHeight;
flat out int vCurveStart;
flat out int vCurveCount;
flat out int vBandHeaderStart;
flat out int vBandCount;
out vec2 vGlyphUV;
// ...
int gid = int(instanceGlyphId);
int mapCol = gid % int(glyphMapWidth);
int mapRow = gid / int(glyphMapWidth);
uvec4 glyphInfo = texelFetch(glyphMapTexture, ivec2(mapCol, mapRow), 0);
vCurveStart      = int(glyphInfo.x);
vCurveCount      = int(glyphInfo.y);
vBandHeaderStart = int(glyphInfo.z);
vBandCount       = int(glyphInfo.w);
vGlyphUV = uv;
```

*Fragment shader `_getFragmentShader()`*: full replacement. Key correctness requirements from convergence:
```glsl
#define MAX_BANDS 16
#define MAX_CURVES_PER_BAND 64

int windingContrib(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 a = p0-p, b = p1-p, c = p2-p;
    float A = a.y - 2.0*b.y + c.y;
    float B = a.y - b.y;
    float C = a.y;
    int winding = 0;
    if (abs(A) < 1e-7) {
        // Degenerate quadratic (line segment)
        if (abs(B) < 1e-7) return 0;
        float t = C / (2.0 * B);
        if (t < 0.0 || t > 1.0) return 0;
        float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
        if (x < 0.0) return 0;
        float dy = 2.0*((b.y - a.y)*(1.0-t) + (c.y - b.y)*t);
        return (dy > 0.0) ? 1 : -1;
    }
    float disc = B*B - A*C;
    if (disc < 0.0) return 0;
    float sqrtDisc = sqrt(disc);
    for (int k = 0; k < 2; k++) {
        float t = (k == 0) ? (B - sqrtDisc)/A : (B + sqrtDisc)/A;
        if (t < 0.0 || t > 1.0) continue;
        float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
        if (x < 0.0) continue;
        float dy = 2.0*((b.y - a.y)*(1.0-t) + (c.y - b.y)*t);
        winding += (dy > 0.0) ? 1 : -1;
    }
    return winding;
}

void main() {
    vec2 p = vGlyphUV;
    int bandIdx = clamp(int(p.y * float(vBandCount)), 0, vBandCount - 1);
    int hdrTexel = vBandHeaderStart + bandIdx;
    uvec4 hdr = texelFetch(bandTexture, ivec2(hdrTexel % 1024, hdrTexel / 1024), 0);
    int entryStart = int(hdr.x);
    int entryCount = int(hdr.y);
    int winding = 0;
    for (int i = 0; i < MAX_CURVES_PER_BAND; i++) {
        if (i >= entryCount) break;
        int entryTexel = entryStart + i;
        uvec4 entry = texelFetch(bandTexture, ivec2(entryTexel % 1024, entryTexel / 1024), 0);
        int ci = (vCurveStart + int(entry.x)) * 2;
        uvec4 t0 = texelFetch(curveTexture, ivec2(ci % 1024, ci / 1024), 0);
        uvec4 t1 = texelFetch(curveTexture, ivec2((ci+1) % 1024, (ci+1) / 1024), 0);
        vec2 cp0 = vec2(float(t0.x)/65535.0, float(t0.y)/65535.0);
        vec2 cp1 = vec2(float(t0.z)/65535.0, float(t0.w)/65535.0);
        vec2 cp2 = vec2(float(t1.x)/65535.0, float(t1.y)/65535.0);
        // Early exit: curves sorted ascending by minX within band.
        // If minX > p.x, all remaining curves are further right → no crossing.
        float minX = min(cp0.x, min(cp1.x, cp2.x));
        if (minX > p.x) break;
        winding += windingContrib(p, cp0, cp1, cp2);
    }
    float coverage = (winding != 0) ? 1.0 : 0.0;
    // Phase 4: fwidth-based AA goes here (commented out placeholder)
    if (coverage < 0.01) discard;
    vec3 finalColor = clamp(vColor * coverage + vAddedColor, 0.0, 1.0);
    fragColor = vec4(finalColor, coverage * vGroupAlpha);
    if (fragColor.a < 0.01) discard;
}
```

*`instanceCodepoint` → `instanceGlyphId` rename*: attribute declaration in `_createInstanceMesh()`, write path in `_rebuildAllInstances()`, write path in `applyPrebuiltBuffers()`. Builder output field `codepoints` → `glyphIds` in `buildGlyphBuffers.js` and `buildBatchBuffers.js` in the same commit.

**`src/picking/PickingSystem.js`** — glyph-mode picking shaders only:
- `PICKING_VERTEX_GLYPH`: drop atlas uniforms, add `usampler2D glyphMapTexture` + same flat int varyings as main vertex shader.
- `PICKING_FRAGMENT_GLYPH`: run the same `windingContrib` loop, discard on `winding == 0`, emit 24-bit picking ID. No color, no highlight, no AA.
- `registerRenderer()`: replace atlas uniform references (`atlasMapTexture`, `atlasTexture`, etc.) with `curveTexture`, `bandTexture`, `glyphMapTexture`.
- Cell-mode picking: zero changes.

### Files created
- `src/vendor/hb.js`
- `src/vendor/hbjs.js`
- `src/shaping/HarfBuzzShaper.js` (new or extend existing)
- `src/slug/SlugEncoder.js`

### Files modified
- `src/core/constants.js` — add `SLUG_LIMITS`, `SLUG_FORMATS`
- `src/GlyphRenderer.js` — shader replacement, uniform wiring, attribute rename, atlas deletion
- `src/picking/PickingSystem.js` — glyph-mode picking shaders + `registerRenderer()`
- `src/workers/builders/buildGlyphBuffers.js` — rename `codepoints` → `glyphIds`
- `src/workers/builders/buildBatchBuffers.js` — rename `codepoints` → `glyphIds`

### Files deleted
- `src/GlyphAtlas.js` — deferred to after full cutover (keep until Phase 3 is stable, then delete)

---

## Implementer Vote

**Assign to: plumbing agent.**

Rationale: The plumbing Phase 0 is closest to the converged plan. It owns `HarfBuzzShaper`, `buildShapedBuffers`, and the worker data-flow — all of which are the integration seams that the rendering changes depend on. The plumbing agent also has the most accurate picture of the `SlugEncoder` → `GlyphRenderer` handoff (the `SlugData` object shape, the `glyphIds` field rename, the `glyphExtents()` API addition). The rendering shader code above is complete enough to copy in directly; the plumbing agent's integration work is the remaining implementation surface.
