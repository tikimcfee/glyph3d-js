# Round 3: Integration Surface convergence

## Settled

All ten consensus points are fully resolved. Here is the final disposition of each:

1. **HitDispatcher owns DOM events (capture-phase mousedown), SpatialWindowManager owns group semantics.** HitDispatcher registers `mousedown` on the canvas in the capture phase (fires before VCC's bubble-phase handler). On hit, calls `stopPropagation()`. On miss, event bubbles to VCC normally. HitDispatcher emits structured calls (not events) into SpatialWindowManager for group-level logic (e.g., "move group by delta"). SpatialWindowManager never touches DOM events.

2. **`screenToWorldDelta` is a shared utility (quaternion-aware), not inlined.** Exported from `app/commands/handlers/spatialHelpers.js` alongside existing spatial math (`getWorldBounds`, `unionBounds`, `zDistanceForFit`). Uses `getCanvasViewportSize(canvas).height`, applies camera quaternion. Both HitDispatcher and SpatialWindowManager import it.

3. **`_findDropTarget` must use `Box3.min`/`.max`, not `.width`/`.height`.** `CodeGrid.getBounds()` returns `THREE.Box3` -- no `.width` or `.height` properties. Area computed as `(box.max.x - box.min.x) * (box.max.y - box.min.y)`. The `_computeOverlap` helper already uses min/max correctly; the area calculation in `_findDropTarget` is the fix.

4. **SelectionManager defers Z-pop for grouped grids via `userData._windowGroup`.** Add a guard at the top of `SelectionManager._applyZPop()` (line 250): `if (grid.userData?._windowGroup) return;`. SpatialWindowManager listens via `selectionManager.on()` and applies Z-pop to all group members (using `Z_POP_AMOUNT` imported from a shared constant). No monotonic counter for Phase 0 -- keep SelectionManager's fixed offset for ungrouped grids.

5. **WindowGroup uses an ordered array of registry IDs.** Not Object3D refs (fragile across disposal), not a Set (loses ordering needed by stack/splay layout). A parallel `_gridToGroup: Map<registryId, groupName>` on SpatialWindowManager provides O(1) membership lookup. `userData._windowGroup` on each grid enables fast per-object checks (SelectionManager Z-pop guard, GridVirtualizer user-hidden check).

6. **SceneRegistry needs multi-listener `onChange` API.** Replace the single `_onChange` callback slot (line 30) with `_changeListeners: Set<Function>`. Public API: `addChangeListener(fn)` / `removeChangeListener(fn)` (not `onChange`/`offChange`, to avoid naming collision with the existing `_onChange` field). Remove `_onChange` entirely -- there are zero current consumers that assign it. No backward-compat shim needed.

7. **`easeInOutCubic` needs exporting from `spatialHelpers.js`.** Currently a private function at line 221. Add the `export` keyword. SpatialAnimator imports it as default easing.

8. **GridVirtualizer needs `_userHidden` check.** In the frustum evaluation loop (line 168-192 of `GridVirtualizer.js`), add: `if (grid.userData?._userHidden) { /* skip scene.add, same removal logic */ continue; }` before the `inFrustum` check. A hidden window at a visible position must not be re-added to the scene.

9. **Fix VCC line 244 `window.innerHeight` to `getCanvasViewportSize`.** `ViewerCameraController._applyDragTranslation()` at line 244 uses `window.innerHeight`. Replace with `getCanvasViewportSize(this.ctx.canvas).height`. This is a pre-existing bug independent of the spatial window feature, but both HitDispatcher and VCC must use the same viewport size source for consistent pixel-to-world conversion.

10. **AgentGrid needs `_background` proxy getter for raycasting.** AgentGrid wraps a CodeGrid at `this.grid`, but the registry entry's `.grid` field points to the AgentGrid, not the inner CodeGrid. HitDispatcher's raycast accesses `entry.grid?._background` which is `undefined` on AgentGrid. Add a getter: `get _background() { return this.grid._background; }` on AgentGrid. Same for `getBounds()`: `getBounds() { return this.grid.getBounds(); }`.

---

## Implementation Plan

### Phase 0: Foundation (no group logic yet -- just the plumbing)

#### File 1: `app/commands/handlers/spatialHelpers.js` (MODIFY)

**Export `easeInOutCubic`** (line 221):
```js
// Change from:
function easeInOutCubic(t) {
// To:
export function easeInOutCubic(t) {
```

**Add `screenToWorldDelta`** (new export, after `zDistanceForFit` at line 214):
```js
/**
 * Convert screen-pixel deltas to world-space deltas at a given Z depth.
 * Quaternion-aware: works with any camera orientation.
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

Requires adding import at top: `import { getCanvasViewportSize } from '../../../src/core/canvasSize.js';`

---

#### File 2: `src/services/camera/ViewerCameraController.js` (MODIFY)

**Fix `_applyDragTranslation`** at line 244:
```js
// Change from:
const pixelScale = (dist * fovFactor) / window.innerHeight;
// To:
const { height: vpHeight } = getCanvasViewportSize(this.ctx.canvas);
const pixelScale = (dist * fovFactor) / vpHeight;
```

Add import at top: `import { getCanvasViewportSize } from '../../core/canvasSize.js';`

---

#### File 3: `src/services/SceneRegistry.js` (MODIFY)

**Replace `_onChange` with multi-listener Set.** Modify constructor (line 19-31):
```js
constructor() {
    this._entries = new Map();
    this._gridToId = new Map();
    this._typeCache = new Map();
    this._changeListeners = new Set();
}
```

Replace `_invalidateCache` (line 240-247):
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

Add public methods after `typeCounts()` (around line 227):
```js
/** @param {Function} fn - (type: string) => void */
addChangeListener(fn) { this._changeListeners.add(fn); }

/** @param {Function} fn */
removeChangeListener(fn) { this._changeListeners.delete(fn); }
```

---

#### File 4: `src/collections/GridVirtualizer.js` (MODIFY)

**Add `_userHidden` check** in the `update()` loop, at line 168, before the `inFrustum` check:
```js
for (const [grid, entry] of this._entries) {
    // User-hidden grids (minimized, group.hide) must not be added to scene
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

#### File 5: `src/collections/AgentGrid.js` (MODIFY)

**Add proxy getters** (after `getPosition()` around line 80):
```js
/** Proxy for raycasting -- HitDispatcher accesses entry.grid._background */
get _background() { return this.grid._background; }

/** Proxy for bounds queries -- overlap detection, layout, etc. */
getBounds() { return this.grid.getBounds(); }
```

---

#### File 6: `src/services/interaction/SelectionManager.js` (MODIFY)

**Add Z-pop guard for grouped grids** at line 250, top of `_applyZPop`:
```js
_applyZPop(sourcePath, grid) {
    // Grouped grids: SpatialWindowManager owns their Z positioning
    if (grid.userData?._windowGroup) return;

    if (!this._originalZ.has(sourcePath)) {
        this._originalZ.set(sourcePath, grid.position.z);
    }
    grid.position.z = this._originalZ.get(sourcePath) + Z_POP_AMOUNT;
}
```

**Export `Z_POP_AMOUNT`** (line 21):
```js
// Change from:
const Z_POP_AMOUNT = 3;
// To:
export const Z_POP_AMOUNT = 3;
```

---

### Phase 1: Core classes

#### File 7: `src/services/interaction/HitDispatcher.js` (CREATE)

Lives in `src/services/interaction/` alongside `SelectionManager.js` and `ShortcutManager.js`. DOM event concern, not spatial math.

Key design:
- Constructor: `{ canvas, camera, scene, registry, spatialManager? }`
- `attach()`: capture-phase mousedown on canvas, document-level mousemove/mouseup
- `_raycastDraggable()`: uses `registry.findByType('grid')` + `registry.findByType('window')`, accesses `entry.grid?._background`, filters visible meshes
- `_handleMouseMove()`: calls `screenToWorldDelta()` from spatialHelpers, applies delta. If `spatialManager` is set and target is grouped, applies delta to all group members via `spatialManager.moveGroupByDelta(groupId, deltaX, deltaY)`
- `_handleMouseUp()`: if displacement < 5px, dispatches `CustomEvent('canvas-click')`. If >= 5px, calls `_findDropTarget()` with Box3 min/max area computation
- `_findDropTarget()`: iterates `registry.findByType('grid')` + `findByType('window')`, computes overlap using `(box.max.x - box.min.x) * (box.max.y - box.min.y)`, threshold 30%
- `detach()`: removes all listeners

---

#### File 8: `src/services/spatial/SpatialWindowManager.js` (CREATE)

New directory `src/services/spatial/`. Contains group membership, color layer integration, selection observation, lifecycle.

Constructor dependencies:
```js
constructor({ registry, selectionManager, fileStateManager, codeColorManager, animator })
```

Key internal state:
- `_groups: Map<string, WindowGroup>` -- groupName to WindowGroup instance
- `_gridToGroup: Map<string, string>` -- registryId to groupName (reverse index)
- `_groupColors: Map<string, {r,g,b}>` -- deterministic hash-based palette

Key methods:
- `createGroup(name) -> WindowGroup`
- `addToGroup(groupName, registryId)` -- single mutation path: (a) adds to WindowGroup.memberIds, (b) sets `grid.userData._windowGroup = groupName`, (c) updates `_gridToGroup`, (d) writes `groupId` to FileStateManager
- `removeFromGroup(groupName, registryId)` -- inverse of above
- `dissolveGroup(name)` -- removes all members, unregisters group from registry
- `moveGroupByDelta(groupName, dx, dy)` -- called by HitDispatcher during grouped drag
- `setLayout(groupName, mode)` -- delegates to WindowGroup.setMode() which calls layout functions
- `hideGroup(name)` / `showGroup(name)` -- sets `userData._userHidden` on all members
- `serialize()` / `deserialize(data)` -- keyed by sourcePath for persistence stability
- `clear()` -- dissolve all groups
- `dispose()` -- unsubscribe from registry + selection listeners

Integration wiring:
- Registers `'group-tint'` color layer at priority 5 on CodeColorManager
- Calls `registry.addChangeListener()` for member reconciliation
- Calls `selectionManager.on()` for group Z-pop propagation (imports `Z_POP_AMOUNT` from SelectionManager)

---

#### File 9: `src/services/spatial/WindowGroup.js` (CREATE)

Pure data structure + layout orchestration. No DOM, no registry dependency.

```js
export class WindowGroup {
    constructor(id, animator) {
        this.id = id;
        this._animator = animator;
        this.memberIds = [];   // ordered array of registry IDs
        this.mode = 'free';
        this.anchor = { x: 0, y: 0, z: 0 };
        this.config = {};
        this._boundsBox = new THREE.Box3();  // pre-allocated for getBounds()
    }
    add(registryId) { ... }
    remove(registryId) { ... }
    setMode(mode, gridsLookup, config, duration) { ... }
    getBounds(gridsLookup) { ... }  // returns pre-allocated _boundsBox
}
```

`gridsLookup` is a function `(registryId) => Object3D|null` passed in by SpatialWindowManager, keeping WindowGroup decoupled from the registry.

Layout functions (`stackLayout`, `splayLayout`, `freeLayout`) are module-level pure functions in the same file. They take `WindowInfo[]` and return `TargetPosition[]`. Bounds are computed via `(box.max.x - box.min.x)` on `THREE.Box3` -- never `.width`/`.height`.

---

#### File 10: `src/services/spatial/SpatialAnimator.js` (CREATE)

Frame-driven property animation. Called from render loop.

- `animateTo(object, property, target, opts)` -- keyed by `${object.uuid}:${property}`
- `animateBatch(batch)` -- convenience for layout transitions
- `cancel(key)` / `cancelAll(object)`
- `update(dt)` -- advances all animations, removes completed ones
- Default easing: `easeInOutCubic` imported from `spatialHelpers.js`
- Properties: `position` (vec3 lerp), `scale` (scalar lerp), `opacity` (float lerp via `_background.material.opacity`)

---

### Phase 2: App-level wiring

#### File 11: `app/GitHubRepoViewer.js` (MODIFY)

**Add imports** (after existing imports, around line 56):
```js
import { HitDispatcher } from '../src/services/interaction/HitDispatcher.js';
import { SpatialWindowManager } from '../src/services/spatial/SpatialWindowManager.js';
import { SpatialAnimator } from '../src/services/spatial/SpatialAnimator.js';
```

**Instantiate after SelectionManager** (line 299, after `this.selectionManager = new SelectionManager(...)`:
```js
// Spatial animation engine (update() called from animate loop)
this.spatialAnimator = new SpatialAnimator();

// Spatial window manager — group membership, color layers, lifecycle
this.spatialManager = new SpatialWindowManager({
    registry: this.registry,
    selectionManager: this.selectionManager,
    fileStateManager: this.fileStateManager,
    codeColorManager: this.codeColorManager,
    animator: this.spatialAnimator,
});

// Hit dispatcher — intercepts mousedown on windows before camera drag
this.hitDispatcher = new HitDispatcher({
    canvas: this.canvas,
    camera: this.camera,
    scene: this.scene,
    registry: this.registry,
    spatialManager: this.spatialManager,
});
this.hitDispatcher.attach();
```

**Add animator tick to animate loop** (line 1971, after `this.cameraController.update(deltaTime)`):
```js
if (this.spatialAnimator) this.spatialAnimator.update(deltaTime);
```

**Add cleanup to `clearGrids()`** (line 1457, after `this.selectionManager.dispose()`):
```js
if (this.spatialManager) this.spatialManager.clear();
```

---

#### File 12: `app/commands/index.js` (MODIFY)

**Add `spatialManager` to context bag** (line 91, after `selectionManager`):
```js
spatialManager: viewer.spatialManager || null,
```

---

#### File 13: `app/commands/handlers/groupCommands.js` (CREATE)

New command handler file. Registers `group.create`, `group.add`, `group.remove`, `group.dissolve`, `group.stack`, `group.splay`, `group.free`, `group.hide`, `group.show`, `group.list`, `group.info`, `group.move` (12 commands). Uses `resolveGridByIdOrIndex` from spatialHelpers.js for grid argument resolution.

---

#### File 14: `app/commands/handlers/index.js` (MODIFY)

**Add import + registration** (after line 23, `import registerTourCommands`):
```js
import registerGroupCommands from './groupCommands.js';
```

In `registerAllCommands` (after line 47, `registerTourCommands(router)`):
```js
registerGroupCommands(router);
```

---

#### File 15: `app/StatePersistence.js` (MODIFY)

**Add `groups` field to DEFAULTS** (line 29-40):
```js
groups: null,    // serialized WindowGroup state
```

**In save path**: read from `viewer.spatialManager?.serialize()`, write to state object.
**In restore path**: call `viewer.spatialManager?.deserialize(state.groups)` after grids are loaded.

---

### Files summary

| # | File | Action | Lines touched |
|---|------|--------|---------------|
| 1 | `app/commands/handlers/spatialHelpers.js` | Modify | +1 import, export easeInOutCubic (L221), add screenToWorldDelta (~20 lines) |
| 2 | `src/services/camera/ViewerCameraController.js` | Modify | +1 import, fix L244 (2 lines) |
| 3 | `src/services/SceneRegistry.js` | Modify | Replace _onChange with _changeListeners (~15 lines) |
| 4 | `src/collections/GridVirtualizer.js` | Modify | Add _userHidden guard in update() (~8 lines at L168) |
| 5 | `src/collections/AgentGrid.js` | Modify | Add _background + getBounds getters (~4 lines at L80) |
| 6 | `src/services/interaction/SelectionManager.js` | Modify | Export Z_POP_AMOUNT (L21), add guard in _applyZPop (L250, +2 lines) |
| 7 | `src/services/interaction/HitDispatcher.js` | **Create** | ~200 lines |
| 8 | `src/services/spatial/SpatialWindowManager.js` | **Create** | ~250 lines |
| 9 | `src/services/spatial/WindowGroup.js` | **Create** | ~150 lines (includes layout functions) |
| 10 | `src/services/spatial/SpatialAnimator.js` | **Create** | ~120 lines |
| 11 | `app/GitHubRepoViewer.js` | Modify | +3 imports, +12 lines instantiation (L299), +1 line animate (L1971), +1 line clearGrids (L1457) |
| 12 | `app/commands/index.js` | Modify | +1 line in buildContext (L91) |
| 13 | `app/commands/handlers/groupCommands.js` | **Create** | ~200 lines |
| 14 | `app/commands/handlers/index.js` | Modify | +2 lines (import + register) |
| 15 | `app/StatePersistence.js` | Modify | +1 default field, ~10 lines save/restore |

**4 new files, 11 modified files. Zero files deleted.**

---

## Implementer Vote

**Spatial Mechanics** should implement.

Rationale: The converged plan's heaviest new code is the four create-files -- HitDispatcher, SpatialWindowManager, WindowGroup (with layout functions), and SpatialAnimator. These are the classes Spatial Mechanics designed in detail during Phase 0. The SpatialAnimator is entirely Spatial Mechanics' design with no modifications. The WindowGroup class and layout functions (stack, splay, free) are Spatial Mechanics' code with the agreed-upon fix (ordered array of registry IDs instead of Object3D refs, Box3 min/max instead of .width/.height). The screenToWorldDelta utility is Spatial Mechanics' quaternion-aware version promoted to shared export. The modify-files (SceneRegistry multi-listener, SelectionManager Z-pop guard, GridVirtualizer _userHidden, VCC viewport fix) are all small surgical changes that Spatial Mechanics identified or agreed to in Round 1. Event Pipeline's HitDispatcher design is the basis for that class, but Spatial Mechanics reviewed it thoroughly and proposed the key fix (group-aware drag), so they understand both sides of the HitDispatcher-to-SpatialWindowManager interface. Integration Surface's contribution (registry integration, color layers, commands, persistence) is captured in the plan with enough specificity that any implementer can execute it, but the spatial math and animation code requires the deepest understanding, which Spatial Mechanics demonstrated.
