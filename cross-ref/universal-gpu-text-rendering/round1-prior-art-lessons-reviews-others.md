# Round 1: prior-art-lessons reviews rendering-backend-portability, universal-text-pipeline, device-tier-scaling, data-source-abstraction

## Errors Found

1. **universal-text-pipeline, line 12-13: Wrong per-glyph byte count.** Claims "11 floats = 44 bytes" per glyph. The actual count is 10 floats = 40 bytes: positions(3) + sizes(2) + codepoints(1) + colors(3) + groupIds(1) = 10. Verified in `src/workers/builders/index.js` lines 294-298 and `src/GlyphRenderer.js` lines 300-304. The "11 floats" figure does not match any code path. This propagates into the proposed `GlyphBufferSet` specification where downstream consumers would calculate wrong buffer sizes.

2. **rendering-backend-portability, line 24: `_createInstanceMesh()` line reference.** States "line 214" for `_createInstanceMesh()`. Actual code confirms line 214, but also claims 5 vertex texture fetches per instance (line 95) in the software rasterizer section. The actual count in the vertex shader (`_getVertexShader()`, lines 328-369) is 3 group texture samples + 1 atlas map sample + 1 highlight texelFetch = 5. This count is correct.

3. **device-tier-scaling, line 39: "Each CodeGrid gets its own GlyphRenderer."** This is misleading. `CodeGrid` wraps a `GlyphCollection`, which wraps a `GlyphRenderer`. Multiple CodeGrids share the same `GlyphAtlas` instance (correct, via `getSharedThreeTexture`), but the statement implies the atlas cost is fully amortized while the per-renderer overhead is duplicated. In practice, the per-grid overhead is dominated by the highlight DataTexture and instance buffers, not a "per-renderer" fixed cost. The 22 MB "fixed overhead per renderer" figure (line 37) is misleading because the atlas and picking target are shared/global, not per-renderer.

4. **data-source-abstraction, line 27: `textToGlyphs() -> buildBuffers()` in the call chain.** The actual call chain goes through `buildBatchBuffers()` or `buildGlyphBuffers()` in `src/workers/builders/index.js`. There is no function called `buildBuffers()` in the codebase. The `textToGlyphs` reference appears to be from an older iteration; the current pipeline uses `iterGraphemes()` from `src/utils/grapheme.js` inline within the buffer builders, not as a separate `textToGlyphs()` call in the data flow.

5. **device-tier-scaling, line 289: iOS Safari 16MB texture limit claim.** The 2048x2048 RGBA atlas is 2048 * 2048 * 4 = 16,777,216 bytes = exactly 16 MB. The claim that "mipmapped upload may exceed this" is correct in principle, but Three.js generates mipmaps on the GPU via `gl.generateMipmap()`, not by uploading them as a single payload. The actual risk is the base upload hitting the 16MB limit, not mipmaps. The mitigation suggestion to "disable mipmaps on iOS" would not help if the base texture itself is the problem.

## Gaps

**What my analysis covered that others missed:**
- Xi-editor's CRDT/multi-process failure mode and the specific lessons about modularity tax. No other agent references this, yet it directly constrains how far the data-source-abstraction's `SourceBoundGrid` + `TextSource` + `FileSystemProvider` layering should go.
- The font rasterization quality comparison across projects (Alacritty crossfont, Zed OS APIs, egui ab_glyph, ImGui stb_truetype). Device-tier-scaling discusses atlas sizing but never addresses font quality degradation at smaller atlas sizes.
- The convergence evidence: every successful project independently arrived at bitmap atlas + textured quads. This validates the architecture but none of the other agents explicitly framed it as cross-project convergence.

**What others covered that I missed:**
- **rendering-backend-portability**: The precise 13-function `GlyphGPU` interface. My analysis recommended "formalize the buffer contract" but did not produce a concrete API. The `GlyphGPU` interface is actionable where my recommendation was directional.
- **device-tier-scaling**: Memory budget arithmetic and the critical insight that `GridVirtualizer` culls draw calls but not VRAM (line 79). My analysis mentioned GridVirtualizer for visibility culling but did not identify the memory/draw-call distinction.
- **data-source-abstraction**: Backpressure and flow control for streaming sources (Section 6). My analysis focused on the render pipeline and did not address data ingestion rate at all.
- **universal-text-pipeline**: The MSDF evaluation (lines 167-170). I mentioned Bevy's bitmap-vs-SDF decision but did not cover MSDF specifically, which is the right long-term answer for 3D zoom-independent text.
- **device-tier-scaling**: WebGL context loss handling (line 287). None of my prior-art subjects explicitly solved this, but it is a real production issue for the browser deployment.

## Tensions

1. **Per-glyph byte count: 40 vs 44.** rendering-backend-portability (line 24) and device-tier-scaling (line 19) both correctly state 10 floats = 40 bytes for instance attributes, with device-tier-scaling adding +4 bytes for the highlight texture = 44 bytes effective. universal-text-pipeline (line 12) claims 11 floats = 44 bytes for the instance attributes alone, which is wrong. **Correct answer**: 10 floats = 40 bytes instance data + 4 bytes RGBA8 highlight = 44 bytes total effective per glyph. The buffer contract should document 10 floats, not 11.

