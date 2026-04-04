# Phase 3 Implementation Summary — Slug Vector Rendering

## What was done

Phase 3 replaces the bitmap atlas rendering path with Slug vector rendering. Glyph shapes are now evaluated per-pixel in the fragment shader via quadratic bezier winding number computation, producing resolution-independent text at any zoom level.

## Files modified

### Core rendering — `src/GlyphRenderer.js`
- **Constructor**: Accepts `options.slugData` (SlugEncoder output) and `options.shaper` (HarfBuzzShaper for sync path). Atlas texture reference (`this.texture`) removed.
- **`setSlugData(slugData, shaper)`**: New method to wire Slug textures post-construction.
- **`_createInstanceMesh()`**: Atlas uniforms (`atlasTexture`, `atlasMapTexture`, `atlasMapWidth`, `atlasMapHeight`) replaced with Slug uniforms (`curveTexture`, `bandTexture`, `glyphMapTexture`, `glyphMapWidth`, `glyphMapHeight`). Attribute `instanceCodepoint` renamed to `instanceGlyphId`. `alphaTest: 0.01` removed (Slug handles coverage via explicit discard).
- **`_getVertexShader()`**: Full rewrite. Reads `glyphMapTexture` via `texelFetch` on `usampler2D`. Passes `flat out int` varyings (`vCurveStart`, `vCurveCount`, `vBandHeaderStart`, `vBandCount`) and `vGlyphUV` to fragment. Group transforms, highlight texture, instancePosition/Size — all preserved unchanged.
- **`_getFragmentShader()`**: Full rewrite. Implements:
  - Band-based spatial partitioning: `bandIdx = clamp(int(p.y * float(vBandCount)), 0, vBandCount - 1)`
  - Per-band curve evaluation via `texelFetch` on `curveTexture` (RGBA16UI, 2 texels/curve)
  - `windingContrib()` function with mandatory linear branch for degenerate quadratics (`abs(A) < 1e-7`)
  - Early-exit: curves sorted by `minX` within band, `break` when `minX > p.x`
  - Binary coverage: `winding != 0 ? 1.0 : 0.0`, explicit `discard` for `coverage < 0.01`
  - Compile-time loop bounds: `MAX_BANDS=16`, `MAX_CURVES_PER_BAND=64`
  - `transparent: false`, `depthWrite: true` — no blending, preserves depth-sort for overlapping CodeGrids
- **`_updateInstanceMesh()`**: References `instanceGlyphId` instead of `instanceCodepoint`.
- **`applyPrebuiltBuffers()`**: Accepts both `glyphIds` (new) and `codepoints` (legacy) field names. Sets `instanceGlyphId` attribute.
- **Deleted methods**: `_createAtlasTexture()`, `_syncAtlasMapDimensions()`, `_ensureGlyphsInAtlas()`.
- **`_rebuildGPUState()`**: Re-uploads Slug DataTextures instead of atlas.
- **`_textToGlyphs()`**: Prefers HarfBuzz shaping when `_shaper` is available. Falls back to atlas-based grapheme iteration for backward compatibility.
- **New `_textToGlyphsShaped()`**: Sync rendering path using HarfBuzz `shape()` per line.

### Picking — `src/picking/PickingSystem.js`
- **Cell mode**: Zero changes (uses `basePickingId + gl_InstanceID`, no glyph content dependency).
- **Glyph mode vertex shader**: Reads `instanceGlyphId` and `glyphMapTexture` via `texelFetch`. Passes `flat out int` curve/band varyings + `vGlyphUV`.
- **Glyph mode fragment shader**: Runs stripped-down `windingContrib` loop (same algorithm as main shader). Discards on `winding == 0`. Emits 24-bit picking ID. No color, no highlight, no AA.
- **`registerRenderer()`**: Glyph-mode branch references `curveTexture`, `bandTexture`, `glyphMapTexture` from `mesh.material.uniforms` instead of atlas uniforms.

### Builder pipeline — `src/workers/builders/index.js`
- **Output field rename**: `codepoints` renamed to `glyphIds` in both `buildGlyphBuffers()` and `buildBatchBuffers()`. `codepoints` kept as alias (same array reference) for backward compatibility.
- **New `buildShapedBatchBuffers()`**: Uses HarfBuzz `shapeText()` per line instead of grapheme iteration. Outputs HarfBuzz glyph IDs. Skips empty glyphs (space, .notdef) — advance cursor only. Handles Z-depth wrapping and pagination. Worst-case allocation + truncation (no pre-count pass).

