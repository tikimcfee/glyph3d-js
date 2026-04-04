# Round 1: rendering-backend-portability reviews universal-text-pipeline, device-tier-scaling, data-source-abstraction, prior-art-lessons

## Errors Found

1. **universal-text-pipeline says "11 floats = 44 bytes" per glyph (line 13).** This is wrong. The builder at `src/workers/builders/index.js` lines 81-85 allocates: positions (3) + sizes (2) + codepoints (1) + colors (3) + groupIds (1) = **10 floats = 40 bytes**. The `GlyphBufferSet` definition on lines 31-39 of the same analysis then lists only 10 floats in the breakdown, contradicting its own header. The 44-byte figure from device-tier-scaling (40 instance + 4 highlight) is correct. universal-text-pipeline's "11 floats" appears to be a stale count from a version that had a separate UV attribute, which was removed when the GPU-side codepoint-to-UV lookup was added.

2. **universal-text-pipeline's proposed `AtlasDescriptor` includes `uvMap: Map<glyphId, {u0, v0, u1, v1}>` (line 46).** The actual atlas map is keyed by grapheme string, not glyphId. See `src/workers/builders/index.js` line 386: `const entry = uvMap[grapheme]`. The proposed interface conflates two different maps. The correct decomposition is: `graphemeToId: Map<string, u32>` (which they do include) and `uvMap` keyed by grapheme string (not numeric ID). Or, since the vertex shader resolves UVs via the DataTexture, the runtime `uvMap` only needs the `numericId` field -- UV coordinates never appear in the buffer contract at all.

3. **device-tier-scaling claims Mali-400 "lacks instancing entirely" (line 101, 104).** Mali-400 supports `ANGLE_instanced_arrays` via the WebGL extension on most Android drivers (confirmed by WebGL stats). It does not support WebGL 2 / GLES 3.0, which is the actual hard wall -- `gl_InstanceID` is unavailable. The distinction matters: the device can do instanced draw calls, it just cannot address instances from within the shader.

4. **device-tier-scaling claims "Each CodeGrid gets its own GlyphRenderer" (line 39).** This needs verification. `CodeGrid` creates a `GlyphCollection` which creates a `GlyphRenderer`, so this is functionally true, but the atlas texture is shared. The implication that per-grid overhead includes a full separate GlyphRenderer with its own group/highlight textures is correct, but the analysis should note that the highlight texture is sized to actual instance count (not a fixed allocation), so a grid with 100 glyphs uses 400 bytes of highlight texture, not a fixed cost.

5. **prior-art-lessons claims Alacritty uses "two draw calls per frame (one for background cells, one for glyph quads)" (line 12).** Alacritty's current renderer actually uses more draw calls than this -- it separates underline, strikethrough, cursor, and various glyph layers. This is a minor inaccuracy but worth noting because the analysis uses it to claim structural identity with glyph3d-js's single-draw-call approach.

6. **prior-art-lessons states the picking fragment shader encodes "24-bit picking ID" (line 122 context) but does not flag the precision loss.** The picking ID is passed as a `float` varying (`vPickingId`). A 32-bit float has 23 bits of mantissa, so IDs above 8,388,608 (2^23) lose precision. The fragment shader's `floor(id / 65536.0)` decomposition fails silently past this threshold. At 10K glyphs per mesh this is fine (838 meshes before overflow), but the prior-art analysis should have noted this as a scalability ceiling, since it recommends scaling up.

## Gaps

- **My analysis covered per-API adaptation notes (Vulkan `gl_InstanceIndex` vs `gl_InstanceID` offset semantics, Metal top-left texture origin)** that no other analysis mentions. These are load-bearing for a native port.
- **device-tier-scaling's memory reclamation gap** (GridVirtualizer culls draw calls but not VRAM) is a critical finding that my analysis and universal-text-pipeline both missed. This matters for the portability story because memory-constrained native targets (mobile Metal/Vulkan) will hit this wall faster than browser WebGL.
- **data-source-abstraction covers incremental updates (append, patch)** that have direct implications for the GPU backend: `addUpdateRange` partial uploads are essential for patch-mode updates. My analysis documented `addUpdateRange` as a buffer upload pattern but didn't connect it to incremental source updates. The two analyses are complementary.
- **prior-art-lessons covers the Blade-to-wgpu migration** which directly validates my recommendation to avoid building a custom GPU abstraction. Neither universal-text-pipeline nor device-tier-scaling addresses this choice.
- **No analysis addresses WebGPU's binding model change.** WebGPU uses bind groups, not individual texture unit bindings. The 4-texture binding layout I documented in my analysis (atlas, atlasMap, group, highlight) would become a single `GPUBindGroup` in WebGPU. This changes the abstraction layer's `drawInstanced` signature.

## Tensions

1. **universal-text-pipeline proposes `charWidth` in `LayoutMetrics` (line 236)** while the CLAUDE.md and my analysis both emphasize "no hardcoded character dimensions -- all metrics from GlyphAtlas." The `charWidth` in `metrics` is computed from the atlas, not a constant, so this isn't technically wrong, but naming it as a fixed field in a "universal" interface risks encouraging hardcoded values in ports. The Rust/Swift port should derive `charWidth` from `glyph_widths['M']` or atlas metrics, not accept it as a parameter.

