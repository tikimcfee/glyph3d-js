# Round 1: shader-rendering reviews shaping-pipeline, migration-integration

## Errors Found

### Error 1 — `buildBuffers.js` is NOT dead code (migration-integration, Phase A deleted files)

migration-integration lists `src/workers/builders/buildBuffers.js` for deletion in Phase A, claiming it is "dead code" because the single-pass builder in `index.js` superseded it. This is incorrect. `src/workers/WorkerBridge.js` line 178 calls `this._buildBuffersSync(input, metrics, atlas)` (line 309), which uses a different path. The file also has an active export used by at least the legacy `GlyphRenderer.js` path (see comment at line 1321: "Buffers come from WorkerBridge.buildBuffers() or buildBatchBuffers()"). Deleting `buildBuffers.js` in Phase A without first auditing every import will break the sync fallback path in `WorkerBridge._buildBuffersSync`. Confirmed: there are no ES module `import` statements pointing to `buildBuffers.js` from other builders, but `WorkerBridge.js` line 309 uses it via a method that imports it at startup. Deletion is not safe without removing or rerouting that method first.

**Correct approach**: Audit `WorkerBridge._buildBuffersSync` before scheduling deletion. Move deletion to a dedicated cleanup step after confirming no active callers.

### Error 2 — `font.glyphToPath()` does not exist in harfbuzzjs (migration-integration, shaping-pipeline)

Both agents reference `font.glyphToPath(glyphId)` as the outline extraction API (migration-integration line 68; source doc at `docs/harfbuzz-slug-integration.md` line 280). The harfbuzzjs JavaScript binding (`harfbuzzjs` npm package) does **not** expose `glyphToPath`. That API is from a different library — `opentype.js`. The harfbuzzjs WASM API exposes `hb.createFont()`, shaping via `hb.shape()`, and `buffer.json()` for glyph IDs and advances. Outline data requires either `opentype.js` (which has `font.getPath(glyph, ...)`) or the newer `libharfbuzz-gpu` (which has its own blob encoder). The `docs/` research document itself notes this (line 395: "Uses opentype.js for font parsing (alternative to HarfBuzz glyphToPath)"). The Phase B `SlugEncoder.js` design in migration-integration is built on a non-existent API.

**Correct approach**: Phase B outline extraction must use `opentype.js` (already present in the research doc as the fallback). The font ArrayBuffer sent to workers can be parsed by `opentype.js` on the main thread. Alternatively, the `libharfbuzz-gpu` API from HarfBuzz 14.0 (April 2026, noted in the research doc) is a viable path but is experimental and adds ~1MB WASM.

### Error 3 — `atlasMapTexture` uses `texture()` not `texelFetch()` — critical Phase A precision issue (shaping-pipeline)

shaping-pipeline says the vertex shader lookup is "unchanged" for Phase A (correctly), but does not flag the fact that the current shader uses `texture()` (bilinear-interpolated) rather than `texelFetch()` for the atlas map lookup (noted in my Phase 0 output, section 1). With codepoint-based IDs this happens to work because the IDs are always integers and map to exact texel centers. With HarfBuzz glyph IDs, the same assumption holds only if glyph IDs are always non-negative integers within the texture bounds. If a font contains glyph IDs above 16384 (uncommon for code fonts but possible), the texture height math `floor(cp / atlasMapWidth)` may produce fractional results due to float32 precision loss. The `texture()` call then bilinearly samples across two texels, returning garbage UV coordinates. The `shaping-pipeline` doc calls this out as worth noting but does not include it in the breaking-changes table or recommend a fix.

**Fix**: In Phase A, switch the atlas map lookup from `texture()` to `texelFetch()` using `int(instanceCodepoint)` directly:
```glsl
// Replace in _getVertexShader():
ivec2 mapCoord = ivec2(int(instanceCodepoint) % atlasMapWidthInt,
                       int(instanceCodepoint) / atlasMapWidthInt);
vec4 uvRect = texelFetch(atlasMapTexture, mapCoord, 0);
```
This also eliminates the `atlasMapWidth`/`atlasMapHeight` float uniforms (replaced by `atlasMapWidthInt` as an int uniform).

### Error 4 — `countGlyphs()` over-allocation is stated, but the two-pass approach has a real cost (shaping-pipeline)

