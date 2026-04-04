# Predictions from buffer-pipeline agent

**Written without reading the other agents' Phase 0 outputs.**

---

## Prediction: picking-system agent

I expect the picking-system agent concluded that GPU color-based picking (render-to-offscreen-target, read pixel, decode ID) is the right approach for glyph-level interaction, because raycasting against 10K+ instanced glyphs on the CPU is infeasible and Three.js has no built-in instanced picking. They likely proposed a dedicated `PickingManager` or `GlyphPicker` class that orchestrates a second render pass using a flat-color shader material, reading back a single pixel under the cursor via `WebGLRenderTarget` and `renderer.readRenderTargetPixels()`.

Their key concerns were likely: (1) the performance cost of the picking pass -- they probably recommended rendering only on click/hover rather than every frame, and possibly at reduced resolution (e.g., 1x1 pixel readback centered on the cursor rather than full-screen); (2) the ID encoding scheme -- they likely settled on 24-bit RGB encoding (R*65536 + G*256 + B), which supports up to ~16.7M unique glyph IDs, matching what I proposed from the buffer side; (3) how to map a decoded picking ID back to meaningful application-level data (which CodeGrid, which line, which character). I expect they proposed a registry or lookup table that maps picking ID ranges to { grid, line, column } tuples, since the buffer pipeline assigns contiguous ID ranges per text entry.

They probably flagged that the picking system depends on the buffer pipeline providing `instancePickingId` as an attribute, and that the picking material needs to replicate the exact same vertex position logic as the main render material (including group DataTexture transforms) to ensure pixel-perfect alignment. They may have raised the question of whether `gl_InstanceID` alone is sufficient or whether an explicit `instancePickingId` attribute is needed -- I expect they concluded the explicit attribute is necessary because `gl_InstanceID` resets per draw call and doesn't carry semantic meaning across multiple renderer meshes.

---

## Prediction: integration-testing agent

I expect the integration-testing agent concluded that the project's lack of any test infrastructure is the primary blocker for safely landing per-glyph rendering changes, because there is no test runner, no CI, and no automated validation today. They likely proposed a pragmatic testing strategy rather than a full framework adoption -- probably headless WebGL rendering tests using a combination of `puppeteer` or `playwright` with screenshot comparison, or possibly a lightweight Node.js approach using `gl` (headless-gl) to validate buffer contents without a browser.

Their key concerns were likely: (1) verifying that new buffer attributes (`instanceAddedColor`, `instancePickingId`) are correctly populated in both the sync and async (worker) paths -- they probably proposed specific test cases that assert typed array contents after `flush()` and `flushAsync()`; (2) round-trip validation of the picking pipeline -- render a known scene, click at a known pixel coordinate, verify the correct picking ID is decoded; (3) regression testing for the existing 10-float buffer layout to ensure backward compatibility when the new attributes are not provided (the `null` fallback paths).

They likely recommended starting with the `examples/render-test/` directory that already exists in the project, extending it with programmatic assertions rather than visual inspection. They may have proposed a test harness that creates a `GlyphCollection`, adds text with known parameters, flushes, and then inspects the resulting `InstancedBufferAttribute` arrays directly -- this would be a unit-level test that doesn't require WebGL at all. For the shader/picking integration, they probably proposed a small end-to-end test that renders to a canvas element and reads back specific pixels.

I expect they also raised concerns about testing the worker pipeline specifically -- ensuring that `buildGlyphBuffers()` and `buildBatchBuffers()` produce identical output to the main-thread path, which is already a contract the codebase relies on but never verifies.
