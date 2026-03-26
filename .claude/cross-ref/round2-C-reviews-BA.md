# Round 2 Cross-Reference: Agent C Reviews B then A (Inverse Order)

**Author:** Agent C (Implementation)
**Pass:** Round 2 — synthesis with inverse review order (B first, then A)
**Date:** 2026-03-25

---

## 0. What Changed After Seeing All Round 1 Outputs

In Round 1 I reviewed A then B cold, based only on the source files. Now I have read:
- A's full analysis of B and C
- B's full analysis of A and C
- My own Round 1 document

Three things shifted in my understanding:

**1. The dual-shader issue is more consequential than I rated it.** In my Round 1 I marked the `vUv` vs `vUV` discrepancy as "Low — documentation/correctness." After reading both A and B flag this independently as a drift risk, and verifying the inline shader in `GlyphRenderer._getVertexShader()` is what actually runs while `src/shaders/textVertex.glsl` is never fetched, I am upgrading this to Medium. The `.glsl` file is actively misleading: it uses `vUv` (lowercase v), the running shader uses `vUV` (uppercase V). Any developer editing the `.glsl` file and testing in an IDE with GLSL tooling will be editing dead code.

**2. The atlas map texture invalidation is a real bug, not just a concern.** A described it as a bug. B specified `invalidateUVLookupTexture()` as a required method. I confirmed in Round 1 that `addGlyphIfMissing()` at `GlyphAtlas.js:451-461` sets `this.textureNeedsUpdate = true` and calls `this.invalidateSerializedCache()` but does NOT null out `this._atlasMapTexture`. The early return at `GlyphAtlas.js:334` means any dynamically added glyph after the first `getAtlasMapTexture()` call will be invisible to the GPU. This is a one-line fix that all three agents identified independently. It should be treated as the highest priority actionable item.

**3. A's "eliminate uvMap from workers" prediction was directionally correct but mechanically wrong.** Both B and I said A's Phase 5 is incomplete because the builders still need the uvMap for existence validation. A acknowledged this in Round 1 and correctly identified the fix: add a shader-side fallback so the builder can emit raw codepoints without consulting the atlas. After reading B's Round 1 section 4.5 on the `fallbackCodepoint` uniform, and my own Round 1 section 4 analysis, I now believe the GPU-side fallback is the right long-term path, but it is not a blocker for the experiment. The current CPU-side fallback is correct and sufficient.

---

## 1. Review: B's Interface Spec (Second Look)

Reading B's output through the lens of the completed implementation, the key findings:

### B's spec that was right and shipped

**Core interface change** — `instanceCodepoint` (float, 1 per glyph) replacing `instanceUV` (vec4, 4 per glyph) — was correctly specified and correctly implemented. The naming diverged (B's `getUVLookupTexture()` vs C's `getAtlasMapTexture()`), but the structural contract is identical. B's spec was a sound upstream design.

**CPU-side fallback** — B's section 3.3 correctly recommended Float32Array as "Option A (recommended for v1)" and acknowledged the CPU-side fallback is sufficient. The spec and implementation agree at the level of what was built, even if the primary spec text said `Uint32Array`.

**V-flip baked at texture build time** — B's Round 1 review (section 1) correctly recognized this as an improvement over B's own spec, which had the flip in the shader. C's baked approach is confirmed best.

### B's spec that was over-specified and not needed

**`gpuLookup` dual-mode constructor flag** — B's Round 1 agrees with my Round 1: C's clean replacement was correct for the experiment branch. The flag would have added dead code. No change needed.

**256x256 fixed texture** — B's Round 1 directly concedes: "C is right, and better." The 1024xN approach is confirmed. B's 256x256 was based on assumptions about GPU alignment (square textures) that do not apply here — 1024 is itself GPU-aligned and the texture is compact.

**`fallbackCodepoint` uniform** — B's Round 1 concludes "C is right. CPU fallback is simpler and sufficient." This is fully converged across all three agents. The shader uniform is a future optimization contingent on wanting to eliminate uvMap from workers entirely, not a current correctness gap.

**`SegmentText → PackBuffers → UploadBuffers` decomposition** — B's Round 1 (section 4) acknowledges these stages are "not needed in current form." The existing `buildGlyphBuffers` / `buildBatchBuffers` functions serve the same purpose with less abstraction. Correct call to defer.

### B's spec that remains unresolved

**Shader dual-source** — B's Round 1 (section 4, "Dual Shader Files") flags the same issue I found: `vUv` in `textVertex.glsl`, `vUV` in `GlyphRenderer._getVertexShader()`, and only the inline version runs. B recommends reconciliation. A recommends reconciliation. I recommend reconciliation. This is the only technical item where all three agents agree on what to do and it still has not been done. See section 5 (Dissent) for my position on priority.

