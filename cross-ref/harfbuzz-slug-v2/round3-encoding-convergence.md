# Round 3: encoding convergence

## Settled

1. **All three Slug textures use RGBA16UI with `usampler2D` + `texelFetch`.** I retract my RGBA16F position from Phase 0 and Round 1. Plumbing retracted it in Round 2. Rendering held RGBA16UI throughout. The deciding arguments: (a) sampler-type uniformity — one `usampler2D` type for all three textures eliminates cross-uniform misassignment bugs; (b) `DataView.setFloat16()` is Baseline 2025 but absent on Android Chrome <121, and this project has no build step or polyfill infrastructure; (c) RGBA16UI provides 65536 levels of precision in [0,1], actually exceeding Float16's 1024 mantissa levels. Packing: `Math.round(value * 65535)`. Unpacking: `float(bits) / 65535.0`.

2. **1 texel per glyph in glyphMapTexture (RGBA16UI).** Fields: `(curveStart, curveCount, bandHeaderStart, bandCount)`. I retract my Phase 0 4-texel RGBA32F design. Bbox is not needed in the shader because curves are normalized to [0,1] within the advance-width cell, and `vGlyphUV = uv` maps directly. Build-time assertion: `if (bbox.xMax > advance || bbox.xMin < 0) warn(...)`.

3. **2 texels per curve in curveTexture.** Packing: `[P0.x, P0.y, P1.x, P1.y]`, `[P2.x, P2.y, _, _]`. All coordinates [0,1] normalized. 6 floats cannot fit in 4 channels — rendering's Section 9 claim of 1 texel/curve was always wrong.

4. **MAX_BANDS = 16, MAX_CURVES_PER_BAND = 64.** All three agents converged in Round 1 and reaffirmed.

5. **`transparent: false` with explicit `if (coverage < 0.01) discard;`.** No `alphaTest` uniform (Slug computes its own coverage). No `transparent: true` (breaks depth-sort for overlapping CodeGrids). AA deferred to Phase 4.

6. **Linear fallback in `windingContrib` is mandatory.** Every L segment and every closing Z produces a degenerate quadratic where A=0. The shader must branch on `abs(A) < 1e-5` and solve the linear case.

7. **ESM patching at vendoring time.** Append `export default createHarfBuzz;` to `hb.js` and `export default hbjs;` to `hbjs.js` as part of the vendoring script, not deferred to integration time.

8. **`glyphExtents(glyphId)` added to `HarfBuzzShaper`.** One-line delegation: `return this._font.glyphExtents(glyphId);`. Required for SlugEncoder's build-time bbox validation.

9. **Advance-width normalization, not visual-bbox.** Curves normalized to `[0, advance] x [descender, ascender]` mapped to [0,1]. Bearing zones get winding 0 and discard. `vGlyphUV = uv` works with no remapping.

10. **curveTexture and bandTexture width: 1024.** I retract my Phase 0 width of 256. Width 1024 matches the existing highlight texture convention and reduces row count.

11. **Space glyphs: curveCount = 0, winding = 0, discard.** Plumbing skips spaces in buffer builder (no instance emitted). Both paths consistent.

12. **SlugEncoder runs on main thread only.** Produces shared DataTextures set as uniforms. Workers only do HarfBuzz shaping + instance buffer packing.

13. **Rename `instanceCodepoint` to `instanceGlyphId`** and builder output field `codepoints` to `glyphIds` in one commit. No transition period.

14. **Band texture uses flat layout** (one texel per band: `absoluteCurveTexelOffset, curveCount, _, _`), not the 2-region header+entry design from my Phase 0. I concede to rendering's simpler approach. The memory cost of duplicate curve indices across bands is negligible for code fonts (~100 extra uint16 values per glyph). The benefit: one fewer indirection level in the fragment shader inner loop (4 texelFetch per curve instead of 5).

15. **Early-exit in hBand traversal tests X-axis, not Y.** Curves within an hBand sorted ascending by `minX`. Shader breaks when `curve.minX > p.x`. Rendering's Phase 0 sketch had `maxY` — wrong axis.

16. **`texture()` replaced with `texelFetch()` everywhere for `usampler2D`.** Rendering's vertex shader sketch used `texture()` on `glyphMapTexture` — GLSL ES 3.0 compile error.

