# Round 3: system-architecture convergence

## Settled

All three agents reached consensus on the following points, with rationale:

1. **Atlas map compact resize is the single highest-value change.** Change `GlyphAtlas.getAtlasMapTexture()` to compute `MAX_CP` as `Math.max(...this.uvMap.keys()) + 1` rounded up to the next power of two, rather than covering the full Unicode range. Result: 17 MB → ~152 KB. All three agents agree. Zero shader changes, zero API changes. Ships first.

2. **`_committedTexts` string drop saves ~75 MB at scale.** Replace `text: item.text` with `textLength: item.text.length` in the committed map entry. Ships first alongside #1. Requires a consumer audit before landing — no caller of `_committedTexts.get(id).text` can exist, or must be updated to accept content as a parameter. If `updateText()` reads `.text`, keep the field or change `updateText()` to require content as an argument.

3. **GridVirtualizer before any per-glyph buffer packing.** Virtualization reduces the active renderer count from 1500 to ~50–300, making the per-glyph packing savings compound on a dramatically smaller base. Per-glyph packing on 1500 live renderers yields ~100 MB saved; the same packing on 50 active renderers after virtualization yields ~3 MB. The correct ordering is: virtualization first, packing second.

4. **`getBounds()` world-space return type must be verified before GridVirtualizer lands.** Both reviewing agents flagged this. The `GridVirtualizer` constructs a `THREE.Frustum` in world space; if `CodeGrid.getBounds()` returns local-space coordinates, frustum intersection silently fails. Must confirm the return is a world-space `THREE.Box3` updated after `flushAsync()` completes.

5. **`instanceSize` → `uniform vec2 instanceSizeWorld` saves 4 bytes/glyph (not 8).** All agents agree the uniform path is correct for single-scale renderers. The `item.scale != 1.0` path in `buildBatchBuffers` requires an `instanceScale float` fallback attribute, reducing net savings from 8 bytes to 4 bytes. The Phase A step list must include updating `_updateInstanceMesh()` in `_rebuildAllInstances()`, which reads `g.size.width/height` and writes the sizes attribute — this write must be removed or it throws against the deleted attribute.

6. **`instancePickingId` → `gl_InstanceID + basePickingId` requires a contiguity audit first.** The `gl_InstanceID` derivation is only valid if slots are always contiguous. `_rebuildAllInstances()` compacts on every rebuild, but `removeText()` without a subsequent rebuild leaves gaps. The global persistent counter `window.__glyph3dPickingIdCounter` must be rearchitected to a per-renderer `basePickingId` uniform. This is medium risk, not low. Gate behind a `_isCompact` flag or require full rebuild after any removal.

7. **`instanceAddedColor` → highlight DataTexture using RGBA8, not RGBA32F.** The highlight DataTexture at `RGBA32F` (160 KB) is larger than the attribute it replaces (120 KB). Using `UnsignedByteType` (RGBA8) reduces the texture to 40 KB — an 80 KB saving over current, plus O(1) single-texel updates. This is correct for syntax highlight colors (8-bit precision is sufficient). The group color-blend path proposed in buffer-packing Phase E would break `CodeGrid.highlightRange()`, which operates at character granularity. The DataTexture path is the correct replacement.

8. **GLSL3 upgrade as one atomic commit, touching all 6 shader strings.** The upgrade touches: `GlyphRenderer._getVertexShader()`, `GlyphRenderer._getFragmentShader()`, and four strings in `PickingSystem.js` (`PICKING_VERTEX_CORE`, `PICKING_VERTEX_CELL`, `PICKING_VERTEX_GLYPH`, picking fragment). All must move from `gl_FragColor` → `out vec4`, `varying` → `in`/`out`, `texture2D` → `texture` in a single commit. Do not interleave syntax changes with feature commits.

9. **`instancePosition` stays vec3.** The Z-wrap path in `buildBatchBuffers` (builders/index.js line 325–334) decrements Z by `zWrapSpacing` at each line wrap. A `(line, col)` vec2 cannot encode the Z offset. The vec2 grid-coord proposal is only valid for flat CodeGrid instances with `zWrapSpacing = 0`, and should be documented as a future CodeGrid-specific path, not a general optimization.

