# Round 1: universal-text-pipeline reviews rendering-backend-portability, device-tier-scaling, data-source-abstraction, prior-art-lessons

## Errors Found

1. **rendering-backend-portability claims 5 vertex texture fetches per instance (Section B, software rasterizer note).** The actual count is 4: three `texture()` calls for group data (gPos, gColor, gScale at `GlyphRenderer.js` lines 329-331), one `texture()` for atlas map UV lookup (line 357). The highlight uses `texelFetch()` (line 369), which is integer-addressed and a different operation. Calling it "5 vertex texture fetches" conflates `texture()` and `texelFetch()`. Matters for software rasterizer perf estimates -- `texelFetch` is cheaper than filtered `texture()`.

2. **rendering-backend-portability states atlas map lookup uses `texelFetch` in Section A.2 header comment** ("codepoint-to-UV") but in Section A.3 correctly says `texture(atlasMapTexture, vec2(tx,ty))`. The atlas map is sampled with normalized `texture()` coordinates, NOT `texelFetch`. Only the highlight texture uses `texelFetch` (integer coords). The Section A.2 table says "Access pattern: `texture(atlasMapTexture, vec2(tx,ty))`" which is correct, but then claims `texelFetch` with integer coordinates is a hard requirement citing the atlas map. The hard requirement for `texelFetch` comes solely from the highlight texture. This matters because backends without `texelFetch` could still do atlas map lookups -- they'd only lose per-glyph highlighting.

3. **My own Phase 0 states "11 floats = 44 bytes" per glyph in Section 1.** This is wrong. The actual count is 10 floats = 40 bytes, as correctly stated in every other analysis and confirmed at `GlyphRenderer.js` lines 300-304 (3+2+1+3+1 = 10). I double-counted somewhere. The 44-byte figure in device-tier-scaling is also wrong for the same reason -- it adds 4 bytes for highlight texture, making the total 44 bytes/glyph effective, which is a different (and valid) accounting, but the "11 floats" claim in my document is a factual error.

4. **device-tier-scaling Section A claims "Each CodeGrid gets its own GlyphRenderer."** This needs qualification. `CodeGrid` creates a `GlyphCollection`, which in turn creates a `GlyphRenderer`. But the atlas texture is shared via `getSharedThreeTexture()` in `GlyphAtlas.js`. The per-renderer overhead is the group texture, highlight texture, and instance buffers -- not a second atlas. The statement is directionally correct but could mislead about memory accounting. The 22 MB fixed overhead is per-atlas, not per-renderer.

5. **rendering-backend-portability Section A.4 says `_createTarget()` is at line 172.** Confirmed correct (`PickingSystem.js` line 172). However, it says `readRenderTargetPixels()` is at line 345. The actual call is at lines 345-346 in `PickingSystem.js`, reading into `this._readBuffer`, then decoding at line 349 with bitshifts `(r << 16) | (g << 8) | b` -- NOT the float arithmetic `floor(id / 65536.0)` described in the picking ID encoding. The encoding uses float math in the fragment shader (line 65-68), the decoding uses integer bitshifts in JS (line 349). This asymmetry is worth noting: the shader-side float decomposition introduces precision risk above 2^24 IDs, but the JS decode is lossless for the 24-bit range.

6. **data-source-abstraction Section 1 call chain says `collection.flushAsync()` calls `WorkerBridge.buildBuffers()`.** The actual method chain is: `GlyphCollection.flushAsync()` -> `WorkerBridge.buildBatchBuffers()` (not `buildBuffers`). The function name matters for grep-ability.

## Gaps

- **My analysis** covered the buffer contract, pipeline stages, font portability, and worker abstraction. I missed:
  - WebGL context loss handling (device-tier-scaling Section F.3 caught this)
  - iOS Safari 16MB texture upload limit (device-tier-scaling Section F.4)
  - The distinction that GridVirtualizer saves draw calls but NOT memory (device-tier-scaling Section A, critical insight)

- **rendering-backend-portability** thoroughly mapped API feature matrices but missed:
  - Incremental/streaming content updates (data-source-abstraction's append/patch model)
  - The font rasterization portability story beyond listing alternatives (prior-art-lessons had the concrete project comparisons)
  - LOD strategies (device-tier-scaling covered this comprehensively)

- **device-tier-scaling** covered the full hardware spectrum but missed:
  - The V-flip in atlas map texture (`GlyphAtlas.js` lines 487-489) as a portability concern
  - Shader cross-compilation options (GLSL -> WGSL/MSL/HLSL via Naga)
  - The async readback requirement for WebGPU picking

- **data-source-abstraction** covered data flow comprehensively but missed:
  - The actual GPU resource lifecycle (no mention of `dispose()` patterns for Three.js objects)
  - How `SourceBoundGrid.dispose()` should propagate to `GlyphRenderer.dispose()` / geometry disposal
  - The gap-buffer mention for Tier 3 patches is good but underestimates the complexity: `_lineSlotBase` (Int32Array mapping line->buffer slot) must be rebuilt on any insertion, not just the buffer itself

- **prior-art-lessons** had the broadest perspective but missed:
  - The specific `texelFetch` vs `texture()` distinction in glyph3d-js's vertex shader (this is what makes the codepoint-to-UV pattern unique vs Alacritty's CPU-baked UVs)
  - Quantified memory budgets per device tier (device-tier-scaling filled this gap)

## Tensions

