# Phase 0: Buffer Pipeline — Swift InstancedConstants → glyph3d-js

**Agent:** buffer-pipeline
**Scope:** Per-glyph bufferIndex, additive color, picking ID — buffer layout, worker pipeline, shader, flush paths.

---

## 1. Current State — Exact Buffer Layout

**Source:** `src/GlyphRenderer.js` lines 218–228, `src/workers/builders/index.js` lines 70–74.

### Per-instance attributes (10 floats = 40 bytes/glyph)

| Attribute | itemSize | Bytes | Allocation line |
|---|---|---|---|
| `instancePosition` | 3 | 12 | GlyphRenderer.js:219 |
| `instanceSize` | 2 | 8 | GlyphRenderer.js:221 |
| `instanceCodepoint` | 1 | 4 | GlyphRenderer.js:223 |
| `instanceColor` | 3 | 12 | GlyphRenderer.js:225 |
| `instanceGroupId` | 1 | 4 | GlyphRenderer.js:227 |

**Total: 40 bytes/glyph**

At 10,000 instances (`PERF_THRESHOLDS.maxInstancesPerMesh`): **400 KB per renderer**, five separate GPU uploads per `_rebuildAllInstances()` call (GlyphRenderer.js:1081–1085).

### Worker output shape (builders/index.js:155)

```js
return { positions, sizes, codepoints, colors, groupIds, count, bounds };
```

`applyPrebuiltBuffers()` (GlyphRenderer.js:1122) destructures exactly this shape and swaps in the arrays directly via `geometry.setAttribute(...)` — zero copy from worker.

### Group DataTexture (orthogonal, not per-glyph)

4×maxGroups RGBA Float texture. Per-group, not per-glyph. Not touched by this proposal.

---

## 2. Proposed Changes

### What to port from Swift InstancedConstants

Swift's `InstancedConstants` (MetalLinkBridgingType.h:23–52) has ~80 bytes. The parts worth adapting:

| Swift field | JS equivalent | Decision |
|---|---|---|
| `bufferIndex int` | `instanceBufferIndex float` — new | Port — enables O(1) glyph lookup, picking |
| `addedColorR/G/B uint8` | `instanceAddedColor vec3` (0–1 float) | Port — additive highlight without texture rebuild |
| `pickingId` (BasicModelConstants) | `instancePickingId float` — new | Port — GPU picking pass |
| `textureDescriptorU/V float4x2` | Already handled by atlasMapTexture lookup | Skip — we do this better via DataTexture |
| `multipliedColorR/G/B uint8` | Already `instanceColor vec3` | Skip — covered |
| `unicodeHash uint64` | Already `instanceCodepoint float` | Skip — covered |
| `scale float4`, `positionOffset float4` | Already group DataTexture | Skip — covered |
| `flags uint8` | Defer — no active use case yet | Skip for now |

### New buffer layout (14 floats = 56 bytes/glyph)

| Attribute | itemSize | Bytes | New? |
|---|---|---|---|
| `instancePosition` | 3 | 12 | existing |
| `instanceSize` | 2 | 8 | existing |
| `instanceCodepoint` | 1 | 4 | existing |
| `instanceColor` | 3 | 12 | existing |
| `instanceGroupId` | 1 | 4 | existing |
| `instanceAddedColor` | 3 | 12 | **NEW** |
| `instancePickingId` | 1 | 4 | **NEW** |

**Total: 56 bytes/glyph (+40% over baseline)**

At 10,000 instances: **560 KB per renderer** (was 400 KB). Acceptable — this is still a single draw call.

**`instanceBufferIndex` decision:** Do not add as a separate buffer attribute. The vertex shader already knows the instance index via `gl_InstanceID` (GLSL ES 3.0, available in WebGL 2). Use that instead. This saves 4 bytes/glyph and avoids a CPU-side write.

---

## 3. Worker Pipeline Changes

**File:** `src/workers/builders/index.js`

Both `buildGlyphBuffers()` and `buildBatchBuffers()` need two new output arrays.

