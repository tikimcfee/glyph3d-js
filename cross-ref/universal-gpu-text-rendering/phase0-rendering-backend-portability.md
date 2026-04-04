# Phase 0: Rendering Backend Portability Analysis

**Agent**: rendering-backend-portability
**Focus**: What is the minimal GPU contract that glyph3d-js's instanced text rendering pattern actually needs, and how does that map across every major graphics API?

---

## A. The Minimal GPU Contract

Extracted from `src/GlyphRenderer.js`, `src/GlyphAtlas.js`, `src/picking/PickingSystem.js`, and `src/core/InstanceBuffer.js`. Every capability listed below is load-bearing -- the pattern breaks without it.

### 1. Instancing

The entire approach is one draw call per renderer. `GlyphRenderer._createInstanceMesh()` (line 214) creates a `THREE.InstancedBufferGeometry` with a single `PlaneGeometry(1,1)` base quad (4 vertices, 6 indices) and **5 per-instance attributes**:

| Attribute           | Type      | Floats | Purpose                                |
|---------------------|-----------|--------|----------------------------------------|
| `instancePosition`  | vec3      | 3      | World-space glyph origin               |
| `instanceSize`      | vec2      | 2      | Quad scale (width, height)             |
| `instanceCodepoint` | float     | 1      | Atlas map texture lookup key           |
| `instanceColor`     | vec3      | 3      | Per-glyph tint color                   |
| `instanceGroupId`   | float     | 1      | Group transform texture row index      |

**Total: 10 floats = 40 bytes/glyph.** Plus 2 per-vertex attributes from PlaneGeometry (`position` vec3, `uv` vec2) = 7 total vertex attributes. All GPUs since 2008 support 16+. Instance counts reach 10,000 per mesh (`PERF_THRESHOLDS.maxInstancesPerMesh`). `gl_InstanceID` must be accessible in the vertex shader -- used for highlight lookup (line 367-368) and picking ID derivation (`PickingSystem.js` line 55).

### 2. Textures (4 simultaneous bindings, 3 in vertex shader)

| Texture              | Format         | Dimensions               | Filter              | Shader stage | Access pattern            |
|----------------------|----------------|--------------------------|---------------------|-------------|---------------------------|
| **Atlas**            | RGBA8 (canvas) | 2048x2048                | Linear+mipmap, aniso 4 | Fragment | `texture(atlasTexture, vUV)` |
| **Atlas map**        | RGBA32F        | 1024 x ceil(maxId/1024)  | Nearest             | Vertex   | `texture(atlasMapTexture, vec2(tx,ty))` -- codepoint-to-UV |
| **Group transform**  | RGBA32F        | 4 x maxGroups (up to 16K)| Nearest             | Vertex   | 3x `texture()` per vertex for pos/color/scale |
| **Highlight**        | RGBA8          | 1024 x ceil(count/1024)  | Nearest             | Vertex   | `texelFetch(highlightTexture, ivec2(hx,hy), 0)` |

**Hard requirements**: RGBA32F texture sampling (atlas map + group transform), `texelFetch` with integer coordinates (highlight), at least 4 texture units bound simultaneously with 3 usable in vertex shader, minimum 2048x2048 texture dimension.

### 3. Shader Capabilities (GLSL ES 3.00)

From `_getVertexShader()` (line 296) and `_getFragmentShader()` (line 379), plus picking shaders in `PickingSystem.js` (lines 25-124):

- `in`/`out` qualifiers, `texture()`, `texelFetch()`, explicit `out vec4 fragColor`
- `gl_InstanceID` -- integer arithmetic: `gl_InstanceID % 1024`, `gl_InstanceID / 1024` (line 367-368)
- `discard` for alpha testing (line 400)
- `mix()`, `step()`, `clamp()`, `floor()`, `mod()` built-ins
- Picking: 24-bit ID encoding via float arithmetic -- `floor(id / 65536.0)`, `mod()` for RGB decomposition (PickingSystem.js lines 64-68)
- Built-in uniforms: `projectionMatrix`, `modelViewMatrix` (Three.js-provided; bare metal must supply MVP)

### 4. Render Target (Picking)

