# Round 1: Integration Surface reviews Event Pipeline, Spatial Mechanics

## Errors Found

1. **Event Pipeline: `_findDropTarget` assumes `getBounds()` returns `{ width, height, min, max }` -- it does not.** `CodeGrid.getBounds()` (line 237 of `src/collections/CodeGrid.js`) returns a `THREE.Box3` with `.min` and `.max` Vector3 properties. There is no `.width` or `.height` property. The `_computeOverlap` helper correctly uses `.min.x` / `.max.x`, but `_findDropTarget` at line 321 reads `dragBounds.width * dragBounds.height`, which will be `undefined * undefined = NaN`. The overlap check will never trigger. Fix: compute area as `(dragBounds.max.x - dragBounds.min.x) * (dragBounds.max.y - dragBounds.min.y)`.

2. **Event Pipeline: `registry.list()` returns `RegistryEntry[]`, not a flat iterable of "all draggable objects."** In `_raycastDraggable` (line 262), iterating `this._registry.list()` works, but note that `list()` returns ALL entry types (grids, windows, annotations, labels, agents, tour-annotations). Most of those have no `_background` mesh. The null guard (`entry.grid?._background`) handles this, but it is worth noting that `list()` allocates a fresh array via spread (`[...this._entries.values()]`, SceneRegistry line 189). At 1500+ entries, calling this on every mousedown is a non-trivial allocation. Use `findByType('grid')` for grids, then also `findByType('window')` for windows, to avoid the full copy.

3. **Spatial Mechanics: claims `easeInOutCubic` exists in `spatialHelpers.js` as a reusable export -- it does not.** The function exists at line 221 of `app/commands/handlers/spatialHelpers.js` but it is a private (non-exported) function used only by the local `animateCameraTo`. It is not importable. SpatialAnimator would need its own copy or the function needs to be explicitly exported.

4. **Spatial Mechanics: `screenToWorldDelta` applies camera quaternion for pitch/yaw, but the HitDispatcher sketch in Event Pipeline does not.** Event Pipeline's `_screenToWorldDelta` (line 291) assumes the camera always faces -Z and uses raw `dxPixels * pixelScale` without quaternion rotation. Currently that is correct (camera is always axis-aligned), but Spatial Mechanics claims the quaternion path "future-proofs" the design. There is a real tension here -- if both implementations coexist, window drag will break the moment the camera gets any rotation. **Only one implementation should exist.** See Tensions below.

5. **Event Pipeline: claims "Stack interaction adds its own `mousemove` + `click` listeners directly on canvas, parallel to the camera system."** This is correct (`_initStackInteraction` at line 1700 of `app/GitHubRepoViewer.js`), but the claim that these "raycast against background meshes identically to SelectionManager" is misleading. The stack interaction raycasts against the same `_background` meshes, yes, but it resolves to a *directory path* via `stackManager.getDirectoryForGrid()`, not a sourcePath. The hit testing is structurally similar but semantically different. HitDispatcher would need to decide: does it suppress stack interaction too? Currently stack uses `click` (not `canvas-click`), so HitDispatcher's capture-phase `mousedown` stopPropagation would NOT suppress it -- the native `click` event still fires on mouseup. This is a potential double-action bug when stack layout is active.

6. **Spatial Mechanics: `WindowGroup.getBounds()` calls `new THREE.Box3()` inside `getBounds()`, allocating on every call.** For a method likely called per-frame during drag overlap checks, this creates GC pressure. Should use a pre-allocated box.

## Gaps

- **Event Pipeline covers touch input** (section 3, "Touch input") -- neither my analysis nor Spatial Mechanics addressed touch at all. Good forward thinking, correct recommendation to defer to Phase 1.
- **My analysis covers persistence** (section 6, "Persistence") -- neither Event Pipeline nor Spatial Mechanics addresses serialization/deserialization of group state, though Spatial Mechanics raises it as an open question (section 6.2).
- **My analysis covers the `_onChange` single-callback-slot problem** (section 6) -- neither other agent identified this. Currently `registry._onChange` is declared (SceneRegistry line 30) but never assigned anywhere in the codebase. Both Event Pipeline and Spatial Mechanics assume registry observation but neither addresses the mechanism.
- **Spatial Mechanics covers animation** -- the SpatialAnimator is a genuine gap in both my work and Event Pipeline's. Window drag release, layout transitions, and hide/show all need it.
- **Spatial Mechanics covers GridVirtualizer interaction** (section 6.4) -- `userData._userHidden` flag to prevent virtualizer from re-adding hidden windows. Neither my analysis nor Event Pipeline considered this.
- **Event Pipeline covers the full event listener registration order** (section 4) -- the most complete audit of all three analyses. My work did not enumerate listener phases.

## Tensions

1. **Who owns drag-to-move: HitDispatcher vs SpatialWindowManager?** Event Pipeline places all drag logic (mousedown capture, mousemove, mouseup) in HitDispatcher. Spatial Mechanics says "the drag handler sits in `SpatialWindowManager`, not in the camera controller" (section 1, "Integration point"). My analysis says SpatialWindowManager owns the group-move semantics but does not define who captures the DOM event. **Event Pipeline is correct**: the raw DOM event interception belongs in a dedicated dispatcher, not in the manager. SpatialWindowManager should receive "move this grid by delta" calls from HitDispatcher, not touch DOM events.

