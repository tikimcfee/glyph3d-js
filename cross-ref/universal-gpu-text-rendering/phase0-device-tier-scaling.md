# Phase 0: Device Tier Scaling Analysis

**Agent**: device-tier-scaling
**Focus**: How does the glyph3d-js instanced rendering pattern scale across the full spectrum of devices, and what are the graceful degradation paths?

---

## A. Memory Budget Analysis

### Per-Glyph Cost Breakdown (actual from codebase)

Instance attributes per glyph (5 InstancedBufferAttributes):
- `instancePosition`: 3 floats = 12 bytes
- `instanceSize`: 2 floats = 8 bytes
- `instanceCodepoint`: 1 float = 4 bytes
- `instanceColor`: 3 floats = 12 bytes
- `instanceGroupId`: 1 float = 4 bytes

**Total per glyph: 10 floats = 40 bytes** (GPU-side InstancedBufferAttribute data)

Plus per-glyph overhead:
- Highlight texture: 4 bytes RGBA8 per glyph (1024-wide 2D DataTexture)
- No picking attribute (derived as `uBasePickingId + gl_InstanceID`)

**Effective per-glyph: 44 bytes**

### Fixed Overhead (per GlyphRenderer instance)

| Resource | Size | Notes |
|---|---|---|
| Atlas canvas texture | 2048x2048 RGBA = 16 MB | + mipmaps ~5.3 MB = ~21.3 MB total |
| Atlas map DataTexture | 1024 x ~10 rows, Float RGBA = ~160 KB | GPU codepoint->UV lookup |
| Group DataTexture | 4 x maxGroups, Float RGBA = 64 groups x 64 bytes = 4 KB | Transform/color per group |
| Base PlaneGeometry | ~200 bytes | Shared quad (4 verts, 6 indices) |
| Picking render target | canvas_width x canvas_height x 4 bytes | e.g., 1920x1080 = ~8.3 MB |

**Fixed overhead per renderer: ~22 MB** (dominated by the atlas texture + mipmaps)

CodeGrid instances share a single atlas (via `getSharedThreeTexture`), so the atlas cost is amortized across all grids. Each CodeGrid gets its own GlyphRenderer, however, so group textures and highlight textures are per-grid.

### Glyph Capacity by GPU Memory Budget

Using 44 bytes/glyph for the variable portion, and assuming the atlas is shared (one-time 22 MB):

| GPU Budget | Available for Glyphs | Max Glyphs | Source Files (8000 glyphs each) |
|---|---|---|---|
| 64 MB | 42 MB | 954,545 | ~119 files |
| 256 MB | 234 MB | 5,318,181 | ~664 files |
| 512 MB | 490 MB | 11,136,363 | ~1,392 files |
| 1 GB | 1002 MB | 22,772,727 | ~2,846 files |
| 4 GB | 4074 MB | 92,590,909 | ~11,573 files |

**Key qualifier**: these are theoretical maximums. Real GPU memory is shared with the OS compositor, browser compositor, other tabs, Three.js internal state (shader compilation, FBO management), etc. A practical rule: assume **50% usable** for glyph data.

Practical adjusted capacity:

| GPU Budget | Practical Glyphs | Practical Files |
|---|---|---|
| 64 MB | ~477K | ~59 |
| 256 MB | ~2.6M | ~332 |
| 512 MB | ~5.5M | ~696 |
| 1 GB | ~11.3M | ~1,423 |
| 4 GB | ~46M | ~5,786 |

### Total Memory Footprint Formula

```
Total = AtlasTexture(21.3 MB, shared)
      + PickingTarget(W * H * 4)
      + SUM_per_grid(
            N_glyphs * 44 bytes              // instance + highlight
          + GroupTexture(maxGroups * 64)       // typically 4 KB
          + HighlightTexture(ceil(N/1024)*1024*4)  // RGBA8 overhead from 1024-wide rounding
        )
```

### What GridVirtualizer Actually Saves

