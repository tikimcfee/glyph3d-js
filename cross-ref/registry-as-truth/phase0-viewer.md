# Phase 0: Registry as Source of Truth — Viewer Migration

## Directive

Delete `this.grids = []`. Replace with a getter that derives from `SceneRegistry.findByType('grid')`. All grid creation flows through `registry.register()`, all removal through `registry.unregister()`. The raw array is gone.

---

## 1. Mutation Audit — Every `this.grids` Site

### Writes (4 sites)
| Line | Code | Migration |
|------|------|-----------|
| 113 | `this.grids = []` | Delete. Add `this.registry = new SceneRegistry()`. Add getter. |
| 888 | `this.grids.push(grid)` | Replace with `this.registry.register(path, grid, { type: 'grid', sourcePath: path })` |
| 1007 | `this.grids = []` (clearGrids) | Replace with `for (const e of this.registry.findByType('grid')) this.registry.unregister(e.id)` |
| 1065 | `this.grids = result.grids` (loadDiff) | Register each diff grid: `result.grids.forEach((g,i) => this.registry.register('diff:' + i, g, { type: 'grid', sourcePath: g.userData?.sourcePath }))` |

### Reads (21 sites) — all become `this.grids` via the getter
No changes needed at read sites. The getter returns a fresh array each call, identical to the old `this.grids` reference semantics since `clearGrids()` already replaced the array object.

---

## 2. The Getter + Cache

```js
// In GitHubRepoViewer constructor, replace: this.grids = [];
this.registry = new SceneRegistry();
this._gridsCache = null;
this._gridsCacheVersion = 0;
this._registryVersion = 0;

get grids() {
    if (!this._gridsCache || this._gridsCacheVersion !== this._registryVersion) {
        this._gridsCache = this.registry.findByType('grid').map(e => e.grid);
        this._gridsCacheVersion = this._registryVersion;
    }
    return this._gridsCache;
}

_invalidateGridsCache() {
    this._registryVersion++;
}
```

Every `register()` and `unregister()` call must be followed by `this._invalidateGridsCache()`. This is cheap — one integer increment — and avoids the `findByType('grid')` scan on every minimap frame (60fps hot path).

---

## 3. SceneRegistry Enhancement — `unregisterByType(type)`

Add to SceneRegistry for `clearGrids()`:

```js
/**
 * Remove all entries of a given type.
 * Returns removed entries (caller iterates for disposal).
 * @param {string} type
 * @returns {RegistryEntry[]}
 */
unregisterByType(type) {
    const removed = [];
    for (const [id, entry] of this._entries) {
        if (entry.type === type) {
            this._entries.delete(id);
            this._gridToId.delete(entry.grid);
            removed.push(entry);
        }
    }
    return removed;
}
```

---

## 4. `createGridForFileAsync` — Registration Point

```js
async createGridForFileAsync(path, content) {
    const filename = path.split('/').pop();
    const grid = new CodeGrid(this.scene, this.atlas);
    await grid.loadFileAsync(filename, content);
    grid.userData.sourcePath = path;

    // Register with sourcePath as ID
    this.registry.register(path, grid, { type: 'grid', sourcePath: path });
    this._invalidateGridsCache();

    return grid;
}
```

The downstream `this.grids.push(grid)` at line 888 is deleted — registration IS the push.

---

## 5. `clearGrids` — Registry-Based Teardown

```js
clearGrids() {
    const removed = this.registry.unregisterByType('grid');
    for (const entry of removed) {
        entry.grid.dispose();
        this.scene.remove(entry.grid);
    }
    this._invalidateGridsCache();

    this.layoutManager.clear();
    if (this.hierarchicalManager) this.hierarchicalManager.clearAll();
    if (this.diffController) this.diffController.clearGrids();

    if (this.fileStateManager) this.fileStateManager.clear();
    if (this.codeColorManager) this.codeColorManager.resetAllColors();
    if (this.selectionManager) this.selectionManager.dispose();
    this.heatmapProvider = null;

    if (this.backdropManager) { this.backdropManager.destroy(); this.backdropManager = null; }
    if (this.nameplateManager) { this.nameplateManager.destroy(); this.nameplateManager = null; }
    if (this.treemapLabelManager) { this.treemapLabelManager.destroy(); this.treemapLabelManager = null; }

    this._tabIndex = -1;
    if (this.minimapOverlay) this.minimapOverlay.rebuildLayout();
}
```

Safe iteration: `unregisterByType` returns a fresh array, mutations don't affect iteration.

---

## 6. `loadDiff` — Diff Grid Registration

```js
// Line 1065, replace: this.grids = result.grids;
for (const grid of result.grids) {
    const sp = grid.userData?.sourcePath || `diff:${result.grids.indexOf(grid)}`;
    this.registry.register(sp, grid, { type: 'grid', sourcePath: sp });
}
this._invalidateGridsCache();
```

`clearGrids()` already called before this point (line 1054), so the registry is clean.

---

## 7. `SceneContext.getGrids` — Unchanged

```js
// SceneContext constructor already has:
getGrids: () => this.grids,
```

The getter fires on every call. No change needed — `this.grids` now resolves via the getter.

---

## 8. MinimapOverlay — Performance Analysis

`MinimapOverlay.update()` calls `this._getGrids()` every frame (line 109). With the cache, this hits the version check (one integer compare) and returns the cached array. Cost: negligible.

