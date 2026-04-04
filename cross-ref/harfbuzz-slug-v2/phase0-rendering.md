# Phase 3 Rendering Analysis — Slug Integration into GlyphRenderer

**Scope**: Fragment shader, vertex shader changes, GlyphRenderer wiring, atlas removal, picking compatibility.

---

## 1. Current Shader Architecture (Exact Facts)

### Vertex Shader (canonical: `GlyphRenderer._getVertexShader()`)

Instance attributes in:
- `instancePosition` vec3 — left-edge world position
- `instanceSize` vec2 — (width, height) of glyph cell in world units
- `instanceCodepoint` float — numeric ID, indexes into `atlasMapTexture`
- `instanceColor` vec3
- `instanceGroupId` float

Key operations in order:
1. `vec3 scaled = position * vec3(instanceSize, 1.0)` — scales PlaneGeometry unit quad
2. Group DataTexture lookups: col 0 (pos+visibility), col 2 (color), col 3 (scale) via normalized UV `vec2(0.125/0.625/0.875, v)`
3. Left-align correction: `alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0)` — the PlaneGeometry is centered, instancePosition is the left edge
4. `worldPos = scaled + alignOffset + instancePosition * gScale.xyz + gPos.xyz`
5. Atlas UV lookup: `instanceCodepoint` → 2D texel coords → `texture(atlasMapTexture, ...)` → `uvRect` → `vUV = mix(uvRect.xy, uvRect.zw, uv)`
6. Highlight fetch: `texelFetch(highlightTexture, ivec2(gl_InstanceID % 1024, gl_InstanceID / 1024), 0)` → `vAddedColor`

Outputs: `vUV`, `vColor`, `vGroupAlpha`, `vAddedColor`

**The UV path is purely a lookup bridge** — vertex shader computes which sub-rect of the atlas bitmap to sample, passes it as `vUV` to the fragment shader. The fragment shader is trivially thin because all the "which pixels are filled" information lives in the bitmap.

### Fragment Shader

```glsl
vec4 texColor = texture(atlasTexture, vUV);       // bitmap sample — O(1)
vec4 base = texColor * vec4(vColor, vGroupAlpha);
fragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);
if (fragColor.a < 0.01) discard;
```

This is bandwidth-bound: one texture sample, two multiplies, one add, one discard test. The entire shape decision comes from the atlas bitmap's alpha channel.

---

## 2. What Changes for Slug

### The Core Inversion

Atlas: CPU rasterizes shapes once → GPU samples.
Slug: CPU stores curve geometry → GPU evaluates shapes per-pixel.

The fragment shader goes from 4 instructions to a loop. The vertex shader loses `vUV` and gains curve-data pass-through integers.

### Uniform Changes

**Remove:**
- `atlasTexture` (sampler2D, RGBA8 bitmap, ~16MB)
- `atlasMapTexture` (sampler2D, Float RGBA, codepoint→UV)
- `atlasMapWidth`, `atlasMapHeight` (floats)

**Add:**
- `curveTexture` (usampler2D, RG16UI or RGBA16UI — packed curve control points)
- `bandTexture` (usampler2D, RG16UI — band→curve index table)
- `glyphMapTexture` (usampler2D, RGBA16UI — glyphId→(curveStart, curveCount, bandStart, bandCount))

**Keep unchanged:**
- `groupTexture`, `groupTextureHeight` (group DataTexture system — untouched)
- `highlightTexture` (RGBA8, gl_InstanceID-indexed — untouched)

### Attribute Change

`instanceCodepoint float` → `instanceGlyphId float`

Same slot, same size, different semantic. The numeric ID now indexes `glyphMapTexture` instead of `atlasMapTexture`. Everything else — position, size, color, groupId — stays identical.

`instanceSize.x` changes meaning from "fixed cell width" to "HarfBuzz advance width" (variable). This is a data change, not a shader change; the shader just uses `instanceSize` as a scale factor either way.

---

## 3. New Vertex Shader

The vertex shader's job becomes: look up the glyph's curve/band offsets, pass them as flat ints to the fragment shader, and compute the per-fragment glyph-local UV coordinate.