17. **fontBuffer sent via structured clone, not Transferable.** At ~100KB, `.slice(0)` + transfer is unnecessary ceremony. Workers get a copy via structured clone; main thread keeps its reference for SlugEncoder.

18. **Pre-count pass in `buildShapedBuffers` eliminated.** Allocate worst-case (`allShapedGlyphs.length`), write into pre-allocated arrays, truncate to actual `idx`. Eliminates double `glyphOutline()` calls.

## Implementation Plan

### Phase 1: Vendoring + Shaping Layer

**`vendor/harfbuzz/` (new directory)**
- Copy `hb.wasm`, `hb.js`, `hbjs.js` from `node_modules/harfbuzzjs/`
- Patch `hb.js`: append `export default createHarfBuzz;`
- Patch `hbjs.js`: append `export default hbjs;`

**`src/shaping/HarfBuzzShaper.js` (new file)**
```js
export default class HarfBuzzShaper {
  constructor(hb) { this._hb = hb; this._blob = null; this._face = null; this._font = null; }
  loadFont(fontBuffer) { /* blob, face, font from hb */ }
  shape(text) { /* returns [{g: glyphId, ax: advanceX, ay: advanceY, dx, dy}, ...] */ }
  glyphOutline(glyphId) { return this._font.glyphToJson(glyphId); }
  glyphExtents(glyphId) { return this._font.glyphExtents(glyphId); }
  destroy() { /* font.destroy(), face.destroy(), blob.destroy() */ }
}
```

**`src/shaping/index.js` (new file)** — re-exports HarfBuzzShaper, SlugEncoder.

### Phase 2: SlugEncoder

**`src/core/constants.js` (modify)** — add:
```js
export const SLUG_LIMITS = {
  MAX_BANDS: 16,
  MAX_CURVES_PER_BAND: 64,
  TEXTURE_WIDTH: 1024,
};
```

**`src/shaping/SlugEncoder.js` (new file)**

Core method signatures:
```js
export default class SlugEncoder {
  constructor(shaper, options = {}) { /* shaper: HarfBuzzShaper */ }
  encode(glyphIds) {
    // Returns { curveTexture, bandTexture, glyphMapTexture, stats }
    // All THREE.DataTexture, RGBA16UI, usampler2D-compatible
  }
  encodeGlyph(glyphId) {
    // 1. shaper.glyphOutline(glyphId) -> segments
    // 2. Parse M/L/Q/Z into quadratic beziers (throw on C)
    // 3. Compute bbox from control points
    // 4. Normalize curves to [0,1] within advance-width cell
    //    X: [0, advance], Y: [descender, ascender]
    //    Assert bbox.xMax <= advance for monospace
    // 5. organizeBands(normalized, bandCount)
    // 6. Return { curves, bands, bbox }
  }
}
```

Band organization (flat layout):
```js
// Per glyph, per band: store (absoluteCurveTexelOffset, curveCount)
// Curves sorted ascending by minX within each hBand
// bandTexture texel: [curveTexelOffset_0, curveTexelOffset_1, ..., count] 
// Actually: one RGBA16UI texel per band = (curveTexelStart, curveCount, _, _)
// The curve indices within a band are written as consecutive entries
// after the band headers, each entry = absolute texel offset into curveTexture
```

Texture construction (all use `internalFormat = 'RGBA16UI'`, `NearestFilter`, no mipmaps):
```js
// curveTexture: Uint16Array, width 1024, height = ceil(totalTexels / 1024)
// bandTexture: Uint16Array, width 1024, flat layout
// glyphMapTexture: Uint16Array, width 1024, 1 texel per glyphId
```

### Phase 3: Rendering + Picking Integration

**`src/GlyphRenderer.js` (modify)**

Changes:
1. Add uniforms: `uCurveTexture`, `uBandTexture`, `uGlyphMapTexture` (all `usampler2D`)
2. Rename `instanceCodepoint` attribute to `instanceGlyphId` in `_createInstancedGeometry()`
3. Replace vertex shader: read glyphMap via `texelFetch`, pass flat int varyings (`vCurveStart`, `vCurveCount`, `vBandStart`, `vBandCount`) + `vGlyphUV`
4. Replace fragment shader: band lookup + winding number accumulation + binary coverage + discard
5. Keep `transparent: false`, `depthWrite: true`
6. Remove atlas texture uniform (replaced by Slug textures)
7. Highlight DataTexture and group DataTexture: unchanged