### buildGlyphBuffers() changes (lines 70–74, 121–139)

```js
// Add to allocations (after line 74):
const addedColors = new Float32Array(glyphCount * 3);  // r,g,b additive
const pickingIds  = new Float32Array(glyphCount);       // 0 = not pickable

// Add to input destructure (line 52):
const { text, position, metrics, uvMap, color, scale = 1.0, groupId = 0,
        addedColor = null, pickingIdBase = 0 } = input;

// In the hot loop, after groupIds[idx] = groupId (line 139):
if (addedColor) {
    addedColors[idx * 3]     = addedColor.r;
    addedColors[idx * 3 + 1] = addedColor.g;
    addedColors[idx * 3 + 2] = addedColor.b;
}
// pickingId: base + per-glyph sequential index within this text
pickingIds[idx] = pickingIdBase > 0 ? pickingIdBase + idx : 0;

// Return (line 155):
return { positions, sizes, codepoints, colors, groupIds,
         addedColors, pickingIds, count, bounds };
```

### buildBatchBuffers() changes (lines 257–262, 355–362)

```js
// Add to combined buffer allocations (after line 262):
const addedColors = new Float32Array(totalGlyphs * 3);
const pickingIds  = new Float32Array(totalGlyphs);

// In per-item destructure (line 279 area), add:
const itemAddedColor   = item.addedColor || null;
const itemPickingIdBase = item.pickingIdBase || 0;

// In hot loop after groupIds[idx] = itemGroupId (line 361):
if (itemAddedColor) {
    addedColors[idx * 3]     = itemAddedColor.r;
    addedColors[idx * 3 + 1] = itemAddedColor.g;
    addedColors[idx * 3 + 2] = itemAddedColor.b;
}
pickingIds[idx] = itemPickingIdBase > 0 ? itemPickingIdBase + (idx - itemStartOffset) : 0;

// Return (line 433):
return { positions, sizes, codepoints, colors, groupIds,
         addedColors, pickingIds, count, bounds, itemMeta };
```

**Worker serialization:** `Float32Array` transfers cleanly through `postMessage` as a `Transferable`. No object allocations. Both arrays are already the right type. No change needed to `WorkerBridge.js` — it already uses structured clone for the return value.

**Zero-default cost:** When `addedColor` is null and `pickingIdBase` is 0, the arrays are `new Float32Array(n)` (all zeros). Zero-initializing typed arrays is a single `memset` in the JS engine — negligible.

---

## 4. Shader Changes

### Vertex shader additions

**File:** `src/GlyphRenderer.js`, `_getVertexShader()` method starting at line 251.

Add two new attribute declarations and one new varying after line 258:

```glsl
attribute vec3 instanceAddedColor;
attribute float instancePickingId;

varying vec3 vAddedColor;
varying float vPickingId;
```

In `main()`, after the `vColor`/`vGroupAlpha` assignments (after line 311):

```glsl
vAddedColor = instanceAddedColor;
vPickingId  = instancePickingId;
```

No other vertex shader logic changes. `gl_InstanceID` is available without a buffer attribute for buffer-index lookups if needed later.

### Fragment shader — standard pass

**Current fragment** (`_getFragmentShader()`, line 320):

```glsl
gl_FragColor = texColor * vec4(vColor, vGroupAlpha);
if (gl_FragColor.a < 0.01) discard;
```

**New fragment** — additive color applied after multiply, before alpha test:

```glsl
varying vec3 vAddedColor;
varying float vPickingId;   // passed through, not used in color pass

void main() {
    vec4 texColor = texture2D(atlasTexture, vUV);
    vec4 base = texColor * vec4(vColor, vGroupAlpha);
    // Additive highlight: clamp to [0,1] so over-bright doesn't blow out alpha
    gl_FragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);
    if (gl_FragColor.a < 0.01) discard;
}
```

### Fragment shader — picking pass

