# Round 1: plumbing reviews encoding, rendering

## Errors Found

### Encoding (phase0-encoding.md)

1. **Curve texture format conflict with shader.** Encoding declares `curveTexture` as `RGBA16F` (Float16, line 104) and shows `DataView.setFloat16()` for packing. Rendering declares `curveTexture` as `RGBA16UI` (Uint16 integer, line 394) with a `usampler2D` in the shader and an `unpackCoord()` function that normalizes `uint` to `[0,1]` via `float(bits) / 65535.0` (line 201). These are incompatible: `RGBA16F` is a float format sampled with `sampler2D`, while `RGBA16UI` is an integer format sampled with `usampler2D`. The rendering doc explicitly overrides the encoding doc's format in its Section 9 table -- but the encoding doc's `encode()` return type (line 194) still says `RGBA16F`, and its memory budget (line 291) uses Float16 byte sizes. **One format must be chosen.** The rendering doc's RGBA16UI approach is simpler (normalized uint16 is trivial to pack, no `DataView.setFloat16()` needed, no `EXT_color_buffer_half_float` dependency). The encoding doc must update to match.

2. **glyphMapTexture format conflict.** Encoding declares glyphMapTexture as `RGBA32F` (line 153) with 4 texels per glyph storing floats (bbox in font units, etc.). Rendering declares it as `RGBA16UI` (line 396) with 1 texel per glyph. The 4-texel-per-glyph layout in encoding stores bbox data (texel 1: `bboxXMin, bboxYMin, bboxW, bboxH`) that the rendering shader never reads -- rendering's vertex shader fetches a single texel of 4 uint16 values (line 128-131). **Rendering's 1-texel RGBA16UI is correct for the shader as written.** If bbox data is needed for UV mapping (coordinate denormalization), it must either be packed into the same texel or passed as additional flat varyings from a second texel fetch. The encoding doc's RGBA32F approach is over-engineered for what the shader actually consumes.

3. **`SlugEncoder` constructor takes `hbFont` and `hbFace` directly (line 186).** My plumbing doc wraps these in `HarfBuzzShaper`. The encoding doc bypasses the shaper and reaches into raw harfbuzzjs objects. This creates a coupling to harfbuzzjs internals that the shaper class was designed to hide. `SlugEncoder` should accept `HarfBuzzShaper` and call `shaper.glyphOutline(id)` and `shaper.glyphAdvance(id)` -- functions already defined in the plumbing doc (lines 119, 128). The `glyphExtents()` call on line 389 of my plumbing doc references `shaper.font.glyphExtents(glyphId)` which also leaks the internal `_font`; I should add a `glyphExtents(glyphId)` method to `HarfBuzzShaper`.

4. **Band count heuristic.** Encoding says "8 bands per axis default" (line 305) but also cites Slug's `ceil(sqrt(curveCount))` clamped to [2, 16] which yields ~5 for Cousine (line 96). Rendering uses `MAX_BANDS = 32` (line 167) and `MAX_CURVES_PER_BAND = 64` as compile-time caps but the runtime count flows from `vBandCount`. The default of 8 is fine, but the rendering shader's MAX_BANDS=32 is wider than encoding's cap of 16 -- these must agree or the encoder could produce data the shader silently truncates.

### Rendering (phase0-rendering.md)

5. **`usampler2D` used with `texture()` call in vertex shader.** Line 127: `uvec4 glyphInfo = texture(glyphMapTexture, vec2(tx, ty));` -- but `glyphMapTexture` is declared `uniform usampler2D` (line 92). In GLSL ES 3.0, `usampler2D` requires `texelFetch()`, not `texture()`. `texture()` on an integer sampler is a compile error. This must be `texelFetch(glyphMapTexture, ivec2(int(mapCol), int(mapRow)), 0)`.