GridVirtualizer eliminates draw calls, not memory. All registered grids keep their GPU buffers allocated. At 1500 grids, frustum culling drops active grids from 1500 to ~10-50, but all 1500 grids' vertex buffers remain in VRAM. This is a critical distinction for memory-constrained devices: **culling helps frame time, not memory pressure**.

To reclaim memory, you would need `unloadContent()` on off-screen grids (mentioned in GridVirtualizer comments but not currently implemented as a pairing).

---

## B. Device Tier Classification

### Tier 0: No GPU / Software Rasterizer (SwiftShader, llvmpipe)

- **Max glyphs**: ~5,000 (single grid)
- **Atlas**: 512x512 (ASCII only, ~1 MB)
- **Instancing**: Works (SwiftShader supports WebGL 2) but at ~2-5 FPS
- **Expected FPS**: 2-5 FPS for any meaningful content
- **Verdict**: Technically functional, practically unusable. This tier should trigger a fallback.

### Tier 1: Low-End Mobile (Adreno 306, Mali-400, 512MB shared RAM)

- **GPU memory**: ~50-100 MB usable (shared with system)
- **Max texture**: 2048x2048 (atlas fits, barely)
- **Max glyphs**: ~50,000 (atlas + instance data fits in ~25 MB)
- **Max files**: ~6 at 8000 glyphs each
- **Instancing**: WebGL 1 with `ANGLE_instanced_arrays` extension (Mali-400 does NOT support this)
- **Float textures**: OES_texture_float may be absent (atlas map DataTexture fails)
- **Expected FPS**: 15-30 at 50K glyphs, dropping fast with overdraw
- **Hard walls**: Mali-400 lacks instancing entirely. Adreno 306 has it but struggles past 10K instances.

### Tier 2: Mid-Range Mobile / Old Laptops (Adreno 6xx, Intel HD 4000, 2-4GB RAM)

- **GPU memory**: 256-512 MB (Intel HD shares system RAM; Adreno has ~1GB shared)
- **Max texture**: 4096x4096
- **Max glyphs**: 200,000-500,000
- **Max files**: 25-62
- **Instancing**: WebGL 2 native (GLSL ES 3.00 -- matches current shaders)
- **Float textures**: Supported (atlas map DataTexture works)
- **Expected FPS**: 30-60 at 200K, 15-30 at 500K
- **Picking**: Works but readPixels stall is expensive (~2-5ms on these GPUs). Already mitigated by `needsPick` dirty flag.

### Tier 3: Modern Mobile / Chromebooks (Apple A14+, Snapdragon 8 Gen 1, 4-8GB)

- **GPU memory**: 1-2 GB effective
- **Max texture**: 8192x8192 (though 2048 atlas is sufficient)
- **Max glyphs**: 2,000,000-5,000,000
- **Max files**: 250-625
- **Instancing**: Full WebGL 2 with good driver quality
- **Float textures**: Full support, including half-float render targets
- **Expected FPS**: 60 at 1M glyphs, 30-60 at 5M
- **Workers**: 4-8 cores available; worker pool is effective here

### Tier 4: Desktop (Discrete GPU, 8GB+ VRAM)

- **GPU memory**: 4-24 GB dedicated
- **Max texture**: 16384x16384
- **Max glyphs**: 20,000,000+ (entire large codebase)
- **Max files**: 2,500+
- **Instancing**: Perfect. Single draw call for 10K instances is trivial.
- **Expected FPS**: 60 at 10M+ glyphs, limited by JavaScript/CPU first
- **Workers**: 8-32 cores; worker pool maximally effective
- **Bottleneck shifts**: At this tier, the bottleneck is CPU-side buffer building, not GPU rendering.

---

## C. GPU Capability Hard Walls

### 1. Instancing (`ANGLE_instanced_arrays` / native WebGL 2)

**Current dependency**: Absolute. The entire rendering pipeline is `InstancedBufferGeometry` with 5 per-instance attributes. There is no fallback.

