# Phase 0 — Shader & Rendering Analysis: Slug Integration into glyph3d-js

**Perspective:** GPU rendering pipeline, buffer management, shader architecture.
**Sources read:** `src/GlyphRenderer.js`, `src/shaders/textVertex.glsl`, `src/shaders/textFragment.glsl`, `src/picking/PickingSystem.js`, `src/core/constants.js`, `docs/harfbuzz-slug-integration.md`.

---

## 1. Current Shader Architecture

### Vertex Shader

The canonical shader lives in `GlyphRenderer._getVertexShader()` (the `.glsl` files in `src/shaders/` are reference-only).

Two-part job per instance:

**Part A — Quad positioning:**
```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);
vec3 alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0);
vec3 worldPos = scaled + alignOffset + instancePosition * gScale.xyz + gPos.xyz;
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
```
The base geometry is a unit `PlaneGeometry` (-0.5 to 0.5). `instanceSize` scales it to glyph dimensions. `alignOffset` left-aligns the centered quad to the instanced left-edge position. Group transform comes from the DataTexture.

**Part B — Atlas UV computation:**
```glsl
float cp = instanceCodepoint;
float mapCol = mod(cp, atlasMapWidth);
float mapRow = floor(cp / atlasMapWidth);
float tx = (mapCol + 0.5) / atlasMapWidth;
float ty = (mapRow + 0.5) / atlasMapHeight;
vec4 uvRect = texture(atlasMapTexture, vec2(tx, ty));
vUV = mix(uvRect.xy, uvRect.zw, uv);
```
`atlasMapTexture` is a `1024 × N` RGBA Float `DataTexture`. Each texel stores `(u0, v0_webgl, u1, v1_webgl)` — pre-V-flipped UV corners for one glyph's atlas sub-rect. The base quad's `uv` (0..1) is interpolated across the rect via `mix`. Note: `texture()` not `texelFetch()` is used here, which means bilinear filtering noise is possible on texel-boundary lookups. This is worth noting for the Slug replacement.

**Highlight passthrough:**
```glsl
int hx = gl_InstanceID % 1024;
int hy = gl_InstanceID / 1024;
vec4 highlight = texelFetch(highlightTexture, ivec2(hx, hy), 0);
vAddedColor = highlight.rgb;
```
`highlightTexture` is a 1024-wide RGBA8 2D `DataTexture`. `gl_InstanceID` indexes it directly. `texelFetch` is correct here (no interpolation wanted).

### Fragment Shader

```glsl
vec4 texColor = texture(atlasTexture, vUV);
vec4 base = texColor * vec4(vColor, vGroupAlpha);
fragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);
if (fragColor.a < 0.01) discard;
```
Single texture sample. The atlas is a 2048×2048 RGBA8 CanvasTexture with mipmaps and anisotropy. Alpha-test discard is the only antialiasing — at the bitmap's own edges, which are pre-antialiased by Canvas 2D's rendering.

**Total uniforms used today:**
`atlasTexture`, `atlasMapTexture`, `atlasMapWidth`, `atlasMapHeight`, `groupTexture`, `groupTextureHeight`, `highlightTexture`.

---

## 2. Phase A Vertex Shader Changes (HarfBuzz, keep bitmap atlas)

Phase A is surgical — only the advance-width behavior changes. The `instanceCodepoint` attribute keeps the same slot and type (`float`), but it now carries the HarfBuzz numeric glyph ID instead of the Unicode codepoint. `GlyphAtlas` must be updated to key its `atlasMapTexture` by HarfBuzz glyph ID rather than Unicode codepoint.

`instanceSize.x` changes from a fixed monospace cell width to the per-glyph advance from HarfBuzz (`glyph.ax * unitsPerEm / fontUnitsToWorld`). The vertex shader code for quad scaling is **unchanged** — it already reads `instanceSize.x` dynamically. No shader edit is required for Phase A beyond ensuring the atlas map is indexed by shaped glyph ID.

