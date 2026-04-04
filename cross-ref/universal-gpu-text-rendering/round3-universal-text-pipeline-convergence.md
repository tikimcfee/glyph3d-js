# Round 3: universal-text-pipeline convergence

## Settled

All points are now fully resolved. Round 1 cross-review achieved consensus across all five agents. No residual disagreements exist.

1. **Per-glyph cost is 10 floats = 40 bytes instance data, not 11.** My Phase 0 header ("11 floats = 44 bytes") was wrong -- a stale count from before the GPU-side codepoint-to-UV lookup replaced a per-instance UV attribute. The buffer contract is 5 typed arrays totaling 10 floats per glyph: positions (3) + sizes (2) + codepoints (1) + colors (3) + groupIds (1). The highlight texture adds 4 bytes RGBA8 per glyph as a separate resource, making the effective total 44 bytes, but the `GlyphBufferSet` specification must document 10 floats. All five agents confirmed this independently.

2. **`GlyphBufferSet` is the portability seam.** The typed-array handoff between `buildBatchBuffers()` and `applyPrebuiltBuffers()` is already the correct architectural boundary. It crosses language boundaries (JS to Rust/Swift), runtime boundaries (Worker to main thread), and backend boundaries (Three.js to wgpu). All five agents independently identified this same boundary. No new GPU abstraction layer should sit on top of it.

3. **No custom GPU abstraction layer.** rendering-backend-portability's 13-function `GlyphGPU` interface is a requirements specification, not a runtime implementation target. prior-art-lessons' evidence from Zed's Blade-to-wgpu migration and xi-editor's over-modularization is decisive. Use Three.js for browser, wgpu for native. The buffer set typed arrays are the interface between portable logic and platform-specific rendering.

4. **Bitmap atlas now, MSDF later, pre-baked atlas as the bridge.** My Phase 0 recommended MSDF as "the right long-term move." prior-art-lessons correctly countered that every shipping GPU text project chose bitmap over SDF for code/UI text. Both positions are right at different timescales. The resolution: design the atlas pipeline so generation is decoupled from consumption. Pre-baked atlas (PNG + JSON descriptor) enables MSDF as a build-time swap later without architectural change. The pre-baked path simultaneously solves portability (no Canvas 2D dependency), tier-scaling (ship 512/1024/2048 variants), and the MSDF migration path.

5. **Pre-baked atlas is the default portability path.** Eliminates runtime Canvas 2D font rasterization for the common charset (ASCII + Latin-1 + box drawing). Native ports ship PNG + JSON and skip platform font dependencies entirely for the base case. Runtime rasterization via `ensureGraphemes()` remains as the fallback for unknown graphemes. This dual-path model follows ImGui's `ImTextureData` precedent.

6. **GridVirtualizer must reclaim GPU memory, not just draw calls.** device-tier-scaling's most critical finding. My Phase 0 treated frustum culling as a scaling mechanism without noting that it only eliminates draw calls -- all buffers remain in VRAM. On mobile GPUs with 256MB-1GB budgets, 1500 grids exhaust VRAM even when only 50 are drawn. Buffer eviction by distance threshold is mandatory for constrained devices.

7. **Distance-based LOD is the highest-impact rendering optimization.** GridVirtualizer already computes `entry.distance` every update cycle. Adding near/mid/far LOD bands cuts active glyph count by 80-90%. This requires no new abstractions and builds on data already computed every frame.

8. **Async-first picking readback.** rendering-backend-portability proposed `readPixel -> Promise<Uint8Array>` for WebGPU compatibility. device-tier-scaling proposed per-frame throttling on mobile. Both are complementary. The API should return a Promise even on WebGL2 (`Promise.resolve(pixel)`) to prevent sync assumptions from spreading before WebGPU arrives. One frame of latency is imperceptible for hover interactions.

9. **WebGL context loss is a production gap.** device-tier-scaling identified this and no other Phase 0 addressed it. Backgrounding a tab on iOS/Android destroys all WebGL state. The handler must re-create atlas textures, instance buffers, highlight textures, and shader programs from in-memory data. This is a prerequisite for mobile production use.

