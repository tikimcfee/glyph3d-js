# Round 3: buffer-packing convergence

## Settled

All three agents reached the same ordering and mechanism on every contested point.
Rationale is brief because Round 1 produced clean resolution with no Round 2 needed.

1. **Atlas map compact resize is item one.** `GlyphAtlas.getAtlasMapTexture()` computes height
   from `0x110000` (full Unicode). Replacing that constant with
   `Math.ceil(Math.max(...this.uvMap.keys()) + 1)` rounded up to the next power of two saves
   17+ MB, requires zero shader changes, and is independent of every other item on this list.
   All three agents ranked this highest-value, lowest-risk. Implement it first.

2. **`_committedTexts` string drop is item two.** `GlyphCollection.flush()` stores
   `text: item.text` in the committed map. Replacing that field with `textLength: item.text.length`
   saves ~75 MB heap at 1500 files. One line. No rendering impact. Must audit all reads of
   `.text` on committed entries first — the only known consumer is a hypothetical `updateText()`
   rebuild; if that method exists it must receive content as a parameter, not read it back.

3. **`GridVirtualizer` before per-glyph packing.** At 1500 active renderers the dominant cost
   is the CPU+GPU buffer mirrors (~672 MB). A per-glyph reduction from 56 to 22 bytes on 1500
   live renderers yields ~580 MB; the same reduction on 50 visible renderers (post-virtualizer)
   yields ~19 MB. Frustum virtualization at the CodeGrid/scene-graph level compounds all packing
   work done after it. `mesh.frustumCulled = false` (GlyphRenderer.js:239) means per-mesh culling
   cannot help; the virtualizer must operate at Object3D level.

4. **`instanceSize` → `instanceSizeWorld` uniform, with `instanceScale` float fallback.**
   `buildBatchBuffers` writes identical `scaledWidth/Height` for every glyph in an item; these
   are proper uniform candidates. But `item.scale != 1.0` per-item support in `buildBatchBuffers`
   line 282 breaks a bare uniform. Resolution: add `uniform vec2 instanceSizeWorld` and keep a
   `attribute float instanceScale` for the non-1.0 case. Net saving is 4 bytes (not 8). Must also
   update `_updateInstanceMesh()` (GlyphRenderer.js line 1179) which writes the size attribute
   directly — this method was absent from the Phase 0 step list and is a required stop.

5. **GLSL3 upgrade as a single atomic commit.** `gl_InstanceID`, `floatBitsToUint`, and
   `texelFetch` all require GLSL ES 3.00. The upgrade touches 6 shader strings: vertex + fragment
   in `GlyphRenderer._getVertexShader()/_getFragmentShader()`, and four picking shader string
   literals in `PickingSystem.js` (`PICKING_VERTEX_CORE`, `PICKING_VERTEX_CELL`,
   `PICKING_VERTEX_GLYPH`, fragment strings). Changes are mechanical (`varying` → `in/out`,
   `texture2D` → `texture`, `gl_FragColor` → `out vec4`). Set `glslVersion: THREE.GLSL3` on
   both the main ShaderMaterial and both picking materials. Do this as one commit, verify all
   examples, then proceed to attribute elimination.

6. **`instancePickingId` → `basePickingId + gl_InstanceID`, after contiguity audit.**
   The derivation is only valid if `gl_InstanceID` maps to the same slot order as the existing
   picking ID assignment. `_rebuildAllInstances()` re-packs on every rebuild (slots are
   contiguous after rebuild). The gap risk is: `removeText()` followed by `addText()` without
   a full rebuild can leave vacated slots. Audit `_removeFromMesh()` and confirm a rebuild is
   always triggered after any removal, or add a compaction step. Once verified: add
   `pickingBaseId` uniform to picking materials, replace the attribute read, remove the
   `registerRenderer()` write loop (PickingSystem.js:227–229) and the post-flush registration
   step in GlyphCollection.js. The global `window.__glyph3dPickingIdCounter` becomes a
   per-renderer `basePickingId` uniform set before each picking pass.

7. **`instanceAddedColor` → RGBA8 highlight DataTexture, not group color-blend.**
   Phase E in Phase 0 listed group color-blend as the primary path. That is wrong: group
   color-blend is coarser than per-character and would break `CodeGrid.highlightRange()` /
   `setGlyphHighlight()` (GlyphRenderer.js:578). The correct mechanism is a 1D DataTexture
   of width=maxInstances, `RGBAFormat`, `UnsignedByteType` (RGBA8, 40 KB at 10K glyphs vs.
   the current 120 KB Float32 attribute — an 80 KB saving). `setGlyphHighlight()` writes one
   texel and sets `texture.needsUpdate`. The vertex shader samples via
   `texelFetch(highlightTex, ivec2(gl_InstanceID, 0), 0)` (requires GLSL3, see item 5).

