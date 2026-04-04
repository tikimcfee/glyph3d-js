# Phase 0: Universal Text Pipeline Analysis

**Agent**: universal-text-pipeline
**Scope**: What's portable, what's coupled, and what's the minimal interface between text processing and GPU submission.

---

## 1. The Buffer Contract (The Universal Seam)

The handoff between "text processing" and "GPU rendering" is already nearly clean. `buildBatchBuffers()` in `src/workers/builders/index.js` produces this exact output:

```
Per glyph (11 floats = 44 bytes):
  positions:  Float32Array  [x, y, z]          3 floats
  sizes:      Float32Array  [width, height]     2 floats
  codepoints: Float32Array  [numericId]         1 float
  colors:     Float32Array  [r, g, b]           3 floats
  groupIds:   Float32Array  [groupId]           1 float

Batch metadata:
  count:      number
  bounds:     {min: {x,y,z}, max: {x,y,z}, width, height, depth} | null
  itemMeta:   [{bufferStartIndex, glyphCount, bounds, lineSlotOffsets}]
```

This is the universal seam. Any platform that can produce these six typed arrays plus metadata can drive any GPU backend. The `codepoints` array stores numeric atlas-texture IDs (not UV coordinates) -- the vertex shader resolves them via a `texelFetch` into the atlas map DataTexture. This is a critical design choice: the buffer contract carries opaque glyph IDs, not rendering-specific UV data.

**Proposed formal interface** (platform-independent):

```
GlyphBufferSet {
  positions:  Float32Array   // 3 * count
  sizes:      Float32Array   // 2 * count
  glyphIds:   Float32Array   // 1 * count (renamed from 'codepoints' for clarity)
  colors:     Float32Array   // 3 * count
  groupIds:   Float32Array   // 1 * count
  count:      u32
  bounds:     AABB | null
  items:      ItemMeta[]     // per-text-entry bookkeeping
}

AtlasDescriptor {
  atlasImage:    OpaqueImageHandle   // platform-specific (Canvas, ImageBitmap, raw RGBA bytes)
  uvMap:         Map<glyphId, {u0, v0, u1, v1}>  // atlas map as flat data
  mapWidth:      u32                 // DataTexture width (currently 1024)
  mapHeight:     u32                 // DataTexture height (grows with charset)
  metrics:       Map<grapheme, {width, height, advance}>
  graphemeToId:  Map<string, u32>    // grapheme cluster -> numeric ID
}
```

Any renderer receives a `GlyphBufferSet` + `AtlasDescriptor` and does platform-specific GPU upload. No other data crosses the boundary.

---

## 2. Pipeline Stage Audit

### Stage 1: Text Segmentation -- PURE PORTABLE

**File**: `src/utils/grapheme.js`
**Platform deps**: `Intl.Segmenter` (Baseline 2024, available in all modern JS runtimes including Workers)
**Fallback**: `codePointAt()` iteration (handles surrogates, not ZWJ)

This is fully portable. The abstract contract is: `string -> Iterator<grapheme_cluster_string>`. Every platform has an equivalent:
- Rust: `unicode-segmentation` crate (`grapheme_clusters()`)
- Swift: `String.unicodeScalars` / `Character` (grapheme clusters by default)
- C/C++: ICU `BreakIterator` or `utf8proc`

No changes needed. Already clean.

### Stage 2: Layout -- PURE PORTABLE

**File**: `src/workers/builders/index.js` (inline in `buildBatchBuffers`, lines 329-416)
**Platform deps**: None. Pure arithmetic over grapheme stream.

The layout pass iterates graphemes, tracks cursor (x, y, z), handles newlines, Z-depth wrapping, and page-break pagination. All inputs are numeric metrics. All outputs are positions in the Float32Array. The only dependency is `iterGraphemes()` from Stage 1.

**Contract**: `(text, startPos, metrics, glyphWidths) -> positions[]`

The older standalone `layoutText()` (`src/workers/builders/layoutText.js`) uses the same pattern but a separate code path. The canonical path is the integrated single-pass in `buildBatchBuffers` which avoids intermediate allocations. This integrated version is the one to port.

### Stage 3: Atlas Lookup / ID Resolution -- PURE PORTABLE (data), PLATFORM-COUPLED (generation)

Two distinct operations here:

**3a. ID resolution during buffer build** (pure portable): Given a grapheme string, look up its numeric ID from a serialized `uvMap` object. This is a hash map lookup. No platform deps. The `uvMap` is `{grapheme_string: {u0, v0, u1, v1, numericId}}` -- a plain object passed to workers via structured clone. Only the `numericId` field is written to buffers; UV coordinates are resolved on-GPU.

**3b. Atlas generation** (platform-coupled -- see Section 3 below).

### Stage 4: Buffer Construction -- PURE PORTABLE

**File**: `src/workers/builders/index.js` (`buildBatchBuffers`)
**Platform deps**: None. Allocates Float32Arrays, fills them in a single pass.

This is the heart of the pipeline and it is entirely platform-independent. It runs in Web Workers today. The only inputs are: text string, position, metrics object, serialized uvMap, glyphWidths map, color, scale. All plain data. All outputs are typed arrays.

The function already runs in a non-DOM, non-WebGL context (Web Worker). Porting to Rust/C/Swift means translating ~170 lines of straight-line arithmetic.

### Stage 5: GPU Upload -- DEEPLY COUPLED (by design)

**File**: `src/GlyphRenderer.js` (`applyPrebuiltBuffers`, lines 1329-1430)
**Platform deps**: Three.js `InstancedBufferAttribute`, `DataTexture`, `ShaderMaterial`, GLSL shaders

This is the only stage that should be platform-specific. `applyPrebuiltBuffers()` takes the exact `GlyphBufferSet` output and:
1. Creates `InstancedBufferAttribute` objects from the Float32Arrays (zero-copy swap)
2. Sets `geometry.instanceCount = count`
3. Sizes the highlight DataTexture

The Three.js specifics here are thin wrappers around WebGL calls. The equivalent on other platforms:
- **Metal**: `MTLBuffer` from `Float32Array` bytes, set as vertex buffer on `MTLRenderCommandEncoder`
- **Vulkan**: `VkBuffer` with `vkMapMemory` / `memcpy`
- **WebGPU**: `GPUBuffer.writeBuffer()`
- **wgpu (Rust)**: `queue.write_buffer()`

The shaders (vertex + fragment) are ~50 lines of GLSL ES 3.0. The vertex shader does one interesting thing: `texelFetch` into `atlasMapTexture` to resolve `instanceCodepoint` -> UV rect. This pattern translates directly to WGSL, MSL, or HLSL.

### Stage 6: Picking -- DEEPLY COUPLED (but small)

**File**: `src/picking/PickingSystem.js`
**Platform deps**: Three.js render-to-texture, `readPixels`

Picking is a second render pass with swapped shaders that encode `uBasePickingId + gl_InstanceID` as RGB. This is GPU-API-specific but the concept is universal: render IDs to an offscreen target, read back one pixel. Every graphics API supports this.

---

## 3. The Font Problem

### What Canvas 2D provides today

`GlyphAtlas.js` uses exactly these Canvas 2D APIs:

1. **`document.createElement('canvas')`** -- creates the atlas backing store
2. **`ctx.measureText(grapheme)`** -- returns `TextMetrics` with `.width` (no height in the API; height is `fontSize * 1.15`)
3. **`ctx.fillText(grapheme, x, y)`** -- rasterizes the glyph at a position
4. **`ctx.font = '48px Monaco, Menlo, ...'`** -- sets the font
5. **`ctx.textBaseline = 'top'`** -- baseline alignment

The atlas is a 2048x2048 RGBA bitmap. Shelf-packing places glyphs left-to-right, row-by-row. UV coordinates are computed from pixel positions. The output is: (a) a bitmap texture, (b) a `uvMap` mapping grapheme -> UV rect, (c) per-grapheme pixel metrics.

### Cross-platform alternatives

**FreeType (C, available everywhere)**:
- `FT_Load_Char` + `FT_Render_Glyph` replaces `fillText`. Produces a grayscale bitmap per glyph.
- `FT_Get_Char_Index` + `FT_Load_Glyph` for metrics (advance, bearing) -- richer than Canvas `measureText`.
- Bindings: Rust (`freetype-rs`), Python (`freetype-py`), Swift (via C interop), JS (via Emscripten -- `opentype.js` is a pure-JS alternative).
- **Pro**: The lowest common denominator. Available on every platform.
- **Con**: No text shaping (no ligatures, no complex scripts). Need HarfBuzz for that.

