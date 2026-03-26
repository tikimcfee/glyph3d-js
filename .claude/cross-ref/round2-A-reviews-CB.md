# Round 2: Agent A (Algorithm Hypothesis) Reviews C then B

**Author:** Agent A (Algorithm Hypothesis), Round 2
**Review order:** C (Implementation) first, then B (Interface Design)
**Date:** 2026-03-25

---

## 1. Evolved Understanding

After reading all three Round 1 cross-references, my understanding has shifted in three significant ways.

### 1a. The uvMap elimination was the wrong goal

In Round 1, I flagged "Worker uvMap still transferred" as a gap and recommended replacing it with a codepoint existence set. After reading C's review (round1-C-reviews-AB, section 1) and B's review (round1-B-reviews-AC, section 2), I now see this differently.

C correctly identified that the uvMap is a **correctness requirement**, not a performance bottleneck. The per-worker caching via `needsUVMap` means the uvMap is transferred once per worker (3 transfers total), not per job. The actual cost is ~220 entries * ~48 bytes/entry = ~10KB, sent once. My hypothesis framed this as a "serialization bottleneck" -- that was wrong. The bottleneck was the per-glyph UV coordinate output (4 floats/glyph * N glyphs), which IS eliminated.

B's review (section 2) confirmed this: "the UV map is now used only as a presence check (boolean), not for coordinate extraction (4 floats)." The meaningful reduction was the output buffer (75% per-glyph), not the input map.

However, C raised an interesting forward path: if a `fallbackCodepoint` uniform were added to the shader, the builder could emit raw codepoints with no existence checking, and the uvMap parameter could truly be removed from the builder signature. This would make the worker path fully decoupled from atlas state. I did not consider this chain of dependencies in Round 1.

### 1b. The shader duplication is more serious than I realized

In Round 1, I noted the `vUv` vs `vUV` varying name discrepancy between `textVertex.glsl` and `_getVertexShader()` as a cleanup item. After reading all three reviews, I now see that every agent flagged this independently:

- My Round 1: "Inline shader duplication [...] will drift. Not both."
- B's Round 1 (section 4): "Two copies [...] different varying names (`vUv` vs `vUV`) [...] drift risk."
- C's Round 1 (section 4): "The `.glsl` files use `varying vec2 vUv` while the inline shaders [...] use `varying vec2 vUV`."

What I missed: the fragment shader uses `vUv` (in `textFragment.glsl`) while the inline fragment shader (in `_getFragmentShader()`) uses `vUV`. This means: **the external .glsl files cannot currently be loaded at runtime as a pair without a name mismatch with the inline version.** The fragment shader is the one that actually samples the texture, so the varying name must match between vertex and fragment. The inline versions are consistent with each other (`vUV` in both), and the external .glsl files are consistent with each other (`vUv` in both). But cross-mixing (inline vertex + external fragment, or vice versa) would silently fail -- the varying would not link, and all glyphs would render as the default interpolated value (likely black or transparent).

This elevates the issue from "cleanup" to "latent correctness bug if anyone tries to use ShaderManager."

### 1c. The atlas map texture invalidation is a real bug, not a hypothetical

All three agents flagged the `_atlasMapTexture` cache invalidation gap. Reading the code confirms it:

- `GlyphAtlas.addGlyphIfMissing()` (line 451-456): sets `this.textureNeedsUpdate = true` and calls `this.invalidateSerializedCache()` but does NOT set `this._atlasMapTexture = null`.
- `GlyphAtlas.getAtlasMapTexture()` (line 334): returns cached texture immediately if `this._atlasMapTexture` exists.

So: `addGlyphIfMissing()` adds a glyph to `this.uvMap` and marks the canvas texture dirty, but the GPU lookup DataTexture remains stale. Any glyph added after the first `getAtlasMapTexture()` call will render as a zero UV rect (invisible quad). The CPU builder's fallback to `?` masks this for known-missing codepoints, but a dynamically added glyph that the builder correctly emits (because uvMap now contains it) will have no entry in the atlas map texture.

