# Round 3: Event Pipeline convergence

## Settled

All 10 consensus points from Round 1 are resolved. Each is confirmed below with rationale and the concrete resolution.

1. **HitDispatcher owns DOM events (capture-phase mousedown on canvas), SpatialWindowManager owns group semantics.** HitDispatcher registers `mousedown` on `canvas` with `{ capture: true }`, fires before VCC's bubble-phase handler at `ViewerCameraController.js:145`. On hit, `stopPropagation()` suppresses camera drag. HitDispatcher produces world-space deltas and emits structured calls into SpatialWindowManager for group-aware movement. No DOM event logic in SpatialWindowManager.

2. **`screenToWorldDelta` is a shared utility (quaternion-aware), not inlined.** Lives in a new file `src/services/spatial/spatialMath.js`. Uses `getCanvasViewportSize(canvas).height` (never `window.innerHeight`). Applies camera quaternion via `applyQuaternion(camera.quaternion)` to the right/up vectors. Both HitDispatcher and SpatialWindowManager import it. The cost of quaternion application is negligible (two `Vector3.applyQuaternion` calls) and prevents silent breakage if camera orientation ever changes.

3. **`_findDropTarget` must use `Box3.min`/`Box3.max`, not `.width`/`.height`.** `CodeGrid.getBounds()` at `CodeGrid.js:237` returns `THREE.Box3` with `.min` and `.max` Vector3 properties. Area computation: `(box.max.x - box.min.x) * (box.max.y - box.min.y)`. The `_computeOverlap` method already uses `.min`/`.max` correctly; only the caller's area computation was wrong.

4. **SelectionManager defers Z-pop for grouped grids via `userData._windowGroup`.** A single guard added to `SelectionManager._applyZPop` at `SelectionManager.js:250`: `if (grid.userData?._windowGroup) return;`. SpatialWindowManager listens to `SelectionManager.on()` and applies the same `Z_POP_AMOUNT` to all group siblings. `Z_POP_AMOUNT` (currently `3`, `SelectionManager.js:21`) is extracted to `src/core/constants.js` so both classes share the value.

5. **WindowGroup uses an ordered array of registry IDs.** Not `Set<string>` (loses ordering needed for stack layout), not `Array<Object3D>` (breaks across disposal/recreation). `this.memberIds = []` with O(1) membership via `SpatialWindowManager._gridToGroup: Map<string, string>`. Layout functions receive members in array order; stack/splay positions depend on index.

6. **SceneRegistry needs multi-listener `onChange` API.** Replace the single `_onChange` callback slot (`SceneRegistry.js:30`) with `_changeListeners: Set<Function>`. Public API: `onChange(fn)` / `offChange(fn)`. No backward-compat shim -- `_onChange` is never assigned anywhere in the codebase (confirmed by grep), so there is zero breakage. Method names `onChange`/`offChange` are fine; the old `_onChange` property (prefixed, private) is simply removed.

7. **`easeInOutCubic` needs exporting from `spatialHelpers.js`.** The function at `app/commands/handlers/spatialHelpers.js:221` is currently module-private. Add `export` keyword. SpatialAnimator imports it from there. No duplication.

8. **GridVirtualizer needs `_userHidden` check.** In `GridVirtualizer.update()` at `GridVirtualizer.js:168`, before evaluating frustum visibility, skip grids where `grid.userData._userHidden === true`. One-line guard: `if (grid.userData?._userHidden) continue;` at the top of the `for (const [grid, entry] of this._entries)` loop. Prevents virtualizer from re-adding user-hidden windows to the scene.

9. **Fix VCC line 244 `window.innerHeight` to `getCanvasViewportSize`.** `ViewerCameraController.js:244` currently reads `window.innerHeight`. Replace with `getCanvasViewportSize(this.ctx.canvas).height`. VCC already has access to the canvas via `this.ctx.canvas`. This is a pre-existing bug per project conventions -- fixing it as a prerequisite ensures camera drag and window drag use identical pixel-scale math.

10. **AgentGrid needs `_background` proxy getter for raycasting.** AgentGrid wraps a CodeGrid at `this.grid` (`AgentGrid.js:34`). HitDispatcher's raycast loop accesses `entry.grid._background`. For AgentGrid entries, `entry.grid` is the AgentGrid instance, not the inner CodeGrid. Add a getter: `get _background() { return this.grid?._background; }` to AgentGrid. Also add `getBounds() { return this.grid?.getBounds(); }` for drop-target detection.

## Implementation Plan

### Phase 0: Prerequisites (modify existing files)