Fragment shader winding core (non-obvious):
```glsl
int windingContrib(vec2 a, vec2 b, vec2 c, vec2 p) {
  // Translate so p is origin
  a -= p; b -= p; c -= p;
  float A = a.y - 2.0*b.y + c.y;
  float B = a.y - b.y;
  float C = a.y;
  if (abs(A) < 1e-5) {
    // Degenerate quadratic = line segment
    if (abs(B) < 1e-5) return 0; // horizontal
    float t = C / (2.0 * B);
    if (t < 0.0 || t > 1.0) return 0;
    float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
    if (x < 0.0) return 0;
    float dy = 2.0*((b.y-a.y)*(1.0-t) + (c.y-b.y)*t);
    return (dy > 0.0) ? 1 : -1;
  }
  float disc = B*B - A*C;
  if (disc < 0.0) return 0;
  float sqrtDisc = sqrt(disc);
  int w = 0;
  for (int s = 0; s < 2; s++) {
    float t = (s == 0) ? (B - sqrtDisc)/A : (B + sqrtDisc)/A;
    if (t < 0.0 || t > 1.0) continue;
    float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
    if (x < 0.0) continue;
    float dy = 2.0*((b.y-a.y)*(1.0-t) + (c.y-b.y)*t);
    w += (dy > 0.0) ? 1 : -1;
  }
  return w;
}
```

**`src/picking/PickingSystem.js` (modify)**

Changes to glyph-mode picking:
1. `PICKING_VERTEX_GLYPH`: same flat int varyings as main vertex shader + `vGlyphUV` + `uBasePickingId`
2. `PICKING_FRAGMENT_GLYPH`: stripped-down winding shader — band lookup, winding, `if (winding == 0) discard;`, emit picking RGB. No color, no highlight, no AA.
3. `registerRenderer()`: picking material constructed with Slug texture uniforms at registration time
4. Replace all 4 atlas-referencing lines (lines 73-116, 267-272 in current PickingSystem.js)

**`src/workers/builders/buildBuffers.js` (modify)**

1. Rename output field `codepoints` to `glyphIds`
2. Replace pre-count pass with worst-case allocation + truncation
3. `glyphOutline()` calls cached in a `Map<glyphId, boolean>` for the visibility check (is this a renderable glyph with curves?)

**`src/workers/builders/textToGlyphs.js` (modify)**

1. Accept shaped glyph array `[{g, ax, ay, dx, dy}]` instead of doing per-character codepoint lookup
2. Use per-glyph advance widths from shaping result, not atlas charWidths

**`src/collections/CodeGrid.js` (modify)**

1. Update `applyPrebuiltBuffers` to destructure `glyphIds` instead of `codepoints`

**`src/index.js` (modify)**

1. Add exports: `HarfBuzzShaper`, `SlugEncoder` from `src/shaping/index.js`

### Files NOT modified
- `src/collections/GridVirtualizer.js` — frustum culling is renderer-agnostic
- `src/collections/GridLayoutManager.js` — spatial layout unaffected
- `src/semantic/` — SemanticInfoMap keying unchanged (still charIndex-based)
- `src/components/MinimapOverlay.js` — reads scene graph, not renderer internals
- Highlight DataTexture — format and `setGlyphHighlight()` API unchanged
- Group DataTexture — unchanged

### Files to delete (Phase 3 cleanup)
- `src/GlyphAtlas.js` — replaced by HarfBuzz shaping + Slug encoding (defer deletion until Slug is validated; keep as fallback during development)
- `src/GlyphAtlasLoader.js` — prebaked atlas no longer relevant
- `src/shaders/textVertex.glsl`, `src/shaders/textFragment.glsl` — reference copies of old shaders

## Implementer Vote

**Plumbing** should implement. Their Phase 0 covers the widest cross-cutting surface: `HarfBuzzShaper`, `buildShapedBuffers`, worker initialization, and the data flow from font load through buffer construction to GPU upload. The converged plan's most complex integration work is in the plumbing layer — wiring SlugEncoder textures into GlyphRenderer, updating the builder pipeline, and connecting HarfBuzzShaper to the existing worker system. The rendering agent's strength is the shader, but the shader is fully specified in this document (winding core, linear branch, early-exit). The encoding agent's strength is SlugEncoder, but SlugEncoder is a self-contained class with a clear API that any agent can implement from the spec. The plumbing agent is best positioned to sequence the cross-file integration correctly.
