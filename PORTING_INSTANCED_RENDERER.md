# Porting Plan: Migrating `glyph3d-js` to Vertex-Instanced Rendering

> **Context**: This document specifies the architecture and phased plan to replace the legacy GPU compute-kernel text layout pipeline in `glyph3d-js` with the vertex-instanced rendering architecture proven in `glyph3d-rs` (`crates/glyph-field-instanced`).

---

## 1. Executive Summary & Goals

### The Problem in `glyph3d-js`
The current rendering pipeline in `glyph3d-js` relies on a multi-pass WebGPU compute-shader pipeline (`packages/glyph3d-core/src/compute/*`: `GlyphLayoutCompute`, `GlyphPipelineArena`, `glyphPipelineKernels`, `glyphPipelineScan`).
* **Hardware Fragility**: WebGPU compute fails silently or fatally on systems without full WebGPU support (including Linux browsers operating on WebGL2 fallback).
* **Architectural Complexity**: The compute arena requires complex sub-allocation, multi-pass prefix sums, slot leakage guards, and device-loss reload loops.
* **Hostility to External Integration**: Embedding `glyph3d-js` into other Three.js projects (e.g. `procinsh` process space visualization) is fraught because external apps cannot easily initialize and share the monolithic compute arena.

### The Solution: Vertex-Instanced Field (Proven in `glyph3d-rs`)
In `glyph3d-rs` (`crates/glyph-field-instanced`), the system abandoned GPU compute for text parsing and layout. Instead:
1. **CPU / Worker Layout**: Text layout and shaping are computed in JavaScript / Web Worker using HarfBuzz and font metrics.
2. **Compact 32-Byte Slot Record**: Emitted directly as an array of 32-byte `RenderSlot` instances.
3. **Vertex-Level Positioning**: The vertex shader in WGSL/TSL evaluates pen anchor, quad expansion, advance, height, and group TRS transform.
4. **Analytic Slug Fragment Coverage**: Evaluates quadratic bezier curves and color emoji sheets with zero compute overhead.
5. **Universal Compatibility**: Renders identically in **both WebGPU (storage buffers) and WebGL2 (instanced vertex attributes)** using standard Three.js primitives.

---

## 2. Core Data Layout: The 32-Byte `RenderSlot`

Directly mirror `glyph3d-rs/crates/glyph-field-instanced/src/slot.rs` and `glyph_field.wgsl`:

```
Offset (Bytes)  Type      Field       Description
0..11           vec3<f32> pos         World-space pen origin (left edge, cell-vertical center)
12..15          u32       glyph_id    FontChain global glyph slot (keys glyphmap texture)
16..19          u32       color       Packed RGBA8 (sRGB display color)
20..23          u32       group_id    Index into group table (pose/clipping/alpha)
24..27          f32       advance     Cell advance / width in world units
28..31          f32       height      Cell height in world units
-----------------------------------------------------------------------------------------
Total Stride: 32 Bytes (8 x 4-byte lanes)
```

### Binary Buffer Representation in JS
A single buffer can be viewed simultaneously as:
```javascript
const buffer = new ArrayBuffer(slotCount * 32);
const f32 = new Float32Array(buffer);
const u32 = new Uint32Array(buffer);

// For slot i:
// Lane 0..2 (f32): pos.x, pos.y, pos.z
f32[i * 8 + 0] = x;
f32[i * 8 + 1] = y;
f32[i * 8 + 2] = z;
// Lane 3 (u32): glyph_id
u32[i * 8 + 3] = glyphId;
// Lane 4 (u32): packed color (r | (g << 8) | (b << 16) | (a << 24))
u32[i * 8 + 4] = packedColor;
// Lane 5 (u32): group_id
u32[i * 8 + 5] = groupId;
// Lane 6..7 (f32): advance, height
f32[i * 8 + 6] = advance;
f32[i * 8 + 7] = height;
```

---

## 3. Shader Pipeline: Porting `glyph_field.wgsl`

Reference implementation: `/home/ivan/dev/glyph3d-rs/crates/glyph-field-instanced/shaders/glyph_field.wgsl`.

### Vertex Stage
Given quad corner indices (6 vertices per quad: `0, 1, 2, 2, 3, 0` or unit quad `[-0.5..0.5, 0..1]`):
1. **Local Quad Expansion**:
   ```wgsl
   let local_x = corner.x * slot.advance;
   let local_y = corner.y * slot.height;
   let p_local = vec3<f32>(local_x, local_y, 0.0) + slot.pos;
   ```
2. **Group Transform & Clipping**:
   - Sample row `slot.group_id` from the group table (`GROUP_STRIDE = 6` vec4s).
   - Apply group matrix (TRS), check group bounding box / clipping planes, modulate group alpha.
3. **Camera Projection**:
   ```wgsl
   output.position = camera.view_proj * p_world;
   output.uv = quad_uv;
   output.glyph_id = slot.glyph_id;
   output.color = unpack_rgba(slot.color);
   ```

### Fragment Stage
1. **Glyph Map Lookup**:
   - `glyphmap` texture (`Rgba32Uint`) at texel `output.glyph_id` yields `[curveStart, curveCount, mode, emojiCell]`.
