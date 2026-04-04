# Round 2: migration-integration reviews shader-rendering, shaping-pipeline (inverse)

## Reaffirm or Retract

### 1. SlugEncoder in workers — RETRACTED

My Phase 0 said: "Workers also run SlugEncoder (curve extraction is CPU work). Curve data transferred back to main thread for texture upload." shaping-pipeline challenged this in Round 1 (line 13, errors section): curve extraction is font-level work, runs once at startup, produces shared textures. Workers only do per-text shaping + buffer building.

**I was wrong.** The curve/band textures describe the font's glyph outlines — there are ~200 unique glyph shapes regardless of how many instances exist. Building these textures once on the main thread during font load is correct. Workers never need curve data; they only need HarfBuzz for shaping (glyphId + advances) and the builder for instance buffers. My proposal would have sent ~50KB of curve data from each worker back to main on every batch job, which is pointless round-tripping. The existing architectural boundary (font-level work on main, per-text work in workers) is the right one and the integration should preserve it.

### 2. Triple-hop glyphId→grapheme→numericId — RETRACTED

My Phase 0 said: "the atlas must map glyphId -> grapheme -> numericId, or we add a direct glyphId -> numericId path." shaping-pipeline correctly identified that HarfBuzz glyph IDs become the numericIds directly. The triple-hop adds a string-keyed intermediate lookup for no benefit. shaping-pipeline's `getGlyphIdMap()` approach (shape each grapheme once, map glyphId to its UV entry, use glyphId as the DataTexture index) is the clean path.

### 3. `buildBuffers.js` deletion — REAFFIRMED

shader-rendering's Round 1 Error 1 claimed `buildBuffers.js` is not dead code because `WorkerBridge._buildBuffersSync` depends on it. **I verified this is incorrect.** `WorkerBridge.js` line 12-13 imports `{ buildGlyphBuffers, buildBatchBuffers }` from `'./builders/index.js'`, not from `buildBuffers.js`. `_buildBuffersSync` (line 309-324) calls `buildGlyphBuffers()` from `index.js`. `GlyphWorker.js` line 15 also imports from `./builders/index.js`. Grep confirms zero import statements pointing to `buildBuffers.js` anywhere in `src/`. The file's only external reference is a comment at `GlyphRenderer.js` line 1321 ("Buffers come from WorkerBridge.buildBuffers()") which refers to the method name, not the file. `buildBuffers.js` is dead code. Delete it in Phase A.

### 4. `font.glyphToPath()` — RETRACTED

shader-rendering correctly identified in Round 1 that `harfbuzzjs` does not expose `glyphToPath()`. My Phase 0 and Phase B plan built SlugEncoder on this non-existent API. The outline extraction must use `opentype.js` (which has `font.charToGlyph()` and `glyph.getPath()`), or wait for `libharfbuzz-gpu` (experimental). My Phase B plan needs revision: `SlugEncoder.js` takes an `opentype.js` Font object, not an `hbFont`, for outline extraction.

### 5. Font URL path — REAFFIRMED

I used `/assets/fonts/Cousine-Regular.ttf`. shaping-pipeline used `/fonts/Cousine-Regular.ttf`. The file lives at `assets/fonts/` in the repo. The Go binary embeds from `cli/web/`, and the Makefile copies `assets/` into `cli/web/assets/`. The URL resolves to `/assets/fonts/Cousine-Regular.ttf`. shaping-pipeline's path would 404.

## Evolved Understanding

### shader-rendering's Phase B shader design is more concrete than I expected

Re-reading shader-rendering's Phase 0 after Round 1, the texture format design (sections 4-5) and the instanced lookup chain are precisely specified. The key insight I missed: the `glyphMapTexture` lookup happens in the vertex shader (per-instance, not per-pixel), passing curve/band offsets as `flat out int` varyings. This is correct and important — I had not thought through where in the pipeline the glyph→curve indirection sits. shader-rendering nailed this.

### The `texture()` vs `texelFetch()` question is worth doing in Phase A

In Round 1 I called shader-rendering's concern "overstated" because the +0.5 centering prevents boundary artifacts. After reflection, I still believe it is not a current bug, but switching to `texelFetch()` in Phase A is a zero-cost cleanup that eliminates any future precision concern when glyph IDs replace codepoints. The atlas map DataTexture already uses `NearestFilter`, so the switch is purely a shader-side change with no texture setup impact. Worth doing.