`PickingSystem._createTarget()` (line 172): offscreen RGBA8 UnsignedByte target at canvas resolution with NearestFilter. Material-swap second render pass -- same scene, swapped pipeline. Synchronous single-pixel readback via `readRenderTargetPixels()` (line 345). Requires: offscreen framebuffer, clear-to-black, and pixel readback (sync or async).

### 5. Buffer Upload Patterns

- **Full upload**: `needsUpdate = true` on `InstancedBufferAttribute`
- **Partial upload**: `addUpdateRange(offset, count)` for surgical updates (`updatePosition()` line 571, `updateColor()` line 602) -- only changed byte range hits GPU
- **Zero-copy worker path**: `applyPrebuiltBuffers()` (line 1329) swaps entire Float32Array backing stores into new InstancedBufferAttribute objects -- no copy
- **Texture updates**: `texture.needsUpdate = true` for full re-upload (highlight texture is small enough; atlas map regrows via `_regrowAtlasMap()` in GlyphAtlas.js line 696)

### 6. Base Geometry

A single `PlaneGeometry(1,1)` -- 4 vertices, 2 triangles, indexed. The simplest possible instanced geometry.

---

## B. Cross-API Mapping

### Feature Support Grid

| Feature | WebGL2 | WebGPU | Metal | Vulkan | GLES3.0 | D3D11 | D3D12 | llvmpipe | SwiftShader |
|---------|--------|--------|-------|--------|---------|-------|-------|----------|-------------|
| Instanced draw | Core | Core | Core | Core | Core | Core | Core | Yes | Yes |
| Attribute divisor | Core | Core | Core | Core | Core | Core | Core | Yes | Yes |
| Vertex texture (3+ units) | 16+ guaranteed | Unlimited | Yes | Yes | 16+ guaranteed | Yes | Yes | Yes | Yes |
| RGBA32F sampling | Core | Core | Core | Core | Core | Core | Core | Yes | Yes |
| texelFetch (int coords) | Core | textureLoad | read() | Core | Core | Load() | Load() | Yes | Yes |
| gl_InstanceID | Core | @builtin(instance_index) | [[instance_id]] | Core | Core | SV_InstanceID | SV_InstanceID | Yes | Yes |
| Offscreen render target | FBO | Texture view | MTLRenderPass | Render pass | FBO | RTV | RTV | Yes | Yes |
| Pixel readback | readPixels (sync) | mapAsync (**async**) | blit+read | copy+map | readPixels (sync) | Map staging | Map readback heap | Yes | Yes |
| Partial buffer update | bufferSubData | writeBuffer(offset) | shared memory | mapped/staging | bufferSubData | Map/UpdateSubresource | placed resources | Yes | Yes |

**Every API can fulfill every requirement.** The only non-trivial adaptation is:

### Per-API Adaptation Notes

**WebGPU**: Pixel readback is async (`mapAsync`). The picking system must become `renderAndRead() -> Promise<pickingId>`. One frame of latency; imperceptible for mouse hover.

**Metal**: Shared memory on Apple Silicon means buffer writes are zero-copy. Texture origin is top-left (matching Canvas 2D), so the V-flip in `GlyphAtlas.getAtlasMapTexture()` (lines 487-489) would be simplified.

**Vulkan**: Pipeline state objects, descriptor sets, render passes, and memory allocation are all explicit. The capabilities are core Vulkan 1.0, but boilerplate is ~3x any other API. `gl_InstanceIndex` starts from `firstInstance` (not 0 like `gl_InstanceID`), requiring awareness when setting `uBasePickingId`.

**D3D11**: Input layout + per-instance step rate replaces `vertexAttribDivisor`. Mechanical HLSL rewrite. Feature set parity with WebGL2.

**D3D12**: Same as Vulkan in verbosity. Root signatures + descriptor heaps replace bind groups. All capabilities are core.

**Software rasterizers (llvmpipe, SwiftShader)**: Feature-complete (implement GLES 3.0 / Vulkan 1.0). Performance is the constraint: 10K instances at 60fps is unlikely on CPU. 1-2K at 10-30fps is realistic. The 5 vertex texture fetches per instance are the bottleneck. Viable for CI/headless testing and screenshot generation, not interactive use.

