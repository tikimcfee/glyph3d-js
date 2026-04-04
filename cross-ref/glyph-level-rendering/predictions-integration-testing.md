# Predictions from integration-testing agent

Agent: integration-testing
Date: 2026-03-30

These predictions are written WITHOUT reading the other agents' Phase 0 outputs.

---

## Prediction: buffer-pipeline agent

I expect the buffer-pipeline agent focused primarily on how to add `instanceBufferIndex` (and later `instanceColorAdd`) as new per-instance attributes without disrupting the existing buffer layout. Their main concern is likely the tight coupling between `buildBuffers()` in `src/workers/builders/buildBuffers.js` and `GlyphRendererV15._rebuildAllInstances()` -- both paths must emit identical attribute sets, and the worker path currently returns only `{positions, sizes, uvs, colors, count}`. Adding a new attribute means modifying the return shape, the transferable list, and the geometry attribute binding in `_createInstanceMesh`.

I predict they concluded that the `instanceBufferIndex` attribute is trivially generated (just `array[i] = i`) and therefore does NOT need to be computed by workers or transferred -- it can be synthesized on the main thread after buffer application. This is the obvious optimization since it's a pure identity sequence. For `instanceColorAdd`, they likely proposed a separate `Float32Array(count * 3)` initialized to zero, managed independently from the main rebuild path so that `setGlyphHighlight()` can write to it without triggering a full flush.

Their key concern is almost certainly the codepoint-based GPU lookup path. The current shader uses `instanceCodepoint` and `atlasMapTexture` for UV lookup, which means the old CPU-side UV arrays are partially vestigial. The buffer-pipeline agent probably flagged that the picking shader needs to use the same vertex positioning logic but output a different fragment (buffer index as color), and recommended that the picking vertex shader share the same attribute layout and group-texture lookup so positions stay consistent between the visual and picking passes. They may have also raised the `buildBatchBuffers` path in `GlyphCollection.flushAsync()` as a coordination concern -- the batch path combines multiple text entries into one buffer, and buffer indices must be globally sequential across all entries in the batch, not reset per-entry.

---

## Prediction: picking-system agent

I expect the picking-system agent concluded that a render-to-texture approach using a second render pass with `WebGLRenderTarget` is the correct design, and that raycasting is explicitly rejected due to the instanced geometry making Three.js's built-in raycaster useless (it doesn't understand `InstancedBufferGeometry`). They likely proposed encoding the buffer index into the RGB channels of the picking texture -- with 24 bits available in RGB this supports up to ~16.7 million instances, far exceeding the 10K-per-mesh limit.

Their primary concern is almost certainly the multi-grid problem: when multiple `GlyphRenderer` instances exist in the scene, the picking pass must disambiguate which renderer owns a given pixel. I predict they proposed encoding a renderer/grid ID in a subset of the RGBA bits (perhaps the alpha channel or the high bits of R) and the buffer index in the remaining bits. They likely designed a `PickingMaterial` (or `PickingShaderMaterial`) that replaces the atlas texture sampling with flat color output based on `instanceBufferIndex`, requiring a second `ShaderMaterial` that uses the same vertex shader attribute layout but a different fragment shader.

I also expect they raised the performance concern around `gl.readPixels()` being a synchronous GPU stall. Their mitigation is likely to avoid per-frame readback for hover events -- instead doing readback only on mouse events (click, mousemove with throttling), and possibly using `getBufferSubData` or async pixel readback via `PBO` if WebGL 2 features are available. They probably proposed a `PickingController` or `PickingManager` class that owns the render target, drives the second pass, and exposes a `pick(x, y)` method returning a resolved glyph identity.

A secondary concern is likely the render target resolution -- they may have proposed rendering the picking texture at half resolution to save GPU cost, noting that pixel-perfect picking at full resolution is unnecessary when glyphs are several pixels wide. They also likely addressed the camera synchronization requirement: the picking pass must use the exact same camera matrices as the main pass, or picked positions will be offset from visual positions.
