# Phase 0: Migration & Integration Analysis

Agent: migration-integration
Focus: per-phase file changes, breakage surface, font/WASM bundling, worker impact, testing, LOD strategy, risk

---

## Key Decisions (Up Front)

1. **No compat shims.** Per project policy, each phase is a clean cut. No `if (useSlug)` dual paths in production code.
2. **Font lives at `assets/fonts/Cousine-Regular.ttf`** -- committed to repo, embedded by Go binary, served over HTTP, fetched by browser as ArrayBuffer.
3. **HarfBuzz WASM** -- vendored from `node_modules/harfbuzzjs/hb.wasm` into `assets/wasm/hb.wasm` during `make prep`. Served by Go binary (relay.go already handles `.wasm` MIME type at line 389).
4. **LOD/hybrid fallback: NO.** Clean-cut at each phase boundary. The atlas path is deleted in Phase B, not kept as fallback. Rationale below.
5. **`textToGlyphs.js` and `layoutText.js` are eliminated** in Phase A -- their logic is subsumed by HarfBuzz shaping + a new unified builder.

---

## Phase A: HarfBuzz Shaping, Keep Bitmap Atlas

### New Files

| File | Purpose |
|------|---------|
| `assets/fonts/Cousine-Regular.ttf` | Bundled font (Apache 2.0), ~170KB |
| `assets/wasm/hb.wasm` | HarfBuzz WASM binary, ~180KB gzipped |
| `src/shaping/HarfBuzzShaper.js` | WASM init, font load, `shape(text)` -> `[{glyphId, advance, xOffset, yOffset, cluster}]` |
| `src/shaping/ShapedText.js` | Thin data class holding shaped run + source text for downstream consumers |
| `src/shaping/index.js` | Barrel exports |

### Modified Files

| File | Changes |
|------|---------|
| `src/workers/builders/index.js` | **Major rewrite.** `buildGlyphBuffers()` and `buildBatchBuffers()` stop calling `iterGraphemes()` for layout. Instead accept `shapedGlyphs[]` (from HarfBuzz) with per-glyph advance widths. Layout cursor: `x += glyph.advance * worldScale + letterSpacing`. The `codepoints` buffer still emits numeric IDs, but now they come from HarfBuzz glyph IDs mapped through `GlyphAtlas._graphemeIds` (the atlas must map glyphId -> grapheme -> numericId, or we add a direct glyphId -> numericId path). Z-wrap and pagination logic stay. `lineSlotOffsets` stays. |
| `src/workers/GlyphWorker.js` | New message type `'BUILD_SHAPED'` / `'BUILD_BATCH_SHAPED'`. Worker loads HarfBuzz WASM on first use (`importScripts` or dynamic `import()`). Caches `HarfBuzzShaper` instance + font blob. Receives font ArrayBuffer once (like UV map caching pattern at line 49-60), then shapes text on worker thread. |
| `src/workers/WorkerBridge.js` | New method `shapedBuildBatch(items, atlas, fontBuffer)`. Transfers font ArrayBuffer to workers on first call (cached, like UV map). Serializes atlas info for glyph ID resolution. New `_fontBufferSent` per-worker flag (mirrors `_hasUVMap` pattern at line 107). |
| `src/GlyphAtlas.js` | Add `getGlyphIdMapping()` -- returns map from HarfBuzz glyph ID -> numeric DataTexture ID. When shaping is active, `ensureCodepoints()` path changes: instead of receiving grapheme strings, receives glyph IDs from HarfBuzz and rasterizes via `font.glyphToPath()` -> Canvas 2D `Path2D` fill (or keeps `fillText` with the actual grapheme from cluster mapping). |
| `src/collections/GlyphCollection.js` | `flushAsync()` path changes to call `shapedBuildBatch()` instead of `buildBatch()`. `_getMetrics()` stays (atlas still provides char size). `_estimateGlyphCount()` stays. |
| `src/collections/CodeGrid.js` | `loadTextAsync()` calls shaping path. `_layoutContentAsync()` passes text through HarfBuzz before building buffers. `metrics.charWidth` becomes an average/fallback -- actual advance is per-glyph from shaper. |
| `src/index.js` | Add exports: `export { HarfBuzzShaper, ShapedText } from './shaping/index.js'` |
| `package.json` | Add `"harfbuzzjs": "^0.8.0"` to `devDependencies`. Add `"assets"` to `"files"` array. |
| `Makefile` | `ASSETS` line: add `assets` to the list (`ASSETS := src app examples assets index.html package.json`). The `prep` target already copies listed assets into `cli/web/`. Also add a `prep-wasm` step that copies `node_modules/harfbuzzjs/hb.wasm` to `assets/wasm/hb.wasm` if not present. |