### Worker — `src/workers/GlyphWorker.js`
- **`BUILD_BATCH` handler**: When HarfBuzz shaper is available (initialized via `INIT_FONT`), uses `buildShapedBatchBuffers()`. Falls back to grapheme-based `buildBatchBuffers()` when shaper is not ready.
- **Buffer transfer**: Uses `glyphIds || codepoints` for the Transferable array.

### Collections — `src/collections/GlyphCollection.js`
- **Config**: Accepts `slugData` and `shaper` options.
- **`_createRendererWithSize()`**: Passes `slugData` and `shaper` to GlyphRendererV15 constructor.
- **New `setSlugData(slugData, shaper)`**: Wires Slug textures to collection and existing renderer.

### Collections — `src/collections/CodeGrid.js`
- **Constructor**: Passes `slugData` and `shaper` options through to GlyphCollection.
- **New `setSlugData(slugData, shaper)`**: Delegates to `_collection.setSlugData()`.

### Collections — `src/collections/TerminalGrid.js`
- **`_writeToInstanceBuffer()`**: References `geom.attributes.instanceGlyphId` instead of `instanceCodepoint`.

### App startup — `app/GitHubRepoViewer.js`
- **Imports**: Added `HarfBuzzShaper`, `SlugEncoder`, `collectUniqueGlyphIds`.
- **`init()`**: After atlas setup, loads font, initializes HarfBuzz WASM, shapes probe text (ASCII printable range) to collect glyph IDs, runs SlugEncoder to build GPU textures. Initializes worker pool with font via `workerBridge.initFont()`. Stores `_shaper` and `_slugData` on viewer instance.
- **`createGridForFileAsync()`**: Passes `slugData` and `shaper` to new CodeGrid instances.

### Documentation — `src/core/types.js`
- Updated GPU contract spec: `instanceCodepoint` -> `instanceGlyphId`, atlas textures -> Slug textures.

## Architecture decisions

1. **No fallback path**: Slug is the only rendering path for new renderers. The atlas is still used for metrics (charSize) but not for rendering.
2. **Backward-compatible buffer fields**: Builder output includes both `glyphIds` and `codepoints` (aliased to same array) so existing consumers (TerminalGrid) work without changes.
3. **Lazy Slug binding**: Renderers can be created before SlugEncoder runs. `setSlugData()` wires textures post-construction.
4. **Linear branch mandatory**: The `windingContrib()` shader function handles degenerate quadratics (`A ~= 0`) explicitly. Every L segment and Z closing produces this case.
5. **Early-exit on minX**: Curves sorted ascending by `minX` within each band. Fragment shader breaks when `minX > p.x` — remaining curves cannot intersect the +X ray.

## What was NOT changed

- `src/GlyphAtlas.js` — kept for metrics derivation (charSize), not used for rendering
- `src/collections/GridVirtualizer.js` — renderer-agnostic frustum culling
- `src/collections/GridLayoutManager.js` — spatial layout unaffected
- `src/semantic/` — SemanticInfoMap keying unchanged
- `src/components/MinimapOverlay.js` — reads scene graph, not renderer internals
- Highlight DataTexture — format and API unchanged
- Group DataTexture — format and API unchanged

## Texture memory comparison

| Resource | Atlas path | Slug path |
|----------|-----------|-----------|
| Atlas bitmap (RGBA8) | ~16 MB | 0 |
| Atlas map (RGBA32F) | ~160 KB | 0 |
| Curve texture (RGBA16UI) | 0 | ~30 KB |
| Band texture (RGBA16UI) | 0 | ~15 KB |
| GlyphMap texture (RGBA16UI) | 0 | ~5 KB |
| **Total** | **~16.2 MB** | **~50 KB** |

## Known follow-ups (Phase 4)

- Sub-pixel AA via `fwidth()`-based smoothing (placeholder comment in fragment shader)
- Delete `GlyphAtlas.js` once metrics can be derived from HarfBuzz font extents alone
- Delete `src/shaders/textVertex.glsl` and `textFragment.glsl` reference copies