**File 1: `src/core/constants.js`** -- Extract Z_POP_AMOUNT

Add alongside existing constants:
```js
/** Z offset for selected grid pop. Shared by SelectionManager and SpatialWindowManager. */
export const Z_POP_AMOUNT = 3;
```

**File 2: `src/services/interaction/SelectionManager.js`** -- Import shared constant, add group guard

- Line 21: Remove `const Z_POP_AMOUNT = 3;`, replace with `import { Z_POP_AMOUNT } from '../../core/constants.js';`
- Line 250, inside `_applyZPop(sourcePath, grid)`: Add guard before the existing body:
```js
_applyZPop(sourcePath, grid) {
    // Grouped grids: SpatialWindowManager handles Z for all siblings
    if (grid.userData?._windowGroup) return;
    // ... existing logic unchanged ...
}
```

**File 3: `src/services/SceneRegistry.js`** -- Multi-listener onChange

- Line 30: Replace `this._onChange = null;` with `this._changeListeners = new Set();`
- Add two methods after `getByIndex()` (after line 214):
```js
/** Register a change listener. @param {Function} fn */
onChange(fn) { this._changeListeners.add(fn); }
/** Remove a change listener. @param {Function} fn */
offChange(fn) { this._changeListeners.delete(fn); }
```
- Line 240-246, `_invalidateCache(type)`: Replace the `_onChange` call:
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

**File 4: `src/services/camera/ViewerCameraController.js`** -- Fix viewport bug

- Add import at top: `import { getCanvasViewportSize } from '../../core/canvasSize.js';`
- Line 244: Replace `window.innerHeight` with `getCanvasViewportSize(this.ctx.canvas).height`

**File 5: `app/commands/handlers/spatialHelpers.js`** -- Export easing

- Line 221: Change `function easeInOutCubic(t) {` to `export function easeInOutCubic(t) {`

**File 6: `src/collections/GridVirtualizer.js`** -- User-hidden guard

- Line 168, inside the `for (const [grid, entry] of this._entries)` loop in `update()`: Add at the top of the loop body:
```js
// User-hidden grids (minimized, group.hide) stay out of scene
if (grid.userData?._userHidden) {
    if (entry.active) {
        this.scene.remove(grid);
        entry.active = false;
        this._active.delete(grid);
    }
    continue;
}
```

**File 7: `src/collections/AgentGrid.js`** -- Proxy getters

- After `getPosition()` (line 80), add:
```js
/** @returns {THREE.Mesh|null} background mesh proxy for raycasting */
get _background() { return this.grid?._background ?? null; }

/** @returns {THREE.Box3} bounding box proxy */
getBounds() { return this.grid?.getBounds() ?? null; }
```

### Phase 1: New files (core spatial system)

**File 8: `src/services/spatial/spatialMath.js`** -- Shared utilities

```js
import { getCanvasViewportSize } from '../../core/canvasSize.js';

/**
 * Convert screen-pixel deltas to world-space deltas at a given Z depth.
 * Quaternion-aware: works at any camera orientation.
 *
 * @param {number} dx - screen pixels rightward
 * @param {number} dy - screen pixels downward
 * @param {number} objectZ - world Z of the target plane
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLCanvasElement} canvas
 * @param {THREE} THREE - Three.js namespace (for Vector3)
 * @returns {{ x: number, y: number }}
 */
export function screenToWorldDelta(dx, dy, objectZ, camera, canvas, THREE) {
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

**File 9: `src/services/spatial/SpatialAnimator.js`** -- Frame-driven animation

Uses Spatial Mechanics' design verbatim (phase0 section 3). Key points:
- `Map<string, Animation>` keyed by `${object.uuid}:${property}`
- `animateTo(object, property, target, opts)` -- cancels in-flight on same key
- `animateBatch(batch)` for group transitions
- `update(dt)` called from render loop
- Imports `easeInOutCubic` from `app/commands/handlers/spatialHelpers.js`
- Properties: `position` (vec3), `scale` (scalar), `opacity` (float via `_background.material.opacity`)

**File 10: `src/services/spatial/WindowGroup.js`** -- Group data + layout

```js
/**
 * WindowGroup -- logical grouping of windows with layout modes.
 * Does not own the windows. Stores ordered array of registry IDs.
 * Layout functions are pure: (memberInfos, config) => targetPositions[].
 */
export class WindowGroup {
    constructor(id, animator) {
        this.id = id;
        this._animator = animator;
        /** @type {string[]} ordered registry IDs */
        this.memberIds = [];
        /** @type {'stack'|'splay'|'free'} */
        this.mode = 'free';
        this.anchor = { x: 0, y: 0, z: 0 };
        this.config = {};
        this._boundsBox = new THREE.Box3(); // pre-allocated
    }