shaping-pipeline recommends "shape first, cache results" to solve the pre-allocation problem (section "Pre-count Problem"). The document correctly identifies that shaping produces results before allocation. However, it then says "The shaping cost is trivial (~0.1ms per 1000 chars)." This figure is plausible for shaping alone but ignores the fact that `hb.shape()` is called **twice** per text item in this design — once in the pre-count pass and once in the fill pass (unless the shaped results are cached). The document says "cache results" but does not show the cache mechanism. If the shaped results are stored in a temporary JS array between passes, this introduces heap allocation in the hot path — directly violating the zero-allocation principle stated in the architecture.

**Fix**: Shape once, push results into a pre-allocated flat array. Then iterate the flat array twice (once to count, once to fill). The shape output `{glyphId, advance, xOffset, yOffset, cluster}` can be written into a reusable pool per batch dispatch. This keeps the hot path allocation-free.

### Error 5 — Worker WASM loading race: `BUILD_BATCH_SHAPED` before `INIT_FONT` completes (migration-integration)

migration-integration describes WASM init triggering on "first `BUILD_BATCH_SHAPED` message" (page 2, Worker Bridge Changes). This means if two jobs arrive in quick succession (round-robin to two workers), the second worker may receive `BUILD_BATCH_SHAPED` before its async WASM compile finishes. The current `WorkerBridge` has no readiness barrier per worker — it dispatches by round-robin without checking worker state. The proposed `_shapingReady` promise covers only "all workers", not per-worker readiness. A worker that hasn't finished WASM compile will fail on the first job it receives after the first worker completes init.

**Fix**: Match the existing `_hasUVMap` flag pattern. Add `worker._hbReady = false` and only dispatch shaped jobs to workers where `_hbReady === true`. Alternatively, send `INIT_FONT` to all workers before any jobs, awaiting `FONT_READY` from each, before enabling the shaped dispatch path.

---

## Gaps

**Covered by shader-rendering, missed by both others:**
- The `texture()` vs `texelFetch()` precision distinction for the atlas map lookup — Phase A correctness risk.
- The `flat out int` GLSL ES 3.0 loop bound conformance issue and the `MAX_BANDS` compile-time cap requirement.
- Specific ALU cost estimation per pixel with the band early-exit optimization.
- `bandTexture` format as `RG16UI` (`usampler2D`) and the WebGL 2 implications for sampling.
- `glyphMapTexture` lookup correctly placed in vertex shader (not fragment) to avoid per-pixel repetition.

**Covered by shaping-pipeline, missed by shader-rendering:**
- The specific `hb.createBuffer()` / `buffer.destroy()` WASM memory management in `finally` blocks.
- `WorkerBridge` has no `dispose()` — workers can't clean up WASM objects on shutdown.
- The `applyPrebuiltBuffers` recount path (line 1364 reference) that would silently miscount with shaped output.

**Covered by migration-integration, missed by shader-rendering:**
- The `.ttf` MIME type gap in `relay.go` (currently no case for `.ttf`, served as `application/octet-stream`).
- `assets/wasm/` should be `.gitignore`d — WASM is a build artifact from npm.
- The Go `prep` target and Makefile `ASSETS` line need explicit update.

**Gap in both shaping-pipeline and migration-integration:**
- Neither discusses what happens to the `buildGlyphBuffers()` single-item path (only `buildBatchBuffers` is addressed). The `GlyphWorker.js` `BUILD` message type dispatches `buildGlyphBuffers` (line 30), not `buildBatchBuffers`. The single-item path needs the same HarfBuzz threading.

---

## Tensions

### Tension 1 — HarfBuzz shaping: inline in builder vs separate `HarfBuzzShaper.js` class

shaping-pipeline proposes shaping inline in `buildBatchBuffers()` via a new `shapeText.js` helper, with HarfBuzz state (`hbFont`, `hbFace`, `hbBlob`) held as worker globals. migration-integration proposes a `src/shaping/HarfBuzzShaper.js` class with its own encapsulated state, instantiated and cached in the worker.

**Which is correct**: shaping-pipeline's approach. Worker-context code must not import DOM or Three.js — it must be importable in `DedicatedWorkerGlobalScope`. A class in `src/shaping/HarfBuzzShaper.js` that manages WASM state is compatible with workers only if it has zero DOM/Three.js dependencies, which the class file location (`src/shaping/`) does not enforce. The existing pattern (worker globals for `cachedUVMap`, `cachedGlyphWidths`) is established, battle-tested, and matches the constraint that `src/workers/builders/` is the worker-safe zone. Placing shaping logic outside that zone risks accidental DOM imports as the `src/shaping/` module grows.

### Tension 2 — LOD / fallback strategy

