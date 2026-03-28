# Metal GPU Layout Analysis: Techniques Portable to glyph3d-js

Cross-reference of `/Users/lugo/localdev/viz-web/metal-glyph-core/` (Swift/Metal)
against `/Users/lugo/localdev/viz-web/glyph3d-js/` (JavaScript/Three.js).

---

## 1. GPU Character Layout

### What the Metal compute shader does

The Metal implementation uses a **multi-pass GPU compute pipeline** for character layout. The full pipeline is orchestrated in `GlyphCompute+Encoding.swift` (`setupAtlasLayoutCommandEncoder`):

1. **Pass 1: `utf8ToUtf32KernelAtlasMapped`** — Each GPU thread takes a byte offset in the raw UTF-8 buffer. It decodes the UTF-8 sequence (1-4 bytes), computes a codepoint, hashes it, and looks up atlas UV data from a pre-built atlas buffer. It also atomically increments a total character counter. One thread per byte position; non-start bytes early-return.

2. **Pass 2: `utf32GlyphMap_FastLayout`** — Each thread corresponds to one glyph in the output buffer. It **backtracks** through previous glyphs to compute its position offset. The algorithm walks backward, accumulating `textureSize.x` for X advances and detecting newline codepoints (`\n`) for Y drops. A `rendered` flag and `foundLineStart` flag prevent double-counting when a prior glyph has already finalized its layout. Backtrack limit: 128 iterations before using the prior glyph's finalized position.

3. **Pass 3: `utf32GlyphMap_FastLayout_Paginate`** — Applies page-break transforms to the computed positions (see Section 2 below).

### How JS currently does it

The JS version (`src/workers/builders/index.js`) does layout in a **single CPU pass**: iterate characters sequentially, advance a cursor (`x`, `y`, `z`), skip whitespace/newlines, write position directly into Float32Array. This is inherently sequential.

### Can WebGL 2 replicate the Metal compute layout?

**No, not directly.** WebGL 2 has no compute shaders. The Metal backtracking layout algorithm (`utf32GlyphMap_FastLayout`) requires read-write access to a shared buffer — each thread reads from previous threads' outputs. This is a scatter/gather pattern that needs:

- **Read-write storage buffers** (not available in WebGL 2)
- **Thread synchronization / memory barriers** (not available in WebGL 2)
- **Arbitrary thread dispatch** (not available in WebGL 2)

**What IS possible in WebGL 2:**
- The GPU codepoint-to-UV lookup is already implemented in glyph3d-js via `atlasMapTexture` — this matches what Metal's Pass 1 does for atlas mapping.
- A **vertex shader transform** could apply page-break pagination (Pass 3) since it only reads from the glyph's own position data. No inter-glyph dependencies.
- Position could be encoded as `(charIndex, lineIndex)` instead of `(worldX, worldY, worldZ)`, with a vertex shader that multiplies by char/line spacing. This would make the GPU do the final position math while the CPU only counts characters and lines (much cheaper).

**WebGPU would enable:** The full Metal compute pipeline. WebGPU compute shaders with storage buffers can replicate the backtracking layout algorithm directly. This is the correct long-term target.

### Architectural insight

The Metal backtracking layout is clever but not optimal — it has O(n) worst-case per thread (bounded to 128 backtracks) and relies on iterative convergence. A parallel prefix-sum approach would be more efficient for GPU layout. The JS sequential approach is actually simpler and, for typical file sizes (< 50K chars), likely faster than GPU roundtrip overhead in WebGL 2.

---

## 2. Z-Depth Line Breaking (Pagination)

### How Metal does it

`calculatePageOffsets()` in `Compute.metal` (lines 396-428) implements a **book-like pagination** system. Key parameters:

```metal
float pageWidth     = 88     // characters wide before horizontal page break
float pageWidthPad  = 10     // gap between horizontal pages
float pageHeight    = -150   // lines tall before vertical page break (negative = downward)
float pageHeightPad = 20     // gap between vertical pages
int pagesWide       = 5      // max horizontal pages before stacking in Z
```

