# Round 2: shader-rendering reviews migration-integration, shaping-pipeline (inverse)

Agent: shader-rendering
Review order: migration-integration Phase 0 first, shaping-pipeline Phase 0 second

---

## Reaffirm or Retract

### Position: `texture()` vs `texelFetch()` on `atlasMapTexture` — RETRACT the "bug" framing, reaffirm the cleanup recommendation

shaping-pipeline Round 1 challenged this as "misleading," noting NearestFilter is already set at `GlyphAtlas.js:506-507`. migration-integration Round 1 called it "not a bug that needs fixing."

Both challenges are correct. I verified the atlas map texture construction in `GlyphRenderer.js` lines 173-174: `NearestFilter` is set. I also verified the vertex shader at line 363-365: the `(mapCol + 0.5) / atlasMapWidth` pattern centers the sample in the texel, making `texture()` and `texelFetch()` produce identical results under NearestFilter.

**Retraction**: The claim that this causes "bilinear filtering noise" was wrong. NearestFilter prevents interpolation entirely.

**Reaffirm**: Switching to `texelFetch()` is still the right call, but for a different reason: it removes the dependency on two float uniforms (`atlasMapWidth`, `atlasMapHeight`) that exist solely to support the `texture()` call's UV arithmetic. The integer form `ivec2(int(cp) % mapW, int(cp) / mapW)` is simpler, eliminates the float division, and makes the shader's intent explicit. This is a cleanup, not a correctness fix. Phase A priority: low.

### Position: GLSL ES 3.0 loop bounds with `flat in` varyings — RETRACT the "conformance violation" framing

migration-integration and shaping-pipeline both disagreed with my framing that `flat in int` loop bounds are "technically non-conformant." migration-integration correctly cites GLSL ES 3.0 section 4.1, which relaxed GLSL ES 1.0's constant-index-expression requirement. Dynamic loops are valid in GLSL ES 3.0.

**Retraction**: The conformance concern as stated was wrong. GLSL ES 3.0 permits dynamic loop bounds.

**Reaffirm**: The `MAX_BANDS` compile-time cap recommendation stands — but for GPU divergence control, not spec conformance. Without a cap, a glyph with an extreme band count (malformed font data, edge case) causes severe warp divergence. `min(vBandCount, MAX_BANDS)` as the loop bound is a robustness guard, not a spec requirement. The justification matters.

### Position: `glyphMapTexture` lookup in vertex shader, not fragment — REAFFIRM

shaping-pipeline did not contest this. migration-integration did not address it directly. The principle is: any per-glyph (per-instance) lookup that produces the same value for every pixel of a quad belongs in the vertex shader, passed as a `flat` varying, not re-evaluated per pixel in the fragment shader. This is the correct design for `glyphMapTexture` in Phase B, and it is not in contention.

### Position: Phase B outline extraction requires opentype.js, not harfbuzzjs — REAFFIRM

All three agents now agree: `font.glyphToPath()` does not exist in harfbuzzjs. migration-integration's Phase B `SlugEncoder.js` design as written is non-functional. opentype.js is the correct library for outline extraction. This position was stated in Round 1 and is now the consensus.

### Position: Phase B is higher risk than Phase A — REAFFIRM

migration-integration called Phase B's Slug fragment shader performance the "Highest risk" item. shaping-pipeline Round 1 noted that SlugEncoder should run on the main thread (not workers), which means the GPU texture upload path is straightforward. Neither challenged the risk assessment itself. The risk is real: no existing proof that the Slug fragment shader sustains 60fps at 10K instanced quads in a browser WebGL 2 context. Phase A can ship and stabilize independently. The prototype gate I proposed in Round 1 remains the correct risk gate for Phase B.

---

## Evolved Understanding

### The `iterGraphemes` fallback at `GlyphRenderer.js:1370` is the most dangerous silent breakage

Reading `applyPrebuiltBuffers()` at lines 1364-1380 directly: when `itemMeta` is absent, the fallback reconstructs it by calling `iterGraphemes(text)` and counting glyphs with `cp > 32`. With HarfBuzz shaping, glyph count may differ from grapheme count (ligatures reduce count). If `itemMeta` is missing for any shaped batch — due to a worker message or structured clone issue — this fallback produces incorrect `bufferStartIndex` values for every item after the first divergence. Highlight system and picking both depend on these offsets being correct. The fix shaping-pipeline and migration-integration propose (always include `itemMeta` in shaped output, add `shaped: true` flag) is sound. But it also means the fallback path itself (`iterGraphemes` counting) should be removed rather than left as a silent error source.

