# Round 3: gpu-techniques convergence

## Settled

All points now fully resolved.

1. **Atlas map compact sizing is the single highest-value change.** Option B: compute
   `MAX_CP = Math.max(...atlas.uvMap.keys()) + 1` rounded up to next power of two at atlas
   generation time rather than using a hardcoded constant. Saves 17 MB globally, zero shader
   impact, two lines. My Phase 0 proposed `0x2600` as a hard constant — buffer-packing
   (R1) correctly identified that any codepoint above that value would silently drop; the
   dynamic `Math.max` from atlas.uvMap.keys() is the correct implementation.

2. **`_committedTexts` string drop saves 75 MB heap, is one line.** Drop `.text` field from
   committed map entries; keep `.textLength`. Before landing, audit all readers of
   `_committedTexts.get(id).text` — if `updateText()` reads it, the method must accept new
   content as a parameter instead of reading back the stored string.

3. **`GridVirtualizer` ships before any per-glyph packing.** Reducing active renderers
   from 1500 to ~50 via scene-graph frustum culling dominates all per-glyph savings. The
   two are compounding, not competing, but ordering matters for delivery value.

4. **`instanceSize` → `uniform vec2 instanceSizeWorld` with `instanceScale` float fallback.**
   The uniform is valid because all builders already compute a single `scaledWidth/Height` per
   item. The fallback `instanceScale float` (4 bytes, not 0) is required to handle
   `item.scale != 1.0` in `buildBatchBuffers`. Net saving: 4 bytes per glyph, not 8.
   `_updateInstanceMesh()` at GlyphRenderer.js ~1179 also writes the size attribute and must
   be updated in the same commit (this step was missing from my Phase 0 step list).

5. **`instancePickingId` → `gl_InstanceID + basePickingId` after contiguity audit.** The
   `window.__glyph3dPickingIdCounter` global must become a per-renderer `basePickingId`
   uniform. Proof required that no gaps exist between `removeText()` and next rebuild.
   If gaps are possible, add a compaction step to `_removeFromMesh()` or gate behind an
   `this._isCompact` flag. RGB encoding must match PickingSystem decode order (high byte in
   `r`, not `b` — my Phase 0 had channels swapped relative to PickingSystem.js lines 63–66).

6. **GLSL3 upgrade is one atomic commit touching 6 shader strings.** Not interleaved with
   feature commits. Strings: `_getVertexShader()`, `_getFragmentShader()` in GlyphRenderer;
   `PICKING_VERTEX_CORE`, `PICKING_VERTEX_CELL`, `PICKING_VERTEX_GLYPH`,
   `PICKING_FRAGMENT_CELL/GLYPH` in PickingSystem.js. Changes: `varying` → `in/out`,
   `gl_FragColor` → `out vec4 fragColor`, `texture2D` → `texture`. Both ShaderMaterial
   instances need `glslVersion: THREE.GLSL3`.

7. **`instanceAddedColor` → highlight DataTexture using RGBA8 format.**
   Use `THREE.DataTexture(maxInstances, 1, RGBAFormat, UnsignedByteType)` — 40 KB per mesh
   vs. 120 KB current attribute. The group color-blend path (buffer-packing Phase E primary)
   is insufficient for `CodeGrid.highlightRange()` which operates at buffer slot granularity.
   RGBA8 limits highlight precision to 255 steps per channel, which is acceptable for syntax
   highlighting. Savings: 80 KB per mesh.

8. **Full instance data DataTexture (my Phase 0 §2) is rejected.** The 2-texel layout had a
   real indexing bug: my coord1 formula `(idx + maxInstances) % 1024` breaks when
   `maxInstances > 1024`. Correct interleaved indexing is `slot = idx * 2`. More
   importantly, moving all vertex data to a DataTexture adds 2 serialized texture fetches per
   vertex on a path where attribute fetches are already handled by the fixed-function pipeline.
   The `updateRange` technique on InstancedBufferAttribute captures the partial-upload benefit
   without the fetch penalty.

