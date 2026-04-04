# Round 2: shaping-pipeline reviews migration-integration, shader-rendering (inverse)

## Reaffirm or Retract

### 1. `fallbackShape()` — RETRACTED

My Phase 0 builder pseudocode (line 170) included `shared.hbReady ? shapeText(...) : fallbackShape(...)`. Both migration-integration and shader-rendering correctly identified this as a compat shim that violates project policy. I retract it. HarfBuzz must initialize before any builder runs. If WASM compilation fails, the application does not start. The readiness gate belongs in `WorkerBridge` dispatch (per-worker `_hbReady` flag), not inside the builder function. The `fallbackShape` function should not exist.

### 2. `import hb from 'harfbuzzjs'` in worker code — RETRACTED

My Phase 0 used bare-specifier imports (`import hb from 'harfbuzzjs'`) in both `GlyphWorker.js` and `shapeText.js`. Migration-integration correctly identified this as broken: workers served via the Go binary's embedded FS cannot resolve bare specifiers without a bundler or import map, neither of which this project has. I retract the import mechanism. The harfbuzzjs JS wrapper (~200 lines) must be vendored into `src/shaping/harfbuzz-wasm.js` and imported by relative path.

### 3. Shaping helper location (`src/workers/builders/shapeText.js`) — PARTIALLY RETRACTED

I placed the shaping helper in `src/workers/builders/`. Migration-integration proposed `src/shaping/HarfBuzzShaper.js`. In Round 1, shader-rendering sided with my approach because `src/workers/builders/` is the established worker-safe zone. However, on reflection, the real constraint is "no DOM, no Three.js imports" — not directory location. A `src/shaping/` module that is purely worker-safe is architecturally cleaner; it represents shaping as a domain concept, not a builder implementation detail. **I retract the specific file path but reaffirm the constraint**: whatever lives in `src/shaping/` must remain importable from worker context. A one-line comment at the top of `src/shaping/index.js` enforces this: `// Worker-safe: no DOM or Three.js imports allowed in this module`.

### 4. Space detection via missing UV entry — RETRACTED

My Phase 0 (line 188-198) detected whitespace via `!entry && sg.advance > 0`. Migration-integration correctly pointed out this is fragile: HarfBuzz assigns a valid glyph ID to space in most fonts, and the atlas will have an entry for it. The correct approach (migration-integration Round 1, recommendation 2) is `text.codePointAt(sg.cluster) === 32`, which indexes back into the source string via the cluster field. This matches the current builder's `cp === 32` logic at `index.js` line 381. Retracted.

### 5. Shape-first-then-allocate — REAFFIRMED WITH REFINEMENT

My Phase 0 proposed shaping all items first, then allocating buffers. Shader-rendering (Round 1, Error 4) correctly flagged that I did not show the cache mechanism and warned about heap allocation in the hot path. I reaffirm the approach but accept the refinement: shape results should be written into a reusable flat pool (pre-allocated per batch dispatch), not fresh JS arrays. Shape once into the pool, iterate the pool to count, iterate again to fill typed arrays. The shaping cost (~0.1ms/1000 chars) is not doubled because we shape exactly once.

### 6. `textToGlyphs.js` / `layoutText.js` — "keep as fallback" — RETRACTED

My Phase 0 (line 391-392) said "Mark deprecated / keep as non-HarfBuzz fallback." This is inconsistent with the `fallbackShape` retraction above and contradicts project policy. These files are dead code once HarfBuzz is the only shaping path. Delete them in Phase A. Clean cut.

### 7. `getGlyphIdMap()` ligature limitation — REAFFIRMED, NOTED

Migration-integration (Round 1, error 6) correctly observed that shaping individual graphemes through HarfBuzz will never produce ligature glyph IDs. For Cousine (no ligatures), this is a non-issue. I reaffirm the approach for Phase A but accept the obligation to document this limitation explicitly in the code.

### 8. Font URL path — RETRACTED

My Phase 0 used `/fonts/Cousine-Regular.ttf`. Migration-integration correctly placed the font at `assets/fonts/Cousine-Regular.ttf`, which maps to URL `/assets/fonts/Cousine-Regular.ttf` under the Go binary's FS serving. My path would 404. Retracted.

---

## Evolved Understanding

After seeing all Round 1 cross-references, three things crystallized:

**1. `font.glyphToPath()` is the critical Phase B blocker.** Shader-rendering's Error 2 in Round 1 is the most important finding across all three agents: the harfbuzzjs npm package does not expose outline extraction. Phase B's entire `SlugEncoder.js` design depends on an API that does not exist. The fix is `opentype.js` for outline extraction, which the original research doc already identified as an alternative. This means Phase B has two font libraries: HarfBuzz for shaping, opentype.js for outline extraction. Not ideal, but functional. The alternative — waiting for `libharfbuzz-gpu` from HarfBuzz 14.0 — is too speculative to plan around.