GPU picking requires a second render pass to an offscreen render target with a flat-color shader that outputs the picking ID as a color. This is a **separate `THREE.ShaderMaterial`**, not the color material.

```glsl
// pickingVertex.glsl (inline in a second material)
attribute float instancePickingId;
varying float vPickingId;
void main() {
    // Same position logic as main vertex shader (copy instancePosition + group lookup)
    // ... [same worldPos calculation] ...
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vPickingId = instancePickingId;
}

// pickingFragment.glsl
precision highp float;
varying float vPickingId;
void main() {
    // Encode 24-bit int as RGB (supports up to 16.7M unique glyphs)
    float id = vPickingId;
    float r = floor(id / 65536.0) / 255.0;
    float g = floor(mod(id, 65536.0) / 256.0) / 255.0;
    float b = mod(id, 256.0) / 255.0;
    gl_FragColor = vec4(r, g, b, 1.0);
}
```

The picking pass swaps `instanceMesh.material` to the picking material, renders to a `THREE.WebGLRenderTarget`, reads back one pixel under the cursor, decodes the RGB back to an integer ID, then restores the color material. This is the standard Three.js picking pattern and does not require changes to the buffer layout beyond what is already proposed.

**Picking ID assignment:** `pickingIdBase` per text entry. The first glyph of a text entry gets `pickingIdBase`, subsequent glyphs get `pickingIdBase + localIndex`. This preserves "which text was clicked" decoding without needing a reverse lookup table per glyph (the caller already knows which IDs they assigned to which entries).

---

## 5. GlyphCollection / CodeGrid Integration

### GlyphCollection.flush() — sync path (line 481)

`renderBatch()` is called and returns renderer IDs. The new attributes propagate through `_rebuildAllInstances()` → `_updateInstanceMesh()`. No change to `flush()` itself.

What changes: `addText()` options object can now carry `addedColor` and `pickingIdBase`:

```js
collection.addText('foo', pos, {
    color: { r: 1, g: 1, b: 0 },
    addedColor: { r: 0.3, g: 0, b: 0 },   // NEW: hot-red highlight
    pickingIdBase: 42000                    // NEW: picking range start
});
```

### GlyphCollection.flushAsync() — worker path (line 562)

The normalization loop (lines 558–563) already copies `groupId` from `options` to the item. Extend it:

```js
// After line 562 (if (p.groupId === undefined) p.groupId = p.options?.groupId || 0;):
if (!p.addedColor)   p.addedColor   = p.options?.addedColor   || null;
if (!p.pickingIdBase) p.pickingIdBase = p.options?.pickingIdBase || 0;
```

### applyPrebuiltBuffers() (GlyphRenderer.js line 1121)

Extend the destructure and the `geometry.setAttribute` block:

```js
// Line 1122 — add new fields to destructure:
const { positions, sizes, codepoints, colors, groupIds,
        addedColors, pickingIds, count } = buffers;

// After line 1137 (instanceGroupId setAttribute):
geometry.setAttribute('instanceAddedColor',
    new THREE.InstancedBufferAttribute(
        addedColors || new Float32Array(count * 3), 3));
geometry.setAttribute('instancePickingId',
    new THREE.InstancedBufferAttribute(
        pickingIds  || new Float32Array(count), 1));
```

The `|| new Float32Array(...)` fallback preserves backward compatibility with worker results that predate this change.

### _createInstanceMesh() pre-allocation block (lines 216–229)

```js
geometry.setAttribute('instanceAddedColor',
    new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
geometry.setAttribute('instancePickingId',
    new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
geometry._maxInstanceCount = maxCount;
```

### _updateInstanceMesh() hot loop (lines 1056–1078)

```js
// After groupIds[i] = g.groupId || 0:
const ac = g.addedColor;
addedColorArr[i * 3]     = ac ? ac.r : 0;
addedColorArr[i * 3 + 1] = ac ? ac.g : 0;
addedColorArr[i * 3 + 2] = ac ? ac.b : 0;
pickingIdArr[i] = g.pickingId || 0;
```