9. **`instancePosition` stays vec3.** My `instanceGridCoord` vec2 proposal is not viable for
   the general GlyphCollection path. Z-wrap in `buildBatchBuffers` (builders/index.js:325–334)
   decrements Z at each line-wrap; a `(col, line)` encoding cannot represent this. My claim
   that `gridOrigin` IS the group offset was also wrong — `instancePosition` is world-space
   and the group offset `gPos.xyz` is added to the already-world-space position, not to a
   local grid coordinate. The vec2 proposal would require a semantic change to the coordinate
   system, not a free reuse.

10. **Color palette deferred.** The proposal requires a new GlyphCollection API, palette
    deduplication at flush time, palette serialization into worker context, and palette texture
    upload on the main thread. This complexity is not justified until atlas map, string
    retention, and GridVirtualizer are shipped.

11. **`InstancedBufferAttribute.updateRange` added to `updatePosition()` and `updateColor()`.**
    Set `attr.updateRange = { offset: slotIndex * itemSize, count: glyphCount * itemSize }` before
    `needsUpdate = true`. This limits `gl.bufferSubData` to the changed range. Pure win on
    existing code, no format change, no GLSL dependency.

---

## Implementation Plan

### Phase 0 — One-line wins (ship immediately, no rendering pipeline change)

**File: `src/GlyphAtlas.js`**
- In `getAtlasMapTexture()`, replace the hardcoded `0x110000` range with:
  ```js
  const maxCP = Math.max(...this.uvMap.keys()) + 1;
  const ATLAS_MAP_WIDTH = 256;
  const ATLAS_MAP_HEIGHT = Math.ceil(maxCP / ATLAS_MAP_WIDTH);
  ```
  The two shader uniforms `atlasMapWidth`/`atlasMapHeight` in `GlyphRenderer._createInstanceMesh()`
  must be set from the atlas instance, not from constants. Verify the atlas is initialized before
  the renderer creates its mesh (it already is — atlas is passed into renderer constructor).

**File: `src/collections/GlyphCollection.js`**
- In `flush()`, committed map entry construction: replace `text: item.text` with
  `textLength: item.text.length`. Audit every `_committedTexts.get(id).text` read site;
  if `updateText()` reads `.text`, change its signature to `updateText(id, newText)` and remove
  the read-back.

### Phase 1 — Partial buffer uploads (no shader change)

**File: `src/GlyphRenderer.js`**
- In `updatePosition(id, pos)` (~line 483): after computing `startIdx`, add
  `posAttr.updateRange = { offset: startIdx * 3, count: entry.glyphCount * 3 }` before
  `posAttr.needsUpdate = true`.
- In `updateColor(id, color)` (~line 522): same pattern with `itemSize = 3`.
- These changes are backward-compatible and require no tests beyond confirming existing
  examples still animate correctly.

### Phase 2 — `instanceSize` → uniform (4-byte save per glyph)

**Files: `src/GlyphRenderer.js`, `src/workers/builders/buildBuffers.js`,
`src/workers/builders/index.js`, `src/shaders/textVertex.glsl`**

- Add `uniform vec2 instanceSizeWorld` to vertex shader; remove `attribute vec2 instanceSize`.
- In `_createInstanceMesh()`: remove `sizes` InstancedBufferAttribute; add uniform to material.
- In `_rebuildAllInstances()` / `_updateInstanceMesh()` (~line 1179): delete the
  `sizes[i*2]` / `sizes[i*2+1]` writes — this is the step omitted in Phase 0 analysis.
- In `applyPrebuiltBuffers()`: remove `sizes` parameter handling.
- In both builder functions: remove `sizes` Float32Array allocation and write loop.
- For multi-scale items (`item.scale != 1.0`): add `instanceScale float` attribute; vertex
  shader multiplies `instanceSizeWorld` by `instanceScale` before quad construction. If
  `item.scale != 1.0` is unused in production (audit `buildBatchBuffers` callers), skip the
  fallback attribute entirely.

