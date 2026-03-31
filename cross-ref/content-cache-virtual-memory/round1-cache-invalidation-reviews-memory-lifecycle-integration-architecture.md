# Round 1: cache-invalidation reviews memory-lifecycle + integration-architecture

Reviewer: cache-invalidation
Reviewed: phase0-memory-lifecycle.md, phase0-integration-architecture.md

---

## Errors Found

### 1. Stub CodeGrid creates a full GlyphCollection (both agents miss this)

Both documents propose creating "shell" or "stub" CodeGrids that skip GPU allocation. But `CodeGrid`'s constructor (CodeGrid.js line 51-55) unconditionally creates a `new GlyphCollection(scene, atlas, ...)`, which in turn caches metrics from the atlas. The GlyphCollection itself doesn't allocate GPU buffers until `flush()`, so the stub approach is viable -- but neither document acknowledges that the GlyphCollection instance already exists. memory-lifecycle's `unloadContent()` (section 8) carefully clears collection internals (`_idMap`, `_reverseIdMap`, `_committedTexts`) rather than nullifying `_collection`, which is correct. But integration-architecture's `unloadGPU()` does `this._collection._bufferSize = 0` and clears maps, then says "Keep bounds cache" -- the `_boundsCache` and `_workerBoundsCache` will contain stale GPU-derived bounds that differ from the shell dimension bounds, creating an inconsistency on reload if the collection's `getBounds()` is called before `flush()` rebuilds them.

### 2. integration-architecture's Z-wrap dimension is wrong

`computeDimensions()` (integration-architecture section 9, line 347-349) calculates `zDepth` as:
```js
const zDepth = (zLayers - 1) * this.metrics.charWidth * wrapThreshold * 0.1;
```
This is not how Z-wrapping works in the actual buffer builder. The builder's Z offset is computed per-line based on character position, and the `0.1` factor is fabricated. memory-lifecycle correctly avoids computing Z-depth entirely, noting "Z-depth discrepancy is negligible for positioning" (section 1). Integration-architecture's attempt at precision here introduces an inaccurate formula that would produce wrong shell bounds for files with long lines.

### 3. `storedAt` is write-time, not access-time -- both agents' LRU is actually LRW

memory-lifecycle's eviction (section 5) and integration-architecture's `ContentBudget` both use `loadedAt` / `performance.now()` timestamps set at write time. Neither updates the timestamp on read. My own phase-0 design has the same issue in the `blobs` store -- `storedAt` is set in `putBlob()` but never updated in `getBlob()`. This means all three agents describe LRW (least-recently-written), not LRU (least-recently-used). For the IndexedDB blob store this matters less (content-addressed, so re-fetched blobs get new timestamps). For the GPU grid eviction it matters more: a grid loaded early but constantly in view would be evicted before a recently-loaded grid that was viewed once.

---

## Gaps

### 4. Neither agent specifies how content strings survive across sessions

memory-lifecycle retains `this.content` in JS heap (~6 MB for 1500 files) for reload. Integration-architecture mentions "Content remains available in IndexedDB for reload" after `unloadGPU()`. But neither connects to my IndexedDB blob store design for the reload path. When a grid is unloaded and its content string is GC'd (or the page is refreshed), the reload path in memory-lifecycle's `reloadContent()` calls `this.loadTextAsync(this.content)` -- but `this.content` would be empty after a session restart. The IndexedDB blob lookup (my phase-0, section 5) is the missing link: `reloadContent()` should fall through to `persistentCache.getBlob(sha)` when `this.content` is unavailable.

### 5. No handling of truncated trees

`_parseTreeResponse` (GitHubRepositorySource.js line 615) preserves `truncated: data.truncated`. GitHub's tree API truncates at ~100K entries. Neither memory-lifecycle nor integration-architecture accounts for a truncated tree. My invalidation design's `_syncTreeMap` also ignores this. For large repos, the tree map would be incomplete, meaning some files would never have blob SHAs and would always fall through to network fetch. This should be detected and flagged (e.g., fall back to per-directory tree fetches).

### 6. Picking system re-registration is underspecified

memory-lifecycle's `reloadContent()` (section 8) re-wires picking by reading `this._collection?._pickingSystem` before calling `loadTextAsync`, then calling `setPickingSystem()` after. But `loadTextAsync` calls `_layoutContentAsync` which calls `flushAsync` which creates a new renderer -- and `setPickingSystem` (GlyphCollection.js line 100-102) only registers if `this._renderer` exists. The ordering works, but the picking IDs will be different on reload (new slot indices). Any external system holding old picking IDs (e.g., `SemanticInfoMap`) will have stale references. Integration-architecture mentions "Re-register with picking if needed" as a comment but provides no implementation.

---

## Tensions

### 7. Two competing names for the same concept

