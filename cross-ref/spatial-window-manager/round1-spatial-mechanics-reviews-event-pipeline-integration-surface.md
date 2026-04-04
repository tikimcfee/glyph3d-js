# Round 1: Spatial Mechanics reviews Event Pipeline, Integration Surface

## Errors Found

1. **Event Pipeline: `_screenToWorldDelta` uses `this._canvas.clientHeight` instead of `getCanvasViewportSize()`** (line 295). The project convention is explicit: never use `window.innerHeight` or raw element dimensions for camera math. The canonical function is `getCanvasViewportSize(canvas).height` from `src/core/canvasSize.js`. Note that `ViewerCameraController._applyDragTranslation` itself has the same bug at line 244 (`window.innerHeight`), but this is a known existing defect, not something new code should copy. HitDispatcher must use `getCanvasViewportSize`.

2. **Event Pipeline: `_findDropTarget` accesses `dragBounds.width` and `dragBounds.height` on a `THREE.Box3`** (lines 319-322). `CodeGrid.getBounds()` returns a `THREE.Box3`, which has `.min` and `.max` but no `.width` or `.height` properties. The `_computeOverlap` method correctly uses `.min`/`.max`, but line 322 (`dragBounds.width * dragBounds.height`) will produce `NaN`. Fix: compute area from `(box.max.x - box.min.x) * (box.max.y - box.min.y)`.

3. **Event Pipeline: `_raycastDraggable` iterates `this._registry.list()`** (line 262). `SceneRegistry.list()` returns all entries of all types (`src/services/SceneRegistry.js` line 188). This means the raycast will attempt to access `._background` on annotation entries, label entries, tour entries, and any other type. Most of these have no `_background` property. The null check on line 264 (`bg && bg.visible`) prevents a crash, but it is silently iterating hundreds of non-draggable objects. Should filter by type first: `this._registry.findByType('grid')` and potentially `findByType('window')`.

4. **Integration Surface: `SelectionManager.on()` callback signature is `(eventType, sourcePath, state)`** (line 52 of phase0-integration-surface.md references this correctly). But the Z-pop integration sketch at line 56 calls `this._findGridIdBySourcePath(sourcePath)` -- a method that does not exist on any class in the codebase and is not defined in the sketch. The registry is keyed by ID, not sourcePath. Resolving sourcePath to grid requires scanning entries (like `SelectionManager._findGrid` does at `SelectionManager.js` line 281). This is a non-trivial lookup that needs a concrete implementation.

5. **Integration Surface: `registry._onChange` is correctly identified as a single callback slot** (line 206). However, the proposed migration to `_changeListeners: Set<Function>` adds `onChange(fn)` and `offChange(fn)` methods that shadow the existing `_onChange` property. The backward-compat shim on line 229 (`if (this._onChange)`) will fire the old callback *in addition to* the new listeners for the same event. During the transition this causes double-firing for any existing consumer that set `_onChange` directly. The fix: just replace `_onChange` outright. There is exactly one consumer (`GitHubRepoViewer` or similar), easy to migrate.

6. **Event Pipeline: background mesh Z is wrong in the analysis description** (line 356 of phase0-event-pipeline.md says "Z-pop from selection raises selected grids by 3 units, making them naturally frontmost"). The actual `_background.position.z` is not a constant. `_initBackground` at `CodeGrid.js` line 385 sets it to `-0.1`, but `_updateBackground` at line 673 recomputes it to `zMin - 0.5` (behind the furthest Z-wrapped text layer). Stacking behavior depends on which code path ran last. This is relevant for raycast hit ordering.

## Gaps

- **Event Pipeline covers touch input** (section 3, "Touch input") with a clear defer-to-Phase-1 plan. My analysis and Integration Surface's analysis both omit touch entirely.
- **Integration Surface covers persistence** (section 6, "Persistence") with a concrete serialization shape keyed by `sourcePath`. My analysis raised it as an open question without committing to an answer.
- **Integration Surface covers color layer integration** (section 3, "Color Layer for Groups") with a `group-tint` layer at priority 5. Neither my analysis nor Event Pipeline addresses visual distinction for groups at all.
- **My analysis covers the critically-damped spring** for drag-release feel. Neither other agent addresses animation physics beyond "animate to target."
- **Neither other agent addresses GridVirtualizer interaction.** My analysis (section 6, item 4) identifies that a user-hidden window must not be re-added by the virtualizer. This is a real bug waiting to happen: `GridVirtualizer` adds grids to the scene purely based on frustum intersection. A hidden window at a visible position will flicker visible every frame.
- **Event Pipeline identifies the `canvas-click` reuse path** (HitDispatcher re-emits `canvas-click` on non-drag mouseup). My analysis does not address how click-on-window feeds back into SelectionManager.

## Tensions

