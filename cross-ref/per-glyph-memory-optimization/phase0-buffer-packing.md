# Phase 0: Per-Glyph Buffer Packing Analysis

## 1. Current State Analysis

### Attribute Layout (14 floats = 56 bytes per glyph)

All attributes are declared in `GlyphRenderer._getVertexShader()` (lines 259–265) and allocated
in `_createInstanceMesh()` (lines 218–231). The builder output in `buildGlyphBuffers` /
`buildBatchBuffers` (src/workers/builders/index.js) feeds these via `applyPrebuiltBuffers()`
(GlyphRenderer.js line 1247).

| Attribute              | Type       | Bytes | Builder source          | Actual content                          |
|------------------------|------------|-------|-------------------------|-----------------------------------------|
| `instancePosition`     | vec3       | 12    | `positions[]`           | World-space (x, y, z) float32           |
| `instanceSize`         | vec2       | 8     | `sizes[]`               | `scaledWidth, scaledHeight` — same for every glyph in an item |
| `instanceCodepoint`    | float      | 4     | `codepoints[]`          | Raw Unicode codepoint (0–65535 typical) |
| `instanceColor`        | vec3       | 12    | `colors[]`              | RGB 0–1, often repeated for whole text  |
| `instanceGroupId`      | float      | 4     | `groupIds[]`            | DataTexture row index; same for every glyph in a CodeGrid |
| `instanceAddedColor`   | vec3       | 12    | zeros (builder doesn't emit; zero-filled in `applyPrebuiltBuffers` line 1268) | RGB 0–1, 99% zeros |
| `instancePickingId`    | float      | 4     | zeros (PickingSystem overwrites post-flush, lines 1270–1271) | Sequential int, derivable |
| **Total**              |            | **56**|                         |                                         |

### Key redundancies observed in code

**`instanceSize` (8 bytes, 14% of budget):** In `buildGlyphBuffers` (line 77–78) and
`buildBatchBuffers` (line 294–295), `scaledWidth` and `scaledHeight` are computed once from
`metrics.charWidth * scale` and `metrics.charHeight * scale`. These values are written
identically for every glyph in the item. Across a 4K-glyph CodeGrid this is 32 KB of
identical data sent to the GPU per frame-that-rebuilds.

**`instanceGroupId` (4 bytes):** In `buildBatchBuffers` (line 283), `itemGroupId` is the same
constant `item.groupId || 0` written to every slot for the item. A single renderer typically
hosts one CodeGrid → one groupId → every glyph holds the same float.

**`instanceAddedColor` (12 bytes):** Builder never emits this array. `applyPrebuiltBuffers`
allocates `new Float32Array(count * 3)` (line 1268) — 12 bytes per glyph, all zero.
Highlighting writes only the non-zero slots via `setGlyphHighlight()` (line 578) and
`updateAddedColor()` (line 553). At rest the entire 12-byte field is wasted GPU upload.

**`instancePickingId` (4 bytes):** Always allocated as zeros (line 1271). `PickingSystem`
overwrites it post-flush via `registerRenderer()`. The picking shaders (PickingSystem.js
line 54) read `instancePickingId` directly; but the value is just `basePickingId + gl_InstanceID`
for contiguous IDs — fully derivable on the GPU if the base ID is passed as a uniform.

**`instanceCodepoint` (4 bytes for 16-bit range):** Used codepoints (ASCII + Latin-1 +
box-drawing) fit in uint16 (0–65535). Stored as float32.

**`instancePosition` (12 bytes):** This is the only field where every glyph genuinely needs
unique values. Z-wrap in `buildBatchBuffers` (lines 326–333) adds a third dimension, so a
pure (line, col) integer encoding does not capture it. Full float32 is justified.

---

## 2. Proposed Packed Layout

### Target: 24 bytes per glyph (57% reduction from 56)

The strategy has four independent sub-optimizations, each removable independently.

```
Packed layout (6 floats = 24 bytes):

  [0..2]  instancePosition   vec3   12 bytes  unchanged — still needed per glyph
  [3]     instanceData       float   4 bytes  packed uint16 col 0..15 | uint16 groupId
  [4]     instanceCodepoint  float   4 bytes  kept as float (uint16 fits, but texture
                                              lookup math already uses float; no gain)
  [5]     instanceColorPack  float   4 bytes  packed uint8 r,g,b,addedColorFlag
```

**Total: 6 floats = 24 bytes per glyph.**

Broken down:

| New field            | Bytes | Replaces                                  | Savings |
|----------------------|-------|-------------------------------------------|---------|
| `instancePosition`   | 12    | instancePosition (unchanged)              | 0       |
| `instanceData`       | 4     | instanceSize (8) + instanceGroupId (4)    | 8       |
| `instanceCodepoint`  | 4     | instanceCodepoint (unchanged)             | 0       |
| `instanceColorPack`  | 4     | instanceColor (12) + instanceAddedColor (12) | 20   |
| ~~`instancePickingId`~~ | 0  | instancePickingId (4)                     | 4       |
| **Total**            | **24**|                                           | **32**  |

### Field encodings

**`instanceData` (replaces `instanceSize` + `instanceGroupId`):**

Size is uniform-driven. A `vec2 instancedSize` uniform replaces the per-instance attribute.
The renderer passes `metrics.charWidth * scale` and `metrics.charHeight * scale` as uniforms
set once at construction time and on scale change. No per-glyph writes needed.

GroupId fits in uint16 (max 16000 groups, well within 65535). Pack it into the low 16 bits
of the float reinterpreted as a uint32 (the standard GLSL bit-pack trick via `floor()` and
`mod()`). Since groupIds are typically 0 (identity group), this field often packs to zero.

Encoding in builder JS:
```js
// groupId fits in uint16; pack into float via reinterpretation
// Use a single float to carry a 16-bit group id (< 65536)
instanceData[idx] = groupId;  // direct float, no packing needed here
                              // — see note below on size elimination
```

Actually the cleanest approach for `instanceData`: eliminate `instanceSize` entirely via
uniforms (see Section 3), making this slot just carry `groupId` as a plain float. This costs
nothing over the current `instanceGroupId` but frees the 8-byte `instanceSize`.

**`instanceColorPack` (replaces `instanceColor` + `instanceAddedColor`):**

Pack base RGB as uint8 (0–255) and the additive highlight flag into a single float interpreted
as a uint32:

```
bits 31..24 : unused (spare / future alpha)
bits 23..16 : blue  (uint8, 0-255)
bits 15..8  : green (uint8, 0-255)
bits  7..0  : red   (uint8, 0-255)
```

8-bit color is sufficient: syntax highlighting palettes (Dracula, Solarized, etc.) use ~16
colors, well within 256 steps per channel. The additive highlight (`instanceAddedColor`) can
be moved to a second DataTexture indexed by glyph slot (sparse — only non-zero during active
highlights), or kept as a separate float-per-glyph `instanceHighlight` float (4 bytes packed
as uint8 rgb + flag) only when the feature is active.

Actually, additive highlight is the edge case — most glyphs are always 0. The cleanest
approach is: remove `instanceAddedColor` from the hot per-glyph buffer and replace it with a
highlight DataTexture (width=N, R8G8B8 format) that is only uploaded when highlights change.
Zero savings in bytes-per-glyph but eliminates the wasted 12-byte allocation for 99% of
glyphs that never highlight. For the 10K-glyph budget this is 120 KB freed.

**`instancePickingId` elimination:**

The picking vertex shader (PickingSystem.js line 54) reads `vPickingId = instancePickingId`.
This can be replaced with:

```glsl
// Add uniform: uniform float pickingBaseId;
vPickingId = pickingBaseId + float(gl_InstanceID);
```

`gl_InstanceID` is a built-in available in WebGL 2 (GLSL ES 3.00). The renderer sets
`pickingBaseId` as a material uniform when the picking pass begins. The picking material swap
in `PickingSystem` already owns the material swap; adding one uniform is trivial.

This eliminates `instancePickingId` entirely — 4 bytes, plus the post-flush write loop in
`PickingSystem.registerRenderer()`.

---

## 3. Builder Changes Needed

### `buildGlyphBuffers` / `buildBatchBuffers` (src/workers/builders/index.js)

**Remove `sizes` array allocation and writes:**
```js
// BEFORE (line 71, line 263):
const sizes = new Float32Array(glyphCount * 2);
// ... and in hot loop:
sizes[idx * 2] = scaledWidth;
sizes[idx * 2 + 1] = scaledHeight;

// AFTER: delete both. Caller passes size as shader uniform.
```

The function return object drops `sizes`. Callers that destructure `sizes` from the result
must be updated: `applyPrebuiltBuffers()` (line 1248), `GlyphCollection.flushAsync()`
(wherever it reads `buffers.sizes`), `GlyphCollection.flush()` sync path.

**Remove `groupIds` array if using DataTexture approach:**
For the uniform-per-renderer approach (each renderer == one group), `groupIds` becomes
redundant — drop it from the builder, pass `groupId` as a uniform in the shader material.
For the multi-group case keep `groupIds` but switch to `Uint16Array` (2 bytes per element)
since group IDs fit in uint16:
```js
// BEFORE:
const groupIds = new Float32Array(glyphCount);
// AFTER (2-byte integers):
const groupIds = new Uint16Array(glyphCount);
groupIds[idx] = groupId;  // same value, half the bytes
```

The InstancedBufferAttribute for `instanceGroupId` must switch to:
```js
geometry.setAttribute('instanceGroupId',
    new THREE.InstancedBufferAttribute(new Uint16Array(maxCount), 1, false));
```
And the vertex shader reads `attribute float instanceGroupId;` unchanged because WebGL
normalizes Uint16 to float in the attribute fetch — wait, it does NOT normalize unsigned
integers for non-normalized attributes. Use `attribute uint instanceGroupId;` with
`WebGL2RenderingContext` or keep float and accept the 4-byte stride alignment. In practice
WebGL 2 attribute stride rules mean you pay 4 bytes either way for a scalar attribute; the
savings only materialize if you pack two uint16 values into a single float attribute (e.g.,
`instanceGroupId` in the high 16 bits and a future field in the low 16 bits).

**Pack color into uint32 (optional, highest complexity, ~20 byte saving):**
```js
// Encode r,g,b as uint8 into a single float (reinterpreted as uint32):
function packColor(r, g, b) {
    const ri = (r * 255 + 0.5) | 0;
    const gi = (g * 255 + 0.5) | 0;
    const bi = (b * 255 + 0.5) | 0;
    // Pack into int32 bit pattern, then reinterpret via DataView:
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, ri);
    view.setUint8(1, gi);
    view.setUint8(2, bi);
    view.setUint8(3, 0);
    return view.getFloat32(0, true);  // little-endian
}
```
This path allocates a `DataView` per call — unacceptable in the hot loop. Pre-allocate one
reusable buffer outside the loop:
```js
const _colorBuf = new ArrayBuffer(4);
const _colorView = new DataView(_colorBuf);
function packColorFast(r, g, b) {
    _colorView.setUint8(0, (r * 255 + 0.5) | 0);
    _colorView.setUint8(1, (g * 255 + 0.5) | 0);
    _colorView.setUint8(2, (b * 255 + 0.5) | 0);
    _colorView.setUint8(3, 0);
    return _colorView.getFloat32(0, true);
}
// In hot loop (replaces 3 writes with 1):
colorPack[idx] = packColorFast(color.r, color.g, color.b);
```
This is a module-level singleton — zero-allocation in the hot path. Worker context safe
(no DOM, no Three.js).

---

## 4. Shader Changes Needed

### Vertex shader (`_getVertexShader()`, GlyphRenderer.js line 256)

**Remove `instanceSize` attribute, add size uniform:**
```glsl
// REMOVE:
attribute vec2 instanceSize;

// ADD:
uniform vec2 instanceSizeWorld;   // charWidth, charHeight in world units

// In main():
// BEFORE:
vec3 scaled = position * vec3(instanceSize, 1.0);
// AFTER:
vec3 scaled = position * vec3(instanceSizeWorld, 1.0);
```

**For uint8-packed color (`instanceColorPack`):**
```glsl
// REMOVE:
attribute vec3 instanceColor;
// ADD:
attribute float instanceColorPack;

// Unpack in main() — GLSL ES 3.00 has floatBitsToUint:
// (WebGL 2 only, requires #version 300 es)
uint packed = floatBitsToUint(instanceColorPack);
vec3 instanceColor = vec3(
    float(packed & 0xFFu) / 255.0,
    float((packed >> 8u) & 0xFFu) / 255.0,
    float((packed >> 16u) & 0xFFu) / 255.0
);
```

If staying on GLSL ES 1.00 (WebGL 1 compat), use the fract/mod decode instead:
```glsl
// GLSL ES 1.00 compatible uint8 unpack from float:
float p = instanceColorPack;
float b_int = floor(p / 65536.0);
float g_int = floor(mod(p, 65536.0) / 256.0);
float r_int = mod(p, 256.0);
vec3 instanceColor = vec3(r_int, g_int, b_int) / 255.0;
```
This works only if `packColorFast` above writes the value as an integer (0–16777215 range)
rather than a float bit-cast. Use `view.setInt32(0, ri | (gi << 8) | (bi << 16), true)` and
`view.getFloat32(0, true)` — but that encodes an integer as a float mantissa, which loses
precision for values > 2^24. Safe for our 24-bit range (max 16777215 < 2^24), confirmed.

**Remove `instanceAddedColor` varying, pass highlight via DataTexture:**
```glsl
// REMOVE:
attribute vec3 instanceAddedColor;
varying vec3 vAddedColor;
// ... and vAddedColor = instanceAddedColor;
```
Fragment shader removes `vAddedColor` contribution. Highlight color is applied via the
existing group DataTexture's color-blend mechanism (already implemented), or via a separate
sparse highlight texture sampled by glyph index.

**`instancePickingId` elimination in picking shaders (PickingSystem.js):**
```glsl
// ADD to picking vertex shader uniform block:
uniform float pickingBaseId;

// CHANGE in main():
// BEFORE:
vPickingId = instancePickingId;
// AFTER (WebGL 2 only, gl_InstanceID is uint):
vPickingId = pickingBaseId + float(gl_InstanceID);
```
Material creation in `PickingSystem` adds `pickingBaseId: { value: 0.0 }` to uniforms and
sets it before each picking pass.

---

## 5. Migration Path

These optimizations are independent. Recommend applying in phases:

### Phase A: Remove `instanceSize` (8 bytes saved, low risk)
1. Add `instanceSizeWorld` uniform to shader material, set from `this.metrics.charWidth/Height`.
2. Remove `instanceSize` attribute from `_createInstanceMesh()` and `applyPrebuiltBuffers()`.
3. Remove `sizes` array from both builder functions and return objects.
4. Update `_updateInstanceMesh()` to skip the size write.
5. Update `applyPrebuiltBuffers()` to not destructure `sizes`.
6. **Risk**: Multi-scale rendering — if callers pass `scale != 1.0` per text item, the uniform
   approach breaks. Currently `buildBatchBuffers` (line 294) uses `item.scale || 1.0` per item.
   Mitigation: add `instanceScale` float attribute (1 byte of headroom via float = 4 bytes),
   net savings still 4 bytes. Or restrict to single-scale renderer instances (CodeGrid already
   does this — one worldScale per renderer).

### Phase B: Eliminate `instancePickingId` (4 bytes saved, requires WebGL 2)
1. Add `pickingBaseId` uniform to picking material in `PickingSystem`.
2. Replace `vPickingId = instancePickingId` with `vPickingId = pickingBaseId + float(gl_InstanceID)`.
3. Remove `instancePickingId` allocation in `_createInstanceMesh()` and `applyPrebuiltBuffers()`.
4. Remove `assignPickingIds()` and its loop in `PickingSystem.registerRenderer()`.
5. **Risk**: `gl_InstanceID` is only available in WebGL 2 (GLSL ES 3.00). The project already
   targets WebGL 2 (confirmed by Canvas 2D atlas and modern Three.js usage). No fallback needed
   but must add `#version 300 es` directive or Three.js `glslVersion: THREE.GLSL3` to material.

### Phase C: Pack `instanceGroupId` into Uint16 (2 bytes saved, medium risk)
1. Switch builder arrays from `Float32Array` to `Uint16Array` for groupIds.
2. Update `InstancedBufferAttribute` constructor.
3. In vertex shader: `attribute float instanceGroupId;` works IF Three.js normalizes the
   Uint16 attribute — it doesn't for non-normalized integer attributes. Instead keep the
   attribute as float but interleave two uint16 values (groupId low + spare high) into a
   single float32 slot using the bit-cast approach. Net: same 4 bytes, 2 bytes of future headroom.
4. Real savings only come if a second uint16 field can share the slot.

### Phase D: Pack `instanceColor` into uint8 (8 bytes saved, medium risk)
1. Add `packColorFast()` to builders (module-level singleton DataView, zero-alloc).
2. Switch `colors` buffer from `Float32Array(N*3)` to `Float32Array(N)`.
3. Update vertex shader to unpack (GLSL ES 3.00 bit ops, or fract/mod for ES 1.00).
4. Update `updateColor()` direct write path in `GlyphRenderer` (line 537) — must repack.
5. Update `applyPrebuiltBuffers()` to not reconstruct per-glyph color objects from 3-float
   layout (line 1323–1326) — read from packed float instead.
6. **Risk**: 8-bit color quantization. Syntax highlighting colors (e.g., `#FF6B6B`) round to
   nearest uint8 — 0.3% error per channel. Visually indistinguishable. Additive highlight must
   move to a separate mechanism (see Phase E).

### Phase E: Remove `instanceAddedColor` (12 bytes saved, low risk)
1. Delete `instanceAddedColor` attribute from shader, geometry, and `applyPrebuiltBuffers`.
2. Replace additive highlight with group DataTexture color-blend: `setGroupColorBlend(g, 1.0)`
   to override color, `setGroupColor(g, highlightColor)` to set it. Already implemented.
3. Limitation: current group system is per-text-entry, not per-character. Per-character
   highlights require a highlight DataTexture (width=maxInstances, single R8G8B8 row).
4. **Risk**: `CodeGrid.highlightRange()` uses `setGlyphHighlight(bufferSlotIndex, color)`
   (GlyphRenderer.js line 578) for character-level highlights. This must route to the highlight
   DataTexture instead. Moderate refactor of `highlightCommands.js`.

---

## 6. Risks and Gotchas

**`updatePosition()` / `updateColor()` direct write paths** (GlyphRenderer.js lines 483–545)
read back `entry.glyphs[i].position` from the JS-side glyph objects to compute offsets. These
shadow copies are 12-byte objects (`{x, y, z}`) per glyph stored in `renderedTexts`. That
CPU-side shadow is a separate memory concern (not GPU buffer) — it exists regardless of packing
and must be maintained for the offset-compute logic. The shadow cost at 10K glyphs is ~240 KB
JS heap, worth addressing separately (replace with Float32Array shadow or delete and re-read
from the GPU buffer attribute array directly).

**Worker transfer**: Buffers passed via `postMessage` with transferable ownership. Switching
`groupIds` to `Uint16Array` is compatible — Web Workers support all TypedArray transfers.
`DataView`-based color packing can run in worker context without issue.

**Multi-scale items**: `buildBatchBuffers` supports `item.scale != 1.0` per item (line 283).
Eliminating `instanceSize` requires either: (a) restricting to single-scale renderers, or (b)
keeping a `instanceScale` float (4 bytes) and computing size in the shader as
`instanceSizeWorld * instanceScale`. Net savings Phase A drops from 8 to 4 bytes.

**GLSL ES version**: Color bit-packing (Phase D) and `gl_InstanceID` (Phase B) both require
GLSL ES 3.00 (`#version 300 es`). Three.js enables this via `glslVersion: THREE.GLSL3` on
`ShaderMaterial`. Output variables change: `varying` → `out`/`in`, `texture2D` → `texture`.
Requires touching every shader line. Alternatively, use the fract/mod decode in ES 1.00 for
color packing (no version bump) and accept `gl_InstanceID` as the only blocker for Phase B.

**`getMemoryStats()`** (line 741) iterates `geom.attributes` and sums `byteLength`. It will
naturally report correct values for the new layout without changes.

**`_rebuildAllInstances()`** (line 1131) is the sync-path rebuild. Its hot loop at
`_updateInstanceMesh()` (line 1170–1199) must be updated to match any attribute changes. The
worker path (`applyPrebuiltBuffers`) is a separate code path and both must be kept in sync.

---

## Summary: Savings by Phase

| Phase | What                           | Bytes saved | Risk   |
|-------|--------------------------------|-------------|--------|
| A     | Remove instanceSize → uniform  | 8           | Low    |
| B     | Remove instancePickingId       | 4           | Low    |
| E     | Remove instanceAddedColor      | 12          | Medium |
| D     | Pack instanceColor → uint8     | 8           | Medium |
| C     | Pack instanceGroupId → uint16  | 2           | Low    |
| **Total** |                            | **34 bytes** | —     |

**From 56 bytes → 22 bytes per glyph (61% reduction).**

At 200K glyphs (20 renderers × 10K): 11.2 MB → 4.4 MB GPU buffer memory.