**Atlas map texture invalidation** — B's `invalidateUVLookupTexture()` is the named interface for what is actually a one-line fix: `this._atlasMapTexture = null` in `addGlyphIfMissing()`. B's Round 1 did not change position on this; it remains "missing" in the implementation.

---

## 2. Review: A's Algorithm Hypothesis (Second Look)

### A's hypothesis that was fully validated

**"CPU emits UTF-32 codepoints during existing sequential layout pass"** — Confirmed by the actual builder code at `src/workers/builders/index.js:115,131`. A's core insight was precisely correct: replace the 4-float UV write with a single codepoint float write in the same loop iteration, with zero structural change to the layout algorithm.

**"float32 exactly represents all Unicode codepoints"** — Confirmed. All agents agree. No precision risk.

**"Option A: direct 1D DataTexture indexed by codepoint"** — Confirmed implemented. A's pseudocode for the vertex shader (`mod(cp, width) / floor(cp / width)`) matches the actual GLSL in `textVertex.glsl:58-61` and `GlyphRenderer.js:298-301` exactly. A predicted the right approach.

**"GPU prefix-sum unnecessary"** — Confirmed. The fixed-width codepoint-per-glyph model makes this trivially parallel. No scan mechanism was implemented or needed.

**"Option B (hash table in texture) and Option C (structured grid) not viable"** — Confirmed. Direct indexing works for the charset in use.

**"75% UV buffer reduction"** — Confirmed. 4 floats/glyph → 1 float/glyph. Validated by the buffer allocations in `builders/index.js:70-74`.

### A's hypothesis where the implementation diverged

**"Texture width = maxCodepoint + 1 (true 1D)"** — A described a conceptual 1D texture. The implementation uses 1024-column rows as a practical 2D approximation of 1D. This requires two extra uniforms (`atlasMapWidth`, `atlasMapHeight`) that A's hypothesis did not specify, since A assumed the width would be passed as a compile-time constant. The 1024xN approach is strictly better (memory-efficient, GPU-aligned), so this divergence is an improvement not a gap.

**"Eliminate uvMap from worker path"** — A's Phase 5 remains unimplemented. The uvMap is still serialized and transferred to workers for glyph existence validation. A's Round 1 acknowledged this was an overstatement of the elimination. The fix requires either (a) the `fallbackCodepoint` GPU uniform so builders can emit raw codepoints without validation, or (b) replacing the full uvMap with a lightweight bitfield. Neither has been implemented. This remains the most significant gap between A's predictions and current state.

**"Phase 1-6 sequential implementation"** — A's 6-phase plan was collapsed into a single implementation pass that covered phases 1-4. Phases 5 (worker cleanup) and 6 (backward mapping) remain as future work. This is not a problem — the experiment branch validated the core hypothesis without needing the cleanup phases.

### A's hypothesis position that B and I disagree with

**"Store `sourceIndex` per glyph for backward mapping"** — A's Round 1 recommended adding a `sourceIndex` field per glyph to `itemMeta` or a parallel CPU array. I disagree that this is necessary now. The `applyPrebuiltBuffers` path at `GlyphRenderer.js:1136-1158` stores `charCode: codepoints[bufIdx]` for each glyph, which is what was impossible with the old UV-only path. A backward hit-test that knows which buffer index was intersected can now directly read the codepoint. The full `(line, column, charIndex)` triple would require per-glyph storage of ~12 bytes of metadata alongside the GPU buffers, doubling the memory of the already-allocated CPU-side glyph objects. This is premature until there is a concrete hit-testing use case. B's Round 1 also agreed it is a "Phase 6 concern."

---

## 3. Convergence: Where All Agents Now Agree

After two rounds, the following positions are unanimous:

| Item | Consensus |
|---|---|
| Core approach: CPU codepoints, GPU DataTexture lookup | Correct and validated |
| Float32Array for `instanceCodepoint` | Correct — IEEE 754 safe for all Unicode |
| 1024xN DataTexture layout | Superior to both A's abstract 1D and B's fixed 256x256 |
| V-flip baked at `getAtlasMapTexture()` build time | Correct optimization |
| No `gpuLookup` dual-mode flag | Correct for experiment branch |
| CPU-side fallback (`? = 63`) in builder | Correct and sufficient |
| Fragment shader: no changes needed | Confirmed |
| Shader dual-source is a drift risk | Agreed — needs reconciliation |
| Atlas map texture invalidation is a bug | Agreed — one-line fix needed |
| Backward mapping `sourceIndex` per glyph | Agreed: defer to hit-testing work |
| Worker uvMap transfer: still needed for now | Agreed: partial elimination only |

