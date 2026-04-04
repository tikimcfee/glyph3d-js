# Round 3: prior-art-lessons convergence

## Settled

All five agents reached consensus through Round 1. The following points are fully resolved, each grounded in the prior art evidence that shaped my original analysis.

1. **The buffer contract is 10 floats = 40 bytes per glyph.** universal-text-pipeline's "11 floats" was a stale count. All five agents confirmed this error. The 4-byte RGBA8 highlight texel is a separate texture resource, not an 11th float. Every implementation must allocate `glyphCount * 10 * 4` bytes for instance data, period. (Alacritty, egui, ImGui all use similarly tight per-glyph packing -- there is no prior art for padding "just in case.")

2. **The `GlyphBufferSet` typed-array handoff is the portability seam.** rendering-backend-portability's `GlyphGPU` 13-function interface and data-source-abstraction's `TextSource` are complementary boundaries at different layers, but all agents agree the buffer set itself -- the output of `buildBatchBuffers`, the input to `applyPrebuiltBuffers` -- is the load-bearing contract. ImGui's `ImDrawList` and egui's `ClippedPrimitive` prove this pattern at ecosystem scale.

3. **No custom GPU abstraction layer.** Zed's Blade-to-wgpu migration is the definitive lesson. rendering-backend-portability's 13-function `GlyphGPU` interface is valuable as a requirements specification documenting what any backend must support, not as a runtime abstraction sitting between the pipeline and Three.js/wgpu. All five agents converged on this: Three.js for browser, wgpu for native, thin adapters per backend.

4. **GridVirtualizer must reclaim memory, not just draw calls.** device-tier-scaling identified this as the highest-impact gap. The virtualizer currently removes grids from the scene graph but leaves all GPU buffers allocated in VRAM. Prior art confirms: Zed only processes visible lines, Bevy uses ECS visibility to control resource allocation. Visibility culling without memory reclamation is incomplete -- it is the difference between "runs on the developer's machine" and "runs on a phone."

5. **Bitmap atlas is correct now; MSDF is correct later.** universal-text-pipeline recommended MSDF as "the right long-term move." My prior art survey showed every shipping project chose bitmap. Both positions are right at different timescales. The resolution (which all agents accepted): design the atlas pipeline so MSDF is a build-time swap (pre-baked atlas images), not an architecture change. Bevy's bitmap choice and cosmic-text's rasterization-agnostic output both validate this sequencing.

6. **Pre-baked atlas eliminates the font portability problem for the common case.** universal-text-pipeline proposed `loadAtlas(imageUrl, descriptorUrl)`. This is the single simplest path to both portability (no Canvas 2D dependency) and tier-scaling (ship 512/1024/2048 variants). Runtime rasterization via `ensureGraphemes()` remains as a fallback for unknown graphemes. ImGui's v1.92 `ImTextureData` status protocol is precedent for this dual-path model.

7. **Distance-based LOD is the highest-impact rendering optimization.** device-tier-scaling proposed near/mid/far bands using GridVirtualizer's existing `entry.distance` field. This is implementable today with no new infrastructure. Bevy's per-font-size atlas strategy and Zed's visible-lines-only approach are both LOD strategies by another name. Expected impact: 80-90% reduction in active glyph count at typical camera positions.

8. **`TextSource` is justified; scheduler/throttle/bridge layers are premature.** data-source-abstraction proposed four new classes. My Xi-editor warning applies: organizational abstractions that multiply coordination without proportional benefit. All agents agreed that `TextSource` alone is the right first step. `ThrottledSourceBridge` and `SourceUpdateScheduler` should be built only when a concrete streaming use case demands them. Xi-editor failed from exactly this pattern -- building infrastructure for use cases that had not materialized.

9. **Async `readPixel` is the correct picking API.** rendering-backend-portability proposed `readPixel -> Promise<Uint8Array>`. device-tier-scaling proposed mobile throttling. These are complementary. WebGPU requires async readback. The one-frame latency is imperceptible for hover interactions. Both the async API and per-device throttling should be implemented. No prior art project uses sync readback as a permanent API -- it is always a transitional convenience.

10. **WebGL context loss is a production gap.** device-tier-scaling identified this. No other agent had it in scope. No prior art project in the browser avoids this problem -- backgrounding a tab on iOS/Android destroys all WebGL state. The handler must re-create atlas textures, instance buffers, highlight textures, and shader programs from in-memory data. This is a prerequisite for mobile production use, not an optimization.

