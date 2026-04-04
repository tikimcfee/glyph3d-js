# Round 3: rendering-backend-portability convergence

## Settled

All points are fully resolved after Round 1. Below is the numbered list of every substantive question with its settled position and rationale.

1. **Per-glyph byte count is 10 floats = 40 bytes instance data + 4 bytes RGBA8 highlight = 44 bytes effective.** All five agents agree after Round 1 corrections. The buffer contract (`GlyphBufferSet`) documents 10 floats across 5 typed arrays. The highlight texture's 4 bytes is a separate resource. universal-text-pipeline's "11 floats" header was a stale count from a pre-GPU-lookup era and is retracted.

2. **ES 3.0 / WebGL 2 is the hard floor.** `gl_InstanceID` in the vertex shader is the linchpin -- without it, both picking ID derivation and highlight texture addressing collapse, requiring per-instance attributes that triple memory. `ANGLE_instanced_arrays` on ES 2.0 provides instanced draw but NOT `gl_InstanceID`. device-tier-scaling correctly noted Mali-400 supports the extension but lacks the shader intrinsic. Devices below ES 3.0 (~3% of web traffic) need an entirely separate renderer (Canvas 2D or HTML), not a degraded GPU path.

3. **No custom GPU abstraction layer at runtime.** All agents converge: Three.js for browser, wgpu for native. My 13-function `GlyphGPU` interface survives as a **requirements specification** documenting what the rendering pattern needs from any backend. It is not a runtime abstraction sitting between the pipeline and Three.js. prior-art-lessons' evidence from Zed's Blade-to-wgpu migration is decisive -- maintaining a custom GPU wrapper across backends is a losing proposition.

4. **`GlyphBufferSet` is the portability seam, not the GPU API.** The typed-array handoff between `buildBatchBuffers()` output and `applyPrebuiltBuffers()` input is already the correct boundary. All five agents independently identified this. The buffer set crosses language boundaries (JS -> Rust/Swift), runtime boundaries (worker -> main thread), and backend boundaries (Three.js -> wgpu). Formalizing this as a documented type contract is the highest-leverage action.

5. **Async-first picking readback (`readPixel -> Promise<Uint8Array>`).** WebGPU requires `mapAsync`. The one-frame latency is imperceptible for hover interactions. device-tier-scaling's mobile throttling (every 3rd frame) is orthogonal and complementary. The current sync `readRenderTargetPixels` wraps trivially in `Promise.resolve()` for WebGL2 without behavior change.

6. **Bitmap atlas now, MSDF later.** prior-art-lessons' evidence is conclusive: every shipping GPU text project chose bitmap over SDF for code/UI text. MSDF is the right long-term answer for glyph3d-js's 3D zoom use case, but the pre-baked atlas strategy (PNG + JSON descriptor) decouples generation from rendering, making MSDF a build-time swap when needed, not an architecture change.

7. **Pre-baked atlas as the default portability path.** Eliminates runtime Canvas 2D font rasterization for the common case (ASCII + Latin-1 + box drawing). Native ports ship the PNG + JSON and skip the platform font dependency entirely for the base charset. Runtime rasterization via `ensureGraphemes()` remains the fallback for unknown graphemes.

8. **GridVirtualizer must reclaim GPU memory, not just draw calls.** device-tier-scaling's most critical finding. The existing code comments ("pair with unloadContent()") acknowledge the need but `unloadContent()` does not exist on CodeGrid. On mobile GPUs with 256MB-1GB budgets, 1500 grids exhaust VRAM even when only 50 are drawn. Buffer eviction by distance threshold is mandatory for Tier 1-2 devices.

9. **LOD by distance is the highest-impact rendering optimization.** GridVirtualizer already computes `entry.distance` every update cycle. Three tiers: near (full glyph rendering), mid (solid-color quads, no atlas sample), far (single rectangle per grid). Cuts active glyph count by 80-90% at typical camera positions.

10. **RGBA32F texture sampling is core in ES 3.0 for nearest filter only.** device-tier-scaling correctly flagged that `OES_texture_float_linear` is required for linear-filtered float textures. The atlas map and group textures use `NearestFilter`, so this works today. The constraint must be documented so future code changes do not accidentally enable linear filtering on float textures.

11. **Picking ID precision ceiling at 2^23 (8,388,608).** The picking ID is passed as a `float` varying. A 32-bit float has 23 mantissa bits. IDs above 2^23 lose precision, causing the RGB decomposition in the fragment shader to fail silently. At 10K glyphs/mesh this allows 838 meshes before overflow -- sufficient for now. The fix when needed: `flat out int vPickingId` (supported in GLSL ES 3.00), giving a full 32-bit integer range.

