# Phase 0: Memory Lifecycle for CodeGrid GPU Content

Agent: memory-lifecycle
Focus: CodeGrid load/unload/reload, memory budget, GPU resource ownership, thrashing prevention, two-phase architecture.

---

## 1. Two-Phase Load Design

Current flow in `GitHubRepoViewer.loadRepository()` (line 900) is: fetch all files -> create all grids with GPU buffers -> layout -> register with virtualizer. Every grid gets full GPU content immediately, causing OOM at ~1500 files.

### Proposed Two-Phase Flow

**Phase 1: Metadata Pass (all files, no GPU)**
- Fetch file content (existing parallel fetch, line 932-938)
- For each file, compute dimensional metadata via cheap string scan:
  - `lineCount`: count `\n` occurrences
  - `maxLineWidth`: track max characters between `\n`s
  - Convert to world-space bounds using `GlyphCollection._getMetrics()` (line 109-127): `width = maxLineWidth * metrics.charWidth`, `height = lineCount * metrics.lineSpacing`
- Create CodeGrid as positioned stub (Object3D with correct `.position`, background plane, but no GlyphCollection content)
- Run `HierarchicalLayoutManager.layoutHierarchy()` using stub bounds
- Register all stubs with GridVirtualizer

**Phase 2: GPU Pass (visible grids only)**
- After layout + first frustum evaluation, build GPU buffers only for grids in `GridVirtualizer._active` set
- Use existing `loadFileAsync()` (CodeGrid line 145) for each visible grid
- Remaining grids stay as positioned stubs with retained dimensional metadata

### Dimension Computation (String Scan)

This replaces the need to build GPU buffers just to know bounds:

```javascript
// ~0.1ms per file, no DOM/GPU/Worker needed
function computeDimensions(content, metrics) {
    let lineCount = 1;
    let maxLineWidth = 0;
    let currentLineWidth = 0;

    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) {
            lineCount++;
            if (currentLineWidth > maxLineWidth) maxLineWidth = currentLineWidth;
            currentLineWidth = 0;
        } else {
            currentLineWidth++;
        }
    }
    if (currentLineWidth > maxLineWidth) maxLineWidth = currentLineWidth;

    return {
        lineCount,
        maxLineWidth,
        width: maxLineWidth * metrics.charWidth,
        height: lineCount * metrics.lineSpacing,
    };
}
```

This is precise enough for layout. The actual GPU bounds (from `GlyphCollection.getBounds()`, line 801) may differ slightly due to Z-wrapping of long lines, but the hierarchical layout only uses width/height from `CodeGrid.getBounds()` (line 236, called at HierarchicalLayoutManager line 418). Z-depth discrepancy is negligible for positioning.

---

## 2. CodeGrid State Machine

```
                        +--------+
          create()      |  STUB  |  has: position, dimensionMeta, background
         +-----------+  |        |  no:  GlyphCollection content, _lineSlotBase
         |           |  +---+----+
         |                  |
         |     loadContent() (frustum enter + budget available)
         |                  |
         |              +---v-----+
         |              | LOADED  |  has: everything (GPU buffers, _lineSlotBase, highlights)
         |              |         |  this._collection._renderer exists, instanceMesh in scene
         |              +---+-----+
         |                  |
         |     unloadContent() (frustum exit + memory pressure)
         |                  |
         |              +---v-------+
         |              | UNLOADED  |  has: position, dimensionMeta, background, content string
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

**State tracking**: Add `this._contentState` enum to CodeGrid: `'stub' | 'loaded' | 'unloaded'`.

Key invariant: `getBounds()` returns valid world-space bounds in ALL states (stub, loaded, unloaded) because `dimensionMeta` is always retained.

---

## 3. Dimension Metadata Retention

Store on CodeGrid (survives unload):

```javascript
// Added to CodeGrid constructor
this._dimensionMeta = null;  // Set during Phase 1 or first load