    add(registryId) {
        if (this.memberIds.includes(registryId)) return;
        this.memberIds.push(registryId);
    }

    remove(registryId) {
        const idx = this.memberIds.indexOf(registryId);
        if (idx !== -1) this.memberIds.splice(idx, 1);
    }

    has(registryId) {
        return this.memberIds.includes(registryId);
    }

    get size() { return this.memberIds.length; }
}
```

Layout functions (`stackLayout`, `splayLayout`, `freeLayout`) live in the same file as module-level exports. They receive `WindowInfo[]` where `bounds` is computed from `Box3.min`/`Box3.max`:
```js
function boundsFromBox3(box) {
    return {
        width: box.max.x - box.min.x,
        height: box.max.y - box.min.y,
    };
}
```

**File 11: `src/services/spatial/SpatialWindowManager.js`** -- Group orchestrator

Constructor receives: `{ registry, selectionManager, fileStateManager, codeColorManager, scene, THREE }`.

Key methods:
- `createGroup(name)` -- creates WindowGroup, registers as type `'group'` in SceneRegistry
- `addToGroup(groupName, gridId)` -- single mutation path: `group.add(id)`, `_gridToGroup.set(id, groupName)`, `grid.userData._windowGroup = groupName`, `fileStateManager.setProperty(sourcePath, 'groupId', groupName)`
- `removeFromGroup(groupName, gridId)` -- reverse of above, clears all three stores
- `dissolveGroup(name)` -- removes all members, unregisters from registry
- `moveGroupByDelta(groupName, deltaX, deltaY)` -- applies world delta to all member positions
- `getGroupForGrid(gridId)` -- returns group name or null
- `_reconcileMembers()` -- called via `registry.onChange()`, removes stale IDs, auto-dissolves empty groups
- `_onSelectionChange(eventType, sourcePath, state)` -- applies Z_POP_AMOUNT to group siblings when a grouped grid is selected
- `serialize()` / `deserialize(data)` -- for StatePersistence, keyed by sourcePath
- `clear()` / `dispose()`

Registers `'group-tint'` color layer at priority 5 via CodeColorManager.

**File 12: `src/services/interaction/HitDispatcher.js`** -- DOM event capture

Constructor: `{ canvas, camera, scene, registry, spatialManager, THREE }`

Key changes from Phase 0 sketch:
- `_screenToWorldDelta` replaced with import of `screenToWorldDelta` from `spatialMath.js`
- `_raycastDraggable` uses `registry.findByType('grid')` + `registry.findByType('window')` + `registry.findByType('agent')` instead of `registry.list()`
- `_handleMouseMove`: after computing world delta, checks `spatialManager.getGroupForGrid(targetId)`. If grouped, calls `spatialManager.moveGroupByDelta(groupName, delta.x, delta.y)`. If ungrouped, moves only the single target grid.
- `_findDropTarget`: area computed as `(box.max.x - box.min.x) * (box.max.y - box.min.y)`
- `_handleMouseDown`: sets `grid.userData._dragPinned = true` to prevent virtualizer culling mid-drag
- `_handleMouseUp`: clears `grid.userData._dragPinned = false`
- `_emitGroupRequest`: calls `spatialManager.createGroup(autoName)` + `spatialManager.addToGroup(...)` directly instead of CustomEvent dispatch (avoids window-level event indirection)

### Phase 2: Wiring (modify existing files)

**File 13: `app/commands/handlers/groupCommands.js`** -- Command handlers (new file)

12 commands in `group.*` namespace as specified by Integration Surface. Each handler accesses `ctx.spatialManager`. Standard pattern matching other handler files.

**File 14: `app/commands/handlers/index.js`** -- Register group commands

Add import and registration:
```js
import registerGroupCommands from './groupCommands.js';
// ... in registerAllCommands():
registerGroupCommands(router);
```

**File 15: `app/commands/index.js`** -- Add spatialManager to context

In `buildContext()` at line 26, add to the returned object:
```js
spatialManager: viewer.spatialManager || null,
```

**File 16: `app/GitHubRepoViewer.js`** -- Wire everything

Insert after `selectionManager` creation (after line 299):
```js
// Spatial window manager (group semantics, color layer, Z coordination)
import SpatialWindowManager from '../src/services/spatial/SpatialWindowManager.js';
import { SpatialAnimator } from '../src/services/spatial/SpatialAnimator.js';
import { HitDispatcher } from '../src/services/interaction/HitDispatcher.js';