12. **WebGL context loss is an unhandled production crash path.** No agent's Phase 0 addressed this. device-tier-scaling identified it in Round 1. Backgrounding a tab on iOS/Android destroys all WebGL state. The handler must re-create atlas textures, instance buffers, shaders, and the picking render target from in-memory data.

13. **Vertex attribute count is 8, not 7.** My Phase 0 stated 7 (5 instance + 2 per-vertex). data-source-abstraction correctly identified that `PlaneGeometry` provides `position` (vec3), `uv` (vec2), AND `normal` (vec3) = 3 per-vertex attributes, making 8 total. Irrelevant to any hard wall (ES 3.0 guarantees 16+) but the number was wrong.

14. **Vertex texture fetch count is 5 (3 group + 1 atlas map + 1 highlight texelFetch).** universal-text-pipeline argued `texelFetch` should not count as a "vertex texture fetch." Functionally it is still a texture read in the vertex stage consuming a texture unit. The distinction matters for software rasterizer performance estimates: `texelFetch` (integer-addressed, no filtering) is cheaper than `texture()` (normalized coordinates, potential filtering). The practical count for performance estimation is "4 filtered + 1 unfiltered."

15. **Data source abstraction layers should be minimal.** prior-art-lessons' xi-editor warning applies. `TextSource` as an interface is justified. `ThrottledSourceBridge` and `SourceUpdateScheduler` should be deferred until a concrete streaming use case demands them. `SourceBoundGrid` with built-in throttling is sufficient initially.

16. **WebGPU bind group model replaces individual texture unit bindings.** The 4-texture binding layout (atlas, atlasMap, group, highlight) becomes a single `GPUBindGroup` in WebGPU. The `GlyphGPU` spec should use grouped bindings (`createBindGroup(pipeline, {textures, uniforms})`), emulatable on WebGL2 with individual `gl.activeTexture` calls. No agent disputed this after I raised it.

17. **Vulkan `gl_InstanceIndex` offset semantics.** `gl_InstanceIndex` includes `firstInstance` from the draw call; WebGL2's `gl_InstanceID` always starts at 0. The picking system's `uBasePickingId` must account for this on Vulkan/wgpu backends. This is a one-line fix per backend but must be documented in the GPU contract spec.

18. **Space-skipping in the buffer contract.** Spaces (codepoint 32) advance the cursor but do not emit a buffer slot. `glyphCount` in the buffer is strictly less than character count. Any port must replicate this. Memory estimates must use renderable glyph count, not character count.

---

## Implementation Plan

From the rendering-backend-portability perspective, the converged plan focuses on: (a) formalizing the GPU contract as documentation, (b) making the existing pipeline robust for production, and (c) preparing the portability seams without building premature abstractions.

### Phase 1: Formalize the buffer contract and GPU requirements spec

**Create: `src/core/types.js`**

Canonical JSDoc type definitions for the portable data contract. No runtime code -- pure documentation consumed by editors and ports.

```js
/**
 * @typedef {Object} GlyphBufferSet
 * @property {Float32Array} positions    - vec3 per glyph (3 floats)
 * @property {Float32Array} sizes        - vec2 per glyph (2 floats)
 * @property {Float32Array} codepoints   - 1 float per glyph (atlas map key)
 * @property {Float32Array} colors       - vec3 per glyph (3 floats)
 * @property {Float32Array} groupIds     - 1 float per glyph (group texture row)
 * @property {number} glyphCount         - renderable glyphs (excludes spaces)
 * @property {Object} itemMeta           - per-text-item metadata
 * @property {Int32Array} itemMeta.lineSlotOffsets - line -> buffer slot mapping
 */

/**
 * @typedef {Object} AtlasDescriptor
 * @property {number} width              - atlas texture width (pixels)
 * @property {number} height             - atlas texture height (pixels)
 * @property {number} atlasMapWidth      - map texture width (texels)
 * @property {number} atlasMapHeight     - map texture height (rows)
 * @property {Map<string, number>} graphemeToId - grapheme string -> numeric codepoint ID
 * @property {Float32Array} atlasMapData - RGBA32F flat array: [u0, v0, u1, v1] per glyph
 */

/**
 * Minimal GPU contract specification (requirements doc, NOT a runtime interface).
 * Documents what glyph3d-js needs from any graphics backend.
 *
 * @typedef {Object} GlyphGPUSpec
 * @property {Function} createPipeline    - (vertexSrc, fragmentSrc, instanceLayout, bindingLayout) -> Pipeline
 * @property {Function} createBuffer      - (byteSize) -> Buffer
 * @property {Function} uploadBuffer      - (buf, data: Float32Array) -> void
 * @property {Function} uploadBufferRange - (buf, byteOffset, data: Float32Array) -> void
 * @property {Function} createTexture     - (w, h, format, filter, mipmaps) -> Texture
 * @property {Function} uploadTexture     - (tex, data: TypedArray) -> void
 * @property {Function} createBitmapTexture - (pixels: ImageData|Canvas, mipmaps) -> Texture
 * @property {Function} createBindGroup   - (pipeline, {textures, uniforms}) -> BindGroup
 * @property {Function} drawInstanced     - (pipeline, bindGroup, vertexBuf, instanceBufs[], count) -> void
 * @property {Function} createRenderTarget - (w, h) -> RenderTarget
 * @property {Function} setRenderTarget   - (target|null) -> void
 * @property {Function} clear             - (r, g, b, a) -> void
 * @property {Function} readPixel         - (target, x, y) -> Promise<Uint8Array>
 */
```