---

## 4. Remaining Tensions

### Tension 1: How to reconcile the dual shader

All agents agree the dual-source must be reconciled. The question is which source wins:

- **Option A: Make `_getVertexShader()` load from `textVertex.glsl` via `ShaderManager`/fetch.** This is architecturally cleaner — the `.glsl` file is the source of truth, `ShaderManager` already exists for this purpose. But it introduces an async load that must complete before the renderer is usable.
- **Option B: Delete `textVertex.glsl` and keep only the inline template literal in `_getVertexShader()`.** Simpler immediately — no fetch needed, the inline version is confirmed working. But loses IDE GLSL tooling (syntax highlighting, validation).

My recommendation: Option B (delete the `.glsl` file) for the experiment branch. Option A (load from `.glsl`) when this merges to main, since `ShaderManager` already has the fetch infrastructure. The varying name must be unified to `vUV` (uppercase, as in the running inline shader) in both cases.

### Tension 2: Worker uvMap elimination path

A's Phase 5 and B's section 4.5 both envisioned full elimination of uvMap from the worker message. Currently:
- `WorkerBridge.getSerializedUVMap()` still serializes the full uvMap
- `GlyphWorker.js:48-49` still caches it
- `builders/index.js:115` uses it only for existence check

Three paths forward:
- **Path 1 (GPU fallback):** Add `fallbackCodepoint` uniform to shader. Builders emit raw `charCodeAt()` without validation. Unknown codepoints render as blank quads (zero UV rect). Workers no longer need uvMap at all. This is B's Phase 5 approach.
- **Path 2 (Bitfield):** Replace the full uvMap object with a `Uint8Array` bitfield of valid codepoints (~1KB for BMP coverage). Workers receive a much lighter validation structure.
- **Path 3 (Accept current state):** Leave it. The uvMap is cached per-worker after first transfer. The serialization cost is one-time per worker. For the experiment this is fine.

Path 3 is correct for now. Path 2 is the right long-term choice if the serialization overhead ever shows up in profiles. Path 1 (GPU fallback) is only worth implementing if we want dynamic atlas extension without rebuilding workers.

### Tension 3: The `char: ''` vs preserved character field

`GlyphRenderer.js:1155` sets `char: ''` when reconstructing glyph objects from the worker path. The old sync path presumably set `char` to the actual character string. This is a quiet regression: anything that reads `glyph.char` will get an empty string. The `charCode` field is set correctly from `codepoints[bufIdx]`. If any downstream code uses `glyph.char` (not just `glyph.charCode`), it would break silently. Worth auditing.

---

## 5. Synthesis: Unified Recommendation

Ordered by priority:

### Priority 1 — Fix (correctness bug, one line)

`GlyphAtlas.addGlyphIfMissing()` must invalidate `_atlasMapTexture` when a new glyph is added. Current state allows the GPU DataTexture to become stale:

```js
// In addGlyphIfMissing(), after this.textureNeedsUpdate = true:
this._atlasMapTexture = null;
// same in addGlyphsIfMissing() after any successful pack
```

The lazy rebuild in `getAtlasMapTexture()`'s early-return cache will then reconstruct on the next renderer initialization. This does require the renderer to re-bind the texture uniform, which may need a flag. At minimum the null invalidation prevents serving a stale texture.

File: `/Users/lugo/localdev/viz-web/glyph3d-js/src/GlphyAtlas.js` lines 451-461.

### Priority 2 — Fix (drift risk, low effort)

Delete `src/shaders/textVertex.glsl` or update it to match the inline shader in `GlyphRenderer._getVertexShader()` exactly. The varying name must be unified: the inline shader uses `vUV` (uppercase), the `.glsl` file uses `vUv` (mixed case). Since the `.glsl` file is never loaded at runtime, it is purely a documentation artifact that currently contradicts the running code.

File: `/Users/lugo/localdev/viz-web/glyph3d-js/src/shaders/textVertex.glsl`

### Priority 3 — Documentation (low effort, prevents regressions)

Add JSDoc to `buildGlyphBuffers` and `buildBatchBuffers` formally declaring the return type as:

```
@returns {{positions: Float32Array, sizes: Float32Array, codepoints: Float32Array, colors: Float32Array, groupIds: Float32Array, count: number, bounds: Object|null, itemMeta?: Array}}
```

`builders/index.js:48-49` already has partial JSDoc; it needs the `codepoints` field explicitly documented (currently it says `codepoints: Float32Array` in the comment but not the full shape).

