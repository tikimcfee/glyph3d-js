# Universal GPU Text Rendering — Cross-Reference Synthesis

## Process

- **5 agents**: rendering-backend-portability, universal-text-pipeline, device-tier-scaling, data-source-abstraction, prior-art-lessons
- **Phase 0**: Independent analysis grounded in source code reads
- **Phase 0.5**: Blind predictions (calibration)
- **Phase 1**: Forward cross-review (6+ factual errors caught, all tensions resolved)
- **Phase 2**: Skipped (convergence achieved in Round 1)
- **Phase 3**: Final convergence + implementer vote
- **Implementer vote**: rendering-backend-portability (3 of 5 votes)

---

## The Core Finding

**The architecture is already correct. The pattern is already universal.**

Every prior art project that ships GPU text rendering (Alacritty, Zed, egui, Dear ImGui, Bevy) converged on the same approach glyph3d-js already uses: rasterize glyphs to a texture atlas, render as instanced textured quads, single draw call. The GPU contract is tiny — 5 instanced attributes, 4 texture bindings, GLSL ES 3.00 — and maps cleanly to WebGL2, WebGPU, Metal, Vulkan, DirectX 11/12, and even software rasterizers.

The gap is not architectural redesign. It is **operational hardening** and **formalizing the seams that already exist**.

---

## 18 Settled Points (unanimous across all 5 agents)

