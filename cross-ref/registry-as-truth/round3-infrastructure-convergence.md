# Round 3: Infrastructure Convergence

Agent: **infrastructure**

---

## Settled

### 1. Promise.all ordering: post-sort, not post-await registration

All three agents identified the Promise.all nondeterministic ordering bug in Round 1. The user's directive resolves this cleanly: keep parallel loading via `Promise.all` for performance, then sort the result array by source path before registration. This gives deterministic ordering regardless of network timing or file size, while preserving the concurrency benefit.

The viewer proposal to register inside `createGridForFileAsync` is withdrawn. Registration happens in a sequential loop after `Promise.all` resolves and after the sort. The same pattern applies to `loadDiff`.

### 2. Registry gains `sortByType(type, compareFn)`

The registry gets a new method that re-orders entries of a given type in place. This is the primitive that makes post-sort work at the registry level, not just at the caller level. After `Promise.all` + registration, the caller invokes:

```js
registry.sortByType('grid', (a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath));
```

This re-inserts entries in sorted order (Map deletion + re-insertion preserves the new order per ES2015 spec), invalidates the type cache, and all downstream consumers (`toArray`, `getByIndex`, `findByType`) see the sorted order.

### 3. Single registry instance owned by the viewer

Viewer creates `this.registry = new SceneRegistry()` in its constructor. The context bag receives `viewer.registry` as a parameter -- no second instance, no seed loop, no drift window.

### 4. Infrastructure's SceneRegistry is the base, plus viewer's `unregisterByType`

The combined method set: `register`, `unregister`, `removeById` (alias), `get`, `has`, `findByType`, `toArray` (cached), `findByMeta`, `list`, `getIdByGrid`, `getByIndex(index, type)`, `typeCounts`, `size`, `unregisterByType`, `sortByType`, `_onChange`, `_invalidateCache`.

Commands' `grids()` method is dropped in favor of `toArray('grid')`.

### 5. `toArray` returns a frozen cached array

`Object.freeze(arr)` at cache creation time. Returns the same reference until invalidated. Prevents silent mutation of shared cache. Cost: one freeze per invalidation, zero per read.

### 6. `_onChange` callback replaces viewer's manual `_invalidateGridsCache`

Registry's internal `_invalidateCache` fires on every register/unregister/sortByType. Viewer wires one callback if it needs a version counter; otherwise it calls `registry.toArray('grid')` directly, which handles staleness internally.

### 7. Integer-first guard with out-of-range fallthrough

Infrastructure's `resolveGridByIdOrIndex` is adopted: pure-integer args resolve as array index first; only if out of range do they fall through to registry lookup. Commands' strict version (error on out-of-range integer) is not adopted.

### 8. `addGrid` signature: `addGrid(grid, opts = {})`

Commands' opts-bag signature wins. Infrastructure's `addGrid(grid, id)` becomes `addGrid(grid, { id })`. The opts bag supports `id`, `type`, and `meta` fields.

### 9. Separate `removeGrid(index)` and `removeGridById(id)`

Callers resolve first via `resolveGridByIdOrIndex`, then call the appropriate removal method. No hidden type-checking in the removal path. Commands' unified `removeGrid(idOrIndex)` is not adopted -- the disambiguation belongs at the resolve step, not inside the removal method.

### 10. `camera.focus` deduplication

`camera.focus` calls `resolveGridByIdOrIndex` for steps 1-2, then adds filename-substring as a third fallback. No separate three-step function.

---

## Implementation Plan

### Step 1: SceneRegistry.js enhancements

Add to the existing SceneRegistry:
- `unregisterByType(type)` -- bulk remove, returns removed entries, single cache invalidation
- `sortByType(type, compareFn)` -- re-order entries of a given type by deleting and re-inserting in sorted order, invalidate cache
- `_typeCache` + `_invalidateCache(type)` -- per-type cache with lazy rebuild
- `_onChange` callback -- single external listener, called by `_invalidateCache`
- `toArray(type)` -- cached, frozen array of grid objects
- `removeById(id)` alias for `unregister`
- `getByIndex(index, type = 'grid')` -- indexes into `toArray`, no external array parameter
- Freeze `toArray` output with `Object.freeze`

### Step 2: Integer-first guard in spatialHelpers.js

Replace `resolveGridByIdOrIndex` with the integer-first version that falls through to registry on out-of-range integers. No behavioral change for non-integer args.

### Step 3: Context bag rewrite in websocket/index.js

- Receive `viewer.registry` instead of creating a new one
- `getGrids: () => registry.toArray('grid')`
- `addGrid(grid, opts = {})` with opts-bag signature
- `removeGrid(index)` and `removeGridById(id)` as separate methods
- Drop the seed loop

### Step 4: Viewer migration in GitHubRepoViewer.js

- Constructor: `this.registry = new SceneRegistry()`, getter `get grids()` delegates to `registry.toArray('grid')`, setter trap throws
- `createGridForFileAsync`: pure factory, returns grid, does NOT register
- `loadRepository` post-`Promise.all` loop: register each grid by sourcePath, then call `registry.sortByType('grid', (a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath))`
- `clearGrids`: `registry.unregisterByType('grid')` + dispose loop
- `loadDiff`: register each diff grid in a loop, then sort

### Step 5: Command migration

All command files swap `resolveGrid(grids, arg)` to `resolveGridByIdOrIndex(ctx, arg)`. `grid.list` uses `findByType`. `scene.reset` uses `findByType` + `unregister`. `camera.focus` uses `resolveGridByIdOrIndex` + filename fallback. `findAgentGrids` uses `findByType('agent')` + `findByType('window')`.

### Step 6: Grep and verify

- Grep for `viewer.grids.push`, `viewer.grids.splice`, `viewer.grids =` -- all must be gone
- Grep for `getByIndex(idx, ` with a second arg that is not a string type -- migrate
- Verify no `console.warn` on normal `grid.create` flow (no double-register)

---

## Implementer Vote

**viewer** should implement this.

Rationale: The heaviest file changes are in `GitHubRepoViewer.js` (constructor rewrite, `createGridForFileAsync`, `loadRepository` post-sort loop, `clearGrids`, `loadDiff`). The viewer agent wrote the original mutation audit (21 read sites, 4 write sites) and knows the interaction points with MinimapOverlay, SelectionManager, CameraController, and layout managers. The SceneRegistry enhancements (Step 1) are mechanical additions that the viewer agent can apply from the agreed spec. The `sortByType` method is 15 lines of code -- straightforward Map delete + re-insert. The command migration (Step 5) is a follow-up that the commands agent can do after the registry and viewer are landed.
