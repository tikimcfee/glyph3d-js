# Phase 0: Integration Architecture -- Content Cache Virtual Memory

## 1. System Overview

```
                          GitHubRepoViewer (orchestrator)
                                    |
                  +-----------------+-----------------+
                  |                 |                 |
          RepositoryAdapter   ContentBudget     GridVirtualizer
          (fetch + cache)     (memory mgr)      (frustum cull)
                  |                 |                 |
                  v                 v                 v
          IndexedDB          GridLifecycle      Scene graph
          (swap file)        Controller         add/remove
                              |       |
                         CodeGrid   CodeGrid
                         (loaded)   (shell only)
```

**Current data flow** (GitHubRepoViewer.loadRepository, lines 900-1098):
1. Fetch all files in parallel via `repoAdapter.getMultipleFiles()` (line 936)
2. Create all grids with full GPU buffers via `createGridForFileAsync()` (lines 946-953)
3. Layout via `hierarchicalManager.layoutHierarchy()` (line 988)
4. First render to compute matrixWorld (line 1039)
5. Register all grids with virtualizer (line 1046)

**The problem**: Step 2 builds GPU buffers for ALL files. At 1500 files x 4K glyphs x 56 bytes/glyph = 336 MB GPU memory. The virtualizer (step 5) only culls draw calls, not memory (GridVirtualizer.js line 17: "Grid GPU resources remain allocated").

**Proposed data flow**: A two-phase load that separates dimension computation from GPU allocation.

## 2. Initial Load Flow Redesign

### Phase 1: Metadata Pass (all files, cheap)

For every file, compute dimensions WITHOUT building GPU buffers. This requires:
- File content (from RepositoryAdapter)
- Atlas metrics (from `GlyphCollection._getMetrics()`, line 109 of GlyphCollection.js)
- Line count, max line width, Z-wrap depth

The key insight: `_getMetrics()` (GlyphCollection.js:109-127) computes charWidth/charHeight/lineSpacing from the atlas alone, with no renderer. We can compute a grid's bounding box from just the text content and these metrics.

New function: `CodeGrid.computeDimensions(content)` -- returns `{ width, height, depth }` without creating a GlyphCollection renderer or allocating GPU buffers. This is the "virtual page" -- the grid knows its size but has no physical backing.

### Phase 2: Selective GPU Load (visible grids only)

After layout positions all grids (using Phase 1 dimensions), only grids inside the camera frustum get GPU buffers built. This is the "physical page allocation."

```
loadRepository flow (redesigned):

  1. fetchTree + filterCodeFiles                        [same as today]
  2. getMultipleFiles (parallel fetch all content)      [same as today]
  3. for each file:
       grid = new CodeGrid(scene, atlas)                [lightweight]
       grid.computeDimensions(content)                  [NEW: no GPU]
       grid.userData.sourcePath = path
       grid.userData.cachedContent = content             [retain for Phase 2]
  4. hierarchicalManager.layoutHierarchy(grids)         [uses dimensions]
  5. register all grids with virtualizer
  6. virtualizer.update()                               [identify visible set]
  7. for each visible grid:
       await grid.loadFileAsync(filename, content)      [GPU buffers]
  8. first render
```

Memory at step 3: ~1500 grids x (Object3D overhead + dimensions + text ref) = ~50 MB JS heap (text content dominates). GPU memory: near zero.

Memory at step 7: ~200 visible grids x 4K glyphs x 56 bytes = ~45 MB GPU. Text content for non-visible grids can be moved to IndexedDB and released from JS heap.

## 3. The "Page Fault Handler" -- Grid Enters Frustum

When `GridVirtualizer.update()` adds a grid to the scene (line 206: `this.scene.add(grid)`), the grid may be a "shell" (has dimensions/position but no GPU buffers). This is the page fault.

**Current GridVirtualizer** only does `scene.add(grid)` / `scene.remove(grid)`. It has no concept of loaded vs. unloaded content. The page fault handler is a NEW callback mechanism:

```js
// GridVirtualizer gains an event callback
constructor(scene, camera, { onActivate, onDeactivate, ...opts }) {
    this._onActivate = onActivate;    // (grid) => void -- page fault
    this._onDeactivate = onDeactivate; // (grid) => void -- page out candidate
}
```

In the `update()` method, after line 206 (`this.scene.add(grid)`):
```js
if (!entry.active) {
    this.scene.add(grid);
    entry.active = true;
    this._active.add(grid);
    if (this._onActivate) this._onActivate(grid);  // NEW
}
```

And after line 183/188 (`this.scene.remove(grid)`):
```js
this.scene.remove(grid);
entry.active = false;
this._active.delete(grid);
if (this._onDeactivate) this._onDeactivate(grid);  // NEW
```

### Page Fault Resolution

The `GridLifecycleController` (new class) handles the callback:

```js
class GridLifecycleController {
    constructor(atlas, contentCache, memoryBudget) {
        this._atlas = atlas;
        this._contentCache = contentCache;   // IndexedDB-backed
        this._budget = memoryBudget;
        this._loadQueue = [];                // priority queue by distance
        this._loading = new Set();           // currently loading (async)
    }

    async onGridActivated(grid) {
        if (grid._gpuLoaded) return;         // already has buffers

        // Check memory budget
        if (this._budget.wouldExceed(grid)) {
            this._budget.evictFarthest();
        }

        // Get content (JS heap or IndexedDB)
        const content = grid.userData.cachedContent
            || await this._contentCache.get(grid.userData.sourcePath);

        if (!content) return;                // fetch failure, grid stays as shell

        await grid.loadFileAsync(grid.getFilename(), content);
        grid._gpuLoaded = true;
        this._budget.track(grid);
    }
}
```

**Critical**: `loadFileAsync` calls `flushAsync()` which creates the renderer and uploads to GPU (GlyphCollection.js:552-726). The grid's bounding box does NOT change -- dimensions were computed in Phase 1. The virtualizer's cached bounds remain valid. Layout is stable.

## 4. The "Page Out" Path -- Memory Pressure

When a grid leaves the frustum AND the memory budget is under pressure, we reclaim its GPU buffers.

**What gets released**:
- `GlyphCollection._renderer` (GlyphRendererV15 instance) -- owns the InstancedBufferGeometry, materials, picking mesh
- `GlyphCollection._renderer.instanceMesh.geometry` buffers (the 56 bytes/glyph Float32Arrays)

**What is retained**:
- The CodeGrid Object3D (position, scale, rotation) -- needed for stable layout
- The cached dimensions -- virtualizer bounds remain valid for frustum testing
- The content text (in IndexedDB, not JS heap) -- needed for reload on re-entry

**Implementation** -- new `CodeGrid.unloadGPU()` method:

```js
unloadGPU() {
    if (!this._collection?._renderer) return;

    // Unregister from picking before disposing renderer
    if (this._collection._pickingSystem) {
        this._collection._pickingSystem.unregisterRenderer(this._collection._renderer);
    }

    // Dispose GPU resources only (renderer + geometry + materials)
    this._collection._renderer.dispose();
    this._collection._renderer = null;
    this._collection._bufferSize = 0;

    // Clear committed text tracking (will be rebuilt on reload)
    this._collection._idMap.clear();
    this._collection._reverseIdMap.clear();
    this._collection._committedTexts.clear();

    // Keep bounds cache (layout stability)
    // Keep _workerBoundsCache (no need to recompute)

    this._gpuLoaded = false;
    // Content remains available in IndexedDB for reload
}
```

**Eviction policy**: LRU by distance. The `ContentBudget` tracks all loaded grids sorted by their distance from camera (from `GridVirtualizer._entries.get(grid).distance`). When budget is exceeded, evict the farthest loaded grid first.

## 5. Prefetch Strategy

Load grids NEAR the frustum edge before the camera reaches them. The virtualizer's `hysteresis` margin (constructor line 31, default 50 world units) already defines a "warm zone."