// Shape:
// {
//   lineCount: number,
//   maxLineWidth: number,       // chars
//   width: number,              // world units
//   height: number,             // world units
//   contentByteLength: number,  // for memory budget estimation
// }
```

**Where it's used**:
- `getBounds()` (line 236): When `_contentState !== 'loaded'`, return bounds from `_dimensionMeta` instead of querying `_collection.getBounds()`. The background plane position/scale uses these same bounds (`_updateBackground()` line 646).
- `HierarchicalLayoutManager._computeBoundsBottomUp()` (line 414): Calls `grid.getBounds()` -- works unchanged because getBounds() always returns valid data.
- `GridVirtualizer.register()` (line 67): Calls `grid.getBounds()` -- same.
- `getLineCount()` and `getMaxLineWidth()` (lines 289, 301): Return from `_dimensionMeta` when content string is not retained.

**Content string retention**: The raw `this.content` string is needed for reload. At 1500 files averaging 4KB each, that's ~6MB of strings -- acceptable. Keep it. (Current code already stores it on CodeGrid line 47: `this.content = '';`.)

---

## 4. Memory Budget Detection and Sizing

```javascript
class MemoryBudget {
    constructor() {
        // navigator.deviceMemory: 1, 2, 4, 8 (GB, approximate)
        // Absent on Firefox/Safari -- default to 4GB (conservative desktop)
        this.deviceMemory = navigator.deviceMemory || 4;

        // Per-grid GPU cost estimate (from task context):
        // 4000 glyphs * 44 bytes = 176 KB base
        // + highlight texture (~16 KB for 4K glyphs)
        // + group DataTexture (~2 KB per renderer)
        // ~194 KB per grid, round to 200 KB
        this.perGridBytes = 200 * 1024;

        // Budget: fraction of device memory for GPU content
        // Mobile (1-2GB): aggressive, keep ~100-150 grids loaded
        // Desktop (4-8GB): relaxed, keep ~300-500 grids loaded
        this.maxLoadedGrids = this._computeBudget();
    }

    _computeBudget() {
        const mem = this.deviceMemory;
        if (mem <= 1) return 75;
        if (mem <= 2) return 150;
        if (mem <= 4) return 300;
        return 500;
    }

    // Runtime pressure check via performance.memory (Chrome only)
    isUnderPressure() {
        const pm = performance.memory;
        if (!pm) return false;
        // Pressure if JS heap exceeds 80% of limit
        return pm.usedJSHeapSize > pm.jsHeapSizeLimit * 0.8;
    }
}
```

The budget controls how many grids may be in `'loaded'` state simultaneously. GridVirtualizer already has a `budget` parameter (line 31) that caps visible grids -- the memory budget is a separate, tighter constraint on which visible grids actually have GPU content.

---

## 5. Unload/Reload Triggers

### Load Triggers
A grid transitions STUB->LOADED or UNLOADED->LOADED when:
1. GridVirtualizer marks it active (frustum intersection, line 205: `scene.add(grid)`)
2. The total loaded grid count is below `MemoryBudget.maxLoadedGrids`
3. The grid has been in the frustum for at least N frames (thrashing guard, see section 6)

### Unload Triggers
A grid transitions LOADED->UNLOADED when:
1. GridVirtualizer removes it from scene (line 183-185: `scene.remove(grid)`)
2. AND total loaded count exceeds budget (don't unload if there's headroom)
3. OR `MemoryBudget.isUnderPressure()` returns true (emergency eviction)

### Priority-Based Eviction
When budget is exceeded, evict the loaded grid farthest from camera that is NOT in the active set. Use `GridVirtualizer._entries` distance field (line 172: `entry.distance`).

### Integration Point
The load/unload logic runs AFTER `GridVirtualizer.update()` in the animation loop:

```javascript
// In GitHubRepoViewer.animate():
this.gridVirtualizer.update();              // frustum cull (existing)
this.contentLifecycle.update(activeGrids);   // load/unload GPU content (new)
```

---

## 6. Thrashing Prevention

Problem: Grid at frustum edge oscillates in/out every few frames, causing repeated GPU buffer allocation/deallocation.

### Hysteresis (Already Exists)
GridVirtualizer has `hysteresis` (line 29, default 50 world units) -- keeps grids visible briefly after leaving frustum. This prevents scene add/remove oscillation but doesn't address GPU content lifecycle.

### Content Lifecycle Cooldowns

```javascript
// On CodeGrid:
this._lastLoadedAt = 0;    // timestamp of last GPU load
this._lastUnloadedAt = 0;  // timestamp of last GPU unload
this._loadCount = 0;       // number of times loaded (detects thrashing)

// In ContentLifecycleManager:
const LOAD_COOLDOWN_MS = 2000;   // Don't reload within 2s of unload
const UNLOAD_COOLDOWN_MS = 5000; // Don't unload within 5s of load