This is not hypothetical. The `addGlyphIfMissing()` API exists, is documented, and is used in examples. The fix is trivially one line: `this._atlasMapTexture = null;` after `this.textureNeedsUpdate = true;` in both `addGlyphIfMissing()` and `addGlyphsIfMissing()`.

---

## 2. Convergence

All three agents now agree on the following, with no dissent:

### 2a. Core architecture is correct and validated

The CPU-codepoint + GPU-DataTexture-lookup approach works. C implemented it, the shader math is correct, the buffer format is correct, the forward rendering pipeline is end-to-end functional. No agent questions this.

### 2b. C's implementation choices win over B's spec where they diverge

| Decision | B's Spec | C's Implementation | All Agents Agree |
|---|---|---|---|
| Texture layout | 256x256 fixed | 1024xN dynamic | C is better |
| Buffer type | Uint32Array (canonical) | Float32Array | C is correct |
| Dual-mode flag | `gpuLookup` boolean | No flag, clean break | C is right for experiment branch |
| Fallback handling | GPU uniform | CPU builder | C is simpler and sufficient |
| V-flip | In-shader | Baked at texture build | C eliminates per-vertex work |

This is unanimous across all three Round 1 reviews.

### 2c. Three bugs/issues need fixing (priority order)

1. **Atlas map texture invalidation** -- correctness bug. All three agents flagged it. One-line fix.
2. **Shader source duplication** (`vUv` vs `vUV`) -- latent correctness bug. All three agents flagged it. Needs a decision: keep inline or keep external, not both.
3. **`charCodeAt()` vs `codePointAt()`** -- correctness for supplementary plane characters. B flagged it explicitly (section 5, "Adopt From A's Hypothesis"), I noted it in my original hypothesis, C acknowledged it as "valid future advice." Not urgent since the current charset is BMP-only, but it should be addressed before adding emoji/CJK supplementary.

### 2d. The `fallbackCodepoint` uniform is the gateway to full worker decoupling

C's review (section 4, "Should adopt") identified the dependency chain most clearly: shader-side fallback enables removing the uvMap from builders, which enables removing it from workers entirely. B designed the interface for this. I predicted the end state but not the intermediate step. All three agents now agree on the sequence: (1) add `fallbackCodepoint` uniform, (2) simplify builder to emit raw codepoints, (3) remove uvMap from worker transfer.

---

## 3. Remaining Tensions

### 3a. When (not whether) to implement backward mapping

B designed a full `HitTestWorld -> ResolveSource -> ResolveItem` pipeline with `CodepointLayout` and `SourcePosition` types. I specified `codepointBuffer + itemMeta + positions -> CPU hit-test` conceptually. C implemented nothing beyond what exists in `applyPrebuiltBuffers`.

The tension is not about the design -- all agree it will be needed. The tension is about timing and scope:
- B treats it as a current interface gap that should be designed now.
- C treats it as a future concern, explicitly deferring it.
- I sit between: the `sourceIndex` per glyph is cheap to add now (one integer per glyph in `itemMeta` or a parallel array), but the full hit-testing pipeline is a separate feature.

**My position after Round 2:** Add `sourceIndex` tracking to `buildBatchBuffers` now -- it is ~5 lines of code in the existing loop and costs nothing at runtime. Defer the spatial query and API surface to when an interactive feature needs it. This is the minimum that makes the backward path viable without over-engineering.

### 3b. Whether the shader fallback is worth the complexity

C expressed a nuance in Round 1 (section 3, "No fallback codepoint uniform") that the other agents glossed over: "Implementing B's shader-side fallback cleanly requires a sentinel value convention [...] the implicit assumption that no real glyph has an all-zero UV rect is fragile."

C is right that `vec4(0.0)` as a sentinel depends on atlas layout details (the first glyph is at `glyphPadding = 6` pixels, so u0 > 0 for all real glyphs). But this assumption is robust: a zero UV rect would mean a glyph at pixel (0,0) with zero width and height, which is physically impossible given the padding. The sentinel is safe. The question is whether the comment-level documentation of this assumption is sufficient vs. whether a more explicit sentinel (e.g., `vec4(-1.0)`) should be used for clarity.