The `alignOffset` calculation:
```glsl
vec3 alignOffset = vec3(instanceSize.x * 0.5, 0.0, 0.0);
```
This already works correctly for variable-width glyphs since it reads from `instanceSize`.

One subtle issue: `x_offset` and `y_offset` from HarfBuzz (diacritic attachment offsets) are currently not plumbed. For code rendering these are rarely needed but to support them fully, either bake them into `instancePosition` at buffer-build time (correct approach — no shader change) or add a `instanceOffset` vec2 attribute (adds 8 bytes/glyph). Baking into `instancePosition` is the right call.

---

## 3. Phase B Vertex Shader Changes (Slug, new fragment shader)

The vertex shader gains two new varyings and loses one:

```glsl
// Remove:
out highp vec2 vUV;  // no longer needed — no atlas

// Add:
out vec2 vGlyphCoord;     // pixel position in glyph-local space [0..1 × 0..1]
flat out int vCurveStart; // start index into curveTexture
flat out int vCurveCount; // number of curve texels for this glyph
flat out int vBandStart;  // start index into bandTexture
flat out int vBandCount;  // number of band texels for this glyph
```

The glyphMapTexture lookup replaces the atlasMapTexture lookup:

```glsl
// New uniform:
uniform sampler2D glyphMapTexture;  // RGBA Float, indexed by glyphId
uniform float glyphMapWidth;
uniform float glyphMapHeight;

// In vertex shader body:
float gid = instanceGlyphId;
float mapCol = mod(gid, glyphMapWidth);
float mapRow = floor(gid / glyphMapWidth);
// texelFetch is preferable here (integer index, no filtering):
ivec2 glyphTexel = ivec2(int(mapCol), int(mapRow));
vec4 glyphInfo = texelFetch(glyphMapTexture, glyphTexel, 0);
// glyphInfo.x = float(curveStart)
// glyphInfo.y = float(curveCount)
// glyphInfo.z = float(bandStart)
// glyphInfo.w = float(bandCount)
vCurveStart = int(glyphInfo.x);
vCurveCount = int(glyphInfo.y);
vBandStart  = int(glyphInfo.z);
vBandCount  = int(glyphInfo.w);
```

`vGlyphCoord` passes normalized position within the glyph's bounding box for curve evaluation:
```glsl
// uv is the base PlaneGeometry 0..1 UV, which already maps correctly
vGlyphCoord = uv;  // x: 0=left edge, 1=right edge; y: 0=bottom, 1=top
```
This is the coordinate the fragment shader evaluates the winding number at.

The `flat` qualifier on the integer outputs is required — these do not interpolate across the quad. Using `flat out int` is valid in GLSL ES 3.00 (WebGL 2).

The `instanceCodepoint` attribute is renamed `instanceGlyphId` — same `float` type, same buffer slot. No geometry or instancing infrastructure changes.

---

## 4. Texture Format Design

### curveTexture — Quadratic Bezier Control Points

**Format:** `THREE.RGBAFormat` + `THREE.HalfFloatType` (HALF_FLOAT in WebGL 2).

**Layout:** Each quadratic bezier needs 3 control points (P0, P1, P2). Pack two per texel pair:
- Texel `2k+0`: `(P0.x, P0.y, P1.x, P1.y)` — float16 × 4
- Texel `2k+1`: `(P2.x, P2.y, unused, unused)` — float16 × 4

Coordinates are in glyph-local space normalized to `[0..1]` over the glyph's bounding box. This avoids needing to know the font's units-per-em in the shader.

```glsl
uniform sampler2D curveTexture;
uniform ivec2 curveTextureDims;  // (width, height) for texelFetch
```

