# Round 2: Agent B (Interface Design) Reviews C then A

**Round:** 2 (inverse order: C first, then A)
**Date:** 2026-03-25

---

## 1. Evolved Understanding

After reading all three Round 1 cross-references, my understanding has sharpened on three points:

**The uvMap elimination question is more nuanced than any of us initially framed.** In Round 1, I (B) noted that workers no longer need the uvMap "in gpuLookup mode." A predicted full uvMap elimination. C correctly pointed out that the uvMap is still required for glyph-existence validation and that it cannot be removed until there is a shader-side fallback. After seeing C's implementation and A's Round 1 acknowledgment of this gap, I now see a clear dependency chain: shader fallback must come before worker uvMap elimination. C articulated this dependency most precisely (Round 1, section 4, item 5: "Phase 5 of A's plan without the shader fallback first" would break rendering). A acknowledged the gap in Round 1 (section 2, "Gaps") but underestimated its blocking nature.

**The dual shader source problem is worse than I initially assessed.** In Round 1 I flagged this as a "drift risk." After reading the actual code, I can confirm it is already drifted: `textVertex.glsl` line 21 uses `varying vec2 vUv` while `GlyphRenderer._getVertexShader()` line 268 uses `varying vec2 vUV`. The fragment shader inline version uses `vUV` while `textFragment.glsl` presumably uses `vUv`. The inline version is what runs; the .glsl files are dead code. All three agents flagged this independently -- it is the single most unanimous finding across all Round 1 reviews.

**C's 1024xN texture layout is the clear winner and nobody contests it.** In Round 1, A called it "superior to both A's abstract 1D and B's fixed 256x256." C justified the divergence from my 256x256 spec. I agreed in my own Round 1 review. This is fully settled.

---

## 2. Convergence

All three agents now agree on the following, with no remaining dissent:

1. **Core architecture is correct.** CPU emits codepoints, GPU resolves to UVs via DataTexture lookup. The pipeline works end-to-end.

2. **Float32Array for codepoints.** All three converge. IEEE 754 float32 exactly represents all Unicode codepoints. WebGL 1 compatibility requires it. My Round 1 spec's `Uint32Array` was wrong for the practical implementation; I retract it.

3. **1024xN dynamic texture layout.** Unanimously endorsed. ~160KB for current charset vs my spec's 1MB. Scales with actual glyph set.

4. **V-flip baked at texture build time.** All three agree this is correct. Saves per-vertex work, eliminates a class of bugs.

5. **No `gpuLookup` dual-mode flag.** Clean replacement on the experiment branch is the right call. All three agree.

6. **CPU-side fallback to `?` is sufficient for now.** A and I both designed GPU-side fallback; C implemented CPU-side. All three Round 1 reviews concluded C's approach is simpler and correct for current state.

7. **Atlas map texture invalidation is a bug.** A flagged it (Round 1, section 2: "one-line fix"). C flagged it (Round 1, section 4, item 2: "correctness bug"). I flagged it (Round 1, section 4: "Missing Interfaces"). `addGlyphIfMissing()` at line 453 sets `this.textureNeedsUpdate = true` but does not set `this._atlasMapTexture = null`. Confirmed by reading the code -- the cache at line 334 prevents newly added glyphs from appearing in the GPU lookup texture.

8. **Shader source duplication must be reconciled.** All three agents identified this independently. The `.glsl` files are dead code with a `vUv` vs `vUV` naming drift from the inline shaders.

---

## 3. Remaining Tensions

### 3.1 Shader fallback: adopt or defer?

C's Round 1 (section 4, item 1) recommends adopting B's `fallbackCodepoint` uniform as the next step, arguing it unlocks uvMap elimination from workers. A's Round 1 (section 4, "Recommendations") says CPU-side fallback is "simpler and more debuggable" and recommends keeping it. My Round 1 (section 5) recommended deferring the shader uniform.