I recommend using `vec4(0.0)` as the sentinel (it is the natural default for uninitialized texels in a zero-filled Float32Array) and documenting the invariant in `getAtlasMapTexture()`.

### 3c. External .glsl files: keep or delete?

All three agents agree the dual-source situation is bad. But there is a genuine design tension:
- **Delete the .glsl files:** Simplest. The inline template literal is what runs. But this loses syntax highlighting, linting, and tool support for GLSL.
- **Load the .glsl files at runtime via fetch:** Cleaner separation, but adds an async dependency to renderer construction, increases startup latency, and requires a server (currently the case, but it is a new runtime constraint on the renderer).
- **Keep .glsl as documentation only:** What C currently does, but this is where drift happens.

**My recommendation:** Keep the inline version as canonical (it is what runs), and either delete the external .glsl files or add a clear comment at the top of each: `// REFERENCE ONLY -- the canonical shader is in GlyphRenderer._getVertexShader()`. The `ShaderManager` class should not be used for these shaders unless the project adopts a fetch-based shader loading strategy project-wide.

---

## 4. Synthesis: Unified Recommendation

Having reviewed all three Round 1 analyses and re-read the implementation, here is a prioritized action plan that reflects the consensus.

### Tier 1: Fix now (correctness)

**1. Atlas map texture invalidation.**
In `addGlyphIfMissing()` (after line 453) and `addGlyphsIfMissing()` (after line 495), add:
```js
this._atlasMapTexture = null;
```
This is a one-line fix per method. Without it, dynamically added glyphs will be invisible in the GPU-lookup path.

**2. Reconcile shader sources.**
Choose one source of truth. Recommendation: the inline template literal in `_getVertexShader()` and `_getFragmentShader()` is canonical. Add a header comment to `textVertex.glsl` and `textFragment.glsl` indicating they are reference copies. Fix the `vUv`/`vUV` inconsistency so both use the same name (prefer `vUv` since it matches Three.js conventions).

### Tier 2: Improve soon (quality, enables future work)

**3. Add `fallbackCodepoint` uniform to the shader.**
This is the gateway improvement that all three agents identified as the path to full worker decoupling. Implementation:
- Add `uniform float fallbackCodepoint;` (default 63.0) to vertex shader.
- After `vec4 uvRect = texture2D(...)`, add: `if (uvRect == vec4(0.0)) { /* re-lookup at fallbackCodepoint */ }`.
- Simplify builders to emit raw `charCodeAt()` / `codePointAt()` values without uvMap existence checks.
- Remove `uvMap` parameter from `buildGlyphBuffers` and `buildBatchBuffers`.
- Remove uvMap serialization from `WorkerBridge`.

**4. Add `sourceIndex` tracking.**
In `buildBatchBuffers`, track the original string index `i` alongside each emitted glyph. Store it in `itemMeta` as a per-glyph array (e.g., `itemMeta[n].sourceIndices = Uint32Array`). This costs almost nothing and makes backward mapping possible without re-parsing.

**5. Switch `charCodeAt()` to `codePointAt()`.**
In `buildGlyphBuffers` and `buildBatchBuffers`, replace `text.charCodeAt(i)` with `text.codePointAt(i)` and add surrogate-pair skipping (`if (charCode > 0xFFFF) i++`). This is a 2-line change per function and future-proofs for supplementary plane characters.

### Tier 3: Defer (not needed yet)

**6. B's composable pipeline decomposition (`SegmentText -> PackBuffers -> UploadBuffers`).** The existing monolithic functions work. Decompose when adding grapheme cluster support or unit tests for builder stages.

**7. B's `CodepointLayout` type and full hit-testing pipeline.** Design this when building the first interactive feature (selection, click-to-source, etc.). The codepoint buffer already makes this easier than the old UV buffer.