memory-lifecycle calls it `ContentLifecycleManager` with methods `update()`, `_evict()`, and state enum `'stub' | 'loaded' | 'unloaded'`. Integration-architecture calls it `GridLifecycleController` with methods `processQueue()`, `onGridActivated()`, and a boolean `_gpuLoaded`. The state model is fundamentally different: a 3-state enum vs. a boolean flag. The 3-state model (memory-lifecycle) is more precise because it distinguishes "never loaded" from "was loaded then unloaded" -- the latter retains `_lineSlotBase` knowledge, the former does not. The boolean `_gpuLoaded` cannot express this.

### 8. Callback vs. polling for virtualizer integration

Integration-architecture adds `onActivate`/`onDeactivate` callbacks to the GridVirtualizer constructor. Memory-lifecycle adds `_justEntered`/`_justExited` arrays that the `ContentLifecycleManager` reads each frame. The callback approach is cleaner (event-driven, no polling), but it creates a tight coupling: GridVirtualizer now knows about lifecycle management via constructor parameters. The array approach is looser (GridVirtualizer just records transitions, consumer reads them). Both work, but they cannot coexist -- the implementation must choose one.

### 9. Budget sizing: fixed count vs. device-adaptive

Memory-lifecycle uses `navigator.deviceMemory` to compute 75-500 grid budget (section 4). Integration-architecture hardcodes `maxLoadedGrids: 400` and `gpuBudgetBytes: 100_000_000` (section 8). These will conflict at integration time. The device-adaptive approach (memory-lifecycle) is better because mobile devices with 1GB RAM cannot sustain 400 loaded grids at 200KB each (80MB GPU). But `navigator.deviceMemory` is Chrome-only and coarsely quantized (returns 0.25, 0.5, 1, 2, 4, 8). Firefox/Safari would always use the 4GB default, which may be too generous for low-end hardware.

---

## Recommendations

1. **Adopt the 3-state model** from memory-lifecycle (`stub | loaded | unloaded`) rather than the boolean `_gpuLoaded`. It captures richer semantics needed for cooldown logic and dimension metadata retention.

2. **Use callback-based virtualizer integration** (integration-architecture's `onActivate`/`onDeactivate`) rather than polling arrays. Rename to `onGridEnterFrustum`/`onGridExitFrustum` for clarity, and keep the lifecycle controller as the subscriber.

3. **Add `lastAccessedAt` to the IndexedDB blob store** -- update it in `getBlob()` so eviction is true LRU. Likewise, `ContentLifecycleManager` should track last-visible-frame per grid, not just load timestamp.

4. **Connect reload to IndexedDB**: `reloadContent()` should accept an optional `contentProvider` function that resolves to the content string, falling back to `this.content` when available. This bridges memory-lifecycle's in-session reload with my persistent cache's cross-session reload.

5. **Clear `_boundsCache` and `_workerBoundsCache` on unload** (integration-architecture's `unloadGPU()` erroneously retains them). Shell bounds from `_dimensionMeta` should be the sole source of truth when unloaded.

6. **Guard against truncated trees** by checking `tree.truncated` in `_syncTreeMap`. If truncated, log a warning and disable tree-SHA-based staleness (fall back to per-file TTL invalidation).

7. **Invalidate SemanticInfoMap on unload/reload** -- add a `grid.addEventListener('contentStateChange', ...)` hook so semantic mappings are cleared on unload and rebuilt on reload. Without this, picking IDs go stale silently.

8. **Merge budget strategies**: use memory-lifecycle's device-adaptive grid count as the default, but cap by integration-architecture's byte budget (`gpuBudgetBytes`). Whichever limit is hit first wins. Add a `performance.memory` pressure check (Chrome) as a runtime override.

9. **Unify the dimension function**: both agents wrote nearly identical `computeDimensions` string scans. Use memory-lifecycle's version (no Z-wrap attempt) since Z-depth is negligible for layout. Store result as `_dimensionMeta` (memory-lifecycle's naming) rather than `_shellBounds` (integration-architecture's naming), since it persists across state transitions, not just the shell state.

10. **Defer GlyphCollection creation for stubs**: since the constructor always creates one, consider a factory pattern -- `CodeGrid.createStub(scene, atlas, content)` that defers `new GlyphCollection()` until `loadContent()`. This saves ~1500 GlyphCollection instances and their metric caches during the metadata pass.

---

## Key Insight

The three designs (my cache invalidation, memory-lifecycle, integration-architecture) form a coherent L1/L2/L3 hierarchy, but none of the three documents defines the contract between layers. Memory-lifecycle assumes content strings live forever in JS heap; integration-architecture assumes IndexedDB is always available; my cache-invalidation design assumes the tree SHA is always accessible. The real risk is not in any individual layer but in the **fallback chain**: what happens when L2 (IndexedDB) is corrupted AND the network is down AND the JS heap content was GC'd? The system needs a single `ContentResolver` interface that each layer implements, with a chain-of-responsibility pattern that degrades gracefully. Without this explicit contract, three agents will build three layers that each work in isolation but break at the seams.