Fetch pattern in fragment shader:
```glsl
ivec2 c0texel = ivec2((curveIdx * 2    ) % curveTextureDims.x,
                      (curveIdx * 2    ) / curveTextureDims.x);
ivec2 c1texel = ivec2((curveIdx * 2 + 1) % curveTextureDims.x,
                      (curveIdx * 2 + 1) / curveTextureDims.x);
vec4 c0 = texelFetch(curveTexture, c0texel, 0);
vec4 c1 = texelFetch(curveTexture, c1texel, 0);
vec2 P0 = c0.xy, P1 = c0.zw, P2 = c1.xy;
```

**Float16 precision:** Half-float has ~3.3 decimal digits of precision. Glyph-local coordinates in [0..1] are safe — sub-pixel artifacts only appear at extreme zoom, which is where Slug's exact math is most needed anyway. Full float32 would cost 2× the memory; float16 is the right call.

**Texture size:** For a code font with ~200 glyphs and ~20 curves average, `200 × 20 × 2 = 8000` texels. A 256×32 HALF_FLOAT RGBA texture covers this with room to spare. Use a power-of-two texture width for optimal cache line alignment.

### bandTexture — Band→Curve Index Mapping

**Format:** `THREE.RGIntegerFormat` + `THREE.UnsignedShortType` (RG16UI).

Each texel: `(curveIndex, maxCoord_packed)` — both uint16.
- `curveIndex`: index into the glyph's local curve array (relative to `vCurveStart`)
- `maxCoord_packed`: the band's maximum coordinate encoded as uint16 (allows early exit)

**Note on WebGL 2 integer textures:** `RG16UI` requires `texelFetch` only (no filtering) and a `usampler2D`. This is supported in WebGL 2 (GLES 3.0) without extensions.

```glsl
uniform usampler2D bandTexture;
uniform ivec2 bandTextureDims;
```

Fetch:
```glsl
uvec2 band = texelFetch(bandTexture, ivec2(bandIdx % bandTextureDims.x,
                                           bandIdx / bandTextureDims.x), 0).xy;
int localCurveIdx = int(band.x);
float maxCoord = float(band.y) / 65535.0;  // decode back to [0..1]
```

### glyphMapTexture — Per-Glyph Curve/Band Offsets

**Format:** `THREE.RGBAFormat` + `THREE.FloatType` — same format as the existing `atlasMapTexture`.

Width: 1024 (matching `atlasMapTexture` for consistency). Height: ceil(maxGlyphId / 1024).

Each texel: `(curveStart, curveCount, bandStart, bandCount)` — stored as floats encoding integers. The vertex shader uses `texelFetch` and casts to `int`.

This texture is CPU-built once during font loading and uploaded as a `DataTexture`. It is updated only when new glyph IDs are encountered (same lazy-regrow pattern as `atlasMapTexture`).

---

## 5. The Instanced Slug Lookup Chain

This is the novel part. Existing Slug implementations (JSlug, slug-webgpu) create one geometry per text string and embed curve offsets directly in vertex attributes or uniform blocks. glyph3d-js must do it differently: 10,000 glyphs in one draw call, potentially thousands of unique glyph IDs.

The full chain per fragment:

```
gl_InstanceID
    │  (passed via flat int from vertex shader, or recomputed)
    ▼
instanceGlyphId  (float attribute, unique per glyph instance)
    │
    ▼ vertex shader texelFetch
glyphMapTexture[glyphId]  →  (curveStart, curveCount, bandStart, bandCount)
    │
    ▼ flat out to fragment
vCurveStart, vCurveCount, vBandStart, vBandCount
    │
    ▼ fragment shader loop
curveTexture[vCurveStart .. vCurveStart + vCurveCount]
bandTexture[vBandStart .. vBandStart + vBandCount]
    │
    ▼
winding number  →  coverage  →  fragColor
```

Key design decision: the `glyphMapTexture` lookup happens in the **vertex shader**, not the fragment shader. This is correct and important — the offsets are uniform across the entire quad for a given instance. Moving the lookup to the fragment shader would repeat it per pixel for no gain. The results are passed as `flat` (non-interpolated) varyings.