10. **Data source abstraction should be minimal.** prior-art-lessons' xi-editor warning applies. `TextSource` as an interface is justified. `ThrottledSourceBridge` and `SourceUpdateScheduler` should be deferred. Coalescing logic (~15 lines) belongs directly in `SourceBoundGrid`, not in separate wrapper classes. Build infrastructure only when concrete streaming use cases demand it.

11. **My `AtlasDescriptor.uvMap` was keyed wrong.** rendering-backend-portability correctly noted that my proposed `uvMap: Map<glyphId, {u0, v0, u1, v1}>` conflated two different maps. The actual atlas map is keyed by grapheme string, not numeric ID. The correct decomposition is: `graphemeToId: Map<string, u32>` (which I did include) and `uvMap` keyed by grapheme string. Since the vertex shader resolves UVs via the DataTexture, the runtime contract only needs the numeric ID -- UV coordinates never appear in the buffer.

12. **Stage 2 (layout) does depend on `iterGraphemes`.** device-tier-scaling flagged that my Phase 0 listed layout as "No platform deps" while the `iterGraphemes()` call is inline in the layout loop at `src/workers/builders/index.js` line 343. The grapheme iterator is an input to layout, not a separate stage. The correct framing: Stage 2 is portable given a grapheme iterator, but the iterator itself depends on `Intl.Segmenter` (or a platform equivalent).

13. **Picking ID precision ceiling at 2^23.** rendering-backend-portability identified that `vPickingId` as a float varying loses precision past 8,388,608. The fix is `flat out int vPickingId` (supported in GLSL ES 3.00), giving full 24-bit ID range with zero precision loss. Not urgent at 10K glyphs per mesh but must be fixed before scaling up.

14. **Space-skipping is a portability-critical behavior.** Spaces (codepoint 32) advance the cursor but do not emit a buffer slot in `buildBatchBuffers`. `glyphCount` in the output is strictly less than character count. Any port must replicate this, and memory estimates must use renderable glyph count, not character count.

15. **Worker `uvMap` transfer should be cached.** The outbound `uvMap` from main-to-worker is a plain object (structured clone, not transferable). It should be cached in the worker after first receipt since it only changes when `ensureGraphemes()` adds new codepoints. The return path (worker-to-main) should use `postMessage(result, [buffer1, buffer2, ...])` with a transfer list for zero-copy.

16. **`TextSource` and `GlyphBufferSet` are complementary seams.** data-source-abstraction correctly identified that the system has two portability boundaries: `TextSource` (where content enters) and `GlyphBufferSet` (where typed arrays exit toward the GPU). The full pipeline is `TextSource -> buildBatchBuffers() -> GlyphBufferSet -> GPU backend`. Both seams need explicit specification.

17. **ES 3.0 / WebGL 2 is the hard floor.** `gl_InstanceID` in the vertex shader is the linchpin. Without it, picking, highlighting, and the codepoint-to-UV atlas lookup all break. Devices below ES 3.0 need an entirely separate renderer, not a degraded GPU path.

18. **Vulkan `gl_InstanceIndex` offset semantics differ from WebGL2 `gl_InstanceID`.** `gl_InstanceIndex` includes `firstInstance` from the draw call; `gl_InstanceID` always starts at 0. The picking system's `uBasePickingId` must account for this on Vulkan/wgpu backends. A one-line fix per backend, but it must be documented in the GPU requirements spec.

---

## Implementation Plan

From the universal-text-pipeline perspective, the converged plan focuses on: (a) formalizing the buffer contract and atlas descriptor as the canonical portable types, (b) extracting the buffer builder into a standalone portable module, (c) adding the pre-baked atlas path that eliminates the font rasterization dependency, and (d) integrating with the operational hardening work (memory reclamation, context loss, LOD) that other agents own.

### Phase 1: Formalize the buffer contract types

**Create: `src/core/types.js`**

Pure JSDoc typedefs. No runtime code. This is the canonical specification consumed by editors, ports, and documentation.