`MinimapOverlay.rebuildLayout()` (line 83) also calls `this._getGrids()`. Same cache path. No change needed.

**No changes to MinimapOverlay.js.**

---

## 9. SelectionManager — Registry Upgrade Path

Currently receives `grids` array as parameter everywhere. Two options:

**Option A (Phase 0 — minimal):** No change. The getter-derived array flows through the existing `{ grids: this.grids }` call sites.

**Option B (Phase 1 — registry-native):** SelectionManager takes registry ref, uses `registry.get(sourcePath)` instead of `grids.find()`. Eliminates O(n) scan per select/deselect.

Phase 0 does Option A. The 6 call sites that pass `this.grids`:
- Line 291: `canvas-click` handler — passes `this.grids` (getter fires, cached)
- Line 562: Escape shortcut — `selectionManager.clear(this.grids)`
- Line 668: Tab traverse — `selectionManager.select(sp, { grids: this.grids })`
- Line 1190: Tree file click — `selectionManager.select(node.path, { grids: this.grids })`
- SelectionManager._findGrid does `grids.find(g => g.userData?.sourcePath === sp)` — works unchanged.

**All unchanged in Phase 0.**

---

## 10. CameraController — No Changes

`CameraController` accesses grids via `this.ctx.getGrids()` (SceneContext closure). The closure calls `viewer.grids` which hits the getter. No change needed.

`focusOnGrid(index)` uses numeric index into the array. This is stable as long as the array order matches registration order. `findByType('grid')` iterates Map insertion order, which matches `register()` call order. Since `createGridForFileAsync` is called in file-load order, the array order is preserved.

---

## 11. Layout Managers — No Changes

All layout managers receive `grids` as a parameter:
- `hierarchicalManager.layoutHierarchy(this.grids)` — line 699, 892
- `spiralManager.layoutSpiral(this.grids)` — line 706
- `treemapManager.layoutTreemap(this.grids)` — line 713
- `stackManager.layout(this.grids)` — line 731

They receive whatever the getter returns. They don't mutate the array. No changes.

---

## 12. Tree UI `grids.indexOf` — Registry Upgrade

Line 1179: `const gridIndex = node.grid ? this.grids.indexOf(node.grid) : -1;`

This O(n) scan runs once per tree-build (not hot). In Phase 0, it works unchanged via the getter. In Phase 1, replace with:

```js
const registryId = this.registry.getIdByGrid(node.grid);
const gridIndex = registryId ? this.grids.indexOf(node.grid) : -1;
// Or better: focusOnGrid accepts registryId directly
```

---

## 13. `loadRepository` Grid-Add Loop — Simplified

Current (lines 886-888):
```js
for (const grid of createdGrids) {
    this.scene.add(grid);
    this.grids.push(grid);
}
```

After migration:
```js
for (const grid of createdGrids) {
    this.scene.add(grid);
    // Registration already happened in createGridForFileAsync
}
```

The `push` is gone because `createGridForFileAsync` registers. `scene.add` remains (registry doesn't own scene membership).

---

## 14. Diff Controller Interaction

`DiffController` has its own `this.grids = []` internally. This is an internal tracking array for the diff subsystem. It remains as-is — the viewer registers diff grids into the main registry in `loadDiff()`.

---

## 15. Implementation Order

1. **Add `unregisterByType`** to `SceneRegistry.js` (5 lines)
2. **Replace `this.grids = []`** with registry + getter + cache in constructor
3. **Move registration into `createGridForFileAsync`** — delete `this.grids.push(grid)` at line 888
4. **Rewrite `clearGrids`** to use `registry.unregisterByType('grid')`
5. **Rewrite `loadDiff` assignment** to register each diff grid
6. **Delete the bare `this.grids = []` in `clearGrids`** — registry is now empty after unregisterByType
7. **Test:** Load repo, switch layouts, clear, load diff, clear, load repo again

---

## 16. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Map iteration order != file load order | ES2015 guarantees Map preserves insertion order. `register()` order = load order. |
| Getter called in tight loop (minimap) | Version-checked cache. One int compare per call. |
| `grids.length` in conditionals | Getter returns array, `.length` works. |
| `for (const grid of this.grids)` | Getter returns fresh array, iteration safe even if registry mutates mid-loop. |
| `loadDiff` assigns `this.grids = result.grids` | Replaced with register loop. No setter on `grids` — assignment would silently create own property shadowing getter. Add a setter that throws to catch mistakes. |

Add a setter trap:

```js
set grids(_) {
    throw new Error('Cannot assign to grids — use registry.register() / registry.unregister()');
}
```

---

## Files Modified

| File | Change |
|------|--------|
| `examples/github-viewer/websocket/SceneRegistry.js` | Add `unregisterByType(type)` |
| `examples/github-viewer/GitHubRepoViewer.js` | Registry as truth: constructor, createGridForFileAsync, clearGrids, loadDiff |
| `examples/github-viewer/SceneContext.js` | No change (closure already indirects) |
| `examples/github-viewer/SelectionManager.js` | No change (Phase 0) |
| `examples/github-viewer/components/MinimapOverlay.js` | No change |
| `examples/github-viewer/CameraController.js` | No change |
| `src/collections/*.js` (layout managers) | No change |