### The `applyPrebuiltBuffers` fallback is a real landmine

shaping-pipeline flagged `GlyphRenderer.js` line 1370 — the `iterGraphemes` recount in the `applyPrebuiltBuffers` fallback. I verified this: when `itemMeta` is missing from worker output, `applyPrebuiltBuffers` reconstructs it by iterating graphemes and counting `cp > 32`. With HarfBuzz, glyph counts may differ (ligatures reduce count). The fix: the shaped builder must always emit `itemMeta` (it already does via `lineSlotOffsets`). The fallback branch at line 1365-1380 becomes dead code for the shaped path. Add a guard (`if (buffers.shaped && !itemMeta) throw`) to catch any silent misuse.

### GLSL ES 3.0 loop bounds: shader-rendering was cautious, I was dismissive, truth is in between

shader-rendering said `flat in int` as loop bound is "technically non-conformant." I said in Round 1 this concern was "unfounded" citing GLSL ES 3.0 section 4.1 relaxing loop rules. After review: GLSL ES 3.0 does allow dynamic loops, but some mobile GPU drivers (Mali, Adreno) have been known to miscompile loops with per-instance-varying bounds. The `MAX_BANDS` compile-time cap is good practice for robustness, regardless of spec conformance. I should not have dismissed it.

## Convergence

All three agents now agree on:

1. **No fallback/dual path.** HarfBuzz must be initialized before any rendering. The `fallbackShape()` branch shaping-pipeline proposed is rejected. If WASM init fails, the app does not start.

2. **Phase A keeps bitmap atlas.** Shaders unchanged. Only the builder input changes (shaped glyph output instead of grapheme iteration). `instanceCodepoint` keeps its name in Phase A; rename to `instanceGlyphId` in Phase B.

3. **Vendor the harfbuzzjs JS wrapper.** Workers cannot resolve bare specifiers. Copy the ~200-line `hb.js` into `src/shaping/`, import by relative path.

4. **Font URL: `/assets/fonts/Cousine-Regular.ttf`.** Not `/fonts/`.

5. **SlugEncoder runs on main thread.** Curve/band textures are font-level, built once. Workers never touch outline data.

6. **`font.glyphToPath()` does not exist in harfbuzzjs.** Phase B outline extraction uses `opentype.js`.

7. **`MAX_BANDS` compile-time cap in Slug fragment shader.** Whether for conformance or driver robustness, it is a one-line guard worth adding.

8. **Per-worker `_hbReady` flag.** Modeled after `_hasUVMap`. Do not dispatch shaped jobs until each worker confirms `FONT_READY`.

9. **`WorkerBridge.dispose()` needed for WASM cleanup.** `hbFont.destroy()` etc. in a `CLEANUP` message before `worker.terminate()`.

10. **`try/finally` on `hb.createBuffer()`.** Mandatory. Buffer leaks are the primary WASM memory risk.

## Remaining Tensions

### 1. Shaping code location: `src/shaping/` vs `src/workers/builders/`

shader-rendering (Round 1, Tension 1) argues shaping logic belongs in `src/workers/builders/` because that is the "worker-safe zone," and placing code in `src/shaping/` risks accidental DOM/Three.js imports. shaping-pipeline argues `src/shaping/` is the right domain location but must remain worker-importable. I proposed `src/shaping/HarfBuzzShaper.js` in my Phase 0.

**My position**: `src/shaping/` is correct. The "worker-safe zone" argument assumes directory conventions enforce import safety — they do not. A file in `src/workers/builders/` can import Three.js just as easily as one in `src/shaping/`. What actually enforces safety is code review and the vendored harfbuzz-wasm module having zero dependencies. The `shapeText()` function is a domain concept (text shaping), not a builder implementation detail. It belongs with the shaping module. Workers import it by relative path (`../../shaping/shapeText.js`).

### 2. `buildGlyphBuffers` single-item path

shader-rendering (Round 1, gap section) noted that all three Phase 0 docs address only `buildBatchBuffers`. `GlyphWorker.js` line 15 imports `buildGlyphBuffers` for the `BUILD` message type. This path also needs HarfBuzz shaping.

