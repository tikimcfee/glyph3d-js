# Universal GPU Text Rendering — Implementation Results

## Process

- **Analysis**: 5 agents, Phase 0 through Round 3 convergence (pre-existing)
- **Implementation**: 4 agents in parallel, grouped by file ownership, zero overlap
- **Integration review**: Orchestrator spot-checked all integration seams, found and fixed 1 gap

## What Was Implemented

### Phase 1: Buffer Contract (types.js + JSDoc)

**Created `src/core/types.js`** — 4 canonical JSDoc typedefs:
- `GlyphBufferSet` — 10 floats/glyph across 5 typed arrays. Corrected from convergence doc: field is `count` (not `glyphCount`), `lineSlotOffsets` is `number[]` (not `Int32Array`)
- `GlyphBufferItemMeta` — per-text-item metadata with `lineSlotOffsets` for highlight range lookup
- `AtlasDescriptor` — platform-independent atlas description for future backends
- `GlyphGPUSpec` — 13-function checklist for alternative GPU backends (requirements doc, not runtime interface)

**Modified `src/workers/builders/index.js`** — `@returns {GlyphBufferSet}` on `buildBatchBuffers()` and `buildGlyphBuffers()`

**Modified `src/GlyphRenderer.js`** — `@param {GlyphBufferSet}` on `applyPrebuiltBuffers()`

### Phase 2: Async Picking Readback

**Modified `src/picking/PickingSystem.js`**:
- `readPixelAsync(t0)` — async wrapper around sync `readRenderTargetPixels`, returns `Promise<Uint8Array(4)>`
- `renderAndReadAsync(camera, scene)` — primary async pick method, returns `Promise<number>` (picking ID)
- Original `renderAndRead()` retained as sync fallback

**Picking ID Precision Fix** (same file):
- `vPickingId` changed from `float` varying to `flat int` varying in all 4 shader strings
- `uBasePickingId` changed from `float` to `int` uniform
- Fragment shader decomposition: `floor()`/`mod()` float math replaced with integer bit-shifts `>> 16`, `>> 8`, `& 0xFF`
- Full 24-bit ID range (16M glyphs) with zero precision loss

**Modified `app/GitHubRepoViewer.js`** — animate loop uses `renderAndReadAsync().then()` with `_pickPending` flag to prevent overlapping async frames

**Modified `examples/picking-test/main.js`** — same async pattern in animate loop + test handler

### Phase 3: Memory Reclamation

**Modified `src/collections/CodeGrid.js`**:
- `unloadContent()` — disposes GlyphCollection (frees InstancedBufferGeometry, highlight texture, buffers). Preserves position, bounding box, content text, config
- `reloadContent(atlas)` — reconstructs collection from stored source text via workers
- `isContentLoaded` getter — clean API for virtualizer to check state
- `_ensureCollection()` — private helper that makes `loadText()`/`loadTextAsync()` safe on evicted grids
- Null guards on `getBounds()`, `getContentBounds()`, `getGlyphCount()`, `clear()`, `_updateBackground()`

**Modified `src/collections/GridVirtualizer.js`**:
- `EVICTION_DISTANCE_FACTOR = 10.0` (10x hysteresis, not 3x — adjusted because virtualizer uses hysteresis not visibility radius)
- `EVICTION_DELAY_MS = 5000` — 5-second delay prevents thrashing (Zed lesson)
- Opt-in via `enableEviction: false` default — existing callers unchanged
- `setAtlas(atlas)` and `setEvictionEnabled(enabled)` for runtime control
- `getStats()` now includes `evicted` count
- Entries track `evicted: boolean` and `_evictionTimer: number|null`

### Phase 4: WebGL Context Loss

**Modified `src/GlyphRenderer.js`**:
- `_setupContextLossHandlers(canvas)` — `webglcontextlost` sets `_contextLost = true`, `webglcontextrestored` calls `_rebuildGPUState()`
- `_rebuildGPUState()` — pure re-upload pass: sets `needsUpdate = true` on atlas texture, atlas map DataTexture, group DataTexture, highlight DataTexture, and all instance buffer attributes. Nothing recomputed.
- `render()` and `renderBatch()` return early when `_contextLost` is true
- Auto-wires if `options.canvas` passed to constructor; manual `_setupContextLossHandlers()` call otherwise