**Modify: `src/workers/builders/index.js`**

Add `@returns {GlyphBufferSet}` JSDoc to `buildBatchBuffers()` and `buildGlyphBuffers()` referencing the new typedef. No functional changes.

### Phase 2: Async picking readback

**Modify: `src/picking/PickingSystem.js`**

Wrap `readRenderTargetPixels` in a Promise to establish the async contract before WebGPU arrives.

```js
// Before (sync):
// renderer.readRenderTargetPixels(target, x, y, 1, 1, this._readBuffer);
// return decode(this._readBuffer);

// After (async-ready):
readPixelAsync(renderer, target, x, y) {
    renderer.readRenderTargetPixels(target, x, y, 1, 1, this._readBuffer);
    return Promise.resolve(new Uint8Array(this._readBuffer));
}
```

All callers of `pick()` / `resolveGlyph()` updated to `await` or `.then()`. Since the current path resolves synchronously, no frame-latency change occurs -- but the API surface is now WebGPU-ready.

**Modify: callers in `app/` that use PickingSystem**

Change synchronous pick calls to `await pickingSystem.pick(x, y)`. These are already in async contexts (event handlers).

### Phase 3: GridVirtualizer memory reclamation

**Modify: `src/collections/CodeGrid.js`**

Add `unloadContent()` and `loadContent(bufferSet)` methods.

```js
/**
 * Release GPU buffers while preserving source reference for reload.
 * Called by GridVirtualizer when grid exits the eviction threshold.
 */
unloadContent() {
    if (this._collection) {
        this._collection.dispose();  // frees InstancedBufferGeometry + highlight texture
        this._contentLoaded = false;
        this._cachedSource = this._boundSource;  // keep source ref for reload
    }
}

/**
 * Reload content from cached source.
 * Called by GridVirtualizer when evicted grid re-enters frustum.
 */
async reloadContent() {
    if (this._cachedSource && !this._contentLoaded) {
        const content = await this._cachedSource.read();
        this.setText(content);
        await this._collection.flushAsync();
        this._contentLoaded = true;
    }
}
```

**Modify: `src/collections/GridVirtualizer.js`**

Add a second distance threshold (`evictionDistance`) beyond the frustum hysteresis. When a grid's distance exceeds `evictionDistance` for N consecutive update cycles, call `grid.unloadContent()`. When an evicted grid re-enters the frustum, call `grid.reloadContent()`.

```js
// In update():
for (const [grid, entry] of this._entries) {
    if (!entry.active && entry.distance > this.evictionDistance) {
        entry.evictionFrames = (entry.evictionFrames || 0) + 1;
        if (entry.evictionFrames > this.evictionDelay && grid._contentLoaded) {
            grid.unloadContent();
            entry.evicted = true;
        }
    } else {
        entry.evictionFrames = 0;
    }

    if (entry.active && entry.evicted) {
        grid.reloadContent();  // async -- grid renders next frame
        entry.evicted = false;
    }
}
```

### Phase 4: WebGL context loss handling

**Modify: `src/GlyphRenderer.js`**

Add context loss/restore listeners in `_createInstanceMesh()` or the constructor.

```js
_setupContextLossHandlers(canvas) {
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();  // allow restoration
        this._contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
        this._contextLost = false;
        // Re-upload all GPU state from in-memory data
        this._rebuildGPUState();
    });
}

_rebuildGPUState() {
    // Atlas texture: re-upload from GlyphAtlas canvas
    if (this.texture) this.texture.needsUpdate = true;
    // Atlas map: re-upload from GlyphAtlas data
    const atlasMapTex = this.atlas.getAtlasMapTexture(THREE);
    this.instanceMesh.material.uniforms.atlasMapTexture.value = atlasMapTex;
    // Group texture: re-upload
    if (this._groupTexture) this._groupTexture.needsUpdate = true;
    // Highlight texture: re-upload
    if (this._highlightTexture) this._highlightTexture.needsUpdate = true;
    // Instance buffers: mark all for full upload
    const geom = this.instanceMesh.geometry;
    for (const name of Object.keys(geom.attributes)) {
        geom.attributes[name].needsUpdate = true;
    }
}
```

