# Content Cache + Virtual Memory System — Converged Design

**Date**: 2026-03-30
**Status**: Design complete, pending implementation
**Cross-ref agents**: cache-invalidation, memory-lifecycle, integration-architecture

---

## Problem Statement

At 1500 files, the app builds GPU buffers for ALL files (~264 MB GPU + ~264 MB CPU mirror), causing OOM on mobile and multi-second load on desktop. The GridVirtualizer eliminates draw calls for off-screen grids but doesn't reclaim GPU memory. We need to:

1. Load GPU buffers only for visible grids (~50-200 at a time)
2. Release GPU buffers when grids leave the frustum under memory pressure
3. Rebuild GPU buffers quickly when grids re-enter the frustum
4. Cache file content persistently (IndexedDB) to avoid re-fetching from GitHub
5. Keep the scene layout stable across load/unload cycles

---

## Architecture Overview

```
GitHubRepoViewer (orchestrator)
        |
  +-----+-------+----------+
  |             |                |
RepositoryAdapter   GridVirtualizer     ContentLifecycleManager
(fetch + cache)     (frustum cull)      (GPU load/unload budget)
  |                     |                       |
  v                     v                       v
PersistentContentCache  scene.add/remove        CodeGrid state machine
(IndexedDB, SHA-keyed)  onActivate/onDeactivate stub -> loaded -> unloaded
```

### Component Responsibilities

| Component | Role | Analogy |
|-----------|------|---------|
| `CodeGrid.setDimensionMeta()` | Compute bounds without GPU | Virtual address reservation |
| `CodeGrid.unloadContent()` | Release GPU buffers, keep dimensions | Page out |
| `CodeGrid.reloadContent()` | Rebuild GPU from retained content string | Page in |
| `ContentLifecycleManager` | Orchestrate load/unload, enforce budget | Page fault handler |
| `MemoryBudget` | Track GPU memory, enforce limits | Physical memory manager |
| `GridVirtualizer.onActivate/onDeactivate` | Trigger lifecycle events | MMU fault signal |
| `PersistentContentCache` (IndexedDB) | Cross-session content store | Swap file |

---

## Two-Phase Load

The layout depends on knowing each grid's dimensions, but dimensions come from content. This chicken-and-egg is resolved by separating dimension computation (cheap) from GPU buffer allocation (expensive).

### Phase 1 — Metadata Pass (all files, no GPU)

- Fetch all file content (existing parallel fetch via RepositoryAdapter)
- For each file: `grid.setDimensionMeta(content, filename)`
  - Counts `\n` occurrences for line count
  - Tracks max characters between newlines for max line width
  - Converts to world-space bounds via `GlyphCollection._getMetrics()` (charWidth, lineSpacing from atlas — no renderer needed)
  - Stores `_dimensionMeta` on the grid
- Layout via `HierarchicalLayoutManager.layoutHierarchy()` using dimension-based bounds
- Register all grids with GridVirtualizer
- Content string retained on `this.content` (~6 MB for 1500 files — acceptable)

### Phase 2 — GPU Pass (visible grids only)

- GridVirtualizer identifies visible grids via frustum test
- `onActivate` callback triggers ContentLifecycleManager
- ContentLifecycleManager queues GPU loads (max 4 concurrent)
- `grid.reloadContent()` calls existing `loadFileAsync()` pipeline
- GPU buffers built via Web Workers (existing async path)
- Only ~50-200 grids get GPU resources at any time

### Memory at Each Phase

| Phase | GPU Memory | JS Heap |
|-------|-----------|---------|
| After Phase 1 (1500 files) | ~0 MB | ~56 MB (Object3Ds + content strings + atlas) |
| After Phase 2 (200 visible) | ~40 MB | ~56 MB |
| Steady state (camera moving) | ~40-60 MB | ~56 MB |

---

## CodeGrid State Machine

```
                    +--------+
      create()      |  STUB  |  has: position, _dimensionMeta, background
     +-----------+  |        |  no:  GPU buffers, _lineSlotBase
     |              +---+----+
     |                  |
     |     reloadContent() (frustum enter + budget available)
     |                  |
     |              +---v-----+
     |              | LOADED  |  has: everything (GPU buffers, _lineSlotBase, highlights)
     |              |         |  _collection._renderer exists
     |              +---+-----+
     |                  |
     |     unloadContent() (frustum exit + memory pressure)
     |                  |
     |              +---v-------+
     |              | UNLOADED  |  has: position, _dimensionMeta, background, content string
     |              |           |  no:  GPU buffers (_renderer disposed)
     |              +---+-------+
     |                  |
     |     reloadContent() (frustum re-enter)
     |                  |
     |              +---v-----+
     |              | LOADED  |
     |              +---------+
     |
     |     dispose() (grid permanently removed)
     |              +----------+
     +-----------+  | DISPOSED |
                    +----------+
```