```glsl
precision highp float;
precision highp int;

in vec3 instancePosition;
in vec2 instanceSize;         // (advanceWidth, lineHeight) from HarfBuzz
in float instanceGlyphId;
in vec3 instanceColor;
in float instanceGroupId;

uniform usampler2D glyphMapTexture;  // width=glyphMapWidth, glyphId→offsets
uniform float glyphMapWidth;
uniform float glyphMapHeight;

uniform sampler2D groupTexture;
uniform float groupTextureHeight;
uniform sampler2D highlightTexture;

flat out int vCurveStart;
flat out int vCurveCount;
flat out int vBandStart;
flat out int vBandCount;
out vec2 vGlyphUV;        // [0,1]² within glyph bounding box
out vec3 vColor;
out float vGroupAlpha;
out vec3 vAddedColor;

void main() {
    vec3 scaled = position * vec3(instanceSize, 1.0);

    float v = (instanceGroupId + 0.5) / groupTextureHeight;
    vec4 gPos   = texture(groupTexture, vec2(0.125, v));
    vec4 gColor = texture(groupTexture, vec2(0.625, v));
    vec4 gScale = texture(groupTexture, vec2(0.875, v));

    vec3 alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0);
    vec3 worldPos = scaled + alignOffset + instancePosition * gScale.xyz + gPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

    // Glyph map lookup: glyphId → curve/band offsets (packed as uint16)
    float gid = instanceGlyphId;
    float mapCol = mod(gid, glyphMapWidth);
    float mapRow = floor(gid / glyphMapWidth);
    float tx = (mapCol + 0.5) / glyphMapWidth;
    float ty = (mapRow + 0.5) / glyphMapHeight;
    uvec4 glyphInfo = texture(glyphMapTexture, vec2(tx, ty));
    vCurveStart = int(glyphInfo.x);
    vCurveCount = int(glyphInfo.y);
    vBandStart  = int(glyphInfo.z);
    vBandCount  = int(glyphInfo.w);

    // Glyph-local UV: PlaneGeometry's uv attribute goes [0,1] across the quad.
    // This maps directly to glyph-space [0,1]² for band/curve evaluation.
    vGlyphUV = uv;

    float colorBlend = gScale.w;
    vColor = mix(instanceColor * gColor.rgb, gColor.rgb, colorBlend);
    vGroupAlpha = gColor.a;

    int hx = gl_InstanceID % 1024;
    int hy = gl_InstanceID / 1024;
    vec4 highlight = texelFetch(highlightTexture, ivec2(hx, hy), 0);
    vAddedColor = highlight.rgb;
}
```

**Why `flat` on the offset varyings:** Curve/band offsets are integers that are the same for every fragment in the quad. `flat` uses the provoking vertex value and avoids interpolation, which would corrupt integer data. This is required — not optional.

**Why `vGlyphUV` rather than re-deriving in fragment:** The fragment shader needs a coordinate in glyph space [0,1]² to determine which bands the pixel falls in. The PlaneGeometry's `uv` attribute already provides this for free — no extra math.

---

## 4. Slug Fragment Shader

### WebGL 2 Constraints on Curve Data Format

No SSBOs in WebGL 2. All curve data lives in textures. The Slug reference format uses float16 for control points. WebGL 2 supports `HALF_FLOAT` for texture internal format `R16F`, `RG16F`, `RGBA16F` (requires `EXT_color_buffer_half_float` on some drivers, native on most current hardware). The safer fallback is `R32F`/`RG32F` at double the memory, still viable given the tiny total size (~50KB for a code font). The band texture uses `RG16UI` (native WebGL 2, no extension needed).

For the shader, `usampler2D` with `texelFetch` gives exact integer reads — correct for both UINT curve packing and band index tables.

### Loop Divergence Cap

GLSL ES 3.0 requires loops to have a constant or uniform upper bound visible at compile time — dynamic loop lengths based on varyings are implementation-defined and produce driver-dependent behavior on some GPUs. The standard Slug approach is to use a `MAX_BANDS` constant and break early.

```glsl
#define MAX_BANDS 32         // compile-time cap; real count from vBandCount
#define MAX_CURVES_PER_BAND 64
```

If a glyph exceeds these caps it renders incorrectly but doesn't crash — add an assertion in SlugEncoder that panics on over-budget glyphs.

### Winding Number Algorithm