**HarfBuzz + FreeType (C, the gold standard)**:
- HarfBuzz does shaping (ligatures, kerning, bidi, complex scripts). FreeType does rasterization.
- This is what browsers use internally. Canvas `measureText`/`fillText` is a thin wrapper over this stack.
- **Pro**: Correct for all scripts. Production-proven.
- **Con**: Two C libraries to link. Overkill for monospace code rendering.

**fontdue (Rust, pure)**:
- Pure Rust font rasterizer. No C dependencies. Competitive performance with FreeType.
- `Font::rasterize(char, px)` -> `(Metrics, Vec<u8>)`. Exactly what we need.
- No text shaping. Fine for monospace code.
- **Pro**: Single-crate, pure Rust, fast.
- **Con**: Rust-only. No shaping.

**cosmic-text (Rust)**:
- Full text layout engine (wrapping, shaping via `rustybuzz`, font fallback).
- Overkill for our use case but demonstrates the Rust ecosystem has complete coverage.

**MSDF (Multi-channel Signed Distance Fields)**:
- Replace bitmap atlas with an MSDF atlas. Each glyph stored as a small (32x32 or 48x48) multi-channel distance field.
- **Pro**: Resolution-independent. A single atlas works at any zoom level. No mipmapping artifacts.
- **Con**: Requires a generation tool (`msdf-atlas-gen`, `msdfgen`). Different fragment shader. Slightly more complex.
- **Assessment**: This is the right long-term move for a 3D text renderer. The current bitmap approach works at the current fixed `worldScale` but MSDF would eliminate the zoom-quality tradeoff entirely.

### Pre-baked atlas strategy

The atlas could be generated offline and shipped as a pair of files:
1. **Atlas image**: PNG/KTX2 bitmap (or MSDF atlas)
2. **Atlas descriptor**: JSON with `{grapheme: {u0, v0, u1, v1, numericId, width, height, advance}}`

At runtime, the consumer loads the image into a GPU texture and parses the JSON into the `uvMap` + `metrics` structures. No font rasterization needed at runtime. Dynamic glyph addition (currently `ensureGraphemes()`) would require either:
- A fallback runtime rasterizer for unknown graphemes, or
- A sufficiently large pre-baked charset (ASCII + Latin-1 + box drawing covers 99% of code)

This decouples atlas generation entirely from the rendering platform.

---

## 4. Worker Portability

### Current model

`WorkerBridge.js` creates `navigator.hardwareConcurrency - 1` Web Workers. Jobs are distributed round-robin. Each worker receives a message with `{text, position, metrics, uvMap, glyphWidths, color}` and returns `{positions, sizes, codepoints, colors, groupIds, count, bounds, itemMeta}` via `postMessage` with Transferable arrays (zero-copy).

### Abstract contract

```
ComputeTask {
  input:   serializable data (text + metrics + maps)
  output:  typed arrays (transferable ownership)
  policy:  fire-and-forget, promise-based completion
}

ComputePool {
  submit(task) -> Promise<result>
  poolSize: number
}
```

### Platform mappings

| Platform | Mechanism | Transfer | Notes |
|----------|-----------|----------|-------|
| Web Workers | `postMessage` + Transferable | Zero-copy ArrayBuffer transfer | Current impl |
| Node.js `worker_threads` | `postMessage` + SharedArrayBuffer | Transfer or shared | Same API surface |
| Rust `rayon` | Work-stealing thread pool | Move semantics (ownership) | `Vec<f32>` moved, not copied |
| Rust `tokio` | Async tasks on thread pool | Same | Better for I/O-bound; glyph build is CPU-bound, prefer rayon |
| Swift GCD | `DispatchQueue.global()` | Value types copied; use `UnsafeMutableBufferPointer` for perf | Natural fit |
| C pthreads | Manual thread pool | Pointer passing, manual sync | Lowest level |

The key insight: the buffer builders are pure functions with no shared mutable state. This means they parallelize trivially on any platform. No locks, no atomics, no coordination beyond "here's the input, give me the output."

The current Web Worker round-robin is the simplest possible scheduler. A work-stealing pool (rayon) would be better for uneven text sizes but the current approach is fine for the typical case (files are roughly similar sizes).

---

## 5. The Minimal Interface

Three boundaries define the universal pipeline:

### Boundary A: Text -> Buffers (pure, portable)

```
fn build_glyph_buffers(
    text:         &str,
    position:     Vec3,
    metrics:      LayoutMetrics,    // {charWidth, charHeight, letterSpacing, lineSpacing, worldScale}
    glyph_ids:    &Map<str, u32>,   // grapheme -> numeric atlas ID
    glyph_widths: &Map<str, f32>,   // grapheme -> pixel width
    color:        Color3,           // {r, g, b} 0-1
    group_id:     u32,
) -> GlyphBufferSet
```

This function exists today as `buildBatchBuffers()`. It is the portable core. Rewrite in Rust/C/Swift as-is.

### Boundary B: Font -> Atlas (platform-specific generation, portable consumption)

```
trait FontRasterizer {
    fn measure(grapheme: &str) -> GlyphMetrics;   // {width, height, advance}
    fn rasterize(grapheme: &str, x: u32, y: u32, target: &mut [u8]);  // write RGBA to atlas bitmap
}
```

Implementations: Canvas2D (current), FreeType, fontdue, Core Text, DirectWrite. Or skip entirely with pre-baked atlas files.

The output is an `AtlasDescriptor` (bitmap + uvMap + metrics). Once generated, this is consumed identically by all platforms.

### Boundary C: Buffers -> GPU (platform-specific)

```
trait GlyphGPUBackend {
    fn upload_atlas(atlas: &AtlasDescriptor);
    fn upload_buffers(buffers: &GlyphBufferSet);
    fn set_instance_count(count: u32);
    fn set_highlight(slot: u32, color: Option<Color4>);
}
```

Implementations: Three.js/WebGL (current), WebGPU, Metal, Vulkan, wgpu. Each is ~200 lines of boilerplate around the same pattern: create instance buffers, bind atlas texture + atlas map texture, draw instanced quads.

---

## 6. What To Do Next

**Immediate (no architecture change)**:
- Extract `buildBatchBuffers` and its dependencies (`iterGraphemes`, `countGlyphs`) into a standalone module with zero imports beyond `grapheme.js`. This is already nearly true -- one import path.
- Define the `GlyphBufferSet` and `AtlasDescriptor` types as JSDoc typedefs in a shared types file. These are the contract.

**Medium-term (atlas portability)**:
- Add a pre-baked atlas loader: `loadAtlas(imageUrl, descriptorUrl) -> AtlasDescriptor`. This decouples font rasterization from rendering entirely.
- Evaluate MSDF atlas generation (via `msdf-atlas-gen`) as a build-time step. The fragment shader change is ~5 lines (median of three distance channels instead of direct texel fetch).

**Long-term (multi-platform)**:
- Port `buildBatchBuffers` to Rust (pure function, ~200 lines). Compile to WASM for web, native for Metal/Vulkan targets.
- Implement `GlyphGPUBackend` for wgpu (covers WebGPU, Metal, Vulkan, DX12 from one codebase).
- The pipeline becomes: pre-baked atlas (or fontdue) -> Rust buffer builder -> wgpu renderer. All three stages work on all platforms.

---

## 7. Coupling Summary

| Stage | Classification | Platform Deps | Portable Contract |
|-------|---------------|---------------|-------------------|
| Grapheme segmentation | Pure portable | `Intl.Segmenter` (JS) / `unicode-segmentation` (Rust) | `string -> Iterator<grapheme>` |
| Layout + buffer build | Pure portable | None (typed array arithmetic) | `(text, metrics, ids) -> GlyphBufferSet` |
| Atlas ID lookup | Pure portable | None (map lookup) | `grapheme -> numericId` |
| Atlas generation | Platform-coupled, abstractable | Canvas2D `measureText`/`fillText` | `FontRasterizer` trait |
| GPU upload | Deeply coupled (by design) | Three.js / WebGL / Metal / etc. | `GlyphGPUBackend` trait |
| Picking | Deeply coupled (by design) | Render-to-texture + readback | Same GPU backend |
| Highlighting | Thin coupling | DataTexture write (4 bytes/glyph) | `set_highlight(slot, color)` |

The pipeline is already ~70% portable by code volume. The buffer builders are the bulk of the logic and they have zero platform dependencies. The font problem is the only hard part -- and pre-baked atlases sidestep it entirely for the code-rendering use case.
