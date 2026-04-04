# Round 3: device-tier-scaling convergence

## Settled

All five agents reached consensus on the following points through Round 1 cross-review. No residual disagreements remain.

1. **Buffer contract is 10 floats = 40 bytes per glyph, not 11.** All five agents independently verified this against `src/workers/builders/index.js` lines 81-85 and `GlyphRenderer.js` lines 300-304. The effective per-glyph cost is 44 bytes (40 instance + 4 highlight RGBA8), but these are separate resources. The `GlyphBufferSet` spec must document 10 floats.

2. **GridVirtualizer culls draw calls, not memory.** My Phase 0 identified this; all four reviewers agreed it is the highest-impact gap. The virtualizer header comment (line 17) already says "pair with unloadContent()" but `CodeGrid.unloadContent()` does not exist. Buffer eviction for off-screen grids is mandatory for Tier 1-2 devices.

3. **No custom GPU abstraction layer.** rendering-backend-portability's 13-function `GlyphGPU` interface is valuable as a requirements specification, not as a runtime abstraction. prior-art-lessons' Blade/xi-editor evidence is decisive. Use Three.js for browser, wgpu directly for native. The `GlyphBufferSet` typed-array handoff IS the portability seam.

4. **Distance-based LOD is the highest-leverage single optimization.** GridVirtualizer already computes `entry.distance` per grid per update cycle. Adding LOD bands (near/mid/far) with progressive simplification cuts active glyph count by 80-90%. All five agents endorsed this.

5. **WebGL context loss handling is unaddressed and critical for mobile.** No agent disagreed. `webglcontextlost`/`webglcontextrestored` must be handled. All GPU state (textures, buffers, shaders) is destroyed on context loss. Recovery requires full reinitialization from in-memory data.

6. **Async `readPixel` is the correct picking API.** rendering-backend-portability proposed it for WebGPU compatibility; I proposed frame-throttling for mobile. These are complementary. The API should return `Promise<Uint8Array>` even on WebGL2 (trivially wrapped), and callers should throttle on constrained devices. One frame of latency is imperceptible for hover.

7. **Pre-baked atlas is the correct first step for portability and tier-scaling.** universal-text-pipeline proposed it for eliminating runtime font rasterization; I proposed atlas LOD (512/1024/2048) for tier scaling. Pre-baked atlases at multiple resolutions satisfy both goals simultaneously. Ship as PNG + JSON descriptor. MSDF is a later optimization, not a prerequisite.

8. **MSDF deferred; bitmap atlas is correct for now.** prior-art-lessons showed every shipping GPU text project chose bitmap. universal-text-pipeline's MSDF recommendation is valid for the long-term 3D zoom case, but the pre-baked atlas strategy decouples generation from rendering, making MSDF a build-time swap later. No architecture changes needed now.

9. **Mali-400 lacks `gl_InstanceID`, not instancing entirely.** My Phase 0 overstated this. rendering-backend-portability and data-source-abstraction correctly noted that `ANGLE_instanced_arrays` is available on Mali-400 but does not expose `gl_InstanceID` in the shader. The failure mode is "instanced draws work, but per-instance addressing (picking, highlighting, UV lookup) breaks silently." Detection should check for WebGL 2 / GLSL ES 3.00, not just the instancing extension.

10. **Data-source abstraction layers should be minimal.** prior-art-lessons' xi-editor warning is well-taken. data-source-abstraction's `TextSource` interface alone is justified. `ThrottledSourceBridge` and `SourceUpdateScheduler` should be merged into `SourceBoundGrid` to reduce layering. The throttling/backpressure logic is ~15 lines and always needed.

11. **Picking ID precision ceiling at 2^23.** rendering-backend-portability identified that `vPickingId` is a `float` varying with 23-bit mantissa, silently corrupting IDs above 8,388,608. The fix is `flat out int vPickingId` (GLSL ES 3.00 supports flat integer varyings), giving full 32-bit range. At 10K glyphs per mesh this is 838 meshes before overflow -- adequate but worth hardening.