11. **The picking ID float precision ceiling at 2^23 is a real scalability wall.** rendering-backend-portability identified that `vPickingId` as a float varying loses precision past 8,388,608 IDs. The fix is `flat out int vPickingId` (GLSL ES 3.00 supports flat integer varyings), giving a full 32-bit range. At 10K glyphs per mesh this is not urgent, but it must be documented and fixed before scaling up.

12. **Space-skipping in the buffer builder is a portability-critical behavior.** rendering-backend-portability documented that spaces (codepoint 32) advance the cursor but do not emit buffer slots. Any port must replicate this, and memory estimates must use renderable glyph count, not character count. This is a subtle behavior that no prior art project documents explicitly, making it a likely source of bugs in re-implementations.

## Implementation Plan

Ordered by priority. Each item names concrete files and describes what changes, with code sketches for non-obvious parts. My perspective is anti-pattern avoidance: every recommendation is shaped by what failed in prior projects and what survived.

### Phase 1: Formalize Existing Seams (No New Behavior)

**Why first**: Xi-editor failed by building new infrastructure before documenting what already existed. Formalize before extending.

**1a. Create `src/core/types.js` -- the canonical buffer contract**

This file contains JSDoc typedefs only. No runtime code. It documents the contract that `buildBatchBuffers` already produces and `applyPrebuiltBuffers` already consumes.

```javascript
/**
 * @typedef {Object} GlyphBufferSet
 * @property {Float32Array} positions  - vec3 per glyph (x, y, z). Length: glyphCount * 3
 * @property {Float32Array} sizes      - vec2 per glyph (width, height). Length: glyphCount * 2
 * @property {Float32Array} glyphIds   - codepoint/grapheme ID per glyph. Length: glyphCount
 * @property {Float32Array} colors     - vec3 per glyph (r, g, b, 0-1 range). Length: glyphCount * 3
 * @property {Float32Array} groupIds   - group texture row per glyph. Length: glyphCount
 * @property {number} glyphCount       - Number of renderable glyphs (excludes spaces)
 * @property {GlyphBufferMeta} meta    - Layout metadata for downstream consumers
 */

/**
 * @typedef {Object} GlyphBufferMeta
 * @property {Int32Array} lineSlotOffsets - Maps line index to first buffer slot on that line
 * @property {number} lineCount          - Total lines in source text
 * @property {number} maxLineWidth       - Widest line in world units
 */

/**
 * @typedef {Object} AtlasDescriptor
 * @property {number} textureWidth
 * @property {number} textureHeight
 * @property {number} fontSize
 * @property {Map<string, {id: number, u0: number, v0: number, u1: number, v1: number, width: number, height: number, bearing: number}>} glyphs
 */
```

**Files touched**: New file `src/core/types.js`. Add `@see` references in `src/workers/builders/index.js` (at `buildBatchBuffers` return) and `src/collections/GlyphCollection.js` (at `applyPrebuiltBuffers` parameter).

**1b. Document the `GlyphGPU` requirements spec in `src/core/gpu-requirements.js`**

This is NOT a runtime interface. It is a JSDoc-only file listing the 13 functions from rendering-backend-portability's analysis, serving as documentation for anyone implementing a backend. This follows the ImGui model: ImGui documents what a backend must do without enforcing it via an abstract class.

