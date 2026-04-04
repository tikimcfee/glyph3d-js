# Round 1: encoding reviews plumbing, rendering

## Errors Found

### 1. Rendering: curveTexture format contradicts itself and contradicts encoding

Rendering (Section 9, line 396) declares `curveTexture` as `RGBA16UI` with `UnsignedShortType + RGBAIntegerFormat`, then proposes packing `(x0,y0,x1,y1)` per curve in one texel. But one quadratic bezier has 3 control points = 6 coordinates. Four uint16 values cannot hold 6 floats. The section header says "halves texture reads" versus the earlier sketch (Section 4, line 254) that uses two texels per curve with `RG16UI`.

Encoding specifies `RGBA16F` (Float16) for curves: 2 texels per curve, `[P0.x, P0.y, P1.x, P1.y]` and `[P2.x, P2.y, _, _]`. This is the correct layout -- 6 coordinates cannot fit in 4 channels.

**Verdict**: Rendering's Section 9 claim about one-texel-per-curve RGBA16UI is wrong. Two texels per curve is required. The fragment shader sketch in Section 4 uses two texels and is correct.

### 2. Rendering: texture format mismatch between usampler2D and RGBA16F

Rendering Section 2 (line 60-62) declares all three textures as `usampler2D` (unsigned integer sampler). Encoding specifies `curveTexture` as `RGBA16F` (float half) and `glyphMapTexture` as `RGBA32F`. Float textures require `sampler2D`, not `usampler2D`. Only `bandTexture` (RGBA16UI) uses `usampler2D`.

The rendering fragment shader (line 202) uses `unpackCoord(uint bits)` which implies unsigned integer data, but encoding's RGBA16F stores actual IEEE 754 half-floats that would be sampled as `float` via `sampler2D`. These two designs are incompatible.