**Modify: `src/picking/PickingSystem.js`**

On context restore, recreate the offscreen render target (`_createTarget()` must be called again since the old FBO is invalid).

### Phase 5: Pre-baked atlas loader

**Create: `src/GlyphAtlasLoader.js`**

Load a pre-generated atlas (PNG image + JSON descriptor) instead of runtime Canvas 2D rasterization. This is the key portability enabler for native targets.

```js
/**
 * Load a pre-baked glyph atlas from static assets.
 * Eliminates runtime Canvas 2D font rasterization dependency.
 *
 * @param {string} imageUrl  - URL to atlas PNG (e.g., '/assets/atlas-2048.png')
 * @param {string} descriptorUrl - URL to atlas JSON descriptor
 * @returns {Promise<{texture: THREE.Texture, atlasMapData: Float32Array, graphemeToId: Map, ...}>}
 */
export async function loadPrebakedAtlas(imageUrl, descriptorUrl) {
    const [image, descriptor] = await Promise.all([
        loadImage(imageUrl),
        fetch(descriptorUrl).then(r => r.json())
    ]);
    // Build atlas map Float32Array from descriptor
    // Build graphemeToId map from descriptor
    // Return in AtlasDescriptor shape
}
```

**Modify: `src/GlyphAtlas.js`**

Add a static factory method `GlyphAtlas.fromPrebuilt(atlasDescriptor)` that accepts the output of `loadPrebakedAtlas()` and creates a GlyphAtlas instance without calling `generate()`.

### Phase 6: Document portability constraints

**Create: `src/core/GPU_CONTRACT.md`** (only if Ivan requests documentation)

Otherwise, the GPU contract specification lives entirely in the JSDoc of `src/core/types.js` (Phase 1). The constraints to document:

- ES 3.0 hard floor (gl_InstanceID required)
- RGBA32F textures with NearestFilter only (no OES_texture_float_linear dependency)
- Minimum 4 simultaneous texture bindings, 3 in vertex stage
- Minimum 2048x2048 texture dimension
- Async readPixel contract
- Vulkan gl_InstanceIndex offset semantics
- Space-skipping (codepoint 32 does not emit buffer slots)
- 2^23 picking ID precision ceiling on float varying path

### Files summary

| Action | File | Phase |
|--------|------|-------|
| Create | `src/core/types.js` | 1 |
| Modify | `src/workers/builders/index.js` (JSDoc only) | 1 |
| Modify | `src/picking/PickingSystem.js` (async readPixel) | 2 |
| Modify | app/ pick callers (await) | 2 |
| Modify | `src/collections/CodeGrid.js` (unloadContent/reloadContent) | 3 |
| Modify | `src/collections/GridVirtualizer.js` (eviction logic) | 3 |
| Modify | `src/GlyphRenderer.js` (context loss handlers) | 4 |
| Modify | `src/picking/PickingSystem.js` (context restore) | 4 |
| Create | `src/GlyphAtlasLoader.js` | 5 |
| Modify | `src/GlyphAtlas.js` (fromPrebuilt factory) | 5 |

No files deleted. No new abstraction layers introduced. Every change either formalizes an existing contract, adds operational robustness, or opens a portability seam without restructuring the pipeline.

---

## Implementer Vote

**I vote for universal-text-pipeline.**

Reasoning: The converged implementation plan is dominated by buffer contract formalization (Phase 1), pipeline lifecycle hardening (Phases 3-4), and atlas portability (Phase 5). These map directly to universal-text-pipeline's Phase 0 focus areas: the `GlyphBufferSet` type definition, the `buildBatchBuffers` pipeline, the `AtlasDescriptor` contract, and the pre-baked atlas strategy. universal-text-pipeline's analysis already contains the most detailed specification of the buffer contract (10-float layout, typed array shapes, worker transfer protocol) and the atlas descriptor format. Their Round 1 self-correction on the byte count and their recommendations (formalize GlyphBufferSet, add memory reclamation, extract buildBatchBuffers) are almost exactly the Phase 1-3 plan above.

device-tier-scaling identified the critical VRAM reclamation gap and LOD strategy, but their perspective is diagnostic (identifying what is wrong) rather than constructive (specifying what to build). prior-art-lessons provides the strategic guardrails (no custom abstraction, xi-editor warning) but their output is advisory, not implementable. data-source-abstraction's focus is the input side of the pipeline, which is important but orthogonal to the GPU-backend work in this plan.

universal-text-pipeline is closest to the converged plan because they own the pipeline's middle layer -- the exact boundary where `GlyphBufferSet` meets the renderer -- and their Phase 0 already contains the most implementation-ready specifications for the types, contracts, and atlas interfaces that form the core of every phase.
