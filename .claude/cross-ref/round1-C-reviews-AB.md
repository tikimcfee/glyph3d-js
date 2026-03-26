# Round 1 Cross-Reference: Agent C Reviews A and B

**Author:** Agent C (Implementation)
**Branch:** experiment/buffers
**Date:** 2026-03-25

---

## 0. Ground Truth: What Was Actually Built

Before evaluating the hypotheses, a summary of the actual implementation on disk:

- `GlyphAtlas.getAtlasMapTexture(THREE)`: 1024×N RGBA Float DataTexture, codepoint-indexed, V-flip baked at build time.
- `GlyphRenderer`: `instanceCodepoint` Float32Array attribute (1 float/glyph). Uniforms: `atlasMapTexture`, `atlasMapWidth`, `atlasMapHeight`. No `instanceUV` attribute exists.
- Vertex shader (inline template literal in `_getVertexShader()`): computes `mod(cp, atlasMapWidth)` / `floor(cp / atlasMapWidth)` → texel coordinate → `texture2D` → pre-flipped UV rect.
- Buffer builders (`src/workers/builders/index.js`): emit `codepoints: Float32Array` at 1 float/glyph instead of `uvs: Float32Array` at 4 floats/glyph. The `uvMap` argument is still required for glyph existence validation (fallback to codepoint 63 when a char is missing from the atlas).
- `GlyphWorker.js`: zero-copy transfer of `codepoints.buffer` in `Transferable` list.
- `WorkerBridge`: `getSerializedUVMap()` and the `needsUVMap` tracking flag are still present and still transfer the uvMap to workers. The uvMap is now used only for existence checks, not for UV packing.
- No `gpuLookup` constructor flag. No `fallbackCodepoint` uniform. No dual-mode code path.
- The GLSL files in `src/shaders/` (`textVertex.glsl`, `textFragment.glsl`) are maintained in parallel with the inline shaders but are not loaded at runtime — `GlyphRenderer._getVertexShader()` returns a template literal, not a file fetch. The `.glsl` files appear to be documentation artifacts.

---

## 1. Theory vs Practice: Agent A's Algorithm Hypothesis

### What A got right

**CPU-emits-UTF-32 strategy (section 2):** Correct and validated. The implementation exactly follows A's "zero-overhead change" framing: the per-character loop already exists for layout computation, and replacing the `uvMap[charCode]` lookup + 4-float UV write with a single `codepoints[idx] = resolvedCode` write is a direct reduction in CPU work. A's note that float32 can exactly represent integers up to 2^24 — covering all of Unicode — is the correct justification for using Float32Array without precision loss.

**1D DataTexture indexed by codepoint (section 3, Option A):** Correct recommendation, and the implementation follows it directly. A's pseudocode for the vertex shader (`mod(cp, width)` / `floor(cp / width)`) matches the actual shader code verbatim. A's CPU-side construction logic (`data[cp * 4 + C]`) also matches `getAtlasMapTexture()` exactly.

**GPU prefix-sum scan is unnecessary (section 2):** Correct. No scan mechanism was needed or implemented. The 1:1 instance-to-glyph mapping with CPU-side layout pre-resolution made this trivially parallel.

**Hash table in texture unnecessary for current charset (Option B):** Correct. The 150KB estimate for the current charset is close to the actual allocation — max codepoint ~9615 (U+258F), so the 1024×10 texture is 409,600 bytes (~400KB), slightly larger than A's estimate but still negligible. A's 150KB estimate used a 1D texture without the 1024-wide row constraint; the actual 2D layout with 1024-column stride wastes some padding.

**Option C (structured grid) not viable:** Correct. Shelf packing precludes arithmetic UV computation.

### Where implementation reality differed from A's hypothesis

**uvMap still required in builders:** A hypothesized that passing codepoints "no longer requires uvMap access during buffer building" — but in practice, the builders still receive and use `uvMap` for glyph existence validation. When a character is not in the atlas, the builder falls back to codepoint 63 (`?`) rather than passing through an unmapped codepoint that would produce a zero UV rect (invisible quad). This is a correctness requirement A did not account for. The full elimination of uvMap from the worker path predicted by A has not been achieved.