8. **`instancePosition` stays vec3.** The gpu-techniques grid-coord vec2 proposal is invalid
   for the general case: Z-wrap in `buildBatchBuffers` (lines 326–333) emits negative Z offsets
   that a `(line, col)` encoding cannot represent. 12 bytes, unchanged.

9. **Color palette deferred.** `instanceColor` packing to uint8 (Phase D) and a palette texture
   approach both require either `floatBitsToUint` (GLSL3, settled above) or fract/mod workarounds.
   More importantly, the benefit of palette indirection only materializes once syntax highlighting
   assigns colors per-token-type rather than per-glyph. Audit `highlightCommands.js` and the
   builder first. Defer until syntax highlighting is palette-driven.

10. **`InstancedBufferAttribute.updateRange` for partial re-uploads.** Not a layout change, but
    a pure performance improvement to existing write paths. `updatePosition()` and `updateColor()`
    (GlyphRenderer.js:483, 522) set `needsUpdate = true` on the full array. Setting
    `attr.updateRange = { offset: slotIndex * itemSize, count: n * itemSize }` before the flag
    limits `gl.bufferSubData` to the changed region. Zero risk, no shader changes, works on both
    GLSL1 and GLSL3 paths.

---

## Implementation Plan

### Phase 0 — One-line wins (ship immediately, no render pipeline risk)

**File: `src/GlyphAtlas.js`**
- In `getAtlasMapTexture()`, replace the hardcoded `Math.ceil(0x110000 / 1024)` height constant
  with `Math.ceil(nextPowerOfTwo(Math.max(...this.uvMap.keys()) + 1) / ATLAS_MAP_WIDTH)`.
  Add a module-level helper `function nextPowerOfTwo(n) { let p = 1; while (p < n) p <<= 1; return p; }`.
  Verify the max codepoint in `_buildCharset()` stays below the computed ceiling — log a warning
  if not.

**File: `src/collections/GlyphCollection.js`**
- In `flush()`, locate the committed-map entry construction (~line 508–514).
  Replace `text: item.text` with `textLength: item.text.length`.
  Audit all `_committedTexts.get(id).text` reads in the file and replace with callers receiving
  text as a parameter. If `updateText()` exists and reads `.text`, update its signature.

### Phase 1 — `GridVirtualizer` (scene-graph level, no shader changes)

**New file: `src/collections/GridVirtualizer.js`**
- Constructor accepts `THREE.Camera` + `THREE.Scene` reference.
- `register(grid)` stores CodeGrid references with their current `getBounds()` Box3.
  Verify `CodeGrid.getBounds()` (CodeGrid.js:236) returns world-space Box3 after flush.
- `update()` called each frame: build `THREE.Frustum` from camera, test each grid's Box3,
  call `grid.setVisible(true/false)` or `grid.unloadContent()`/`grid.reloadContent()` based
  on a budget guard.
- Wire into `GlyphRenderer` via the existing `MemoryBudget` / LRU pattern from system-architecture.

**File: `src/collections/CodeGrid.js`**
- Add `unloadContent()`: dispose geometry, release `Float32Array` buffers, mark as unloaded.
- Add `reloadContent()`: re-run `loadText()` / `loadTextAsync()` path, re-flush.

### Phase 2 — `instanceSize` → uniform (4 bytes saved per glyph)

**File: `src/GlyphRenderer.js`**
- In `_getVertexShader()`: remove `attribute vec2 instanceSize;`, add `uniform vec2 instanceSizeWorld;`,
  replace `position * vec3(instanceSize, 1.0)` with `position * vec3(instanceSizeWorld, 1.0)`.
  For non-1.0 scale: add `attribute float instanceScale; uniform vec2 instanceSizeWorld;` and
  compute `instanceSizeWorld * instanceScale` in the vertex shader.
- In `_createInstanceMesh()`: remove the `sizes` attribute allocation; add `instanceSizeWorld`
  uniform to the material; conditionally add `instanceScale` attribute.
- In `_updateInstanceMesh()` (~line 1179): remove the `sizes[i*2]` write; write `instanceScale`
  only when `item.scale != 1.0`.
- In `applyPrebuiltBuffers()`: remove `sizes` destructuring.

**File: `src/workers/builders/index.js`**
- In `buildGlyphBuffers()` and `buildBatchBuffers()`: remove `sizes` array allocation and hot-loop
  writes. Drop `sizes` from return objects. If `item.scale != 1.0` is encountered, emit
  `scales: Float32Array` instead.

**File: `src/collections/GlyphCollection.js`**
- Update `flush()` and `flushAsync()` to not pass `buffers.sizes` to `applyPrebuiltBuffers`.

### Phase 3 — GLSL ES 3.00 upgrade (atomic commit, no attribute changes)

