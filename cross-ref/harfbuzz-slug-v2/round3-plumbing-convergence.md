# Round 3: plumbing convergence

## Settled

1. **All three Slug textures use RGBA16UI.** Encoding retracted RGBA16F in Round 2. Rendering held RGBA16UI throughout. Plumbing retracted RGBA16F preference in favor of sampler-type uniformity (all `usampler2D`, all `texelFetch`). No `DataView.setFloat16` dependency. Unpack in shader: `float(bits) / 65535.0`.
2. **1 texel per glyph in glyphMapTexture (RGBA16UI).** Fields: `(curveStart, curveCount, bandHeaderStart, bandCount)`. Encoding retracted 4-texel RGBA32F. Plumbing retracted 2-texel compromise. Bbox not needed at runtime — advance-width normalization + `vGlyphUV = uv` eliminates remapping.
3. **2 texels per curve in curveTexture.** 6 coordinates cannot fit in 4 channels. Layout: `[P0.x, P0.y, P1.x, P1.y]`, `[P2.x, P2.y, _, _]`.
4. **MAX_BANDS = 16, MAX_CURVES_PER_BAND = 64.** All three agents converged by Round 1.
5. **`transparent: false` + explicit `if (coverage < 0.01) discard;`.** No `transparent: true`. Encoding conceded in Round 2. Depth-write + early-Z preserved for overlapping CodeGrids.
6. **Degenerate quadratic linear branch is mandatory.** Every L segment and closing Z produces A=0. The shader must handle this explicitly, not rely on fallthrough.
7. **ESM patching at vendoring time.** Append `export default createHarfBuzz;` to `hb.js` and `export default hbjs;` to `hbjs.js` during vendoring. Not deferred.
8. **`glyphExtents(glyphId)` on HarfBuzzShaper.** One-line delegation: `return this._font.glyphExtents(glyphId);`. Never expose `_font`.
9. **Attribute rename: `instanceCodepoint` to `instanceGlyphId`.** Builder output field `codepoints` renamed to `glyphIds`. Done in one commit, no transition period.
10. **SlugEncoder runs on main thread only.** Produces shared DataTextures consumed by all renderers. No worker involvement for texture building.
11. **Space glyphs: 0 curves, winding=0, discard.** Builder skips emitting instances for space glyphs (advance cursor only). Both paths consistent.
12. **Advance-width normalization.** Curves normalized to `[0, advance] x [descender, ascender]` mapped to [0,1]. `vGlyphUV = uv` maps directly. Build-time assertion: `if (bbox.xMax > advance) warn(...)`.
13. **Texture widths: 1024.** All three textures use width 1024 with 2D wrap addressing via `ivec2(idx % 1024, idx / 1024)`.
14. **Sub-pixel AA deferred to Phase 4.** Phase 3 ships binary coverage + discard. Visually equivalent to current `alphaTest: 0.01`.
15. **Band texture: flat layout, not 2-region.** Encoding conceded in Round 2. Each band stores `(absoluteCurveTexelOffset, curveCount, _, _)` in RGBA16UI. One `texelFetch` per band, then direct curve fetch. No indirection through an entry region. `vCurveStart` from glyphMapTexture is not used in the fragment shader — `bandCurveStart` is already absolute.
16. **Early-exit in hBand curve loop: test `minX > p.x`.** Curves sorted ascending by `minX` within each hBand. Break when `curve.minX > p.x` — remaining curves are further right and cannot intersect the +X ray.
17. **Font buffer to workers: structured clone, no Transferable.** ~100KB for Cousine; structured clone is simpler and equally fast. No `.slice(0)` ceremony.
18. **Picking cell mode: zero changes.** Picking glyph mode: rewrite vertex+fragment shaders to use Slug textures instead of atlas. Stripped-down winding loop (no AA, no color, no highlight). Separate `ShaderMaterial` constructed at `registerRenderer()` time.
19. **Pre-count pass replaced by worst-case allocation + truncation.** `totalGlyphs = allShapedGlyphs.length`, allocate full, write with `idx`, slice to `idx` at end. Cache `Set<glyphId>` of empty-outline glyphs to avoid redundant `glyphOutline()` FFI calls.

## Implementation Plan

### Phase 1: Vendor HarfBuzz, WASM loading, font delivery, worker init

**New files:**