2. **`screenToWorldDelta`: two implementations.** Event Pipeline defines it as a private method on HitDispatcher (line 291). Spatial Mechanics defines it as an exported pure function with quaternion support (section 1). **Spatial Mechanics is correct on design**: this should be a shared utility function (not buried in a class), and the quaternion path costs almost nothing while preventing a future breakage if camera orientation changes. Event Pipeline should import it rather than duplicating.

3. **Z management: monotonic counter vs fixed offset.** Spatial Mechanics proposes a `_zCounter` with `Z_LAYER_STEP = 0.5` (section 4). SelectionManager uses a fixed `Z_POP_AMOUNT = 3` (line 21 of `SelectionManager.js`). My analysis says SpatialWindowManager "listens for `select` events and applies the same Z delta to all siblings." These three approaches conflict. **Recommendation**: SpatialWindowManager should own Z for grouped grids, and SelectionManager should defer Z-pop to SpatialWindowManager when `grid.userData._windowGroup` is set (as Spatial Mechanics suggests in section 4.2). The monotonic counter is overkill for Phase 0 -- keep SelectionManager's fixed offset for ungrouped grids, use the same fixed offset for grouped grids applied by SpatialWindowManager.

4. **WindowGroup: `members` as Array (Spatial Mechanics) vs `memberIds` as Set (my analysis).** Spatial Mechanics stores `THREE.Object3D` references directly in an array. My analysis stores registry IDs in a Set. **Registry IDs are correct** because: (a) grid objects can be disposed and recreated across repo loads while IDs are stable within a session, (b) Set gives O(1) membership checks, (c) persisting to localStorage requires IDs/paths, not object references. The array ordering in Spatial Mechanics is needed for layout (stack order matters), so use an ordered array of IDs, not a Set.

## Recommendations

1. **Create `screenToWorldDelta` as a shared utility** in `src/services/spatial/spatialMath.js`, using Spatial Mechanics' quaternion-aware version. Both HitDispatcher and SpatialWindowManager import from there.

2. **Fix `_findDropTarget` in HitDispatcher** to compute area from `Box3.min` / `Box3.max`, not from nonexistent `.width` / `.height` properties.

3. **Use `findByType('grid')` + `findByType('window')` in HitDispatcher** instead of `registry.list()`, to avoid full-registry allocation on every mousedown.

4. **Export `easeInOutCubic`** from `spatialHelpers.js` so SpatialAnimator can import it, or move it to the shared `spatialMath.js` utility.

5. **Use ordered array of registry IDs** (not Object3D references, not a Set) for WindowGroup membership. Provides ordering for layout, O(1) lookup via a parallel `_gridToGroup` Map, and serializes cleanly.

6. **Add HitDispatcher awareness of stack layout interaction.** When `_activeLayout === 'stack'`, HitDispatcher should either suppress stack interaction on capture (preventing double-action) or defer to it. Simplest: HitDispatcher does not intercept mousedown when stack layout is active.

7. **Pre-allocate `THREE.Box3` in WindowGroup** for `getBounds()` to avoid per-call allocation. Store as `this._boundsBox = new THREE.Box3()` in constructor.

8. **SpatialWindowManager owns group Z, SelectionManager defers.** Add a check in `SelectionManager._applyZPop`: if `grid.userData._windowGroup` is truthy, skip Z-pop and let SpatialWindowManager handle it via its selection listener.

9. **Convert `SceneRegistry._onChange` to `_changeListeners: Set<Function>`** with `onChange(fn)` / `offChange(fn)` methods (as I proposed in my Phase 0). Currently `_onChange` is never assigned anywhere in the codebase, so this is purely additive with zero breakage risk.

10. **SpatialAnimator.update(dt) must be called from the render loop.** Event Pipeline does not address where animation ticks. Add `if (this.spatialAnimator) this.spatialAnimator.update(deltaTime);` in GitHubRepoViewer's animate loop, next to `this.cameraController.update(deltaTime)` (around line 1971).

## Key Insight

The three analyses converge on a clean three-layer architecture -- HitDispatcher (DOM event capture and routing), SpatialWindowManager (group membership, selection coordination, color layers, commands), and SpatialAnimator (frame-driven position/scale interpolation) -- but they disagree on where the boundaries fall for drag handling and Z management. The critical design constraint is that **SelectionManager already owns Z-pop and selection state via FileStateManager**, and any spatial window system must either replace that ownership for grouped grids or create irreconcilable dual-authority over grid positions. The safest path is a narrow conditional: SelectionManager checks `userData._windowGroup` before touching Z, and SpatialWindowManager listens to selection events to apply group-aware Z positioning. This keeps SelectionManager unchanged for ungrouped grids (the 99% case during Phase 0) while giving the window manager authority over its members.
