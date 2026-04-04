# Round 2: encoding reviews rendering, plumbing (inverse)

## Reaffirm or Retract

### Reaffirmed: 4 texels per glyph in glyphMapTexture — RETRACTED

My Phase 0 specified RGBA32F with 4 texels per glyph (Section 6). Both plumbing (Round 1) and rendering (Round 1) argued for 1 texel RGBA16UI. I retract the 4-texel design. The key argument I missed: if curves are already normalized to [0,1] in glyph-local space, and `vGlyphUV = uv` maps the PlaneGeometry's UV directly to that same [0,1] space, then bbox data is not needed at runtime in the shader. My rationale for including bbox was to support the mapping from advance-width UV space to visual-bbox UV space. But for monospace fonts (Cousine), the advance width IS the visual width — the glyph does not overhang. The bbox becomes a build-time validation assertion, not a shader input.

**New position**: 1 texel per glyph, RGBA16UI: `(curveStart, curveCount, bandTableStart, bandCount)`. This matches what the vertex shader actually reads (4 uint16 values as flat int varyings). The savings are real: 4 texels x 16 bytes x 200 glyphs = 12.8 KB wasted on data the shader never reads.

### Reaffirmed: curveTexture RGBA16F — RETRACTED

My Phase 0 specified RGBA16F with `DataView.setFloat16()`. Both reviewers converged on RGBA16UI with `uint16 / 65535.0` normalization. I retract RGBA16F for two reasons:

1. `DataView.setFloat16()` is Baseline 2025 but unavailable on Android Chrome <121 (Jan 2024). The project has no polyfill infrastructure and no build step — a runtime TypeError on older browsers with no fallback is unacceptable.
2. RGBA16UI achieves the same effective precision for [0,1] normalized coordinates: 65536 levels vs Float16's 1024 levels in [0,1]. RGBA16UI is actually MORE precise, not less. I had this backwards.

