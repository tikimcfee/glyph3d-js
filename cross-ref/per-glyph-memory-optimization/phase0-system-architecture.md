# Phase 0: System Architecture — Memory & Scale Analysis

**Date:** 2026-03-30
**Scope:** glyph3d-js at 1500+ file scale. All line numbers reference current `experiment/ide-shell` branch.

---

## 1. Current Lifecycle Analysis

### Creation Path (sync)

```
GitHubRepoViewer.loadRepository()              [GitHubRepoViewer.js:885]
  → Promise.all(createGridForFileAsync × N)    [GitHubRepoViewer.js:934]
    → new CodeGrid(scene, atlas)               [CodeGrid.js:21]
      → new GlyphCollection(scene, atlas)      [GlyphCollection.js:38]
        → this.group = new THREE.Group()       [GlyphCollection.js:57]
        → scene.add(this.group)                ← scene reference stored forever
    → grid.loadFileAsync(filename, content)
      → _collection.addText(entireContent)     [CodeGrid.js:471]
      → _collection.flushAsync()               [GlyphCollection.js:550]
        → WorkerBridge.buildBatchBuffers()     ← Float32Arrays built in worker
        → _createRendererWithSize(count)       ← GlyphRendererV15 created
          → _createInstanceMesh()              ← InstancedBufferGeometry + 7 attributes
            → Float32Array × 7, sized to count [GlyphRenderer.js:218–232]
          → GroupDataTexture created           ← Float32Array(maxGroups × 4 × 4)
        → applyPrebuiltBuffers(buffers)        ← worker arrays copied into GPU attrs
```

**Memory owners at creation:**
- Worker thread: `positions`, `sizes`, `codepoints`, `colors`, `groupIds` Float32Arrays — these are **transferred** (zero-copy) to main thread via `Transferable`, so worker memory drops to zero after the transfer.
- Main thread (JS heap): `renderedTexts` Map with per-glyph `{position, size}` objects in `entry.glyphs[]` — for 4000 glyphs this is ~4000 plain objects, roughly 400 KB per file in GC-managed heap.
- GPU (via WebGL): 7 `InstancedBufferAttribute` arrays. Per-instance layout: position(3) + size(2) + codepoint(1) + color(3) + groupId(1) + addedColor(3) + pickingId(1) = **14 floats = 56 bytes**. At 4000 glyphs: 224 KB per renderer.
- CPU mirror: The same Float32Arrays back the GPU attributes — Three.js holds both the JS typed array and the GPU buffer simultaneously. So CPU + GPU = 448 KB per file for the instance data alone.

### What Is Never Freed

1. `GlyphCollection.group` is added to `scene` at construction time (line 58). If the CodeGrid is disposed but the collection was already scene-added before dispose runs, the group stays in the scene graph.
2. `GlyphCollection._committedTexts` Map holds full `TextEntry` objects including the original text string. For a 50 KB source file, this string alone occupies 50 KB × 2 (UTF-16) = 100 KB per file, never released between load and explicit `clearGrids()`.
3. `CodeGrid.content` stores the raw source string (line 47). Combined with `_committedTexts` storing items' `.text` fields, the same content is duplicated at least twice in JS heap.
4. `CodeGrid.lines[]` — `content.split('\n')` produces N strings sharing substrings (V8 slices), but still allocates N string objects.
5. `GlyphRendererV15._groupData` — `new Float32Array(maxGroups × 4 × 4)`. At default `maxGroups = 64` this is `64 × 16 × 4 = 4096` bytes, trivial. But the texture object is duplicated CPU+GPU.

### Worker Buffer Lifecycle — The Leak Window

In `flushAsync()` (GlyphCollection.js line 618):
```js
const buffers = await bridge.buildBatchBuffers(items, ...);
// buffers.positions, buffers.sizes, etc. are Transferable Float32Arrays
const rendererIds = this._renderer.applyPrebuiltBuffers(buffers, items);
```

Inside `applyPrebuiltBuffers()` (GlyphRenderer.js), the incoming Float32Arrays are set as the backing store of `InstancedBufferAttribute` via `new THREE.InstancedBufferAttribute(buffers.positions, 3)`. Three.js retains those arrays as `attribute.array`. They are never nulled after GPU upload. The typed arrays live on until the renderer is disposed. This is correct behavior — Three.js needs the CPU mirror for `needsUpdate` cycles — but it means the CPU-side copy of all instance data is permanent.

**At 1500 files × 4K glyphs:**
- GPU instance buffers: 1500 × 224 KB = **336 MB**
- CPU instance buffer mirrors: 1500 × 224 KB = **336 MB**
- JS heap (glyph objects in renderedTexts): 1500 × 400 KB ≈ **600 MB**
- Source strings (content + committedTexts): 1500 × ~50 KB avg × 2 = **150 MB**
- **Total without atlas: ~1422 MB**

