# Round 3: Spatial Mechanics convergence

## Settled

All 10 consensus points are resolved. Here is the final status of each.

1. **HitDispatcher owns DOM events (capture-phase mousedown), SpatialWindowManager owns group semantics.**
   Settled. HitDispatcher lives at `src/services/interaction/HitDispatcher.js`, registers `mousedown` on the canvas in capture phase, and calls `e.stopPropagation()` on hit. SpatialWindowManager lives at `src/services/spatial/SpatialWindowManager.js` and receives structured method calls from HitDispatcher (not DOM events). HitDispatcher constructor takes an optional `spatialManager` reference. During drag of a grouped grid, HitDispatcher queries `spatialManager.getGroupForGrid(gridId)` and applies the world delta to all group members.

2. **`screenToWorldDelta` is a shared utility (quaternion-aware), not inlined.**
   Settled. Exported from `app/commands/handlers/spatialHelpers.js` as a named export. Uses `getCanvasViewportSize(canvas).height`, applies camera quaternion via `applyQuaternion(camera.quaternion)` for both right and up vectors. HitDispatcher, SpatialWindowManager, and any future consumer import from there. The function signature is `screenToWorldDelta(dx, dy, objectZ, camera, canvas)`.

3. **`_findDropTarget` must use `Box3` `.min`/`.max`, not `.width`/`.height`.**
   Settled. `CodeGrid.getBounds()` returns `THREE.Box3`. The area computation is `(box.max.x - box.min.x) * (box.max.y - box.min.y)`. The `_computeOverlap` helper already uses `.min`/`.max` correctly. Only the area denominator in `_findDropTarget` needed the fix.

4. **SelectionManager defers Z-pop for grouped grids via `userData._windowGroup`.**
   Settled. A one-line guard in `SelectionManager._applyZPop` (line 250): `if (grid.userData?._windowGroup) return;`. SpatialWindowManager listens to SelectionManager via `.on()` and applies `Z_POP_AMOUNT` to all group siblings when one member is selected. The constant `Z_POP_AMOUNT = 3` stays in SelectionManager; SpatialWindowManager imports it (or duplicates the value -- it is a single number). The monotonic Z counter from my Phase 0 is deferred to a later phase; for now the fixed offset is sufficient.

5. **WindowGroup uses ordered array of registry IDs.**
   Settled. `WindowGroup.memberIds` is `string[]` (registry IDs), not `Set<string>` (loses order) and not `Object3D[]` (not serializable). Order matters for stack/splay layout. A parallel `SpatialWindowManager._gridToGroup: Map<string, string>` provides O(1) reverse lookup. `userData._windowGroup` is set on the Object3D for fast per-object checks (SelectionManager guard, virtualizer guard).

6. **SceneRegistry needs multi-listener `onChange` API.**
   Settled. Replace the single `_onChange` callback slot with `_changeListeners: Set<Function>` and public `addChangeListener(fn)` / `removeChangeListener(fn)` methods. No backward-compat shim for `_onChange` -- there are zero existing consumers that assign it (confirmed: `_onChange` is declared at line 30 of `SceneRegistry.js` but never assigned anywhere in the codebase). Method names are `addChangeListener`/`removeChangeListener` to avoid collision with the old `_onChange` field name.

7. **`easeInOutCubic` needs exporting from `spatialHelpers.js`.**
   Settled. Currently a private function at line 221 of `app/commands/handlers/spatialHelpers.js`. Add `export` keyword. SpatialAnimator imports it as default easing.

8. **GridVirtualizer needs `_userHidden` check.**
   Settled. In `GridVirtualizer.update()`, after `const inFrustum = ...` (line 169), add: `if (grid.userData?._userHidden) { /* treat as not in frustum, remove if active */ continue; }`. This prevents the virtualizer from re-adding grids that the user explicitly hid via `group.hide` or window minimize.