```js
/**
 * The portable buffer contract between text processing and GPU rendering.
 * Output of buildBatchBuffers(). Input to applyPrebuiltBuffers().
 * 10 floats = 40 bytes per glyph across 5 typed arrays.
 *
 * @typedef {Object} GlyphBufferSet
 * @property {Float32Array} positions  - vec3 per glyph. Length: glyphCount * 3
 * @property {Float32Array} sizes      - vec2 per glyph (from atlas metrics). Length: glyphCount * 2
 * @property {Float32Array} codepoints - atlas map key per glyph. Length: glyphCount
 * @property {Float32Array} colors     - vec3 per glyph (0-1 range). Length: glyphCount * 3
 * @property {Float32Array} groupIds   - group texture row per glyph. Length: glyphCount
 * @property {number} glyphCount       - renderable glyphs (excludes spaces/whitespace)
 * @property {Object|null} bounds      - {min: {x,y,z}, max: {x,y,z}, width, height, depth}
 * @property {GlyphBufferItemMeta[]} itemMeta - per-text-entry metadata
 */

/**
 * Per-text-item metadata produced alongside buffer data.
 * @typedef {Object} GlyphBufferItemMeta
 * @property {number} bufferStartIndex - first slot in the buffer for this item
 * @property {number} glyphCount       - number of glyphs for this item
 * @property {Object|null} bounds      - item-local bounding box
 * @property {Int32Array} lineSlotOffsets - maps line index -> first buffer slot on that line
 */

/**
 * Atlas descriptor: platform-independent description of a font texture atlas.
 * Generated by GlyphAtlas.generate() or loaded from pre-baked PNG + JSON.
 * Consumed identically by all rendering backends.
 *
 * @typedef {Object} AtlasDescriptor
 * @property {number} textureWidth      - atlas bitmap width (pixels)
 * @property {number} textureHeight     - atlas bitmap height (pixels)
 * @property {number} fontSize          - font size used during generation (px)
 * @property {number} atlasMapWidth     - map DataTexture width (texels)
 * @property {number} atlasMapHeight    - map DataTexture height (rows)
 * @property {Object} glyphs           - {grapheme: {id, u0, v0, u1, v1, width, height, advance}}
 * @property {Object} glyphWidths      - {grapheme: pixelWidth} for layout
 * @property {ImageData|HTMLCanvasElement|null} atlasImage - platform-specific bitmap (null if pre-baked)
 * @property {Float32Array} atlasMapData - RGBA32F flat array: [u0, v0, u1, v1] per glyph slot
 */
```

**Modify: `src/workers/builders/index.js`**

Add `@returns {GlyphBufferSet}` JSDoc to `buildBatchBuffers()` and `buildGlyphBuffers()` referencing the types. No functional changes.

**Modify: `src/GlyphRenderer.js`**

Add `@param {GlyphBufferSet}` to `applyPrebuiltBuffers()`. No functional changes.

### Phase 2: Extract the portable buffer builder

**Create: `src/workers/builders/buildBatchBuffers.js`**

Extract `buildBatchBuffers()` from `src/workers/builders/index.js` into its own file with explicit imports and documented type contracts. Currently the function lives in `index.js` alongside `buildGlyphBuffers()`, re-exports, and the worker message handler. The extraction makes the portable core greppable and its dependency tree explicit.

The function has exactly one external dependency: `iterGraphemes` from grapheme utilities. The extraction preserves this.

```js
// src/workers/builders/buildBatchBuffers.js
import { iterGraphemes, countGlyphs } from '../utils/grapheme.js';

/**
 * Single-pass text-to-typed-array conversion. The portable core of the pipeline.
 * Runs in Web Workers (no DOM, no Three.js). Pure function over plain data.
 *
 * @param {Object} params
 * @param {Array<{text: string, x: number, y: number, z: number, color?: {r,g,b}, groupId?: number}>} params.items
 * @param {Object} params.metrics - {charWidth, charHeight, letterSpacing, lineSpacing, worldScale}
 * @param {Object} params.uvMap   - {grapheme: {u0, v0, u1, v1, numericId}}
 * @param {Object} params.glyphWidths - {grapheme: pixelWidth}
 * @returns {GlyphBufferSet}
 */
export function buildBatchBuffers(params) {
    // ... moved from index.js, unchanged logic
}
```