10. **Color palette deferred.** Palette requires a new `GlyphCollection` registration API, worker-context palette serialization, and flush-time deduplication. Not justified until atlas map, virtualization, and string retention are addressed. Defer until syntax highlighting is palette-driven end-to-end.

11. **`InstancedBufferAttribute.updateRange` for partial buffer uploads.** Set `attr.updateRange = { offset: slotIndex * itemSize, count: changedCount * itemSize }` before `needsUpdate = true` in `updatePosition()` and `updateColor()`. Limits `gl.bufferSubData` to the changed range instead of re-uploading the full 120 KB attribute. No format change required, compatible with both GLSL1 and GLSL3.

12. **Vertex shader world-position formula has a latent scale bug.** Line 292 of GlyphRenderer.js: `vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz` — group scale multiplies the glyph's *position offset*, not the quad size. A group scale of `(2,2,1)` doubles spacing between glyphs, not their rendered size. Fix before group scale is advertised as a feature: `gScale.xyz` should scale `scaled` (the quad), not `instancePosition`.

---

## Implementation Plan

### Phase 0 — One-line wins (ship immediately, zero pipeline risk)

**Files:** `src/GlyphAtlas.js`, `src/collections/GlyphCollection.js`

1. `GlyphAtlas.getAtlasMapTexture()`: Replace the hardcoded full-Unicode range constant with:
   ```js
   const maxCp = Math.max(...this.uvMap.keys()) + 1;
   const atlasMapHeight = Math.ceil(maxCp / atlasMapWidth);
   ```
   This is two lines changed. Verify the result covers Braille (U+28FF) and box-drawing (U+257F). Update `atlasMapHeight` uniform set in `GlyphRenderer._createInstanceMesh()` to match.

2. `GlyphCollection.js` flush path (~line 508): Remove `text: item.text` from committed map entries. Replace with `textLength: item.text.length`. Audit all reads of `_committedTexts.get(id).text` first — if `updateText()` or any command handler reads this field, update those callers or change `updateText()` to require content as an argument.

### Phase 1 — GridVirtualizer (scene-graph only, no renderer changes)

**Files to create:** `src/services/rendering/GridVirtualizer.js`, `src/services/rendering/SpatialIndex.js`

**Files to modify:** `app/GitHubRepoViewer.js` (registration call), animation loop

- Implement `GridVirtualizer` as designed in phase0-system-architecture §2. Call `virtualizer.update()` before `renderer.render()` in the animation loop.
- Verify `CodeGrid.getBounds()` (CodeGrid.js line 236) returns a world-space `THREE.Box3` after flush. Read the method and confirm the return. If it returns local-space, add a world-space computation using `grid.matrixWorld`.
- Add `SpatialIndex` for O(log N) frustum query (phase0-system-architecture §7). Wire it into `GridVirtualizer.update()` to replace the O(N) loop over all registered grids.

### Phase 2 — Unload/reload and memory budget

**Files to modify:** `src/collections/CodeGrid.js`, `src/collections/GlyphCollection.js`

**Files to create:** `src/services/rendering/MemoryBudget.js`

- Add `CodeGrid.unloadContent()` and `CodeGrid.reloadContent(fetchFn)` as designed in phase0-system-architecture §5.
- Wire `GridVirtualizer._deactivate()` to check budget pressure and call `unloadContent()` when over budget.
- Implement `MemoryBudget` with LRU eviction using `renderer.getMemoryStats().allocatedBytes` as the tracking value. Note: `getMemoryStats()` does not include `groupTextureBytes` in `allocatedBytes` — add it or track separately to avoid under-counting.

### Phase 3 — `updateRange` partial uploads (zero format change)

**Files to modify:** `src/GlyphRenderer.js`

- In `updatePosition()` (~line 483): before `positionAttr.needsUpdate = true`, set `positionAttr.updateRange = { offset: slotIndex * 3, count: 3 }` for single-glyph updates. For bulk updates, set offset/count to cover the full changed range.
- Same pattern in `updateColor()` (~line 522) with `itemSize = 3`.

### Phase 4 — GLSL3 upgrade (atomic commit)

**Files to modify:** `src/GlyphRenderer.js` (vertex + fragment shader strings), `src/picking/PickingSystem.js` (4 shader strings)