**Key invariant**: `getBounds()` returns valid world-space bounds in ALL states because `_dimensionMeta` is always retained. Layout never shifts due to load/unload.

### State Field

```javascript
this._contentState = 'stub';  // 'stub' | 'loaded' | 'unloaded'
```

### getBounds() Modification

When `_contentState !== 'loaded'`, synthesize bounds from `_dimensionMeta` instead of querying the (absent) renderer:

```javascript
getBounds() {
    if (this._contentState === 'loaded') {
        // existing implementation — queries _collection.getBounds()
    }

    if (this._dimensionMeta) {
        const box = new THREE.Box3();
        const padding = this.config.backgroundPadding;
        const m = this._dimensionMeta;
        const filenameOffset = (this.config.showFilename && this.filename)
            ? this.metrics.lineHeight * 1.5 : 0;

        box.min.set(-padding, -(m.height + filenameOffset) - padding, 0);
        box.max.set(m.width + padding, padding, 0);
        box.applyMatrix4(this.matrixWorld);
        return box;
    }

    return new THREE.Box3(); // empty
}
```

### Critical Implementation Notes

1. **`_workerBoundsCache` must be cleared on unload** — otherwise `GlyphCollection.getBounds()` returns stale GPU-derived bounds instead of falling back to `_dimensionMeta`
2. **GlyphCollection is always created in constructor** — unload disposes the renderer inside it, not the collection itself. The collection stays as a shell for re-use.
3. **Picking re-registration needed after reload** — `reloadContent()` must call `setPickingSystem()` to wire the new renderer into the picking system.

---

## Persistent Content Cache (IndexedDB)

### Cache Key Design

The existing in-memory cache uses branch-name keys (`file:owner/repo@branch:path`) — correct for session scope but wrong for persistence. Branches move between sessions.

**Persistent cache uses git blob SHAs** from the tree response. The tree API (`_parseTreeResponse`, GitHubRepositorySource.js) already provides per-file SHAs. Blob SHAs are content hashes — two files with identical content have the same SHA regardless of repo, branch, or path.

### Two Object Stores

**`blobs`** — content-addressed file storage:
```
Key:    blob SHA (string, 40 hex chars)
Value:  { content: string, size: number, storedAt: number, lastAccessedAt: number }
Index:  storedAt (for LRU eviction)
```

**`treeMaps`** — maps repo+branch to path-SHA index:
```
Key:    "owner/repo@branch" (string)
Value:  { treeSha: string, paths: { [path]: blobSha }, storedAt: number }
```

### Staleness Detection (Zero Extra API Calls)