2. **prior-art-lessons recommends "Keep Three.js for browser" (line 162) while my analysis documents Three.js's load-bearing contributions (scene graph, InstancedBufferGeometry wrappers, DataTexture, camera/renderer).** These are not contradictory, but the prior-art analysis underestimates Three.js's value by saying "Do not build a custom abstraction layer" and "wgpu for native" without acknowledging that Three.js IS the browser's equivalent of wgpu. Dropping Three.js for raw WebGL2 or wgpu-in-WASM would lose ~175 lines of Three.js convenience (my LOC table) and gain nothing on the browser path.

3. **device-tier-scaling proposes a 4-tier degradation ladder down to plain HTML (lines 246-277).** My analysis concludes that ES 3.0 is the hard floor and devices below it should use an "entirely separate text output system." These positions are compatible but the device-tier analysis should be clearer that Levels 1-2 (Canvas 2D, HTML) are not degraded versions of the instanced pipeline -- they are completely different renderers sharing nothing with the GPU path except the text content.

## Recommendations

1. **Fix the "11 floats" error in universal-text-pipeline.** Change to "10 floats = 40 bytes" in the `GlyphBufferSet` definition. This propagates to any implementation that allocates buffer memory.

2. **Unify the GPU contract interfaces.** My `GlyphGPU` (13 functions) and universal-text-pipeline's `GlyphGPUBackend` (4 methods) and data-source-abstraction's `TextSource` are three views of the same system. Merge into a single layered spec: `TextSource` -> `buildGlyphBuffers()` -> `GlyphGPUBackend`. The backend needs more than 4 methods (it needs render target + readback for picking), and my 13-function interface should drop `setUniform` in favor of a bind-group model compatible with WebGPU.

3. **Add `readPixel` precision ceiling to the collective analysis.** The 2^23 float precision limit on picking IDs is a real scalability wall that none of us flagged adequately. Document it and propose the fix: use `flat` integer varying (`flat out int vPickingId`) which GLSL ES 3.00 supports, giving a full 32-bit ID range.

4. **Adopt device-tier-scaling's VRAM reclamation finding.** Add `unloadContent()` to the GPU contract so backends can free buffers for frustum-culled grids. This is essential for native ports targeting mobile GPUs with 256MB-1GB budgets.

5. **Add WebGPU bind group model to the GPU contract.** Replace individual texture bindings with a grouped binding layout: `createBindGroup(pipeline, {atlas, atlasMap, group, highlight, uniforms})`. This maps 1:1 to WebGPU and can be emulated on WebGL2 with individual `gl.activeTexture` calls.

6. **Incorporate prior-art's pre-baked atlas recommendation into the portability strategy.** A pre-baked atlas (PNG + JSON descriptor) eliminates the font rasterization dependency entirely for the common case (ASCII + Latin-1 + box drawing). This should be the default path for native ports, with runtime rasterization as a fallback for unknown graphemes.

7. **Add `gl_InstanceIndex` offset handling to the GPU contract.** Vulkan's `gl_InstanceIndex` includes `firstInstance` from the draw call, while WebGL2's `gl_InstanceID` always starts at 0. The picking system's `uBasePickingId` must account for this on Vulkan/wgpu backends. Add a note or a `firstInstance` parameter to `drawInstanced`.

8. **Merge data-source-abstraction's backpressure model with device-tier-scaling's frame budget.** Both propose frame-rate-aware throttling from different angles (source update rate vs GPU budget). A unified scheduler should: (a) cap source update processing per frame, (b) prioritize visible grids, (c) respect the device tier's instance budget. These are the same system.

9. **Document space-skipping in the buffer contract.** Spaces (codepoint 32) advance the cursor but do not emit a buffer slot (`src/workers/builders/index.js` line 374-379). This means `glyphCount` in the buffer is strictly less than character count. Any port must replicate this, and any memory estimate must use renderable glyph count, not character count.

10. **Drop the "2D Canvas fallback" from the degradation ladder.** Device-tier-scaling's Level 2 (Canvas 2D with pan/zoom) is an entirely different application, not a graceful degradation. It shares no code with the GPU path. If built, it should be a separate entry point, not a runtime fallback.

## Key Insight

The five analyses converge on a finding that none of us stated explicitly: the rendering pipeline's portability is already solved in principle (every GPU API from 2012 onward supports the required features), but the practical bottleneck is not the GPU contract -- it is the three-way coupling between atlas generation (Canvas 2D), buffer building (JavaScript typed arrays), and the data source layer (browser fetch/WebSocket). A native port does not need a new GPU abstraction; it needs a native atlas generator (cosmic-text/FreeType), a native buffer builder (the ~170-line `buildBatchBuffers` translated to Rust), and a native content pipeline (filesystem reads instead of HTTP fetches). The GPU backend itself is the easiest part, comprising roughly 500-700 lines on any modern API. The collective analysis over-indexed on the GPU contract and under-indexed on the font and content pipelines, which is where 80% of the porting effort actually lives.
