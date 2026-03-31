# Round 1: memory-lifecycle reviews cache-invalidation + integration-architecture

Reviewer: memory-lifecycle
Reviewed: phase0-cache-invalidation, phase0-integration-architecture

---

## Errors Found

### 1. Integration-architecture stores content on `userData` instead of `this.content`

Integration-architecture (section 2, step 3) stores content as `grid.userData.cachedContent`, but CodeGrid already has `this.content` (line 47 of `CodeGrid.js`). The `loadTextAsync()` method (line 123) sets `this.content = text` on entry. Storing in `userData` creates a parallel content field that will drift out of sync. My Phase 0 uses `this.content` directly for retention. The integration-architecture should do the same.

### 2. Integration-architecture's `unloadGPU()` retains `_workerBoundsCache` -- dangerous

Integration-architecture (section 4) comments "Keep _workerBoundsCache (no need to recompute)." But `_workerBoundsCache` holds the exact bounds from the last GPU buffer build, which may reference invalidated renderer state. More critically, `GlyphCollection.getBounds()` (line 801-811) returns `_workerBoundsCache` directly when it exists, bypassing the renderer query. After unload, `getBounds()` would return stale GPU-pass bounds instead of the shell/dimensional bounds. My Phase 0 clears `_workerBoundsCache` in `unloadContent()` (line 315: `this._collection._workerBoundsCache = null`) precisely to force the override `getBounds()` to use `_dimensionMeta`. The integration-architecture's approach will cause `CodeGrid.getBounds()` to silently return data from a disposed renderer rather than falling through to the shell bounds path.

### 3. Integration-architecture's `computeDimensions()` accesses `this.metrics` before it exists in shell path

In section 9, `computeDimensions()` references `this.metrics.lineHeight` and `this.metrics.charWidth`. But `this.metrics` is set in the constructor (line 58-64) from `this._collection._getMetrics()`. This works if the constructor ran. However, the proposed flow (section 2, step 3) calls `new CodeGrid(scene, atlas)` then `grid.computeDimensions(content)`. The constructor creates a `GlyphCollection` (line 51-55) eagerly -- so `this.metrics` exists. This is not an error per se, but it means **every shell grid allocates a full `GlyphCollection` instance** with its internal state (`_idMap`, `_reverseIdMap`, `_committedTexts`, etc.). For 1500 grids that's 1500 GlyphCollection objects doing nothing. My Phase 0 has the same issue (`setDimensionMeta()` calls `this._collection._getMetrics()`). Both designs should extract metrics computation to a static/shared method on GlyphCollection to avoid 1500 empty collection instances.

### 4. Cache-invalidation's `_getBlobSha` linear scan acknowledged but fix is not in the code sketch

Cache-invalidation (section 5) notes that `tree.tree.find()` should be replaced with a Map, and even proposes `this._pathToSha = new Map(...)`. But the `_getBlobSha` code sketch on the same page still uses `tree.tree.find()`. The `_syncTreeMap` method (section 7) does build the Map correctly. This is a minor inconsistency but could lead to a copy-paste bug during implementation.

---

## Gaps

### 1. No coordination between persistent cache eviction (cache-invalidation) and GPU memory budget (integration-architecture)

Cache-invalidation's `PersistentContentCache` evicts blobs from IndexedDB based on LRU/size (100 MB budget). Integration-architecture's `ContentBudget` evicts GPU buffers based on distance. Neither document addresses the scenario where a blob is evicted from IndexedDB while the GPU buffer is unloaded -- the grid enters the frustum, GPU reload needs the content string, but it was evicted from both JS heap and IndexedDB. My Phase 0 retains `this.content` in the JS heap (~6 MB for 1500 files), which sidesteps this for the active repository. But if the integration-architecture's flow releases `userData.cachedContent` to save heap (as hinted in section 2: "Text content for non-visible grids can be moved to IndexedDB and released from JS heap"), then a cache miss at both levels means a network re-fetch during a page fault -- a visible stall.

### 2. Integration-architecture lacks thrashing prevention

My Phase 0 specifies cooldowns (2s reload, 5s unload), thrashing detection (3 loads in 30s triggers pinning), and distance-based unload delays. The integration-architecture's `GridLifecycleController` has none of this. Its `onGridDeactivated` immediately unloads if budget pressure exceeds 80%, with no cooldown check. A grid oscillating at the frustum edge would repeatedly allocate and dispose GPU buffers every few frames.

### 3. Cache-invalidation has no strategy for handling `storedAt` timestamp updates on read

The `getBlob` method (line 301-308) never updates `storedAt`. This means the LRU eviction is actually LRW (least recently written), not LRU. Frequently accessed blobs that were written long ago will be evicted first. This matters for repos visited daily -- their blobs get stale timestamps and become eviction targets despite being actively used.

### 4. Neither document addresses picking system state across load/unload cycles