The tree fetch is already mandatory (it's how the app discovers what files exist). Staleness detection piggybacks on it:

1. Fetch tree from GitHub (1 API call, already required)
2. Compare returned `tree.sha` against stored tree map's `treeSha`
3. If match: every cached blob is valid. Zero file fetches needed.
4. If mismatch: diff old vs new path-SHA maps. Fetch only changed files.

### Three-Tier Lookup

```
request -> RepositoryContentCache (in-memory L1, <5min TTL)
         -> PersistentContentCache (IndexedDB L2, SHA-validated)
         -> GitHub API / raw.githubusercontent.com (L3, network)
```

### Eviction Policy

- **Budget**: 100 MB soft limit (safe for mobile)
- **Eviction**: True LRU — update `lastAccessedAt` on reads, evict oldest
- **Pinning**: Active repo's blob SHAs are pinned (never evicted during session)
- **Emergency**: On `QuotaExceededError`, drop 25% of oldest unpinned blobs
- **Tree maps**: Evict when repo hasn't been loaded in 30 days

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Force push | Tree SHA changes, diff identifies changed files, re-fetch only those |
| Branch switch | Different tree map key, shared blob store. 90% shared files = 90% cache hits |
| Repo switch | Different tree map key. Content-addressed blobs dedup across repos (forks) |
| Offline | Fall back to stored tree map + cached blobs. Flag UI as potentially stale |
| Partial eviction | Tree map still valid. Missing blob = L2 miss, falls through to L3 |
| Multiple tabs | IndexedDB supports concurrent access. Blob writes are idempotent (same SHA = same content) |

---

## Memory Budget

### Device-Adaptive Sizing

```javascript
class MemoryBudget {
    constructor() {
        this.deviceMemory = navigator.deviceMemory || 4; // GB, absent on Firefox/Safari
        this.maxLoadedGrids = this._computeBudget();
        this.perGridBytes = 200 * 1024; // ~200 KB per grid (40 bytes * 4K glyphs + textures)
    }

    _computeBudget() {
        const mem = this.deviceMemory;
        if (mem <= 1) return 75;
        if (mem <= 2) return 150;
        if (mem <= 4) return 300;
        return 500;
    }

    // Chrome-only runtime pressure check
    isUnderPressure() {
        const pm = performance.memory;
        if (!pm) return false;
        return pm.usedJSHeapSize > pm.jsHeapSizeLimit * 0.8;
    }
}
```

### Eviction Strategy

When loaded grid count exceeds budget:
1. Build candidates: loaded grids NOT in the active (visible) set
2. Sort by distance from camera (farthest first)
3. Evict until at 80% of budget (hysteresis to prevent churn)
4. Apply cooldown checks before evicting (see thrashing prevention)

---

## Thrashing Prevention

Problem: Grid at frustum edge oscillates in/out every few frames, causing repeated GPU alloc/dealloc.

### Cooldowns

| Transition | Cooldown | Rationale |
|-----------|----------|-----------|
| UNLOADED -> LOADED | 2s after last unload | Don't rebuild what was just released |
| LOADED -> UNLOADED | 5s after last load | Don't release what was just built |

### Thrash Detection

If a grid loads >3 times within 30 seconds, promote to "pinned" — keep loaded until the camera moves far enough away that the grid is well outside the frustum (not just at the edge).

### Existing Hysteresis

GridVirtualizer already has 50 world-unit hysteresis for scene add/remove. This prevents the visibility oscillation. The content lifecycle cooldowns are a second layer for the GPU alloc/dealloc cycle.

---

## GridVirtualizer Integration

The virtualizer gains `onActivate` / `onDeactivate` callbacks:

```javascript
constructor(scene, camera, { onActivate, onDeactivate, ...opts }) {
    this._onActivate = onActivate;    // grid entered frustum
    this._onDeactivate = onDeactivate; // grid left frustum
}

// In update(), when a grid becomes active:
if (!entry.active) {
    this.scene.add(grid);
    entry.active = true;
    this._active.add(grid);
    if (this._onActivate) this._onActivate(grid);
}

// When a grid becomes inactive:
this.scene.remove(grid);
entry.active = false;
this._active.delete(grid);
if (this._onDeactivate) this._onDeactivate(grid);
```

### Prefetch Strategy (Future Enhancement)

A second, larger margin beyond the frustum identifies "warm zone" grids. These are prefetch candidates — loaded at lower priority than page faults, processed during idle frames via `requestIdleCallback`. Camera velocity can predict which frustum edge will gain grids next.

---

## ContentLifecycleManager

Orchestrates GPU load/unload decisions. Sits in the animate loop after GridVirtualizer.

```javascript
class ContentLifecycleManager {
    constructor(memoryBudget, gridVirtualizer) {
        this.budget = memoryBudget;
        this.virtualizer = gridVirtualizer;
        this._loadedGrids = new Set();
        this._loadQueue = [];        // grids waiting for GPU load
        this._loading = new Set();   // currently loading (async)
        this._maxConcurrentLoads = 4;
    }

    // Called each frame from animate loop
    update() {
        const active = this.virtualizer.getActiveGrids();

        // Queue loads for visible stubs/unloaded grids
        for (const grid of active) {
            if (grid._contentState === 'loaded') continue;
            if (this._loading.has(grid)) continue;
            if (this._isInCooldown(grid)) continue;
            this._loadQueue.push(grid);
        }

        // Sort by distance (closest first)
        this._loadQueue.sort((a, b) => {
            const da = this.virtualizer._entries.get(a)?.distance ?? Infinity;
            const db = this.virtualizer._entries.get(b)?.distance ?? Infinity;
            return da - db;
        });

        // Process loads (respecting budget + concurrency)
        while (this._loadQueue.length > 0
            && this._loading.size < this._maxConcurrentLoads
            && this._loadedGrids.size + this._loading.size < this.budget.maxLoadedGrids) {
            const grid = this._loadQueue.shift();
            if (grid._contentState === 'loaded') continue;
            this._startLoad(grid);
        }
        this._loadQueue = [];

        // Evict if over budget
        if (this._loadedGrids.size > this.budget.maxLoadedGrids
            || this.budget.isUnderPressure()) {
            this._evict(active);
        }
    }

    _startLoad(grid) {
        this._loading.add(grid);
        grid.reloadContent().then(() => {
            this._loading.delete(grid);
            this._loadedGrids.add(grid);
        }).catch(err => {
            console.warn(`GPU load failed for ${grid.name}:`, err);
            this._loading.delete(grid);
        });
    }

    _evict(activeGrids) {
        const candidates = [];
        for (const grid of this._loadedGrids) {
            if (activeGrids.has(grid)) continue; // don't evict visible grids
            if (this._isInCooldown(grid)) continue;
            const entry = this.virtualizer._entries.get(grid);
            candidates.push({ grid, distance: entry?.distance ?? Infinity });
        }

        candidates.sort((a, b) => b.distance - a.distance); // farthest first

        const target = Math.floor(this.budget.maxLoadedGrids * 0.8);
        while (this._loadedGrids.size > target && candidates.length > 0) {
            const { grid } = candidates.shift();
            grid.unloadContent();
            this._loadedGrids.delete(grid);
        }
    }

    _isInCooldown(grid) {
        const now = performance.now();
        if (grid._contentState === 'unloaded' && now - grid._lastUnloadedAt < 2000) return true;
        if (grid._contentState === 'loaded' && now - grid._lastLoadedAt < 5000) return true;
        return false;
    }
}
```

---

## App-Level Wiring (GitHubRepoViewer.js)

### Constructor additions

```javascript
this.memoryBudget = new MemoryBudget();
this.contentLifecycle = new ContentLifecycleManager(
    this.memoryBudget, this.gridVirtualizer
);

this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera, {
    onActivate: (grid) => { /* ContentLifecycleManager picks up in update() */ },
    onDeactivate: (grid) => { /* ContentLifecycleManager picks up in update() */ },
});
```

### loadRepository Redesign

```javascript
// Phase 1: Create shell grids with dimensions (no GPU)
const shellGrids = [];
for (const file of sourceFiles) {
    const fileData = fileMap.get(file.path);
    if (fileData?.content) {
        const grid = new CodeGrid(this.scene, this.atlas);
        grid.setDimensionMeta(fileData.content, file.path.split('/').pop());
        grid.userData.sourcePath = file.path;
        shellGrids.push(grid);
    }
}

// Phase 2: Layout using shell dimensions
this.hierarchicalManager.layoutHierarchy(shellGrids);

// Register + first frustum evaluation
this.gridVirtualizer.registerAll(shellGrids);
this.gridVirtualizer.update();

// Phase 3: ContentLifecycleManager handles async GPU loading
// for visible grids (triggered by first update() above)
```

### Animate Loop

```javascript
// After existing virtualizer update:
if (this.gridVirtualizer) this.gridVirtualizer.update();

// Process GPU load/unload lifecycle
if (this.contentLifecycle) this.contentLifecycle.update();
```

---

## New Files

| File | Purpose |
|------|---------|
| `src/services/memory/MemoryBudget.js` | Device-adaptive GPU budget sizing |
| `src/services/memory/ContentLifecycleManager.js` | Load/unload orchestration |
| `src/services/data/PersistentContentCache.js` | IndexedDB SHA-keyed blob store |

## Modified Files

| File | Changes |
|------|---------|
| `src/collections/CodeGrid.js` | Add `setDimensionMeta()`, `unloadContent()`, `reloadContent()`, `_contentState`, modify `getBounds()` |
| `src/collections/GridVirtualizer.js` | Add `onActivate`/`onDeactivate` callbacks |
| `src/services/data/RepositoryAdapter.js` | Add PersistentContentCache L2 tier, `_syncTreeMap()` |
| `app/GitHubRepoViewer.js` | Rewrite `loadRepository()` for two-phase load, add lifecycle manager to animate loop |

---

## Implementation Order

1. **CodeGrid state machine** — `setDimensionMeta()`, `unloadContent()`, `reloadContent()`, modified `getBounds()`
2. **GridVirtualizer callbacks** — `onActivate`/`onDeactivate`
3. **MemoryBudget** — device detection, budget sizing
4. **ContentLifecycleManager** — load queue, eviction, cooldowns
5. **loadRepository rewrite** — two-phase load
6. **PersistentContentCache** — IndexedDB, tree map sync, blob storage
7. **RepositoryAdapter L2 integration** — three-tier lookup

Steps 1-5 can ship together as the core virtual memory system. Step 6-7 (IndexedDB persistence) can follow as a separate pass — the system works without it, just re-fetches from GitHub on page reload.

---

## Open Questions for Implementation

1. **Background panel rendering for stubs**: Should unloaded grids show a background panel (placeholder rectangle) or be completely invisible? The background is a separate mesh from the glyph content.

2. **Content string lifecycle at monorepo scale**: At 1500 files x 4 KB avg, content strings are ~6 MB. At 10K+ files (monorepo), this grows. When should content strings move to IndexedDB and be released from JS heap?

3. **Per-glyph width data during reload**: The builder needs `glyphWidths` from the atlas. Are these already available from the cached WorkerBridge data, or does the atlas need to re-serialize them?

4. **Prefetch priority**: Should prefetch be velocity-based (predict camera direction) or distance-based (closest non-loaded grid)? Velocity is smarter but more complex.

5. **Visual loading indicator**: When a grid transitions from stub to loaded, should there be a visual transition (fade in)? Or is the background-to-content swap instant enough?