Multiple instances of the same glyph (e.g., 'e' appearing 500 times) all look up the same `glyphMapTexture` texel and get identical `(curveStart, curveCount, bandStart, bandCount)`. The curve and band textures are shared across all instances. Only `vGlyphCoord` varies per pixel within each instance.

---

## 6. Slug Fragment Shader in GLSL ES 3.0

### Winding Number Core

```glsl
precision highp float;

uniform sampler2D curveTexture;
uniform usampler2D bandTexture;
uniform ivec2 curveTextureDims;
uniform ivec2 bandTextureDims;

flat in int vCurveStart;
flat in int vCurveCount;
flat in int vBandStart;
flat in int vBandCount;
in vec2 vGlyphCoord;  // [0..1] × [0..1] within glyph bounding box

in vec3 vColor;
in float vGroupAlpha;
in vec3 vAddedColor;
out vec4 fragColor;

// Quadratic bezier winding contribution at point p, ray cast in +x direction
float bezierWinding(vec2 P0, vec2 P1, vec2 P2, vec2 p) {
    // Translate so ray origin = p
    vec2 A = P0 - p, B = P1 - p, C = P2 - p;
    // Check if curve crosses y=0 (horizontal ray)
    float t0 = A.y, t1 = 2.0 * (B.y - A.y), t2 = C.y - 2.0 * B.y + A.y;
    // ... (Lengyel equivalence class algorithm, numerically robust)
    // Returns: -1.0, 0.0, or +1.0
}

void main() {
    vec2 p = vGlyphCoord;
    float winding = 0.0;

    // Determine which band p.x and p.y fall in, then iterate those bands only.
    // vBandStart..vBandCount covers the horizontal bands first, then vertical.
    for (int bi = 0; bi < vBandCount; bi++) {
        int bandIdx = vBandStart + bi;
        uvec2 band = texelFetch(bandTexture,
            ivec2(bandIdx % bandTextureDims.x, bandIdx / bandTextureDims.x), 0).xy;
        int localIdx = int(band.x);
        float maxCoord = float(band.y) / 65535.0;

        // Early exit: if sorted by maxCoord, stop when p is past all curves in band
        // (This is the band algorithm's key optimization)
        if (p.x > maxCoord) break;  // for horizontal bands; y for vertical

        int curveIdx = vCurveStart + localIdx;
        ivec2 t0 = ivec2((curveIdx * 2    ) % curveTextureDims.x,
                         (curveIdx * 2    ) / curveTextureDims.x);
        ivec2 t1 = ivec2((curveIdx * 2 + 1) % curveTextureDims.x,
                         (curveIdx * 2 + 1) / curveTextureDims.x);
        vec4 cp0 = texelFetch(curveTexture, t0, 0);
        vec4 cp1 = texelFetch(curveTexture, t1, 0);
        winding += bezierWinding(cp0.xy, cp0.zw, cp1.xy, p);
    }

    float coverage = clamp(abs(winding), 0.0, 1.0);
    if (coverage < 0.01) discard;

    vec3 col = vColor * coverage;
    col = clamp(col + vAddedColor, 0.0, 1.0);
    fragColor = vec4(col, coverage * vGroupAlpha);
}
```

**No SSBOs.** WebGL 2 does not expose `GL_SHADER_STORAGE_BUFFER_OBJECT`. All glyph data lives in textures accessed via `texelFetch`. This is exactly what JSlug and the HarfBuzz GPU demo do.

**Loop bound.** GLSL ES 3.0 requires that loop bounds be deterministic at compile time or derived from uniform/constant expressions, not varyings. `vBandCount` is a `flat in int` which is technically runtime-varying per draw call invocation. WebGL 2 implementations generally accept this, but a safe fallback is to set a `const int MAX_BANDS_PER_GLYPH = 64` compile-time cap and break early.