My Phase 0 handles picking registration/unregistration in `unloadContent()` and `reloadContent()`. The integration-architecture mentions `unregisterRenderer` in `unloadGPU()` but the `GridLifecycleController.processQueue()` only says "Re-register with picking if needed" as a comment with no implementation. The cache-invalidation document doesn't mention picking at all. A grid that reloads without re-registering with `PickingSystem` will not respond to hover/click events.

---

## Tensions

### 1. Content string ownership: `this.content` vs `userData.cachedContent` vs IndexedDB

Three different retention strategies across three documents:
- **My Phase 0**: Keep `this.content` on CodeGrid always (~6 MB total, simple).
- **Integration-architecture**: `grid.userData.cachedContent`, potentially released to IndexedDB.
- **Cache-invalidation**: IndexedDB is the authoritative store, in-memory is L1 cache with TTL.

These must converge. If content is released from JS heap, reloads become async (IndexedDB read) rather than synchronous buffer builds. This changes the `reloadContent()` contract from "rebuild from retained string" to "fetch from IndexedDB, then rebuild."

### 2. Budget sizing: fixed count vs byte-based vs device-adaptive

- **My Phase 0**: `navigator.deviceMemory`-based grid count (75-500).
- **Integration-architecture**: Fixed 400 grids + 100 MB GPU budget (dual constraint).
- **Cache-invalidation**: 100 MB IndexedDB budget (separate dimension).

The 400-grid fixed cap from integration-architecture conflicts with my device-adaptive approach. A 1 GB mobile device should not load 400 grids. The 100 MB GPU budget is a better constraint than grid count alone, since grid sizes vary (a 10-line file vs a 2000-line file differ by 200x in GPU cost).

### 3. Naming: `ContentLifecycleManager` vs `GridLifecycleController`

My Phase 0 calls the orchestrator `ContentLifecycleManager`. Integration-architecture calls it `GridLifecycleController`. Same role, different names. Need to converge before implementation.

---

## Recommendations

1. **Use `this.content` for retention, not `userData.cachedContent`.** CodeGrid already owns this field (line 47). Eliminates sync issues. Reserve IndexedDB for cross-session persistence, not intra-session swapping.

2. **Clear `_workerBoundsCache` on unload.** Integration-architecture must null this out; otherwise `GlyphCollection.getBounds()` returns stale data instead of falling through to shell bounds.

3. **Extract `GlyphCollection._getMetrics()` to a static method** that takes `(atlas, worldScale)` and returns the metrics object. Avoids constructing 1500 GlyphCollection instances for shell grids.

4. **Add thrashing prevention to `GridLifecycleController`.** Port my Phase 0's cooldown/pinning logic into the integration-architecture's controller. Without it, edge-case grids will churn GPU allocations.

5. **Update `storedAt` on read in `PersistentContentCache.getBlob()`.** Change `getBlob` to do a read-then-write to refresh the timestamp, making eviction truly LRU. Use a debounced/batched write to avoid per-read transaction overhead.

6. **Converge budget model on byte-based + device-adaptive.** Drop fixed grid count. Use `navigator.deviceMemory` to scale the GPU byte budget (e.g., 50 MB on 1 GB device, 200 MB on 8 GB). ContentBudget tracks actual glyph count * 56 bytes, which is already implemented.

7. **Implement picking re-registration in `GridLifecycleController.processQueue()`.** After `grid.loadFileAsync()` resolves, call `grid._collection.setPickingSystem(pickingSystem)` if a picking system is active on the scene.

8. **Pin active repo's content strings against IndexedDB eviction AND JS heap release.** If both retention layers can evict, a page fault could trigger a network fetch mid-navigation. The pin mechanism from cache-invalidation (`pinShas`) should be the authoritative guard.

9. **Unify naming: `GridLifecycleController`** is more descriptive (it controls grid lifecycle specifically, not generic "content"). Both documents should adopt this name.

10. **Defer GlyphCollection construction to `loadContent()`/`reloadContent()`.** For shell grids, only store `_dimensionMeta` and the background plane. Construct `this._collection` lazily on first load. Saves ~1 KB per idle grid across 1500 grids.

---

## Key Insight

The integration-architecture and my Phase 0 converge on the same two-phase design and arrive at nearly identical `unloadGPU()`/`unloadContent()` implementations, which validates the approach. But the critical gap is at the **seam between GPU lifecycle and content persistence**: neither document cleanly specifies what happens when a grid needs to reload but its content has been evicted from both JS heap and IndexedDB. The safest resolution is to keep `this.content` pinned in JS heap for the active repository (only ~6 MB for 1500 files at 4 KB average) and use IndexedDB exclusively for cross-session warm starts. This makes GPU reload synchronous (string is always available) and eliminates the async-in-page-fault complexity that would otherwise require loading spinners, retry logic, and error states for grids that pop into the frustum.