// ... in init():
this.spatialAnimator = new SpatialAnimator();
this.spatialManager = new SpatialWindowManager({
    registry: this.registry,
    selectionManager: this.selectionManager,
    fileStateManager: this.fileStateManager,
    codeColorManager: this.codeColorManager,
    scene: this.scene,
    THREE,
});

this.hitDispatcher = new HitDispatcher({
    canvas: this.canvas,
    camera: this.camera,
    scene: this.scene,
    registry: this.registry,
    spatialManager: this.spatialManager,
    THREE,
});
this.hitDispatcher.attach();
```

In `animate()` (after line 1971), add:
```js
if (this.spatialAnimator) this.spatialAnimator.update(deltaTime);
```

In cleanup/dispose path, add:
```js
if (this.hitDispatcher) this.hitDispatcher.detach();
if (this.spatialManager) this.spatialManager.dispose();
```

In `clearGrids()`, add:
```js
if (this.spatialManager) this.spatialManager.clear();
```

**File 17: `app/StatePersistence.js`** -- Persist group state

In `save()`: read `viewer.spatialManager?.serialize()` and store as `groups` field.
In `restore()`: after grids are loaded, call `viewer.spatialManager?.deserialize(data.groups)`.

### Phase 3: GridVirtualizer drag-pin guard

In `GridVirtualizer.update()` at line 168, add alongside the `_userHidden` check:
```js
if (grid.userData?._dragPinned) {
    // Being dragged -- keep in scene regardless of frustum
    if (!entry.active) {
        this.scene.add(grid);
        entry.active = true;
        this._active.add(grid);
    }
    continue;
}
```

### Summary: File manifest

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `src/core/constants.js` | Modify | +2 |
| `src/services/interaction/SelectionManager.js` | Modify | ~5 (import + guard) |
| `src/services/SceneRegistry.js` | Modify | ~15 (multi-listener) |
| `src/services/camera/ViewerCameraController.js` | Modify | ~2 (import + fix) |
| `app/commands/handlers/spatialHelpers.js` | Modify | 1 (add `export`) |
| `src/collections/GridVirtualizer.js` | Modify | ~12 (two guards) |
| `src/collections/AgentGrid.js` | Modify | ~4 (proxy getters) |
| `src/services/spatial/spatialMath.js` | **Create** | ~30 |
| `src/services/spatial/SpatialAnimator.js` | **Create** | ~120 |
| `src/services/spatial/WindowGroup.js` | **Create** | ~150 (class + layouts) |
| `src/services/spatial/SpatialWindowManager.js` | **Create** | ~250 |
| `src/services/interaction/HitDispatcher.js` | **Create** | ~200 |
| `app/commands/handlers/groupCommands.js` | **Create** | ~180 |
| `app/commands/handlers/index.js` | Modify | +2 |
| `app/commands/index.js` | Modify | +1 |
| `app/GitHubRepoViewer.js` | Modify | ~15 |
| `app/StatePersistence.js` | Modify | ~10 |

**Total**: 7 modified files, 6 new files, ~1000 lines of new code.

### Dependency order for implementation

```
Phase 0 (prerequisites, no interdependency, can be done in parallel):
  constants.js, SelectionManager.js, SceneRegistry.js, VCC.js,
  spatialHelpers.js, GridVirtualizer.js, AgentGrid.js

Phase 1 (new spatial core, depends on Phase 0):
  spatialMath.js -> SpatialAnimator.js -> WindowGroup.js -> SpatialWindowManager.js
  HitDispatcher.js (depends on spatialMath.js + SpatialWindowManager.js)

Phase 2 (wiring, depends on Phase 1):
  groupCommands.js, handlers/index.js, commands/index.js,
  GitHubRepoViewer.js, StatePersistence.js
```

## Implementer Vote

**Integration Surface** should implement.

Rationale: The converged plan has more integration wiring than novel code. The 7 modified files all require understanding existing service boundaries -- SceneRegistry's listener API, SelectionManager's Z-pop path, CodeColorManager's layer registration, FileStateManager's property writes, the command handler registry pattern, and StatePersistence serialization. Integration Surface's Phase 0 mapped all of these touchpoints precisely and demonstrated the deepest knowledge of how these services compose. The spatial math (spatialMath.js, SpatialAnimator.js, WindowGroup layout functions) is well-specified enough to implement from the plan without the Spatial Mechanics agent's continuous involvement. The DOM event work (HitDispatcher) is similarly well-specified. The risk in this implementation is not in any single file but in getting the multi-service wiring correct -- and that is exactly Integration Surface's strength.
