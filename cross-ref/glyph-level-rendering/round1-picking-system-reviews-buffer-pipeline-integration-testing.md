# Round 1: picking-system reviews buffer-pipeline, integration-testing

## Errors Found

### buffer-pipeline: `instanceBufferIndex` vs `gl_InstanceID` — incomplete analysis

buffer-pipeline correctly rejects `instanceBufferIndex` as a buffer attribute and cites `gl_InstanceID` instead (section 6, final paragraph). This is sound. However, the document also includes `instanceBufferIndex` in the Phase 1 header of integration-testing's dependency graph (section 1 of that doc, "Phase 1: instanceBufferIndex"). The buffer-pipeline doc never defines an `instanceBufferIndex` attribute — it defines `instancePickingId` instead. These two documents use different names for the same concept with no reconciliation.

Concretely: integration-testing's Phase 1 self-test snippet (section 2) reads `geometry.attributes.instanceBufferIndex` — an attribute that neither document actually adds to `_createInstanceMesh()`. If implemented as written, this test will throw `Cannot read properties of undefined (reading 'array')` on line 4 of that snippet.

### picking-system: vertex shader visibility trick is broken GLSL

The picking vertex shader (section 2) uses `gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, visible)` where `visible` is `0.0` for hidden groups, intending to collapse the triangle. Setting `w=0` does not discard the primitive — it creates a degenerate position at the far clip plane and triggers a perspective divide by zero, which is undefined in GLSL ES. The correct technique is to push the position behind the far plane: `gl_Position = vec4(0.0, 0.0, 2.0, 1.0)` when invisible, or use `if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }`.

### picking-system: `readAtMouse()` reads after `renderPickingPass()` sets target back to null

In section 4's `readAtMouse()` implementation and the render loop example (section 9), the call order is:
```javascript
pickingSystem.renderPickingPass(camera);  // sets target, renders, sets target back to null
const pickingId = pickingSystem.readAtMouse();  // sets target again, reads, sets back to null
```
`renderPickingPass()` ends with `this._renderer.setRenderTarget(null)`. Then `readAtMouse()` starts with `this._renderer.setRenderTarget(this._target)` before the `gl.readPixels` call. This is correct — the readback is from the texture, not from what is currently bound. But the section 4 standalone `readAtMouse()` snippet does the same double set-and-restore, which is redundant and adds two extra `setRenderTarget` calls per frame. Minor, but a production implementation should consolidate into a single bound state.

### integration-testing: `pickingId` encoding described but never specified

Section 3 states: "The picking color encodes `pickingId` in the high bits and `bufferIndex` in the low bits of the RGBA value." No bit layout is given. This conflicts with picking-system, which uses a pure 24-bit `instancePickingId` globally unique per slot with no `pickingId` / `bufferIndex` split. A reader implementing section 3 of integration-testing would build a different and incompatible encoding than picking-system's section 2.

### buffer-pipeline: `pickingIds[idx]` indexing is wrong in `buildBatchBuffers()`

buffer-pipeline section 3, batch path:
```js
pickingIds[idx] = itemPickingIdBase > 0 ? itemPickingIdBase + (idx - itemStartOffset) : 0;
```
`idx` here is the global glyph counter across all items. `itemStartOffset` is not defined in the diff snippet — it must be the per-item glyph start within the combined buffer. The name is never introduced in the surrounding context shown, making this snippet non-functional as written without inferred context. The corresponding single-text version uses `pickingIds[idx] = pickingIdBase + idx`, which is also wrong for the batch case because `idx` resets to 0 at each item but `pickingIdBase` is a global offset. The picking-system's `registerRenderer()` approach avoids this problem entirely by assigning IDs after the buffer is built.

---

## Gaps

### What buffer-pipeline covers that picking-system and integration-testing miss

- `updateAddedColor()` direct-write API with no rebuild (section 7D) — neither other document defines the per-frame highlight update path.
- The `|| new Float32Array(...)` backward-compatibility fallback in `applyPrebuiltBuffers()` for old worker results — important for incremental rollout.
- Explicit accounting of the 400 KB → 560 KB memory change with per-config numbers.