12. **Worker transferable audit needed.** The outbound `uvMap` from main-to-worker is a plain object (structured clone, not transferable). The return path (worker-to-main) should use `postMessage(result, [buffer1, buffer2, ...])` for zero-copy. The `uvMap` should be cached in the worker after first receipt since it only changes when `ensureGraphemes()` adds new codepoints.

---

## Implementation Plan

This plan focuses on what the device-tier-scaling perspective says should be built: memory reclamation, LOD, device detection, context loss recovery, and the budget system. These are the operational hardening items that make the existing architecture production-viable across the full device spectrum.

### Phase 1: Device Tier Detection (`src/core/DeviceTier.js`) — NEW FILE

The foundation. Everything else in the plan reads from this.

```javascript
/**
 * DeviceTier — runtime GPU capability detection and tier classification.
 *
 * Probes WebGL capabilities at startup, classifies the device into a tier
 * (0-4), and exposes concrete budget limits that the rest of the system
 * reads. Replaces the static PERF_THRESHOLDS.maxInstancesPerMesh = 10000.
 */
export default class DeviceTier {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @returns {DeviceTier}
     */
    static detect(renderer) {
        const gl = renderer.getContext();
        const caps = renderer.capabilities;
        const tier = new DeviceTier();

        tier.isWebGL2 = caps.isWebGL2;
        tier.maxTextureSize = caps.maxTextureSize;
        tier.maxVertexTextures = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
        tier.floatTextureLinear = !!gl.getExtension('OES_texture_float_linear');
        tier.deviceMemoryGB = navigator.deviceMemory || 4; // default mid-range
        tier.hardwareConcurrency = navigator.hardwareConcurrency || 4;

        // Classify
        if (!caps.isWebGL2) {
            tier.level = 0; // No GLSL ES 3.00 = no gl_InstanceID = hard wall
        } else if (tier.deviceMemoryGB <= 2 || tier.maxTextureSize <= 2048) {
            tier.level = 1;
        } else if (tier.deviceMemoryGB <= 4) {
            tier.level = 2;
        } else if (tier.deviceMemoryGB <= 8) {
            tier.level = 3;
        } else {
            tier.level = 4;
        }

        // Budget from tier
        const BUDGETS = [
            { maxInstancesPerMesh: 0,       maxGrids: 0,    atlasSize: 512,  workerCount: 0 },
            { maxInstancesPerMesh: 5000,    maxGrids: 10,   atlasSize: 1024, workerCount: 1 },
            { maxInstancesPerMesh: 10000,   maxGrids: 100,  atlasSize: 2048, workerCount: 2 },
            { maxInstancesPerMesh: 50000,   maxGrids: 500,  atlasSize: 2048, workerCount: 3 },
            { maxInstancesPerMesh: 100000,  maxGrids: 2000, atlasSize: 2048, workerCount: Math.max(1, tier.hardwareConcurrency - 1) },
        ];
        Object.assign(tier, BUDGETS[tier.level]);

        return tier;
    }

    /** @returns {{ maxInstancesPerMesh: number, maxGrids: number, atlasSize: number }} */
    getBudget() {
        return {
            maxInstancesPerMesh: this.maxInstancesPerMesh,
            maxGrids: this.maxGrids,
            atlasSize: this.atlasSize,
            workerCount: this.workerCount,
        };
    }
}
```

**Why**: Every subsequent optimization (LOD thresholds, eviction distances, atlas size, worker pool size) needs a tier classification to parameterize against. This replaces the static `PERF_THRESHOLDS.maxInstancesPerMesh = 10000` in `src/core/constants.js`.

### Phase 2: LOD System in GridVirtualizer (`src/collections/GridVirtualizer.js`) — EDIT

Add LOD bands to the existing `update()` loop. The distance data is already computed.

**Changes to `GridVirtualizer.js`**:

1. Add LOD constants at module level:
```javascript
const LOD_NEAR = 50;   // Full glyph rendering
const LOD_MID = 200;   // Simplified (one quad per line or solid-color quads)
const LOD_FAR = 500;   // Background rectangle only, zero instances
```

2. In the `update()` loop, after computing `entry.distance`, set LOD:
```javascript
// Inside the visible-grid loop, after entry.distance is set:
const lod = entry.distance < LOD_NEAR ? 0
          : entry.distance < LOD_MID  ? 1
          : entry.distance < LOD_FAR  ? 2
          : 3;  // 3 = eviction candidate

if (lod !== entry.lod) {
    entry.lod = lod;
    grid.setLOD(lod);
}
```

3. Add `lod` field to the entry object (default 0).

**Changes to `CodeGrid.js`**:

Add `setLOD(level)` method:
```javascript
/**
 * Set level of detail. Called by GridVirtualizer based on camera distance.
 * @param {number} level - 0=full, 1=simplified, 2=background-only
 */
setLOD(level) {
    if (level === this._lod) return;
    this._lod = level;

    if (level === 0) {
        // Full rendering — show instance mesh, hide background-only
        if (this._collection?._renderer?.instanceMesh) {
            this._collection._renderer.instanceMesh.visible = true;
        }
    } else if (level === 1) {
        // Mid-range — instance mesh still visible but could swap to simplified buffers
        // Phase 2b: build line-averaged color buffers (one quad per line)
        if (this._collection?._renderer?.instanceMesh) {
            this._collection._renderer.instanceMesh.visible = true;
        }
    } else {
        // Far — hide instance mesh, show only background panel
        if (this._collection?._renderer?.instanceMesh) {
            this._collection._renderer.instanceMesh.visible = false;
        }
    }
}
```

LOD level 1 (mid-range simplified buffers) is a later refinement. The immediate win is LOD level 2: `instanceMesh.visible = false` eliminates the draw call entirely while keeping the background panel visible as a colored rectangle. This alone achieves the 80-90% active glyph reduction.

**Why**: This is the single highest-impact optimization identified across all five analyses. It requires zero new abstractions and builds on data already computed every frame.

### Phase 3: Memory Reclamation in GridVirtualizer — EDIT

Add a second distance threshold beyond LOD_FAR for buffer eviction, and a re-load path.

**Changes to `GridVirtualizer.js`**:

```javascript
const EVICT_DISTANCE = 1000;  // Beyond this, dispose GPU buffers entirely
const EVICT_HOLD_MS = 5000;   // Hold for 5s after leaving eviction zone before disposing

// In update(), for grids removed from the scene:
if (!inFrustum && entry.distance > EVICT_DISTANCE) {
    if (!entry.evictTimer) {
        entry.evictTimer = performance.now();
    } else if (performance.now() - entry.evictTimer > EVICT_HOLD_MS) {
        grid.unloadContent();
        entry.evicted = true;
        entry.evictTimer = null;
    }
} else {
    entry.evictTimer = null;
}

// When a previously-evicted grid re-enters the frustum:
if (entry.evicted && inFrustum) {
    grid.reloadContent();  // Re-build buffers from source
    entry.evicted = false;
}
```

**Changes to `CodeGrid.js`**:

Add `unloadContent()` and `reloadContent()`:
```javascript
/**
 * Dispose GPU buffers but retain source content string for re-loading.
 * Called by GridVirtualizer when grid is far off-screen.
 */
unloadContent() {
    if (this._collection) {
        this._collection.dispose();
        this._collection = null;
    }
    this._unloaded = true;
}

/**
 * Re-build GPU buffers from retained source content.
 * Called by GridVirtualizer when an evicted grid re-enters the frustum.
 */
async reloadContent() {
    if (!this._unloaded || !this.content) return;
    this._unloaded = false;
    // Re-create collection and flush
    this._collection = new GlyphCollection(this._scene, this._atlas, this._options);
    this.add(this._collection._renderer.instanceMesh || new THREE.Object3D());
    await this._collection.addText(this.content, 0, 0, 0);
    this._collection.flush();
}
```