- Change all 6 shader strings to GLSL ES 3.00 syntax in a single commit.
- Add `glslVersion: THREE.GLSL3` to the main `ShaderMaterial` in `GlyphRenderer._createInstanceMesh()` and to both picking materials in `PickingSystem.js`.
- Required transformations: `varying` → `in`/`out`, `texture2D` → `texture`, `gl_FragColor` → `out vec4 fragColor`.
- Verify all three examples render correctly before tagging this commit.

### Phase 5 — `instanceSize` → uniform (requires Phase 4)

**Files to modify:** `src/GlyphRenderer.js`, `src/workers/builders/buildBuffers.js`, `src/workers/builders/index.js`

- Add `uniform vec2 instanceSizeWorld` to vertex shader. Set from `this.metrics` at construction.
- Remove `sizes` Float32Array from `_createInstanceMesh()`, `applyPrebuiltBuffers()`, and both builder functions.
- Delete the `sizes[i * 2] = g.size.width` writes in `_updateInstanceMesh()` inside `_rebuildAllInstances()`.
- For renderers with `item.scale != 1.0`: add `instanceScale float` attribute only if this path is confirmed in production use. Check `buildBatchBuffers` line 282 to determine if any caller sets `item.scale != 1.0`. If not used, omit the attribute entirely.
- Net saving: 8 bytes/glyph if no scale variation; 4 bytes/glyph if `instanceScale` fallback is added.

### Phase 6 — Highlight DataTexture (requires Phase 4)

**Files to modify:** `src/GlyphRenderer.js`

- Allocate `THREE.DataTexture(maxInstances, 1, THREE.RGBAFormat, THREE.UnsignedByteType)` instead of the `instanceAddedColor` `InstancedBufferAttribute`.
- Update `setGlyphHighlight()` (~line 578) to write one texel at `slotIndex` and set `texture.needsUpdate = true`.
- In the vertex shader, sample via `texelFetch(highlightTex, ivec2(gl_InstanceID, 0), 0).rgb` (GLSL3 required, hence after Phase 4).
- Result: 40 KB texture vs 120 KB attribute, O(1) per-glyph updates, no full attribute re-upload.

### Phase 7 — `instancePickingId` elimination (requires Phase 4 + contiguity audit)

**Files to modify:** `src/GlyphRenderer.js`, `src/picking/PickingSystem.js`

- Audit whether `removeText()` followed by `addText()` without a rebuild can leave gaps in buffer slots. If yes, add a compaction step to `_removeFromMesh()` or add a `_isCompact` flag that must be true before this optimization activates.
- Reroute `window.__glyph3dPickingIdCounter` to a per-renderer `basePickingId` uniform.
- Remove `registerRenderer()` write loop in PickingSystem.js (~line 227) and the post-flush registration in GlyphCollection.js (~line 522).
- Match the RGB channel order between the new vertex shader encoding and the PickingSystem decode path — confirm which encodes the high byte in which channel and make both sides consistent.

### Phase 8 — Fix vertex shader group scale bug

**Files to modify:** `src/GlyphRenderer.js` (vertex shader string)

- In the world-position formula, move `gScale.xyz` to scale the quad (`scaled`) rather than `instancePosition`. Correct form:
  ```glsl
  vec3 scaledQuad = scaled * gScale.xyz;
  vec3 worldPos = scaledQuad + instancePosition + gPos.xyz;
  ```
  This makes group scale affect rendered glyph size, not glyph spacing. Verify with a test group scale of `(2,2,1)` in the browser examples.

---

## Implementer Vote

**Vote: buffer-packing**

Rationale: The remaining implementation work is concentrated in `GlyphRenderer.js` — removing the `sizes` attribute, wiring the highlight DataTexture, updating the `_rebuildAllInstances` path, and modifying the vertex shader uniform. buffer-packing's Phase 0 contains the most precise source-line references for these exact paths (buildBatchBuffers line 282, `_updateInstanceMesh` line 1179, `applyPrebuiltBuffers`, sizes array removal), and the DataView/typed-array zero-allocation patterns it proposed are directly applicable to the highlight texture write path. The system-architecture Phase 0 code (GridVirtualizer, MemoryBudget, SpatialIndex) is already fully specified and can be implemented by anyone reading the design; the renderer-internal changes are where buffer-packing's detailed knowledge of the buffer layout and builder code is most valuable.
