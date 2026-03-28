# Round 3: Commands Convergence

Agent: **commands**

---

## Settled

These items are resolved. All three agents and the user agree. No further debate.

### 1. Registry is the single source of truth
`viewer.grids` becomes a derived getter. All creation flows through `registry.register()`, all removal through `registry.unregister()`. The raw array is gone. Unanimous across all three Phase 0 proposals.

### 2. Single registry instance, owned by the viewer
Viewer creates `this.registry = new SceneRegistry()` in its constructor. The context bag receives `viewer.registry` as a parameter -- it does not create its own. This eliminates the dual-registry tension and the seed-loop hack identified in Round 1. The viewer is the application; the context bag is the command interface to it.

### 3. Parallel loading + post-sort for deterministic order
Per user directive: `Promise.all` stays for performance. `createGridForFileAsync` remains a pure grid factory -- it does NOT call `registry.register()` internally. After `Promise.all` resolves, a post-sort by source path produces deterministic ordering regardless of completion order. Registration happens in this sorted post-await loop. This supersedes the Round 1 fix (which proposed registration in the original `for (const grid of createdGrids)` loop without sorting). The sort makes order fully deterministic even across runs with different network conditions.

### 4. Registry gains `sortByType(type, compareFn)`
Per user directive, the registry gets a `sortByType` method that re-orders entries of a given type according to a caller-provided comparator. This is the mechanism for the post-sort: after `Promise.all`, the viewer registers grids in whatever order, then calls `registry.sortByType('grid', (a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath))` to establish deterministic order. Downstream consumers (`focusOnGrid`, minimap, tab traversal, tour stops) see stable indices from that point on.

### 5. Infrastructure's SceneRegistry as the canonical base
Infrastructure's full rewrite (with `toArray`, `_invalidateCache`, `_onChange`, `findByType`, `findByMeta`, `getByIndex(index, type)`, `removeById`) is the base. Viewer's `unregisterByType` is added. Commands' `grids()` method is dropped in favor of `toArray('grid')`.

### 6. `toArray` returns a frozen cached array
`Object.freeze(arr)` on the cached array at creation time. Returns the reference safely -- no caller can corrupt the shared cache. One freeze per invalidation cycle, zero cost per read. This was identified as the highest-priority fix by all three Round 1 reviews.

### 7. Infrastructure's `_onChange` callback replaces manual invalidation
Viewer's manual `_invalidateGridsCache()` calls are dropped. The viewer wires `registry._onChange = () => { this._registryVersion++; }` once. Or better: the viewer getter just calls `registry.toArray('grid')` directly and drops its own caching layer entirely, since the registry's internal cache already handles staleness.

### 8. `addGrid` signature: `addGrid(grid, opts = {})`
Commands' opts-bag signature wins. It is a superset of infrastructure's `addGrid(grid, id)`. The extra fields (`type`, `meta`) cost nothing and `grid.create` already needs them. Infrastructure's version becomes `addGrid(grid, { id })`.

### 9. `removeGrid` unified: `removeGrid(idOrIndex)`
Single method accepting string ID or numeric index. Uses `resolveGridByIdOrIndex` internally for disambiguation. Infrastructure's split `removeGrid`/`removeGridById` is dropped. One method, one call site pattern.

### 10. Integer-first guard with out-of-range fallthrough
Infrastructure's version of `resolveGridByIdOrIndex`: pure-integer args resolve as array indices first. If out of range, fall through to registry lookup (handles deliberate numeric registry IDs). Commands' strict version (error on OOB integer) is dropped -- the fallthrough is safer and handles edge cases.

### 11. `camera.focus` deduplication
`camera.focus` calls `resolveGridByIdOrIndex` for steps 1-2 (numeric index, registry ID), then adds filename-substring as a third fallback. No separate three-step function.

---

## Implementation Plan

Ordered by dependency. Each step is independently deployable.

### Step 1: SceneRegistry enhancements (`SceneRegistry.js`)
- Deploy infrastructure's full rewrite as the base
- Add viewer's `unregisterByType(type)` method
- Add `sortByType(type, compareFn)` method:
  ```js
  sortByType(type, compareFn) {
      const entries = this.findByType(type);
      entries.sort(compareFn);
      // Rebuild Map insertion order: delete then re-insert in sorted order
      for (const entry of entries) {
          this._entries.delete(entry.id);
      }
      for (const entry of entries) {
          this._entries.set(entry.id, entry);
      }
      this._invalidateCache(type);
  }
  ```
- Freeze `toArray` output: change line 143 to `Object.freeze(arr)` before caching
- No callers break -- all new methods are additive

### Step 2: Integer-first guard (`spatialHelpers.js`)
- Deploy infrastructure's `resolveGridByIdOrIndex` with out-of-range fallthrough
- Retire old `resolveGrid(grids, arg)` -- leave as deprecated wrapper for now

### Step 3: Context bag rewrite (`websocket/index.js`)
- `buildContext` receives `viewer.registry` as parameter, does not create its own
- `getGrids: () => viewer.registry.toArray('grid')`
- `addGrid(grid, opts = {})` with commands' opts-bag signature
- `removeGrid(idOrIndex)` unified method using `resolveGridByIdOrIndex`
- Drop seed loop -- viewer's registry is already populated
- Depends on Steps 1 and 2

### Step 4: Viewer migration (`GitHubRepoViewer.js`)
- Replace `this.grids = []` with `this.registry = new SceneRegistry()`
- Add getter: `get grids() { return this.registry.toArray('grid'); }`
- Add setter trap: `set grids(_) { throw new Error('Use registry.register()/unregister()'); }`
- `createGridForFileAsync` stays as pure factory -- no registration inside
- Post-`Promise.all` loop: register all grids, then `this.registry.sortByType('grid', (a, b) => a.meta.sourcePath.localeCompare(b.meta.sourcePath))`
- Rewrite `clearGrids` to use `registry.unregisterByType('grid')`
- Rewrite `loadDiff` assignment to register loop + sort
- Drop viewer-side version-counter cache -- `toArray` handles it
- Depends on Step 1

### Step 5: Command file migration (all command files)
- Swap all `resolveGrid(grids, arg)` calls to `resolveGridByIdOrIndex(ctx, arg)`
- `grid.list` uses `ctx.registry.findByType('grid')`
- `scene.reset` uses `ctx.registry.findByType(type)` per type then `unregister`
- `camera.focus` calls `resolveGridByIdOrIndex` + filename-substring fallback
- `findAgentGrids` uses registry types, drops name-prefix scanning
- Can be done in any order after Steps 1-4

### Step 6: Validation
- Load repo, verify grid order matches sorted source paths
- Switch layouts, clear, load diff, clear, load repo again
- Run `grid.list` -- confirm indices are stable across repeated loads
- Test `grid.remove` by ID and by index
- Test `camera.focus` with numeric index, registry ID, and filename substring
- Verify no `console.warn` on normal `grid.create` flow (no double-register)

---

## Implementer Vote

**viewer** -- the viewer agent should implement this.

Rationale: The critical path runs through `GitHubRepoViewer.js` (Steps 1 and 4). The viewer agent authored the mutation audit, knows every `this.grids` site (4 writes, 21 reads), and owns the `createGridForFileAsync` / `clearGrids` / `loadDiff` flows where registration order is determined. The `sortByType` post-sort and the getter/setter trap are viewer-file changes. Steps 3 and 5 (context bag and command files) are mechanical rewiring that follows naturally once the viewer-side registry is in place. Infrastructure could do Step 1 in isolation, but the tight coupling between Steps 1 and 4 means a single implementer avoids coordination overhead.