This is over the practical process limit before atlas, picking target, or overhead are counted.

---

## 2. Virtualized Rendering Proposal

### Core idea: render only what's in frustum

The renderer has `mesh.frustumCulled = false` explicitly set at GlyphRenderer.js line 239. This was necessary because the instanced mesh's bounding box is not updated when positions change. The fix is to maintain per-grid bounding boxes and skip `scene.add` / `scene.remove` based on frustum intersection, not per-mesh frustum culling.

A `GridVirtualizer` should sit between the app and the scene:

```js
// src/services/rendering/GridVirtualizer.js

export class GridVirtualizer {
    constructor(scene, camera, { budget = 300, margin = 1.2 } = {}) {
        this.scene = scene;
        this.camera = camera;
        this.budget = budget;          // max simultaneously active grids
        this.margin = margin;          // frustum expansion factor
        this._active = new Set();      // CodeGrids currently in scene
        this._all = [];                // [{grid, bounds, priority}]
        this._frustum = new THREE.Frustum();
        this._projScreenMatrix = new THREE.Matrix4();
    }

    register(grid) {
        const bounds = grid.getBounds();          // THREE.Box3 world-space
        this._all.push({ grid, bounds, priority: 0 });
    }

    unregister(grid) {
        this._all = this._all.filter(e => e.grid !== grid);
        this._deactivate(grid);
    }

    update(cameraNear, cameraFar) {
        // Recompute frustum
        this._projScreenMatrix.multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse
        );
        this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

        const camPos = this.camera.position;

        // Score each grid
        for (const entry of this._all) {
            const inFrustum = this._frustum.intersectsBox(entry.bounds);
            if (!inFrustum) { entry.priority = -1; continue; }
            const dist = entry.bounds.distanceToPoint(camPos);
            entry.priority = 1 / (dist + 1);  // closer = higher priority
        }

        // Sort by priority descending
        this._all.sort((a, b) => b.priority - a.priority);

        const desired = new Set(
            this._all.slice(0, this.budget)
                .filter(e => e.priority > 0)
                .map(e => e.grid)
        );

        // Deactivate grids no longer in budget
        for (const g of this._active) {
            if (!desired.has(g)) this._deactivate(g);
        }

        // Activate newly-visible grids
        for (const g of desired) {
            if (!this._active.has(g)) this._activate(g);
        }
    }

    _activate(grid) {
        this.scene.add(grid);
        this._active.add(grid);
    }

    _deactivate(grid) {
        this.scene.remove(grid);
        this._active.delete(grid);
    }
}
```

Call `virtualizer.update()` in the animation loop before `renderer.render()`. This alone eliminates draw calls for all out-of-frustum grids with zero change to the rendering stack. At any given camera position, typically 20–60 grids are visible.

**Estimated saving:** If 50 of 1500 grids are visible, WebGL processes ~50 draw calls instead of 1500. Zero change to per-glyph GPU data.

---

## 3. LOD Strategy

Distance thresholds should be derived from atlas metrics, not hardcoded. The atlas `charWidth` at `worldScale=0.025` is approximately `0.6` world units. A glyph subtends less than 1 screen pixel at distance `~600 / tan(FOV/2) × charWidth / viewport_height` — roughly 800 world units for a typical setup.

Three LOD levels per CodeGrid:

| Level | Distance | Representation | Implementation |
|-------|----------|----------------|----------------|
| FULL | 0–400 | All glyphs rendered | Current path |
| LABEL | 400–1200 | Filename + line count only | `grid.getCollection().setGroupVisibility(contentGroupId, false)` — 1 DataTexture write |
| INVISIBLE | 1200+ | Grid removed from scene | GridVirtualizer deactivates |

The DataTexture group system already supports this. At flush time, assign all content glyphs to `groupId=1` and the filename to `groupId=2`. Toggling visibility is then O(1) regardless of glyph count:

```js
// In CodeGrid, after _layoutContentAsync():
this._contentGroupId = this._collection.createGroup();
// pass groupId in addText options for content lines
```

LABEL mode costs near-zero: the group texture write is 4 bytes. No buffer rebuild. No scene graph change.

**Estimated saving:** At 300 grids in scene with 200 in LABEL mode, 200 × ~4000 glyphs = 800K instances skip vertex shader processing. GPU utilization drops proportionally.

---

## 4. Memory Budget System

A `MemoryBudget` singleton tracks total allocated GPU bytes across all renderers and enforces an eviction policy:

```js
// src/services/rendering/MemoryBudget.js

const BUDGET_BYTES = 512 * 1024 * 1024;   // 512 MB GPU instance budget
const EVICT_TO = 0.7;                       // evict until 70% full

export class MemoryBudget {
    constructor() {
        this._renderers = new Map();    // grid → renderer
        this._lruOrder = [];            // grid, LRU front = oldest
        this._totalBytes = 0;
    }

    register(grid, renderer) {
        const stats = renderer.getMemoryStats();   // GlyphRenderer.js:741
        this._renderers.set(grid, stats.allocatedBytes);
        this._totalBytes += stats.allocatedBytes;
        this._touch(grid);
        if (this._totalBytes > BUDGET_BYTES) this._evict();
    }

    touch(grid) { this._touch(grid); }

    unregister(grid) {
        const bytes = this._renderers.get(grid) ?? 0;
        this._renderers.delete(grid);
        this._totalBytes -= bytes;
        this._lruOrder = this._lruOrder.filter(g => g !== grid);
    }

    _touch(grid) {
        this._lruOrder = this._lruOrder.filter(g => g !== grid);
        this._lruOrder.push(grid);        // most-recently-used at back
    }

    _evict() {
        const target = BUDGET_BYTES * EVICT_TO;
        while (this._totalBytes > target && this._lruOrder.length > 0) {
            const oldest = this._lruOrder.shift();
            const bytes = this._renderers.get(oldest) ?? 0;
            oldest.unloadContent();       // see §5
            this._renderers.delete(oldest);
            this._totalBytes -= bytes;
        }
    }

    getStats() {
        return { totalBytes: this._totalBytes, budgetBytes: BUDGET_BYTES, grids: this._renderers.size };
    }
}
```

`GlyphRendererV15.getMemoryStats()` (line 741) already returns `allocatedBytes` — the sum of all instance attribute byte lengths. This is the correct input to the budget tracker.

**Priority for eviction:** Grids furthest from camera and not recently interacted with. LRU is a sufficient proxy; camera distance can be incorporated if needed.

---

## 5. Lazy Load/Unload Design

`CodeGrid` needs two new methods: `unloadContent()` and `reloadContent(fetchFn)`.

```js
// In CodeGrid.js

/**
 * Release GPU buffers while retaining metadata (position, filename, bounds).
 * The grid remains in the scene as an invisible stub.
 */
unloadContent() {
    if (!this._collection) return;
    this._collection.dispose();   // disposes renderer, removes mesh from group
    this._collection = null;
    this._lineSlotBase = null;
    // Keep: this.content (for reload), this.position, this.filename, this.userData
    this._isUnloaded = true;
}

/**
 * Reload content — re-creates the collection and flushes to GPU.
 * @param {() => Promise<string>} fetchFn - async function returning file content
 */
async reloadContent(fetchFn) {
    if (!this._isUnloaded) return;
    const content = this.content || await fetchFn();
    this._collection = new GlyphCollection(this.scene, this.atlas, {
        maxChars: this.config.maxChars,
        defaultColor: this.config.textColor,
        worldScale: this.config.worldScale
    });
    this.add(this._collection.group);
    this.content = content;
    await this._layoutContentAsync();
    this._updateBackground();
    this._isUnloaded = false;
}
```

The `GitHubRepoViewer` integration point is `GridVirtualizer._deactivate()`: before removing from scene, check if the grid should be unloaded (budget pressure), and queue a reload when it re-enters the frustum.

**Lazy fetch:** If `this.content` is cleared to `''` after `unloadContent()` (to release the string), the `fetchFn` callback must re-fetch from GitHub API or a local cache. A `ContentCache` (Map keyed by path, bounded by LRU) can avoid repeated network hits:

```js
// 50 MB content cache in JS heap — much cheaper than 336 MB of GPU buffers
const CONTENT_CACHE_BYTES = 50 * 1024 * 1024;
```

**Estimated saving:** Unloading 1200 of 1500 grids reduces GPU instance data from 336 MB to 67 MB and JS heap glyph objects from 600 MB to 80 MB. Content cache is 50 MB vs 150 MB raw strings. Net GPU+heap reduction: ~939 MB.

---

## 6. Worker Buffer Lifecycle Fixes

The current path in `applyPrebuiltBuffers()` correctly uses Transferable arrays — the worker loses ownership of the buffers on `postMessage()`. The main thread receives zero-copy typed arrays. These become the backing store for `InstancedBufferAttribute.array`.

**The actual issue:** After `applyPrebuiltBuffers()`, the `items` array passed to `flushAsync()` (line 618, GlyphCollection.js) still holds references to `{text, position, options}` objects via `this._pendingAdds`, even though they are cleared at line 675. The clearing is correct. However, `this._committedTexts` at line 508–514 stores a new object with `text: this._pendingAdds[i].text` — the source string is copied by reference into the committed map and stays there permanently.