// Thrashing detection: if loadCount > 3 within 30s,
// promote grid to "pinned" -- keep loaded until camera moves far away
const THRASH_WINDOW_MS = 30000;
const THRASH_THRESHOLD = 3;
```

### Distance-Based Unload Delay
Instead of unloading immediately when a grid leaves the frustum, use distance tiers:
- Distance < 2x frustum depth: keep loaded (likely to re-enter)
- Distance 2-5x: schedule unload after 3 seconds
- Distance > 5x: unload on next cycle

---

## 7. Integration Points with GridVirtualizer

GridVirtualizer currently does scene.add/remove only (draw-call elimination). The memory lifecycle layer sits on top:

```
GridVirtualizer.update()     -->  scene.add/remove (visibility)
ContentLifecycleManager.update() -->  loadContent/unloadContent (GPU memory)
```

### Required GridVirtualizer Modifications

1. **Expose enter/exit events** (currently implicit in update loop):
```javascript
// Add to GridVirtualizer:
this._justEntered = [];  // grids that became active this frame
this._justExited = [];   // grids that became inactive this frame

// In update(), track transitions:
if (!entry.active) {
    this.scene.add(grid);
    entry.active = true;
    this._active.add(grid);
    this._justEntered.push(grid);  // NEW
}
// ...
if (entry.active) {
    this.scene.remove(grid);
    entry.active = false;
    this._active.delete(grid);
    this._justExited.push(grid);   // NEW
}
```

2. **Expose distance map** for eviction priority: `getDistances()` returning `Map<CodeGrid, number>`.

3. **Stub-aware bounds**: GridVirtualizer calls `grid.getBounds()` at registration (line 71) and via `refreshBounds()` (line 108). With dimensionMeta retention, these work unchanged because `getBounds()` returns valid data in all states.

---

## 8. Code Sketches

### CodeGrid.unloadContent()

```javascript
/**
 * Release GPU resources while retaining layout metadata.
 * Grid stays in scene as positioned stub with background.
 * Content string retained for future reload.
 */
unloadContent() {
    if (this._contentState !== 'loaded') return;

    // Retain dimensional metadata (already computed)
    // this._dimensionMeta stays untouched

    // Dispose GPU resources via collection
    if (this._collection) {
        // Unregister from picking before disposal
        if (this._collection._pickingSystem) {
            this._collection._pickingSystem.unregisterRenderer(
                this._collection._renderer
            );
        }

        // Dispose renderer (GPU buffers, highlight texture, group texture)
        if (this._collection._renderer) {
            this._collection._renderer.dispose();
            this._collection._renderer = null;
        }

        // Clear collection state but keep the group (it's our child)
        this._collection._idMap.clear();
        this._collection._reverseIdMap.clear();
        this._collection._committedTexts.clear();
        this._collection._pendingAdds = [];
        this._collection._pendingRemovals = [];
        this._collection._pendingUpdates = [];
        this._collection._boundsCache = null;
        this._collection._workerBoundsCache = null;
        this._collection._bufferSize = 0;
        this._collection._dirty = false;
    }

    // Clear line-slot mapping (rebuilt on reload)
    this._lineSlotBase = null;
    this._contentTextIds = [];
    this._filenameTextId = null;

    // Keep: this.content, this.filename, this._dimensionMeta, this.position
    // Keep: this._background (shows grid placeholder)
    this._contentState = 'unloaded';
    this._lastUnloadedAt = performance.now();
}
```

### CodeGrid.reloadContent()

```javascript
/**
 * Rebuild GPU buffers from retained content string.
 * Position and layout remain unchanged.
 * @returns {Promise<void>}
 */
async reloadContent() {
    if (this._contentState === 'loaded') return;
    if (!this.content) return;

    // Re-wire picking system if available
    const pickingSystem = this._collection?._pickingSystem;

    // Rebuild via existing async path (creates renderer, builds buffers)
    await this.loadTextAsync(this.content);

    // Re-wire picking
    if (pickingSystem && this._collection) {
        this._collection.setPickingSystem(pickingSystem);
    }

    this._contentState = 'loaded';
    this._lastLoadedAt = performance.now();
    this._loadCount++;
}
```

### CodeGrid.setDimensionMeta() (Phase 1 stub creation)

```javascript
/**
 * Set dimensional metadata without loading GPU content.
 * Enables layout positioning before GPU buffers exist.
 * @param {string} content - File content (retained for future load)
 * @param {string} filename - File name
 */