Adjustments from rendering-backend-portability's original 13 functions:
- Drop `setUniform` in favor of a bind-group model (WebGPU compatibility, per rendering-backend-portability's own Round 1 recommendation).
- Add `setPipeline` or make `drawInstanced` accept a pipeline parameter, to support the picking system's material-swap pattern.
- Change `readPixel` signature to `readPixel(x, y) -> Promise<Uint8Array>`.

**Files touched**: New file `src/core/gpu-requirements.js`.

### Phase 2: Memory Reclamation (Highest-Impact Operational Fix)

**Why second**: device-tier-scaling proved this is the single highest-impact change. Zed processes only visible lines. Bevy uses ECS visibility for resource control. glyph3d-js currently keeps all 1500 grids' buffers in VRAM even though only 50 are drawn. This is the #1 reason the system fails on constrained devices.

**2a. Add `unloadContent()` / `reloadContent()` to CodeGrid**

`GridVirtualizer.js` line 17 already mentions `unloadContent()` in a comment, but the method does not exist on `CodeGrid`. The implementation should:

- `unloadContent()`: Call `this._collection.dispose()`, null the collection reference, set a `this._contentUnloaded = true` flag, store the source text (or a reference to it) needed for reconstruction.
- `reloadContent(atlas)`: Re-create the `GlyphCollection`, re-run `setText()` / buffer building from stored source, clear the `_contentUnloaded` flag.

```javascript
// In CodeGrid.js
unloadContent() {
    if (this._collection) {
        this._collection.dispose();
        this._collection = null;
    }
    this._contentUnloaded = true;
}

async reloadContent(atlas) {
    if (!this._contentUnloaded || !this._sourceText) return;
    this._collection = new GlyphCollection(atlas);
    await this._collection.setText(this._sourceText, this._textOptions);
    this._contentUnloaded = false;
}
```

**File**: `src/collections/CodeGrid.js`

**Anti-pattern warning (Xi lesson)**: Do NOT create a `ContentLifecycleManager` or `GridMemoryCoordinator` class. The eviction logic belongs in `GridVirtualizer` calling `CodeGrid.unloadContent()` directly. Adding coordination layers is exactly what killed Xi.

**2b. Add eviction distance threshold to GridVirtualizer**

`GridVirtualizer.js` already computes `entry.distance` (line 192). Add a second threshold beyond the visibility radius:

```javascript
// In GridVirtualizer.js update loop
const EVICTION_DISTANCE = this._visibilityRadius * 3;
const EVICTION_DELAY_MS = 5000;

for (const entry of this._entries) {
    if (entry.distance > EVICTION_DISTANCE && !entry.grid._contentUnloaded) {
        if (!entry._evictionTimer) {
            entry._evictionTimer = performance.now();
        } else if (performance.now() - entry._evictionTimer > EVICTION_DELAY_MS) {
            entry.grid.unloadContent();
            entry._evictionTimer = null;
        }
    } else {
        entry._evictionTimer = null;
    }

    if (entry.distance < this._visibilityRadius && entry.grid._contentUnloaded) {
        entry.grid.reloadContent(this._atlas);
    }
}
```

**File**: `src/collections/GridVirtualizer.js`

**Anti-pattern warning (Zed lesson)**: The eviction delay prevents thrashing at the boundary. Zed learned that instantaneous eviction/reload causes visible flicker. The 5-second delay is conservative; tune based on testing.

### Phase 3: Distance-Based LOD

**Why third**: This is the second-highest-impact optimization after memory reclamation. It reduces active glyph count without changing architecture. Every prior art project does some form of this -- Zed (visible lines only), Bevy (ECS visibility), egui (culled primitives).

**3a. Add LOD levels to CodeGrid**

Three levels, matching device-tier-scaling's proposal:
- **Near** (< 200 units): Full glyph rendering (current behavior).
- **Mid** (200-800 units): Solid-color rectangles per line (one quad per line, average line color from syntax highlighting).
- **Far** (> 800 units): Single colored rectangle for the entire grid.

The mid-range representation is the critical one. It should use the existing `GlyphRenderer` with a degenerate buffer: one "glyph" per line, sized to the line's width, colored to the line's dominant syntax color.

```javascript
// In CodeGrid.js
setLOD(level) {
    if (level === this._currentLOD) return;
    this._currentLOD = level;
    switch (level) {
        case 'near': this._showFullContent(); break;
        case 'mid':  this._showLineBlocks(); break;
        case 'far':  this._showGridBlock(); break;
    }
}
```

**Files**: `src/collections/CodeGrid.js` (LOD methods), `src/collections/GridVirtualizer.js` (LOD switching based on `entry.distance`).

### Phase 4: Pre-Baked Atlas Pipeline

**Why fourth**: This is the bridge to both portability (eliminates Canvas 2D dependency) and MSDF (swappable at build time). The prior art is strong: ImGui ships default fonts as embedded data, egui embeds fonts, cosmic-text's output is a bitmap+metrics pair that could be serialized.

**4a. Add atlas export to GlyphAtlas**

```javascript
// In GlyphAtlas.js
exportDescriptor() {
    return {
        textureWidth: this._canvas.width,
        textureHeight: this._canvas.height,
        fontSize: this._fontSize,
        glyphs: Object.fromEntries(
            Object.entries(this._glyphMap).map(([grapheme, entry]) => [
                grapheme, { id: entry.id, u0: entry.u0, v0: entry.v0,
                           u1: entry.u1, v1: entry.v1,
                           width: entry.width, height: entry.height,
                           bearing: entry.bearing }
            ])
        )
    };
}

exportImage() {
    return this._canvas.toDataURL('image/png');
}
```

**4b. Add atlas import (`loadAtlas`)**

```javascript
// In GlyphAtlas.js
static async loadAtlas(imageUrl, descriptorUrl) {
    const [img, descriptor] = await Promise.all([
        loadImage(imageUrl),
        fetch(descriptorUrl).then(r => r.json())
    ]);
    const atlas = new GlyphAtlas();
    atlas._canvas = img;  // or draw to canvas
    atlas._glyphMap = descriptor.glyphs;
    atlas._fontSize = descriptor.fontSize;
    // Build Three.js texture from image
    atlas._buildThreeTexture();
    return atlas;
}
```

**File**: `src/GlyphAtlas.js`

**Anti-pattern warning (egui lesson)**: egui's atlas grows dynamically. The pre-baked path must still support `ensureGraphemes()` for characters not in the pre-baked set. Do not make pre-baked and dynamic mutually exclusive -- they must compose. The pre-baked atlas covers the common case (ASCII + Latin-1 + box drawing); `ensureGraphemes()` handles the long tail.

### Phase 5: WebGL Context Loss Handling

**Why fifth**: This is a production-critical fix for mobile but does not block the other phases. No prior art project in the browser avoids this problem.

**5a. Add context loss/restore handlers to GlyphRenderer**

```javascript
// In GlyphRenderer.js constructor or init
this._canvas = renderer.domElement;
this._canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();  // Allows restoration
    this._contextLost = true;
});
this._canvas.addEventListener('webglcontextrestored', () => {
    this._contextLost = false;
    this._rebuildGPUResources();
});

_rebuildGPUResources() {
    // Re-upload atlas texture
    this._atlas._buildThreeTexture();
    // Re-create highlight DataTexture
    this._createHighlightTexture();
    // Mark all buffers as needing full upload
    this._needsFullUpload = true;
}
```

**File**: `src/GlyphRenderer.js`

The key insight from prior art: all in-memory data (atlas bitmap, typed arrays, highlight state) survives context loss. Only GPU-side resources are destroyed. The restore handler re-uploads from existing data, it does not re-compute anything.

### Phase 6: Picking ID Precision Fix

**Why last**: This is a scalability fix that is not urgent at current scale (10K glyphs per mesh = 838 meshes before overflow), but must be done before scaling up.

**6a. Change `vPickingId` from `float` to `flat int`**

In `PickingSystem.js`, change the picking vertex shader:
```glsl
// Before:
out float vPickingId;
vPickingId = uBasePickingId + float(gl_InstanceID);

// After:
flat out int vPickingId;
vPickingId = int(uBasePickingId) + gl_InstanceID;
```

And the fragment shader:
```glsl
// Before:
in float vPickingId;
float id = vPickingId;
float r = floor(id / 65536.0);

// After:
flat in int vPickingId;
int id = vPickingId;
int r = (id >> 16) & 0xFF;
int g = (id >> 8) & 0xFF;
int b = id & 0xFF;
fragColor = vec4(float(r)/255.0, float(g)/255.0, float(b)/255.0, 1.0);
```

**File**: `src/picking/PickingSystem.js`

This gives a clean 24-bit ID range (16M glyphs) with zero precision loss, and the encode/decode symmetry matches the JS-side bitshift decode at line 349.

## Implementer Vote

**rendering-backend-portability** should implement.

Reasoning: The implementation plan above is dominated by formalizing GPU-facing contracts (types.js, gpu-requirements.js), modifying GPU resource lifecycle (memory reclamation, context loss, LOD switching), and adjusting shader code (picking precision fix). These are all squarely within rendering-backend-portability's domain expertise -- that agent produced the most precise analysis of the GPU pipeline internals, correctly mapped the texture binding layout, identified the `readPixel` async requirement, and provided concrete LOC estimates for backend implementations. The prior art lessons I bring are now embedded in the anti-pattern warnings throughout this plan; the actual implementation work is GPU plumbing, and rendering-backend-portability is the right agent for that.

The one risk: rendering-backend-portability initially proposed the `GlyphGPU` as a runtime abstraction, which all agents agreed should be a spec-only document. As long as the implementer follows the "requirements spec, not runtime layer" guidance in Phase 1b, this agent is the strongest choice.