### What picking-system covers that integration-testing misses

- `resolveGlyph()` walking `renderedTexts` by `bufferStartIndex` to map `slotIndex → { textId, charIndex }` (section 4). Integration-testing's Phase 4 pipeline sketch assumes this mapping exists but never defines it.
- The debug overlay using a fullscreen NDC plane with `depthTest: false` (section 6) — integration-testing describes the same overlay but as a corner thumbnail, with no implementation sketch.
- Resolution scaling and the `onResize()` hook — integration-testing does not mention the resize case at all.

### What integration-testing covers that picking-system misses

- Buffer index stability across flushes (section 10, second risk): if `_rebuildAllInstances()` is called after removing a text entry, all slot indices shift. `SemanticInfoMap` becomes stale. picking-system has no invalidation mechanism in its `registerRenderer()` / registry design — the registry stores `startId + count` and would return wrong results after a partial removal.
- The `window.__pickingIdCounter` hot-reload persistence trick (section 10, fourth risk) — a real problem in dev that picking-system's module-level counter doesn't handle.
- `SemanticInfoMap` as a pure data structure with O(1) lookup (section 6) — not addressed in either picking-system or buffer-pipeline.

### What all three agents miss

The `GlyphCollection` creates its renderer lazily on first `flush()` (GlyphCollection.js line 61). `PickingSystem.registerRenderer()` must be called after flush, but the collection's `_renderer` field is not public. None of the documents define how the app layer gets a reference to the internal renderer after flush to pass to `registerRenderer()`. A `getRenderer()` accessor on `GlyphCollection` is needed but not mentioned anywhere.

---

## Tensions

### Tension 1: Global sequential IDs (picking-system) vs. per-renderer IDs + grid discriminator (integration-testing)

picking-system assigns globally unique IDs across all renderers via a `_nextPickingId` counter (section 5). Each slot in the picking texture encodes a single integer that uniquely identifies a glyph across all renderers.

integration-testing describes encoding `pickingId` (renderer discriminator) in the high bits and `bufferIndex` in the low bits (section 3). This is a two-field packed encoding.

These are mutually exclusive. The picking vertex shader in picking-system writes `instancePickingId` — a single integer per slot. The fragment shader encodes it as 24-bit RGB. Under integration-testing's scheme you would need either a wider encoding (32 bits, requiring FLOAT render target) or a more restricted bit split (e.g., 12 bits renderer / 12 bits slot = 4096 renderers × 4096 slots, which is too small).

**picking-system's approach is correct.** Global sequential IDs with a registry that maps ranges to renderers are simpler, unambiguous, and fit in 24-bit RGB with room for 16M glyphs. The integration-testing encoding introduces a fragile bit split with no defined boundary.

### Tension 2: `instanceBufferIndex` as a buffer attribute (integration-testing Phase 1) vs. `gl_InstanceID` (buffer-pipeline)

integration-testing Phase 1 treats `instanceBufferIndex` as a physical attribute that must be written to the geometry and verified via `attr.array[i] === i`. buffer-pipeline correctly eliminates it: GLSL ES 3.0 provides `gl_InstanceID` at zero CPU cost.

**buffer-pipeline is correct.** The Phase 1 self-test as written in integration-testing tests an attribute that should not exist. The Phase 1 test should instead verify that `instancePickingId` is present, non-zero for pickable instances, and sequential within each renderer's ID block.

### Tension 3: `instancePickingId` assigned at build time (buffer-pipeline) vs. assigned at registration time (picking-system)

buffer-pipeline has the caller pass `pickingIdBase` per text entry during `addText()`, which flows through the worker builder and is baked into the buffer during flush. picking-system assigns IDs inside `registerRenderer()` after the buffer is already built, writing a new `instancePickingId` attribute at that point.

These two designs are structurally incompatible: buffer-pipeline's approach requires the caller to know the global picking ID range before flushing; picking-system's approach derives IDs only after the renderer exists.

