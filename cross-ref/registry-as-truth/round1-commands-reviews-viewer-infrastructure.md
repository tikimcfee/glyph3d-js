# Round 1: Commands Reviews Viewer + Infrastructure

Reviewer: **commands**
Reviewed: **viewer** (phase0-viewer.md), **infrastructure** (phase0-infrastructure.md)

---

## Errors Found

### 1. Promise.all registration order is nondeterministic (viewer, section 4)

Viewer proposes moving `registry.register()` inside `createGridForFileAsync`, which is called in a `Promise.all` batch (line 864 of GitHubRepoViewer.js). The current code pushes grids into `this.grids` AFTER `Promise.all` resolves, iterating the `createdGrids` result array -- which `Promise.all` guarantees returns in input order regardless of completion order. By moving registration into the async function body, grids register in whichever order their `loadFileAsync` completes. A 500-line file finishes before a 5000-line file, so registration order becomes load-time-dependent, not file-tree-order.

This directly breaks the "Map insertion order = stable indices" guarantee that all three proposals rely on. Commands agent's `grid.list`, `camera.focus`, `resolveGridByIdOrIndex` -- all assume registry order matches the deterministic file iteration order. Infrastructure's `toArray('grid')` cache amplifies this: once the wrong order is cached, every consumer sees it.

**Fix**: Keep registration in the post-`Promise.all` loop (lines 886-888), not inside `createGridForFileAsync`. The viewer proposal should register grids in the same `for (const grid of createdGrids)` loop that does `scene.add`:

```js
for (const grid of createdGrids) {
    this.scene.add(grid);
    this.registry.register(grid.userData.sourcePath, grid, {
        type: 'grid', sourcePath: grid.userData.sourcePath
    });
}
this._invalidateGridsCache();
```

### 2. toArray returns a mutable cached reference (infrastructure, section 1)

Infrastructure's `toArray(type)` returns the same array object from cache. Any consumer that does `arr.push()`, `arr.sort()`, or `arr.splice()` corrupts the cache for all other consumers. The old `this.grids` was a direct-owned array so mutations were intentional. A shared cached array that looks like a plain array is a trap.

Viewer's `grids` getter returns `findByType('grid').map(e => e.grid)` (fresh array each time unless cached). Infrastructure's `toArray` returns the same reference. These are incompatible strategies. If the viewer getter delegates to `toArray`, layout managers that receive the array and hypothetically sort it would corrupt the shared cache.

**Fix**: Either `Object.freeze()` the cached array, or always return a shallow copy. Freezing is better -- it turns silent corruption into a loud TypeError.

### 3. Viewer's grids setter trap does not prevent property shadowing in all cases (viewer, section 16)

The setter trap (`set grids(_) { throw ... }`) only fires on direct assignment `this.grids = [...]`. It does not fire on `delete this.grids` followed by re-creation, or on `Object.defineProperty`. More importantly, the `loadDiff` path at line 1065 does `this.grids = result.grids` -- the setter will throw here. Viewer acknowledges this and replaces it with a register loop, but any other code path that assigns (e.g., future contributors) will get an opaque error with no guidance on what to do instead.

**Fix**: The setter error message is good. Just ensure the `loadDiff` migration is listed as a hard prerequisite before deploying the setter.

---

## Gaps

### 1. No `unregisterByType` in infrastructure's SceneRegistry

Viewer's `clearGrids` (section 5) calls `this.registry.unregisterByType('grid')`. Viewer defines this method in section 3. Infrastructure's full SceneRegistry replacement does not include `unregisterByType`. If infrastructure's version is deployed, viewer's clearGrids breaks.

Both agents independently enhanced SceneRegistry but did not coordinate on the method set. Infrastructure adds `toArray`, `removeById`, `_onChange`, `_invalidateCache`. Viewer adds `unregisterByType`. The final implementation needs both.

### 2. getByIndex signature conflict

The current SceneRegistry has `getByIndex(index, grids)` taking an external array. Infrastructure changes it to `getByIndex(index, type = 'grid')` using internal `toArray`. Commands agent's `resolveGridByIdOrIndex` does not call `getByIndex` at all -- it uses `ctx.getGrids()[idx]` directly. So the signature change is safe, but any existing callers of `getByIndex(idx, grids)` in command files will silently receive wrong behavior (the `grids` array would be interpreted as the `type` string).

**Fix**: Grep for `getByIndex` call sites before deploying. If any exist, they need migration.