**WorkerBridge still serializes and transfers uvMap:** A predicted that "the uvMap serialization bottleneck on the worker path" would be eliminated. It was not. `WorkerBridge.getSerializedUVMap()` is still called for every `buildBatchBuffers` call. The uvMap transfer reduction from the `needsUVMap` caching flag predated this experiment and remains unchanged. This is the most significant gap between A's prediction and current state.

**Texture dimensions:** A recommended width = max_codepoint + 1 for a true 1D texture. The implementation uses a fixed 1024-column stride regardless of charset. This was a deliberate choice for GPU compatibility (see section 3 below), but A's estimate of ~150KB is lower than the actual ~400KB because A's estimate assumed a 1D layout.

**6-phase implementation plan:** A outlined 6 phases; the implementation collapsed phases 1-4 into a single pass without the intermediate states A described. Phase 5 (worker path uvMap elimination) and phase 6 (backward mapping / hit testing) remain unimplemented.

---

## 2. Interface Gaps: Agent B's Interface Design

### B's interfaces that would directly improve the implementation

**`fallbackCodepoint` uniform (section 3.1):** B specified a shader-level fallback: when `uvRect == vec4(0.0)`, the shader re-samples the lookup texture at the fallback codepoint (default 63, `?`). The current implementation handles this on the CPU side in the builder — `resolvedCode = uvMap[charCode] ? charCode : (uvMap[63] ? 63 : 0)`. Moving this to the GPU shader would allow full uvMap elimination from the worker path: builders could emit raw codepoints without any existence check, and the shader would gracefully degrade for unknown codepoints. This is the cleanest path to completing A's predicted worker simplification.

**`GlyphBuffersGPULookup` interface definition (section 1.3):** B defined a typed interface for the buffer output structure. The actual return shape from `buildBatchBuffers` matches B's spec exactly: `{ positions, sizes, codepoints, colors, groupIds, count, bounds, itemMeta }`. Formalizing this as JSDoc would prevent regressions (e.g., a caller accidentally passing `uvs` to a method expecting `codepoints`).

**`invalidateUVLookupTexture()` method (section 2.3):** B specified a method to call when `addGlyphIfMissing()` succeeds and the atlas grows. The current `getAtlasMapTexture()` is lazy-created and cached — if the atlas grows after the first call, the DataTexture is stale. There is no invalidation path. This is a real bug for the dynamic glyph addition case.

**`CodepointLayout` interface with `sourceIndex`, `lineIndex`, `columnIndex` (section 5.1):** The current `itemMeta` array from `buildBatchBuffers` tracks `bufferStartIndex` and `glyphCount` per text item, which gives line-granularity mapping back to source. B's `CodepointLayout` goes further, tracking per-glyph source position. This would be valuable for selection/hit-testing but is not needed for the current rendering-only use case.

### B's interfaces that are over-engineered for current state

**`gpuLookup` constructor flag (section 4.1):** B specified a dual-mode flag for backward compatibility. The experiment branch replaced the UV path entirely — there is no legacy mode to preserve. Adding `gpuLookup` as a flag would create dead code. The value of dual-mode is for a production merge where old callers must not break; on this experiment branch, a clean cut was the right call.

**256×256 texture (section 2.1):** B recommended 256×256 (65536 entries, 1MB) for BMP coverage. The implementation used 1024×N sized to the actual charset. The 256×256 approach wastes ~7× more GPU memory for a charset of ~220 glyphs vs B's stated break-even. The 1024-wide approach is more efficient in practice. B's 256×256 has an advantage: the shader coordinate math is simpler (no need for `atlasMapWidth`/`atlasMapHeight` uniforms — they become compile-time constants of 256.0). This is a minor ergonomic difference.

**Two-tier hash table design (section 2.1 primary spec):** B's primary recommendation was a hash table with load factor < 0.5 and linear probing. B then noted this was "over-engineered for v1" and fell back to 256×256. The hash table path was never considered in the implementation and correctly so.

**Forward/backward mapping bundle pipeline (section 5):** B's `SegmentText → PackBuffers → UploadBuffers` composable stages and `HitTestWorld → GlyphIndexToSource` backward mapping are sound architectural thinking for a future interactive system, but they require restructuring the entire builder pipeline. The current implementation is a single-pass loop; decomposing it into pure composable stages would require significant refactoring with no immediate rendering benefit.