1. **Where SpatialWindowManager lives.** Integration Surface places it at `src/services/spatial/SpatialWindowManager.js` (line 269). Event Pipeline places HitDispatcher at `src/services/interaction/HitDispatcher.js` (line 435). My WindowGroup lives conceptually in the same spatial directory. The tension: HitDispatcher is an event/interaction concern, not a spatial math concern. It should live in `src/services/interaction/` alongside `SelectionManager.js`. The spatial math (layouts, animator) belongs in `src/services/spatial/`. **Both positions are correct for their respective classes.** The key is that HitDispatcher and SpatialWindowManager are separate classes in separate directories.

2. **Who owns drag-move of grouped windows.** Integration Surface says "Dragging a selected group member moves the entire group" (section 2). Event Pipeline's HitDispatcher moves only the single `this._target.grid` (line 208). These are contradictory. **Integration Surface's position is the correct UX.** The fix: HitDispatcher must check `spatialManager.getGroupForGrid(gridId)` and, if grouped, apply the world delta to all group members. HitDispatcher needs a reference to SpatialWindowManager (or emits a delta event that the manager intercepts).

3. **Z-pop ownership.** My analysis says the window manager should own Z for grouped grids and SelectionManager should skip them (section 4, item 2). Integration Surface says SelectionManager still Z-pops the clicked grid normally, and SpatialWindowManager applies the same delta to siblings (section 2, line 49). **Integration Surface's approach is simpler and correct.** It avoids modifying SelectionManager. The only risk: if the window manager's Z-pop amount ever diverges from `Z_POP_AMOUNT = 3`, siblings will be at different Z than the primary. Solution: import or share the constant.

4. **Background Z value for z-fighting analysis.** My analysis states background is at `z = -0.1` (section 4, line 389 of my doc). The actual code in `_updateBackground` (`CodeGrid.js` line 673) repositions it to `zMin - 0.5`, which can be much further back for Z-wrapped files. My stack-mode z-fighting analysis (0.5 units per card, 5x the minimum gap of 0.1) is **too optimistic** for Z-wrapped content. For wrapped files, background can be at `-0.5` or deeper, meaning the effective gap between stacked cards is smaller than claimed. Still safe at 0.5 step, but the stated reasoning is wrong.

## Recommendations

1. **HitDispatcher must use `getCanvasViewportSize(canvas).height`** in `_screenToWorldDelta`, not `this._canvas.clientHeight`. One-line fix, prevents viewport mismatch in container-embedded canvases.

2. **Fix `_findDropTarget` area computation.** Replace `dragBounds.width * dragBounds.height` with `(dragBounds.max.x - dragBounds.min.x) * (dragBounds.max.y - dragBounds.min.y)`. `THREE.Box3` has no `.width`/`.height`.

3. **Filter `_raycastDraggable` by type.** Replace `this._registry.list()` with `[...this._registry.findByType('grid'), ...this._registry.findByType('window')]`. Avoids iterating annotations, labels, tour markers.

4. **Add group-aware drag to HitDispatcher.** When a drag target belongs to a group, apply the world delta to all group members. HitDispatcher constructor should accept an optional `spatialManager` ref (null during Phase 0, wired in Phase 1).

5. **Share `Z_POP_AMOUNT`.** Extract the constant from `SelectionManager.js` line 21 to `src/core/constants.js` or `spatialHelpers.js`. Both SelectionManager and SpatialWindowManager need the same value.

6. **Replace `SceneRegistry._onChange` with a listener Set in one step** -- no backward-compat shim. There is one consumer to migrate. The dual-fire transition period is unnecessary complexity.

7. **Add `userData._userHidden` check to GridVirtualizer.** When a window is hidden by the user (via `group.hide` or window minimize), the virtualizer must not re-add it to the scene. One-line guard in the frustum check.

8. **Export `easeInOutCubic` from spatialHelpers.js.** My SpatialAnimator sketch imports it as a default easing. It is currently a private function (line 221 of spatialHelpers.js). Either export it there or put it in a shared `src/utils/easing.js`.

9. **Concrete `sourcePath -> gridId` resolver for Integration Surface's selection listener.** The simplest approach: `this._registry.findByMeta('sourcePath', sourcePath)` -- if grid registration stores `sourcePath` in meta (it currently does in some code paths). Verify this is consistent.

10. **Integration Surface's `WindowGroup` and my `WindowGroup` should converge.** Integration Surface's is a plain data structure (`memberIds: Set<string>`). Mine is richer (holds Object3D refs, calls layout functions, owns `_getBounds`). The implementation should use mine with Integration Surface's registry integration (register group as type `'group'`).

## Key Insight

The three analyses converge on the same architecture but disagree on who moves what during a group drag. Event Pipeline's HitDispatcher owns the raw input and produces world-space deltas. Integration Surface's SpatialWindowManager owns group membership and should amplify a single-grid delta into a group-wide move. My SpatialAnimator handles the interpolation. The critical missing wire is the connection between HitDispatcher's per-frame `_handleMouseMove` and SpatialWindowManager's group membership query -- without it, dragging a grouped window will only move one member, which is the single most visible UX bug the system could ship with. The fix is straightforward (one lookup, one loop), but it must be designed in Phase 0 because it determines whether HitDispatcher takes a manager reference or emits events, and that shapes every interface downstream.