### Phase 3 — GLSL3 upgrade (atomic commit, prerequisite for phases 4 and 5)

**Files: `src/GlyphRenderer.js`, `src/picking/PickingSystem.js`**

Six shader string locations:
- `GlyphRenderer._getVertexShader()`: `varying` → `out`, `texture2D` → `texture`
- `GlyphRenderer._getFragmentShader()`: `varying` → `in`, `gl_FragColor` → `out vec4 fragColor`,
  `texture2D` → `texture`
- `PickingSystem.js` strings `PICKING_VERTEX_CORE`, `PICKING_VERTEX_CELL`, `PICKING_VERTEX_GLYPH`:
  `varying` → `out`/`in`, `texture2D` → `texture`
- `PickingSystem.js` fragment string(s): `gl_FragColor` → `out vec4`, `texture2D` → `texture`

Both ShaderMaterial instantiation sites add `glslVersion: THREE.GLSL3`. Verify all three
example pages render before continuing.

### Phase 4 — Highlight DataTexture (80-byte save per mesh net, better update granularity)

**Files: `src/GlyphRenderer.js`, `src/shaders/textVertex.glsl`**

- Allocate `THREE.DataTexture(maxInstances, 1, RGBAFormat, UnsignedByteType)` as
  `this._highlightTexture`, zero-initialized.
- Add `uniform sampler2D highlightTex` to vertex shader. Replace `vAddedColor` varying
  sourced from `instanceAddedColor` with `texelFetch(highlightTex, ivec2(gl_InstanceID, 0), 0).rgb`
  (requires Phase 3 GLSL3 upgrade for `texelFetch`).
- In `setGlyphHighlight(slotIndex, color)` (~line 578): write to
  `this._highlightTexture.image.data[slotIndex * 4 ... +3]`, set `needsUpdate = true` on the
  texture instead of flagging the attribute.
- Remove `instanceAddedColor` InstancedBufferAttribute and its builder write paths.
- Update `getMemoryStats()` to include `highlightTextureBytes` (40 KB per mesh).

### Phase 5 — `instancePickingId` → `gl_InstanceID` (4-byte save per glyph, after audit)

**Files: `src/GlyphRenderer.js`, `src/picking/PickingSystem.js`**

Pre-work (required before this phase):
- Audit `removeText()` → confirm `_rebuildAllInstances()` always follows before next pick.
  If not, add compaction to `_removeFromMesh()` or add `this._pickingDirty` guard.
- Migrate `window.__glyph3dPickingIdCounter` to per-renderer `this._basePickingId` assigned
  at mesh creation time from a module-level counter.

Implementation:
- Add `uniform float basePickingId` to both picking vertex shaders.
- In picking vertex shader: `float vPickingIdF = basePickingId + float(gl_InstanceID)`.
- Picking fragment RGB encoding must match PickingSystem decode: high byte in `r`
  (`r = floor(pid/65536.0)`, `g = floor(mod(pid,65536.0)/256.0)`, `b = mod(pid,256.0)`).
- Remove `instancePickingId` attribute and `registerRenderer()` write loop in PickingSystem
  (~line 227) and the post-flush registration in GlyphCollection (~line 522).

---

## Implementer Vote

**buffer-packing** should implement this plan.

Their Phase 0 analysis has the closest match to the converged plan: exact byte-per-attribute
breakdown with builder source line references, the `_rebuildAllInstances` / `applyPrebuiltBuffers`
dual-path discipline, the `instanceScale` fallback reasoning, and the DataView singleton
pattern for zero-alloc hot paths. The implementation work is primarily about modifying buffer
builder functions and removing attributes from the geometry setup — exactly the terrain
buffer-packing mapped in detail. The gpu-techniques perspective contributed the atlas map
insight and the DataTexture mechanisms, but the majority of the implementation touches
CPU-side buffer management where buffer-packing has the more thorough existing analysis.