**TypeScript-style `interface` declarations throughout:** Useful documentation, not actionable for this JS-only codebase without a TypeScript build step. JSDoc equivalents would serve the same purpose.

---

## 3. Divergence Justification

### Float32Array vs Uint32Array

B specified `Uint32Array` for `instanceCodepoint`. The implementation uses `Float32Array`.

Reason: WebGL 1 attribute arrays must be either float or normalized integer types. `Uint32Array` as a vertex attribute requires WebGL 2 and GLSL `attribute uint`. Using `Float32Array` keeps the implementation compatible with WebGL 1 and is consistent with the existing `instanceGroupId` pattern (also a float-encoded integer). IEEE 754 float32 exactly represents all integers up to 2^24 = 16,777,216, which exceeds Unicode's maximum codepoint of 1,114,112. There is no precision risk. B acknowledged this in section 3.3 and recommended the Float32Array option as "Option A (recommended for v1)," so this is not a real disagreement — B's primary spec and the implementation converge on the same conclusion.

### 1024×N vs 256×256

B recommended 256×256. The implementation uses 1024×N where N = ceil((maxCodepoint + 1) / 1024).

Reason: The 256×256 texture allocates 65,536 texels regardless of charset size. For the current ~220-glyph charset with max codepoint ~9615, a 1024×10 texture uses only 10,240 texels — 6× smaller than 256×256. The 1024-column stride was chosen because it is a common maximum texture width that avoids edge cases on older hardware, while still being compact. The tradeoff is two additional uniforms (`atlasMapWidth`, `atlasMapHeight`). As the atlas grows (Latin extended, CJK), the texture grows in row count rather than immediately allocating a large fixed block.

The practical difference in this use case is minor: both are tiny textures. The 1024×N approach is more principled in that it scales with what is actually in the atlas.

### No gpuLookup flag

B specified a `gpuLookup: boolean` constructor option for backward compatibility. The implementation replaced the UV path entirely with no flag.

Reason: This is an experiment branch. The goal was to validate the GPU-lookup path end-to-end, not to maintain backward compatibility with the old UV path. Adding a flag creates two code paths that must both be tested and maintained. On this branch, a clean replacement is more productive. For a production merge into `main`, a flag or graceful fallback would be appropriate — but that decision belongs at merge time, not during the experiment.

### No fallback codepoint uniform

B specified a `fallbackCodepoint` uniform (default 63.0 = `?`) used in the shader when a UV rect lookup returns `vec4(0.0)`.

Reason: The fallback is currently handled on the CPU in the builder: `resolvedCode = uvMap[charCode] ? charCode : (uvMap[63] ? 63 : 0)`. This was the path of least resistance because the uvMap is already available in the builder for existence validation. Moving the fallback to the GPU shader is the cleaner long-term design — it would let the builder emit raw codepoints without atlas knowledge — but it requires the shader to distinguish between a zero UV rect for an unmapped glyph vs a legitimate all-zero UV rect (which cannot exist for any real glyph, since the atlas starts at `glyphPadding` = 6 pixels, but this implicit assumption is fragile). Implementing B's shader-side fallback cleanly requires a sentinel value convention, which was not designed at the time of the initial implementation.

---

## 4. What to Adopt Next vs What to Skip

### Should adopt

1. **`fallbackCodepoint` uniform in the shader** (from B, section 3.1). Adopt this to complete A's prediction of full uvMap elimination from workers. Once the shader handles unknown codepoints gracefully, the builder can be simplified to emit raw `charCodeAt()` values without any uvMap lookup. This removes the last coupling between the worker path and the atlas state.

2. **`invalidateUVLookupTexture()` on GlyphAtlas** (from B, section 2.3). The dynamic glyph addition path (`addGlyphIfMissing()`) leaves the `_atlasMapTexture` stale. This is a correctness bug that will manifest if any code calls `addGlyphIfMissing()` after `getAtlasMapTexture()` has been called. A simple invalidation flag and rebuild on next access would fix it.

