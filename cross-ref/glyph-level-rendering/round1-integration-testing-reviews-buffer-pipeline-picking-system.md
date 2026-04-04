# Round 1: integration-testing reviews buffer-pipeline, picking-system

## Errors Found

### 1. Picking vertex shader uses wrong world-position formula

picking-system `section 2` vertex shader:
```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

Actual vertex shader (`GlyphRenderer.js` line 285):
```glsl
vec3 worldPos = scaled + instancePosition * gScale.xyz + gPos.xyz;
```

These match, so the position formula is correct. However the picking shader drops the
`atlasMapTexture` and `atlasMapWidth`/`atlasMapHeight` uniforms — these are declared in
the main shader. The picking material in `registerRenderer()` only supplies `groupTexture`
and `groupTextureHeight` (`picking-system section 9`). The picking vertex shader does not
sample the atlas map, which is fine because it does not need UV output, so no uniform
mismatch error will occur. This is correct.

### 2. buffer-pipeline `updateAddedColor()` assumes `entry.glyphs` is populated on the worker path

`buffer-pipeline section 7D` proposes:
```js
for (let i = 0; i < entry.glyphs.length; i++) {
    const bufIdx = (startIdx + i) * 3;
    arr[bufIdx] = r; ...
}
```

After the worker path runs `applyPrebuiltBuffers()`, `entry.glyphs` is reconstructed
as a plain `Array` (`GlyphRenderer.js` line 1178). Its `.length` equals `meta.glyphCount`
from `itemMeta`. This is correct — `glyphs` is populated on the worker path too, so
`entry.glyphs.length` is safe. No bug, but the author didn't verify this.

### 3. picking-system `resolve()` does a linear scan — mischaracterized as acceptable

`picking-system section 4` presents a linear scan through `this._registry` as the
resolution path. With 50+ `GlyphCollection` instances (the github-viewer loads one per
file) this is an O(N) walk at 60fps. This is not flagged as a performance concern. At 50
renderers it is negligible, but at 500 (a large repo) it accumulates. Should be noted.

### 4. picking-system `registerRenderer()` writes `instancePickingId` by replacing the attribute

`picking-system section 9`, inside `registerRenderer()`:
```js
geom.setAttribute('instancePickingId',
    new THREE.InstancedBufferAttribute(ids, 1));
