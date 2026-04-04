# Phase 0: GPU Shader Pipeline Analysis
**Agent**: GPU Shader Pipeline
**Scope**: Vertex shader math, quad geometry, UV mapping, picking shader parity, group scale interaction

---

## 1. Geometry Setup

`_createInstanceMesh()` (GlyphRenderer.js ~line 217) uses `new THREE.PlaneGeometry(1, 1)`.

Three.js `PlaneGeometry(1,1)` emits four vertices:
```
(-0.5, -0.5, 0)   bottom-left
( 0.5, -0.5, 0)   bottom-right
(-0.5,  0.5, 0)   top-left
( 0.5,  0.5, 0)   top-right
```
UVs are `(0,0) (1,0) (0,1) (1,1)` — a unit square from 0 to 1.

The base `position` attribute in the vertex shader therefore ranges from -0.5 to +0.5 in X and Y.

---

## 2. The Main Vertex Shader Transform

Full transform sequence (GlyphRenderer.js `_getVertexShader()`, line ~325):

```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);

float v = (instanceGroupId + 0.5) / groupTextureHeight;
vec4 gPos   = texture(groupTexture, vec2(0.125, v));
vec4 gColor = texture(groupTexture, vec2(0.625, v));
vec4 gScale = texture(groupTexture, vec2(0.875, v));

vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
```

### Step-by-step math

**Step 1: Scale the quad**

`scaled = position * vec3(instanceSize, 1.0)`

With `instanceSize = (W, H)` where W is `glyphWidth * scale` and H is `charHeight * scale`:
```
scaled.x ranges from  -W/2  to  +W/2
scaled.y ranges from  -H/2  to  +H/2
```
The scaled quad is centered at the origin.

**Step 2: Translate**

`worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz`

With group defaults `gScale = (1,1,1,0)` and `gPos = (0,0,0,1)`:
```
worldPos.x = scaled.x + instancePosition.x
           = (instancePosition.x - W/2)  ..  (instancePosition.x + W/2)
```

The rendered quad spans `[instancePosition.x - W/2, instancePosition.x + W/2]`.

---

## 3. The Core Bug: instancePosition Is the Left Edge

In `buildBatchBuffers()` (workers/builders/index.js line ~397) and `buildGlyphBuffers()` (line ~151), the position written to the buffer is the cursor `x` at the moment of rendering — the LEFT EDGE of the glyph cell:

```js
positions[idx * 3] = x;          // x = left edge cursor
positions[idx * 3 + 1] = y;
positions[idx * 3 + 2] = z;

sizes[idx * 2] = glyphWidth * scale;
sizes[idx * 2 + 1] = scaledHeight;

// then: x += glyphWidth * scale + metrics.letterSpacing
```

The cursor `x` is initialized to `pos.x` (the text origin) and advances by `glyphWidth * scale + letterSpacing` after each glyph. It is never offset by `glyphWidth / 2` before writing. This is unambiguously the left edge.

**The quad the shader renders spans:**
```
left  = instancePosition.x - W/2
right = instancePosition.x + W/2
```
where `instancePosition.x` is the left edge and `W = instanceSize.x = glyphWidth * scale`.

**Therefore the rendered quad spans:**
```
left  = leftEdge - W/2
right = leftEdge + W/2
```

**But the correct span should be:**
```
left  = leftEdge
right = leftEdge + W
```

This is a systematic half-width shift to the left. Every glyph's rendered quad is offset by `-W/2` from where the builder intended it. Visually, text still appears coherent because all glyphs shift by the same fraction of their own width, but the rendered geometry does NOT align with the logical glyph cell boundaries tracked by the picking/highlight system.

**Quantified displacement**: For a glyph with `glyphWidth = 0.3` world units, the quad is shifted left by `0.15` world units from its cell boundary. This is large enough to cause column-level misalignment in hover/picking.

---

## 4. Why This Has Been Invisible Until Now