9. **Fix VCC line 244 `window.innerHeight` to `getCanvasViewportSize`.**
   Settled. This is a pre-existing bug. `ViewerCameraController._applyDragTranslation` at line 244 uses `window.innerHeight`. Change to `getCanvasViewportSize(this.ctx.canvas).height`. VCC already has access to `this.ctx.canvas` via SceneContext. Import `getCanvasViewportSize` from `src/core/canvasSize.js`.

10. **AgentGrid needs `_background` proxy getter for raycasting.**
    Settled. AgentGrid wraps a CodeGrid at `this.grid` but the registry entry's `.grid` field points to the AgentGrid, not the inner CodeGrid. HitDispatcher accesses `entry.grid._background`, which is `undefined` on AgentGrid. Fix: add a getter `get _background() { return this.grid._background; }` on AgentGrid. Similarly add `getBounds() { return this.grid.getBounds(); }` for drop-target detection.

---

## Implementation Plan

### Phase 0: Prerequisites (3 files modified)

These are bug fixes and exports that unblock everything else.

#### File 1: `src/services/camera/ViewerCameraController.js`

**Line 244** -- fix `window.innerHeight` bug:

```js
// Before:
const pixelScale = (dist * fovFactor) / window.innerHeight;

// After:
const { height } = getCanvasViewportSize(this.ctx.canvas);
const pixelScale = (dist * fovFactor) / height;
```

Add import at top of file:
```js
import { getCanvasViewportSize } from '../../core/canvasSize.js';
```

#### File 2: `app/commands/handlers/spatialHelpers.js`

**Line 221** -- export `easeInOutCubic`:
```js
// Before:
function easeInOutCubic(t) {

// After:
export function easeInOutCubic(t) {
```

**After line 306** -- add `screenToWorldDelta`:
```js
/**
 * Convert screen-pixel deltas to world-space deltas at a given Z depth.
 * Quaternion-aware: works at any camera orientation.
 *
 * @param {number} dx - screen pixels rightward
 * @param {number} dy - screen pixels downward
 * @param {number} objectZ - world Z of the object being moved
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLCanvasElement} canvas
 * @returns {{ x: number, y: number }}
 */
export function screenToWorldDelta(dx, dy, objectZ, camera, canvas) {
    const { height } = getCanvasViewportSize(canvas);
    const depth = Math.abs(camera.position.z - objectZ);
    const fovRad = camera.fov * Math.PI / 180;
    const pixelScale = (2 * depth * Math.tan(fovRad / 2)) / height;

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

    return {
        x:  dx * pixelScale * right.x + (-dy) * pixelScale * up.x,
        y:  dx * pixelScale * right.y + (-dy) * pixelScale * up.y,
    };
}
```

Note: `spatialHelpers.js` already imports THREE at the top (uses `THREE.Box3`, `THREE.Vector3` in existing functions). It must also import `getCanvasViewportSize` from `../../../src/core/canvasSize.js`.

#### File 3: `src/collections/AgentGrid.js`

**After the constructor** (after line 51) -- add proxy getters:
```js
/** Proxy for raycasting — HitDispatcher accesses entry.grid._background */
get _background() {
    return this.grid._background;
}

/** Proxy for bounds queries — drop detection, layout */
getBounds() {
    return this.grid.getBounds();
}
```

---

### Phase 1: Infrastructure (2 files modified)

#### File 4: `src/services/SceneRegistry.js`

Replace `_onChange` single slot with multi-listener API.

**Constructor (line 29-30)** -- replace:
```js
// Before:
/** @type {Function|null} external change listener */
this._onChange = null;

// After:
/** @type {Set<Function>} change listeners */
this._changeListeners = new Set();
```

**After line 231 (before closing brace of class)** -- add methods:
```js
/**
 * Subscribe to change notifications.
 * @param {Function} fn - called with (type: string)
 */
addChangeListener(fn) {
    this._changeListeners.add(fn);
}

/**
 * Unsubscribe from change notifications.
 * @param {Function} fn
 */
removeChangeListener(fn) {
    this._changeListeners.delete(fn);
}
```