**New position**: RGBA16UI for curveTexture, `usampler2D` + `texelFetch`, unpack via `float(bits) / 65535.0`. Two texels per curve (6 coordinates cannot fit in 4 channels — rendering's Section 9 claim of 1 texel per curve is wrong, but the Section 4 shader sketch correctly uses 2 texels).

### Reaffirmed: MAX_BANDS = 16

All three agents converge. Rendering proposed 32 as a compile-time cap; encoding and plumbing both analyzed the actual curve counts (~20/glyph for Cousine) and concluded 16 is generous. Rendering's Round 1 did not push back on 16. This is resolved: `MAX_BANDS = 16`, `MAX_CURVES_PER_BAND = 64`.

### Reaffirmed: [0,1] normalization per-glyph bbox

My Phase 0 normalization scheme survives the RGBA16UI switch cleanly. Normalized coordinates in [0,1] pack to uint16 via `Math.round(value * 65535)` and unpack in the shader via `float(bits) / 65535.0`. The only question was whether the normalization target should be the visual bbox or the advance-width cell. With the monospace assumption (advance == visual width for Cousine), both coincide. I now normalize to the advance-width cell, not the visual bbox, so `vGlyphUV = uv` maps directly with no remapping.

## Evolved Understanding

### The band texture two-region indexing problem (from rendering Round 1)

Rendering (Round 1, E2 in rendering-reviews-plumbing-encoding) raised a critical indexing ambiguity: the band texture contains both band headers and curve-index entries, but the fragment shader uses a single global index without knowing where one region ends and the other begins.

My Phase 0 design (Section 6) specified a 2-level lookup:
1. `glyphMapTexture[glyphId]` yields `bandTableStart`
2. `bandTexture[bandTableStart + bandIdx]` yields `(entryStart, entryCount)`
3. `bandTexture[entryStart + j]` yields curve indices

The problem: steps 2 and 3 both index into `bandTexture` but into different regions. `bandTableStart` is an absolute offset into the header region; `entryStart` is an absolute offset into the entry region. Both share one texture. The fragment shader needs to know whether an index refers to a header or an entry — and it does, because the access paths are distinct. Step 2 always reads headers (via `bandTableStart` from glyphMap). Step 3 always reads entries (via `entryStart` from the header just fetched). There is no ambiguity at the GLSL level; the confusion arose from the rendering shader sketch omitting step 2 and using `vBandStart + bandIdx` directly, which collapses the two regions.

**Resolution**: The `glyphMapTexture` field should be named `bandHeaderStart` (not `bandStart`) to clarify it points at the header region. The rendering vertex shader must pass this value. The fragment shader does:
```
bandHeader = texelFetch(bandTexture, bandHeaderStart + bandIdx)
entryStart = bandHeader.x
entryCount = bandHeader.y
for j in 0..entryCount: curveIdx = texelFetch(bandTexture, entryStart + j).x
```

The rendering shader sketch collapsed this into one level by making `vBandStart` point directly at a flat curve list, which eliminates per-band early-exit (you lose the per-band curve count). The 2-level approach is correct and I reaffirm it.

### The vGlyphUV mapping with advance-width normalization

Plumbing's `buildShapedBuffers` sets `instanceSize.x = advance * scaleFactor` (line 361 of Phase 0). The PlaneGeometry is a unit quad scaled by `instanceSize` in the vertex shader. Its UV attribute goes [0,1] across that quad. If I normalize curve coordinates to [0,1] within the advance width (not the visual bbox), then `vGlyphUV = uv` maps directly to the normalized coordinate space with no remapping. This is cleaner than my Phase 0 design, which normalized to the visual bbox and required bbox data in the shader to undo it.

For glyphs whose visual bbox is narrower than the advance (most characters have left/right bearings), the [0,1] normalized curves will occupy a sub-range like [0.05, 0.95] within the UV space. Pixels in the bearing zones get winding number 0 and are discarded. This is correct behavior — the bearing zones are intentionally empty.

For glyphs that overhang their advance (italic 'f', some ligatures), curves would map outside [0,1] in UV space. For Cousine (upright monospace), this never happens. Add a build-time assertion: `if (bbox.xMax > advance || bbox.xMin < 0) warn(...)`.

## Convergence

All three agents now agree on:

1. **Texture formats**: All three textures use unsigned integer formats (`RGBA16UI` or `RG16UI`) with `usampler2D` and `texelFetch`. No float textures, no `sampler2D` for Slug data, no `DataView.setFloat16()`.

2. **Curves: 2 texels per curve in RGBA16UI**. The rendering Section 9 claim of 1 texel per curve is impossible (6 coords, 4 channels) and is superseded by the Section 4 shader sketch that uses 2 texels. Packing: `[P0.x, P0.y, P1.x, P1.y]`, `[P2.x, P2.y, _, _]`.

3. **GlyphMap: 1 texel per glyph in RGBA16UI**: `(curveStart, curveCount, bandHeaderStart, bandCount)`. No bbox in the shader.

4. **MAX_BANDS = 16, MAX_CURVES_PER_BAND = 64**.

5. **`transparent: false`** with explicit `if (coverage < threshold) discard;` in the fragment shader. No `alphaTest` uniform (Slug computes its own coverage), no `transparent: true` (avoids depth-sort overhead).

6. **Linear fallback in `windingContrib`** for degenerate quadratics (A == 0) is mandatory, not optional.

7. **ESM patching of vendored hb.js/hbjs.js** is a blocking step during vendoring, not a "verify later" task.

8. **`glyphExtents()` method on HarfBuzzShaper** must be added for SlugEncoder's build-time bbox validation.

9. **Space glyphs** have curveCount = 0, the shader gets winding 0, pixel is discarded. Plumbing skips them in the buffer builder (no instance emitted). Both paths are consistent.

## Remaining Tensions

### 1. Band texture layout: flat vs 2-region

My Phase 0 and plumbing's Round 1 assume a 2-region band texture (headers + entries). Rendering's shader sketch uses a flat layout where `vBandStart + bandIdx` directly indexes a flat array of `(curveStart, curveCount)` pairs — one pair per band, with `curveStart` being an absolute offset into `curveTexture`.

The flat layout is simpler but loses per-band granularity: every band for a glyph stores the same `curveStart` (the glyph's global curve pool start), and `curveCount` is the count of curves in THAT band (not the whole glyph). This works if the encoder writes per-band curve lists (duplicating curve data across bands). The 2-region layout avoids duplication by storing curve indices.

**My position**: The 2-region design is more memory-efficient but adds one extra `texelFetch` per band in the inner loop. For 3-5 bands per pixel, that is 3-5 extra fetches. The flat layout costs more memory (duplicate curve indices) but has one fewer indirection level. For code fonts with ~20 curves and ~5 bands, the duplicate entries are small (~100 extra uint16 values per glyph). The flat layout wins on simplicity. I concede this point to rendering's design IF the `bandTexture` stores `(absoluteCurveTexelOffset, curveCount)` per band, not relative offsets. This must be explicit.

### 2. Advance-width normalization vs visual-bbox normalization

I conceded this above (normalize to advance width), but it introduces a subtlety: the Y-axis normalization base. The advance width defines the X-axis cell, but what defines Y? The plumbing doc uses `lineHeight` (ascender - descender + lineGap) for `instanceSize.y`. If I normalize Y coordinates to [0, lineHeight] (in font units), then `vGlyphUV.y` maps correctly. But most glyphs do not span the full line height — a lowercase 'a' sits in the x-height zone. Pixels above and below get winding 0 and discard, which is correct.

The tension: should normalization use the advance-width cell `[0, advance] x [descender, ascender]` or the visual bbox? The advance-width cell is consistent with `vGlyphUV = uv` but wastes shader cycles evaluating pixels in empty regions (bearings, above ascender, below baseline). The visual bbox is tighter but requires bbox data in the shader for UV remapping.

**My position**: Use the advance-width cell. The wasted cycles are minimal — the band lookup immediately shows 0 curves in empty bands, and the early exit fires. The implementation simplicity of `vGlyphUV = uv` with no remapping outweighs the few extra band lookups on empty pixels.

### 3. Antialiasing strategy

Rendering (Round 1) correctly identified that `clamp(abs(float(winding)), 0.0, 1.0)` produces binary coverage — the winding number is an integer, so `abs(winding)` is 0 or >= 1, never fractional. There is no sub-pixel AA. The Slug algorithm's AA comes from computing signed distance to the nearest curve edge and `smoothstep`-ing within a pixel-width band.

This is not resolved. The three options:
- **Binary discard** (`coverage >= 1.0 ? 1 : discard`): simplest, matches current `alphaTest` quality, no AA.
- **`fwidth`-based AA**: compute `fwidth(vGlyphUV)` to get the screen-space derivative, find the nearest curve edge distance, `smoothstep` within +-0.5px. This is Slug's actual AA technique. Adds ~10 ALU instructions per pixel.
- **MSAA**: let the GPU's multisampling handle it. The fragment shader still does binary in/out, but MSAA samples multiple points per pixel. Requires MSAA render target (already available via `renderer.setPixelRatio` or explicit MSAA configuration).

**My position**: Ship Phase 3 with binary discard. Add `fwidth`-based AA in a follow-up. The shader sketch should include a commented-out AA block showing the intended approach, so the follow-up is mechanical. MSAA is orthogonal and can be enabled independently.

## Synthesis

The format contract is now locked: three RGBA16UI textures, `usampler2D`, `texelFetch`, coordinates packed as `uint16 = Math.round(normalizedValue * 65535)`. This single decision eliminates the largest class of cross-document inconsistencies.

The remaining implementation-blocking items are:

1. **Linear fallback in `windingContrib`**: Every L and Z segment produces A == 0. The shader MUST have:
   ```glsl
   if (abs(A) < 1e-5) {
       // Linear: solve 2Bt = C → t = C / (2B)
       if (abs(B) > 1e-5) {
           float t = C / (2.0 * B);
           if (t >= 0.0 && t <= 1.0) {
               float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
               if (x >= 0.0) {
                   float dy = 2.0*((b.y - a.y)*(1.0-t) + (c.y - b.y)*t);
                   winding += (dy > 0.0) ? 1 : -1;
               }
           }
       }
       return winding;
   }
   ```

2. **Early-exit sort axis correction**: Rendering's shader tests `maxY < p.y` for early exit in the curve loop (line 264 of Phase 0). But horizontal bands partition Y; curves within an hBand should be sorted by X-extent for early exit along the +X ray. My Phase 0 sorts by `xMax` (Section 3, line 74). The shader's early-exit test should be `if (minX > p.x) break;` — if a curve's minimum X exceeds the pixel's X, no subsequent curves (sorted ascending by xMax) can intersect the rightward ray. Plumbing Round 1 identified this same error. The rendering Phase 0 sketch has the wrong axis.

3. **`texture()` vs `texelFetch()` on `usampler2D`**: The vertex shader (line 127 of rendering Phase 0) uses `texture(glyphMapTexture, vec2(tx, ty))` on a `usampler2D`. This is a GLSL ES 3.0 compile error. Must be `texelFetch(glyphMapTexture, ivec2(int(mapCol), int(mapRow)), 0)`. Plumbing Round 1 caught this too.

4. **ESM patching of vendored files**: Append `export default createHarfBuzz;` to `hb.js` and `export default hbjs;` to `hbjs.js`. Without this, `import` fails silently or with a SyntaxError in browser ESM context. This is step 1 of vendoring, before any integration testing.

## Dissent

### Against rendering's picking rewrite scope assessment

Rendering (Phase 0, Section 5) states glyph-mode picking "must be rewritten for Slug" and proposes duplicating the full winding-number computation in the picking fragment shader. I dissent on the scope. The picking fragment shader does not need AA, does not need color, and does not need highlight blending. It needs exactly one bit: is this pixel inside the glyph or not? The picking fragment shader should be a stripped-down version — band lookup, winding accumulation, `if (winding == 0) discard;`, then emit the picking ID. No coverage math, no `fwidth`, no color varyings. The vertex shader for glyph-mode picking needs the same flat int varyings (curveStart, curveCount, bandHeaderStart, bandCount) and `vGlyphUV`, plus `uBasePickingId`. That is it.

The rendering doc's claim that `registerRenderer()` "must reference `curveTexture`, `bandTexture`, `glyphMapTexture`" is correct but understates the change: the glyph-mode picking material is a separate `ShaderMaterial` with its own uniform block. It does not share the main material — it replaces it during the picking pass (material-swap pattern, verified at `PickingSystem.js` line 266-270). The picking material must be constructed with the Slug texture uniforms at `registerRenderer()` time, not patched onto the existing material.

### Against plumbing's `fontBuffer.slice(0)` as Transferable pattern

Plumbing (Phase 0, line 243) sends `fontBuffer.slice(0)` as a Transferable for each worker. Rendering (Round 1, P1) correctly identified that this copies-then-transfers, which is pointless — structured clone without transfer is simpler and equally fast at ~100KB. I agree with rendering. The pattern should be:

```js
worker.postMessage({ type: 'INIT_FONT', jobId, payload: { fontBuffer, wasmUrl } });
```

No Transferable list. The browser copies the ArrayBuffer via structured clone. The main thread keeps its reference for SlugEncoder. The per-worker `.slice(0)` ceremony is unnecessary complexity.