**Prefetch ring**: A second, larger margin beyond the frustum. Grids in this ring are prefetch candidates, loaded at lower priority than page faults.

```js
// In GridVirtualizer.update(), after scoring visible grids:
const prefetchMargin = this.hysteresis * 3; // 150 world units

for (const [grid, entry] of this._entries) {
    if (entry.active) continue; // already in scene
    const dist = entry.bounds.distanceToPoint(this._camPos);
    if (dist < prefetchMargin) {
        this._prefetchCandidates.push({ grid, distance: dist });
    }
}
```

Prefetch requests are enqueued at low priority in the `GridLifecycleController._loadQueue`. They yield to page faults (which are immediate) and run during idle frames via `requestIdleCallback`.

**Velocity-based direction**: The camera's movement vector predicts WHICH edge of the frustum will gain new grids. Prefetch grids in the movement direction first.

```js
const velocity = { x: cp.x - this._lastCamX, y: cp.y - this._lastCamY };
// Score prefetch candidates: lower distance + alignment with velocity = higher priority
```

## 6. Session Resume Flow

The RepositoryContentCache (RepositoryContentCache.js) is currently in-memory only (Map-based). Session resume requires an IndexedDB tier.

```
Session resume:
  1. Read persisted repo URL + branch from localStorage   [StatePersistence]
  2. Open IndexedDB "glyph3d-content" store
  3. Read cached tree (avoids API call)
  4. For each file in tree:
       Read cached content from IndexedDB
       Create shell grid with computeDimensions()
  5. layoutHierarchy(grids)                               [instant -- no fetch]
  6. Restore camera position from localStorage
  7. virtualizer.update() -> page faults -> load visible   [~200 grids]
  8. First render within ~1 second of page load
```

**IndexedDB schema**:
```
Store: "repository-content"
  Key: "owner/repo@branch:path"
  Value: { content: string, fetchedAt: number, sha: string }

Store: "repository-tree"
  Key: "owner/repo@branch"
  Value: { tree: [...], fetchedAt: number }
```

The existing `RepositoryContentCache.export()` / `import()` (lines 237-287) already serialize to JSON -- this mechanism extends to IndexedDB persistence. The TTL check in `import()` (line 275) applies: stale entries trigger a background re-fetch.

## 7. Error Handling

### Fetch failures (network, 404)
Grid stays as a shell (dimensions from tree metadata if content unavailable). The shell renders as an empty background panel with filename label. Retry on next camera visit with exponential backoff tracked per-grid.

### Cache corruption (IndexedDB)
If IndexedDB read fails or returns corrupt data, fall back to API fetch. Log a warning, clear the corrupted entry. The `RepositoryAdapter` already handles fetch fallback (line 253-260: raw URL -> API URL).

### API rate limits
The `RepositoryAdapter` already tracks rate limit status (line 437). When rate-limited:
- Page faults for grids with IndexedDB content still succeed (no API call needed)
- Page faults requiring API fetch are deferred until rate limit resets
- The `RateLimitError` from GitHubRepositorySource includes `resetDate`
- Show toast: "GitHub rate limit reached. Cached content available, new files deferred until {resetDate}"

### Budget overflow (too many visible grids)
The virtualizer's `budget` parameter (constructor line 31, default Infinity) caps simultaneously visible grids. If all visible grids are loaded and budget is still exceeded, the farthest visible grids beyond budget are unloaded first (they're in the frustum but at the edge).

## 8. App-Level Wiring in GitHubRepoViewer.js

### Constructor additions (after line 248):
```js
this.lifecycleController = new GridLifecycleController(this.atlas, {
    gpuBudgetBytes: 100 * 1024 * 1024,  // 100 MB GPU budget
    maxLoadedGrids: 400,
});
```

### GridVirtualizer wiring (replaces line 248):
```js
this.gridVirtualizer = new GridVirtualizer(this.scene, this.camera, {
    onActivate: (grid) => this.lifecycleController.onGridActivated(grid),
    onDeactivate: (grid) => this.lifecycleController.onGridDeactivated(grid),
});
```