---

## C. The Thinnest Abstraction Layer

13 functions, scoped to instanced text rendering. No compute, no storage buffers, no multi-pass beyond picking.

```
interface GlyphGPU {
    // Lifecycle
    createPipeline(vertexSrc, fragmentSrc, instanceLayout, bindingLayout) -> Pipeline
    
    // Buffers
    createBuffer(byteSize) -> Buffer
    uploadBuffer(buf, data: Float32Array) -> void
    uploadBufferRange(buf, byteOffset, data: Float32Array) -> void
    
    // Textures
    createTexture(width, height, format: RGBA8|RGBA32F, filter: Nearest|Linear, mipmaps: bool) -> Texture
    uploadTexture(tex, data: TypedArray) -> void
    createBitmapTexture(pixels: ImageData|Canvas, mipmaps: bool) -> Texture   // atlas
    
    // Uniforms
    setUniform(pipeline, name, value: number|Float32Array) -> void
    
    // Drawing
    drawInstanced(pipeline, vertexBuf, instanceBufs[], textures[], instanceCount) -> void
    
    // Render targets (picking)
    createRenderTarget(width, height) -> RenderTarget
    setRenderTarget(target|null) -> void
    clear(r, g, b, a) -> void
    readPixel(target, x, y) -> Promise<Uint8Array>   // async for WebGPU compat
}
```

**Instance layout** (fixed, known at compile time):
```
[ {position, 3, f32}, {size, 2, f32}, {codepoint, 1, f32}, {color, 3, f32}, {groupId, 1, f32} ]
```

**Binding layout** (fixed):
```
textures: [ atlas(RGBA8, linear+mip), atlasMap(RGBA32F, nearest), group(RGBA32F, nearest), highlight(RGBA8, nearest) ]
uniforms: [ groupTextureHeight(f32), atlasMapWidth(f32), atlasMapHeight(f32) ]
picking adds: [ uBasePickingId(f32) ]
```

Compare to wgpu's ~200 entry points. The scoping eliminates 95% of a general GPU abstraction.

**Key design choice**: `readPixel` returns `Promise<Uint8Array>` even on synchronous backends. WebGPU requires async readback; designing sync-first would force a rewrite later.

### Shader Portability

Three options:
1. **GLSL ES 3.00 as canonical + transpile** via Naga/Tint/glslc to SPIR-V, MSL, HLSL, WGSL. This is what wgpu does. **Recommended** -- the shaders already exist.
2. **WGSL as canonical** + Naga to GLSL/SPIR-V/MSL/HLSL. Forward-looking but requires rewrite.
3. **Per-backend source**: Maintain GLSL + WGSL + MSL. Viable because shaders are ~40 lines each. Swift project already has MSL.

---

## D. What Three.js Gives Us vs. Bare Metal

### Load-bearing (must replicate)
- **InstancedBufferGeometry + InstancedBufferAttribute**: VAO creation, divisor setup, `drawElementsInstanced`. ~200 lines on WebGL2 bare, ~500+ on Vulkan.
- **ShaderMaterial with uniforms**: Shader compilation, uniform location caching, texture unit binding, `projectionMatrix`/`modelViewMatrix` injection.
- **DataTexture**: Creates GPU textures from raw TypedArrays. Atlas map regrow (`_regrowAtlasMap`, GlyphAtlas.js line 696) requires texture recreation + data copy on Vulkan/D3D12 (descriptor set update).
- **WebGLRenderTarget + readRenderTargetPixels**: Offscreen FBO for picking. ~30 lines on WebGL2, ~150-300 on Vulkan.
- **CanvasTexture**: Uploads HTML Canvas to GPU. Platform-specific; concept is "upload RGBA bitmap."

### Convenience (can drop)
- **Scene graph** (`scene.add(mesh)`): One mesh per renderer, no hierarchy. Just draw.
- **Mesh/Material objects**: Bundle geometry+material. Replaced by pipeline+buffers.
- **`frustumCulled = false`** (line 280): We do our own culling via GridVirtualizer.
- **Object3D transform hierarchy**: CodeGrid extends Object3D but rendering uses pure instanced attributes.