**Modify: `src/workers/builders/index.js`**

Re-export `buildBatchBuffers` from the new file. The worker message handler stays in `index.js`. No behavior change for callers.

```js
export { buildBatchBuffers } from './buildBatchBuffers.js';
```

**Why this matters for portability**: The extracted file is the ~170-line function that a Rust/Swift port would translate. Making it a standalone module with an explicit import tree and typed contract makes the porting target unambiguous. Every input is plain data (strings, numbers, plain objects). Every output is typed arrays.

### Phase 3: Worker `uvMap` caching

**Modify: `src/workers/GlyphWorker.js`**

Cache the `uvMap` and `glyphWidths` in worker-global scope after first receipt. Only resend when `ensureGraphemes()` adds new codepoints (detectable by version counter or map size change).

```js
// In GlyphWorker.js message handler
let cachedUvMap = null;
let cachedGlyphWidths = null;
let cachedMapVersion = 0;

self.onmessage = (e) => {
    const { uvMap, glyphWidths, mapVersion, ...rest } = e.data;

    // Only update cache when atlas has changed
    if (mapVersion !== cachedMapVersion) {
        cachedUvMap = uvMap ?? cachedUvMap;
        cachedGlyphWidths = glyphWidths ?? cachedGlyphWidths;
        cachedMapVersion = mapVersion;
    }

    const result = buildBatchBuffers({
        ...rest,
        uvMap: cachedUvMap,
        glyphWidths: cachedGlyphWidths,
    });

    // Transfer typed arrays back (zero-copy)
    const transferList = [
        result.positions.buffer,
        result.sizes.buffer,
        result.codepoints.buffer,
        result.colors.buffer,
        result.groupIds.buffer,
    ];
    self.postMessage(result, transferList);
};
```

**Modify: `src/workers/WorkerBridge.js`**

Add a `_mapVersion` counter that increments when `ensureGraphemes()` is called. Only include `uvMap` and `glyphWidths` in the message when the version has changed since the target worker last received it.

```js
// In WorkerBridge
_dispatchToWorker(workerId, job) {
    const msg = { ...job };
    if (this._workerMapVersions[workerId] !== this._mapVersion) {
        msg.uvMap = this._uvMap;
        msg.glyphWidths = this._glyphWidths;
        msg.mapVersion = this._mapVersion;
        this._workerMapVersions[workerId] = this._mapVersion;
    } else {
        msg.mapVersion = this._mapVersion;
    }
    this._workers[workerId].postMessage(msg);
}
```

**Why this matters**: The `uvMap` is a plain object containing ~200-500 entries (one per distinct grapheme in the charset). Structured cloning it on every job dispatch wastes both time and memory. Caching eliminates redundant transfers for the ~99% of dispatches where the atlas has not changed.

### Phase 4: Pre-baked atlas pipeline

**Modify: `src/GlyphAtlas.js`**

Add two methods for export and import.

Export (build-time / debug tool):

```js
/**
 * Serialize atlas state for pre-baking. Run once at build time.
 * @returns {{image: string, descriptor: Object}}
 */
exportAtlas() {
    const descriptor = {
        textureWidth: this._canvas.width,
        textureHeight: this._canvas.height,
        fontSize: this._fontSize,
        atlasMapWidth: this._atlasMapWidth,
        atlasMapHeight: this._atlasMapHeight,
        glyphs: {},
        glyphWidths: {},
    };
    for (const [grapheme, entry] of Object.entries(this._glyphMap)) {
        descriptor.glyphs[grapheme] = {
            id: entry.id, u0: entry.u0, v0: entry.v0,
            u1: entry.u1, v1: entry.v1,
            width: entry.width, height: entry.height,
            advance: entry.advance,
        };
        descriptor.glyphWidths[grapheme] = entry.width;
    }
    return {
        image: this._canvas.toDataURL('image/png'),
        descriptor,
    };
}
```

Import (runtime fast path):