3. **JSDoc `GlyphBuffersGPULookup` return type** (from B, section 1.3). Document the buffer shape as JSDoc on `buildGlyphBuffers` and `buildBatchBuffers`. Low effort, prevents interface drift.

4. **Reconcile the GLSL files vs inline shaders**. The `src/shaders/textVertex.glsl` and `textFragment.glsl` files use `varying vec2 vUv` while the inline shaders in `GlyphRenderer._getVertexShader()` use `varying vec2 vUV` (capital UV). The files appear to be out of sync with the running code. Either make `ShaderManager` load these files at runtime (replacing the template literals) or delete the files to avoid confusion.

### Should not adopt (at this time)

1. **256×256 fixed texture dimensions** (from B). The 1024×N approach is already implemented and is more memory-efficient for the current charset. No reason to change.

2. **`gpuLookup` constructor flag** (from B). This experiment branch validates the new path. The flag belongs in a production merge PR, not here.

3. **Forward/backward mapping bundle pipeline** (from B, section 5). The `CodepointLayout`, `SegmentText`, `PackBuffers`, `UploadBuffers` decomposition is valuable for a future interactive selection system. It is not needed for rendering correctness and would require restructuring stable code.

4. **Hash table texture** (from B, section 2.1 primary spec). B correctly ruled this out for v1. The direct-index texture handles the current charset trivially.

5. **Phase 5 of A's plan (worker uvMap elimination) without the shader fallback first**. A's predicted elimination of the uvMap transfer is incomplete until the shader-side fallback is in place. Attempting to remove uvMap from the worker without the fallback would break rendering for any character not in the atlas.

---

## 5. Performance Observations vs A's Predictions

### A's predicted 75% UV buffer reduction

Confirmed. The `uvs` array was 4 floats/glyph (16 bytes/glyph). The `codepoints` array is 1 float/glyph (4 bytes/glyph). This is a 75% reduction in that specific buffer. At 10,000 instances (the per-mesh cap), the reduction is 120KB → 40KB for the codepoints attribute. In practice this is a small absolute number — the position buffer (3 floats, 12 bytes/glyph) dominates.

### Worker transfer size

A predicted elimination of uvMap transfer overhead. In practice, `WorkerBridge` still transfers the uvMap (serialized via `getSerializedUVMap()`), with the `needsUVMap` per-worker flag providing cache-hit avoidance after the first transfer to each worker. The first transfer cost is unchanged. A's prediction is partially correct in that once each worker has the uvMap cached, subsequent dispatches do not re-transfer it — but this was already the case before this experiment via the `needsUVMap` optimization.

### GPU-side texture fetch

A did not provide timing estimates for the additional `texture2D` call in the vertex shader. In practice, the `atlasMapTexture` lookup is a NearestFilter fetch with no mipmaps, sized at ~400KB. On any modern GPU with a texture cache, this is not measurable in frame time. The shader change is performance-neutral at the frame level.

### Atlas map texture build time

A did not address one-time cost. `getAtlasMapTexture()` iterates the uvMap once (O(glyphCount) ≈ 220 iterations), allocates a Float32Array of ~41KB, and creates a DataTexture. This runs once at renderer construction and is negligible.

### Correctness of A's per-character path analysis

A correctly identified that `charCodeAt()` vs `codePointAt()` is a non-issue for the current BMP-only charset. The builders use `charCodeAt()` throughout, which matches the implementation. A's recommendation to use `codePointAt()` for correctness with supplementary plane characters is valid future advice but not a current gap.

---

## 6. Summary: Key Open Issues

| Issue | Source | Priority |
|---|---|---|
| `atlasMapTexture` stale after dynamic glyph addition | B (section 2.3) | High — correctness bug |
| `fallbackCodepoint` uniform for shader-side fallback | B (section 3.1) | Medium — enables uvMap elimination from workers |
| uvMap still transferred in WorkerBridge | A (phase 5) | Medium — depends on fallback uniform |
| GLSL files out of sync with inline shaders (`vUv` vs `vUV`) | Implementation finding | Low — documentation/correctness |
| JSDoc for `GlyphBuffersGPULookup` buffer shape | B (section 1.3) | Low — documentation |