**My evolved position:** C is right that the shader fallback is the key to unlocking worker simplification, but A is right that it is not needed for correctness today. The priority should be: fix the atlas invalidation bug first (unanimous), then add shader fallback as a follow-up that enables the worker optimization. This is a sequencing question, not a design disagreement.

### 3.2 Worker uvMap: replace with bitset or eliminate entirely?

A's Round 1 recommends replacing the uvMap with a "codepoint existence set" -- a lighter serialization. C recommends the shader fallback path that would eliminate the uvMap transfer entirely. I recommended a `Set` or bitfield.

**My evolved position:** These are two points on the same continuum. The lightweight existence check (bitset/Set) is a quick win that can land immediately. Full elimination via shader fallback is the correct end state but requires more work. Both are valid; do the bitset now, shader fallback later.

### 3.3 Backward mapping: how much to build now?

A's Round 1 recommends storing `sourceIndex` per glyph as a minimum. My Round 1 spec defined a full `HitTestWorld -> ResolveSource -> ResolveItem` pipeline. C did not implement backward mapping and notes it is "Phase 6."

**My evolved position:** A is right that `sourceIndex` per glyph is the minimum viable backward mapping. My full pipeline spec is over-engineered for the experiment branch. But I want to note: C's codepoint buffer already makes backward mapping easier than the old UV buffer (A's key finding in Round 1, section 5). The codepoints array preserves character identity directly. When backward mapping is needed, the data foundation is already in place -- no architectural changes required, just API surface.

### 3.4 `codePointAt()` vs `charCodeAt()`

A flagged this in the hypothesis and I echoed it in Round 1. C acknowledged it as "valid future advice but not a current gap." The builders use `charCodeAt()` at line 92 of `builders/index.js`.

**My evolved position:** This is a latent correctness issue, not a current bug. The charset is BMP-only today. If CJK supplementary plane or emoji are ever added, `charCodeAt()` will silently produce surrogate halves instead of codepoints, which will look up the wrong texel in the atlas map. The fix is trivial (`codePointAt()` + proper iteration stepping), but it is not urgent until the charset expands.

---

## 4. Synthesis: Unified Recommendation

Incorporating all three perspectives, here is the recommended action plan in priority order:

### Immediate (correctness fixes)

1. **Fix atlas map texture invalidation.** In `GlyphAtlas.addGlyphIfMissing()` (line 453 area) and `addGlyphsIfMissing()`, add `this._atlasMapTexture = null;` after `this.textureNeedsUpdate = true`. This is a one-line fix for a confirmed bug. All three agents agree.

2. **Reconcile shader sources.** Either delete `src/shaders/textVertex.glsl` and `textFragment.glsl` (they are dead code -- `_getVertexShader()` returns the inline literal, not a file fetch), or make `ShaderManager` load them and remove the inline versions. The `vUv`/`vUV` drift is already real. Recommendation: delete the .glsl files on this experiment branch since they serve no runtime purpose. If kept as documentation, rename them to `.glsl.reference` or similar to make their non-runtime status explicit.

### Short-term (experiment branch improvements)

3. **Replace worker uvMap with a codepoint existence bitset.** Change `getSerializedUVMap()` to emit a lightweight structure (e.g., `Uint8Array` indexed by codepoint, or a `Set` serialized as an array). The builders only call `uvMap[charCode] ? charCode : ...` -- they need a truthy/falsy check, not UV coordinates. Estimated savings: from ~220 entries of `{u0, v0, u1, v1}` objects to a flat array of 220 numbers. Small absolute gain, but eliminates conceptual coupling between the builder and the atlas UV layout.

4. **Add `fallbackCodepoint` uniform to the vertex shader.** When `uvRect == vec4(0.0)`, re-sample at codepoint 63. This enables future full elimination of the existence check from builders. The zero-rect sentinel is safe because no real glyph can have all-zero UVs (the atlas uses 6px padding, so u0/v0 are always > 0).

### Deferred (future work, not for this branch)