### 3. No batch invalidation for clearGrids

Infrastructure acknowledges (section 6, risk 3) that `_onChange` fires per-item during bulk operations. Viewer's `unregisterByType` returns removed entries as a batch, but if implemented atop individual `unregister()` calls, each one triggers `_invalidateCache`. For 200 grids, that is 200 cache deletions followed by one rebuild. The cost is trivial (sub-microsecond deletes), but the `_onChange` callback fires 200 times. If any listener does work beyond a version bump, this becomes a problem.

### 4. Context bag `addGrid` signature mismatch

Commands proposes `addGrid(grid, opts = {})` where opts contains `{ id, type, meta }`. Infrastructure proposes `addGrid(grid, id)` where id is a plain string. These are incompatible signatures. Every command calling `ctx.addGrid` will behave differently depending on which version is deployed.

**Fix**: Agree on one signature. Commands' `opts` bag is more extensible. Infrastructure's plain `id` is simpler. Recommend the opts bag since `grid.create` already needs to pass `type` and `meta`.

---

## Tensions

### 1. Who owns the registry instance?

Viewer creates `this.registry = new SceneRegistry()` on the GitHubRepoViewer instance. Infrastructure and commands create it inside `buildContext()` in `websocket/index.js`. These are two different registry instances. If viewer registers grids in its own `this.registry` and commands query `ctx.registry`, they see different data.

Viewer's section 7 says `SceneContext.getGrids()` already delegates to `this.grids`, which would hit the getter. But the getter returns `this.registry.findByType('grid')` -- the viewer's registry, not the command context's registry. The command context's `ctx.registry` is a separate instance seeded from `viewer.grids` at init time.

This is the central tension. Resolution: there must be exactly ONE registry. Either the viewer owns it and the context bag references it, or the context bag owns it and the viewer references it. Viewer is the natural owner since it exists before the command center initializes. The context bag should receive `viewer.registry` as a parameter, not create its own.

### 2. Cache strategy: version counter vs. Map deletion

Viewer uses a version counter (`_registryVersion++`) with a version check in the getter. Infrastructure uses `_typeCache.delete(type)` with lazy rebuild on next `toArray` call. Both work. But if both are deployed, the viewer's version counter is redundant -- the registry's internal cache already handles staleness. The viewer getter should just call `registry.toArray('grid')` and drop its own caching layer.

### 3. removeGrid by index vs. by ID

Commands' `removeGrid` in the context bag accepts string ID or numeric index (via `resolveGridByIdOrIndex`). Infrastructure's `removeGrid(index)` only accepts numeric index, plus a separate `removeGridById(id)`. Commands expects a unified entry point. Infrastructure splits into two methods.

---

## Recommendations

1. **Single registry instance**: Viewer creates `this.registry = new SceneRegistry()` in its constructor. Context bag receives `viewer.registry` -- does not create a new one. This eliminates the dual-registry tension and the seed-loop hack.

2. **Register after Promise.all, not inside createGridForFileAsync**: Keep `createGridForFileAsync` as a pure grid factory. Registration happens in the deterministic post-await loop. This is a hard requirement for stable indices.

3. **Merge SceneRegistry enhancements**: Take infrastructure's version (with `toArray`, `_invalidateCache`, `_onChange`) and add viewer's `unregisterByType`. Drop viewer's separate cache layer -- use `registry.toArray('grid')` directly.

4. **Freeze toArray output**: `Object.freeze(arr)` before caching. Prevents accidental mutation of shared reference. Negligible cost.

5. **Unify addGrid signature**: Use `addGrid(grid, opts = {})` from the commands proposal. Infrastructure's `addGrid(grid, id)` becomes `addGrid(grid, { id })`.

6. **Unify removeGrid**: Single method `removeGrid(idOrIndex)` that delegates to `resolveGridByIdOrIndex` internally. Drop the split `removeGrid`/`removeGridById`.

---

## Key Insight

The three proposals independently arrived at "registry is truth" but diverged on **who instantiates it** and **when registration happens**. The `Promise.all` ordering bug is the most dangerous error because it is silent -- indices shift unpredictably based on network timing and file sizes, making it unreproducible across runs. The fix is simple (register post-await, not inside the async function), but it must be explicit in the implementation plan because viewer's proposal actively moves registration into the wrong place. Every downstream consumer -- commands, camera, minimap, tour stops -- inherits the wrong order if this is not caught.