**Winding vs coverage.** For filled glyphs, `winding != 0` means inside. The raw winding number gives no antialiasing. True sub-pixel antialiasing requires computing the winding at the fragment center and using the partial coverage at edges — which Slug achieves by evaluating the distance to the nearest curve and converting to a smooth coverage value rather than a hard threshold. The Lengyel reference shader uses analytic coverage from the quadratic bezier parameterization. This is the hardest part to port correctly and should be taken from the EricLengyel/Slug MIT-licensed GLSL.

---

## 7. Interaction with Highlight Texture and Picking

### Highlight texture

The highlight system uses `gl_InstanceID` to index `highlightTexture`:
```glsl
int hx = gl_InstanceID % 1024;
int hy = gl_InstanceID / 1024;
vec4 highlight = texelFetch(highlightTexture, ivec2(hx, hy), 0);
vAddedColor = highlight.rgb;
```
This is **instance-ID-based**, not glyph-ID-based. It is orthogonal to the Slug rendering path and survives Phase B unchanged. The `vAddedColor` varying is added to the final fragment color after winding coverage computation — the same additive overlay as today.

### Picking system

The `PickingSystem` has two modes. The `'cell'` mode picking shader (`PICKING_VERTEX_CELL` + `PICKING_FRAGMENT_CELL`) uses only `instancePosition`, `instanceSize`, and `instanceGroupId` — no atlas, no codepoints. It is **fully compatible with Phase B** with no changes.

The `'glyph'` mode (`PICKING_VERTEX_GLYPH` + `PICKING_FRAGMENT_GLYPH`) reads `instanceCodepoint` and `atlasMapTexture` to alpha-test against the bitmap. After Phase B, `'glyph'` mode needs updating: either replace the atlas alpha-test with a Slug coverage test (pass `glyphId` and do a lightweight winding check), or simply promote `'cell'` mode as the default since glyph-outline picking is rarely needed for code visualization. For Phase B, **drop `'glyph'` mode temporarily** and use `'cell'` only.

---

## 8. WebGL 2 Constraints

| Constraint | Impact |
|---|---|
| No SSBOs | All curve/band data in textures — already the plan |
| Max texture size = 16384 | curveTexture 256×N stays well within; even 10K curves fits in 256×79 |
| `HALF_FLOAT` for curveTexture | Requires `OES_texture_half_float_linear` for filtering, but we use `texelFetch` (NearestFilter only) — no extension needed |
| `RG16UI` integer texture | Requires `texelFetch`, `usampler2D` — valid WebGL 2, no extension |
| `flat` varyings | Valid in GLSL ES 3.0 (WebGL 2) — required for integer varyings |
| Loop with runtime bound | Technically non-conformant; add `MAX_BANDS` compile-time cap as safety |
| `gl_InstanceID` in vertex | Standard WebGL 2, used today — no change |

No extensions beyond standard WebGL 2 are required.

---

## 9. Performance: ALU Cost at Small Glyph Sizes

For code grids, most glyphs render at 8-16 screen pixels tall. At 12px glyph height with ~0.7 aspect ratio, a glyph is roughly 8×12 = 96 pixels. With band early-exit, an average Latin character intersects 2-4 bands, each with 2-4 curves. Per-pixel cost is approximately 4-12 quadratic bezier evaluations.

Each bezier evaluation requires:
- 2 `texelFetch` calls (4 bytes each from HALF_FLOAT cache)
- ~20 ALU ops (subtract, multiply, discriminant, step)

At 96 pixels/glyph, 8 curves average: `96 × 8 × 20 = 15,360 ALU ops/glyph`. At 10,000 glyphs: `153M ALU ops/frame`. Modern GPUs execute hundreds of GFLOP/s — this is well within budget.