**Fix:** Do not store the text string in `_committedTexts`. The text is only needed for `updateText()` (which rebuilds the buffer anyway) and diagnostics. Replace with a byteLength proxy:

```js
// GlyphCollection.js flush(), line 508
this._committedTexts.set(ourId, {
    id: ourId,
    rendererId,
    // text: this._pendingAdds[i].text,   // REMOVE — releases string
    textLength: this._pendingAdds[i].text.length,  // keep for diagnostics
    position: this._pendingAdds[i].position,
    options: this._pendingAdds[i].options
});
```

Similarly, `CodeGrid._clearContent()` calls `_collection.flush()` to process removals (line 407). After clearing, `this.content` and `this.lines` are reset, but only in `clear()` (line 153), not in `_clearContent()`. If `loadFile()` is called repeatedly (e.g., during diff view), old content strings accumulate until GC runs.

**Estimated saving:** Removing string storage from `_committedTexts` saves ~50 KB × 1500 = 75 MB from the permanent JS heap.

---

## 7. Chunked / Spatial Partitioning

For the hierarchical layout, grids are positioned in a 2D plane with Z-depth per directory level. A spatial grid (voxel-style) partitions world space into cells and maps each cell to the grids it contains. This is the backing data structure for both `GridVirtualizer` and `MemoryBudget`.

```js
// src/services/rendering/SpatialIndex.js

export class SpatialIndex {
    constructor(cellSize = 500) {
        this._cellSize = cellSize;
        this._cells = new Map();     // "cx,cy" → Set<CodeGrid>
    }

    insert(grid) {
        for (const key of this._cellsFor(grid.getBounds())) {
            if (!this._cells.has(key)) this._cells.set(key, new Set());
            this._cells.get(key).add(grid);
        }
    }

    query(box3) {
        const result = new Set();
        for (const key of this._cellsFor(box3)) {
            const cell = this._cells.get(key);
            if (cell) for (const g of cell) result.add(g);
        }
        return result;
    }

    _cellsFor(box) {
        const c = this._cellSize;
        const x0 = Math.floor(box.min.x / c);
        const y0 = Math.floor(box.min.y / c);
        const x1 = Math.floor(box.max.x / c);
        const y1 = Math.floor(box.max.y / c);
        const keys = [];
        for (let x = x0; x <= x1; x++)
            for (let y = y0; y <= y1; y++)
                keys.push(`${x},${y}`);
        return keys;
    }
}
```

`GridVirtualizer.update()` would then call `spatialIndex.query(frustumBounds)` instead of iterating all 1500 grids per frame. At `cellSize=500`, a typical 3840×2160 frustum footprint covers ~16 cells; 1500 grids in a 200×200 world area yields ~4 grids per cell — the query returns ~64 candidates instead of 1500.

**Estimated saving:** Frame CPU time for frustum classification drops from O(N) to O(frustum area / cell²). At 1500 grids, this saves ~0.3 ms/frame (marginal, but eliminates GC pressure from iterating 1500 objects per frame).

---

## 8. Summary of Estimated Memory Savings

| Strategy | Memory Saved | Complexity |
|----------|-------------|------------|
| Frustum culling (§2) | 0 MB GPU, eliminates ~1450 draw calls | Low — no memory change, major render perf |
| LOD LABEL mode (§3) | 0 MB GPU (group toggle), major GPU ALU | Low — DataTexture path exists |
| Memory budget + LRU unload 80% (§5) | ~939 MB GPU+heap | Medium — needs unloadContent() |
| Remove string from _committedTexts (§6) | ~75 MB heap | Low — 1-line change |
| Content cache (§5) | ~100 MB vs raw strings | Low — replace Map with bounded LRU |
| Spatial index (§7) | 0 MB, saves 0.3 ms/frame | Low once §2 exists |

**Combined target (conservative):** From ~1422 MB to ~250 MB by applying §2 + §5 + §6. This fits comfortably within the 1.5 GB WebGL process limit with headroom for atlas (21 MB), picking target (8 MB), and Three.js overhead.

---

## Implementation Order

1. **§6 string fix** — one-line, zero risk, ships immediately.
2. **§2 GridVirtualizer** — pure scene-graph manipulation, no renderer changes. Requires `grid.getBounds()` which already exists (CodeGrid.js line 236).
3. **§5 unloadContent/reloadContent** — extends CodeGrid and GlyphCollection, requires wiring in GridVirtualizer._deactivate().
4. **§4 MemoryBudget** — wraps §5, uses existing `getMemoryStats()` (GlyphRenderer.js:741).
5. **§3 LOD groups** — requires adding `groupId` assignment to `_layoutContentAsync()` in CodeGrid.
6. **§7 SpatialIndex** — optimization pass after §2 is live.