**Modified `src/picking/PickingSystem.js`**:
- `onContextRestored()` — disposes stale FBO, recreates render target, forces fresh pick on next frame

**Integration wiring (orchestrator fix)**:
- `app/GitHubRepoViewer.js` — added `webglcontextrestored` listener that calls `pickingSystem.onContextRestored()`

### Phase 5: Pre-baked Atlas

**Modified `src/GlyphAtlas.js`**:
- `exportAtlas()` — serializes full state: glyph metrics, shelf-packing cursor, synthetic ID allocation, rendering constants. Returns `{image: dataUrl, descriptor: Object}`
- `static fromPrebuilt(descriptor, image)` — reconstructs fully operational GlyphAtlas without `generate()`. Restores packing state so `ensureGraphemes()` can extend the atlas at runtime

**Created `src/GlyphAtlasLoader.js`** — `loadPrebakedAtlas(imageUrl, descriptorUrl)` fetches PNG + JSON in parallel, delegates to `GlyphAtlas.fromPrebuilt()`

**Created `tools/bake-atlas.mjs`** — Node.js CLI for build-time atlas generation. Minimal DOM shim (only `document.createElement('canvas')`), generates at multiple sizes (512/1024/2048)

**Modified `src/index.js`** — re-exports `loadPrebakedAtlas`

**Modified `package.json`** — added `"./atlas-loader"` exports entry

## Integration Review

### Gap Found and Fixed

The GlyphRenderer and PickingSystem both implemented context loss handling independently (as designed — they own different files). But neither agent wired the canvas `webglcontextrestored` event to `pickingSystem.onContextRestored()`. This is correct separation of concerns — the GlyphRenderer doesn't know about PickingSystem — but the app layer needed the glue. Fixed in GitHubRepoViewer.js.

### Verified Clean

- Zero file overlap between agents (confirmed: each agent touched exclusively different files)
- Types in `types.js` were corrected to match actual code (`count` not `glyphCount`, `number[]` not `Int32Array`)
- `fromPrebuilt()` correctly restores shelf-packing state so `ensureGraphemes()` composes with pre-baked content
- Eviction is opt-in (`enableEviction: false` default) — no behavior change for existing callers
- Async picking preserves sync `renderAndRead()` — no breaking changes

## Files Changed

| File | Action | Phase |
|------|--------|-------|
| `src/core/types.js` | Created | 1 |
| `src/workers/builders/index.js` | Modified (JSDoc) | 1 |
| `src/GlyphRenderer.js` | Modified (JSDoc + context loss) | 1, 4 |
| `src/picking/PickingSystem.js` | Modified (async + precision + context loss) | 2, 4 |
| `app/GitHubRepoViewer.js` | Modified (async pick + context wiring) | 2, 4 |
| `examples/picking-test/main.js` | Modified (async pick) | 2 |
| `src/collections/CodeGrid.js` | Modified (unload/reload) | 3 |
| `src/collections/GridVirtualizer.js` | Modified (eviction) | 3 |
| `src/GlyphAtlas.js` | Modified (export/fromPrebuilt) | 5 |
| `src/GlyphAtlasLoader.js` | Created | 5 |
| `tools/bake-atlas.mjs` | Created | 5 |
| `src/index.js` | Modified (export) | 5 |
| `package.json` | Modified (exports) | 5 |

## What Was Deferred

- **Phase 6: LOD + Device Tier** — distance-based LOD bands (near/mid/far), `DeviceTier.js` runtime detection
- **TextSource / SourceBoundGrid** — data source abstraction layer (designed in convergence, not implemented)
- **Worker uvMap caching** — version-based cache to avoid redundant structured clones
- **MSDF atlas** — pre-baked pipeline enables this as a future build-time swap