**If missing**: The renderer produces zero visible output. Mali-400 and some Intel GMA 3150 chips have no instancing support whatsoever. This affects ~2% of global WebGL traffic (declining).

**Fallback cost**: Without instancing, you would need one draw call per glyph (N draw calls instead of 1). At 10,000 glyphs, that means 10,000 draw calls per frame. WebGL overhead per draw call is ~0.05-0.1ms, so 10K calls = 500-1000ms per frame. This is fundamentally broken, not merely slow. The only viable non-instancing path is a completely different rendering approach (2D canvas, HTML DOM).

### 2. Texture Size Limits

**Current atlas**: 2048x2048 (set in `GlyphAtlas` constructor). This is within the WebGL 1 minimum guaranteed maximum (2048). Safe.

**Atlas map DataTexture**: 1024 wide, ~10 rows tall. No issue anywhere.

**If max texture is 2048**: Current code works without modification. The atlas is already 2048. If you wanted a 4096 atlas for higher-resolution glyphs, you would need to detect the limit and fall back.

**Highlight texture**: 1024 wide, height = ceil(instanceCount/1024). At 100K glyphs, that is 1024x98 -- well within limits.

### 3. Float Textures (`OES_texture_float`)

**Current dependency**: Yes. The atlas map DataTexture is `THREE.FloatType` (RGBA Float32). The group DataTexture is also Float32.

**If unavailable**: `getAtlasMapTexture()` fails silently -- the DataTexture creation may succeed but sampling returns garbage. The vertex shader's UV lookup (`texture(atlasMapTexture, ...)`) produces wrong UVs, rendering visual corruption (glyphs mapped to wrong atlas regions).

**Mitigation**: The atlas map stores UV coordinates in [0,1] range. These could be encoded as RGBA8 with 8 bits per channel (256 levels of precision for UV). At 2048 atlas size, that gives 2048/256 = 8-pixel UV resolution -- too coarse, visible seams. A half-float path (`OES_texture_half_float`) provides 10-bit mantissa = 1024 levels -- marginal but workable. Half-float support is far more widespread than full float.

### 4. Offscreen Render Targets (Picking)

**Current dependency**: PickingSystem creates a `WebGLRenderTarget` at canvas resolution. If `readPixels` fails or render targets are unsupported, picking breaks.

**If unavailable**: Picking is an enhancement, not a rendering requirement. The 3D text still renders. Fallback: raycasting against bounding boxes (coarse, per-grid not per-glyph), or disable picking entirely.

**Practical reality**: `WebGLRenderTarget` works on virtually every device that supports WebGL 1+. The real issue is `readPixels` latency: on mobile GPUs this forces a pipeline stall. The `needsPick` dirty flag already mitigates this.

### 5. `addUpdateRange` (Partial Buffer Uploads)

**Current usage**: `GlyphRenderer.updatePosition()` and `updateColor()` use `addUpdateRange()` on InstancedBufferAttributes for partial GPU uploads.

**If unavailable**: Three.js falls back to uploading the entire attribute buffer (`needsUpdate = true`). For a 10K-glyph mesh, uploading all 40KB of position data instead of just the changed 12 bytes is wasteful but not catastrophic. The cost is proportional to buffer size, not glyph count.

**Practical reality**: `addUpdateRange` is a Three.js abstraction over `bufferSubData`. `bufferSubData` is WebGL 1 baseline -- always available. This is not a hard wall.

---

## D. Scaling Strategies

### 1. LOD for Text

Three distance bands based on camera distance to grid:

| Distance | Rendering | Cost |
|---|---|---|
| Near (< 50 units) | Full glyph rendering, all attributes | 44 bytes/glyph |
| Mid (50-200 units) | Solid colored quads (skip atlas sampling). Set `instanceCodepoint` to a solid-fill glyph, collapse per-glyph colors to line-average color. Reduce instance count by rendering one quad per line instead of per character. | ~0.5% of full cost |
| Far (> 200 units) | Single colored rectangle per grid (the existing background panel). Zero instances. | Effectively free |