2. **MSDF vs bitmap atlas.** universal-text-pipeline (line 170) recommends MSDF as "the right long-term move." My analysis (Section 1.5 on Bevy) and the prior art evidence show bitmap won over SDF in every shipping project for code/UI text. The tension is real: bitmap is proven and simpler; MSDF solves the zoom problem cleanly. **Resolution**: Both are right at different timescales. Bitmap is correct for shipping now; MSDF is correct for the 3D zoom use case long-term. The pre-baked atlas strategy from universal-text-pipeline (line 172-183) is the right bridge -- it decouples generation from rendering, so swapping bitmap for MSDF is a build-time change, not an architecture change.

3. **Abstraction layer size.** rendering-backend-portability proposes a 13-function `GlyphGPU` interface (Section C) as "the thinnest abstraction layer." data-source-abstraction proposes `TextSource` + `SourceBoundGrid` + `ThrottledSourceBridge` + `SourceUpdateScheduler` -- four new classes above the rendering pipeline. My analysis warns against over-modularization (Section 6.5, citing Xi-editor). **Resolution**: The GPU abstraction (rendering-backend-portability) is at the right level -- it is a data contract, not a process boundary. The data-source classes (data-source-abstraction) risk the Xi-editor pattern: organizational abstractions that multiply coordination without proportional benefit. `TextSource` alone is justified; the scheduler/throttle/bridge layers should be deferred until a concrete streaming use case demands them.

4. **readPixel sync vs async.** rendering-backend-portability (line 146) and device-tier-scaling (line 291) both identify the sync `readPixels` issue. rendering-backend-portability recommends async-first (`readPixel -> Promise`). device-tier-scaling recommends throttling to every 3rd frame on mobile. **Both are correct and complementary**: the API should be async, and the caller should throttle on constrained devices. These are not contradictions.

## Recommendations

1. **Fix the universal-text-pipeline byte count.** Change "11 floats = 44 bytes" to "10 floats = 40 bytes" in the `GlyphBufferSet` specification. The highlight texture's 4 bytes/glyph is a separate resource, not part of the buffer contract.

2. **Adopt the `GlyphGPU` 13-function interface from rendering-backend-portability as the formal GPU contract.** It is the most concrete and actionable proposal across all five analyses. Pair it with the `GlyphBufferSet` + `AtlasDescriptor` types from universal-text-pipeline (after correcting the byte count).

3. **Implement GridVirtualizer memory reclamation before adding new abstraction layers.** device-tier-scaling's insight that culling saves draw calls but not VRAM (line 79) is the highest-impact finding. Adding `unloadContent()` / `loadContent()` to CodeGrid, triggered by distance thresholds in GridVirtualizer, would make the existing architecture viable on Tier 2 devices without any new classes.

4. **Defer data-source-abstraction's scheduler and throttle layers.** Implement only `TextSource` and `FileTextSource` initially. The `ThrottledSourceBridge` and `SourceUpdateScheduler` solve problems that do not yet exist in the codebase. When a streaming use case arrives, add them then.

5. **Add WebGL context loss handling.** device-tier-scaling identified this (line 287) and no other agent addressed it. This is a production bug on mobile. The handler needs to re-create atlas textures, instance buffers, and shaders from the existing in-memory data.

6. **Design the pre-baked atlas path as the MSDF bridge.** universal-text-pipeline's `loadAtlas(imageUrl, descriptorUrl)` proposal (line 279) is the right next step. Implementing it for bitmap atlases first means MSDF becomes a drop-in replacement at the generation stage without changing the runtime pipeline.

7. **Validate the `GlyphGPU` interface against the picking system specifically.** rendering-backend-portability's interface includes `readPixel -> Promise`, but the picking system also needs material/shader swapping per mesh (`PickingSystem._swapMaterials`, `_restoreMaterials`). The 13-function interface does not account for pipeline swapping. Add `setPipeline(pipeline)` or make `drawInstanced` accept the pipeline as a parameter (which it already does -- but the swap-restore pattern needs explicit support).

8. **Use device-tier-scaling's LOD bands (Section D.1) as the first scaling implementation.** The near/mid/far distance bands with the GridVirtualizer's existing `entry.distance` field are immediately implementable. This would reduce active glyph count by 80-90% at typical camera positions, directly addressing the Tier 2 viability gap.

9. **Do not introduce a custom GPU abstraction.** My prior-art analysis and rendering-backend-portability agree: use Three.js for WebGL, wgpu for native. The `GlyphGPU` interface should be a specification for backend implementors, not a runtime abstraction layer that sits between the pipeline and Three.js.

10. **Correct data-source-abstraction's call chain documentation.** Replace `textToGlyphs() -> buildBuffers()` with the actual functions: `iterGraphemes()` (from `src/utils/grapheme.js`) called inline within `buildGlyphBuffers()` / `buildBatchBuffers()` (from `src/workers/builders/index.js`).

## Key Insight

The five analyses collectively confirm that glyph3d-js's architecture is already the convergent design that every successful GPU text project has independently discovered -- bitmap atlas, instanced quads, typed-array buffer contract, platform-specific font rasterization behind a common interface. The path to universality is not redesign but formalization: the `GlyphGPU` interface from rendering-backend-portability and the `GlyphBufferSet` / `AtlasDescriptor` types from universal-text-pipeline are the two seams that need explicit specification. However, the most urgent work is not new abstractions -- it is the operational gaps that device-tier-scaling identified (memory reclamation, context loss, LOD), which are the difference between "works on the developer's machine" and "works in production on real devices." The prior art shows that projects fail not from wrong architecture but from missing operational robustness (Xi-editor's complexity tax, Zed's Blade maintenance burden). Prioritize making the existing architecture resilient before extending it.