**`_invalidateCache` (lines 240-247)** -- replace body:
```js
_invalidateCache(type) {
    this._typeCache.delete(type);
    for (const cb of this._changeListeners) {
        try { cb(type); } catch (e) {
            console.error('[registry] onChange error:', e);
        }
    }
}
```

#### File 5: `src/collections/GridVirtualizer.js`

**In `update()`, line 168** -- add `_userHidden` check at the top of the loop body:
```js
for (const [grid, entry] of this._entries) {
    // Skip user-hidden grids (window.hide, group.hide)
    if (grid.userData?._userHidden) {
        if (entry.active) {
            this.scene.remove(grid);
            entry.active = false;
            this._active.delete(grid);
        }
        continue;
    }

    const inFrustum = this._frustum.intersectsBox(entry.bounds);
    // ... rest unchanged
```

---

### Phase 2: Core classes (3 files created)

#### File 6: `src/services/spatial/SpatialAnimator.js` (NEW)

Full class as described in my Phase 0 sketch. Key details:
- `_active: Map<string, Animation>` keyed by `${object.uuid}:${property}`
- `animateTo(object, property, target, opts)` -- cancels in-flight on same key
- `animateBatch(batch)` -- convenience for group transitions
- `cancel(key)`, `cancelAll(object)`, `isAnimating` getter
- `update(dt)` -- called from render loop, advances all active animations
- Imports `easeInOutCubic` from `../../app/commands/handlers/spatialHelpers.js`
- Animated properties: `position` (vec3), `scale` (scalar), `opacity` (float via `_background.material.opacity`)

#### File 7: `src/services/spatial/WindowGroup.js` (NEW)

Data structure + layout computation. Key details:
- `this.id: string`
- `this.memberIds: string[]` -- ordered array of registry IDs
- `this.mode: 'stack'|'splay'|'free'`
- `this.anchor: {x,y,z}`
- `this.config: Object`
- `add(registryId)`, `remove(registryId)`, `has(registryId)`, `reorder(fromIdx, toIdx)`
- `computeLayout(registry)` -- returns `TargetPosition[]` using current mode
- Layout functions (`stackLayout`, `splayLayout`, `freeLayout`) are module-private pure functions
- `getBounds(registry)` -- returns `THREE.Box3` union of all members. Uses a pre-allocated `this._boundsBox = new THREE.Box3()` to avoid per-call allocation
- `_getBounds(entry)` computes `{ width, height }` from `entry.grid.getBounds()` via `box.max.x - box.min.x` / `box.max.y - box.min.y`

#### File 8: `src/services/interaction/HitDispatcher.js` (NEW)

DOM event interceptor. Key details:

Constructor params:
```js
{ canvas, camera, scene, registry, THREE, spatialManager = null }
```

Methods:
- `attach()` -- canvas `mousedown` capture, document `mousemove`/`mouseup` bubble
- `detach()` -- remove all listeners
- `_handleMouseDown(e)` -- raycast via `_raycastDraggable`, stopPropagation on hit
- `_handleMouseMove(e)` -- 5px threshold, compute `screenToWorldDelta`, apply to target grid. If target is in a group (`spatialManager.getGroupForGrid(gridId)`), apply delta to all group members
- `_handleMouseUp(e)` -- if no movement: dispatch `canvas-click` CustomEvent. If moved: call `_findDropTarget` and emit `window-group-request` if overlap >= 30%
- `_raycastDraggable(clientX, clientY)` -- uses `registry.findByType('grid')` + `registry.findByType('window')` (NOT `registry.list()`). Accesses `entry.grid._background` (works for both CodeGrid and AgentGrid via the proxy getter)
- `_findDropTarget(draggedGrid, clientX, clientY)` -- `Box3` min/max area computation
- `_computeOverlap(a, b)` -- rectangle intersection using `min`/`max`

Imports:
```js
import { getCanvasViewportSize } from '../../core/canvasSize.js';
import { screenToWorldDelta } from '../../../app/commands/handlers/spatialHelpers.js';
```

