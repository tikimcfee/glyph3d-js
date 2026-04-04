# Predictions from picking-system Agent

Written blind -- before reading the other agents' Phase 0 outputs.

---

## Predictions for buffer-pipeline Agent

I expect the buffer-pipeline agent focused on how to extend `buildBuffers.js` and
`_rebuildAllInstances()` to carry per-glyph identity data through the existing worker
pipeline. Their central concern is likely the question of **what new data must flow
through the worker boundary** -- specifically, whether a `pickingId` or `codepoint index`
array should be computed in the worker (where buffer building is a pure function with no
DOM/Three.js access) or on the main thread after buffers arrive.

They probably concluded that the picking ID assignment must happen on the main thread,
because picking IDs are globally unique across all renderers and the worker has no
knowledge of the global ID counter. However, they likely proposed that the worker should
output a **slot-to-source mapping** (e.g., an array mapping each buffer slot back to its
originating text entry index and character offset within that entry), since
`textToGlyphs.js` and `layoutText.js` already have this information during the
single-pass layout and it would be wasteful to reconstruct it later.

I also expect the buffer-pipeline agent raised concerns about **buffer format
compatibility** -- the existing `applyPrebuiltBuffers()` accepts positions, sizes, uvs,
colors, and groupIds, and adding a new `pickingIds` array means the worker message
protocol and the `Transferable` list both need updating. They likely noted this is
straightforward but flagged it as a coordination point with the picking system. They may
have also addressed whether `instanceCodepoint` (the GPU-side atlas lookup attribute)
could double as a picking identifier, concluding it cannot because codepoints are not
unique per glyph.

---

## Predictions for integration-testing Agent

I expect the integration-testing agent designed a test strategy that does NOT rely on a
traditional test runner (since the project has none configured -- no Jest, no Vitest, no
Mocha). They likely proposed **browser-based visual regression tests** or an extension of
the existing `examples/render-test/` pattern, where a test page renders known content and
validates the result programmatically.

Their main conclusions likely center on three testing layers:

1. **Unit-level pure function tests** for buffer builders -- these are the easiest to test
   because `buildBuffers`, `textToGlyphs`, and `layoutText` are pure functions with no
   DOM dependencies. The agent probably proposed either a simple Node.js test harness or
   inline assertions in a test HTML page.

2. **Visual snapshot tests for the picking texture** -- render the picking pass to a
   canvas, read back a region of pixels, and assert that known glyph positions produce
   non-zero IDs and that background pixels produce zero. This is the most natural way to
   validate the picking system end-to-end without a GPU mocking layer.

3. **Round-trip integration tests** -- add text to a GlyphCollection, flush, render the
   picking pass, readPixels at known screen coordinates, resolve the ID, and verify it
   maps back to the correct text entry and character index.

Their key concern is likely **test environment reliability** -- WebGL readPixels behavior
varies across GPUs and drivers, so they probably recommended tolerance-based assertions
(e.g., "the ID at this pixel is non-zero" rather than "the ID at pixel (47, 83) is
exactly 142") and running tests at a fixed canvas size to get deterministic pixel
coordinates.

They may have also flagged that the worker path adds complexity to testing (async
boundaries, transferable buffers) and recommended testing both the worker path and the
main-thread fallback path.