setDimensionMeta(content, filename) {
    this.content = content;
    this.filename = filename;
    this.lines = [];  // populated lazily

    const metrics = this._collection._getMetrics();
    let lineCount = 1, maxLineWidth = 0, currentWidth = 0;
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) {
            lineCount++;
            if (currentWidth > maxLineWidth) maxLineWidth = currentWidth;
            currentWidth = 0;
        } else {
            currentWidth++;
        }
    }
    if (currentWidth > maxLineWidth) maxLineWidth = currentWidth;

    this._dimensionMeta = {
        lineCount,
        maxLineWidth,
        width: maxLineWidth * (metrics.charWidth + metrics.letterSpacing),
        height: lineCount * metrics.lineSpacing,
        contentByteLength: content.length,
    };

    this._contentState = 'stub';

    // Update background to show placeholder
    this._updateBackgroundFromMeta();
}
```

### CodeGrid.getBounds() (Modified)

```javascript
getBounds() {
    // If loaded, use actual collection bounds (existing behavior)
    if (this._contentState === 'loaded') {
        // ... existing implementation (line 236-258)
    }

    // Stub or unloaded: synthesize bounds from dimensional metadata
    if (this._dimensionMeta) {
        const box = new THREE.Box3();
        const padding = this.config.backgroundPadding;
        const m = this._dimensionMeta;

        // Filename offset (matches _layoutContent logic, line 425)
        const filenameOffset = (this.config.showFilename && this.filename)
            ? this.metrics.lineHeight * 1.5
            : 0;

        box.min.set(-padding, -(m.height + filenameOffset) - padding, 0);
        box.max.set(m.width + padding, padding, 0);
        box.applyMatrix4(this.matrixWorld);
        return box;
    }

    return new THREE.Box3();  // empty
}
```

### ContentLifecycleManager (Orchestrator)

```javascript
class ContentLifecycleManager {
    constructor(memoryBudget, gridVirtualizer) {
        this.budget = memoryBudget;
        this.virtualizer = gridVirtualizer;
        this._loadedGrids = new Set();
        this._loadQueue = [];     // grids waiting to load
        this._loading = new Set(); // currently loading (async)
        this._maxConcurrentLoads = 4;
    }

    update() {
        const active = this.virtualizer.getActiveGrids();

        // Queue loads for visible stubs/unloaded grids
        for (const grid of active) {
            if (grid._contentState === 'loaded') continue;
            if (this._loading.has(grid)) continue;
            if (this._isInCooldown(grid)) continue;
            this._loadQueue.push(grid);
        }

        // Sort queue by distance (closest first)
        // Use virtualizer entry distances
        this._loadQueue.sort((a, b) => {
            const da = this.virtualizer._entries.get(a)?.distance ?? Infinity;
            const db = this.virtualizer._entries.get(b)?.distance ?? Infinity;
            return da - db;
        });

        // Process load queue (respecting budget and concurrency)
        while (
            this._loadQueue.length > 0 &&
            this._loading.size < this._maxConcurrentLoads &&
            this._loadedGrids.size + this._loading.size < this.budget.maxLoadedGrids
        ) {
            const grid = this._loadQueue.shift();
            if (grid._contentState === 'loaded') continue;
            this._loading.add(grid);
            grid.reloadContent().then(() => {
                this._loading.delete(grid);
                this._loadedGrids.add(grid);
            });
        }
        this._loadQueue = [];

        // Evict if over budget
        if (this._loadedGrids.size > this.budget.maxLoadedGrids || this.budget.isUnderPressure()) {
            this._evict(active);
        }
    }

    _evict(activeGrids) {
        // Build eviction candidates: loaded grids NOT in active set
        const candidates = [];
        for (const grid of this._loadedGrids) {
            if (activeGrids.has(grid)) continue;
            const entry = this.virtualizer._entries.get(grid);
            candidates.push({ grid, distance: entry?.distance ?? Infinity });
        }

        // Sort farthest first
        candidates.sort((a, b) => b.distance - a.distance);

        // Evict until under budget
        const target = Math.floor(this.budget.maxLoadedGrids * 0.8); // 80% to avoid immediate re-eviction
        while (this._loadedGrids.size > target && candidates.length > 0) {
            const { grid } = candidates.shift();
            if (this._isInCooldown(grid)) continue;
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

## Summary of Key Decisions

| Concern | Decision |
|---|---|
| Layout stability | `_dimensionMeta` always retained; `getBounds()` returns synthetic bounds when unloaded |
| Content retention | Keep `this.content` string (~6 MB for 1500 files); needed for reload |
| GPU cost per grid | ~200 KB (buffers + highlight + group textures) |
| Budget sizing | 75-500 loaded grids based on `navigator.deviceMemory` |
| Load trigger | Frustum enter + budget headroom + cooldown expired |
| Unload trigger | Frustum exit + over budget (or memory pressure) |
| Thrashing guard | 2s reload cooldown, 5s unload cooldown, pin after 3 loads in 30s |
| Concurrency | Max 4 concurrent async loads (worker pool has ~3 workers) |
| Eviction target | 80% of budget (hysteresis to avoid churn) |
| GridVirtualizer changes | Add `_justEntered`/`_justExited` arrays, expose distance map |