**My position**: Deprecate the single-item `BUILD` path. Convert it to a `BUILD_BATCH` with a one-item array internally. The batch builder handles all cases. One shaped code path is better than two.

### 3. Phase B prototype gate

shader-rendering's Round 1 key insight: Phase B needs a standalone prototype (HTML page, one glyph, winding shader, instanced draw) before integration work begins. shaping-pipeline does not address this. I flagged the Slug fragment shader as the highest risk in my Phase 0 but proposed "prototype with a single CodeGrid" rather than a standalone page.

**My position**: shader-rendering is right. A standalone prototype decouples the Slug shader validation from all the integration plumbing. Build it in `examples/slug-prototype/`. If the winding shader cannot render one glyph correctly at 60fps on target hardware, nothing else matters.

## Synthesis

### Phase A: ship order

1. Vendor harfbuzzjs JS wrapper into `src/shaping/harfbuzz-wasm.js`
2. Create `src/shaping/shapeText.js` — pure function, worker-safe, `try/finally` on buffer
3. Create `src/shaping/index.js` — barrel exports
4. Commit font: `assets/fonts/Cousine-Regular.ttf` + `LICENSE-Cousine.txt`
5. Add `prep-wasm` Makefile target; add `assets/wasm/` to `.gitignore`
6. Add `INIT_FONT` message to `GlyphWorker.js`; add per-worker `_hbReady` flag to `WorkerBridge.js`; add `WorkerBridge.dispose()` with `CLEANUP` message
7. Add `GlyphAtlas.getGlyphIdMap()` — shape each grapheme, map glyphId→UV entry
8. Modify `buildBatchBuffers()` in `src/workers/builders/index.js`: replace `iterGraphemes` with shaped glyph iteration, use cluster-based space detection (`text.codePointAt(sg.cluster) === 32`), shape-first-cache for pre-allocation
9. Switch `atlasMapTexture` lookup from `texture()` to `texelFetch()` in `GlyphRenderer._getVertexShader()` and `PickingSystem.js`
10. Guard `applyPrebuiltBuffers` fallback: shaped buffers must always include `itemMeta`
11. Delete `textToGlyphs.js`, `layoutText.js`, `buildBuffers.js`
12. Deprecate `BUILD` single-item path; route through `BUILD_BATCH` internally
13. Add `.ttf` MIME type to `relay.go`
14. Update `ASSETS` in Makefile, update `package.json` devDependencies

### Phase B: prerequisites before integration

1. Add `opentype.js` to devDependencies; vendor the glyph-path extraction into `src/shaping/`
2. Build `examples/slug-prototype/` — standalone page: load font, extract curves for one glyph via opentype.js, pack into HALF_FLOAT DataTexture, render with winding-number fragment shader in one instanced draw call
3. Profile on M1 Mac + mid-range Android. If <60fps at 5000 glyphs, stop and reassess
4. Only then proceed with full `SlugEncoder.js`, `CurveTexture.js`, `BandTexture.js`, `GlyphMapTexture.js`
5. Rename `instanceCodepoint` → `instanceGlyphId` in same commit that drops glyph-mode picking

## Dissent

### `opentype.js` adds real complexity that nobody has fully costed

All three agents now agree Phase B uses `opentype.js` for outline extraction, treating it as a simple swap for the non-existent `glyphToPath()`. But `opentype.js` is a 400KB library (minified) with its own font parsing pipeline, its own glyph representation, and its own coordinate system. We would be loading the font twice — once via harfbuzzjs for shaping, once via opentype.js for outlines. Two font parsers, two in-memory representations of the same .ttf, two potential sources of metric disagreement. Nobody has addressed whether opentype.js's glyph IDs match harfbuzzjs's glyph IDs (they should, both derive from the font's `cmap` + `glyf` tables, but this must be verified). Nobody has addressed the binary size impact on the Go-embedded binary (~400KB more). And nobody has addressed whether opentype.js works in a worker context (it does, but it has its own WASM/JS detection logic).

This is the sleeper risk of Phase B. The `glyphToPath()` API gap is not just a one-line fix — it introduces a second font library with its own maintenance burden. The prototype in `examples/slug-prototype/` must validate glyph ID correspondence between harfbuzzjs and opentype.js for every glyph in Cousine before any integration proceeds. If IDs disagree, the entire `glyphMapTexture` indexing chain breaks silently.