```js
/**
 * Load a pre-baked atlas from static assets.
 * Eliminates runtime Canvas 2D font rasterization.
 *
 * @param {string} imageUrl - URL to atlas PNG
 * @param {string} descriptorUrl - URL to atlas JSON
 * @returns {Promise<GlyphAtlas>}
 */
static async fromPrebuilt(imageUrl, descriptorUrl) {
    const [img, descriptor] = await Promise.all([
        new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = imageUrl;
        }),
        fetch(descriptorUrl).then(r => r.json()),
    ]);

    const atlas = new GlyphAtlas();
    // Draw image to canvas for ensureGraphemes() fallback
    atlas._canvas = document.createElement('canvas');
    atlas._canvas.width = descriptor.textureWidth;
    atlas._canvas.height = descriptor.textureHeight;
    const ctx = atlas._canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    atlas._ctx = ctx;

    // Restore glyph map
    atlas._glyphMap = descriptor.glyphs;
    atlas._glyphWidths = descriptor.glyphWidths;
    atlas._fontSize = descriptor.fontSize;
    atlas._atlasMapWidth = descriptor.atlasMapWidth;
    atlas._atlasMapHeight = descriptor.atlasMapHeight;

    // Shelf-packing state: set cursor past all existing glyphs
    // so ensureGraphemes() can add new ones
    atlas._shelfX = descriptor.textureWidth;  // will wrap to next row
    atlas._shelfY = 0;
    atlas._shelfRowHeight = 0;
    for (const entry of Object.values(descriptor.glyphs)) {
        atlas._shelfY = Math.max(atlas._shelfY, entry.v1 * descriptor.textureHeight);
    }

    atlas._generated = true;
    return atlas;
}
```

**Create: `tools/bake-atlas.mjs`**

A Node.js script (or browser page) that generates the pre-baked atlas pair. Uses `canvas` npm package (node-canvas) for headless Canvas 2D or runs in a browser context.

```js
#!/usr/bin/env node
// tools/bake-atlas.mjs
// Usage: node tools/bake-atlas.mjs --font "Monaco" --size 48 --out ./assets/atlas
import { GlyphAtlas } from '../src/GlyphAtlas.js';

const atlas = new GlyphAtlas({ fontSize: parseInt(process.argv[4] || '48') });
atlas.generate();
const { image, descriptor } = atlas.exportAtlas();

// Write PNG and JSON
import { writeFileSync } from 'fs';
writeFileSync(`${outDir}/atlas.png`, Buffer.from(image.split(',')[1], 'base64'));
writeFileSync(`${outDir}/atlas.json`, JSON.stringify(descriptor, null, 2));
```

This script is a build-time tool, not part of the runtime pipeline. It can generate atlases at multiple sizes (512, 1024, 2048) for device-tier-scaling's multi-resolution strategy.

### Phase 5: Extract `iterGraphemes` to a reusable portable module

**Current state**: `iterGraphemes` and `countGlyphs` are defined in the builder files or `src/utils/grapheme.js` (the exact path needs verification -- data-source-abstraction flagged that `src/utils/grapheme.js` may be aspirational rather than factual).

**Action**: Verify the actual location. If `iterGraphemes` is inline in the builders, extract it to `src/utils/grapheme.js` (or confirm it already lives there). This file must:
- Export `iterGraphemes(string)` -> iterator of grapheme cluster strings
- Export `countGlyphs(string)` -> number of renderable glyphs (excluding spaces)
- Use `Intl.Segmenter` with `codePointAt()` fallback
- Import nothing (zero dependencies)

This file is the first thing a Rust port would replace with `unicode-segmentation::UnicodeSegmentation::graphemes()`.

### Phase 6: Integration points for other agents' work

These are not changes I build, but interfaces I provide or consume.

**For device-tier-scaling (LOD + memory reclamation)**:
- `GlyphBufferSet` metadata includes `bounds` and `itemMeta[].lineSlotOffsets`. LOD mid-range (one quad per line) can be computed from `lineSlotOffsets` and per-line color averaging without re-running the builder.
- `unloadContent()` on CodeGrid must null out the `GlyphBufferSet` arrays. `reloadContent()` re-runs `buildBatchBuffers()` through the worker pool.

