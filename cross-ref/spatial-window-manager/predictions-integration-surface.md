# Cross-Ref Predictions: Integration Surface Agent

Agent: Integration Surface
Task: Predict what the Event Pipeline and Spatial Mechanics agents concluded, WITHOUT reading their outputs.

---

## Predictions for Event Pipeline Agent

### Main Conclusions (predicted)

I expect the Event Pipeline agent concluded that the primary bottleneck for window drag is **ViewerCameraController's monopoly on mousedown/mousemove/mouseup**. The camera controller currently owns the entire drag gesture -- it captures mousedown on the canvas, tracks displacement, and only fires a synthetic `canvas-click` CustomEvent when displacement is under 5px. There is no mechanism for a second consumer (a window drag handler) to intercept the mousedown and claim the gesture before the camera starts panning.

The agent likely proposed a **gesture disambiguation layer** -- something like a HitDispatcher or GestureRouter that sits between the raw DOM events and the camera controller. On mousedown, it would first GPU-pick (via PickingSystem) or raycast to determine whether the pointer is over a draggable window header/titlebar region. If yes, the gesture is claimed for window drag and the camera controller is suppressed for that gesture. If no, the camera controller proceeds as normal.

I expect the agent flagged that **PickingSystem only runs on mousemove** (`needsPick` dirty flag) and only resolves glyph-level hits, not "is this a window titlebar" hits. The agent likely concluded that either (a) a separate raycaster against CodeGrid `_background` meshes is needed for window-level hit testing (similar to what SelectionManager already does), or (b) PickingSystem needs a lightweight "which grid did I hit?" query that does not require the full glyph-resolution picking pass. My bet is they recommended option (a) -- reusing SelectionManager's raycasting pattern -- since PickingSystem is expensive for a simple "which grid" answer.

### Key Concerns (predicted)

1. **Click vs drag vs window-drag three-way disambiguation.** Currently there are two states: displacement < 5px = click, else = camera drag. Adding window drag makes it three-way: click, camera drag, window drag. The agent likely proposed a priority system: (1) hit-test on mousedown, (2) if hit is on a window header, enter window-drag mode, (3) else enter camera-drag mode, (4) on mouseup with < 5px displacement, fire click regardless.

2. **Event priority and the "who gets mousedown" problem.** The camera controller listens on the canvas element directly. The agent likely noted that adding more mousedown listeners creates ordering ambiguity and proposed either a single entry point that dispatches, or `stopImmediatePropagation` from the winning handler. I predict they recommended the single-entry-point approach since `stopImmediatePropagation` is fragile.

3. **Drop-to-group detection.** When a window is being dragged and released over another window or group, the agent needs to detect spatial proximity. I expect they concluded this should be a world-space proximity check (not another GPU pick), computed at mouseup time: iterate visible grids, check if the dragged grid's position overlaps any group's bounding box or any ungrouped grid's bounding box, with a configurable snap threshold.

### Likely Design Choices (predicted)

- A `GestureDispatcher` or `InteractionRouter` class that wraps the canvas and owns all pointer event listeners, delegating to consumers (camera controller, window drag handler, selection manager) based on hit-test results.
- Window drag detection via titlebar/header region check -- either a dedicated invisible mesh at the top of each CodeGrid, or a Y-offset check against the grid's bounding box top edge.
- The existing `canvas-click` CustomEvent pattern preserved but routed through the new dispatcher.
- The StackLayoutManager's existing fan/pull interaction noted as a precedent, since it already does mousemove hover detection and click handling on stacked grids.

---

## Predictions for Spatial Mechanics Agent

### Main Conclusions (predicted)

I expect the Spatial Mechanics agent concluded that **screen-to-world projection for drag** must use the existing `_applyDragTranslation` math from ViewerCameraController as a reference, but applied to grid position instead of camera position. The core technique is: convert screen pixel deltas to world-space deltas using the camera's view distance and aspect ratio, then apply those deltas to the dragged grid's `Object3D.position`. They likely identified that the camera controller already has this math in `_applyDragTranslation` (screen px to world units scaled by camera distance) and proposed extracting it into a shared utility or duplicating the formula in the drag handler.

The agent likely proposed **three group layout modes** (stack, splay, free) matching what I outlined in the integration surface analysis, but with specific geometric formulas. For stack layout, I expect they concluded vertical stacking along Y with a fixed offset per member, similar to StackLayoutManager's `stackZOffset` but using Y instead of Z. For splay, a fan-out along X or in a radial arc. For free layout, members keep their current positions relative to the group centroid.