### loadRepository changes (lines 941-953 rewritten):
```js
// Phase 1: Create shell grids with dimensions (no GPU)
const shellGrids = [];
for (const file of sourceFiles) {
    const fileData = fileMap.get(file.path);
    if (fileData?.content) {
        const grid = new CodeGrid(this.scene, this.atlas);
        grid.computeDimensions(fileData.content);
        grid.userData.sourcePath = file.path;
        grid.userData.cachedContent = fileData.content;
        grid.name = file.path.split('/').pop();
        shellGrids.push(grid);
    }
}

// Phase 2: Layout using shell dimensions
this.hierarchicalManager.layoutHierarchy(shellGrids);

// Register shells with virtualizer (bounds from dimensions, not GPU)
this.gridVirtualizer.registerAll(shellGrids);

// Phase 3: virtualizer.update() triggers page faults for visible grids
// lifecycleController handles async GPU loading
this.gridVirtualizer.update();
```

### Animate loop (line 1671-1672 -- after virtualizer.update()):
```js
// Process pending GPU loads (max 2 per frame to avoid jank)
if (this.lifecycleController) {
    this.lifecycleController.processQueue(2);
}
```

## 9. Code Sketches

### CodeGrid.computeDimensions() -- the "virtual page"

```js
/**
 * Compute bounding dimensions from text content without creating GPU resources.
 * Used for layout positioning before selective GPU loading.
 * @param {string} content - File text content
 */
computeDimensions(content) {
    this.content = content;

    // Count lines and max line width
    let lineCount = 1;
    let maxLineWidth = 0;
    let currentWidth = 0;
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) { // newline
            if (currentWidth > maxLineWidth) maxLineWidth = currentWidth;
            currentWidth = 0;
            lineCount++;
        } else {
            currentWidth++;
        }
    }
    if (currentWidth > maxLineWidth) maxLineWidth = currentWidth;

    // Filename adds 1.5x lineHeight to top
    const filenameHeight = this.config.showFilename ? this.metrics.lineHeight * 1.5 : 0;

    // Z-wrap: lines longer than ~120 chars wrap in Z
    const wrapThreshold = 120; // matches GlyphRenderer wrap logic
    const zLayers = Math.ceil(maxLineWidth / wrapThreshold);
    const effectiveWidth = Math.min(maxLineWidth, wrapThreshold) * this.metrics.charWidth;
    const zDepth = (zLayers - 1) * this.metrics.charWidth * wrapThreshold * 0.1;

    this._shellBounds = {
        width: effectiveWidth,
        height: filenameHeight + lineCount * this.metrics.lineHeight,
        depth: zDepth,
    };
    this._gpuLoaded = false;
}

/**
 * Override getBounds() to use shell dimensions when GPU is not loaded.
 */
getBounds() {
    if (this._gpuLoaded || this._collection?._renderer) {
        return super.getBounds(); // real GPU-computed bounds
    }
    if (!this._shellBounds) return new THREE.Box3();

    const box = new THREE.Box3();
    const pad = this.config.backgroundPadding;
    box.min.set(-pad, -(this._shellBounds.height + pad), -this._shellBounds.depth);
    box.max.set(this._shellBounds.width + pad, pad, 0);
    box.applyMatrix4(this.matrixWorld);
    return box;
}
```

### ContentBudget -- the "physical memory manager"