2. **Branching**:
   - `mode == 0`: Outline glyph → evaluate Slug quadratic beziers from `curves` texture (`Rgba32Uint`) using winding-number ray coverage.
   - `mode == 1`: Color emoji → sample `emoji` texture array.
3. **Color Blending**: Premultiplied alpha blend into output.

---

## 4. Components to Deprecate & Remove

Once the instanced path is established, the following can be completely deprecated and removed from `packages/glyph3d-core`:

| Directory / File | Reason for Deprecation |
|---|---|
| `src/compute/GlyphLayoutCompute.js` | WebGPU compute layout dispatch |
| `src/compute/GlyphPipelineArena.js` | Storage buffer arena management |
| `src/compute/glyphPipelineKernels.js`| Multi-pass compute WGSL shaders |
| `src/compute/glyphPipelineScan.js`   | GPU prefix sum scanner |
| `src/compute/glyphBake.js`           | Pre-bake GPU measurement pipelines |
| `src/compute/glyphPipelineWindow.js` | Arena window staging |
| `src/MegaGlyphField.js`              | Arena-backed mega field |
| `src/core/ByteLayoutDescription.js`  | Byte-level GPU layout descriptors |

---

## 5. Work Breakdown for Agent Fleet

### Fleet Workstreams

#### Subagent 1: Data Buffer & CPU Layout Generator (Flash / Pro)
* **Goal**: Implement `InstancedSlotBuffer.js` and `LayoutGenerator.js`.
* **Inputs**: Text string / lines, font metrics, `FontChain` / `MonospaceShapeCache`.
* **Outputs**: `ArrayBuffer` structured as 32-byte `RenderSlot` arrays.
* **Requirements**:
  * High-speed allocation and pooling.
  * Fast string/line scan computing `pos.x` advancing by font advance, `pos.y` stepping line pitch.
  * Pack colors as `u32` (little-endian RGBA).

#### Subagent 2: Three.js Instanced Field Shader & Material (Pro)
* **Goal**: Port `glyph_field.wgsl` into a Three.js material that runs in `three/webgpu` (TSL / WGSL) and can bind instanced attributes in standard WebGL2 fallback.
* **Key files to inspect**:
  * `/home/ivan/dev/glyph3d-rs/crates/glyph-field-instanced/shaders/glyph_field.wgsl`
  * `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/GlyphField.js`
* **Requirements**:
  * Use Slug curve textures and `glyphmap` currently managed by `GlyphAtlas` / `FontChain`.
  * Support `group` table lookups for grid TRS transforms.

#### Subagent 3: `InstancedField` Class Implementation (Flash / Pro)
* **Goal**: Create `packages/glyph3d-core/src/collections/InstancedField.js` mirroring `glyph3d-rs/crates/glyph-field-instanced/src/field.rs`.
* **Requirements**:
  * Manages `InstancedBufferGeometry` / storage buffer.
  * Supports partial uploads when editing or paging text.
  * Manages Three.js mesh instances and bounds calculation.

#### Subagent 4: Rewire `CodeGrid` & Paging (Pro)
* **Goal**: Update `packages/glyph3d-core/src/collections/CodeGrid.js` to use `InstancedField`.
* **Requirements**:
  * Remove all references to `getPipelineArena()`, `_pipeline`, and `MegaGlyphField`.
  * `CodeGrid.loadText(text)` routes directly to `LayoutGenerator` → uploads to `InstancedField`.
  * Keep `setWindow(cols, rows)`, `highlightRange()`, and `decorateMemoryGrid()` functional.

---

## 6. Reference Code Paths

### Rust Source of Truth (`glyph3d-rs`)
* Slot definition: `/home/ivan/dev/glyph3d-rs/crates/glyph-field-instanced/src/slot.rs`
* Field renderer: `/home/ivan/dev/glyph3d-rs/crates/glyph-field-instanced/src/field.rs`
* Upload transcode: `/home/ivan/dev/glyph3d-rs/crates/glyph-field-instanced/src/upload.rs`
* WGSL Shader: `/home/ivan/dev/glyph3d-rs/crates/glyph-field-instanced/shaders/glyph_field.wgsl`

### JavaScript Targets (`glyph3d-js`)
* Atlas & Font handles: `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/GlyphAtlas.js`
* Shaper & Cache: `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/shaping/`
* Grids: `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/collections/CodeGrid.js`
* Memory View helpers: `/home/ivan/dev/glyph3d-js/packages/glyph3d-core/src/memory/`

---

## 7. Verification Milestones

1. **Unit Test**: Transcoder test verifying 32-byte alignment, lane offsets, and packed colors.
2. **Visual Verification**: Run `tools/dev.sh` or standalone test page rendering a single `CodeGrid` using `InstancedField` on both Chrome (WebGPU) and Firefox / WebGL2.
3. **Memory View Test**: Run `mem.view` command in the IDE and verify byte color accents and pointer edges render atop the new instanced field.
4. **Integration Test**: Import `@glyph3d/core` into `procinsh` WebGL2 canvas and render a floating memory inspection grid.