- `src/shaping/vendor/hb.js` — vendored from `node_modules/harfbuzzjs/hb.js`, ESM-patched (append `export default createHarfBuzz;`)
- `src/shaping/vendor/hbjs.js` — vendored, ESM-patched (append `export default hbjs;`)
- `src/shaping/vendor/hb.wasm` — vendored, untouched
- `src/shaping/vendor/harfbuzz.js` — 10-line ESM wrapper (as in phase0-plumbing)
- `src/shaping/HarfBuzzShaper.js` — WASM init, `shape()`, `glyphOutline()`, `glyphAdvance()`, `glyphExtents()`, `fontExtents()`, `destroy()`
- `src/shaping/index.js` — re-exports `HarfBuzzShaper`
- `src/fonts/Cousine-Regular.ttf` — Apache 2.0 font file

**Modified files:**

- `src/workers/GlyphWorker.js` — add `INIT_FONT` case: instantiate `HarfBuzzShaper`, respond `FONT_READY`
- `src/workers/WorkerBridge.js` — add `async initFont(fontBuffer)`: compute WASM URL from `import.meta.url`, send `{ type: 'INIT_FONT', fontBuffer, wasmUrl }` to all workers (structured clone), await all `FONT_READY` responses
- `cli/relay.go` — add `.ttf` MIME type (`font/sfnt`) to the content-type switch if not auto-detected

**`HarfBuzzShaper.glyphExtents` sketch:**
```js
glyphExtents(glyphId) {
    return this._font.glyphExtents(glyphId);
    // Returns {xBearing, yBearing, width, height} in font units
}
```

### Phase 2: SlugEncoder — curve/band/glyphMap textures

**New files:**

- `src/shaping/SlugEncoder.js` — main thread only. `addGlyph(glyphId, curves, extents, advance)`, `buildTextures()` returning `{ curveTexture, bandTexture, glyphMapTexture, glyphMapWidth, glyphMapHeight }`

**Modified files:**

- `src/core/constants.js` — add `SLUG_FORMATS` and `SLUG_LIMITS`:
```js
export const SLUG_LIMITS = {
    maxBandsPerGlyph: 16,
    maxCurvesPerBand: 64,
    textureWidth: 1024,
};
export const SLUG_FORMATS = {
    // All three: RGBA16UI, usampler2D, texelFetch
    // curveTexture:    2 texels/curve  [P0.x,P0.y,P1.x,P1.y] [P2.x,P2.y,_,_]
    // bandTexture:     1 texel/band    [absCurveTexelOffset, curveCount, _, _]
    // glyphMapTexture: 1 texel/glyph   [curveStart, curveCount, bandHeaderStart, bandCount]
};
```

**SlugEncoder key logic:**
1. For each glyph: parse `glyphToJson` output, convert L/Z to degenerate quadratics, normalize to [0,1] within advance-width cell.
2. Assert no cubics (Cousine is TrueType). Assert `bbox.xMax <= advance`.
3. Organize curves into hBands: `bandCount = clamp(ceil(sqrt(curveCount)), 2, 16)`.
4. Sort curves within each band ascending by `minX`.
5. Write flat band table: one RGBA16UI texel per band with `(absoluteCurveTexelOffset, curveCount, 0, 0)`. The absolute offset points directly into curveTexture (texel index, not byte offset).
6. Pack all curve control points as `Math.round(normalized * 65535)` into `Uint16Array`.
7. Build Three.js `DataTexture` objects: `THREE.RGBAIntegerFormat`, `THREE.UnsignedShortType`, `THREE.NearestFilter`, `generateMipmaps = false`.

### Phase 3: Rendering — shader swap, atlas removal, picking update

**Modified files:**

- `src/GlyphRenderer.js`:
  - Constructor: replace `atlas` parameter with `slugData` (SlugEncoder output).
  - `_createInstanceMesh()`: replace atlas uniforms with `curveTexture`, `bandTexture`, `glyphMapTexture`, `glyphMapWidth`, `glyphMapHeight`. Keep `groupTexture`, `highlightTexture` unchanged. Set `transparent: false`, `depthWrite: true`.
  - `_getVertexShader()`: replace atlas UV lookup with glyphMap `texelFetch` using `ivec2`. Pass `flat int` varyings: `vCurveStart`, `vCurveCount`, `vBandStart`, `vBandCount`. Output `vGlyphUV = uv`.
  - `_getFragmentShader()`: full Slug winding-number loop with: `unpackCoord()`, `windingContrib()` (including linear branch for A=0), band lookup, early-exit on `minX > p.x`, binary coverage, explicit discard.
  - Rename `instanceCodepoint` attribute to `instanceGlyphId` everywhere.
  - Delete: `_createAtlasTexture()`, `_syncAtlasMapDimensions()`, `_ensureGlyphsInAtlas()`, `atlas.checkAndClearTextureUpdate()`, `GlyphAtlas` import.