**For data-source-abstraction (TextSource)**:
- `buildBatchBuffers()` accepts `items[].text` as plain strings. `TextSource.read()` must return a plain string. No special encoding.
- `ensureGraphemes()` must be called before building buffers for text containing non-ASCII characters. `TextSource` should expose a charset hint (optional) so `ensureGraphemes()` can be batched.

**For rendering-backend-portability (GPU contract)**:
- `applyPrebuiltBuffers()` in `GlyphRenderer.js` is the sole consumer of `GlyphBufferSet` on the Three.js path. A wgpu backend would implement its own `applyPrebuiltBuffers()` equivalent consuming the same typed arrays.
- The `AtlasDescriptor` carries `atlasMapData` (Float32Array) which becomes the atlas map DataTexture/GPUTexture on any backend.

### File summary

| Action | File | Phase | Description |
|--------|------|-------|-------------|
| Create | `src/core/types.js` | 1 | JSDoc typedefs for GlyphBufferSet, AtlasDescriptor |
| Modify | `src/workers/builders/index.js` | 1, 2 | Add @returns JSDoc; re-export from new module |
| Modify | `src/GlyphRenderer.js` | 1 | Add @param JSDoc to applyPrebuiltBuffers |
| Create | `src/workers/builders/buildBatchBuffers.js` | 2 | Extracted portable buffer builder |
| Modify | `src/workers/GlyphWorker.js` | 3 | Cache uvMap/glyphWidths per mapVersion |
| Modify | `src/workers/WorkerBridge.js` | 3 | Add mapVersion counter, conditional uvMap send |
| Modify | `src/GlyphAtlas.js` | 4 | exportAtlas(), static fromPrebuilt() |
| Create | `tools/bake-atlas.mjs` | 4 | Build-time atlas generation script |
| Verify/Create | `src/utils/grapheme.js` | 5 | Standalone grapheme segmentation module |
| -- | (no changes) | 6 | Integration points documented, not built |

No files deleted. No new abstraction layers. Every change either formalizes an existing contract, extracts an existing function for clarity, or opens a portability seam.

---

## Implementer Vote

**rendering-backend-portability** should implement.

The implementation votes across all five agents tell a clear story:

- rendering-backend-portability voted for **universal-text-pipeline** (me)
- device-tier-scaling voted for **rendering-backend-portability**
- data-source-abstraction voted for **device-tier-scaling**
- prior-art-lessons voted for **rendering-backend-portability**

rendering-backend-portability received the most votes (2 of 4 others), and I add a third. Here is why:

The converged implementation plan -- taken across all five agents -- is dominated by GPU resource lifecycle work. The buffer contract formalization (my Phase 1) is JSDoc documentation requiring no deep GPU knowledge. The pre-baked atlas (my Phase 4) is a serialization/deserialization pair. But the changes that actually make the system production-viable -- memory reclamation in GridVirtualizer (disposing and re-creating `InstancedBufferGeometry` without leaking GPU memory or corrupting shared atlas state), WebGL context loss recovery (re-uploading textures, re-creating shader programs, coordinating across GlyphRenderer/GlyphAtlas/PickingSystem), LOD switching (hiding/showing instance meshes, potentially swapping to simplified buffer sets), and the async picking readback -- these all require precise understanding of the Three.js GPU object lifecycle.

rendering-backend-portability demonstrated this understanding most concretely: they mapped every texture binding, distinguished `texelFetch` from `texture()`, identified the WebGPU bind group model change, produced the 13-function requirements spec, and gave LOC estimates per backend. They know where the GPU objects are created, how they are disposed, and what order operations must happen in.

My own Phase 0 is the closest to the converged plan's type formalization and atlas portability work, but the hardest engineering in the converged plan is not my domain -- it is GPU resource management. The types and contracts I propose are documentation that any competent engineer can write once the GPU lifecycle work is solid. Getting `_onContextRestored()` right, or ensuring `unloadContent()` does not leak a `DataTexture` reference while the shared atlas survives, requires the kind of API-surface knowledge that rendering-backend-portability has already proven they possess.

device-tier-scaling would be my second choice -- they identified the VRAM reclamation gap and understand the budget system. But their strength is diagnostic (what is wrong, what the budgets should be) rather than constructive at the GPU API level.