And `needsUpdate` flags for the two new attributes in `_updateInstanceMesh()` (lines 1081–1085 area):

```js
geometry.attributes.instanceAddedColor.needsUpdate = true;
geometry.attributes.instancePickingId.needsUpdate = true;
```

### CodeGrid — no changes required

`CodeGrid` constructs `GlyphCollection` with `loadText()` / `loadTextAsync()` (CodeGrid.js:103–148). It passes through `options` to `_collection.addText()` unchanged. New options fields in `addText()` will flow automatically. No CodeGrid-specific code changes.

---

## 6. Performance Analysis

### Memory impact

| Config | Before | After | Delta |
|---|---|---|---|
| 10K glyphs (one mesh) | 400 KB | 560 KB | +160 KB |
| 5 meshes (50K glyphs) | 2.0 MB | 2.8 MB | +800 KB |
| 50 meshes (500K glyphs) | 20 MB | 28 MB | +8 MB |

+8 MB for 500K glyphs is acceptable on a desktop GPU. The picking ID array in particular can be lazily omitted (null fallback) when the caller does not assign pickingIdBase, keeping it zeroed without allocating from the warm path.

### GPU bandwidth impact

Each `needsUpdate = true` on a buffer attribute re-uploads the entire attribute array. The two new attributes add 160 KB/frame to the upload budget **only when they change**. Additive color and picking ID are write-once-per-flush for most use cases (highlight animation excepted). The existing `updateColor()` / `updateColors()` direct-write pattern (GlyphRenderer.js:512–534) can be extended to `updateAddedColor()` using the same approach.

### What NOT to port from Swift InstancedConstants

- **`textureDescriptorU/V float4x2` (32 bytes):** The atlasMapTexture DataTexture lookup already achieves this more efficiently. The Swift version stores pre-computed UV rects in the instance buffer; the JS version stores one float (codepoint) and resolves UVs in the vertex shader via a texture fetch. No regression here.
- **`uint8` packed colors:** JavaScript typed arrays don't benefit from uint8 packing the way Metal buffers do. `Uint8Array` would require a separate `InstancedBufferAttribute` with a custom `normalized: true` flag and GLSL `lowp` handling. The 2-byte saving per channel (6 bytes total for addedColor) is not worth the complexity.
- **`flags uint8`:** No immediate use case maps to this. The group DataTexture already handles visibility. Defer until a concrete use case arrives.
- **`multipliedColorR/G/B`:** `instanceColor` already serves this role. The group DataTexture col 2 provides group-level multiply. Per-glyph multiplicative color on top of these two layers would add complexity with no current use case.
- **`simd_float4 scale`:** Group DataTexture col 3 already covers this. Per-glyph scale belongs in `instanceSize` which already exists.

### `gl_InstanceID` vs. `instanceBufferIndex`

Swift uses `bufferIndex int` for CPU→GPU index correlation during picking and compute. In GLSL ES 3.0 (WebGL 2), `gl_InstanceID` provides the same value free — no buffer write needed. Verify WebGL 2 context is required (it is: Three.js >=r150 defaults to WebGL 2).

---

## 7. Code Sketches

### A. Attribute setup in `_createInstanceMesh()` (complete diff section)

```js
// GlyphRenderer.js — _createInstanceMesh(), replace lines 216–229
if (!this.config.skipPrealloc) {
    const maxCount = this.config.maxInstances;
    geometry.setAttribute('instancePosition',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
    geometry.setAttribute('instanceSize',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 2), 2));
    geometry.setAttribute('instanceCodepoint',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
    geometry.setAttribute('instanceColor',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
    geometry.setAttribute('instanceGroupId',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
    // NEW
    geometry.setAttribute('instanceAddedColor',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3), 3));
    geometry.setAttribute('instancePickingId',
        new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1));
    geometry._maxInstanceCount = maxCount;
}
```

### B. Vertex shader additions (inside `_getVertexShader()`)

