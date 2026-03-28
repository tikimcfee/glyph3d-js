# Implementation Summary: SceneRegistry as Source of Truth

Implementer: viewer agent
Date: 2026-03-27

## What changed

The `grids` array is eliminated as a data store. `SceneRegistry` is now the single source of truth for all scene objects. All grid creation flows through `registry.register()`, all removal through `registry.unregister()`.

---

## Files modified (13 files)

### Step 1: SceneRegistry enhancements
**`examples/github-viewer/websocket/SceneRegistry.js`** -- Full rewrite.
- Added `_typeCache` (Map) with `Object.freeze()` on cached arrays
- Added `_onChange` callback hook (fires on every register/unregister)
- Added `_invalidateCache(type)` -- deletes type cache + fires onChange
- Added `toArray(type)` -- returns frozen cached array of grid objects
- Added `sortByType(type, compareFn)` -- re-orders entries via Map delete + re-insert
- Added `removeById(id)` alias for `unregister`
- Added `unregisterByType(type)` -- bulk removal, single cache invalidation
- Changed `getByIndex(index, type='grid')` -- no external array needed
- Changed `register`/`unregister` -- call `_invalidateCache` on every mutation

### Step 2: Integer-first guard
**`examples/github-viewer/websocket/commands/spatialHelpers.js`**
- `resolveGridByIdOrIndex`: pure-digit args (`/^\d+$/`) resolve as numeric index first
- Out-of-range integers fall through to registry lookup (handles numeric IDs)
- Non-digit args go to registry lookup first
- Old `resolveGrid(grids, arg)` kept for backward compat (no callers remain)

### Step 3: Context bag rewrite
**`examples/github-viewer/websocket/index.js`**
- `buildContext` receives `viewer.registry` (single instance, viewer-owned)
- `getGrids()` returns `registry.toArray('grid')` (frozen cached array)
- `addGrid(grid, opts={})` -- opts bag with id, type, meta; registers + scene.add
- `removeGrid(idOrIndex)` -- accepts string ID or numeric index; unregister + dispose + scene.remove
- Seed loop eliminated (viewer owns registry, it is already populated)

### Step 4: GitHubRepoViewer migration
**`examples/github-viewer/GitHubRepoViewer.js`**
- Added `import SceneRegistry` from websocket/SceneRegistry.js
- Constructor: `this.grids = []` replaced with `this.registry = new SceneRegistry()`
- Added `get grids()` getter: returns `this.registry.toArray('grid')`
- Added `set grids(_)` setter trap: throws Error (catches stale assignment)
- `loadRepository`: after `Promise.all`, sort `createdGrids` by source path, then register each grid
- `clearGrids`: uses `this.registry.unregisterByType('grid')`, iterates returned entries for dispose + scene.remove
- `loadDiff`: sorts diff grids by source path, registers each in a loop (replaces `this.grids = result.grids`)
- `createGridForFileAsync`: unchanged (pure factory, no registration inside)

### Step 5: Command file migration

**`examples/github-viewer/websocket/commands/gridCommands.js`**
- `grid.list`: uses `ctx.registry.findByType('grid')`, shows registry ID column
- `grid.info`: uses `resolveGridByIdOrIndex`, shows registryId field
- `grid.color`, `grid.visibility`, `grid.text`, `grid.position`, `grid.scale`: all use `resolveGridByIdOrIndex`
- `grid.create`: single registration via `ctx.addGrid(grid, { id })`, no double-register
- `grid.remove`: resolves by ID or index, removes via `ctx.removeGrid(registryId)`

**`examples/github-viewer/websocket/commands/cameraCommands.js`**
- `camera.focus`: uses `resolveGridByIdOrIndex` for steps 1-2 (index, ID), filename-substring as step 3

**`examples/github-viewer/websocket/commands/sceneCommands.js`**
- `scene.info`: uses `ctx.registry.findByType('grid')` and `ctx.registry.typeCounts()`

**`examples/github-viewer/websocket/commands/searchCommands.js`**
- `search`: iterates `ctx.registry.findByType('grid')` entries, includes registry ID in results

**`examples/github-viewer/websocket/commands/selectCommands.js`**
- `select`, `select.add`: find grids via `ctx.registry.findByType('grid')` with path matching

**`examples/github-viewer/websocket/commands/compositionCommands.js`**
- `grid.align`, `grid.attach`, `grid.stack`: all swapped to `resolveGridByIdOrIndex(ctx, arg)`

**`examples/github-viewer/websocket/commands/spatialCommands.js`**
- `grid.bounds`, `grid.bounds.union`, `grid.anchor`, `grid.distance`, `grid.overlap`: all swapped to `resolveGridByIdOrIndex(ctx, arg)`

**`examples/github-viewer/websocket/commands/navigationCommands.js`**
- `camera.frame`: uses `resolveGridByIdOrIndex` for index resolution
- `tour.stop`: stores `registryId` on each stop for stable replay
- `tour.play`: resolves stops via `registryId` first, falls back to `gridIndex`

**`examples/github-viewer/websocket/commands/systemCommands.js`**
- `status`: uses `ctx.registry.findByType('grid')` for counts, shows registry total

**`examples/github-viewer/websocket/commands/annotationCommands.js`**
- `highlight.grid`: uses `resolveGridByIdOrIndex`
- `camera.lookat.grid`: uses `resolveGridByIdOrIndex`
- `scene.reset --windows`: registry-based removal of agent/window types (no reverse-index iteration)

**`examples/github-viewer/websocket/commands/agentLayoutCommands.js`**
- `findAgentGrids`: registry-native, returns `registryId` instead of `index`
- `layout.focus`: computes index on demand via `ctx.getGrids().indexOf(target.grid)`
- `layout.agents.list`: shows `registryId` column instead of grid index

---

## Key invariants

1. **Frozen `toArray` output** -- no caller can mutate the cached array
2. **Single registry instance** -- viewer creates it, context bag references it
3. **Register after `Promise.all`** -- sorted by source path for deterministic order
4. **Integer-first guard** -- prevents ID "42" from shadowing index 42
5. **`scene.add`/`scene.remove` always paired with register/unregister**
6. **Setter trap on `this.grids`** -- catches any stale `this.grids = x` assignment

## What was NOT changed

- `createGridForFileAsync` -- still a pure factory (no registration inside)
- `DiffController.js` -- keeps its own internal `this.grids` array
- `SelectionManager.js` -- receives grids array via getter (Phase 0, no change needed)
- `CameraController.js` -- accesses grids via `SceneContext.getGrids()` closure
- Layout managers -- receive grids as parameter, don't mutate the array
- `MinimapOverlay.js` -- calls `getGrids()` which now resolves via getter
- `SceneContext.js` -- closure `getGrids: () => this.grids` hits the getter