### Browser-specific (needs platform equivalent)
- **Canvas 2D for atlas** (`ctx.fillText()`, GlyphAtlas.js line 272): Replace with CoreText (macOS/iOS), DirectWrite (Windows), FreeType+HarfBuzz (Linux). ~500-1000 lines per platform. **This is the true portability bottleneck.**
- **requestAnimationFrame**: Platform event loop.
- **DOM events**: Platform input API.

### Bare Metal LOC Estimates

| Component | Three.js | WebGL2 bare | WebGPU bare | Metal bare | Vulkan bare |
|-----------|----------|-------------|-------------|------------|-------------|
| Instance mesh + draw | ~50 | ~200 | ~250 | ~300 | ~600 |
| Shader pipeline | ~80 | ~100 | ~150 (WGSL) | ~200 (MSL) | ~400 (SPIR-V) |
| 4 texture bindings | ~20 | ~100 | ~100 | ~80 | ~300 |
| Picking render target | ~15 | ~80 | ~120 | ~100 | ~300 |
| Buffer updates | ~10 | ~30 | ~30 | ~20 | ~50 |
| **Total** | **~175** | **~510** | **~650** | **~700** | **~1650** |

---

## E. Where the Pattern Breaks

### Hard Walls

1. **No `gl_InstanceID`**: The linchpin. Without it, picking cannot derive per-glyph IDs and highlights cannot be addressed per-glyph, without adding dedicated per-instance attributes (increasing memory by 8+ bytes/glyph). OpenGL ES 2.0 / WebGL 1 lack this. `ANGLE_instanced_arrays` provides instanced draw but NOT `gl_InstanceID` in the shader. **ES 3.0 is the hard floor.**

2. **No vertex texture fetch**: Atlas map, group transform, and highlight lookups all happen in the vertex shader (5 texture samples total). Without vertex texture units, these must become per-instance attributes: +4 floats (UV rect) +12 floats (group pos/color/scale) +3 floats (highlight) = 19 extra floats = 76 bytes/glyph, tripling memory. ES 2.0 allows `MAX_VERTEX_TEXTURE_IMAGE_UNITS == 0`. **ES 3.0 guarantees >= 16.**

3. **No RGBA32F textures**: Atlas map and group textures store 32-bit floats. Without them, UVs must be encoded as fixed-point in RGBA8 (1/256 precision on 2048 texels = ~8 texel error, causing visible shimmer). **Workaround exists but degrades quality.** Core in ES 3.0.

4. **No offscreen render targets**: Picking requires FBO. Without it, CPU raycast against glyph bounding boxes at O(n) per pick. All modern APIs support this.

5. **Texture size < 2048**: Atlas is 2048x2048. All GPUs from ~2008 support this.

### Minimum Viable Hardware

**OpenGL ES 3.0** (2012+), which covers: all iOS from iPhone 5S (2013), all Android from ~2013, all desktop GPUs from ~2008, Intel HD Graphics 2000+ (2011). WebGL 1 / ES 2.0 is a hard wall.

### Async Readback (WebGPU)

The picking system's `readRenderTargetPixels()` is synchronous in WebGL2. WebGPU's `mapAsync` forces the API to become asynchronous. This is a design-level change affecting all callers. The `_needsPick` dirty flag still works, but consumers must tolerate one frame of latency. **The abstraction layer should be async-first** (`readPixel -> Promise`).

### The One Feature That Kills Universality

**`gl_InstanceID` in the vertex shader.** Without it, the derived-ID approach for both picking (`uBasePickingId + gl_InstanceID`) and highlighting (`texelFetch(highlightTexture, ivec2(gl_InstanceID % 1024, gl_InstanceID / 1024), 0)`) collapses entirely. These would revert to per-instance attributes, destroying the memory optimization that makes 10K glyphs viable. ES 2.0 does not expose it. ES 3.0 is the absolute minimum.

### No-GPU Environments

The pattern requires a GPU or GPU emulation. Software rasterizers (llvmpipe, SwiftShader) work for correctness testing at reduced scale. Pure terminal/SSH environments cannot use this rendering path at all -- they would need an entirely separate text output system.