**Verdict**: Either all textures go integer (RGBA16UI with explicit [0, 65535] normalization as encoding's fragment sketch partially implies), or curveTexture stays RGBA16F and the shader uses `sampler2D` + `texelFetch` returning `vec4` of floats. Encoding's normalization to [0,1] with Float16 storage is the cleaner path -- the shader simply reads floats directly. Rendering must change `usampler2D curveTexture` to `sampler2D curveTexture` if we keep RGBA16F.

### 3. Rendering: glyphMapTexture format disagrees with encoding

Encoding Section 6 specifies `glyphMapTexture` as `RGBA32F` with 4 texels per glyph (16 floats total: curveStart, curveCount, bandCounts, bbox, bandTableStarts, reserved). Rendering Section 9 specifies it as `RGBA16UI` with 1 texel per glyph (4 uint16: curveStart, curveCount, bandStart, bandCount).

These are fundamentally different designs. Encoding's 4-texel layout carries bbox data needed for UV-to-glyph-space mapping. Rendering's 1-texel layout omits bbox entirely, relying on `vGlyphUV = uv` (line 135) which assumes the PlaneGeometry UV [0,1] maps directly to glyph [0,1] space.

**Verdict**: If coordinates are normalized to [0,1] per-glyph before packing (as encoding specifies), then `vGlyphUV = uv` is correct and bbox is not needed in the shader -- the vertex shader scales the quad via `instanceSize` and the normalized curves cover [0,1] in glyph-local space. But the glyph's visual bbox may not match its advance width (e.g., an italic 'f' that overhangs). Encoding stores bbox for this reason. Rendering's simplification works only for monospace fonts where advance == bbox width. This is acceptable for Cousine but must be documented as a monospace assumption.

### 4. Rendering: windingContrib division-by-zero when A == 0

The `windingContrib` function (line 206-232) divides by `A` without checking for zero. When a curve degenerates to a line (which encoding explicitly creates for L segments and closing paths), `A = a.y - 2*b.y + c.y` will be exactly zero because `b = midpoint(a,c)`. The function notes this at line 285 ("needs an explicit linear branch") but the code will produce NaN/Inf on every degenerate quadratic.

**Verdict**: This is a guaranteed runtime bug, not an edge case. Every L segment and every closing Z segment produces degenerate quadratics. The linear branch is required, not optional.

### 5. Plumbing: `shaper.font.glyphExtents(glyphId)` uses wrong access path

Plumbing Section "Data Flow to Phase 2" (line 389-404) calls `shaper.font.glyphExtents(glyphId)`. But `HarfBuzzShaper` stores the font object as `this._font` (private). The public API wraps methods like `glyphOutline()` and `glyphAdvance()`. There is no `shaper.font` property exposed -- the class correctly encapsulates `_font`. The data flow sketch should use `shaper.glyphExtents(glyphId)` after adding a `glyphExtents()` method to the `HarfBuzzShaper` class (which it currently does not define).

**Verdict**: Add `glyphExtents(glyphId)` to `HarfBuzzShaper` alongside the existing `glyphOutline()` and `glyphAdvance()` methods.

### 6. Plumbing: ESM import of CJS hb.js may not work in raw browser serving

Plumbing acknowledges this (line 55) but understates the severity. The project serves raw ES modules with no bundler (`"type": "module"`, no build step). `hb.js` uses `module.exports = createHarfBuzz` (UMD). Browsers do not support CJS `module.exports` in `<script type="module">` or `import` statements. The ESM wrapper `import createHarfBuzz from './hb.js'` will fail with a syntax error in Chrome/Firefox/Safari.

**Verdict**: The vendored `hb.js` must be patched to add `export default createHarfBuzz;` at the end (or the UMD guard replaced with ESM export). Same for `hbjs.js`. This is not "verify at integration time" -- it is a blocking requirement that must be documented as step 1 of vendoring.

## Gaps

### Encoding covers, others miss:
- **Cubic-to-quadratic conversion strategy**: Encoding explicitly throws on C segments and documents why (TrueType-only at launch). Neither plumbing nor rendering addresses what happens if a user loads a CFF font.
- **Shared-endpoint optimization analysis**: Encoding explains why NOT to exploit shared endpoints (band reordering breaks adjacency). Rendering assumes random-access curves without justifying why.
- **Band count heuristic**: Encoding provides `ceil(sqrt(curveCount))` clamped to [2,16]. Rendering uses `MAX_BANDS = 32` (line 167), double the encoding cap of 16. These must agree.

### Plumbing covers, others miss:
- **Space glyph handling**: Plumbing (line 296-329) identifies that HarfBuzz emits glyphs for spaces and the builder must detect and skip them. Encoding and rendering never address how space characters render under Slug -- a space glyph has no curves, so `glyphToJson()` returns empty. The fragment shader receives `vCurveCount = 0`, the winding number stays 0, and the pixel is discarded. This is correct behavior but should be explicitly validated.
- **Worker WASM instantiation**: Plumbing details per-thread WASM instantiation. Neither encoding nor rendering addresses whether SlugEncoder should also run in workers (it should not -- it produces shared textures).

### Rendering covers, others miss:
- **`transparent: true` requirement**: Rendering correctly identifies (line 384) that Slug needs `transparent: true` because coverage produces real alpha. The current atlas path uses `transparent: false` + `alphaTest: 0.01`. This changes blending behavior -- depth-sorted transparent rendering is more expensive.
- **Glyph-mode picking rewrite**: Rendering identifies (line 304-310) that glyph-mode picking must be rewritten. Encoding and plumbing do not mention picking.

## Tensions

### 1. curveTexture format: RGBA16F (encoding) vs RGBA16UI (rendering)

Encoding: RGBA16F with `DataView.setFloat16()`, shader reads via `sampler2D`, coordinates are native float in [0,1].
Rendering: RGBA16UI with `usampler2D`, shader unpacks via `float(bits) / 65535.0`.

**Correct position**: Encoding's RGBA16F is cleaner. Float16 has 10 mantissa bits = 1024 levels in [0,1], which is sufficient for glyph curves at sub-pixel precision. Using RGBA16F means the shader reads floats directly with no unpack math. RGBA16UI with manual normalization adds ALU cost per texelFetch for no benefit. However, RGBA16F requires `EXT_color_buffer_half_float` on some mobile GPUs for render-target use -- but these textures are read-only (not render targets), so the extension is not needed. `texelFetch` on RGBA16F textures works natively in WebGL 2.

### 2. glyphMapTexture: 4 texels x RGBA32F (encoding) vs 1 texel x RGBA16UI (rendering)

Encoding stores bbox, band counts, curve offsets, band table offsets across 4 texels. Rendering crams everything into 1 texel with 4 uint16 values.

**Correct position**: Rendering's 1-texel design is workable IF we accept the monospace assumption (advance == visual width). For Cousine this holds. The 4 uint16 values (curveStart, curveCount, bandStart, bandCount) are sufficient for the shader's needs. The bbox data in encoding's design is only needed if the shader must map from advance-width UV space to visual-bbox UV space. With [0,1] normalization and monospace advance, they coincide. Go with rendering's compact 1-texel RGBA16UI, but use `RGBA32UI` if any index exceeds 65535 (unlikely for a code font with <1000 glyphs and <20K curves).

### 3. MAX_BANDS: 16 (encoding) vs 32 (rendering)

Encoding caps at 16 bands per axis. Rendering's shader defines `MAX_BANDS 32`.

**Correct position**: Encoding's analysis shows code fonts average ~20 curves/glyph, making 5-8 bands optimal. 16 is already generous headroom. 32 wastes compile-time loop iterations on GPUs that unroll. Use 16 as the cap, matching encoding. The shader's `MAX_BANDS` define must equal the encoder's cap.

## Recommendations

1. **Resolve curveTexture format**: Adopt RGBA16F (encoding's design). Change rendering's shader from `usampler2D` to `sampler2D` for `curveTexture`. Remove `unpackCoord()` -- `texelFetch` returns float directly.

2. **Fix windingContrib linear branch**: Add explicit `if (abs(A) < 1e-6)` guard that handles the degenerate quadratic as a line segment (single root `t = C / (2*B)`). This is mandatory -- every L and Z segment from harfbuzzjs hits this path.

3. **Unify glyphMapTexture format**: Use RGBA16UI, 1 texel per glyph (rendering's compact design). Drop encoding's 4-texel RGBA32F layout. Encoding's bbox data moves to a build-time assertion (verify advance matches bbox for monospace), not a shader input.

4. **Unify MAX_BANDS to 16**: Change rendering's `#define MAX_BANDS` from 32 to 16. Match encoding's encoder cap. Add SlugEncoder assertion: `if (bandCount > 16) throw`.

5. **Add `glyphExtents()` to HarfBuzzShaper**: Plumbing's class is missing this method. Add it alongside `glyphOutline()` and `glyphAdvance()`. Encoding's SlugEncoder needs it for bbox computation.

6. **Patch vendored hb.js and hbjs.js for ESM**: Append `export default createHarfBuzz;` to `hb.js` and `export default hbjs;` to `hbjs.js` during the vendoring step. Document this as a required modification, not a "verify later" task.

7. **Validate space glyph behavior end-to-end**: Add a test assertion that `glyphToJson(spaceGlyphId)` returns an empty array, `glyphMapTexture` entry has `curveCount = 0`, and the fragment shader discards. This is the happy path but must be verified.

8. **Document the monospace assumption**: The 1-texel glyphMapTexture design (no bbox in shader) only works when glyph visual bbox fits within advance width. Add a SlugEncoder assertion: `if (bbox.xMax > advance) warn('glyph overhangs advance')`. Cousine passes; italic fonts may not.

9. **Address `transparent: true` performance**: Rendering correctly identifies this change. Transparent rendering requires back-to-front sorting or OIT. For instanced geometry this is expensive. Consider keeping `alphaTest` with a Slug-computed binary mask (coverage > 0.5 = opaque, else discard) for the non-antialiased fast path, and `transparent: true` only when AA is desired.

10. **Curve texture width**: Encoding uses 256, rendering uses 1024. Standardize on 1024 (rendering's constants in `SLUG_LIMITS`). Wider textures mean fewer rows, better cache locality for sequential texelFetch.

## Key Insight

The three documents converge on the correct architecture but diverge on data formats in ways that would produce silent shader failures. The most critical disconnect is the curveTexture type: encoding packs Float16 values while rendering's shader reads unsigned integers -- feeding RGBA16F data to a `usampler2D` uniform produces garbage. The fix is mechanical (change the sampler type and drop the unpack function), but it illustrates why the texture format contract between SlugEncoder and the shader must be specified in exactly one place (a shared constants/types module) rather than independently derived by each phase. The `windingContrib` division-by-zero on degenerate quadratics is the only guaranteed runtime crash -- every other issue is a design disagreement that can be resolved before code is written.