**Why**: This is the critical gap that makes the existing architecture viable on Tier 1-2 devices. Without it, 1500 registered grids consume VRAM for all 1500 even though only 10-50 are visible. With eviction, only grids within EVICT_DISTANCE hold buffers. The `content` string is retained in JS heap (cheap) while GPU buffers (expensive) are freed.

### Phase 4: WebGL Context Loss Recovery (`src/GlyphRenderer.js`) — EDIT

**Changes to `GlyphRenderer.js`**:

In the constructor, after the canvas is available:
```javascript
// Context loss handling
this._canvas = renderer.domElement;
this._canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // Allow context restoration
    this._contextLost = true;
});
this._canvas.addEventListener('webglcontextrestored', () => {
    this._contextLost = false;
    this._onContextRestored();
});
```

Add restoration method:
```javascript
/**
 * Reinitialize all GPU resources after WebGL context loss.
 * Textures, buffers, and shaders are all invalid after context loss.
 */
_onContextRestored() {
    // Atlas texture is shared — GlyphAtlas handles its own restoration
    // Recreate per-renderer resources
    if (this._groupTexture) {
        this._groupTexture.dispose();
        this._groupTexture = this._createGroupTexture();
    }
    if (this._highlightTexture) {
        this._highlightTexture.needsUpdate = true;
    }
    // Mark all instance buffers for re-upload
    if (this.instanceMesh) {
        const geom = this.instanceMesh.geometry;
        for (const name of Object.keys(geom.attributes)) {
            geom.attributes[name].needsUpdate = true;
        }
    }
    // Recompile material
    if (this.instanceMesh?.material) {
        this.instanceMesh.material.needsUpdate = true;
    }
}
```

**Changes to `GlyphAtlas.js`**:

Add context loss listener on the shared texture:
```javascript
// In generate() or wherever the canvas is first available:
// After atlas texture creation, mark for re-upload on context restore
this._onContextRestored = () => {
    if (this._threeTexture) {
        this._threeTexture.needsUpdate = true;
    }
};
```

**Why**: On mobile, backgrounding a tab destroys all WebGL state. Without these handlers, the user returns to a black screen with no recovery path. This is a hard production bug on iOS and Android.

### Phase 5: Async Picking API (`src/picking/PickingSystem.js`) — EDIT

Wrap the sync `readPixels` in a Promise to establish the async contract before WebGPU arrives.

```javascript
// Replace the sync readPixels path:
/**
 * @param {number} x - Screen x coordinate
 * @param {number} y - Screen y coordinate
 * @returns {Promise<number>} Picking ID at the given pixel
 */
async readPixelAt(x, y) {
    // Existing render-to-offscreen logic stays the same
    this._renderPickingPass();

    const buf = this._readBuffer;
    this._renderer.readRenderTargetPixels(this._target, x, this._target.height - y, 1, 1, buf);

    const id = (buf[0] << 16) | (buf[1] << 8) | buf[2];
    return id;
}
```

The method already runs only on `needsPick` frames. Making it async changes nothing for current callers (they can `await` trivially) but prevents sync assumptions from spreading into new code.

**Why**: WebGPU requires async readback. Establishing the async contract now means the WebGPU port only needs to change the implementation, not the callers.

### Phase 6: Wire DeviceTier into Existing Entry Points — EDIT

**Changes to `src/core/constants.js`**:

Add a note that `PERF_THRESHOLDS.maxInstancesPerMesh` is a fallback default, overridden at runtime by `DeviceTier`:
```javascript
// Performance thresholds (static defaults — overridden by DeviceTier at runtime)
export const PERF_THRESHOLDS = {
    maxInstancesPerMesh: 10000,  // Split if more instances needed (DeviceTier overrides)
    targetFPS: 60,
    warnRenderTime: 16.67,
    defaultMaxGroups: 64
};
```

**Changes to app entry points** (`app/IDEShell.js` or `app/GitHubRepoViewer.js`):