The more relevant concern is **texture cache pressure**. Each glyph instance fetches from a different region of `curveTexture` (since different glyph IDs have different offsets). With 200 unique glyph types and 50KB of curve data, the entire `curveTexture` fits in L1 texture cache on any discrete GPU. Even on mobile, the data fits comfortably in L2. This is dramatically better than the current 16MB `atlasTexture`, which causes cache thrashing at high glyph density.

**Atlas vs Slug at 10K glyphs, 12px:** The atlas path reads from a 2048×2048 RGBA8 texture scattered across 10,000 different UV regions — effectively random access into 16MB. The Slug path reads from a 50KB texture with ~200 unique regions, high reuse. **Slug wins on cache at large instance counts.**

The break-even point (where atlas's single sample/pixel is cheaper than Slug's N samples/pixel) depends on GPU architecture. For compute-heavy mobile GPUs, that break-even may be around 30-40px glyph height. Below that, Slug's cache advantage dominates.

### Band Early-Exit Effectiveness

For typical code characters (ASCII, narrow bounding boxes), horizontal bands partition well. A pixel in the center of an 'A' glyph falls in 1-2 horizontal bands containing 3-4 curves — not all 15+ curves that define the full glyph. The vertical-band dual pass catches curves that the horizontal bands miss. Expected average: 3-5 curve evaluations per pixel for code-font Latin characters.

---

## 10. Antialiasing Approach

**Winding number → coverage**: The raw winding number gives a binary inside/outside answer. For smooth edges at arbitrary zoom, the fragment shader must compute how much of the pixel area lies inside the glyph boundary. Slug does this analytically: for each bezier curve that the evaluation ray nearly crosses, the parametric distance is converted to a sub-pixel coverage value.

The Lengyel reference shader computes this as a signed area contribution from each curve crossing, summed to give a coverage in `[0..1]`. The key GLSL function involves solving the quadratic for bezier/ray intersection, computing the parametric `t` at the crossing, and using `fwidth` to estimate pixel footprint.

**Stem darkening**: At very small sizes (under 8px), thin strokes of code-font characters can fall between pixels and nearly disappear. The HarfBuzz GPU demo implements stem darkening: artificially thickens strokes by biasing the winding threshold. For Phase B, skip stem darkening initially — accept sub-8px degradation, which the bitmap atlas already handles poorly anyway. Add it in a follow-up as a uniform `uStemDarken: float`.

**No MSAA dependency**: Slug produces clean antialiasing from the analytic coverage alone, without requiring MSAA render targets. This is important because glyph3d-js uses a standard `WebGLRenderTarget` for picking, and adding MSAA to that path would be expensive.

---

## 11. Phase Transition: What Changes Where

| Component | Phase A change | Phase B change |
|---|---|---|
| `GlyphRenderer._getVertexShader()` | None | Replace atlas lookup with `glyphMapTexture` lookup; add `flat out` curve offset varyings |
| `GlyphRenderer._getFragmentShader()` | None | Full replacement with winding-number evaluator |
| `GlyphRenderer` uniforms | None | Drop `atlasTexture`, `atlasMapTexture`, `atlasMapWidth/Height`; add `curveTexture`, `bandTexture`, `glyphMapTexture`, `curveTextureDims`, `bandTextureDims` |
| `instanceCodepoint` attribute | Rename to `instanceGlyphId` semantically; same float buffer slot | No further change |
| `instanceSize.x` | Variable advance from HarfBuzz | No further change |
| `highlightTexture` + `vAddedColor` | Unchanged | Unchanged — additive overlay still works |
| `groupTexture` + group DataTexture | Unchanged | Unchanged — transform system orthogonal to rendering path |
| Picking `'cell'` mode | Unchanged | Unchanged |
| Picking `'glyph'` mode | Unchanged | Drop or convert to Slug coverage test |

The instancing infrastructure, the group DataTexture system, the highlight DataTexture, and the picking system all survive Phase B intact. Only the glyph-data lookup path and the fragment shading kernel are replaced.