1. **MSDF vs bitmap atlas.** My analysis (Section 3) recommends MSDF as "the right long-term move." prior-art-lessons (Section 2.1, 1.5) explicitly argues bitmap won across all prior art because "pixel-perfect quality at target size matters more than scale-independence." Both cite the zoom-quality tradeoff. **prior-art-lessons is more correct for the current use case**: glyph3d-js renders monospace code at roughly fixed projected sizes (the camera moves, text doesn't scale continuously). Bevy's subpixel binning is the better path than MSDF for code text. MSDF makes sense for smooth-zooming UI labels, not code grids.

2. **Custom GPU abstraction vs use existing.** rendering-backend-portability proposes a 13-function `GlyphGPU` interface (Section C). prior-art-lessons (Section 6.4) explicitly says "Don't Build a Custom GPU Abstraction" citing Zed's Blade-to-wgpu migration. **prior-art-lessons is correct**: the 13-function interface looks small but maintaining it across 5+ backends is exactly the trap Zed fell into. For browser, keep Three.js. For native, adopt wgpu directly. The `GlyphBufferSet` is the portability seam, not a GPU API wrapper.

3. **GridVirtualizer as memory optimization.** My analysis (Section 4) and prior-art-lessons (Section 2.4) both treat frustum culling as a key scaling mechanism. device-tier-scaling (Section A) correctly identifies that **GridVirtualizer does not reclaim memory** -- all buffers stay in VRAM. For Tier 2 devices, this means 1500 grids still exhaust VRAM even though only 50 are drawn. **device-tier-scaling is correct** and the other analyses (including mine) should have been more precise about this distinction.

4. **Worker transfer: zero-copy vs clone.** My analysis (Section 4) says workers use "Transferable arrays (zero-copy)." device-tier-scaling (Section F.6) says "structured clone (not transferable in all browsers)." Checking `WorkerBridge.js` would settle this -- if `postMessage(result, [buffer])` is used with a transfer list, it's zero-copy. If not, device-tier-scaling's memory-doubling concern is valid. The codebase likely uses transferables on the return path (worker -> main) since `applyPrebuiltBuffers` takes ownership, but the outbound path (main -> worker) sends `uvMap` which is a plain object and must be cloned.

## Recommendations

1. **Fix my "11 floats" error.** The buffer contract is 10 floats = 40 bytes/glyph. The 44-byte "effective" figure (adding highlight RGBA8) is valid but should be labeled differently. Update `phase0-universal-text-pipeline.md` Section 1.

2. **Formalize the `GlyphBufferSet` type as a shared typedef.** All five analyses agree this is the portability seam. Create it in `src/core/types.js` as JSDoc. Don't build a GPU abstraction layer on top of it -- the buffer set IS the contract.

3. **Add memory reclamation to GridVirtualizer.** device-tier-scaling identified this as the single highest-impact change. When a grid leaves the frustum for N seconds, call `grid.unloadContent()` to free GPU buffers. Re-build on re-entry. This pairs with data-source-abstraction's deferred-update pattern.

4. **Do not pursue MSDF for code text.** prior-art-lessons' evidence from Bevy, egui, and Alacritty is convincing. If zoom-quality becomes an issue, use multi-size atlas LOD (device-tier-scaling Section D.4) rather than MSDF.

5. **Do not build a custom GPU abstraction layer.** Use Three.js for browser, wgpu directly for native. The `GlyphBufferSet` typed arrays cross the boundary. rendering-backend-portability's 13-function interface is useful as documentation of requirements, not as a runtime abstraction.

6. **Add WebGL context loss handling.** device-tier-scaling Section F.3 identified this as an unhandled crash path on mobile. Listen for `webglcontextlost`/`webglcontextrestored` on the canvas and reinitialize textures+buffers on restore.

7. **Make data-source-abstraction's `TextSource.onChange` support backpressure.** The `ThrottledSourceBridge` pattern (Section 6) is good but should be built into `SourceBoundGrid` rather than requiring a separate wrapper. The coalescing interval should be configurable per source type.

8. **Verify worker transferable usage.** If the outbound `uvMap` is being structured-cloned on every job dispatch, cache it in the worker after first receipt. The `uvMap` changes only when `ensureGraphemes()` adds new codepoints -- no need to resend for every buffer build.

9. **Add distance-based LOD in GridVirtualizer.** device-tier-scaling's three-tier LOD proposal (near/mid/far) is the single highest-impact rendering optimization. GridVirtualizer already computes per-grid distance. Adding `setLOD()` that swaps to solid-color quads at mid-range and single rectangles at far-range would cut active glyph count by 80-90%.

10. **Extract `buildBatchBuffers` into a standalone module with explicit type contract.** It currently lives in `src/workers/builders/index.js` with one import (`iterGraphemes`). Make the dependency explicit and document the input/output types as the canonical portable interface.

## Key Insight

The five analyses converge on a single structural observation: glyph3d-js already has the right architecture -- the rendering pipeline is 70% portable by code volume, and every successful prior art project independently arrived at the same atlas-plus-instanced-quads pattern. The gap is not architectural redesign but operational hardening. The three concrete missing pieces are (1) memory reclamation for off-screen grids (GridVirtualizer culls draw calls but leaves buffers allocated, silently exhausting VRAM on constrained devices), (2) distance-based LOD to cut active glyph counts by an order of magnitude, and (3) formalizing the `GlyphBufferSet` typed-array contract as the explicit portability seam rather than building a GPU abstraction layer on top of it. The prior art evidence from Zed's failed Blade abstraction and xi-editor's over-modularization strongly argues against adding new abstraction layers -- the typed array handoff between `buildBatchBuffers` and `applyPrebuiltBuffers` is already the right boundary, and the correct next step is to document and freeze that contract, not wrap it.