### Worker WASM readiness deserves the same per-worker flag discipline as `_hasUVMap`

After reading both round 1 outputs, the per-worker `_hbReady` flag is the correct pattern, not a global promise. `WorkerBridge.js` already handles `_hasUVMap` per-worker (line 107 per migration-integration's reference). The same discipline — track per-worker, gate dispatch, send init before first job — must apply to `_hbFont`. migration-integration's aggregate `_shapingReady` promise is insufficient for round-robin dispatch. My Round 1 position on this stands.

### SlugEncoder belongs on the main thread; workers only shape text

shaping-pipeline's Round 1 review correctly identified that migration-integration incorrectly placed SlugEncoder in the worker path for Phase B. Curve/band textures are font-level data — one set per glyph in the font, shared across all instances. Building them per-job in workers and transferring curve data back to the main thread for texture upload is a round-trip that serves no purpose; the data never changes between jobs. The existing architectural boundary — atlas/texture work on main thread, buffer building in workers — must be preserved for Phase B exactly as it is for Phase A.

This clarifies Phase B's data flow:
- Main thread at startup: `opentype.js` outline extraction → SlugEncoder → CurveTexture + BandTexture + GlyphMapTexture (GPU upload once)
- Workers per job: HarfBuzz shaping → instance buffer build → transfer to main → `applyPrebuiltBuffers()`

The worker bridge change for Phase B is additive, not architectural.

---

## Convergence

All three agents now agree on:

1. **`font.glyphToPath()` does not exist in harfbuzzjs.** Phase B requires `opentype.js` for outline extraction.

2. **No fallback (`fallbackShape`) in committed builder code.** HarfBuzz readiness is a startup concern, not a per-job runtime branch. The `hbReady ? shapeText() : fallbackShape()` pattern in shaping-pipeline's pseudocode must not be implemented.

3. **SlugEncoder runs on the main thread once at font load, not in workers.** Curve/band textures are font-level, not per-text.

4. **Vendor the harfbuzzjs JS wrapper.** Bare-specifier imports fail in worker context without a bundler or import map.

5. **Per-worker `_hbReady` flag pattern** (mirrors `_hasUVMap`).

6. **`try/finally` on `hb.createBuffer().destroy()`** in `shapeText()`.

7. **`MAX_BANDS` compile-time cap** in the Slug fragment shader (for divergence control, not GLSL conformance).

8. **Delete `textToGlyphs.js` and `layoutText.js` in Phase A** — no deprecated-but-kept files.

9. **`applyPrebuiltBuffers` fallback `iterGraphemes` recount** at `GlyphRenderer.js:1370` must be gated or removed before Phase A ships.

10. **`.ttf` MIME type** in `relay.go` switch block.

---

## Remaining Tensions

### Tension 1 — `buildBuffers.js` deletion: Phase A or pre-Phase A prerequisite?

Round 1: I said delete after auditing `_buildBuffersSync`. migration-integration said delete in Phase A. shaping-pipeline said delete immediately.

The live code confirms: `WorkerBridge._buildBuffersSync` (line 309) calls `buildBuffers` and is the sync fallback used when `this.workers.length === 0` (`WorkerBridge.buildBuffers()`, line 183). If `buildBuffers.js` is deleted before `_buildBuffersSync` is rerouted to the builders in `index.js`, the zero-worker sync path breaks silently.

**Remaining tension**: The three agents disagree on sequencing. My position: audit and reroute `_buildBuffersSync` to `buildGlyphBuffers` from `index.js` as a preparatory step, then delete `buildBuffers.js`. This is not a Phase A delivery item — it is a prerequisite gate before any Phase A work touches the worker bridge. Deleting it in Phase A without the reroute is the risk.

### Tension 2 — `shapeText.js` file location: `src/workers/builders/` vs `src/shaping/`

Round 1: I argued `src/workers/builders/` (enforced worker-safe zone). shaping-pipeline Round 1 partially conceded, suggesting `src/shaping/HarfBuzzShaper.js` is the right location if it has zero DOM/Three.js deps. migration-integration proposed `src/shaping/` as the domain-concept directory.

**Still unresolved**: The project's established convention is that `src/workers/builders/` is the worker-safe zone by structural enforcement — DOM and Three.js imports simply don't exist there. `src/shaping/` has no such enforcement; accidental imports can creep in as the module grows. The safer long-term choice is `src/workers/builders/shapeText.js` for the worker-callable portion, with `src/shaping/` reserved for main-thread-only classes (`SlugEncoder`, `CurveTexture`, `BandTexture`). This matches the existing two-zone model: main-thread concerns in `src/`, worker-safe functions in `src/workers/builders/`.

### Tension 3 — Phase A risk assessment relative to Phase B

shaping-pipeline treated Phase A (HarfBuzz WASM in workers, uvMap rekeying, builder rewrite) as lower risk. migration-integration agreed. I assessed Phase B as higher risk due to the Slug ALU budget and the `opentype.js` dependency. The ordering is agreed, but the question of *how much* Phase A risk is still open: the `applyPrebuiltBuffers` fallback issue, the WASM per-worker readiness race, and the uvMap rekeying transition all represent concrete failure modes that neither Phase 0 document treated as significant. I consider Phase A's operational risk underestimated.

---

## Synthesis

### Phase A (ship first, stabilize)

**Prerequisite (before Phase A work begins):**
- Reroute `WorkerBridge._buildBuffersSync` to use `buildGlyphBuffers` from `src/workers/builders/index.js`
- Delete `buildBuffers.js` after confirming no other callers
- Remove `iterGraphemes` fallback from `applyPrebuiltBuffers` at `GlyphRenderer.js:1370` (or gate it on `!itemMeta` only when the shaped flag is absent, and document it as legacy-only)

**New files:**
- `src/workers/builders/shapeText.js` — HarfBuzz buffer create/shape/json/destroy, `try/finally`, returns flat glyph array with newline markers; no DOM, no Three.js
- `assets/fonts/Cousine-Regular.ttf` — committed
- `assets/wasm/` — `.gitignore`'d, populated by `make prep-wasm`

**Modified files:**
- `src/workers/builders/index.js` — shape-first allocation (one `shapeText()` call, flat result array, count pass, allocate, fill pass)
- `src/workers/GlyphWorker.js` — `INIT_FONT` handler, persistent `hbBlob`/`hbFace`/`hbFont`
- `src/workers/WorkerBridge.js` — per-worker `_hbReady` flag, `dispose()` sends `CLEANUP`, pre-warms all workers during loading screen
- `src/GlyphAtlas.js` — `getGlyphIdMap(hbFont, hb)` builds `glyphIdUvMap` once at init
- `relay.go` — add `.ttf` MIME type case
- `Makefile` — `ASSETS` list + `prep-wasm` target

**Deleted:** `textToGlyphs.js`, `layoutText.js`

**Unchanged:** `GlyphRenderer.js` shaders, `PickingSystem.js`, `GridVirtualizer.js`, all highlight/picking/group systems

**`texelFetch` cleanup**: Switch `atlasMapTexture` lookup at `GlyphRenderer.js:365` to `texelFetch` as a low-priority cleanup — correct but not urgent.

### Phase B (prototype gate required)

Before any Phase B integration work:
- Standalone HTML prototype: `opentype.js` loads `.ttf`, extracts quadratic beziers for 3 glyphs, packs into `HALF_FLOAT` DataTexture + `RG16UI` (or `RGBA16UI`) band texture, winding-number fragment shader in a single instanced draw, `MAX_BANDS = 64` compile-time cap
- Target hardware: M1 MacBook + mid-range Android phone
- Success criterion: 10K instanced quads, winding-number evaluation, 60fps in Chrome DevTools

If prototype passes: proceed with `SlugEncoder`, `CurveTexture`, `BandTexture`, `GlyphMapTexture` on the main thread; vertex shader lookup of `glyphMapTexture` passing curve/band ranges as `flat` varyings; fragment shader winding evaluation.

If prototype fails: Phase A is the stable endpoint. No hybrid path.

---

## Dissent

### The `applyPrebuiltBuffers` fallback is a higher Phase A risk than all three agents acknowledged

The fallback at `GlyphRenderer.js:1364-1380` (confirmed in source) reconstructs `itemMeta` using `iterGraphemes` when it's absent. With shaped output, this produces wrong `bufferStartIndex` values whenever ligature counts differ from grapheme counts. Even if Cousine has no ligatures and Phase A seems fine, leaving this code in place means Phase B (or any future ligature font) silently corrupts highlight and picking offsets for every item after the first divergent one. The fix is removal, not documentation. The only safe `itemMeta`-absent scenario is old worker code that predates the shaped pipeline — and that case should fail loudly, not silently degrade to wrong offsets.

This is a single-agent position: the other two agents noted the issue but treated it as "add a shaped flag" rather than "remove the fallback entirely." I hold that the fallback must be removed before Phase A ships, not gated with a flag that will be forgotten.