### Deleted Files

| File | Reason |
|------|--------|
| `src/workers/builders/textToGlyphs.js` | Replaced by HarfBuzz shaping output. The 1:1 grapheme->glyph mapping is eliminated. |
| `src/workers/builders/layoutText.js` | Layout is now cursor accumulation over HarfBuzz advances, inlined into `buildGlyphBuffers()`. Separate file unnecessary. |
| `src/workers/builders/buildBuffers.js` | The old `buildBuffers()` (glyph-objects -> typed arrays) is dead code. The single-pass builder in `index.js` already superseded it. Confirm no imports remain, then delete. |

### Files That Do NOT Change

- `GlyphRenderer.js` -- shaders unchanged, still reads `atlasMapTexture` + `atlasTexture`
- `src/shaders/textVertex.glsl`, `src/shaders/textFragment.glsl` -- reference copies unchanged
- `src/picking/PickingSystem.js` -- picking ID derivation unchanged
- `src/collections/GridVirtualizer.js` -- frustum culling unchanged
- `src/semantic/SemanticInfoMap.js` -- token mapping still works (maps by buffer slot index)

---

## Phase B: Slug Vector Rendering (Replace Atlas)

### New Files

| File | Purpose |
|------|---------|
| `src/shaping/SlugEncoder.js` | Extracts glyph outlines from HarfBuzz `font.glyphToPath()`, parses SVG path to quadratic beziers, organizes into H/V bands, packs into Float16 curve texture + Uint16 band texture. Caches per glyphId (font-lifetime cache). |
| `src/shaping/CurveTexture.js` | Creates/manages `THREE.DataTexture` (HALF_FLOAT RGBA) holding bezier control points. Auto-grows when new glyphs encountered. |
| `src/shaping/BandTexture.js` | Creates/manages `THREE.DataTexture` (UNSIGNED_SHORT RG) for band->curve index mapping. |
| `src/shaping/GlyphMapTexture.js` | Replaces `atlasMapTexture`. Maps glyphId -> (curveStart, curveCount, bandStart, bandCount). Same DataTexture pattern as current `atlasMapTexture` but different payload. |

### Modified Files

| File | Changes |
|------|---------|
| `src/GlyphRenderer.js` | **Major rewrite of shader pipeline.** (1) Remove `atlasTexture` and `atlasMapTexture` uniforms. (2) Add `curveTexture`, `bandTexture`, `glyphMapTexture` uniforms. (3) Vertex shader: lookup `instanceGlyphId` -> glyphMap -> pass curve/band offsets as varyings. (4) Fragment shader: Slug algorithm -- iterate bands, evaluate quadratic bezier intersections, compute winding number, antialias. (5) `_createInstanceMesh()` changes material construction. (6) Keep highlight texture, group texture, picking ID uniform -- those are orthogonal. |
| `src/picking/PickingSystem.js` | Picking fragment shader must also change -- currently samples `atlasTexture` for alpha test in glyph mode. Replace with Slug winding number evaluation for glyph-accurate picking, or simplify to cell-only picking (full quad, no alpha test). Cell mode needs no change. |
| `src/GlyphAtlas.js` | **Deleted entirely** or gutted to a thin `GlyphOutlineCache` that holds SlugEncoder output per glyphId. The bitmap Canvas 2D path is gone. `getCharSize()` replaced by metrics from HarfBuzz font metrics (ascent/descent/units-per-em). |
| `src/GlyphAtlasLoader.js` | Deleted -- prebaked atlas loading is meaningless without a bitmap atlas. |
| `src/collections/GlyphCollection.js` | Constructor takes `SlugEncoder` (or combined `FontContext`) instead of `GlyphAtlas`. `_getMetrics()` derives from HarfBuzz font metrics instead of atlas pixel measurements. |
| `src/collections/CodeGrid.js` | Constructor signature changes: `atlas` param becomes `fontContext` (shaper + encoder). Metrics derived from font, not atlas. |
| `src/index.js` | Remove `GlyphAtlas` and `loadPrebakedAtlas` exports. Add `SlugEncoder`, `CurveTexture`, `BandTexture` exports. |
| `app/GitHubRepoViewer.js` | Initialization path at line 254: replace `new GlyphAtlas()` + `atlas.generate()` with `new HarfBuzzShaper()` + font load + `new SlugEncoder(shaper)`. Remove atlas caching (IndexedDB prebaked atlas). |
| `tools/bake-atlas.html` | Delete -- prebaking is gone. |
| All examples (`examples/*/`) | Replace `GlyphAtlas` construction with `HarfBuzzShaper` + `SlugEncoder` init. Each example that creates an atlas must change. |