**picking-system's approach is correct.** The `pickingIdBase` field in buffer-pipeline forces a coordination point between the app layer and the worker builders that does not exist today. picking-system's `registerRenderer()` writes the `instancePickingId` buffer after flush, which is the only point where `geometry.instanceCount` is known and stable. This keeps the builder pure.

---

## Recommendations

1. **Remove `instanceBufferIndex` from integration-testing Phase 1.** Replace the Phase 1 self-test with a check that `instancePickingId` exists and is globally sequential after `PickingSystem.registerRenderer()` is called. The attribute name `instancePickingId` should be used consistently across all three documents.

2. **Fix the visibility suppression in the picking vertex shader.** Replace `vec4(worldPos, visible)` with an explicit branch: `if (visible < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }`. This is safe GLSL and avoids the w=0 divide-by-zero.

3. **Add `getRenderer()` to `GlyphCollection`.** The `_renderer` field is created lazily inside `flush()` (GlyphCollection.js line 61) and is not accessible externally. The app layer needs it to call `pickingSystem.registerRenderer()`. A simple public getter is sufficient.

4. **Define registry invalidation in picking-system.** When `GlyphCollection.flush()` is called again (e.g., after a text removal), the geometry is rebuilt and instance counts change. Add `PickingSystem.unregisterRenderer(glyphRenderer)` and call it from `GlyphCollection.flush()` before re-registering. Without this, the registry holds stale ranges and `resolve()` returns wrong results.

5. **Remove `pickingIdBase` from buffer-pipeline's worker builder design.** Picking IDs are assigned at registration time, not build time. Removing `pickingIdBase` from `buildGlyphBuffers()` and `buildBatchBuffers()` keeps the builders pure and avoids requiring the caller to pre-coordinate global ID ranges. The `instancePickingId` attribute is written by `PickingSystem.registerRenderer()`, not by the builders.

6. **Adopt picking-system's global sequential ID scheme exclusively.** Drop integration-testing's "pickingId in high bits / bufferIndex in low bits" encoding. It is underdefined, would require a wider render target for scenes with many renderers, and is redundant given the registry.

7. **Consolidate the `readAtMouse()` + `renderPickingPass()` into a single `updateAndRead()` call.** Eliminate the extra `setRenderTarget` round-trips. Call sequence: set target → clear → render → `gl.readPixels` → set target null → return id.

8. **Add `SemanticInfoMap.invalidate()` tied to flush events.** integration-testing correctly identifies that buffer slot indices shift after `_rebuildAllInstances()`. The `populate()` call must be wired to flush completion. Define this as a contract in the integration-testing Phase 1 section, not deferred to Phase 4.

9. **Store the `window.__pickingIdCounter` persistence in `PickingSystem` constructor.** Use `window.__glyph3dPickingIdCounter = (window.__glyph3dPickingIdCounter || 0)` and assign to `this._nextPickingId`. This is a one-line change that prevents stale picks on hot-reload.

10. **Clarify the `instanceCodepoint` attribute in buffer-pipeline's table.** The table in section 1 lists it but it is absent from the "new buffer layout" table in section 2. A reader comparing both tables will wonder if codepoints were removed. Add a note that `instanceCodepoint` is unchanged.

---

## Key Insight

The three designs agree on the destination — GPU-side picking with per-glyph ID readback — but are building toward it from three different coordinate systems: buffer-pipeline starts from the data layout and works up, integration-testing starts from the test outcomes and works down, and picking-system starts from the render target and works outward. The critical structural flaw is that none of them has defined the invalidation lifecycle: when `GlyphCollection.flush()` is called a second time (on file reload, on text removal, on any dynamic update), every picking registry entry, every `instancePickingId` buffer, and every `SemanticInfoMap` built against the old buffer indices becomes wrong simultaneously. The implementation order that makes this safe is: (1) flush geometry, (2) unregister old renderer from picking system, (3) re-register with new counts to get new ID block, (4) write new `instancePickingId` attribute, (5) repopulate `SemanticInfoMap` with new glyph offsets. None of the three documents describe this sequence end-to-end, and the picking vertex shader, registry, and semantic map will silently produce wrong results on any scene that is not static from initialization to teardown.