Note on import path: `screenToWorldDelta` is in the `app/` tree, which `src/` normally does not import from. Two options: (a) move `screenToWorldDelta` to `src/core/spatialMath.js` (cleaner), or (b) accept the cross-boundary import. Recommendation: move it to `src/core/spatialMath.js` alongside `getCanvasViewportSize` in `src/core/canvasSize.js`. Then `spatialHelpers.js` re-exports it for backward compat. This keeps `src/` self-contained.

---

### Phase 3: Manager + wiring (3 files modified, 1 created)

#### File 9: `src/services/spatial/SpatialWindowManager.js` (NEW)

Orchestrator. Constructor params:
```js
{ registry, selectionManager, fileStateManager, codeColorManager, animator, scene }
```

State:
- `_groups: Map<string, WindowGroup>`
- `_gridToGroup: Map<string, string>` (gridId -> groupName)
- `_groupColors: Map<string, {r,g,b}>`

Public API:
- `createGroup(name) -> WindowGroup`
- `addToGroup(groupName, gridId)` -- single mutation path: (a) `group.add(registryId)`, (b) `_gridToGroup.set(gridId, groupName)`, (c) set `entry.grid.userData._windowGroup = groupName`, (d) `fileStateManager.setProperty(sourcePath, 'groupId', groupName)`
- `removeFromGroup(groupName, gridId)` -- reverse of above
- `dissolveGroup(name)` -- removes all members, deletes group
- `setLayout(groupName, mode)` -- calls `group.computeLayout(registry)`, feeds targets to `animator.animateBatch()`
- `moveGroup(groupName, dx, dy, dz)` -- offset-preserving move of all members
- `hideGroup(name)` / `showGroup(name)` -- sets `userData._userHidden`, animates opacity to 0 / 1, sets `visible = false` on complete
- `getGroupForGrid(gridId) -> string|null`
- `serialize()` / `deserialize(data)` -- keyed by sourcePath for persistence
- `clear()` / `dispose()`

Lifecycle:
- Subscribes to `registry.addChangeListener(type => this._reconcileMembers())` -- removes stale IDs, auto-dissolves empty groups
- Subscribes to `selectionManager.on((event, path, state) => ...)` -- applies Z-pop to group siblings when a grouped grid is selected

Color layer:
- Registers `'group-tint'` layer on `codeColorManager` at priority 5
- 8-color low-saturation palette, deterministic index from name hash

#### File 10: `app/GitHubRepoViewer.js`

**After line 299** (after `selectionManager` creation) -- create SpatialAnimator and SpatialWindowManager:
```js
// Spatial window management
import { SpatialAnimator } from '../src/services/spatial/SpatialAnimator.js';
import { SpatialWindowManager } from '../src/services/spatial/SpatialWindowManager.js';
import { HitDispatcher } from '../src/services/interaction/HitDispatcher.js';

// ... in init():
this.spatialAnimator = new SpatialAnimator();
this.spatialManager = new SpatialWindowManager({
    registry: this.registry,
    selectionManager: this.selectionManager,
    fileStateManager: this.fileStateManager,
    codeColorManager: this.codeColorManager,
    animator: this.spatialAnimator,
    scene: this.scene,
});

this.hitDispatcher = new HitDispatcher({
    canvas: this.canvas,
    camera: this.camera,
    scene: this.scene,
    registry: this.registry,
    THREE,
    spatialManager: this.spatialManager,
});
this.hitDispatcher.attach();
```

**In `animate()` at line 1971** -- add animator update after camera update:
```js
this.cameraController.update(deltaTime);
if (this.spatialAnimator) this.spatialAnimator.update(deltaTime);
```

**In `SelectionManager._applyZPop` (line 250)** -- add group guard:
```js
_applyZPop(sourcePath, grid) {
    if (grid.userData?._windowGroup) return; // SpatialWindowManager owns Z for grouped grids
    if (!this._originalZ.has(sourcePath)) {
        // ... existing code
```

#### File 11: `app/commands/index.js`

**In `buildContext()` after line 93** -- add spatialManager:
```js
spatialManager: viewer.spatialManager || null,
spatialAnimator: viewer.spatialAnimator || null,
```