### Deleted Files

| File | Reason |
|------|--------|
| `src/GlyphAtlas.js` | Replaced by `SlugEncoder` + `HarfBuzzShaper` |
| `src/GlyphAtlasLoader.js` | Prebaked atlas concept gone |
| `tools/bake-atlas.html` | No bitmap atlas to bake |

---

## What Breaks (Consumer Impact)

### CodeGrid (primary consumer)
- **Phase A**: Constructor still takes `atlas`. Internal change only -- `_layoutContentAsync()` calls shaped builder. `metrics.charWidth` becomes a nominal value; actual layout uses per-glyph advances. Background sizing (`_updateBackground`) uses bounds from builder (already does this). **Low breakage.**
- **Phase B**: Constructor signature changes (`atlas` -> `fontContext`). Every callsite that creates a CodeGrid must pass the new object. Grep shows CodeGrid constructed in: `GitHubRepoViewer.js`, `TerminalGrid.js`, all examples. **Medium breakage, mechanical fix.**

### GitHubRepoViewer (app entry point)
- **Phase A**: Must add font fetch + HarfBuzz WASM init to startup sequence (before atlas.generate). Startup becomes: fetch font -> init HarfBuzz -> generate atlas -> proceed. Loading overlay text updates. **Low breakage.**
- **Phase B**: Atlas generation removed entirely. Startup: fetch font -> init HarfBuzz -> init SlugEncoder -> proceed. Faster startup (~200ms atlas gen eliminated). IndexedDB atlas cache code deleted. **Medium breakage.**

### PickingSystem
- **Phase A**: No change. Atlas texture still exists for alpha test.
- **Phase B**: Glyph-mode picking needs Slug evaluation in picking fragment shader (expensive) OR we drop to cell-mode only (full quad hit test). **Decision: cell-mode only for Phase B launch, add Slug picking later if needed.** Risk: glyph-mode picking currently used for character-level selection. Cell-mode is per-character-cell, which is close enough for code text.

### WorkerBridge / GlyphWorker
- **Phase A**: Workers must initialize HarfBuzz WASM. First-job latency increases (~50ms WASM compile). Font buffer must be transferred to each worker (one-time, ~170KB). Worker message protocol expands. **Medium complexity.**
- **Phase B**: Workers also run SlugEncoder (curve extraction is CPU work). Curve data transferred back to main thread for texture upload. **Medium complexity, additive.**

### SemanticInfoMap
- **Phase A & B**: Unchanged. It maps buffer slot indices to token info. Buffer slots are still 1:1 with rendered glyphs. The slot indices come from `lineSlotOffsets` which the builder still produces.

### Highlight System
- **Phase A & B**: Unchanged. Highlight texture is indexed by buffer slot (gl_InstanceID). Orthogonal to rendering method.

---

## Font Bundling Strategy

### File placement
```
assets/
  fonts/
    Cousine-Regular.ttf    # committed to repo, ~170KB
    LICENSE-Cousine.txt    # Apache 2.0 notice (required)
  wasm/
    hb.wasm                # NOT committed -- copied from node_modules during make prep
```

### Go binary embedding
`Makefile` `prep` target already copies `ASSETS` list into `cli/web/`. Add `assets` to `ASSETS`:
```makefile
ASSETS := src app examples assets index.html package.json
```

Font and WASM are then at `cli/web/assets/fonts/Cousine-Regular.ttf` and `cli/web/assets/wasm/hb.wasm`. The `//go:embed all:web` directive in `cli/embed.go` picks them up automatically. No changes to `embed.go`.

### HTTP serving
`relay.go` `RunServer()` serves `webFS` via `http.FileServer`. Font file served as `application/octet-stream` (default for .ttf, acceptable). WASM already has correct MIME type (line 389: `application/wasm`). Add a `.ttf` case for correct MIME if desired:
```go
case strings.HasSuffix(path, ".ttf"), strings.HasSuffix(path, ".otf"):
    w.Header().Set("Content-Type", "font/ttf")
```

### Browser fetch
```javascript
// In HarfBuzzShaper.js
const fontBuffer = await fetch('/assets/fonts/Cousine-Regular.ttf').then(r => r.arrayBuffer());
const wasmBinary = await fetch('/assets/wasm/hb.wasm').then(r => r.arrayBuffer());
const hb = await hbjs(wasmBinary);
const blob = hb.createBlob(fontBuffer);
```