Before proportional glyph widths were introduced (post-grapheme migration), `instanceSize.x` was the same for every glyph — `metrics.charWidth`. The shift was constant and uniform across all glyphs. With uniform character widths:
- All quads shift left by the same amount (`charWidth / 2`)
- Picking ray-casts against a target that is also `charWidth / 2` left of the cursor boundary
- The first character of any row has its left edge at `startX - charWidth/2`, which may partially overlap the column before

With proportional widths after the grapheme migration:
- Wide grapheme clusters (emoji, CJK, multi-codepoint sequences) have large `W`, so their shift is large
- Narrow glyphs (`.`, `i`, `:`) have small `W`, so their shift is small
- Adjacent glyphs now have DIFFERENT displacements, causing inter-glyph gaps and overlaps in the picking geometry relative to the visual geometry

---

## 5. UV Mapping Analysis

The atlas UV rect for a glyph is `(u0, v0_webgl, u1, v1_webgl)` after pre-flipping in `GlyphAtlas.getAtlasMapTexture()`:
```js
data[base]     = uv.u0;
data[base + 1] = 1.0 - uv.v1;  // pre-flip V: bottom edge in WebGL coords
data[base + 2] = uv.u1;
data[base + 3] = 1.0 - uv.v0;  // pre-flip V: top edge in WebGL coords
```

In the shader:
```glsl
vec4 uvRect = texture(atlasMapTexture, vec2(tx, ty));
vUV = mix(uvRect.xy, uvRect.zw, uv);
```

The `uv` varying from PlaneGeometry ranges (0,0) at bottom-left to (1,1) at top-right. `mix(uvRect.xy, uvRect.zw, uv)`:
- At `uv = (0,0)`: `vUV = uvRect.xy = (u0, v0_webgl)`  — bottom-left of atlas rect
- At `uv = (1,1)`: `vUV = uvRect.zw = (u1, v1_webgl)`  — top-right of atlas rect

This is correct. The glyph image is mapped onto the quad proportionally. Because both the image and the quad are centered on `instancePosition`, the visual appearance is self-consistent — the rendered image IS centered on `instancePosition.x`. The image would need to be shifted if the quad geometry shift is corrected.

**Important**: The atlas `u0`/`u1` are computed from `x + uvInsets.horizontal` to `x + glyphWidth - uvInsets.horizontal` where `x` is the pixel-space shelf cursor. This UV rect captures only the rendered ink region. The width in atlas UV space (`u1 - u0`) corresponds to `glyphWidth - 2*uvInsets.horizontal` pixels. Since the shader stretches this to fill `instanceSize.x = glyphWidth * scale`, minor inset trimming is absorbed by scaling and does not cause the centering bug.

---

## 6. Picking Vertex Shader: Exact Parity

`PICKING_VERTEX_CELL` (PickingSystem.js line ~41):
```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);
// ... group lookups ...
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
```

`PICKING_VERTEX_GLYPH` (PickingSystem.js line ~83):
```glsl
vec3 scaled = position * vec3(instanceSize, 1.0);
// ... group lookups ...
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
```

Both picking shaders are **byte-for-byte identical** to the main vertex shader in their position computation. The same `-W/2` offset applies to all three. This means:

- The picking pass renders quads in exactly the same position as the main render pass.
- There is NO picking vs. visual misalignment introduced by shader divergence.
- The picking system correctly identifies which glyph the mouse is over relative to the rendered quads.
- The bug is in the relationship between the rendered quad positions and the `lineSlotOffsets` / column-index coordinate system used by `highlightRange()`.

When `highlightRange()` computes which buffer slot corresponds to a (line, col) coordinate pair, it uses `lineSlotOffsets[line] + col`. This slot index addresses the highlight texture. The highlight system then illuminates the glyph quad centered at `instancePosition.x`. The question is whether the highlight texel region matches what the user perceives as the glyph's screen position. Because picking and rendering are in sync, a mouse click on a rendered glyph returns the correct slot — but the highlight painted on that slot covers a quad that is shifted left by `W/2` from the cell's left boundary, which the user sees as illuminating the wrong character when the caller specifies a column index directly (e.g., from a language server token range).

