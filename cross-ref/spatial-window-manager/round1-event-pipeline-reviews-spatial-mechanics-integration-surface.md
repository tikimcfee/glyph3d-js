# Round 1: Event Pipeline reviews Spatial Mechanics, Integration Surface

## Errors Found

1. **Spatial Mechanics: VCC uses `window.innerHeight`, not `getCanvasViewportSize`.**
   The `screenToWorldDelta` function (phase0-spatial-mechanics.md line 35) uses `getCanvasViewportSize(canvas).height`. The comment on line 58 says "Uses `getCanvasViewportSize(canvas)` -- never `window.innerHeight` (per project convention)." However, the actual VCC code at `src/services/camera/ViewerCameraController.js` line 244 uses `window.innerHeight`. So the proposed function diverges from the code it claims to derive from. This is not necessarily wrong -- it may be a deliberate improvement -- but it introduces a subtle parallax mismatch: camera drag and window drag will compute different pixel scales for the same viewport if canvas height differs from window height. Both must use the same height source, and `getCanvasViewportSize` is the correct one, meaning VCC itself has the bug. Document this as a prerequisite fix or accept the drift.

2. **Spatial Mechanics: `CodeGrid.getBounds()` returns `THREE.Box3`, not `{ width, height }`.**
   The `WindowGroup._getBounds` helper (line 509) expects `obj.getBounds()` to return an object with `.width` and `.height`. In reality, `CodeGrid.getBounds()` (`src/collections/CodeGrid.js` line 237) returns a `THREE.Box3` (with `.min` and `.max` Vector3 properties, no `.width`/`.height`). The `splayLayout` function (line 137-138) accesses `m.bounds.width` and `m.bounds.height`, which will be `undefined`. The `_getBounds` wrapper tries to compute these from a `.max.x - .min.x` pattern on line 511, but the incoming `getBounds()` never has `.max.x` as a flat property -- it is `box.max.x` on a Box3. Actually, Box3 does have `.min.x` and `.max.x`, so the subtraction on line 511 would work. The issue is the splay/stack layouts receiving `WindowInfo` where `bounds.width` comes from `_getBounds` -- this path is correct if `_getBounds` is always called to build the `WindowInfo`. Just ensure `_getBounds` is the only entry point.

3. **Spatial Mechanics: `easeInOutCubic` is not exported from `spatialHelpers.js`.**
   Line 207 states it "already exists in spatialHelpers.js." Confirmed at `app/commands/handlers/spatialHelpers.js` line 221. But it is a module-private function (no `export` keyword -- used internally by `animateCamera`). The SpatialAnimator would need it exported, or would need its own copy. Minor, but will fail at import time.

4. **Integration Surface: `registry._onChange` is a single slot, and the proposed `onChange()` method name collides with the internal field.**
   The analysis (phase0-integration-surface.md line 209) correctly identifies `_onChange` as a single callback slot (`src/services/SceneRegistry.js` line 30). The proposed fix adds `_changeListeners` as a `Set<Function>` and keeps `_onChange` for backward compat (line 229). This is sound, but the public method `onChange(fn)` (line 233) shadows the internal `_onChange` convention. Naming it `addChangeListener` / `removeChangeListener` avoids confusion with the existing `_onChange` field.

5. **Integration Surface: `SelectionManager.on()` callback signature is `(eventType, sourcePath, state)`, not `(eventType, sourcePath)`.**
   The listener example (line 53) uses the correct 3-arg signature, matching `src/services/interaction/SelectionManager.js` line 289-298. No error here -- just confirming it is correct.

6. **My own analysis (Event Pipeline): VCC mousedown is on canvas, not document.**
   Confirmed correct. `ViewerCameraController.js` line 145: `canvas.addEventListener('mousedown', this._onMouseDown)`. My phase0 correctly describes this. The HitDispatcher capture-phase mousedown on canvas fires before VCC's bubble-phase mousedown on canvas -- both on the same element, capture wins.

## Gaps

- **Spatial Mechanics covers animation and layout geometry in depth; I (Event Pipeline) and Integration Surface do not.** The SpatialAnimator class, critically-damped spring, and layout modes are Spatial Mechanics territory and well-explored. Neither other agent addresses animation at all.
- **Integration Surface covers color layers, command surface, and persistence; the other two agents do not.** The `group-tint` CodeColorManager layer, FileStateManager integration, and StatePersistence serialization are Integration Surface territory.
- **None of the three agents address GridVirtualizer interaction during window drag.** Spatial Mechanics mentions it in open question 4 (line 537-540) with a `_userHidden` flag, but nobody addresses what happens when a grid being dragged is culled by the virtualizer mid-drag because the camera moved. The virtualizer removes grids from the scene; if the drag target gets removed, the drag silently breaks. HitDispatcher must either pin the drag target as unculled or handle the target disappearing.
- **Touch input.** My analysis (Event Pipeline) covers it briefly in section 3. Neither Spatial Mechanics nor Integration Surface mentions touch.
- **Integration Surface does not address HitDispatcher at all.** The command handlers (`window.move`, `group.move`) are addressed, but the actual mouse-level event interception is entirely absent from Integration Surface's analysis. This is expected (different scope), but means the connection between "dragging a grouped window moves the group" (Integration Surface line 47) and the actual drag mechanics (Event Pipeline + Spatial Mechanics) is unstated.

## Tensions

1. **Where does `screenToWorldDelta` live?**
   - Spatial Mechanics: standalone exported function in a spatial utilities module (line 34).
   - Event Pipeline (my analysis): inline `_screenToWorldDelta` method on HitDispatcher (line 291).
   - **Correct position**: Spatial Mechanics is right. The function is pure math with no HitDispatcher state dependency. Extract it. HitDispatcher, SpatialAnimator, and potentially group drag all need it.