The algorithm:
1. **Vertical pages**: `yPages = abs(yPosition) / pageHeight`. Wraps Y position back to top of page.
2. **Horizontal pages**: `xPages = xPosition / pageWidth`. Wraps X position within page width.
3. **X offset**: Modulo-wraps X, then shifts by `(pageWidth + pageWidthPad) * (yPages % pagesWide)` — this fans vertical pages out horizontally.
4. **Z depth**: `zFromVertical = (yPages / pagesWide) * 32.0` plus `zFromHorizontal = xPages * -4.0`. Vertical page groups stack 32 units deep. Horizontal pages get a slight Z offset.

The result: a long file becomes a **book with pages fanned out horizontally and stacked in depth**. You can have 5 pages side-by-side before they stack behind.

### How JS currently does it

`buildBatchBuffers()` has a simpler Z-wrap: when `charsOnSegment >= maxLineWidth` (default 200), it resets X to the start and decrements Z by `zWrapSpacing` (3x charHeight). Z resets on each newline. This gives a flat ribbon that extends backward — no horizontal paging or vertical page breaks.

### Porting to Three.js

**Fully portable.** The `calculatePageOffsets()` function is pure math on per-glyph position data with no inter-glyph dependencies. Two implementation paths:

**A. CPU-side (immediate, recommended):** Replace the simple Z-wrap in `buildBatchBuffers()` with the Metal page offset calculation. This adds ~10 lines of math per glyph in the existing loop. No GPU changes needed.

**B. Vertex shader (deferred, elegant):** Store raw (x, y, z) positions as linear character/line indices, then have the vertex shader compute page offsets. This would require adding uniforms for page dimensions. Advantage: page layout parameters can be changed without rebuilding buffers.

---

## 3. Wide Buffer Boundaries (BackingBuffer)

### Metal approach

`BackingBuffer.swift` implements:
- **2x growth factor** (`enlargeMultiplier = 2.01`) — when the buffer fills, allocate a new buffer 2x the size
- **Semaphore guards** — `enlargeSemaphore` prevents concurrent expansions, `createSemaphore` prevents concurrent element creation
- **GPU buffer copy** — `link.copyBuffer(from:oldCount:newCount:)` copies old data into the new larger buffer on the GPU
- **Direct pointer access** — `UnsafeMutablePointer<Stored>` for zero-copy reads/writes
- **Default size 256** — starts small and grows as needed
- `RandomAccessCollection` conformance — buffer is directly subscriptable

The key insight: Metal buffers can be resized by creating a new buffer and GPU-copying the old data. The pointer is updated atomically.

### JS approach

The JS version has two modes:
1. **Pre-allocated fixed size** (`maxInstances = 10000`) — wastes memory for small texts
2. **Worker path** — allocates exact-size Float32Arrays per batch, then swaps them in via `applyPrebuiltBuffers()` which creates new `InstancedBufferAttribute` objects each time

### What to port

**Amortized growth pattern.** Instead of either over-allocating (10K) or exact-sizing (per-batch), implement 2x growth:

```javascript
// When buffer fills:
const newSize = Math.max(currentSize * 2, requiredSize);
const newArray = new Float32Array(newSize * stride);
newArray.set(oldArray); // copy existing data
geometry.setAttribute('instancePosition',
    new THREE.InstancedBufferAttribute(newArray, 3));
```

This avoids:
- The 10K pre-allocation waste for small grids
- The full buffer re-creation on every `applyPrebuiltBuffers()` call
- Frequent GC pressure from discarded Float32Arrays

No semaphores needed — JS is single-threaded for GPU buffer operations.

---

## 4. Whitespace/Newline Reuse

### Metal approach