### Priority 4 — Audit (risk assessment)

Search for any code that reads `glyph.char` (the string field on reconstructed glyph objects). The worker path sets this to `''` at `GlyphRenderer.js:1155`. If any example code, layout manager, or collection layer depends on `glyph.char`, it will get an empty string silently. The safe field is `glyph.charCode` which is correctly populated from `codepoints[bufIdx]`.

### Priority 5 — Future (do not implement now)

- Worker uvMap elimination (A's Phase 5): defer until GPU fallback uniform is designed or bitfield replacement is evaluated.
- Backward mapping `sourceIndex` per glyph (A's Phase 6): defer until hit-testing use case is specified.
- `gpuLookup` dual-mode flag (B's spec): defer to production merge, not needed on experiment branch.
- `SegmentText → PackBuffers → UploadBuffers` decomposition (B's spec): defer to when hit-testing or grapheme cluster support is required.

---

## 6. Dissent

### Position: The dual-shader issue should be fixed before any other work

A and B both flagged the dual-shader (inline vs `.glsl` file) as a "should fix" with medium priority. I'm pushing this to should-fix-first, ahead of everything except the atlas map invalidation bug.

My reasoning: the atlas map invalidation only triggers when `addGlyphIfMissing()` is called after `getAtlasMapTexture()` has been built. In current examples, glyphs are pre-generated at startup before any renderer is constructed, so the bug is latent. The shader discrepancy is active every time a developer opens `textVertex.glsl` in an editor. The GLSL file has `vUv` (lowercase v), the running shader has `vUV` (uppercase V). These will diverge further as the shader is maintained. The `.glsl` file will accumulate incorrect edits or mislead developers reading it for documentation.

The fix is 5 minutes: either add a comment at the top of `textVertex.glsl` saying "THIS FILE IS NOT LOADED AT RUNTIME — see GlyphRenderer._getVertexShader()" and unify the varying name, or delete the file. The atlas map bug takes the same effort but affects a less-traveled code path.

Both should be fixed, but if I had to sequence them: shader reconciliation first, atlas invalidation second, then documentation.

### Position: `codePointAt()` upgrade is less important than A argues

A's Round 1 (section "Should change" #5 equivalent) and B's Round 1 (section "Adopt From A's Hypothesis") both recommend switching from `charCodeAt()` to `codePointAt()` with surrogate-pair iteration for correctness with supplementary plane characters (emoji, rare CJK).

I maintain from my Round 1 that this is low priority for code visualization. The current atlas covers ASCII, box-drawing characters, and Latin-1 supplement. No supplementary plane character (above U+FFFF) is in the charset. When CJK or emoji support is added, the atlas generation code (`GlyphAtlas.generate()`) would need to change too — at that point, upgrading `charCodeAt` to `codePointAt` is the right co-change. Doing it now is correct but creates a behavioral change with no visible effect and introduces iteration complexity (surrogate pairs require a while loop instead of a for loop with integer index).

A and B recommend this as a "consider for later" / "future advice" item. I agree with that characterization, but both frame it as something worth noting prominently. I would not include it in any near-term work list.

---

## 7. Summary Table: Final Positions After Round 2

| Issue | A Position | B Position | C Position (this doc) | Status |
|---|---|---|---|---|
| Atlas map invalidation bug | Fix it (one line) | Fix it (`invalidateUVLookupTexture()`) | Fix it (Priority 1) | All agree, unimplemented |
| Dual shader reconciliation | Fix it (consolidate) | Fix it (reconcile) | Fix it (Priority 2, ahead of schedule) | All agree, unimplemented |
| `codePointAt()` upgrade | Recommend for correctness | Recommend for correctness | Defer until charset expansion | Minor dissent |
| Worker uvMap elimination | Phase 5 (future) | GPU fallback path | Accept current state, defer | Effective agreement |
| Backward mapping sourceIndex | Add minimum (sourceIndex) | Full pipeline (defer to Phase 6) | Defer (charCode is sufficient) | Minor dissent with A |
| `gpuLookup` flag | N/A | Defer to main merge | Not needed on experiment branch | Converged |
| `fallbackCodepoint` uniform | GPU-side ideal | GPU-side ideal | CPU-side sufficient; GPU path is future | Practical convergence |
| Float32Array for codepoints | Correct | Correct (primary spec was Uint32) | Correct | Fully converged |
| 1024xN texture | Correct (A didn't specify dims) | Better than B's 256x256 | Best approach | Fully converged |
| V-flip at build time | Correct | Better than shader flip | Correct | Fully converged |