After renderer creation:
```javascript
import DeviceTier from '../src/core/DeviceTier.js';

// After: const renderer = new THREE.WebGLRenderer(...)
const tier = DeviceTier.detect(renderer);
const budget = tier.getBudget();

// Pass budget to atlas, virtualizer, worker bridge
const atlas = new GlyphAtlas({ atlasSize: budget.atlasSize });
const virtualizer = new GridVirtualizer(scene, camera, { budget: budget.maxGrids });
// WorkerBridge pool size from budget.workerCount
```

**Why**: This is the wiring that makes all the per-tier budgets actually take effect. Without it, Phases 1-5 are dead code.

### File Summary

| File | Action | What Changes |
|---|---|---|
| `src/core/DeviceTier.js` | NEW | Tier detection + budget calculation |
| `src/core/constants.js` | EDIT | Comment noting DeviceTier overrides |
| `src/collections/GridVirtualizer.js` | EDIT | LOD bands + eviction threshold + re-load trigger |
| `src/collections/CodeGrid.js` | EDIT | `setLOD()`, `unloadContent()`, `reloadContent()` |
| `src/GlyphRenderer.js` | EDIT | Context loss/restore handlers |
| `src/GlyphAtlas.js` | EDIT | Context restore for shared texture |
| `src/picking/PickingSystem.js` | EDIT | Async `readPixelAt()` wrapping existing sync path |
| `app/IDEShell.js` | EDIT | Wire DeviceTier into startup |
| `app/GitHubRepoViewer.js` | EDIT | Wire DeviceTier into startup |

### What I Am NOT Building (and why)

- **Canvas 2D / HTML fallback renderers** (Phase 0 Levels 1-2): rendering-backend-portability correctly noted these are entirely separate applications, not degraded versions of the instanced pipeline. They share zero code with the GPU path. If built, they should be separate entry points, not runtime fallbacks. Tier 0 devices get a "your device does not support 3D rendering" message.
- **MSDF atlas pipeline**: Deferred per cross-reference consensus. Pre-baked bitmap at multiple resolutions is the bridge.
- **`FontRasterizer` trait**: prior-art-lessons' proposal for native ports. Not needed for the browser path where Canvas 2D font rasterization works.
- **`GlyphGPU` runtime abstraction**: The 13-function interface is a spec document, not code. Three.js is the browser GPU layer.
- **Data source abstractions** (`TextSource`, `SourceBoundGrid`): data-source-abstraction's domain, not mine. My `reloadContent()` method provides the hook they need.

---

## Implementer Vote

**rendering-backend-portability** should implement.

Reasoning: The implementation plan above is heavy on GPU resource lifecycle management -- context loss recovery, buffer eviction/re-creation, async readback, and per-renderer disposal. These are all changes to the GPU-facing layer of the codebase (`GlyphRenderer.js`, `PickingSystem.js`, `GlyphAtlas.js`). rendering-backend-portability demonstrated the deepest understanding of the actual GPU API surface: they mapped every texture binding, identified the `texelFetch` vs `texture()` distinction, documented the 5-vertex-texture-fetch pattern, and produced the concrete `GlyphGPU` requirements spec. They also identified the WebGPU bind group model change that context loss recovery must anticipate.

The LOD and eviction logic lives in GridVirtualizer (my domain), but the hard parts -- correctly disposing and re-creating `InstancedBufferGeometry`, `DataTexture`, and materials without leaking GPU memory or corrupting shared atlas state -- require the kind of precise GPU API knowledge that rendering-backend-portability showed. Getting `_onContextRestored()` wrong (e.g., re-uploading buffers before the new context has compiled shaders, or disposing the shared atlas texture during per-renderer cleanup) would introduce bugs worse than the ones being fixed.

universal-text-pipeline would be my second choice (they understand the buffer builder contract), but their analysis was more focused on the pipeline stages and less on GPU resource management. data-source-abstraction's strength is the input side, not the GPU side. prior-art-lessons' strength is architectural judgment, not implementation detail.