### Binary size impact
Current binary ~8MB. Font adds ~170KB. WASM adds ~350KB uncompressed (~180KB gzipped). Total increase: ~520KB uncompressed. Acceptable for a single-user tool.

---

## HarfBuzz WASM Delivery

`harfbuzzjs` ships `hb.wasm` alongside its JS entry point. Two approaches:

**Option 1 (chosen): Vendor into assets/**
```makefile
prep-wasm:
    @mkdir -p assets/wasm
    @cp node_modules/harfbuzzjs/hb.wasm assets/wasm/hb.wasm 2>/dev/null || \
        echo "Warning: harfbuzzjs not installed, run npm install"
```
Browser fetches from `/assets/wasm/hb.wasm`. Works in both embedded and `--local` modes.

**Option 2 (rejected): Let harfbuzzjs auto-locate WASM.**
The `harfbuzzjs` module tries to load WASM relative to its own URL via `import.meta.url`. This breaks when served from Go embedded FS because the directory structure doesn't match `node_modules/`. Vendoring gives us control.

### Worker WASM loading
Workers fetch the same `/assets/wasm/hb.wasm` URL. WASM compiles once per worker via `WebAssembly.instantiate()`. Cached in worker scope (same pattern as UV map caching). First-job latency: ~50ms for WASM compile + font parse.

---

## npm Dependency Changes

```json
{
  "devDependencies": {
    "three": "^0.169.0",
    "harfbuzzjs": "^0.8.0"
  }
}
```

`harfbuzzjs` is devDependency only (same as Three.js) -- the actual runtime asset is the vendored WASM file, not the npm module. The JS wrapper from harfbuzzjs (~5KB) is either vendored into `src/shaping/` or imported directly if the module resolution works with the embedded server.

Recommended: vendor the harfbuzzjs JS wrapper (`hb.js`, ~200 lines) into `src/shaping/harfbuzz-wasm.js` to avoid any module resolution issues. Keep `harfbuzzjs` in devDependencies for WASM binary access only.

---

## Worker Bridge Changes

### Phase A changes to WorkerBridge

1. **New `_fontBuffer` cache** (parallels `_uvMapCache`):
   ```javascript
   this._fontBuffer = null;  // ArrayBuffer, sent once per worker
   ```

2. **New per-worker `_hasFont` flag** (parallels `_hasUVMap` at line 107):
   Workers receive font ArrayBuffer on first dispatch. Stored in worker-local `cachedFontBuffer`.

3. **New `_shapingReady` promise**: HarfBuzz WASM init is async. WorkerBridge tracks readiness.

4. **New dispatch path**: `buildBatchShaped(items, shared)` -- same shape as `buildBatch()` but items carry raw text (shaping happens on worker). `shared` includes font metrics but NOT UV map (shaping produces glyph IDs directly).

### Phase A changes to GlyphWorker

1. **WASM init on first `BUILD_BATCH_SHAPED` message**: Fetch `/assets/wasm/hb.wasm`, compile, create HarfBuzz font from cached font buffer.
2. **Shape + build in one pass**: `hb.shape(font, buffer)` -> `buffer.json()` -> feed advances/glyphIds into `buildBatchBuffers()`.
3. **Memory management**: `buffer.destroy()` after each shape call. Font/face/blob persist for worker lifetime.

---

## Testing Strategy (No Test Runner)

### Phase A validation

1. **Visual diff**: Load the same repo in current atlas path vs HarfBuzz path. Screenshot both. Monospace font (Cousine) should produce nearly identical output -- any difference reveals a bug in advance accumulation.
2. **Console metrics**: Log `shaping time`, `buffer build time`, `total glyph count` in both paths. HarfBuzz should produce same glyph count (monospace font, no ligatures unless font has them).
3. **Highlight system**: Load a file, run `highlight.range 1 1 5 10 1 0 0 1`. Verify highlight covers correct characters. This validates `lineSlotOffsets` is still correct.
4. **Picking**: Hover over glyphs, verify character-level hit detection still works. This validates buffer slot alignment.
5. **Worker path**: Compare sync (`loadText`) vs async (`loadTextAsync`) output. Both should produce identical rendering.
6. **Existing examples**: Run `examples/picking-test/`, `examples/render-test/`. They must still work.
7. **Edge cases**: Empty file, single character, file with only newlines, Unicode emoji, very long lines (Z-wrap).

### Phase B validation

1. **Zoom test**: Zoom to 1000% on a glyph. Atlas path: visible pixelation. Slug path: sharp curves. This is the primary visual proof.
2. **Performance**: FPS counter at 1500-file scale. Must hold 60fps with GridVirtualizer active (~50 visible grids).
3. **GPU memory**: Check `renderer.info.memory` before and after. Should see ~16MB texture savings.
4. **Mobile**: Test on phone browser (low-end GPU). If Slug fragment shader is too heavy, this is where it shows.

### Automated (future)
`examples/render-test/` already does headless rendering comparison. Extend with a HarfBuzz test case that renders a known string and compares pixel output against a reference image.

---

## LOD / Hybrid Fallback: Clean Cut, Not Hybrid

**Decision: No hybrid path.** Rationale:

1. **Project policy**: No compat shims, no dual paths. A hybrid renderer that switches between atlas and Slug based on zoom level is a dual path.
2. **Maintenance cost**: Two shader pipelines, two texture systems, switching logic, two code paths through every consumer. This is the exact kind of complexity the project rejects.
3. **GridVirtualizer already handles the performance concern**: At any given frame, only 10-50 grids are visible. The Slug ALU cost is bounded by visible glyph count, not total glyph count.
4. **If Slug can't do 10K glyphs at 60fps**: The fallback is to stay on Phase A (HarfBuzz + bitmap atlas), not to build a hybrid. Phase A is already a significant improvement over current state.

The progression is: current -> Phase A (shipped, stable) -> Phase B (shipped, replaces A). Not: current -> hybrid that does both.

---

## Risk Assessment

### Highest risk: Instanced Slug fragment shader performance

**Why**: No existing implementation combines Slug with GPU instancing at the scale glyph3d-js needs (10K glyphs per mesh, multiple meshes). JSlug uses one geometry per string. The HarfBuzz GPU demo uses instancing but is a compiled C++ binary, not a JS + Three.js app.

**Specific concern**: The Slug fragment shader loops over bezier curves per pixel. With 10K instanced quads, each pixel evaluates curves independently. Band-based early exit helps, but worst case (dense overlapping glyphs) could blow the fragment shader budget.

**Mitigation**:
1. Prototype the Slug fragment shader with a single CodeGrid (one mesh, ~5000 glyphs) before committing to full integration.
2. Profile on target hardware: M1 MacBook (primary dev), mid-range Android phone (mobile target).
3. If performance is unacceptable, Phase A is the stable fallback. No code is thrown away.

### Second risk: HarfBuzz WASM in workers

**Why**: WASM instantiation in Web Workers is well-supported but adds first-job latency. Font buffer transfer is ~170KB per worker (3 workers = ~510KB of transfers). Could cause jank during first file load.

**Mitigation**: Pre-warm workers during loading screen (font buffer sent alongside atlas data, before any file loads).

### Third risk: SVG path parsing for Slug

**Why**: `font.glyphToPath()` returns SVG path strings ("M 100 200 Q 150 300 200 200 Z"). Parsing these into quadratic bezier data structures is string manipulation that must be correct and fast. Cubic curves (C commands) in CFF/OpenType fonts need conversion to quadratics.

**Mitigation**: Cousine-Regular.ttf is TrueType (quadratic natively). Test with TrueType first. Add cubic-to-quadratic conversion later if OTF support needed.

### Low risk: Font bundling

The Go embed system is proven. Adding files to `assets/` and `ASSETS` list is mechanical. MIME types are handled. Binary size increase is negligible.

---

## Makefile Changes

```makefile
# Assets to embed
ASSETS := src app examples assets index.html package.json

# Add prep-wasm as dependency of prep
prep: prep-wasm
    @rm -rf $(WEB_DIR)
    @mkdir -p $(WEB_DIR)
    @for asset in $(ASSETS); do \
        if [ -e "$$asset" ]; then \
            cp -r "$$asset" $(WEB_DIR)/; \
        fi; \
    done
    @echo "Prepared $(WEB_DIR)/ for embedding"

# Copy HarfBuzz WASM from node_modules into assets/ (idempotent)
prep-wasm:
    @mkdir -p assets/wasm
    @if [ -f node_modules/harfbuzzjs/hb.wasm ]; then \
        cp node_modules/harfbuzzjs/hb.wasm assets/wasm/hb.wasm; \
    else \
        echo "Warning: harfbuzzjs not installed (run npm install). WASM not bundled."; \
    fi
```

`assets/fonts/Cousine-Regular.ttf` is committed to the repo directly -- no build step needed. `assets/wasm/hb.wasm` is a build artifact copied from `node_modules/`.

### .gitignore addition
```
assets/wasm/
```
The WASM binary comes from npm, not source control. Font file IS committed (it's a project asset, Apache 2.0 licensed).
