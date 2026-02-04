# Glyph Rendering Deep Dive

A living technical reference for the glyph rendering pipeline in glyph3d-js. This document covers the internal mechanics of how glyphs are stored, transformed, and rendered on the GPU, how properties are applied to groups of glyphs, and where the architecture needs to evolve.

---

## Table of Contents

1. [GPU Buffer Architecture](#gpu-buffer-architecture)
2. [Per-Instance Attribute Layout](#per-instance-attribute-layout)
3. [The Rendering Pipeline End-to-End](#the-rendering-pipeline-end-to-end)
4. [Applying Properties to Glyphs](#applying-properties-to-glyphs)
5. [Group Operations and Transforms](#group-operations-and-transforms)
6. [The Deferred Flush Pattern](#the-deferred-flush-pattern)
7. [Worker Pipeline and Zero-Copy Buffers](#worker-pipeline-and-zero-copy-buffers)
8. [Layout Systems](#layout-systems)
9. [Current Limitations and Evolution Path](#current-limitations-and-evolution-path)

---

## GPU Buffer Architecture

Every visible glyph in the scene is a quad (a `PlaneGeometry(1, 1)`) rendered via Three.js `InstancedBufferGeometry`. A single mesh holds all glyphs in a collection. The GPU sees one draw call regardless of glyph count.

### The Four Instance Buffers

Each glyph instance is described by four attribute arrays, stored as contiguous `Float32Array` typed arrays:

| Attribute | Components | Stride | Format | Shader Name |
|-----------|-----------|--------|--------|-------------|
| **Position** | 3 | `i * 3` | `[x, y, z]` | `instancePosition` |
| **Size** | 2 | `i * 2` | `[width, height]` | `instanceSize` |
| **UV** | 4 | `i * 4` | `[u0, v1_flipped, u1, v0_flipped]` | `instanceUV` |
| **Color** | 3 | `i * 3` | `[r, g, b]` | `instanceColor` |

Total memory per glyph: **12 floats = 48 bytes**.

For 10,000 glyphs (default max per mesh): **480 KB** of GPU buffer.

### Buffer Indexing

For glyph at index `i`:

```
positions[i*3 + 0] = x    positions[i*3 + 1] = y    positions[i*3 + 2] = z
sizes[i*2 + 0]     = w    sizes[i*2 + 1]     = h
uvs[i*4 + 0]       = u0   uvs[i*4 + 1]       = v1'   uvs[i*4 + 2] = u1   uvs[i*4 + 3] = v0'
colors[i*3 + 0]    = r    colors[i*3 + 1]    = g     colors[i*3 + 2] = b
```

### UV Coordinate Convention

The atlas is rendered by Canvas 2D (top-left origin) but consumed by WebGL (bottom-left origin). The V-flip is applied at buffer-fill time, not in the shader:

```javascript
// Canvas UV: (u0, v0) is top-left, (u1, v1) is bottom-right
// WebGL UV:  V must be flipped
const v0_flipped = 1.0 - uv.v0;
const v1_flipped = 1.0 - uv.v1;

// Stored as: [u0, v1_flipped, u1, v0_flipped]
// This maps to shader's mix(instanceUV.xy, instanceUV.zw, uv)
// where .xy = bottom-left corner and .zw = top-right corner
```

This is a critical detail. The UV storage order is `[u_min, v_bottom, u_max, v_top]` after flipping — matching how `mix()` interpolates from the base quad's `(0,0)-(1,1)` UVs.

---

## Per-Instance Attribute Layout

### Vertex Shader

The vertex shader (`textVertex.glsl` / inline in `GlyphRenderer.js`) does minimal work per vertex:

```glsl
// Scale the unit quad by instance size
vec3 scaled = position * vec3(instanceSize, 1.0);

// Translate to world position
vec3 worldPos = scaled + instancePosition;

// Standard MVP transform
gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

// Interpolate UVs from base quad (0-1) to atlas region
vUV = mix(instanceUV.xy, instanceUV.zw, uv);
vColor = instanceColor;
```

Each quad vertex is scaled by the instance's `[width, height]` then offset by its `[x, y, z]`. The quad's built-in `uv` attribute (0-1 range) is remapped into the glyph's atlas region.

### Fragment Shader

```glsl
vec4 texColor = texture2D(atlasTexture, vUV);
gl_FragColor = texColor * vec4(vColor, 1.0);
if (gl_FragColor.a < 0.01) discard;
```

The atlas texture is sampled, multiplied by the instance color (tinting), and alpha-tested. The color is multiplicative — white text (`{1,1,1}`) renders the atlas as-is; colored text tints it.

---

## The Rendering Pipeline End-to-End

### Sync Path (GlyphRenderer direct)

```
text string
    ↓
GlyphLayout.layoutText()         → Array of {x, y, z} positions per character
    ↓
GlyphRenderer._textToGlyphs()    → Array of glyph objects {position, size, uv, color}
    ↓
GlyphRenderer._registerText()    → Store in renderedTexts Map with ID
    ↓
GlyphRenderer._rebuildAllInstances()  → Flatten all glyphs, write to Float32Arrays
    ↓
GlyphRenderer._updateInstanceMesh()   → Copy to InstancedBufferAttribute arrays
    ↓
Mark needsUpdate = true on each attribute
    ↓
Three.js uploads to GPU on next render()
```

### Async Path (Worker pipeline)

```
text string + position + color
    ↓
GlyphCollection.addText()        → Queue in _pendingAdds (deferred)
    ↓
GlyphCollection.flushAsync()     → Send to WorkerBridge
    ↓
WorkerBridge.buildBatchBuffers() → Serialize items + UV map, post to worker
    ↓
GlyphWorker                      → Call buildBatchBuffers() (pure function)
    ↓                               Single-pass: text → Float32Arrays directly
    ↓                               No intermediate glyph objects
    ↓                               Returns: {positions, sizes, uvs, colors, count, bounds}
    ↓
GlyphCollection receives result  → Creates renderer with exact buffer size
    ↓
GlyphRenderer.applyPrebuiltBuffers() → Swap in worker's arrays (zero-copy!)
    ↓
Three.js uploads to GPU on next render()
```

The worker path is faster because:
1. No intermediate glyph objects are allocated — text goes directly to `Float32Array`
2. The `Float32Array` buffers are transferred (not copied) from worker to main thread
3. `applyPrebuiltBuffers()` replaces the attribute arrays wholesale — no per-element copy
4. Buffer sizing is exact (no over-allocation)

---

## Applying Properties to Glyphs

### Individual Glyph Properties

Each glyph has four independently mutable properties:

| Property | Buffer | Components | Unit |
|----------|--------|-----------|------|
| Position | `instancePosition` | `x, y, z` | World units |
| Size | `instanceSize` | `width, height` | World units |
| UV | `instanceUV` | `u0, v1', u1, v0'` | Normalized (0-1) |
| Color | `instanceColor` | `r, g, b` | Normalized (0-1) |

### Direct Buffer Writes (Fast Path)

`GlyphRenderer` supports direct buffer writes for position and color changes. These bypass the full rebuild and only mark the affected attribute for GPU re-upload:

```javascript
// GlyphRenderer.updatePosition() — O(n) where n = glyphs in one text entry
updatePosition(id, newPosition) {
    const entry = this.renderedTexts.get(id);
    const positions = geometry.attributes.instancePosition.array;

    // Calculate delta from first glyph
    const offset = { x: newPosition.x - entry.glyphs[0].position.x, ... };

    // Write directly to Float32Array
    for (let i = 0; i < entry.glyphs.length; i++) {
        const bufIdx = (entry.bufferStartIndex + i) * 3;
        positions[bufIdx]     = glyph.position.x + offset.x;
        positions[bufIdx + 1] = glyph.position.y + offset.y;
        positions[bufIdx + 2] = glyph.position.z + offset.z;
    }

    // Only this attribute needs GPU re-upload
    geometry.attributes.instancePosition.needsUpdate = true;
}
```

```javascript
// GlyphRenderer.updateColor() — same pattern
updateColor(id, newColor) {
    const colors = geometry.attributes.instanceColor.array;
    for (let i = 0; i < entry.glyphs.length; i++) {
        const bufIdx = (entry.bufferStartIndex + i) * 3;
        colors[bufIdx]     = newColor.r;
        colors[bufIdx + 1] = newColor.g;
        colors[bufIdx + 2] = newColor.b;
    }
    geometry.attributes.instanceColor.needsUpdate = true;
}
```

Key detail: `entry.bufferStartIndex` is set during `_rebuildAllInstances()`, which maps each text entry's glyphs to their contiguous range in the buffer. This allows O(n) updates without touching other glyphs.

### Full Rebuild (Slow Path)

Any operation that changes the *set* of glyphs (add, remove, text change) triggers `_rebuildAllInstances()`:

1. Iterate all entries in `renderedTexts`
2. Flatten all glyph arrays into one list
3. Write all four attribute buffers from scratch
4. Mark all four attributes as `needsUpdate`

This is O(total_glyphs), not O(changed_glyphs). It is the primary bottleneck for dynamic content.

### Batch Update Mode

To amortize multiple changes:

```javascript
renderer.beginBatchUpdate();
renderer.updateColor(id1, red);
renderer.updateColor(id2, blue);
renderer.updatePosition(id3, newPos);
renderer.endBatchUpdate(); // Single rebuild
```

Without batch mode, each call triggers a full rebuild. With batch mode, changes are deferred and a single rebuild happens at the end.

---

## Group Operations and Transforms

### Collection-Level Transforms (Three.js Group)

`GlyphCollection` wraps the renderer's mesh in a `THREE.Group`. Collection-level transforms apply to all glyphs without touching any buffers:

```javascript
collection.setPosition({ x: 100, y: 0, z: 0 });   // Moves all glyphs
collection.setScale(2.0);                           // Doubles all glyphs
collection.setRotation({ x: 0, y: Math.PI/4, z: 0 }); // Rotates all
```

This is O(1) — it modifies the Group's matrix, which the GPU applies during vertex transformation. No buffer writes occur.

### CodeGrid Object3D Hierarchy

`CodeGrid` extends `THREE.Object3D` and parents its collection's group. This means:

```
Scene
  └── CodeGrid (Object3D) — grid.position.set(x, y, z)
       ├── Collection Group — collection.setPosition(...)
       │    └── Instance Mesh — actual glyphs
       └── Background Mesh — the background panel
```

Moving a `CodeGrid.position` moves everything — glyphs, background, labels — through Three.js's scene graph, not buffer manipulation.

### GridLayoutManager

Positions `CodeGrid` instances using Three.js Object3D positioning (not buffer-level):

```
addTrailing(grid)    → grid.position.x = lastGrid.bounds.max.x + spacing
addInNextRow(grid)   → grid.position.y = rowBottom - spacing
addInNextPlane(grid) → grid.position.z = planeZ - spacing
addAuto(grid)        → trailing if fits, else next row
```

Maintains bidirectional neighbor relationships (`left`, `right`, `up`, `down`, `forward`, `backward`) and row bounds caching for O(1) layout decisions.

### HierarchicalLayoutManager

Maps directory trees to 3D space in four phases:

1. **Build tree** from file paths (`_buildTree`)
2. **Compute bounds** bottom-up — leaf bounds come from `grid.getBounds()`, directory bounds aggregate children
3. **Position nodes** top-down — allocate regions, recursively subdivide
4. **Apply positions** — `grid.position.copy(node.position)` for each leaf

Directories can stack in Z (`directoriesInZ: true`) to reduce vertical noise. Files lay out horizontally at the front Z-plane; directories stack behind.

---

## The Deferred Flush Pattern

`GlyphCollection` uses a queue-flush model:

```javascript
// These are cheap — just push to arrays
collection.addText('line 1', pos1);  // → _pendingAdds.push(...)
collection.addText('line 2', pos2);
collection.addText('line 3', pos3);

// This is where GPU work happens
collection.flush();       // Sync: creates renderer, calls renderBatch()
collection.flushAsync();  // Async: offloads to worker, applies prebuilt buffers
```

### Why Deferred?

1. **Right-sized buffers**: The renderer is created lazily at flush time, sized to actual content (with 10% headroom by default). No wasted pre-allocation.
2. **Batch efficiency**: All pending adds go through `renderBatch()` as a single operation, triggering one `_rebuildAllInstances()` instead of N.
3. **Worker compatibility**: The entire pending set can be serialized and sent to a worker in one message.

### Dirty Tracking

`GlyphCollection` tracks `_dirty` and `_boundsDirty` flags. `flush()` is a no-op when nothing has changed. Bounds are cached and only recomputed when content changes.

---

## Worker Pipeline and Zero-Copy Buffers

### Builder Architecture

The `src/workers/builders/` directory contains pure functions with no DOM or Three.js dependencies:

| Function | File | Purpose |
|----------|------|---------|
| `buildGlyphBuffers()` | `index.js` | Single text → Float32Arrays (single-pass) |
| `buildBatchBuffers()` | `index.js` | Multiple texts → combined Float32Arrays |
| `layoutText()` | `layoutText.js` | Text → positioned coordinates with Z-wrap |
| `textToGlyphs()` | `textToGlyphs.js` | Text + positions → glyph objects (two-step path) |
| `buildBuffers()` | `buildBuffers.js` | Glyph objects → Float32Arrays (two-step path) |

The **single-pass path** (`buildGlyphBuffers`, `buildBatchBuffers`) is preferred. It skips intermediate glyph objects entirely:

```
// Single-pass (preferred):
text → countGlyphs() → allocate Float32Arrays → fill in one loop

// Two-step (legacy/sync):
text → layoutText() → textToGlyphs() → buildBuffers()
```

### Single-Pass Buffer Building

`buildBatchBuffers()` in `index.js` is the hot path for the worker pipeline:

```javascript
// First pass: count total glyphs across all items
let totalGlyphs = 0;
for (const item of items) totalGlyphs += countGlyphs(item.text);

// Allocate combined buffers ONCE
const positions = new Float32Array(totalGlyphs * 3);
const sizes     = new Float32Array(totalGlyphs * 2);
const uvs       = new Float32Array(totalGlyphs * 4);
const colors    = new Float32Array(totalGlyphs * 3);

// Second pass: fill buffers directly (no intermediate objects)
let bufferOffset = 0;
for (const item of items) {
    for (const char of item.text) {
        // Write position, size, uv, color directly to typed arrays
        positions[bufferOffset * 3] = x;
        // ... etc
        bufferOffset++;
    }
}
```

This avoids:
- No `Array.push()` (pre-allocated typed arrays)
- No intermediate glyph objects
- No spread operators
- Single allocation per buffer type

### Z-Depth Wrapping

Lines longer than `maxLineWidth` (default 200 chars) wrap in Z instead of Y:

```
Characters 0-199:    z = startZ
Characters 200-399:  z = startZ - zWrapSpacing
Characters 400-599:  z = startZ - zWrapSpacing * 2
```

Newlines reset Z back to `startZ`. This keeps files with very long lines (minified JS, binary data) spatially compact while preserving the Y-axis for logical line breaks.

### UV Map Serialization

Workers can't access `Map` objects from the main thread. The UV map is serialized to a plain object:

```javascript
// Main thread: atlas.getSerializableUVMap()
const uvMap = {};
for (const [charCode, uv] of atlas.uvMap) {
    uvMap[charCode] = uv;  // charCode as string key
}

// Worker: lookup by charCode
const uv = uvMap[charCode] || uvMap[63]; // fallback to '?'
```

The serialized map is cached on the `WorkerBridge` and the `GlyphAtlas`. It's only re-serialized when dynamic glyphs are added.

### Transfer vs Copy

`applyPrebuiltBuffers()` replaces attribute arrays wholesale:

```javascript
// Creates NEW InstancedBufferAttribute with worker's arrays
geometry.setAttribute('instancePosition',
    new THREE.InstancedBufferAttribute(positions, 3));
```

The `Float32Array` from the worker is used directly — no element-by-element copy. This is the "zero-copy" path.

---

## Layout Systems

### GlyphLayout (Sync, Main Thread)

`src/layout/GlyphLayout.js` — used by `GlyphRenderer` in the sync path. Supports:

- **Linear**: Left-to-right with newline handling
- **Grid**: Terminal-style row/column positioning
- **Wrapped**: Word-wrapping at a max width
- **Circular**: Characters along a circle
- **Path**: Characters along arbitrary 3D paths

Cursor-based API for streaming text (terminal emulation).

### layoutText (Worker-Compatible)

`src/workers/builders/layoutText.js` — pure function equivalent of `GlyphLayout.layoutText()`. Adds Z-depth wrapping. Returns both positions and bounds in a single pass.

### GridLayoutManager

Row/column/plane positioning of `CodeGrid` instances. O(1) layout decisions via cached row bounds. Supports reflow and grid removal.

### HierarchicalLayoutManager

Directory-tree-aware layout. Four-phase algorithm (build tree → compute bounds → position → apply). Supports horizontal/vertical sibling direction, Z-depth stacking for directories, and row wrapping within directories.

---

## Current Limitations and Evolution Path

### What Works Well

- **Single draw call rendering** — GPU instancing is efficient for large glyph counts
- **Worker offloading** — buffer computation doesn't block the main thread
- **Deferred flush** — right-sized buffers, batch efficiency
- **Collection transforms** — O(1) group movement via Three.js scene graph
- **Direct buffer writes** — fast position/color updates for existing text

### Where Things Need to Evolve

#### 1. Per-Glyph Property Updates Without Full Rebuild

**Current state**: Changing the text content, adding, or removing any text entry triggers `_rebuildAllInstances()` — a full O(N) rewrite of all four buffers. Only position and color have direct-write fast paths.

**What's needed**: A buffer management strategy that supports:
- **Slot-based allocation**: Reserve contiguous ranges per text entry. When an entry is removed, mark its slots as free (tombstoning) rather than rebuilding.
- **Compaction on demand**: When fragmentation exceeds a threshold, compact the buffer. This is the only time a full rebuild should be needed.
- **Per-entry size updates**: Allow changing `instanceSize` for individual entries without rebuild (analogous to existing `updatePosition`/`updateColor`).
- **Per-glyph color**: Currently, `updateColor` sets all glyphs in an entry to the same color. Supporting per-character color (syntax highlighting) requires either individual glyph addressing or a color array per entry.

#### 2. Sub-Entry Glyph Addressing

**Current state**: The finest addressable unit is a "text entry" (a string added via `addText()`). Individual characters within an entry can only be addressed by knowing their buffer index (`entry.bufferStartIndex + charIndex`).

**What's needed**:
- A `getGlyphAt(textId, charIndex)` API that returns the buffer offset for direct manipulation
- Range-based operations: `setColorRange(textId, startChar, endChar, color)` for syntax highlighting
- Character hit-testing: given a world position, find the text entry and character index

#### 3. Efficient Dynamic Content

**Current state**: Changing text content requires remove + re-add + full rebuild. The worker path only supports initial load, not incremental updates.

**What's needed**:
- **Incremental worker updates**: Send only changed text entries to workers, receive partial buffer patches
- **Buffer patching**: Apply a worker's partial result to a sub-range of the existing buffer without full replacement
- **Append-only mode**: For streaming text (logs, terminals), append new glyphs to the end of the buffer without touching existing data

#### 4. Multi-Color Text Entries

**Current state**: Each `addText()` call accepts a single color. To render syntax-highlighted code, the caller must split text into per-color fragments and call `addText()` once per fragment. This leads to many small text entries (one per color span), each requiring its own glyph tracking overhead.

**What's needed**:
- An `addColoredText(text, position, colorArray)` API where `colorArray` provides per-character `{r,g,b}` values
- The worker pipeline already supports this at the buffer level — each glyph gets independent color values. The missing piece is the API and the color data format.

#### 5. Scale and Size Operations

**Current state**: `instanceSize` is set once during buffer construction (from `metrics.charWidth * scale`). There is no `updateSize()` method.

**What's needed**:
- `updateScale(textId, newScale)` — recalculates size for all glyphs in an entry
- Per-glyph scale (for emphasis, animations, hover effects)
- Smooth scale transitions (lerp between current and target size per frame)

#### 6. Buffer Memory Management

**Current state**: When using the sync path, buffers are pre-allocated to `maxInstances` (default 10,000). When using the worker path, buffers are exact-sized. Neither path reuses buffer memory across clear/reload cycles.

**What's needed**:
- **Buffer pooling**: Reuse `Float32Array` allocations across clear/reload cycles to reduce GC pressure
- **Growth strategy**: When content exceeds the current buffer, grow by 2x (amortized O(1) appends) rather than exact-size + full copy
- **Shrink threshold**: If utilization drops below 25%, compact to half-size

#### 7. Shader-Level Property Application

**Current state**: All property changes happen on the CPU side (writing to `Float32Array`). The shader receives static attribute values.

**What's needed for next-level performance**:
- **Uniform-based group properties**: Pass collection-level color tint, opacity, or highlight as uniforms. The shader applies them multiplicatively. This enables O(1) color changes for entire collections.
- **Attribute compression**: Pack color as `uint8x4` instead of `float32x3`. Pack UV as `uint16x4`. This reduces per-glyph memory from 48 bytes to ~28 bytes.
- **Texture-based properties**: Store per-glyph properties in a data texture (1D, indexed by glyph index). Update the texture instead of attribute buffers. Texture updates can be partial (sub-image upload).

#### 8. Layout Pipeline Integration

**Current state**: Layout and rendering are separate concerns. Layout managers position `CodeGrid` instances but don't participate in the buffer pipeline. The worker pipeline doesn't know about layout managers.

**What's needed**:
- **Layout-aware workers**: Send directory structure + file contents to workers, get back fully-positioned buffers for the entire scene
- **Incremental layout**: When one file changes, only recompute affected subtree positions, not the entire hierarchy
- **Layout animation**: Smooth transitions when grids are added, removed, or repositioned (lerp Object3D positions over frames)

#### 9. Atlas Evolution

**Current state**: The atlas is generated once with a fixed character set. Dynamic glyph addition is supported but requires a full texture re-upload.

**What's needed**:
- **Partial texture updates**: Use `texSubImage2D` to update only the new glyph region, not the entire atlas
- **Multi-page atlas**: When one 2048x2048 atlas fills up, create a second atlas and a second draw call. This removes the character limit.
- **SDF rendering**: Switch from rasterized glyphs to Signed Distance Field rendering for resolution-independent text that looks sharp at any zoom level

---

## Quick Reference: File to Concept Map

| Concept | Primary File | Key Function/Method |
|---------|-------------|-------------------|
| Buffer layout (4 arrays, strides) | `GlyphRenderer.js:561-605` | `_updateInstanceMesh()` |
| Direct position write | `GlyphRenderer.js:339-371` | `updatePosition()` |
| Direct color write | `GlyphRenderer.js:378-401` | `updateColor()` |
| Full rebuild trigger | `GlyphRenderer.js:540-555` | `_rebuildAllInstances()` |
| Batch update mode | `GlyphRenderer.js:307-332` | `beginBatchUpdate()` / `endBatchUpdate()` |
| Zero-copy buffer apply | `GlyphRenderer.js:638-660` | `applyPrebuiltBuffers()` |
| Deferred add/flush | `GlyphCollection.js:121-326` | `addText()` / `flush()` |
| Worker batch build | `builders/index.js:158-305` | `buildBatchBuffers()` |
| Single-pass build | `builders/index.js:35-138` | `buildGlyphBuffers()` |
| Z-depth wrapping | `builders/index.js:232-239` | Z-wrap in `buildBatchBuffers()` |
| UV V-flip | `builders/index.js:113-116` | V-flip in buffer fill loop |
| Collection transforms | `GlyphCollection.js:426-472` | `setPosition()` / `setScale()` / `setRotation()` |
| Grid layout | `GridLayoutManager.js:66-203` | `addTrailing()` / `addInNextRow()` / `addAuto()` |
| Hierarchical layout | `HierarchicalLayoutManager.js:86-107` | `layoutHierarchy()` |
| Atlas UV generation | `GlyphAtlas.js:173-230` | `_packGlyph()` |
| Dynamic glyph addition | `GlyphAtlas.js:332-361` | `addGlyphIfMissing()` |
| Vertex shader | `shaders/textVertex.glsl` | Quad scaling + positioning |
| Fragment shader | `shaders/textFragment.glsl` | Atlas sampling + color tint |
| Worker bridge | `WorkerBridge.js:134-208` | `buildBuffers()` / `buildBatchBuffers()` |
| Font metrics derivation | `GlyphRenderer.js:48-65` | Constructor metrics block |