**Implementation path**: GridVirtualizer already knows distance-to-camera per grid (the `entry.distance` field). Add a `setLOD(level)` method to CodeGrid that swaps between full buffers, simplified buffers, and hidden-mesh-with-background-only.

### 2. Progressive Loading

The existing pattern already supports this: `buildBatchBuffers` is called per-grid, and `applyPrebuiltBuffers` is per-grid. The missing piece is **load ordering**.

Strategy: sort grids by distance from camera before building their buffers. Build nearest grids first. Use `requestIdleCallback` or manual frame-budget checking to spread loading across frames. The GridVirtualizer's frustum check can gate which grids get their buffers built at all.

### 3. Dynamic Instance Budget

Detect device tier at startup via GPU capability probing:
```
renderer.capabilities.maxTextureSize  -> atlas size limit
renderer.capabilities.isWebGL2        -> instancing native vs extension
navigator.hardwareConcurrency         -> worker pool size
navigator.deviceMemory                -> rough RAM tier (4 = mid, 8+ = desktop)
performance.memory?.jsHeapSizeLimit   -> Chrome-only JS heap cap
```

Map to concrete limits:
- Tier 1: maxInstancesPerMesh = 5,000, maxGrids = 10, atlas = 1024
- Tier 2: maxInstancesPerMesh = 10,000, maxGrids = 100, atlas = 2048
- Tier 3: maxInstancesPerMesh = 50,000, maxGrids = 500, atlas = 2048
- Tier 4: maxInstancesPerMesh = 100,000, maxGrids = 2000, atlas = 2048

These would replace the static `PERF_THRESHOLDS.maxInstancesPerMesh = 10000`.

### 4. Atlas LOD

Current atlas is 2048x2048 at 48px font size. For devices that cannot afford 21.3 MB of texture:
- **1024x1024 at 24px**: 4 MB + mipmaps ~1.3 MB = ~5.3 MB. ASCII-only charset (~95 glyphs) fits easily. Legible at typical code-viewing distance.
- **512x512 at 16px**: ~1 MB total. Only ASCII. Blurry up close but readable for Tier 1.

The atlas size is already a constructor parameter (`atlasSize = 2048`). This is a clean scaling knob.

### 5. Temporal Spreading (Frame Budget)

Current `buildBatchBuffers` is synchronous and blocks the main thread (or a worker) for the entire batch. For a 500-line file (~4000 glyphs), this is ~1-2ms on desktop but could be 10-20ms on mobile.