6. **`transparent: true` claim (line 384).** The current `GlyphRenderer.js` uses `transparent: false` with `alphaTest: 0.01` (lines 260-261 of `GlyphRenderer.js`). The rendering doc says Slug needs `transparent: true` because it computes real alpha. This is correct for antialiased edges, but changes the render order from opaque (front-to-back, early-Z) to transparent (back-to-front, no early-Z). At 10K instances this may cause overdraw regression. Consider: keep `transparent: false` initially with hard alpha cutoff (coverage >= 0.5 = opaque, else discard), then add MSAA or screen-door transparency later. The rendering doc should note this tradeoff explicitly.

7. **Winding number `A == 0` edge case.** Line 216: `float A = a.y - 2.0*b.y + c.y;` and line 222: `float t = (B - sqrtDisc) / A;`. When A is zero (degenerate quadratic = line segment), this is a division by zero. The doc acknowledges this ("a real implementation needs an explicit linear branch") but the shader sketch does not include the branch. Since this is the actual shader code that will be adapted, the linear fallback must be present or lines in glyph outlines (which are common -- every `L` segment from `glyphToJson` becomes a degenerate quadratic) will produce NaN/Inf.

8. **Early exit direction inverted.** Line 264: `if (maxY < p.y) break;` -- the comment says "curves sorted by max-y within band" but the encoding doc sorts by `sortKey: xMax` for horizontal bands (line 74). These are different axes. Horizontal bands partition Y; curves within an hBand should be sorted by their X extent for early exit along the ray (+X direction). The rendering shader tests Y-max, which is the band partitioning axis, not the ray axis. **The encoding doc's sort key (`xMax`) is correct for +X ray casting.** The rendering shader's early exit test should be `if (curve.minX > p.x) break;` or similar, not a Y comparison.

## Gaps

### Covered by plumbing, missed by encoding and rendering

- **ESM compatibility of vendored files.** Both `hb.js` and `hbjs.js` use CJS (`module.exports`). I identified the specific lines (hb.js line 2: `module.exports=createHarfBuzz`; hbjs.js last 3 lines: `try { module.exports = hbjs; } catch(e) {}`). Neither encoding nor rendering addresses how these files get imported in a `"type": "module"` project served as raw ES modules with no bundler. The `hbjs.js` try/catch will silently fail in browser ESM context, leaving `hbjs` as an undeclared global -- this won't work with `import hbjs from './hbjs.js'`. Both vendored files need `export default` appended.

- **Worker WASM URL resolution.** Workers can't reliably resolve `import.meta.url`-relative paths for WASM loading. My plumbing doc addresses this (main thread computes absolute URL, sends via `INIT_FONT` message). Neither encoding nor rendering mentions worker-side WASM initialization.

### Covered by encoding, missed by plumbing

- **Cubic bezier handling.** Encoding explicitly calls out that CFF fonts produce `C` segments and decides to throw (line 28, 263). My plumbing doc's `glyphOutline()` returns raw `glyphToJson()` output without filtering -- the throw-on-cubic policy should be documented at the shaper level too, or the shaper should filter/throw before returning.

### Covered by rendering, missed by plumbing

- **`instanceCodepoint` rename to `instanceGlyphId`.** Rendering documents this rename across `_createInstanceMesh()`, `_rebuildAllInstances()`, and `applyPrebuiltBuffers()` (line 349, 386). My plumbing doc's `buildShapedBuffers` returns a field called `codepoints` (line 379) for backward compat with `applyPrebuiltBuffers` (which reads `buffers.codepoints` at `GlyphRenderer.js` line 1346). The rename needs to be synchronized: either the builder output field changes to `glyphIds` and `applyPrebuiltBuffers` updates, or the attribute rename is deferred.

## Tensions

1. **Curve texture format: RGBA16F (encoding) vs RGBA16UI (rendering).** Rendering is correct. RGBA16UI with integer normalization (`uint16 / 65535.0`) gives uniform [0,1] precision without Float16 extension concerns. The encoding doc must adopt RGBA16UI. This also eliminates the `DataView.setFloat16()` dependency (Baseline 2025 but not universally available in older browser versions).