```js
class ContentBudget {
    constructor({ maxLoadedGrids = 400, gpuBudgetBytes = 100_000_000 }) {
        this.maxLoaded = maxLoadedGrids;
        this.gpuBudget = gpuBudgetBytes;
        this._loaded = new Map(); // grid -> { glyphCount, loadedAt }
        this._totalGlyphs = 0;
    }

    track(grid) {
        const count = grid.getGlyphCount();
        this._loaded.set(grid, { glyphCount: count, loadedAt: performance.now() });
        this._totalGlyphs += count;
    }

    untrack(grid) {
        const entry = this._loaded.get(grid);
        if (entry) {
            this._totalGlyphs -= entry.glyphCount;
            this._loaded.delete(grid);
        }
    }

    get currentBytes() { return this._totalGlyphs * 56; }
    get loadedCount() { return this._loaded.size; }

    wouldExceed(grid) {
        // Estimate: use text length as rough glyph count
        const est = (grid.content?.length || 0) * 56;
        return (this.currentBytes + est > this.gpuBudget)
            || (this._loaded.size >= this.maxLoaded);
    }

    /** Evict the grid farthest from camera. Caller provides distance fn. */
    evictFarthest(distanceFn) {
        let farthest = null, maxDist = -1;
        for (const grid of this._loaded.keys()) {
            const d = distanceFn(grid);
            if (d > maxDist) { maxDist = d; farthest = grid; }
        }
        if (farthest) {
            farthest.unloadGPU();
            this.untrack(farthest);
        }
    }
}
```

### GridLifecycleController -- the "page fault handler"

```js
class GridLifecycleController {
    constructor(atlas, options = {}) {
        this._atlas = atlas;
        this._budget = new ContentBudget(options);
        this._queue = [];          // { grid, priority } sorted by distance
        this._loading = new Set(); // in-flight async loads
        this._maxConcurrent = 4;
    }

    /** Called by virtualizer onActivate */
    onGridActivated(grid) {
        if (grid._gpuLoaded) return;
        this._queue.push(grid);
    }

    /** Called by virtualizer onDeactivate */
    onGridDeactivated(grid) {
        // Remove from queue if pending
        const idx = this._queue.indexOf(grid);
        if (idx >= 0) this._queue.splice(idx, 1);

        // Budget-driven unload: only if under pressure
        if (this._budget.loadedCount > this._budget.maxLoaded * 0.8) {
            grid.unloadGPU();
            this._budget.untrack(grid);
        }
    }

    /** Process N items from queue. Call from animate loop. */
    async processQueue(maxPerFrame = 2) {
        let processed = 0;
        while (this._queue.length > 0
            && processed < maxPerFrame
            && this._loading.size < this._maxConcurrent) {

            const grid = this._queue.shift();
            if (grid._gpuLoaded) continue;

            // Budget check
            while (this._budget.wouldExceed(grid)) {
                if (!this._budget.evictFarthest(g =>
                    g.position.distanceTo(grid.position))) break;
            }

            this._loading.add(grid);
            processed++;

            // Async load -- fire and forget within frame budget
            const content = grid.userData.cachedContent;
            if (content) {
                grid.loadFileAsync(grid.name, content).then(() => {
                    grid._gpuLoaded = true;
                    this._budget.track(grid);
                    this._loading.delete(grid);
                    // Re-register with picking if needed
                }).catch(err => {
                    console.warn(`GPU load failed for ${grid.name}:`, err);
                    this._loading.delete(grid);
                });
            }
        }
    }
}
```

---

**Summary of new components**:
| Component | Role | Analogy |
|-----------|------|---------|
| `CodeGrid.computeDimensions()` | Compute bounds without GPU | Virtual address reservation |
| `CodeGrid.unloadGPU()` | Release GPU buffers, keep dimensions | Page out |
| `ContentBudget` | Track GPU memory, enforce limits | Physical memory manager |
| `GridLifecycleController` | Orchestrate load/unload | Page fault handler |
| `GridVirtualizer.onActivate/onDeactivate` | Trigger lifecycle events | MMU fault signal |
| IndexedDB content store | Persistent content across sessions | Swap file |

**Files to modify**:
- `src/collections/CodeGrid.js` -- add `computeDimensions()`, `unloadGPU()`, override `getBounds()`
- `src/collections/GridVirtualizer.js` -- add `onActivate`/`onDeactivate` callbacks, prefetch ring
- `src/services/data/RepositoryContentCache.js` -- add IndexedDB tier
- `app/GitHubRepoViewer.js` -- rewire `loadRepository()`, add lifecycle controller to animate loop

**New files**:
- `src/services/memory/ContentBudget.js`
- `src/services/memory/GridLifecycleController.js`