```glsl
// Add after line 259 (attribute float instanceGroupId;):
attribute vec3 instanceAddedColor;
attribute float instancePickingId;

// Add after line 271 (varying float vGroupAlpha;):
varying vec3 vAddedColor;
// vPickingId not needed in standard color pass; only picking pass uses it

// Add at end of main(), after line 311 (vGroupAlpha = gColor.a;):
vAddedColor = instanceAddedColor;
```

### C. Fragment shader (complete replacement of `_getFragmentShader()`)

```glsl
precision highp float;
uniform sampler2D atlasTexture;
varying highp vec2 vUV;
varying vec3 vColor;
varying float vGroupAlpha;
varying vec3 vAddedColor;

void main() {
    vec4 texColor = texture2D(atlasTexture, vUV);
    vec4 base = texColor * vec4(vColor, vGroupAlpha);
    gl_FragColor = vec4(clamp(base.rgb + vAddedColor, 0.0, 1.0), base.a);
    if (gl_FragColor.a < 0.01) discard;
}
```

### D. `updateAddedColor()` direct-write API (parallel to `updateColor()` at line 512)

```js
// GlyphRenderer.js — add after updateColor() (line 535)
/**
 * Update additive color highlight — DIRECT BUFFER WRITE (no rebuild)
 * @param {number} id
 * @param {{r: number, g: number, b: number}|null} addedColor - null clears
 */
updateAddedColor(id, addedColor) {
    const entry = this.renderedTexts.get(id);
    if (!entry || entry.bufferStartIndex === undefined) return;

    const arr = this.instanceMesh.geometry.attributes.instanceAddedColor.array;
    const startIdx = entry.bufferStartIndex;
    const r = addedColor?.r ?? 0;
    const g = addedColor?.g ?? 0;
    const b = addedColor?.b ?? 0;

    for (let i = 0; i < entry.glyphs.length; i++) {
        const bufIdx = (startIdx + i) * 3;
        arr[bufIdx]     = r;
        arr[bufIdx + 1] = g;
        arr[bufIdx + 2] = b;
    }
    this.instanceMesh.geometry.attributes.instanceAddedColor.needsUpdate = true;
}
```

### E. Picking ID range API

```js
// GlyphRenderer.js — add utility near group API section
/**
 * Assign a contiguous picking ID range to a text entry.
 * First glyph gets baseId, subsequent glyphs get baseId+1, etc.
 * @param {number} textId - Renderer text ID
 * @param {number} baseId - Starting picking ID (>0; 0 = not pickable)
 */
assignPickingIds(textId, baseId) {
    const entry = this.renderedTexts.get(textId);
    if (!entry || entry.bufferStartIndex === undefined) return;

    const arr = this.instanceMesh.geometry.attributes.instancePickingId.array;
    const start = entry.bufferStartIndex;
    for (let i = 0; i < entry.glyphs.length; i++) {
        arr[start + i] = baseId + i;
    }
    this.instanceMesh.geometry.attributes.instancePickingId.needsUpdate = true;
}

/**
 * Decode a picking ID read from the GPU framebuffer (RGB encoded).
 * @param {Uint8Array} pixel - 4 bytes [r, g, b, a] from readPixels
 * @returns {number} The picking ID
 */
static decodePickingId(pixel) {
    return pixel[0] * 65536 + pixel[1] * 256 + pixel[2];
}
```

---

## Implementation Order

1. Buffer allocations in `_createInstanceMesh()` (no behavior change, additive zeros = invisible)
2. Builder functions in `builders/index.js` (worker-safe, pure functions)
3. Vertex shader: add attribute declarations and varying pass-through
4. Fragment shader: additive color blend
5. `applyPrebuiltBuffers()`: add new attributes to setAttribute block
6. `_updateInstanceMesh()`: fill new arrays in hot loop
7. `updateAddedColor()` direct-write API
8. `assignPickingIds()` + picking material (separate PR — requires WebGLRenderTarget setup)
9. `GlyphCollection.flushAsync()` normalization for `addedColor`/`pickingIdBase`