**2. The `applyPrebuiltBuffers` recount fallback (GlyphRenderer.js line 1364-1380) is a latent bug.** I flagged this in Phase 0 and Round 1, but after seeing the actual code (confirmed: line 1370 uses `iterGraphemes`, line 1373 checks `cp > 32`), the fix is simpler than I initially described. With HarfBuzz shaping, `itemMeta` is *always* provided by `buildBatchBuffers` — the fallback path at line 1364 only triggers when `itemMeta` is missing from structured clone or old worker code. The real fix is to ensure the shaped builder always includes `itemMeta` in its output (it already does), making the fallback dead code. Add an assertion or warning if the fallback triggers, then delete it in a follow-up.

**3. `buildBuffers.js` deletion requires routing `_buildBuffersSync`.** Shader-rendering's Error 1 in Round 1 is correct: `WorkerBridge._buildBuffersSync` (line 309-313) calls `buildGlyphBuffers` from `index.js`, NOT `buildBuffers` from `buildBuffers.js`. So `buildBuffers.js` has zero live importers (confirmed via grep). Migration-integration's deletion is safe. Shader-rendering's concern about `_buildBuffersSync` depending on `buildBuffers.js` is wrong — it depends on `buildGlyphBuffers` from `index.js`.

---

## Convergence

All three agents now agree on:

1. **Phase A is a clean cut, not a hybrid.** No fallback shaping path, no dual-mode builders, no deprecated-but-kept files.
2. **Vendor the harfbuzzjs JS wrapper.** Bare-specifier imports are broken in this project's module resolution.
3. **HarfBuzz WASM init is a startup gate.** Per-worker `_hbReady` flag, pre-warm during loading screen, fail-fast if init fails.
4. **SlugEncoder runs on main thread at font-load time, not in workers.** Curve/band textures are font-level data.
5. **`instanceCodepoint` rename to `instanceGlyphId` deferred to Phase B.** Rename + glyph-mode picking removal in one atomic commit.
6. **`MAX_BANDS` compile-time cap in Slug fragment shader.** Agreed for divergence control, regardless of GLSL ES 3.0 conformance status.
7. **`WorkerBridge.dispose()` needed for HarfBuzz WASM cleanup.** `CLEANUP` message before `worker.terminate()`.
8. **`try/finally` for `hb.createBuffer()` / `buffer.destroy()`.** Non-negotiable memory safety.
9. **Cluster-based whitespace detection.** `text.codePointAt(sg.cluster) === 32`.
10. **Phase B prototype required before integration.** Standalone HTML page: load font via opentype.js, extract curves, pack textures, evaluate winding shader in one instanced draw call.

---

## Remaining Tensions

### 1. `texture()` vs `texelFetch()` for `atlasMapTexture` — timing

Shader-rendering says fix in Phase A. Migration-integration says it is not a bug (NearestFilter + texel-center sampling is correct). I recommended the fix in Round 1. **My position**: fix it in Phase A as a cleanup. It is not a correctness bug today, but switching to `texelFetch()` removes a fragile implicit dependency on NearestFilter and +0.5 centering. Zero risk, one-line change, pays forward for Phase B which uses `texelFetch` everywhere.

### 2. `SlugEncoder` startup: main thread vs worker — WHERE specifically

All three agree it runs on main thread. But migration-integration's Phase 0 (line 37) still has `ensureCodepoints()` referencing `font.glyphToPath()` for on-demand glyph rasterization, and (Phase B, line 77) puts curve extraction as part of `SlugEncoder.js` on main thread. The open question is: does `opentype.js` parsing happen at startup (parse entire font, extract all ~400 glyphs), or lazily (parse on first encounter of a new glyph ID)? **My position**: startup. Code fonts have small charsets (~400 glyphs). Parsing all outlines at font-load time is <50ms. Lazy extraction adds complexity (texture regrow, partial upload) for no real gain at this charset size.

### 3. `buildGlyphBuffers()` single-item path

Shader-rendering (Round 1 gap) correctly noted that both Phase 0 docs only address `buildBatchBuffers`. `GlyphWorker.js` has a `BUILD` message type that dispatches `buildGlyphBuffers()` (single item). This path also needs HarfBuzz shaping. **My position**: deprecate `BUILD` / `buildGlyphBuffers()` entirely. Convert all callers to use `BUILD_BATCH` with a one-item array. The batch path handles single items correctly (it iterates an array that happens to have length 1). This removes a code path rather than adding HarfBuzz plumbing to two separate functions.

