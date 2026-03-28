# Phase 0: Viewer & Subsystem Migration to Registry-Based Access

## Current State: `this.grids` as Central Array

`GitHubRepoViewer.grids` is the single mutable array backing all scene content.
It is mutated in 4 places and read in 15+. Every subsystem receives it via
closure (`() => this.grids`) or direct pass.

### Mutation Sites

| Location | Operation | Context |
|---|---|---|
| `loadRepo` (L888) | `this.grids.push(grid)` | After `createGridForFileAsync` |
| `clearGrids` (L1007) | `this.grids = []` | Full reset |
| `loadDiff` (L1065) | `this.grids = result.grids` | Replace with diff grids |
| `websocket/index.js` ctx (L40,65) | `push` / `splice` | `addGrid` / `removeGrid` in context bag |

### Read Sites (by subsystem)

**SceneContext / CameraController**: `getGrids: () => this.grids` closure (L240, L315).
CameraController calls `this.ctx.getGrids()` in `focusOnGrid(index)` and
`focusOnGrids()`. Uses numeric index into the array.

**SelectionManager**: Receives `grids` array as parameter on every call --
`handleClick(grids)`, `select({grids})`, `deselect({grids})`, `clear(grids)`.
Iterates for `_background` mesh raycasting and `_findGrid(sourcePath, grids)`.

**MinimapOverlay**: `getGrids` closure called every frame in `update()` (L109).
Iterates all grids for position/bounds. Also called in `rebuildLayout()` (L83).

**Layout managers**: `layoutHierarchy(this.grids)` (L699), `layoutSpiral(this.grids)`
(L706), `layoutTreemap(this.grids)` (L713), `stack.layout(this.grids)` (L731).
Each stores its own copy internally (`this.grids = grids`).

**Tab traversal** (`_tabTraverse`): `this.grids[this._tabIndex]`, `grids.findIndex`,
`grids.length` for modular index arithmetic (L651-668).

**Tree panel** (`_buildTreeItem`): `this.grids.indexOf(node.grid)` to get numeric
index for `focusOnGrid(gridIndex)` (L1179-1188).

**Stack raycasting** (L1276-1286): Iterates `this.grids` for background meshes.

**Stats update** (L1503-1506): `this.grids.length` and glyph count iteration.

---

## Migration Design

### Strategy: Registry as Source of Truth, `grids` as Cached View

The `grids` array becomes a **getter** that materializes from the registry:

```js
// In GitHubRepoViewer
get grids() {
    if (this._gridsCacheDirty) {
        this._gridsCache = this._registry.findByType('grid').map(e => e.grid);
        this._gridsCacheDirty = false;
    }
    return this._gridsCache;
}
```

Cache invalidation: `_gridsCacheDirty = true` whenever `register()` or
`unregister()` is called. The registry gains an `onChange` callback hook
for this.

Why cached: `MinimapOverlay.update()` calls `getGrids()` every frame.
`findByType` iterates the full Map -- acceptable at <200 entries but the
cache avoids repeated allocation of intermediate arrays.

### Registration Point

In `loadRepo`, after `createGridForFileAsync` returns a grid and before
`this.grids.push(grid)`:

```js
// Current:
this.scene.add(grid);
this.grids.push(grid);

// After migration:
this.scene.add(grid);
this._registry.register(path, grid, { type: 'grid', sourcePath: path });
// grids getter auto-updates via cache invalidation
```

The `path` (sourcePath) is the natural stable ID -- it is already used as
the key in `FileStateManager`, `SelectionManager`, and tree panel items.

For diff grids, the ID is `diff:${filename}:left` / `diff:${filename}:right`.

For WS-created grids, the context bag's `addGrid()` already auto-registers
(L42-53 in `websocket/index.js`). This becomes the canonical path.

### `clearGrids` Migration

```js
clearGrids() {
    for (const entry of this._registry.findByType('grid')) {
        entry.grid.dispose();
        this.scene.remove(entry.grid);
        this._registry.unregister(entry.id);
    }
    // ... rest unchanged
}
```

No more `this.grids = []` -- cache invalidates automatically.

### `loadDiff` Migration

Instead of `this.grids = result.grids`, the diff controller registers each
grid with `diff:` prefixed IDs. The viewer's `grids` getter returns them.

---

## Subsystem-by-Subsystem Migration

### 1. CameraController.focusOnGrid(index)

**Current**: Numeric index into `ctx.getGrids()` array.

**Problem**: Index is unstable across add/remove. Tree panel computes it
via `this.grids.indexOf(node.grid)` and passes it to `focusOnGrid`.

**Migration**: Add `focusOnGridById(id)` that resolves via registry:

```js
focusOnGridById(id) {
    const entry = this.ctx.registry.get(id);
    if (!entry) return;
    this._focusOnGridImpl(entry.grid);
}
```

Keep `focusOnGrid(index)` as backward compat (for WS index-based commands).
Tree panel switches to `focusOnGridById(node.path)` -- the path is already
on the tree node. The `camera-focus-changed` event emits `{ id, index }`
for both consumers.

### 2. SelectionManager

**Current**: Receives `grids` array as parameter every call. Uses
`grids.find(g => g._background === hitMesh)` for raycasting and
`_findGrid(sourcePath, grids)` for Z-pop.

**Migration path (two options)**:

**Option A -- Give SelectionManager a registry reference**:
```js
constructor(THREE, fileStateManager, registry) {
    this._registry = registry;
}
_findGrid(sourcePath) {
    const entry = this._registry.get(sourcePath);
    return entry?.grid || null;
}
handleClick(clientX, clientY, canvas, camera, additive) {
    // Build background meshes from registry
    const grids = this._registry.findByType('grid').map(e => e.grid);
    // ... rest unchanged
}
```

**Option B -- Keep parameter passing, viewer passes `this.grids`**:
Zero-change option. The `grids` getter returns the cached array. All call
sites keep working. Migrate `_findGrid` to use registry only.

**Recommendation**: Option B first (no API break), then Option A later.

### 3. MinimapOverlay

**Current**: `getGrids` closure called every frame. Iterates for bounds and
hue coloring by index.

**Migration**: The `getGrids` closure already returns `this.grids` -- when
`grids` becomes a cached getter, minimap gets registry-backed data for free
with zero changes to MinimapOverlay itself.

For index-based hue coloring (`i / grids.length`), the ordering from
`findByType` is Map insertion order, which matches registration order
(file load order). Colors remain stable.

### 4. Layout Managers

**Current**: `layoutHierarchy(grids)`, `layoutSpiral(grids)`, etc.
Each stores the array internally.

**Migration**: No change to layout manager APIs. The viewer passes
`this.grids` (now a getter). Layout managers consume it as a snapshot --
they never mutate the input array.

Longer-term, layout managers could accept a registry reference and query
`findByType('grid')` themselves, but this couples library code to the
example's registry. Keep the array-based API.

### 5. Tab Traversal

**Current**: `this._tabIndex` indexes into `this.grids`. Wraps with modular
arithmetic.

**Migration**: Works unchanged since `this.grids` getter returns a stable-
order array. The `_tabIndex` is an index into the materialized array.

If grids are added/removed between Tab presses, the index may point to a
different file. Fix: store `_tabSourcePath` instead and resolve to index:

```js
_tabTraverse(delta) {
    const grids = this.grids;
    if (grids.length === 0) return;
    let idx = this._tabSourcePath
        ? grids.findIndex(g => g.userData?.sourcePath === this._tabSourcePath)
        : -1;
    if (idx < 0) idx = 0;
    idx = (idx + delta + grids.length) % grids.length;
    const grid = grids[idx];
    this._tabSourcePath = grid.userData?.sourcePath;
    // ...
}
```

### 6. Tree Panel File Click

**Current**: `const gridIndex = this.grids.indexOf(node.grid)` then
`this.cameraController.focusOnGrid(gridIndex)`.

**Migration**: Use the node's path directly:
```js
this.cameraController.focusOnGridById(node.path);
```
Eliminates the index lookup entirely.

### 7. WebSocket Context Bag

**Current**: `getGrids: () => viewer.grids`, `addGrid`, `removeGrid` with
push/splice.

**Migration**: `addGrid` already registers in the registry (L42-53).
`removeGrid` already unregisters (L59-60). `getGrids` returns the
getter. The context bag needs no structural changes -- only `removeGrid`
switches from `splice(index)` to `registry.unregister(id)`:

```js
removeGrid(id) {
    const entry = registry.get(id);
    if (!entry) return null;
    entry.grid.dispose();
    viewer.scene.remove(entry.grid);
    registry.unregister(id);
    return entry.grid;
}
```

Index-based `removeGrid(index)` stays as backward compat via
`registry.getByIndex(index, viewer.grids)`.

---

## Registry onChange Hook

Add to `SceneRegistry`:

```js
constructor() {
    this._entries = new Map();
    this._gridToId = new Map();
    this._onChange = null; // callback: () => void
}
register(id, grid, opts) {
    // ... existing logic ...
    if (this._onChange) this._onChange();
    return entry;
}
unregister(id) {
    // ... existing logic ...
    if (this._onChange) this._onChange();
    return entry;
}
```

Viewer wires it:
```js
this._registry.onChange = () => { this._gridsCacheDirty = true; };
```

---

## Migration Order

1. Add `_onChange` to SceneRegistry (1 line)
2. Move registry creation from `websocket/index.js` into `GitHubRepoViewer` constructor
3. Replace `this.grids = []` with cached getter + registry
4. Update `loadRepo` to register grids (already has `path`)
5. Update `clearGrids` to unregister
6. Update `loadDiff` to register diff grids
7. Add `focusOnGridById` to CameraController
8. Update tree panel click to use `focusOnGridById(path)`
9. Update WS context bag to use viewer's registry instance

Steps 1-6 are the core migration. Steps 7-9 are ID-based access improvements.
No subsystem API changes are required for steps 1-6 -- the cached getter
makes `this.grids` behave identically to the old array for all read sites.

---

## Risk: Array Identity

Some code may hold a reference to a previous `this.grids` array (e.g.,
`loadDiff` did `this.grids = result.grids`). With the getter, `this.grids`
always returns the cache array. If a layout manager stores `this.grids`
internally and later the cache is rebuilt, the layout manager holds a stale
snapshot. This is fine -- layout managers already treat their stored array
as a snapshot. They never re-read it after layout.

The `getGrids` closures in SceneContext and MinimapOverlay call the getter
each time, so they always get fresh data.
