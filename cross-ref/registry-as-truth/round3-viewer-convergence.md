# Round 3: Viewer Convergence

## Settled

All three agents and all three Round 1 reviews converge on these points with zero remaining disagreement:

1. **Single registry instance, viewer-owned.** The viewer creates `this.registry = new SceneRegistry()` in its constructor. The context bag receives `viewer.registry` as a parameter -- it does not create its own. This eliminates the dual-registry tension, the seed loop, and the drift window between `viewer.grids` and `registry.toArray('grid')`.

2. **Register after Promise.all, not inside createGridForFileAsync.** The async factory returns the grid. Registration happens in the deterministic post-await loop where `Promise.all` guarantees input-order results. The user's directive confirms: parallel loading stays for performance, with a post-sort by source path after `Promise.all` resolves to guarantee deterministic ordering regardless of completion order. This applies to both `loadRepository` and `loadDiff`.

3. **Infrastructure's SceneRegistry is the base implementation**, plus viewer's `unregisterByType(type)`. Commands' `grids()` convenience method is dropped in favor of `toArray('grid')`.

4. **Freeze `toArray` output.** `Object.freeze(arr)` on the cached array before storing it. Returns a safe immutable reference. One freeze per invalidation cycle, zero cost per read. Prevents the mutable-cache corruption vector that all three Round 1 reviews flagged.

5. **Use infrastructure's `_onChange` callback** instead of the viewer's manual `_invalidateGridsCache()` calls. The viewer wires `registry._onChange = () => { ... }` once, and drops its own version-counter caching layer. The registry's internal `_typeCache` with `_invalidateCache` is the single caching layer.

6. **Drop the viewer-side cache entirely.** The `grids` getter becomes `get grids() { return this.registry.toArray('grid'); }` -- one line, no version counter, no `_gridsCache`, no `_gridsCacheVersion`. The frozen `toArray` return is safe to hold for a frame.

7. **Commands' `addGrid(grid, opts = {})` signature wins** over infrastructure's `addGrid(grid, id)`. The opts bag supports `id`, `type`, and `meta` without signature changes later. Infrastructure's version becomes `addGrid(grid, { id })` at call sites.

8. **Unified `removeGrid(idOrIndex)`** with string/number dispatch (commands' approach). Infrastructure's split `removeGrid(index)` / `removeGridById(id)` is dropped. One method, one call site pattern. Internally uses `resolveGridByIdOrIndex` for disambiguation.

9. **Integer-first with out-of-range fallthrough** for `resolveGridByIdOrIndex` (infrastructure's approach). Pure-digit args resolve as array index first; only if out of bounds does it fall through to registry lookup. Commands' strict version (error on OOB integers, no fallthrough) is dropped.

10. **`camera.focus` deduplication.** The three-step lookup in `camera.focus` calls `resolveGridByIdOrIndex` for steps 1-2, then adds filename-substring as a third fallback. No standalone three-step function.

11. **Post-sort by source path.** Per the user's directive, after `Promise.all` resolves in `loadRepository` (and `loadDiff`), the `createdGrids` array is sorted by source path before registration. This makes ordering fully deterministic -- independent of file sizes, network timing, or worker completion order. The sort key is `grid.userData.sourcePath`.

---

## Implementation Plan

### Step 1: SceneRegistry enhancements (SceneRegistry.js)
- Deploy infrastructure's full SceneRegistry rewrite (section 1 of phase0-infrastructure)
- Add viewer's `unregisterByType(type)` method
- Add `Object.freeze(arr)` to `toArray` before caching: `this._typeCache.set(type, Object.freeze(arr))`
- Verify `getByIndex` has no external callers with old `(index, grids)` signature (grep before merging)

### Step 2: Viewer migration (GitHubRepoViewer.js)
- Replace `this.grids = []` with `this.registry = new SceneRegistry()`
- Add getter: `get grids() { return this.registry.toArray('grid'); }`
- Add setter trap: `set grids(_) { throw new Error('Use registry.register() / registry.unregister()'); }`
- Delete `_gridsCache`, `_gridsCacheVersion`, `_registryVersion`, `_invalidateGridsCache()`
- In `loadRepository`: keep `createGridForFileAsync` as a pure factory (no registration inside it). After `const createdGrids = await Promise.all(gridPromises)`, sort by source path, then register in a sequential loop:
  ```js
  const createdGrids = await Promise.all(gridPromises);
  createdGrids.sort((a, b) => (a.userData.sourcePath || '').localeCompare(b.userData.sourcePath || ''));
  for (const grid of createdGrids) {
      this.scene.add(grid);
      this.registry.register(grid.userData.sourcePath, grid, {
          type: 'grid', sourcePath: grid.userData.sourcePath
      });
  }
  ```
- Delete the `this.grids.push(grid)` at line 888
- Rewrite `clearGrids` to use `this.registry.unregisterByType('grid')`
- Rewrite `loadDiff` assignment to sort + register each diff grid

### Step 3: Context bag rewrite (websocket/index.js)
- `buildContext` receives `viewer.registry` instead of creating its own SceneRegistry
- `getGrids: () => viewer.registry.toArray('grid')`
- `addGrid(grid, opts = {})` using commands' signature -- registers in `viewer.registry`
- `removeGrid(idOrIndex)` with string/number dispatch
- Delete the seed loop (no longer needed -- viewer owns the registry and it is already populated)
- Wire `registry` reference: `registry: viewer.registry`

### Step 4: Integer-first guard (spatialHelpers.js)
- Deploy infrastructure's `resolveGridByIdOrIndex` with out-of-range fallthrough
- Delete old `resolveGrid(grids, arg)` or add deprecation wrapper

### Step 5: Command handler migration (all command files)
- Replace `resolveGrid(grids, arg)` with `resolveGridByIdOrIndex(ctx, arg)` at all call sites
- Replace `ctx.getGrids()` iteration with `ctx.registry.findByType('grid')` where entry metadata is needed
- Deduplicate `camera.focus` three-step lookup to use `resolveGridByIdOrIndex` + filename fallback
- `grid.create`: uses `ctx.addGrid(grid, { id })` as single registration path -- the `getIdByGrid` guard inside `addGrid` prevents double-register

### Step 6: Verification
- Load repo, confirm grid order matches alphabetical source path order
- Switch layouts, clear, load diff, clear, load repo again
- Run `grid.list` via WebSocket, confirm indices are stable across repeated loads
- Test `grid.remove` by ID and by index
- Test `camera.focus` with numeric index, registry ID, and filename substring

---

## Implementer Vote

**infrastructure** -- owns SceneRegistry (the central artifact), the context bag rewrite, and the `resolveGridByIdOrIndex` guard. Steps 1, 3, and 4 are infrastructure's core domain. The viewer migration (step 2) and command handler migration (step 5) are mechanical applications of the patterns infrastructure defines. Infrastructure has the clearest view of cache invalidation semantics, the `_onChange` callback, and the freeze contract -- getting these wrong silently corrupts downstream consumers.