migration-integration explicitly rejects a hybrid LOD path ("No hybrid path. Clean cut at each phase boundary."). This is correct per project policy (CLAUDE.md: "No compat shims"). shaping-pipeline does not address this explicitly but its "graceful degradation" line in the builder pseudocode — `const shaped = shared.hbReady ? shapeText(...) : fallbackShape(text, uvMap, glyphWidths, ws)` — is a dual path. This directly contradicts the project policy.

**Which is correct**: migration-integration. The fallback branch should not exist in committed code. If HarfBuzz isn't ready, the job should queue or fail fast with an error, not silently fall back to a different code path that produces different output. The `hbReady` check belongs in the WorkerBridge dispatch layer, not inside the builder.

### Tension 3 — `buildBuffers.js` deletion timing

migration-integration deletes `buildBuffers.js` in Phase A. shaping-pipeline does not mention it. As established in Error 1 above, `WorkerBridge._buildBuffersSync` depends on it. Deletion in Phase A is premature.

**Which is correct**: Neither covers it fully. The file should be deleted only after `_buildBuffersSync` is removed or rerouted, which is a prerequisite step both documents miss.

---

## Recommendations

1. **Before Phase A: audit `WorkerBridge._buildBuffersSync`** — confirm all callers, then route to `buildGlyphBuffers()` from `index.js` before scheduling `buildBuffers.js` for deletion.

2. **Phase A shader fix: switch atlas map lookup from `texture()` to `texelFetch()`** in `GlyphRenderer._getVertexShader()`. Use `ivec2(int(instanceCodepoint) % mapW, int(instanceCodepoint) / mapW)` to prevent float precision errors on high glyph IDs.

3. **Phase B outline extraction: replace `font.glyphToPath()` with `opentype.js`** — the harfbuzzjs API does not expose this method. Add `opentype.js` as a devDependency and vendor the relevant parsing code into `src/shaping/SlugEncoder.js`.

4. **Remove the `fallbackShape()` branch** from the builder pseudocode in shaping-pipeline. WASM readiness is a startup concern handled in `WorkerBridge`, not a per-job branch inside the buffer builder.

5. **Add `BUILD` (single-item) shaping path** — both docs cover only `BUILD_BATCH`. `GlyphWorker.js` line 30 dispatches `buildGlyphBuffers()` for the `BUILD` message. This path also needs shaped input or must be deprecated in favor of always using `BUILD_BATCH` with a one-item array.

6. **Per-worker `_hbReady` flag in WorkerBridge** — modeled after `_hasUVMap`. Do not dispatch shaped jobs until each worker has confirmed `FONT_READY`. The single `_shapingReady` promise migration-integration proposes covers the aggregate but not per-worker state.

7. **Shape result caching between pre-count and fill passes** — write `shapeText()` output into a flat reusable object pool rather than calling it twice. This preserves the zero-allocation principle in the hot path.

8. **Add `MAX_BANDS_PER_GLYPH` compile-time constant** to the Slug fragment shader — `const int MAX_BANDS_PER_GLYPH = 64;` with early `break` — as the loop bound conformance guard. This is a single-line change that prevents driver-level undefined behavior on conformant WebGL 2 implementations.

9. **`relay.go` MIME type for `.ttf`** — add the `.ttf`/`.otf` case in the switch at line 382 of `relay.go`. The `font/ttf` MIME type enables correct browser font preloading behavior (link rel=preload).

10. **Restrict `src/shaping/` to main-thread-only code** — document in a comment at the top of `src/shaping/index.js` that this module must not be imported from worker context. Worker-safe shaping code lives in `src/workers/builders/shapeText.js`. Keeping these two zones distinct prevents accidental Three.js or DOM imports from crossing into worker scope.

---

## Key Insight

The most structurally dangerous assumption shared across both reviewed documents is that `font.glyphToPath()` is the Phase B outline extraction API — it is not part of the harfbuzzjs JavaScript binding, and Phase B's entire `SlugEncoder.js` design depends on it. This single API misidentification makes Phase B's outline extraction plan non-functional as written. The fix exists (use `opentype.js`, which is already identified in the research doc as an alternative), but it adds a second major library dependency and its own parsing surface. Phase A's plan is sound and can ship independently. Phase B needs a concrete prototype — specifically, a standalone HTML page that loads a `.ttf` via `opentype.js`, extracts quadratic bezier curves for one glyph, packs them into a `HALF_FLOAT` DataTexture, and evaluates a winding-number shader in a single instanced draw call — before any Phase B integration work begins. That prototype is the real risk gate, not the migration planning.