Strategy: split `buildBatchBuffers` into chunks of N glyphs (e.g., 2000), yield between chunks via `requestAnimationFrame` or `setTimeout(0)`. Display partial results as they complete. The worker path already handles this naturally (workers don't block the main thread), but the main-thread fallback path does not.

Concrete budget: 8ms per frame (half of 16.67ms at 60fps). If buffer building exceeds 8ms, yield.

---

## E. The Graceful Degradation Ladder

### Level 4: Full 3D Instanced (current)
- All features: instanced rendering, GPU picking, highlight texture, worker offload
- **Trigger to enter**: Device supports WebGL 2 + float textures + sufficient VRAM
- **Recovery**: Always try this first

### Level 3: Reduced Instance Count
- Same rendering path, but cap total glyphs at device-tier limit
- LOD applied: distant grids rendered as colored rectangles, not glyph instances
- Atlas downscaled to 1024 if needed
- Picking disabled or reduced to per-grid (not per-glyph)
- **Trigger**: FPS drops below 30 for 3 consecutive seconds, or `navigator.deviceMemory < 4`
- **Recovery up**: If FPS recovers above 50 for 5 seconds, try increasing instance budget by 20%

### Level 2: 2D Canvas Fallback
- Abandon Three.js entirely. Render text to a 2D `<canvas>` with standard `fillText`.
- Navigation becomes 2D pan/zoom instead of 3D camera.
- Preserve the grid layout concept (files as rectangles in a 2D space).
- No instancing, no shaders, no WebGL.
- **Trigger**: WebGL context creation fails, or instancing is completely unsupported, or FPS stays below 10
- **Recovery up**: Not practical (would require re-initializing the entire WebGL pipeline)

### Level 1: Plain HTML Text
- Render source files as `<pre>` elements with syntax highlighting via CSS classes.
- Scroll-based navigation. No spatial layout.
- **Trigger**: Canvas 2D also too slow (extremely old device), or user preference
- **Recovery up**: N/A

### Transition Mechanism

The degradation ladder should be a state machine with hysteresis. Measuring FPS over a 3-second window prevents jitter-triggered transitions. Upward recovery is gated harder (5 seconds of sustained headroom) to prevent oscillation.

Current codebase has no fallback mechanism at all. The entire app assumes WebGL 2 with full float texture support. Implementing even Level 3 (reduced instance count with dynamic budgeting) would cover 95%+ of the device spectrum.

---

## F. Hard Walls (Where the Pattern Cannot Work)

1. **No instancing at all** (Mali-400, Intel GMA 3150, some embedded/kiosk WebGL implementations): The InstancedBufferGeometry path is the only path. There is no per-glyph draw call fallback and should not be one -- it would be ~1000x slower. These devices must skip to Level 2 (canvas) or Level 1 (HTML).

2. **No WebGL** (~3% of global web traffic, mostly older iOS WebViews, some enterprise locked browsers): Skip directly to Level 1.

3. **WebGL context lost during operation**: Three.js fires a `webglcontextlost` event. Currently unhandled in glyph3d-js. On mobile, context loss happens when the OS reclaims GPU memory (backgrounding the tab, memory pressure). The entire rendering state is destroyed. Recovery requires full reinitialization of all textures, buffers, and shaders.

4. **16MB texture upload limit on iOS Safari**: iOS Safari silently fails or crashes when uploading textures larger than 16MB. The 2048x2048 RGBA atlas is exactly 16MB before mipmaps. Mipmapped upload may exceed this. Mitigation: use `premultipliedAlpha: false` and disable mipmaps on iOS, or drop to 1024 atlas.

5. **readPixels sync stall on mobile**: `readPixels` is synchronous and stalls the entire GPU pipeline. On some Qualcomm drivers, a single `readPixels` costs 5-15ms. The picking system's `needsPick` dirty flag helps (only reads on mouse move), but on touch devices with continuous finger tracking, this becomes per-touch-frame overhead. Mitigation: throttle picks to every 3rd frame on mobile, or use async readback (`getBufferSubData` with fence, not yet in the codebase).

6. **JavaScript heap exhaustion**: The worker path transfers Float32Arrays via structured clone (not transferable in all browsers). For 1M glyphs, the position buffer alone is 12MB. Cloning this doubles memory momentarily. On a 2GB-RAM mobile device with 512MB JS heap, this is a real limit. The `applyPrebuiltBuffers` path does accept the arrays directly (zero-copy via `new InstancedBufferAttribute(positions, 3)`), but the worker-to-main transfer is the bottleneck.

---

## Summary

The current codebase is implicitly Tier 3-4. It works well on modern mobile and desktop. The main gaps:

1. **No device detection or adaptive budgeting** -- `maxInstancesPerMesh = 10000` is static.
2. **No LOD** -- every visible grid renders all glyphs at full fidelity regardless of distance.
3. **No memory reclamation** -- GridVirtualizer culls draw calls but not VRAM.
4. **No fallback chain** -- if WebGL 2 fails, the app shows nothing.
5. **No context loss handling** -- a background/foreground cycle on mobile destroys state silently.

The highest-impact single change would be distance-based LOD in GridVirtualizer: switch distant grids to single-quad representation. This alone would cut active glyph count by 80-90% at typical camera positions, making the existing pipeline viable on Tier 2 devices without changing the rendering architecture.
