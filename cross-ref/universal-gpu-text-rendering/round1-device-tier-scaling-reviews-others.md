# Round 1: device-tier-scaling reviews rendering-backend-portability, universal-text-pipeline, data-source-abstraction, prior-art-lessons

## Errors Found

1. **universal-text-pipeline Section 1 header: "11 floats = 44 bytes"** — The header says "Per glyph (11 floats = 44 bytes)" but then lists positions (3) + sizes (2) + codepoints (1) + colors (3) + groupIds (1) = **10 floats = 40 bytes**. Confirmed by `src/workers/builders/index.js` lines 81-85 allocating `glyphCount * 3`, `glyphCount * 2`, `glyphCount`, `glyphCount * 3`, `glyphCount`. The 44-byte figure only holds if you count the 4-byte RGBA8 highlight texel as part of the per-glyph cost (40 + 4 = 44), but that is not an 11th float — it is a separate texture, not part of the buffer contract.

2. **rendering-backend-portability Section B: "RGBA32F sampling — Core" for WebGL2** — Strictly incorrect. WebGL2 (OpenGL ES 3.0) guarantees RGBA32F *texture creation* but does NOT guarantee RGBA32F *filtering*. `OES_texture_float_linear` is required for linear-filtered float textures. The atlas map and group textures use `NearestFilter` (confirmed `GlyphAtlas.js` line 499, `GlyphRenderer.js` group texture creation), so in practice this works — nearest sampling of float textures IS core in ES 3.0. But the blanket "Core" in the feature grid is misleading. If any future code path enables linear filtering on a float texture, it would silently break on devices without the extension.

3. **rendering-backend-portability Section A.2: "at least 4 texture units bound simultaneously with 3 usable in vertex shader"** — The main rendering path binds 4 textures total (atlas, atlasMap, group, highlight), with 3 sampled in the vertex shader. The picking `glyph` mode (`PickingSystem.js` line 73-106) adds atlas + atlasMap + group = 3 vertex textures. This is correct for the main path but the picking glyph mode also reads atlas in the fragment shader (line 116), so the glyph-mode picking pipeline binds 4 textures with atlas shared across both stages. The analysis should note that atlas is bound twice (vertex for UV lookup, fragment for alpha test in glyph mode). In practice this is fine (same texture unit), but the count is still 4 max simultaneous.

4. **universal-text-pipeline Section 2, Stage 2 claim: "No platform deps"** — The layout pass in `buildBatchBuffers` calls `iterGraphemes()` from `src/utils/grapheme.js`, which depends on `Intl.Segmenter`. This is acknowledged separately under Stage 1 but the Stage 2 description says "Pure arithmetic over grapheme stream" with "None" for platform deps, which is only true if you consider the grapheme iterator an input rather than a dependency. This is a framing issue, not a hard error, but the boundary is incorrectly placed — the `iterGraphemes` call is inline in the layout loop (`src/workers/builders/index.js` line 343), not a separate stage.

5. **prior-art-lessons Section 1.1: "Alacritty... Two draw calls per frame (one for background cells, one for glyph quads)"** — This may be outdated. Alacritty's renderer has evolved significantly and the draw call count depends on the renderer version (vte vs the newer GPU-based approach). The document cites PR #4373 but that was a WIP exploration, not a merged change. This is a minor factual risk — the core analogy (instanced quads from atlas) holds regardless.

## Gaps

### What my analysis covered that others missed