I expect the agent identified that **there is no shared animation system** in the codebase. The TourSequencer has `animateCamera` via spatialHelpers (lerp-based requestAnimationFrame loop), and StackLayoutManager has instant position sets with no animation. The agent likely proposed either (a) a lightweight `AnimationManager` utility that runs lerp/spring animations on `Object3D.position` values per frame, hooked into the render loop, or (b) inline requestAnimationFrame lerp loops like TourSequencer uses. Given the codebase's preference for minimal infrastructure, I predict they recommended approach (b) -- a simple `animatePosition(object3D, target, duration)` utility function rather than a full animation manager class.

### Key Concerns (predicted)

1. **Depth management for dragged grids.** When a grid is being dragged, it needs to render on top of everything else. The agent likely noted that `renderOrder` and `position.z` are the two mechanisms available. SelectionManager already uses Z-pop (`Z_POP_AMOUNT = 3`). The agent likely proposed a larger Z offset during drag (e.g., 10-20 units) to guarantee the dragged grid visually floats above all others, then animate back to its target Z on drop.

2. **Group centroid calculation and offset-preserving movement.** When moving a group, each member must maintain its relative offset from the group centroid. The agent likely proposed: compute centroid as average of all member positions, then on group move, apply the delta (new centroid - old centroid) to every member's position. This is standard but the agent would have called it out explicitly since getting it wrong causes the group to collapse to a point.

3. **GridVirtualizer interaction.** Frustum culling might remove a grid that is mid-drag if the camera moves. The agent likely flagged this and proposed that dragged/grouped grids should be marked as "pinned" in the virtualizer so they are never culled while in an active interaction state.

4. **The plane problem for 3D drag.** Mouse drag gives 2D screen deltas, but grids live in 3D. The agent must have decided which plane to project onto. I predict they chose the camera-parallel plane at the grid's current Z depth (or the group centroid's Z depth), which is the standard approach and matches how `_applyDragTranslation` already works for camera panning.

### Likely Design Choices (predicted)

- Drag projection onto a camera-facing plane at the target's Z depth, converting screen deltas to world units using `camera.position.z - target.position.z` as the scale factor.
- Layout geometries computed as pure position arrays, then applied to member grids either instantly or via per-frame lerp.
- No external animation library -- either a small `animateVec3(target, from, to, duration, callback)` utility or direct requestAnimationFrame loops.
- Group bounding box computed as the union of all member grid bounding boxes, updated lazily (dirty flag on member add/remove/move).
- Depth during drag handled by temporarily increasing `position.z`, not by changing `renderOrder` (since renderOrder affects the glyph mesh but the background mesh has its own renderOrder at -1, and changing both is error-prone).

---

## Points of Expected Convergence

All three agents (including myself) should converge on:

1. **Groups are a centroid + member offsets model.** This is the only sane way to move N objects as a unit while preserving their spatial arrangement.

2. **The camera controller must yield control during window drag.** The current design has no mechanism for this, so all agents should identify it as the critical integration challenge.

3. **No existing animation infrastructure.** Every agent touching movement or layout transitions will have noted this gap and proposed a lightweight solution rather than a framework.

4. **StackLayoutManager as the closest precedent.** It already does spatial grouping (directory stacks), fan-out layout, pull-to-workspace, and hover detection. All agents should reference it as the design ancestor for window groups.

## Points of Expected Divergence

1. **Where the gesture routing lives.** Event Pipeline likely puts it in a new dedicated class. Spatial Mechanics likely treats it as an input concern and focuses on what happens after the gesture is classified. I put it in the camera controller's mousedown handler as a pre-check. We may disagree on the organizational boundary.

2. **Animation approach.** Spatial Mechanics may have proposed a more structured animation system (since layout transitions are their core concern), while Event Pipeline may not have addressed animation at all (since events are instantaneous). I proposed nothing specific about animation in my analysis, deferring to spatial mechanics.

3. **Drop detection geometry.** Event Pipeline may have proposed GPU-based drop detection (a second picking pass to find what's under the drop point). Spatial Mechanics may have proposed pure world-space bounding box overlap checks. I predicted world-space checks in the event pipeline section, but the agents may differ.