5. **Backward mapping API.** When hit-testing or text selection is needed, add `sourceIndex` tracking in `buildGlyphBuffers`/`buildBatchBuffers`. The codepoints buffer already provides character identity; `sourceIndex` adds positional identity. My full `HitTestWorld -> ResolveSource -> ResolveItem` pipeline is the target architecture but should be built incrementally.

6. **Switch `charCodeAt()` to `codePointAt()`.** Do this when expanding the charset beyond BMP. Not before.

7. **Clean up deprecated `GlyphInstancePool.js` references to `instanceUV`.** This file is in the "partially deprecated" layout subsystem. Its `instanceUV` reference at line 187 is orphaned code.

---

## 5. Dissent

### Position I hold that others do not: the `fallbackCodepoint` uniform matters more than the bitset optimization

A's Round 1 recommended keeping CPU-side fallback and reducing the worker uvMap to a lighter format. C's Round 1 recommended the shader fallback as "the cleanest path to completing A's predicted worker simplification." I agree with C's reasoning but want to elevate it further.

The shader fallback is not just about worker optimization. It is about **architectural decoupling**. Today, the buffer builders have a runtime dependency on atlas state: they must know which codepoints exist to resolve fallbacks. This means:
- Workers must receive atlas existence data before they can build buffers
- If the atlas grows dynamically (via `addGlyphIfMissing`), workers may have stale existence data
- The builder's output depends on atlas state, not just text content

With a shader fallback, builders become pure functions of text content. A builder receives text and emits codepoints -- no atlas knowledge needed. The GPU handles missing glyphs gracefully. This makes the builder:
- Truly worker-safe (no atlas data transfer needed at all)
- Deterministic (same text always produces same buffer, regardless of atlas state)
- Simpler to test (no mock uvMap needed)

A's bitset recommendation is a band-aid on the same coupling. The shader fallback eliminates it entirely. The cost is one conditional branch in the vertex shader per instance -- which modern GPUs handle in a single cycle via predication.

I recognize this is a stronger position than any of us took in Round 1. A explicitly recommended against it ("GPU-side fallback... avoids a branch in the vertex shader"). C recommended it but as a next step, not urgently. My position: the shader fallback should be the first enhancement after the correctness fixes, ahead of the bitset optimization, because it eliminates the need for the bitset entirely.

### Position on shader file consolidation

A and C both noted the dual shader issue but neither took a firm position on which to keep. I do: **delete the .glsl files**. The inline template literals in `_getVertexShader()` and `_getFragmentShader()` are the running code. The .glsl files are not loaded by any runtime path -- `ShaderManager` exists but is not invoked by `GlyphRenderer`. Keeping dead .glsl files alongside active inline shaders is a maintenance trap, not a documentation benefit. If external shader files are desired in the future, that should be a deliberate architectural choice with `ShaderManager` integration, not a parallel copy that has already drifted.

---

## Summary Matrix: Final Positions After Round 2

| Issue | A (Round 1) | B (Round 1) | C (Round 1) | B (Round 2 Synthesis) |
|---|---|---|---|---|
| Atlas invalidation bug | One-line fix | Missing interface | Correctness bug | Fix immediately (unanimous) |
| Shader duplication | Consolidate | Reconcile | Delete .glsl or load them | Delete .glsl files |
| Worker uvMap | Replace with Set | Replace with bitfield | Shader fallback first | Shader fallback first (agree with C) |
| Shader fallback uniform | Not needed (CPU is simpler) | Defer | Adopt next | Adopt next (stronger than C) |
| Backward mapping | sourceIndex minimum | Full pipeline | Phase 6 | sourceIndex when needed, pipeline later |
| `codePointAt()` | Future-proof | Endorsed | Not a current gap | Defer until charset expands |
| Texture layout | 1024xN best | 1024xN best | 1024xN justified | Settled: 1024xN |
| Buffer type | Float32Array | Float32Array (retracted Uint32) | Float32Array | Settled: Float32Array |
| Dual-mode flag | Not needed | Not needed (retracted) | Not needed | Settled: no flag |