---

## 7. Group Scale Interaction

The transform is:
```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

`scaled = position * vec3(instanceSize, 1.0)` is computed before the group scale is applied. Group scale `gScale.xyz` multiplies only `instancePosition`, not `scaled`. This means:

- `instanceSize` (the quad dimensions) is NOT scaled by group scale.
- Only the translation of `instancePosition` is scaled.

**Consequence when `gScale != (1,1,1)`:**

Suppose `gScale.x = 2.0`, `instancePosition.x = 5.0`, `W = 0.3`:

- Main render: `scaled.x ∈ [-0.15, +0.15]`, `worldPos.x ∈ [5.0*2 - 0.15, 5.0*2 + 0.15] = [9.85, 10.15]`
- The quad renders at x=10 with width 0.3 (not 0.6)

The group scale fan-out spreads glyph positions but does not proportionally scale glyph sizes. This creates gaps between glyphs that widen as scale increases. However, since picking uses the same formula, the picking quads match the rendered quads exactly. There is no picking misalignment from group scale per se — but layout-level column calculations would be invalidated because the world-space position of slot N no longer corresponds to `startX + N * charWidth`.

For the default group (gScale = (1,1,1)), this has no effect.

---

## 8. The Correct Fix: Shift the Quad Right by W/2

To align the rendered quad's left edge with `instancePosition.x`, the vertex shader needs:

```glsl
// Current (centered on instancePosition):
vec3 scaled = position * vec3(instanceSize, 1.0);
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;

// Fixed (left-aligned to instancePosition):
vec3 scaled = position * vec3(instanceSize, 1.0);
vec3 offset = vec3(instanceSize.x * 0.5, 0.0, 0.0);
vec3 worldPos = scaled + offset + instancePosition * gScale.xyz + gPos.xyz;
```

The `offset` shifts the centered quad right by half its own width, so:
```
left  = instancePosition.x - W/2 + W/2 = instancePosition.x
right = instancePosition.x + W/2 + W/2 = instancePosition.x + W
```

This change must be applied identically in all three shaders:
1. `GlyphRenderer._getVertexShader()`
2. `PICKING_VERTEX_CELL` in PickingSystem.js
3. `PICKING_VERTEX_GLYPH` in PickingSystem.js

Alternatively, the builder could be changed to emit `instancePosition.x = cursorX + glyphWidth/2` (center position instead of left edge), which keeps the shader unchanged. The builder change would be simpler but requires adjusting every consumer that reads `instancePosition` back as a left-edge (e.g., `updatePosition`, bounds calculations, `lineSlotOffsets`-based column mapping).

**The shader fix is the lower-risk change** because it is localized to three GLSL strings and does not affect any data in memory.

---

## 9. Summary Table

| Property | Value |
|---|---|
| PlaneGeometry vertex range | -0.5 to +0.5 (unit quad, centered at origin) |
| `scaled` X range | `[-W/2, +W/2]` where `W = instanceSize.x` |
| `instancePosition.x` convention | Left edge of glyph cell (cursor before advance) |
| Rendered quad left edge | `instancePosition.x - W/2` (shifted left by W/2) |
| Rendered quad right edge | `instancePosition.x + W/2` |
| Expected left edge | `instancePosition.x` |
| Bug magnitude | `-W/2` per glyph, varies with proportional width |
| Main vs. picking shader divergence | None — both use identical `worldPos` formula |
| Group scale effect on quad size | None — `gScale` scales position only, not `instanceSize` |
| UV mapping correctness | Correct given current centering convention |
| Safe fix location | Add `vec3(instanceSize.x * 0.5, 0.0, 0.0)` to `worldPos` in all 3 shaders |