2. **GlyphMap layout: 4 texels RGBA32F (encoding) vs 1 texel RGBA16UI (rendering).** Rendering's 1-texel layout is sufficient if bbox data is not needed in the shader. But the fragment shader needs to map from `vGlyphUV` (PlaneGeometry UV) to normalized glyph-space coordinates. If the glyph's visible strokes don't fill the full advance-width quad, `vGlyphUV` won't map to `[0,1]` over the actual bbox -- it maps to `[0,1]` over the advance-width cell. The encoding doc's bbox storage (texel 1) provides the data needed for this remapping. **Resolution:** use 2 texels per glyph in RGBA16UI -- texel 0 for curve/band offsets, texel 1 for bbox (as uint16 in font-unit scale divided by upem). The vertex shader fetches both and passes bbox as flat varyings.

3. **MAX_BANDS: 16 (encoding) vs 32 (rendering).** Use 16. Code font glyphs have ~20 curves; 16 bands is already generous. Lower cap = fewer wasted loop iterations in the shader. Rendering doc's constants (section 10, line 408) should match.

4. **`buildShapedBuffers` output field `codepoints` (plumbing) vs attribute name `instanceGlyphId` (rendering).** The field name in builder output should stay `codepoints` during transition to avoid breaking `applyPrebuiltBuffers` (which destructures `codepoints` at GlyphRenderer.js:1346). The GPU attribute rename happens only in the geometry setup. Document this explicitly to avoid confusion.

## Recommendations

1. **Standardize all three Slug textures as RGBA16UI with `texelFetch`.** One format, one sampler type (`usampler2D`), no float extension worries. Encoding doc updates packing; rendering doc updates `unpackCoord` (already correct); plumbing doc is unaffected.

2. **Fix the vertex shader: replace `texture()` with `texelFetch()` for `glyphMapTexture`.** Integer samplers require `texelFetch`. This is a compile error, not a quality issue.

3. **Add linear fallback in `windingContrib` for `A == 0`.** Every `L` segment from `glyphToJson` produces a degenerate quadratic where A approaches zero. Without the branch, most glyph outlines will render with NaN artifacts.

4. **Fix early-exit sort axis.** Encoding sorts hBand curves by `xMax` (correct for +X ray). Rendering's early-exit tests `maxY` (wrong axis). Align the shader to test against the sorted key.

5. **Add `glyphExtents(glyphId)` to `HarfBuzzShaper`.** Verified at `hbjs.js` line 594-607: returns `{xBearing, yBearing, width, height}`. Expose through the shaper so `SlugEncoder` never touches raw harfbuzzjs objects.

6. **Use 2 texels per glyph in glyphMapTexture** to carry bbox data for UV remapping. The advance-width quad is wider than the visible glyph; without bbox, the winding number test will evaluate coordinates outside the glyph's actual outline region.

7. **Decide `transparent` strategy before implementation.** Prototype with `transparent: false` + `alphaTest: 0.5` first. Measure aliasing. Add MSAA or alpha-to-coverage before switching to `transparent: true` + blending, which changes sort order.

8. **Append `export default` to vendored `hbjs.js`.** The try/catch CJS pattern silently fails in browser ESM. One line fix: `export default hbjs;` after the try/catch block. Same for `hb.js`.

9. **Cap MAX_BANDS at 16 in both encoder and shader.** 32 is wasteful for code fonts.

10. **Keep builder output field as `codepoints` during Phase 1-2.** Rename to `glyphIds` in Phase 3 when the atlas path is deleted and `applyPrebuiltBuffers` is updated simultaneously. Document the semantic change (codepoint -> glyph ID) in the field's JSDoc now.

## Key Insight

The encoding and rendering docs disagree on every texture format -- curveTexture (RGBA16F vs RGBA16UI), glyphMapTexture (RGBA32F vs RGBA16UI), and the curve packing layout (2 texels vs 1 texel per curve). These are not minor details; they determine the GLSL sampler types, the packing code, and the shader's inner loop structure. Until a single authoritative format table is agreed upon and both docs update to match, any code written against either doc will be incompatible with code written against the other. The rendering doc's shader sketch also has two bugs that would prevent compilation or correct output (integer sampler with `texture()`, wrong early-exit axis). These must be fixed before the shader is transcribed to code.