2. **Who owns window drag state?**
   - Spatial Mechanics: "The drag handler sits in `SpatialWindowManager`" (line 67).
   - Event Pipeline: HitDispatcher owns drag state (`_active`, `_target`, `_hasMoved`).
   - **Correct position**: Event Pipeline. HitDispatcher must own the low-level DOM event interception and drag state because it needs capture-phase mousedown to suppress VCC. SpatialWindowManager is a higher-level orchestrator that responds to drag results (e.g., group movement). HitDispatcher calls into SpatialWindowManager, not vice versa.

3. **Depth management: monotonic counter vs fixed Z-pop.**
   - Spatial Mechanics: monotonic `_zCounter * 0.5` per interaction (line 369-379).
   - Integration Surface: SelectionManager's existing `Z_POP_AMOUNT = 3` (SelectionManager.js line 21), with SpatialWindowManager applying the same delta to group siblings (line 49-65).
   - **Tension**: Spatial Mechanics wants to replace the fixed Z-pop with a monotonic counter. Integration Surface wants to extend the existing Z-pop to groups. These conflict -- if the counter runs, the fixed +3 pop is meaningless. If SelectionManager's Z-pop runs first and SpatialWindowManager also bumps Z, you get double-pop.
   - **Correct position**: Spatial Mechanics' counter is the better model long-term, but the transition must coordinate with SelectionManager. Short-term: keep SelectionManager's Z-pop for ungrouped grids, have SpatialWindowManager intercept Z-pop for grouped grids (as Integration Surface suggests on line 49), and introduce the monotonic counter only for window-managed objects.

4. **Registration model: where does group membership live?**
   - Spatial Mechanics: `object3d.userData._windowGroup = this.id` (WindowGroup.add, line 447).
   - Integration Surface: `SpatialWindowManager._gridToGroup` reverse map + FileStateManager `groupId` property (line 36-37, 90-91).
   - **Correct position**: Both are needed. `userData._windowGroup` enables fast per-object checks (e.g., SelectionManager Z-pop guard from Spatial Mechanics line 407). The reverse map enables group-level queries. FileStateManager `groupId` drives CodeColorManager. All three stores must stay in sync, which means a single mutation path through SpatialWindowManager.

## Recommendations

1. **Extract `screenToWorldDelta` as an exported function in `spatialHelpers.js`.** HitDispatcher and SpatialWindowManager both import it. Use `getCanvasViewportSize`, not `window.innerHeight`.

2. **Fix VCC `_applyDragTranslation` to use `getCanvasViewportSize`.** Line 244 of ViewerCameraController.js uses `window.innerHeight`. This is a pre-existing bug per project conventions. Fix it alongside the window manager work to keep pixel-scale calculations consistent.

3. **Export `easeInOutCubic` from `spatialHelpers.js`.** Currently private (line 221). SpatialAnimator needs it.

4. **Pin drag targets against virtualizer culling.** When HitDispatcher starts a drag, set `grid.userData._dragPinned = true`. GridVirtualizer checks this flag and skips removal. Clear on drag end.

5. **Single mutation path for group membership.** `SpatialWindowManager.addToGroup()` must: (a) call `windowGroup.add(object3d)` which sets `userData._windowGroup`, (b) update `_gridToGroup` map, (c) write `groupId` to FileStateManager. Never set any of these independently.

6. **HitDispatcher owns drag, SpatialWindowManager owns group semantics.** HitDispatcher detects hits and emits structured events (`window-drag-start`, `window-drag-move`, `window-drag-end`). SpatialWindowManager listens and handles group logic (moving siblings, drop-to-group). This keeps DOM concerns out of the spatial layer.

7. **Name SceneRegistry's multi-listener API `addChangeListener`/`removeChangeListener`**, not `onChange`/`offChange`, to avoid collision with the existing `_onChange` field.

8. **Coordinate Z-pop ownership.** Add `if (grid.userData._windowGroup) return;` guard in SelectionManager._applyZPop (line 251). SpatialWindowManager handles Z for grouped grids.

9. **Add touch handlers to HitDispatcher in Phase 1.** Mirror mousedown/move/up with touchstart/move/end using `e.changedTouches[0]`. Two-finger gestures stay with TouchController.

10. **AgentGrid has no `_background` mesh and no `getBounds`.** The HitDispatcher raycast loop (my phase0 line 262-267) iterates `registry.list()` and accesses `entry.grid?._background`. AgentGrid wraps a CodeGrid at `this.grid`, so the registry entry's `.grid` would be the AgentGrid, not the inner CodeGrid. The raycast must access `entry.grid.grid?._background` for AgentGrid entries, or AgentGrid should proxy `_background` from its inner CodeGrid. Cleaner: AgentGrid exposes a `get _background()` getter delegating to `this.grid._background`.

## Key Insight

The three analyses converge on a clean layered architecture -- HitDispatcher (DOM events) -> SpatialWindowManager (group semantics) -> WindowGroup (layout math) -> SpatialAnimator (per-frame interpolation) -- but they disagree on which layer owns drag state and Z-ordering. The critical realization is that the pixel-scale math in VCC itself has a latent bug (`window.innerHeight` vs `getCanvasViewportSize`) that will cause window drag to feel slightly off if not fixed. Every layer that converts screen pixels to world units must use the same viewport size source, and fixing VCC now prevents a class of "it feels wrong but I can't tell why" bugs in all three agents' designs.