### 4. Three.js `RGIntegerFormat` availability

I raised this in Round 1. No agent has verified whether `THREE.RGIntegerFormat` exists in the project's Three.js version (>=0.150.0). **My position**: verify at implementation time. If missing, use `RGBAIntegerFormat` with 2 wasted channels. The memory cost is negligible (a few KB).

---

## Synthesis

### Phase A execution order

1. **Vendor harfbuzzjs** JS wrapper into `src/shaping/harfbuzz-wasm.js`. Place `hb.wasm` in `assets/wasm/` via `make prep-wasm`. Place `Cousine-Regular.ttf` in `assets/fonts/` (committed). Update Makefile `ASSETS` and `.gitignore`.
2. **Create `src/shaping/HarfBuzzShaper.js`** — WASM init, font load, `shape(text)` returning `[{glyphId, advance, xOffset, yOffset, cluster}]`. Worker-safe (no DOM/Three.js). Add `src/shaping/index.js` barrel export.
3. **Modify `GlyphWorker.js`** — new `INIT_FONT` message type. Persistent `hbFont`/`hbFace`/`hbBlob` state. `FONT_READY` response. `CLEANUP` message for teardown.
4. **Modify `WorkerBridge.js`** — per-worker `_hbReady` flag (parallels `_hasUVMap`). Font buffer transfer on first dispatch. `dispose()` method sending `CLEANUP`. Pre-warm during loading screen.
5. **Modify `GlyphAtlas.js`** — add `getGlyphIdMap(hbFont, hb)` producing `Map<number, {u0,v0,u1,v1}>`. Add `fillAtlasMapForGlyphIds()` for DataTexture population. Document ligature limitation.
6. **Modify `src/workers/builders/index.js`** — replace `iterGraphemes` loop with shaped glyph iteration. Shape-first allocation with reusable pool. Whitespace via `text.codePointAt(sg.cluster) === 32`. `xOffset`/`yOffset` baked into `instancePosition`.
7. **Delete** `textToGlyphs.js`, `layoutText.js`, `buildBuffers.js`. All have zero live importers.
8. **Switch `atlasMapTexture` lookup** from `texture()` to `texelFetch()` in `GlyphRenderer._getVertexShader()` and `PickingSystem.js`.
9. **Deprecate `BUILD` message type** in `GlyphWorker.js` — route to `BUILD_BATCH` with single-item array.
10. **Add `.ttf` MIME type** to `relay.go` MIME switch.

### Phase B prerequisites (before any integration)

1. **Standalone prototype**: HTML page that loads Cousine-Regular.ttf via `opentype.js`, extracts quadratic beziers for 5 glyphs, packs into HALF_FLOAT DataTexture, evaluates winding-number fragment shader in a single instanced draw call. This validates the full Slug pipeline outside the codebase.
2. **Performance benchmark**: measure fragment shader cost at 5000 instanced quads (one CodeGrid equivalent) on target hardware.
3. **If prototype fails performance**: Phase A is the stable endpoint. No code is thrown away.

---

## Dissent

### `opentype.js` as a permanent dependency concerns me

All three agents converge on `opentype.js` for Phase B outline extraction since `font.glyphToPath()` does not exist in harfbuzzjs. I accept this as the only viable path today, but I want to register that carrying two font libraries (HarfBuzz for shaping + opentype.js for outlines) is architecturally inelegant and doubles the font-parsing surface. The research doc mentions `libharfbuzz-gpu` (HarfBuzz 14.0, experimental) which would unify both operations. **My dissent**: Phase B should be designed so that `opentype.js` is an isolated, replaceable module behind a `GlyphOutlineProvider` interface. When/if `libharfbuzz-gpu` stabilizes, swapping the implementation should require changing one file, not refactoring the entire Slug pipeline. Neither other agent proposed this isolation boundary.

### Deprecating `buildGlyphBuffers()` (single-item path)

I am the only agent proposing this. Shader-rendering says to add HarfBuzz threading to both `buildGlyphBuffers` and `buildBatchBuffers`. Migration-integration does not address it. **My position**: maintaining two builder functions that do the same thing (one for single items, one for batches) is unnecessary code surface. The batch path handles `items.length === 1` correctly. Unifying to one path reduces the HarfBuzz integration surface by half and eliminates a category of divergence bugs. The `BUILD` message type in `GlyphWorker.js` becomes a thin adapter that wraps the single item into a one-element array and calls `buildBatchBuffers`.