Slug uses a ray-casting winding number, not the simple even-odd rule. For quadratic Beziers, the standard approach (Lengyel's equivalence class method) classifies each curve's contribution via the sign of the cross product of the ray direction with the curve's tangent at intersection. This avoids the numerical problems of direct root-finding.

The fragment shader in condensed form:

```glsl
precision highp float;
precision highp int;

uniform usampler2D curveTexture;   // packed curve control points
uniform usampler2D bandTexture;    // band→curve index table

flat in int vCurveStart;
flat in int vCurveCount;
flat in int vBandStart;
flat in int vBandCount;
in vec2 vGlyphUV;      // [0,1]² glyph-local coordinate
in vec3 vColor;
in float vGroupAlpha;
in vec3 vAddedColor;

out vec4 fragColor;

// Unpack float16 control point from packed uint16 texel.
// Layout: one quadratic bezier per two texels:
//   texel N:   (x0, y0, x1, y1) — start + control point
//   texel N+1: (x2, y2, ?,  ?)  — end point in .xy
float unpackCoord(uint bits) { return float(bits) / 65535.0; }

// Returns the winding number contribution of one quadratic Bezier
// against a horizontal ray cast from p in the +x direction.
// p is in [0,1]² glyph space. Curve endpoints in same space.
int windingContrib(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    // Translate to p-relative coords
    vec2 a = p0 - p, b = p1 - p, c = p2 - p;
    // Parametric: Q(t) = (1-t)^2*a + 2t(1-t)*b + t^2*c
    // Find t where Q.y == 0 (ray y == 0)
    float A = a.y - 2.0*b.y + c.y;
    float B = a.y - b.y;            // note: standard: -2*(b.y - a.y)/2
    float C = a.y;
    // Solve At^2 - 2Bt + C = 0 — using discriminant
    float disc = B*B - A*C;
    if (disc < 0.0) return 0;
    float sqrtDisc = sqrt(disc);

    int winding = 0;
    // Two roots (may coincide)
    for (int k = 0; k < 2; k++) {
        float t = (k == 0) ? (B - sqrtDisc) / A : (B + sqrtDisc) / A;
        if (t < 0.0 || t > 1.0) continue;
        // Intersection x at parameter t
        float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
        if (x < 0.0) continue;  // left of ray origin — doesn't cross ray
        // Winding direction: sign of tangent.y at t
        float dy = 2.0*((b.y - a.y)*(1.0-t) + (c.y - b.y)*t);
        winding += (dy > 0.0) ? 1 : -1;
    }
    return winding;
}

void main() {
    vec2 p = vGlyphUV;

    // Find which horizontal band this pixel is in.
    // Bands partition the [0,1] y-range into equal strips.
    // bandCount bands → band index = floor(p.y * vBandCount)
    int bandIdx = clamp(int(p.y * float(vBandCount)), 0, vBandCount - 1);
    int globalBandIdx = vBandStart + bandIdx;

    // Fetch the curve range for this band from bandTexture.
    uvec4 bandData = texelFetch(bandTexture, ivec2(globalBandIdx % 1024, globalBandIdx / 1024), 0);
    int bandCurveStart = int(bandData.x);
    int bandCurveCount = int(bandData.y);

    int winding = 0;

    for (int i = 0; i < MAX_CURVES_PER_BAND; i++) {
        if (i >= bandCurveCount) break;

        int ci = (vCurveStart + bandCurveStart + i) * 2;  // 2 texels per curve
        uvec4 t0 = texelFetch(curveTexture, ivec2((ci)   % 1024, (ci)   / 1024), 0);
        uvec4 t1 = texelFetch(curveTexture, ivec2((ci+1) % 1024, (ci+1) / 1024), 0);

        vec2 cp0 = vec2(unpackCoord(t0.x), unpackCoord(t0.y));
        vec2 cp1 = vec2(unpackCoord(t0.z), unpackCoord(t0.w));
        vec2 cp2 = vec2(unpackCoord(t1.x), unpackCoord(t1.y));

        // Early exit: curves sorted by max-y within band.
        // If this curve's min-y is above the pixel, remaining curves can't intersect.
        float maxY = max(cp0.y, max(cp1.y, cp2.y));
        if (maxY < p.y) break;

        winding += windingContrib(p, cp0, cp1, cp2);
    }

    // Winding number != 0 means inside the glyph.
    // Antialiasing: use partial coverage near 0 (sub-pixel transition).
    float coverage = clamp(abs(float(winding)), 0.0, 1.0);

    if (coverage < 0.01 && vGroupAlpha < 0.01) discard;

    vec3 finalColor = clamp(vColor * coverage + vAddedColor, 0.0, 1.0);
    fragColor = vec4(finalColor, coverage * vGroupAlpha);
    if (fragColor.a < 0.01) discard;
}
```

**Notes on this sketch:**
- The `windingContrib` handles the degenerate `A == 0.0` case (linear segment) by falling through with `disc < 0` when A is tiny — a real implementation needs an explicit linear branch.
- The `unpackCoord` above uses uint16 normalized to [0,1] in glyph-space. SlugEncoder must normalize all control points to the glyph bounding box before packing.
- The two-discard pattern (early coverage + final alpha) matches the current fragment shader's behavior, preserving group visibility via `vGroupAlpha`.

---

## 5. How Existing Systems Survive

### Highlight Texture (RGBA8, gl_InstanceID-indexed)

Zero changes. The highlight system indexes by `gl_InstanceID % 1024 / 1024` — this is independent of glyph content, atlas, or curve data. The vertex shader continues to fetch from `highlightTexture` and pass `vAddedColor` to the fragment shader. The fragment shader adds `vAddedColor` to final color identically. `setGlyphHighlight(bufferSlotIndex, color)` and `updateAddedColor(id, color)` are unaffected.

### Group DataTexture (4-column, groupTexture)

Zero changes. The group system reads `instanceGroupId`, looks up `groupTexture`, applies offset/scale/color/visibility. The vertex shader retains all three group texture lookups. Group API (`createGroup`, `setGroupOffset`, `setGroupColor`, `setGroupVisibility`) is unaffected because it writes to `_groupData` / `_groupTexture`, which Phase 3 does not modify.

### Picking — Cell Mode

Cell mode picking uses `PICKING_VERTEX_CELL` which reads only: `instancePosition`, `instanceSize`, `instanceGroupId`, `groupTexture`, `groupTextureHeight`, `uBasePickingId`. It does not read `instanceCodepoint` or `atlasMapTexture`. Cell mode picking **requires zero changes** — it already doesn't depend on atlas data.

### Picking — Glyph Mode

`PICKING_VERTEX_GLYPH` reads `instanceCodepoint`, `atlasMapTexture`, `atlasMapWidth`, `atlasMapHeight` and `PICKING_FRAGMENT_GLYPH` samples `atlasTexture`. After Phase 3, all of these uniforms are gone.

**Decision**: Glyph-mode picking must be rewritten for Slug. The replacement samples coverage from the Slug winding number instead of atlas alpha. This is the only picking system change Phase 3 requires.

The new glyph-mode picking vertex shader reads `instanceGlyphId` and passes `vGlyphUV` + flat curve/band offsets identically to the main vertex shader. The picking fragment shader runs the winding number computation and discards on `coverage < 0.01` instead of `atlas alpha < 0.01`. The picking ID encoding (RGB 24-bit) is unchanged.

`registerRenderer()` in PickingSystem constructs picking material uniforms by reading from `mesh.material.uniforms`. After Phase 3, the referenced atlas uniforms are gone, so the glyph-mode branch of `registerRenderer()` must reference `curveTexture`, `bandTexture`, and `glyphMapTexture` instead.

---

## 6. Performance Budget

### ALU Cost

At 8-16px glyph height (typical zoomed-out code view), each glyph covers 64–256 pixels. A code font glyph averages ~12 curves. With band organization partitioning into 8 horizontal bands, each pixel evaluates ~1-3 curves in its band before early exit.

Expected instruction count per pixel vs current:
- Current atlas: ~5 instructions (sample + multiply + add + compare + discard)
- Slug at 8px: ~15-40 instructions (band lookup + 2-3 curve evaluations)
- Slug at 16px: ~20-60 instructions (band lookup + 3-5 curve evaluations)

At 10,000 instances × 64 pixels average = 640,000 fragments/frame. Modern mobile GPUs execute ~200-400 million fragment instructions/sec. 640K fragments × 50 avg instructions = 32M instructions — well within budget. This is conservative; `GridVirtualizer` culls ~97% of grids so typical draw counts are much lower.

### Memory

Removing `atlasTexture` (16MB RGBA8) is the dominant change. The Slug textures total ~50KB for a code font. GPU texture cache pressure drops by 300x — this likely improves atlas path performance too, since the 16MB atlas fits poorly in L2 texture cache.

### needsUpdate Patterns

No change to the update pattern. `_groupTexture.needsUpdate` is set only when a group property changes (O(1) texel write). `_highlightTexture.needsUpdate` is set on `setGlyphHighlight` calls. The new `curveTexture`, `bandTexture`, and `glyphMapTexture` are built once in SlugEncoder and never written again per frame — they get `needsUpdate = true` once on upload and are static thereafter.

---

## 7. What Gets Deleted from GlyphRenderer

| Item | Lines | Reason |
|------|-------|--------|
| `_createAtlasTexture()` | ~15 | Bitmap atlas generation |
| `this.texture = atlas.getSharedThreeTexture(THREE)` | 1 | Atlas texture reference |
| `atlasMapTexture` uniform setup in `_createInstanceMesh()` | ~5 | UV lookup texture |
| `atlasMapWidth`, `atlasMapHeight` uniforms | 2 | UV lookup dims |
| `atlasTexture` uniform | 1 | Bitmap sampler |
| `_syncAtlasMapDimensions()` | ~10 | Atlas growth sync |
| `_ensureGlyphsInAtlas()` | ~10 | Pre-flight atlas insertion |
| `atlas.checkAndClearTextureUpdate()` call in `render()` | ~4 | Deferred atlas upload |
| `instanceCodepoint` attribute (rename to `instanceGlyphId`) | 1 | Rename |
| `vUV` varying (replace with `vGlyphUV` + flat int offsets) | — | Shader varyings |
| Fragment shader body (entire) | ~8 | Replaced by Slug loop |
| `GlyphAtlas` import | 1 | No atlas |

**Constructor signature changes**: `atlas` parameter becomes `slugData` (a `SlugEncoder` result containing the three textures). The `skipPrealloc` option and batch modes are unaffected.

---

## 8. GlyphRenderer Wiring

The renderer needs three new uniform slots set at construction time, populated from a `SlugData` object that Phase 2 (SlugEncoder) produces:

```javascript
// In _createInstanceMesh(), replace atlas uniform block with:
const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
        curveTexture:       { value: slugData.curveTexture },    // usampler2D RG16UI
        bandTexture:        { value: slugData.bandTexture },     // usampler2D RG16UI
        glyphMapTexture:    { value: slugData.glyphMapTexture }, // usampler2D RGBA16UI
        glyphMapWidth:      { value: slugData.glyphMapWidth },
        glyphMapHeight:     { value: slugData.glyphMapHeight },
        groupTexture:       { value: this._groupTexture },
        groupTextureHeight: { value: this._maxGroups },
        highlightTexture:   { value: null }  // set after first flush
    },
    vertexShader: this._getVertexShader(),
    fragmentShader: this._getFragmentShader(),
    transparent: true,   // Slug computes alpha — needs blending
    depthWrite: true,
    side: THREE.DoubleSide
});
```

Note `transparent: true` — the Slug fragment shader computes a real alpha (coverage), unlike the atlas path which used `alphaTest: 0.01` with `transparent: false`. Blending must be active or antialiased edges appear solid.

The `instanceCodepoint` attribute rename to `instanceGlyphId` is a one-line change in `_createInstanceMesh()` and all three `_rebuildAllInstances()` / `applyPrebuiltBuffers()` write paths.

---

## 9. Texture Format Decision

| Texture | Internal Format | Three.js Type | Rationale |
|---------|----------------|---------------|-----------|
| `curveTexture` | RGBA16UI | `THREE.UnsignedShortType` + `THREE.RGBAIntegerFormat` | 4 uint16 per texel → pack (x0,y0,x1,y1) per curve in one texel instead of two, halves texture reads |
| `bandTexture` | RG16UI | `THREE.UnsignedShortType` + `THREE.RGIntegerFormat` | (curveStart, curveCount) per band |
| `glyphMapTexture` | RGBA16UI | `THREE.UnsignedShortType` + `THREE.RGBAIntegerFormat` | (curveStart, curveCount, bandStart, bandCount) per glyph |

All three use `THREE.NearestFilter`, `generateMipmaps = false`. Integer formats use `texelFetch` not `texture()` — `texelFetch` is correct for both (it bypasses filtering).

`RGBAIntegerFormat` and `RGIntegerFormat` exist in Three.js r150+ alongside `THREE.GLSL3`. Verify `gl.RGBA16UI` is exposed in the target Three.js version before shipping.

The curve shader sketch above uses RG16UI with two texels per curve. Switching to RGBA16UI with one texel per curve halves the `texelFetch` count in the inner loop — this is the preferred layout.

---

## 10. Constants to Add (`src/core/constants.js`)

```javascript
export const SLUG_LIMITS = {
    maxBandsPerGlyph: 32,        // compile-time loop cap in fragment shader
    maxCurvesPerBand: 64,        // compile-time loop cap
    glyphMapTextureWidth: 1024,  // same pattern as atlasMapTexture
    curveTextureWidth: 1024,
    bandTextureWidth: 1024,
};
```

These constants feed both the GLSL `#define` values (injected as shader header) and SlugEncoder's validation assertions.