- `src/picking/PickingSystem.js`:
  - Cell mode: zero changes.
  - Glyph mode: rewrite `PICKING_VERTEX_GLYPH` and `PICKING_FRAGMENT_GLYPH`. Vertex passes same `flat int` curve/band varyings + `vGlyphUV`. Fragment runs stripped-down winding loop (no highlight, no color), discards on `winding == 0`, emits picking RGB ID.
  - `registerRenderer()`: glyph-mode branch references `curveTexture`, `bandTexture`, `glyphMapTexture` from `mesh.material.uniforms` instead of atlas uniforms.

- `src/workers/builders/buildBuffers.js` (or `buildShapedBuffers` in new file):
  - Replace `iterGraphemes()` path with `shaper.shape(line)` per line.
  - Use worst-case allocation + idx truncation (no pre-count pass).
  - Cache `emptyGlyphs = new Set()` to skip `glyphOutline()` on known-empty glyphs.
  - Output field: `glyphIds` (not `codepoints`).
  - `instanceSize.x = advance * scaleFactor` (variable, from HarfBuzz).

- `src/collections/GlyphCollection.js` — update `applyPrebuiltBuffers` destructuring: `glyphIds` instead of `codepoints`.

- `src/collections/CodeGrid.js` — if it references `codepoints` in buffer output, rename to `glyphIds`.

- `src/GlyphAtlas.js` — **not deleted yet**. Kept for fallback during Phase 3 development. Deleted after Phase 3 is validated. (Or deleted in the same commit if confidence is high.)

**Fragment shader `windingContrib` with linear branch:**
```glsl
int windingContrib(vec2 p, vec2 a, vec2 b, vec2 c) {
    float A = a.y - 2.0*b.y + c.y;
    float B = a.y - b.y;
    float C = a.y;
    int winding = 0;

    if (abs(A) < 1e-7) {
        // Degenerate quadratic = line segment
        if (abs(B) < 1e-7) return 0; // horizontal
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
        float t = (k == 0) ? (B - sqrtDisc) / A : (B + sqrtDisc) / A;
        if (t < 0.0 || t > 1.0) continue;
        float x = (1.0-t)*(1.0-t)*a.x + 2.0*t*(1.0-t)*b.x + t*t*c.x;
        if (x < 0.0) continue;
        float dy = 2.0*((b.y - a.y)*(1.0-t) + (c.y - b.y)*t);
        winding += (dy > 0.0) ? 1 : -1;
    }
    return winding;
}
```

**Fragment shader early-exit (corrected axis):**
```glsl
// Curves sorted ascending by minX within each hBand
float curveMinX = min(cp0.x, min(cp1.x, cp2.x));
if (curveMinX > p.x) break; // all remaining curves are further right
```

### Files NOT changed

- `src/core/canvasSize.js` — untouched
- `src/components/MinimapOverlay.js` — untouched
- `src/camera/` — untouched
- `src/semantic/` — untouched (SemanticInfoMap maps tokens to buffer slots, not glyphs)
- `src/collections/GridVirtualizer.js` — untouched
- `src/collections/GridLayoutManager.js` — untouched
- `app/` — untouched (consumes library API, does not reference atlas internals)

## Implementer Vote

**Rendering** should implement. The rendering agent's Phase 0 is the most complete specification of the shader code, GlyphRenderer wiring, and PickingSystem changes — which constitute the largest and most error-prone part of the converged plan. The encoding agent's SlugEncoder work is a dependency but is mechanically derivable from the now-locked format contract. The plumbing work (HarfBuzzShaper, worker init, builder refactor) is well-specified in my Phase 0 and can be implemented by following it directly. The rendering agent is best positioned to own the full integration because they understand the shader/material/uniform lifecycle and the picking system's material-swap pattern from the inside.