- **WebGL context loss** (`webglcontextlost` event): None of the four agents address what happens when the browser reclaims GPU resources on mobile. This is a real production failure mode — backgrounding a tab on iOS/Android destroys all WebGL state. The rendering-backend-portability and data-source-abstraction analyses both propose new architectures that would need context loss recovery, but neither accounts for it.
- **iOS Safari 16MB texture upload limit**: My analysis identified the 2048x2048 RGBA atlas as exactly 16MB, which can cause silent failures on iOS when mipmaps push total upload past the limit. No other agent flags this device-specific constraint.
- **JavaScript heap exhaustion from worker structured clone**: The worker-to-main transfer of large Float32Arrays doubles memory momentarily during structured clone (before transferable takes effect). universal-text-pipeline describes the worker contract but does not address the memory spike during transfer.
- **Concrete FPS expectations per tier**: I provided specific FPS ranges per device class. The other analyses discuss capabilities in binary terms (supports/doesn't support) without quantifying performance.

### What others covered that I missed

- **MSDF atlas as a long-term quality solution** (universal-text-pipeline Section 3): I discussed atlas LOD (scaling down to 1024/512) but not the fundamentally different approach of signed distance fields, which would make zoom-level quality a non-issue.
- **Pre-baked atlas strategy** (universal-text-pipeline Section 3): Shipping atlas as PNG + JSON descriptor eliminates runtime font rasterization entirely. My analysis assumed runtime atlas generation on all tiers.
- **Incremental update protocol** (data-source-abstraction Section 4): The three-tier update model (full replacement / append / patch) addresses a performance dimension I did not consider — the cost of re-rendering on content change, not just initial load.
- **cosmic-text as the native font rasterizer** (prior-art-lessons Section 1.8): My analysis did not address the native port font pipeline at all, focusing purely on browser-side device tiers.
- **The wgpu ecosystem convergence** (prior-art-lessons Section 1.4, rendering-backend-portability Section C): Both agents independently identified wgpu as the correct native GPU abstraction. My analysis stayed within the WebGL/Three.js world.
- **The `GlyphGPU` 13-function contract** (rendering-backend-portability Section C): A concrete, minimal API surface for GPU portability. My analysis proposed device-tier-aware parameter tuning but not a portable GPU interface.

## Tensions

### 1. Memory reclamation: culling-as-optimization vs culling-as-requirement

My analysis (Section A) states: "GridVirtualizer eliminates draw calls, not memory. All registered grids keep their GPU buffers allocated." The data-source-abstraction agent (Section 5) proposes deferred updates for frustum-culled grids but assumes those grids still hold their buffers. The rendering-backend-portability agent does not discuss memory reclamation at all.

This tension matters because on Tier 1-2 devices, the 64-256MB GPU budget means you CANNOT keep all grid buffers allocated — memory reclamation is mandatory, not optional. GridVirtualizer (`src/collections/GridVirtualizer.js` line 17) mentions "pair with unloadContent()" in its header comment, but this method does not exist on CodeGrid. The data-source-abstraction agent's `SourceBoundGrid.onBecameVisible()` pattern is close to the right answer but doesn't address the GPU buffer side.

**Correct position**: For Tier 1-2, the virtualizer must be extended to dispose/recreate GPU buffers, not just scene graph membership. The data-source-abstraction's staleness-flag approach should be combined with buffer eviction.

### 2. Sync vs async picking readback

rendering-backend-portability (Section C) proposes `readPixel -> Promise<Uint8Array>` as the universal API, noting WebGPU requires async. My analysis (Section C.5) notes that on mobile, sync `readPixels` costs 5-15ms and proposes throttling to every 3rd frame. These are complementary, not contradictory, but there is a design tension: an async API adds one frame of latency everywhere, while the current sync API has zero latency on desktop and high latency on mobile.

**Correct position**: rendering-backend-portability is right — async-first is correct. The one-frame latency is imperceptible for hover interactions. The mobile throttling I proposed is orthogonal (reduces frequency, not latency).

### 3. Atlas portability: Canvas 2D vs pre-baked vs cosmic-text

universal-text-pipeline (Section 3) proposes three paths: keep Canvas 2D for browser, add pre-baked atlas loader, evaluate MSDF. prior-art-lessons (Section 4/6.3) proposes extracting a `FontRasterizer` trait with Canvas 2D as one implementation and cosmic-text for native. My analysis proposes atlas LOD (smaller atlas for lower tiers).

These are not contradictory but they imply different implementation orders. The pre-baked atlas (universal-text-pipeline) is the simplest path to portability AND the simplest path to tier-scaled atlas sizes (just ship multiple pre-baked atlases at different resolutions). The `FontRasterizer` trait (prior-art-lessons) is more flexible but adds code. MSDF (universal-text-pipeline) solves zoom quality but requires a different fragment shader.

**Correct position**: Pre-baked atlas first (simplest, enables both portability and tier-scaling), `FontRasterizer` trait second (for dynamic glyph addition via `ensureGraphemes`), MSDF third (quality improvement, separate concern).

### 4. Over-modularization risk

prior-art-lessons (Section 3.1, 6.5) explicitly warns against over-modularization, citing xi-editor's failure. data-source-abstraction proposes `TextSource`, `SourceBoundGrid`, `ThrottledSourceBridge`, `SourceUpdateScheduler` — four new abstractions layered between data sources and CodeGrid. These are not excessive individually, but stacking all four creates the kind of abstraction depth that xi-editor suffered from.

**Correct position**: prior-art-lessons is right to raise the flag, but data-source-abstraction's abstractions are data boundaries (typed arrays, event streams), not process boundaries. The risk is lower than xi-editor's. However, `ThrottledSourceBridge` and `SourceUpdateScheduler` could be merged into `SourceBoundGrid` to reduce the layer count.

## Recommendations

1. **Fix the universal-text-pipeline "11 floats" error.** The buffer contract is 10 floats = 40 bytes. Document the 4-byte highlight texel separately. This matters because it propagates into memory calculations.

2. **Add `OES_texture_float_linear` to the capability check matrix** in rendering-backend-portability. The current code only uses nearest filtering on float textures, but the feature grid should note this constraint explicitly so future changes don't accidentally break Tier 2 devices.

3. **Implement buffer eviction in GridVirtualizer**, not just scene graph removal. For Tier 1-2 devices, call `grid.dispose()` on far-off grids and re-load from source (using data-source-abstraction's `SourceBoundGrid`) when they re-enter the frustum. The virtualizer already tracks `entry.distance` (line 192) — add a second distance threshold for eviction.

4. **Ship pre-baked atlases at multiple resolutions** (512, 1024, 2048). This satisfies both my tier-scaling analysis (smaller atlas for lower devices) and universal-text-pipeline's portability goal (no runtime font rasterization needed). A build-time step generates all three from the same font using `msdf-atlas-gen` or Canvas 2D.

5. **Merge `ThrottledSourceBridge` into `SourceBoundGrid`** to reduce abstraction depth per prior-art-lessons' warning. The throttling logic is ~15 lines and is always needed for stream sources.

6. **Add `webglcontextlost` / `webglcontextrestored` handlers** to GlyphRenderer. On context loss, mark all buffers as needing re-upload. On context restore, re-initialize the shader pipeline and trigger a full buffer re-upload. This is critical for mobile production use.

7. **Make the `GlyphGPU` interface (rendering-backend-portability Section C) tier-aware.** Add a `capabilities` query method that returns device tier information (max texture size, vertex texture units, estimated VRAM). The tier detection logic from my analysis would live here, informing atlas size, instance budget, and LOD thresholds.

8. **Prototype the LOD system using GridVirtualizer's existing `entry.distance`** field. The data is already computed every update cycle. Adding a `setLOD()` call to CodeGrid gated on distance thresholds (near/mid/far) is the highest-impact single optimization for Tier 2 devices.

9. **Document the async `readPixel` decision** from rendering-backend-portability as the canonical API. Update `PickingSystem.js` to return a Promise even on the WebGL2 path (trivially: `Promise.resolve(pixel)`). This prevents the sync-assumption from spreading into consumer code before WebGPU arrives.

10. **Add Transferable array transfer to the worker path** where it is not already used. universal-text-pipeline mentions zero-copy Transferable but the actual `WorkerBridge` implementation should be audited to confirm all Float32Array responses use `postMessage(result, [result.positions.buffer, ...])` syntax. If any path uses structured clone without transfer, the memory spike I identified becomes a problem on Tier 1-2 devices.

## Key Insight

The four analyses converge on a single architectural truth that was not obvious from any one perspective alone: the buffer contract (`GlyphBufferSet`: 10 floats per glyph in 5 typed arrays) is simultaneously the portability seam (rendering-backend-portability, universal-text-pipeline), the data-flow boundary (data-source-abstraction), the unit of LOD and tier scaling (my analysis), and the pattern validated by every successful prior art project (prior-art-lessons). This means the highest-leverage engineering investment is not in any new abstraction layer but in making the buffer contract itself richer — adding LOD metadata (distance hint, desired resolution), lifecycle state (loaded/evicted/stale), and tier-budget awareness (max instance count per grid) directly into the `GlyphBufferSet` and its surrounding `CodeGrid` lifecycle. Every proposed improvement — portability, streaming updates, device scaling, memory reclamation — ultimately flows through this same 40-byte-per-glyph data boundary, and any architectural decision that respects this boundary will compose cleanly while any that crosses it will create the kind of coupling that killed xi-editor.