In the Metal pipeline, **every byte position** in the UTF-8 buffer gets a `GlyphMapKernelOut` slot. Whitespace and newlines get `unicodeHash = 0` (they pass through the UTF-8 decoder but don't match any atlas entry). The layout kernel (`utf32GlyphMap_FastLayout`) checks `if (out.unicodeHash == 0) return` — skipping layout computation for these positions. The blit kernel (`blitGlyphsIntoConstants`) similarly skips entries with `targetBufferIndex >= expectedCharacterCount`.

So whitespace characters:
- **Occupy buffer slots** in the intermediate `utf32Buffer` (one per byte position)
- **Do NOT get instanced** — they never make it into `InstancedConstants`
- **Affect layout** only through the backtracking algorithm — a newline (`codePoint == '\n'`) triggers Y offset reduction
- The `sourceRenderableStringIndex` field maps each visible glyph to a compact output index (via `atomic_fetch_add` on `totalCharacterCount`)

### JS approach

The JS builder (`buildBatchBuffers`) skips whitespace during buffer writing — spaces advance the cursor but don't get a buffer entry. Newlines reset X and advance Y. This is equivalent to the Metal output: only renderable glyphs get buffer entries.

### Assessment

**The JS approach is already optimal here.** The Metal version actually wastes memory on intermediate buffer slots for whitespace (one `GlyphMapKernelOut` per byte, most empty) — this is a tradeoff for GPU parallelism. The JS sequential pass avoids this waste entirely. No porting needed.

---

## 5. Color Blend Modes

### Metal approach

`MetalLinkInstancedShaders.metal` defines four blend functions:

```metal
colorBlend_Add(bottom, top)       // bottom.rgb += top.rgb
colorBlend_Overlay(bottom, top)   // Photoshop overlay formula
colorBlend_Screen(a, b)           // 1 - (1-a)(1-b)
colorBlend_Multiply(bottom, top)  // bottom.rgb *= top.rgb (skips if top channel is 0)
```

Each instance carries **two colors**: `addedColor` (RGB uint8) and `multipliedColor` (RGB uint8). The fragment shader applies multiply first, then add:

```metal
color = colorBlend_Multiply(color, multipliedColor);
color = colorBlend_Add(color, addedColor);
```

This dual-color system enables:
- **Syntax highlighting** via `multipliedColor` (tint the base glyph)
- **Search highlighting** via `addedColor` (overlay a bright color on matches)
- Both can be active simultaneously on the same glyph

The per-instance `flags` byte includes `matchesCurrentSearch` (bit 2) which the vertex shader checks to apply search highlighting (Z-pop + red addedColor).

### JS approach

The JS version has:
- Per-instance `instanceColor` (vec3, 0-1 range)
- Per-group `gColor` (vec4, in group DataTexture)
- Color blend factor `gScale.w`: 0.0 = multiply instance by group, 1.0 = replace with group color
- Fragment: `texColor * vec4(vColor, vGroupAlpha)`

This is a single-layer multiply. No additive channel, no per-instance flags.

### What to port

**Dual-color (add + multiply) is high value for code visualization.** Implementation:

1. Add `instanceAddedColor` attribute (vec3, per-instance) — 3 extra floats per glyph
2. Fragment shader becomes:
   ```glsl
   vec4 color = texColor * vec4(vMultipliedColor, vGroupAlpha);
   color.rgb += vAddedColor;
   ```
3. The additive channel enables search highlighting without disturbing syntax colors

**Overlay and Screen blend modes** are lower priority — multiply + add covers 95% of use cases. Could add as a per-group uniform later if needed.

**Per-instance flags** (search match, hover ignore) are worth adding as a single float attribute that packs 8 boolean bits. The vertex shader can branch on these for visual effects.

---

## 6. Portable vs. Metal-Only Techniques

### Directly portable to WebGL 2

| Technique | Metal Source | JS Implementation Path |
|-----------|-------------|----------------------|
| Page-break pagination | `calculatePageOffsets()` | CPU-side in builder or vertex shader uniform |
| Dual-color blending (add + multiply) | Fragment shader | Add `instanceAddedColor` attribute |
| Per-instance flags (search/hover) | `flags` uint8 in `InstancedConstants` | Add `instanceFlags` float attribute |
| 2x buffer growth | `BackingBuffer.swift` | Wrap Float32Array management |
| Atomic bounds computation | `blitGlyphsIntoConstants` (atomicMin/Max) | CPU-side during buffer build (already done) |
| GPU-side atlas lookup | `utf8ToUtf32KernelAtlasMapped` atlas mapping | Already implemented (`atlasMapTexture`) |
| GPU text search | `searchGlyphs` kernel | Not portable to WebGL 2 — requires compute |
| Hash-based glyph identity | `unicodeHash` for search | Could pre-compute on CPU for search |

### Requires WebGPU (not portable to WebGL 2)

| Technique | Why |
|-----------|-----|
| GPU UTF-8 decoding (`utf8ToUtf32Kernel`) | Needs compute shader with storage buffer |
| GPU character layout (`utf32GlyphMap_FastLayout`) | Needs read-write shared buffer + thread dispatch |
| GPU search (`searchGlyphs`, `clearSearchGlyphs`) | Needs compute + atomic operations |
| GPU constants blit (`blitGlyphsIntoConstants`) | Needs compute + atomics for bounds |
| GPU color blit (`blitColorsIntoConstants`) | Needs compute (but trivial to do CPU-side) |

### Key limitation: WebGL 2 vs Metal Compute

The Metal pipeline's core advantage is that **the entire path from raw UTF-8 bytes to rendered instances** happens on the GPU. The CPU only provides the raw file data. In WebGL 2, we can only use the GPU for the final rendering stage. WebGPU would close this gap.

However, the JS worker pool already offloads the CPU-side layout to background threads, so the main thread stays responsive. The real bottleneck is the **buffer upload** (`needsUpdate = true`), not the layout computation.

---

## 7. Concrete Recommendations: Top 5 Things to Port

### 1. Page-Break Pagination (HIGH IMPACT, LOW COMPLEXITY)

**What changes:** Replace the simple Z-wrap in `buildBatchBuffers()` (`src/workers/builders/index.js`) with a `calculatePageOffsets()` function matching the Metal algorithm. Add configurable parameters: `pageWidth`, `pageHeight`, `pagesWide`.

**Why:** Current Z-wrap creates a flat ribbon extending infinitely backward. The Metal approach creates a readable book-like layout that keeps all content navigable in 3D space. This is the single biggest visual improvement for large files.

**Complexity:** ~50 lines of code. Pure math, no GPU changes, no API changes. Can be added as an option alongside existing Z-wrap.

**Files to modify:**
- `src/workers/builders/index.js` — add `calculatePageOffsets()`, apply in `buildBatchBuffers()` loop
- `src/core/constants.js` — add page layout constants

### 2. Dual-Color System: Additive + Multiplicative (HIGH IMPACT, MEDIUM COMPLEXITY)

**What changes:** Add `instanceAddedColor` (vec3) per-instance attribute. Modify fragment shader to apply multiply then add. Update `GlyphCollection`/`GlyphRenderer` APIs to support both color channels.

**Why:** Enables simultaneous syntax highlighting (multiply) and search highlighting (add) without interference. Currently, updating color for search destroys syntax colors and requires expensive restoration.

**Complexity:** ~150 lines across 4 files. Adds 3 floats per instance (12 bytes), ~30% buffer size increase for colors. Fragment shader change is 2 lines.

**Files to modify:**
- `src/GlyphRenderer.js` — add attribute, update shaders, add `updateAddedColor()` API
- `src/workers/builders/index.js` — emit `addedColors` buffer (default all zeros)
- `src/collections/GlyphCollection.js` — proxy `updateAddedColor()` through
- `src/shaders/textVertex.glsl` / `textFragment.glsl` — reference copies

### 3. Amortized Buffer Growth (MEDIUM IMPACT, LOW COMPLEXITY)

**What changes:** When `applyPrebuiltBuffers()` receives a buffer that fits within the current allocation, write into existing arrays instead of creating new `InstancedBufferAttribute` objects. When it doesn't fit, grow by 2x. Track `_bufferCapacity` separate from `instanceCount`.

**Why:** Currently every `applyPrebuiltBuffers()` call creates 5 new `InstancedBufferAttribute` objects, triggering GPU buffer recreation. For incremental updates (adding one file to a collection), this is wasteful. The Metal 2x growth pattern amortizes allocation cost.

**Complexity:** ~80 lines in `GlyphRenderer.js`. No API changes.

**Files to modify:**
- `src/GlyphRenderer.js` — modify `applyPrebuiltBuffers()`, add `_bufferCapacity` tracking

### 4. Per-Instance Flags for Search/Selection (MEDIUM IMPACT, MEDIUM COMPLEXITY)

**What changes:** Add `instanceFlags` (float) per-instance attribute. Encode search-match, selection, hover-ignore as bit flags. Vertex shader reads flags to apply visual effects (Z-pop for search matches, outline for selection).

**Why:** The Metal version does GPU-side text search with flag-based highlighting. While we can't do the GPU search in WebGL 2, we can do CPU-side search and set flags efficiently. This eliminates the need to rebuild color buffers for search highlighting — just set a flag and the shader handles the visual.

**Complexity:** ~120 lines. Adds 1 float per instance. Vertex shader adds conditional logic.

**Files to modify:**
- `src/GlyphRenderer.js` — add attribute, shader conditionals, `setInstanceFlags()` API
- `src/workers/builders/index.js` — emit `flags` buffer
- `src/collections/GlyphCollection.js` — search/selection flag API

### 5. Vertex Shader Position Encoding (MEDIUM IMPACT, HIGH COMPLEXITY)

**What changes:** Instead of storing absolute world positions per instance, store `(charIndex, lineIndex, depth)` as integers. The vertex shader multiplies by char/line spacing uniforms and applies page-break pagination. Position update becomes a uniform change instead of a buffer rewrite.

**Why:** The Metal version stores position offsets computed on the GPU. We can approximate this by making the vertex shader do the final position math from compact indices. This means layout parameter changes (font size, line spacing, page width) only require updating uniforms — not rebuilding 100K+ position entries.

**Complexity:** ~200 lines. Changes the position encoding format, requires builder and shader modifications, and the group offset system needs adjustment. Significant testing needed.

**Files to modify:**
- `src/GlyphRenderer.js` — new vertex shader, new uniforms
- `src/workers/builders/index.js` — emit (charIdx, lineIdx, depth) instead of (x, y, z)
- `src/collections/CodeGrid.js` — adapt to new position encoding
- `src/core/constants.js` — layout parameter uniforms

---

## Summary Table

| # | Technique | Impact | Complexity | WebGL 2 | WebGPU |
|---|-----------|--------|------------|---------|--------|
| 1 | Page-break pagination | HIGH | LOW | Yes | Yes |
| 2 | Dual-color (add + multiply) | HIGH | MEDIUM | Yes | Yes |
| 3 | Amortized buffer growth | MEDIUM | LOW | Yes | Yes |
| 4 | Per-instance flags | MEDIUM | MEDIUM | Yes | Yes |
| 5 | Vertex shader position encoding | MEDIUM | HIGH | Partial | Full |
| - | GPU text search | HIGH | HIGH | No | Yes |
| - | GPU character layout | LOW* | HIGH | No | Yes |
| - | GPU UTF-8 decoding | LOW* | HIGH | No | Yes |

*LOW impact because CPU worker path is already fast enough for typical file sizes.
