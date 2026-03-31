# Round 1: Integration Architecture Reviews Cache Invalidation + Memory Lifecycle

Reviewer: integration-architecture
Reviewing: phase0-cache-invalidation, phase0-memory-lifecycle

---

## Errors Found

### 1. Per-glyph byte cost is 40 bytes, not 56

All three documents (including my own Phase 0) use 56 bytes/glyph (14 floats). The actual renderer at `src/GlyphRenderer.js:260-271` allocates 10 floats per instance: `instancePosition` (vec3), `instanceSize` (vec2), `instanceCodepoint` (float), `instanceColor` (vec3), `instanceGroupId` (float). Lines 270-271 explicitly comment that `instanceAddedColor` and `instancePickingId` were removed -- highlights moved to a DataTexture and picking IDs are derived from `gl_InstanceID`. This means:

- **Actual cost**: 10 floats x 4 bytes = **40 bytes/glyph** (plus highlight texture + group texture overhead per renderer, not per glyph)
- cache-invalidation's budget math is unaffected (100 MB soft limit is for IndexedDB text content, not GPU)
- memory-lifecycle's `perGridBytes` estimate (line 145: "200 KB per grid") is directionally fine but the base formula is wrong: 4000 glyphs x 40 bytes = 160 KB, not 176 KB
- My own Phase 0 `ContentBudget.currentBytes` (line 402: `this._totalGlyphs * 56`) overstates GPU usage by 40%

### 2. memory-lifecycle uses `metrics.lineSpacing` for height; my Phase 0 uses `metrics.lineHeight`

In `GlyphCollection._getMetrics()` (line 119), `lineSpacing` = `charHeight * scale * 1.2`. In `CodeGrid` constructor (line 63), `lineHeight` is assigned from `collectionMetrics.lineSpacing`. They are the same value, but the naming inconsistency in the design documents could cause bugs if someone implements from memory-lifecycle's `computeDimensions()` (uses `metrics.lineSpacing`) vs. my `computeDimensions()` (uses `this.metrics.lineHeight`). The canonical name is `this.metrics.lineHeight` on the CodeGrid instance.

### 3. memory-lifecycle's `computeDimensions()` omits `letterSpacing` from width

Line 392: `width: maxLineWidth * (metrics.charWidth + metrics.letterSpacing)`. This accounts for letterSpacing. My Phase 0's version (line 348) does not: `effectiveWidth = Math.min(maxLineWidth, wrapThreshold) * this.metrics.charWidth`. The memory-lifecycle version is more accurate -- each glyph occupies `charWidth + letterSpacing` horizontally. However, both omit the filename width contribution, which could exceed content width on short files.

### 4. GlyphCollection constructor adds group to scene directly

`GlyphCollection` constructor line 58: `this.scene.add(this.group)`. CodeGrid constructor line 75: `this.add(this._collection.group)`. Both happen -- the group gets added to the scene AND to the CodeGrid Object3D. This double-parenting means `scene.add(this.group)` is immediately overridden by `this.add(this._collection.group)` which reparents the group under the CodeGrid. The `scene.add` on line 58 is effectively a no-op after CodeGrid's constructor runs. However, if we implement `unloadGPU()` / `unloadContent()` and later reload, `GlyphCollection.flushAsync()` may try to create a new renderer and add its mesh to `this.group` -- which still lives under the CodeGrid. This is fine, but both documents' `unloadContent()`/`unloadGPU()` clear `_renderer` without clearing `group`, meaning the group (with its stale children from the disposed renderer) stays in the scene. `GlyphRendererV15.dispose()` (line 1455) calls `this.scene.remove(this.instanceMesh)` where `this.scene` is the group -- so it does clean up. This chain is correct but fragile.

---

## Gaps

### 1. No discussion of atlas texture memory

Both memory documents budget GPU buffer memory but ignore the atlas. `GlyphAtlas` generates a single shared texture, but the atlas UV map DataTexture is noted in CLAUDE.md as "17 MB" -- a fixed cost regardless of loaded grid count. Neither document accounts for this in the budget, which matters at the 100 MB GPU ceiling.

### 2. cache-invalidation's `hasShas()` batch check scales poorly

Line 340: `Promise.all(shaArray.map(sha => ...store.count(sha)...))`. For 1500 files, this fires 1500 individual IndexedDB `count()` requests in a single transaction. IndexedDB implementations vary, but this pattern can block the main thread. A cursor-based scan over the `blobs` store with a Set lookup would be O(n) with 1 IDB request instead of 1500.

### 3. No coordination between GPU budget (memory-lifecycle) and IndexedDB cache (cache-invalidation)

cache-invalidation evicts blobs from IndexedDB under its own 100 MB budget. memory-lifecycle's `ContentLifecycleManager` unloads GPU buffers and expects to reload from `grid.content` (kept in JS heap). But my Phase 0 proposes moving content to IndexedDB for non-visible grids (section 2, line 69: "Text content for non-visible grids can be moved to IndexedDB and released from JS heap"). If content is evicted from IndexedDB before a grid re-enters the frustum, the reload path needs to fall through to network. Neither document defines what happens when `grid.content` is null AND IndexedDB miss occurs AND the user is rate-limited.

### 4. memory-lifecycle clears `_workerBoundsCache` on unload (line 315) but my Phase 0 retains it