**File: `src/GlyphRenderer.js`** (methods `_getVertexShader()`, `_getFragmentShader()`)
- Add `#version 300 es` preamble (Three.js injects this via `glslVersion: THREE.GLSL3`).
- `varying` → `out` (vertex) / `in` (fragment).
- `texture2D(...)` → `texture(...)` in all sampler calls.
- `gl_FragColor` → `out vec4 fragColor; ... fragColor = ...`.
- Add `glslVersion: THREE.GLSL3` to the `ShaderMaterial` constructor call.

**File: `src/picking/PickingSystem.js`**
- Apply the same mechanical translation to all four inline shader string literals
  (`PICKING_VERTEX_CORE`, `PICKING_VERTEX_CELL`, `PICKING_VERTEX_GLYPH`, and the fragment string).
- Add `glslVersion: THREE.GLSL3` to both picking `ShaderMaterial` constructors.
- Verify all examples render after this commit before proceeding.

### Phase 4 — `instancePickingId` elimination (4 bytes saved, after contiguity audit)

**Pre-work:** Audit `_removeFromMesh()` in `GlyphRenderer.js`. Confirm a rebuild is triggered
after any text removal before `addText()` can assign a new slot. If not, add a `this._needsCompaction`
flag and a compaction step at the top of `_rebuildAllInstances()`.

**File: `src/GlyphRenderer.js`**
- Remove `instancePickingId` attribute from `_createInstanceMesh()` and `applyPrebuiltBuffers()`.
- In `_getVertexShader()`: remove `attribute float instancePickingId;`, add
  `uniform float pickingBaseId;`.

**File: `src/picking/PickingSystem.js`**
- Replace `vPickingId = instancePickingId` with `vPickingId = pickingBaseId + float(gl_InstanceID)`.
- Remove the `registerRenderer()` write loop (~lines 227–229).
- Add `pickingBaseId` uniform to picking materials; set it to the renderer's base ID before each pass.
- Replace `window.__glyph3dPickingIdCounter` with per-renderer `basePickingId` tracking.

**File: `src/collections/GlyphCollection.js`**
- Remove the post-flush `PickingSystem.registerRenderer()` call (~line 522–524).

### Phase 5 — `instanceAddedColor` → RGBA8 highlight DataTexture (80 KB saved per mesh)

**File: `src/GlyphRenderer.js`**
- Remove `instanceAddedColor` attribute allocation in `_createInstanceMesh()` and `applyPrebuiltBuffers()`.
- Allocate `this._highlightTexture = new THREE.DataTexture(new Uint8Array(maxCount * 4), maxCount, 1, THREE.RGBAFormat, THREE.UnsignedByteType)`.
  Initialize to zeros. Add as `highlightTex` uniform on the material.
- In `setGlyphHighlight(slotIndex, color)` (~line 578): write 4 bytes at `slotIndex * 4` in
  `this._highlightTexture.image.data`; set `this._highlightTexture.needsUpdate = true`.
- In `_getVertexShader()`: remove `attribute vec3 instanceAddedColor; varying vec3 vAddedColor;`.
  Add `uniform sampler2D highlightTex;`. In `main()`:
  `vec3 vAddedColor = texelFetch(highlightTex, ivec2(gl_InstanceID, 0), 0).rgb / 255.0;`
  (requires GLSL3 from Phase 3).
- In `_getFragmentShader()`: remove `varying vec3 vAddedColor;`, inline the additive term.

### Phase 6 — `updateRange` partial re-uploads (no layout change)

**File: `src/GlyphRenderer.js`**
- In `updatePosition(id, position)` (~line 483): after computing `startIdx`, set
  `attr.updateRange = { offset: startIdx * 3, count: glyphCount * 3 }` before `needsUpdate = true`.
- In `updateColor(id, color)` (~line 522): same pattern with `offset: startIdx * 3, count: glyphCount * 3`.

---

## Implementer Vote

**Vote: gpu-techniques agent.**

The Phase 3 GLSL3 upgrade and Phase 4 picking ID elimination are the highest-complexity
implementation steps remaining, and gpu-techniques produced the most thorough analysis of
exactly those two surfaces — enumerating all six shader strings, identifying the
`window.__glyph3dPickingIdCounter` global as the rearchitecture target, and specifying the
`texelFetch` indexing layout. The gpu-techniques agent's Phase 0 is also the origin of the
atlas map insight (item one above, the single highest-value change), which signals that agent
is tracking GPU-side memory allocation most precisely. The work in Phases 3–5 is GPU-pipeline
work, which matches that agent's declared domain.

The Phase 0 and Phase 1 quick wins (atlas map resize, string drop, GridVirtualizer) are
system-architecture territory, but those are thin enough that any agent can execute them from
the settled plan above without further analysis.