```

This replaces any `instancePickingId` attribute that `_createInstanceMesh()` already
pre-allocated via `buffer-pipeline section 7A`. The pre-allocated buffer is discarded.
This means calling `registerRenderer()` after `applyPrebuiltBuffers()` would also discard
the worker-provided picking IDs just written. The two agents have not coordinated on who
owns the `instancePickingId` buffer: buffer-pipeline says the builder emits it; picking-
system says `registerRenderer()` constructs it from scratch. Both cannot be correct. The
picking-system approach also assigns IDs sequentially from `this._nextPickingId`, which
differs from the `pickingIdBase + localIndex` scheme in buffer-pipeline.

### 5. buffer-pipeline line-count claims are stale

buffer-pipeline states `_getVertexShader()` starts at line 251 and attribute declarations
are at lines 258-259. In the actual file, `_getVertexShader()` is at line 251 but the
attribute declarations (`attribute vec3 instancePosition`, etc.) are at lines 255-259 —
off by a few lines. `_getFragmentShader()` is at line 320, not 320 as claimed — this one
matches. The `applyPrebuiltBuffers()` destructure is at line 1122 (claimed); that is
accurate.

---

## Gaps

### What buffer-pipeline covered that others missed

- Explicit `Float32Array` allocation sizes and per-glyph byte counts with arithmetic
  showing the +40% memory increase. Concrete and verifiable.
- `gl_InstanceID` as a zero-cost substitute for `instanceBufferIndex`. Neither picking-
  system nor integration-testing used this insight; they independently proposed separate
  attributes. Buffer-pipeline's approach saves 4 bytes/glyph and eliminates a CPU write.
- The `|| new Float32Array(...)` fallback in `applyPrebuiltBuffers()` for backward
  compatibility with pre-upgrade workers.
- `uint8` packed color analysis: correctly rejected due to GLSL `normalized` complexity.

### What picking-system covered that others missed

- Async PBO readback path (`gl.getBufferSubData` + fence sync) — explicitly missing from
  integration-testing's risk section, which only mentioned throttling.
- `pickingResolutionScale` option with concrete rationale (0.5× halves target memory,
  doesn't affect single-pixel read accuracy).
- Shared-geometry parallel picking mesh approach (picking-system section 5) avoids
  duplicating geometry data. Integration-testing did not describe how the picking mesh
  would be structured.
- Correct handling of invisible groups in the picking pass: the `visible` w=0 trick
  avoids `discard` in the fragment stage and is cheaper.

### What integration-testing covered that others missed

- Buffer index instability across flushes: if a `GlyphCollection` is rebuilt (file reload),
  all `SemanticInfoMap` glyph indices become stale. Neither other agent named this risk.
- `window.__pickingIdCounter` persistence across hot-reload to prevent picking ID
  collisions between dev cycles.
- Phase 3 can be developed and visually tested before Phase 2 is complete (hard-coded
  index stub). Neither other agent noted this parallelism.
- `populate()` must be called inside the flush completion callback, not once at load.

### Mutual gap across all three agents

None of the three agents addressed what happens when `_rebuildAllInstances()` is called
after `registerRenderer()` has already assigned picking IDs. A rebuild discards the
`entry.glyphs`-derived buffer layout and re-computes `bufferStartIndex`. If picking IDs
were written to buffer slot positions derived from the previous `bufferStartIndex`, the
IDs are now at wrong slots. This is the same instability risk integration-testing
identified for SemanticInfoMap, but it also affects the picking ID buffer itself. It
requires that `registerRenderer()` (or whatever assigns IDs) is called after every
rebuild, not just once at init.

---

## Tensions

### Tension 1: Who constructs the `instancePickingId` buffer?

buffer-pipeline says the worker builder (`buildBatchBuffers`) emits a `pickingIds`
`Float32Array` and `applyPrebuiltBuffers()` sets it as an attribute directly (section 5).

picking-system says `registerRenderer()` constructs the buffer by allocating
`new Float32Array(count)` and filling it from `this._nextPickingId` (section 9).

These are mutually exclusive. If both run, the last one wins and the other's data is
discarded.

**Correct position: picking-system's `registerRenderer()` approach.** The worker builder
cannot know the global picking ID offset assigned by `PickingSystem._nextPickingId` —
that counter lives in the PickingSystem singleton, which the worker has no access to.
Emitting `pickingIds` from the builder requires passing a `pickingIdBase` parameter into
the worker job, which adds coupling and requires the caller to pre-allocate the ID range
before dispatch. The picking-system's post-flush assignment is cleaner: after buffers are
applied, `registerRenderer()` claims a block and writes the buffer. The buffer-pipeline
plan for builder-emitted picking IDs should be removed. The `instancePickingId` attribute
should be a pre-allocated zeros array (set in `_createInstanceMesh`) that picking-system
fills after registration.

### Tension 2: `instanceBufferIndex` as attribute vs. `gl_InstanceID`

buffer-pipeline correctly identifies that `gl_InstanceID` (GLSL ES 3.0, available in
WebGL 2) gives the per-instance slot index for free and recommends dropping
`instanceBufferIndex` as a CPU-side buffer (section 2, "gl_InstanceID decision").

integration-testing's Phase 1 plan proposes adding `instanceBufferIndex` as a new
`InstancedBufferAttribute` and validating `attr.array[i] === i` in the browser
(section 2). This Phase 1 plan only makes sense if the attribute exists.

**Correct position: buffer-pipeline.** `gl_InstanceID` is the right mechanism. The
integration-testing Phase 1 self-test (`attr.array[i] === i`) should be rewritten to
verify that `gl_InstanceID`-based resolution (via the picking ID buffer) returns the
expected slot. The `instanceBufferIndex` attribute should not be added; it is redundant
and costs 40 KB at 10K instances.

---

## Recommendations

1. **Remove `pickingIds` from builder output.** Delete `pickingIds` from
   `buildGlyphBuffers()` and `buildBatchBuffers()` return shapes. Picking ID assignment
   belongs in `PickingSystem.registerRenderer()` after `applyPrebuiltBuffers()` completes.

2. **Pre-allocate `instancePickingId` as zeros in `_createInstanceMesh()`.** Add it
   alongside the existing five attributes in the `!skipPrealloc` block. This lets
   `applyPrebuiltBuffers()` skip it entirely; `registerRenderer()` fills it after.

3. **Call `registerRenderer()` inside `GlyphCollection.flush()` completion, not at init.**
   After `_rebuildAllInstances()` or `applyPrebuiltBuffers()` returns, call
   `pickingSystem?.registerRenderer(this._renderer, this._id)`. This must re-run on every
   rebuild, not once, to keep IDs consistent with `bufferStartIndex`.

4. **Replace integration-testing Phase 1 test with a picking-ID round-trip test.** Drop
   the `instanceBufferIndex` attribute plan. The Phase 1 self-test should instead verify
   that `PickingSystem.resolve(pickingSystem.readAtMouse())` returns a non-null object
   when the mouse is over a known glyph (seeded position, static camera). This is a
   stronger test that covers both the buffer and the readback in one step.

5. **Add a rebuild guard to `PickingSystem`.** After any call to `_rebuildAllInstances()`
   or `applyPrebuiltBuffers()`, invalidate the existing registry entry for that renderer
   (by renderer identity) and re-register. Add a `deregisterRenderer(glyphRenderer)`
   method that removes from `_registry` and subtracts its count from `_nextPickingId` — or
   more simply, compact the registry and re-number on deregister.

6. **Document the `skipPrealloc` path for picking.** When `GlyphRenderer` is constructed
   with `skipPrealloc: true` (the worker path), the pre-allocated `instancePickingId`
   attribute will not exist until `applyPrebuiltBuffers()` sets it. `registerRenderer()`
   must tolerate being called before `applyPrebuiltBuffers()` (it won't — it needs
   `geometry.instanceCount`). Document that `registerRenderer()` must be called after
   buffer application on the worker path.

7. **Reorder the picking render pass.** picking-system section 9 shows:
   ```js
   pickingSystem.renderPickingPass(camera);
   const pickingId = pickingSystem.readAtMouse();
   threeRenderer.render(mainScene, camera);
   ```
   `readAtMouse()` calls `gl.readPixels` immediately after `renderPickingPass()`. This
   guarantees a GPU sync stall. Move the read to the top of the *next* frame's loop body
   (before the next picking pass) to overlap GPU work with CPU processing.

8. **Wire the `onResize()` call.** picking-system provides `PickingSystem.onResize()` but
   the render loop sketch does not wire it to the canvas resize event. Add:
   ```js
   window.addEventListener('resize', () => pickingSystem.onResize());
   ```
   Without this, the picking target stays at the original viewport size after window
   resize, causing coordinate mapping errors.

9. **Buffer-pipeline `updateAddedColor()` needs a per-glyph overload.** The proposed API
   (`updateAddedColor(id, color)`) sets all glyphs for a text entry to the same color.
   Token highlighting (Phase 4) needs to highlight a sub-range of glyphs within one text
   entry (e.g., one identifier inside a line of code). Add:
   ```js
   setGlyphHighlight(bufferSlotIndex, color)  // single glyph by absolute buffer index
   ```
   This is the method integration-testing named in its Phase 3 plan. The two agents used
   different method signatures for the same operation.

10. **Move `src/picking/PickingSystem.js` to `src/semantic/PickingSystem.js`** or keep it
    at `src/picking/`. The two agents proposed different module paths (`src/picking/` vs
    `src/semantic/PickingController.js`). Pick one and make it explicit. Recommend
    `src/picking/PickingSystem.js` (picking-system's proposal) because picking is
    independent of semantic annotation and should not be co-located with `SemanticInfoMap`.

---

## Key Insight

The two proposals are architecturally compatible but have a critical ownership conflict on
`instancePickingId`: buffer-pipeline treats it as a worker-emitted buffer that lives
alongside positions and colors, while picking-system treats it as a post-flush assignment
made by a singleton that owns the global ID counter. The picking-system approach is
correct because the global counter cannot be known at worker dispatch time without a
round-trip that defeats the purpose of async computation. Resolving this conflict requires
removing `pickingIds` from the builder return shapes entirely and treating
`instancePickingId` as a buffer that is always written by `PickingSystem.registerRenderer()`
after the geometry is finalized — which also means every call to `_rebuildAllInstances()`
must be followed by re-registration, making `registerRenderer()` a post-flush lifecycle
hook rather than a one-time init call.