My Phase 0 line 175: "Keep _workerBoundsCache (no need to recompute)". memory-lifecycle line 315: `this._collection._workerBoundsCache = null`. Clearing it means `getBounds()` falls through to the renderer query path, which returns null since the renderer is disposed. The fallback to `_dimensionMeta` synthetic bounds would work, but only if the `getBounds()` override checks for that case before querying `_collection.getBounds()`. My Phase 0 override does (line 363); memory-lifecycle's override does (line 408). But they must not call `super.getBounds()` or `_collection.getBounds()` first, or they get null.

---

## Tensions

### 1. Callback vs. polling for virtualizer integration

My Phase 0 proposes `onActivate`/`onDeactivate` callbacks on the GridVirtualizer constructor (line 79-82). memory-lifecycle proposes `_justEntered`/`_justExited` arrays polled by `ContentLifecycleManager.update()` after `GridVirtualizer.update()` (line 249-267). These are incompatible designs. The callback approach is simpler and guarantees no missed transitions. The polling approach allows the lifecycle manager to batch and prioritize. Recommendation: use callbacks, but have the lifecycle manager queue internally rather than acting immediately in the callback.

### 2. Where content string lives

My Phase 0: content in `grid.userData.cachedContent` (line 58, line 126). memory-lifecycle: content in `grid.content` (line 128, line 325). CodeGrid already has `this.content` (line 47). Using `userData.cachedContent` duplicates it. The memory-lifecycle approach of using the existing `this.content` field is correct -- no need for `userData.cachedContent`.

### 3. Naming: `unloadGPU()` vs `unloadContent()`

My Phase 0 calls it `unloadGPU()`. memory-lifecycle calls it `unloadContent()`. The method does the same thing in both documents. `unloadContent()` is misleading because content (the text string) is retained. `unloadGPU()` is more accurate. But memory-lifecycle's state machine uses `loadContent`/`unloadContent`/`reloadContent` as a consistent trio. Recommendation: `unloadGPUBuffers()` for the method, but `'loaded'`/`'unloaded'` for state names (since the state describes whether content is rendered, not whether the string exists).

### 4. Budget class naming and ownership

My Phase 0: `ContentBudget` in `src/services/memory/`. memory-lifecycle: `MemoryBudget`. Different names, different APIs. `ContentBudget` tracks actual loaded grids and their glyph counts. `MemoryBudget` uses `navigator.deviceMemory` to compute a max loaded count but does not track individual grids. The actual tracking is done by `ContentLifecycleManager._loadedGrids`. Recommendation: merge into one class that both computes the budget ceiling and tracks actual usage.

---

## Recommendations

1. **Fix the per-glyph byte constant**: Use 40, not 56. Propagate this to `ContentBudget.currentBytes` and all budget estimation formulas.

2. **Use `grid.content` not `grid.userData.cachedContent`**: The field already exists on CodeGrid line 47. No duplication needed.

3. **Adopt callback-based virtualizer integration**: Add `onActivate`/`onDeactivate` to GridVirtualizer constructor, but have the lifecycle controller enqueue rather than act synchronously.

4. **Retain `_workerBoundsCache` on unload**: Do not clear it (line 315 of memory-lifecycle). It is needed for `getBounds()` to return valid data without the renderer. Clearing it forces reliance on `_dimensionMeta` which may have slight Z-depth inaccuracies.

5. **Replace `hasShas()` with cursor-based existence check**: For 1500-file repos, a single cursor scan with a Set is far cheaper than 1500 individual `count()` calls.

6. **Add letterSpacing to width in `computeDimensions()`**: Use `maxLineWidth * (metrics.charWidth + metrics.letterSpacing)` as in memory-lifecycle's version.

7. **Define the three-way fallback for content on reload**: `grid.content` (JS heap) -> `persistentCache.getBlob(sha)` (IndexedDB) -> network fetch. Document what happens when all three fail (grid stays as shell, retry with backoff).

8. **Merge `ContentBudget` and `MemoryBudget`**: One class that computes the ceiling from device capabilities AND tracks current usage. Name it `GPUMemoryBudget`.

9. **Name the unload method `unloadGPU()`**: The content string is retained, so "unloadContent" is misleading. Keep state enum values as `'stub' | 'loaded' | 'unloaded'` from memory-lifecycle -- that state machine is well-designed.

10. **Account for atlas fixed cost**: The 17 MB atlas map DataTexture is a constant overhead. Subtract it from the GPU budget ceiling before computing how many grids can be loaded.

---

## Key Insight

The three documents converge on the same architecture but disagree on a critical boundary: who owns the content string's lifecycle. My Phase 0 treats content as disposable (move to IndexedDB, release from heap). cache-invalidation treats IndexedDB as a persistent L2 cache keyed by blob SHA. memory-lifecycle treats `grid.content` as always-retained (~6 MB for 1500 files).

The correct answer depends on scale. At 1500 files x 4 KB average = 6 MB, keeping all content strings in the JS heap is cheap and simplifies reload. At 15,000 files (monorepo) x 4 KB = 60 MB, it is not. The design should treat `grid.content` as the hot path (always try it first) but allow nulling it under memory pressure with IndexedDB as the warm fallback. The cache-invalidation SHA-keyed blob store is the right persistence layer for this -- it just needs a "promote to JS heap on page fault" path that memory-lifecycle's `reloadContent()` does not currently include.