1. **Buffer contract: 10 floats = 40 bytes per glyph** (+ 4 bytes highlight texture = 44 effective)
2. **`GlyphBufferSet` is THE portability seam** — the typed-array handoff between `buildBatchBuffers()` and `applyPrebuiltBuffers()` crosses language, runtime, and backend boundaries
3. **No custom GPU abstraction layer** — Three.js for browser, wgpu for native (Zed's Blade→wgpu migration is the cautionary tale)
4. **ES 3.0 / WebGL 2 is the hard floor** — `gl_InstanceID` is the linchpin; without it, picking, highlighting, and UV lookup all break
5. **GridVirtualizer must reclaim VRAM, not just draw calls** — the single most impactful gap discovered
6. **Distance-based LOD is the highest-leverage optimization** — near/mid/far bands using already-computed `entry.distance`, 80-90% glyph count reduction
7. **Bitmap atlas now, MSDF later** — every shipping project chose bitmap; pre-baked atlas makes MSDF a future build-time swap
8. **Pre-baked atlas (PNG + JSON) is the portability bridge** — eliminates runtime Canvas 2D dependency for the common charset
9. **Async-first picking readback** — `readPixel → Promise<Uint8Array>` for WebGPU readiness
10. **WebGL context loss is an unhandled production crash path** — must handle `webglcontextlost`/`webglcontextrestored`
11. **`TextSource` is the input portability seam** — complementary to `GlyphBufferSet`, not competing
12. **Minimal data-source abstraction** — `TextSource` + `SourceBoundGrid` only; no scheduler/throttle layers yet (xi-editor warning)
13. **Picking ID precision ceiling at 2^23** — float varying loses precision; fix with `flat out int` when needed
14. **Space-skipping is portability-critical** — spaces don't emit buffer slots; any port must replicate this
15. **Worker uvMap should be cached** — structured clone on every dispatch wastes time and memory
16. **RGBA32F textures: NearestFilter only** — `OES_texture_float_linear` not guaranteed; document the constraint
17. **Vulkan `gl_InstanceIndex` offset semantics** differ from WebGL2 `gl_InstanceID` — one-line fix per backend, must document
18. **The pipeline is `TextSource → buildBatchBuffers() → GlyphBufferSet → GPU backend`** — two seams, four stages, already implemented

---

## Implementation Plan (6 phases, converged across all agents)

### Phase 1: Formalize the Buffer Contract
- **Create** `src/core/types.js` — JSDoc typedefs for `GlyphBufferSet`, `AtlasDescriptor`, `GlyphGPUSpec` (requirements doc)
- **Modify** `src/workers/builders/index.js` — add `@returns {GlyphBufferSet}` JSDoc
- **Modify** `src/GlyphRenderer.js` — add `@param {GlyphBufferSet}` to `applyPrebuiltBuffers()`

### Phase 2: Async Picking Readback
- **Modify** `src/picking/PickingSystem.js` — wrap `readRenderTargetPixels` in Promise
- **Modify** app/ pick callers — change to `await`

### Phase 3: GridVirtualizer Memory Reclamation
- **Modify** `src/collections/CodeGrid.js` — add `unloadContent()` / `reloadContent()`
- **Modify** `src/collections/GridVirtualizer.js` — add eviction distance threshold, buffer disposal for far-off grids

### Phase 4: WebGL Context Loss
- **Modify** `src/GlyphRenderer.js` — `webglcontextlost`/`webglcontextrestored` handlers, `_rebuildGPUState()`
- **Modify** `src/picking/PickingSystem.js` — re-create render target on context restore

### Phase 5: Pre-baked Atlas
- **Create** `src/GlyphAtlasLoader.js` — load PNG + JSON atlas without runtime Canvas 2D
- **Modify** `src/GlyphAtlas.js` — add `exportAtlas()` and `static fromPrebuilt()`
- **Create** `tools/bake-atlas.mjs` — build-time atlas generation at multiple sizes (512/1024/2048)

### Phase 6: LOD + Device Tier (future)
- **Create** `src/core/DeviceTier.js` — runtime GPU capability detection
- **Modify** `src/collections/GridVirtualizer.js` — LOD bands (near: full glyphs, mid: solid quads, far: rectangles)

### Files Summary

| Action | File | Phase |
|--------|------|-------|
| Create | `src/core/types.js` | 1 |
| Modify | `src/workers/builders/index.js` | 1 |
| Modify | `src/GlyphRenderer.js` | 1, 4 |
| Modify | `src/picking/PickingSystem.js` | 2, 4 |
| Modify | `src/collections/CodeGrid.js` | 3 |
| Modify | `src/collections/GridVirtualizer.js` | 3, 6 |
| Create | `src/GlyphAtlasLoader.js` | 5 |
| Modify | `src/GlyphAtlas.js` | 5 |
| Create | `tools/bake-atlas.mjs` | 5 |
| Create | `src/core/DeviceTier.js` | 6 |

No files deleted. No new abstraction layers. Every change formalizes an existing contract, adds operational robustness, or opens a portability seam.

---

## What This Means for "Run Anywhere"

The analysis confirms that glyph3d-js's rendering pattern is genuinely universal. The path to running on any device is:

1. **Browser (today)**: Already works. Phases 1-5 harden it for production mobile use.
2. **Native (Rust/wgpu)**: Translate `buildBatchBuffers()` (~170 lines of pure typed-array math), ship pre-baked atlas, write a thin wgpu renderer consuming `GlyphBufferSet`. The buffer contract is the porting target.
3. **Native (Swift/Metal)**: Already proven in the sister project. Formalized buffer contract makes the interface explicit.
4. **Low-end devices**: Pre-baked atlas at 512px + LOD + VRAM reclamation = viable on 2GB phones.
5. **Software rasterizer**: Works for correctness testing, not interactive framerates at scale.

The hard floor is OpenGL ES 3.0 (2012 hardware). Below that, a fundamentally different renderer (Canvas 2D / HTML) is needed — the instanced pattern cannot degrade gracefully without `gl_InstanceID`.

---

## Key Risks and Deferred Items

- **MSDF atlas**: Deferred. Correct for 3D zoom quality, but bitmap + pre-baked is sufficient now.
- **Streaming/incremental updates**: `TextSource` supports it conceptually; `buildBatchBuffers()` needs an append path for Tier 2 (append-only) and Tier 3 (patch-based) updates. Deferred until concrete streaming use case.
- **Picking ID overflow**: Not urgent at current scale (838 meshes × 10K glyphs). `flat out int` fix documented for when needed.
- **Over-modularization**: The xi-editor lesson is load-bearing. Build only what concrete use cases demand.