---

### Phase 4: Commands (2 files)

#### File 12: `app/commands/handlers/groupCommands.js` (NEW)

Registers `group.*` commands on the router. Full command set:
- `group.create <name> [id1 id2 ...]`
- `group.add <group> <id|path>`
- `group.remove <group> <id|path>`
- `group.dissolve <group>`
- `group.stack <group>`
- `group.splay <group> [angle]`
- `group.free <group>`
- `group.hide <group>`
- `group.show <group>`
- `group.list`
- `group.info <group>`
- `group.move <group> <x> <y> <z>`

Each command follows the pattern of existing handlers: receives `(args, ctx)`, returns `{ text, data }`. Uses `ctx.spatialManager` for all mutations.

#### File 13: `app/commands/handlers/index.js`

**Add import and registration:**
```js
import registerGroupCommands from './groupCommands.js';

// In registerAllCommands():
registerGroupCommands(router);
```

---

### Phase 5: Persistence (1 file modified)

#### File 14: `app/StatePersistence.js`

Add `groups` field to saved state. On save: `viewer.spatialManager?.serialize()`. On restore: `viewer.spatialManager?.deserialize(data.groups)` after grids are loaded. Serialized shape:

```js
{
    groups: [
        { name: 'workspace-1', layout: 'stack', memberPaths: ['src/foo.js', 'src/bar.js'] }
    ]
}
```

Keyed by `memberPaths` (sourcePaths), not registry IDs, because IDs are regenerated each load.

---

### Summary table

| File | Action | Phase |
|------|--------|-------|
| `src/services/camera/ViewerCameraController.js` | Modify (line 244, add import) | 0 |
| `app/commands/handlers/spatialHelpers.js` | Modify (export easeInOutCubic, add screenToWorldDelta) | 0 |
| `src/collections/AgentGrid.js` | Modify (add _background + getBounds proxy getters) | 0 |
| `src/services/SceneRegistry.js` | Modify (multi-listener API) | 1 |
| `src/collections/GridVirtualizer.js` | Modify (_userHidden check in update loop) | 1 |
| `src/services/spatial/SpatialAnimator.js` | **Create** | 2 |
| `src/services/spatial/WindowGroup.js` | **Create** | 2 |
| `src/services/interaction/HitDispatcher.js` | **Create** | 2 |
| `src/services/spatial/SpatialWindowManager.js` | **Create** | 3 |
| `app/GitHubRepoViewer.js` | Modify (create + wire all new systems, animate loop) | 3 |
| `src/services/interaction/SelectionManager.js` | Modify (1-line _windowGroup guard in _applyZPop) | 3 |
| `app/commands/index.js` | Modify (add spatialManager to context) | 3 |
| `app/commands/handlers/groupCommands.js` | **Create** | 4 |
| `app/commands/handlers/index.js` | Modify (register group commands) | 4 |
| `app/StatePersistence.js` | Modify (groups field) | 5 |

4 new files, 11 modified files. No deletions.

---

## Implementer Vote

**Integration Surface** should implement.

Rationale: The converged plan is dominated by wiring work -- SpatialWindowManager connects to SceneRegistry, SelectionManager, FileStateManager, CodeColorManager, and the command system. Integration Surface's Phase 0 defined the exact registration model, the color layer, the command surface, the context extension, and the lifecycle/persistence strategy. Those pieces account for roughly 60% of the implementation effort (SpatialWindowManager itself, groupCommands.js, StatePersistence, buildContext, SceneRegistry migration). The Event Pipeline and Spatial Mechanics contributions (HitDispatcher, SpatialAnimator, WindowGroup layouts) are well-specified enough in this convergence document to implement from the sketches, whereas the integration wiring requires the kind of whole-system awareness that Integration Surface demonstrated in its analysis. Integration Surface is also the agent that identified the `_onChange` listener gap, the `sourcePath -> gridId` resolution problem, and the FileStateManager property flow -- all of which are implementation-time decisions that benefit from the original analyst executing them.