**8. Worker uvMap replacement with a bitset.** Only relevant if Tier 2 item 3 (shader fallback) is not pursued. If the shader handles fallback, the uvMap is eliminated entirely from workers and this becomes moot.

---

## 5. Dissent

### 5a. I disagree with C on the fallback sentinel concern

C's Round 1 (section 3) called the `vec4(0.0)` sentinel assumption "fragile." I disagree. The atlas uses `glyphPadding = 6` pixels on a 2048-pixel canvas, making the minimum u0 = 6/2048 = 0.00293. A texel with u0 = 0.0 is structurally impossible for any packed glyph. The sentinel is not fragile -- it is a direct consequence of the packing algorithm. Furthermore, the Float32Array used for the DataTexture is zero-initialized by default in JavaScript, so unmapped codepoints will naturally have `vec4(0.0)` without any explicit sentinel assignment.

I recommend implementing the shader fallback using `vec4(0.0)` as the sentinel and documenting the invariant in one place (`getAtlasMapTexture()`), not treating it as a blocking concern.

### 5b. I disagree with B on the need for formal type definitions

B's spec defined `CodepointLayout`, `SourcePosition`, `AtlasMapEntry`, and `GlyphBuffersGPULookup` as formal TypeScript-style interfaces. C correctly noted this is over-specification for a JS project with no TypeScript build step. But B and C both recommend adding JSDoc for the buffer return type.

My position: the `@returns` JSDoc on `buildGlyphBuffers` (line 48-49 of builders/index.js) already documents the return shape accurately. Adding a separate `@typedef` block for `GlyphBuffersGPULookup` would duplicate this and create another drift surface. The JSDoc on the function is sufficient and is the single source of truth. Do not add parallel type definitions.

### 5c. The 1024xN texture is better than even A and C stated

In Round 1, I noted C's 1024xN layout was "superior to both A's abstract 1D and B's fixed 256x256." After re-reading the code, I want to strengthen this: the 1024-wide stride has a GPU-side advantage neither B nor C mentioned. Texture cache lines on modern GPUs are typically 64 or 128 bytes wide. A 1024-texel-wide RGBA Float row is 16KB, which fits cleanly into L1 texture cache on most discrete GPUs. The ASCII printable range (32-126) fits in a single cache line fetch spanning ~6 texels at the start of row 0. This means the most commonly accessed codepoints (ASCII) are spatially local in the texture, maximizing cache hits during the vertex shader's texture fetch. A 256-wide texture would spread ASCII across the same fraction of a row, but the 1024-wide texture's larger row means more codepoints share a single texture fetch row, improving locality for mixed-charset text.

This is a minor effect -- the texture is tiny regardless -- but it reinforces that C's choice was not just adequate but actively good.

---

## Summary Table: Status After Round 2

| Topic | Round 1 Status | Round 2 Status |
|---|---|---|
| Core GPU-lookup approach | All agree: correct | Confirmed, no change |
| 1024xN texture | A+B deferred to C | Unanimous: C's choice is best |
| Float32Array for codepoints | A+C agreed, B acknowledged | Unanimous |
| Atlas map cache invalidation | All flagged as bug | Unanimous: fix now, one-line |
| Shader duplication (vUv/vUV) | All flagged as risk | Elevated to latent correctness bug |
| Worker uvMap elimination | A predicted, C+B showed incomplete | Resolved: shader fallback is prerequisite |
| `fallbackCodepoint` uniform | B designed, C deferred, A didn't address | Consensus: implement as Tier 2 |
| Backward mapping | B designed fully, A conceptual, C deferred | Consensus: add `sourceIndex` now, defer full API |
| `charCodeAt` vs `codePointAt` | A+B flagged, C acknowledged | Consensus: switch, low effort |
| Formal type definitions | B designed, C rejected | Consensus: JSDoc on functions is sufficient |
| `gpuLookup` dual-mode | B designed, C rejected | Unanimous: not needed on experiment branch |
