# Round 1: geometry reviews composition, navigation

## Errors Found

### E1: Navigation skips `updateMatrixWorld` before `getBounds()` (BUG)

`unionBoundsFromIndices()` in navigation calls `grids[idx].getBounds()` directly without calling `updateMatrixWorld(true)` first. If a grid was just repositioned (e.g., by a composition command in the same frame), `matrixWorld` is stale and `getBounds()` returns incorrect world-space coordinates. This affects `camera.frame`, `camera.frame.bounds` (indirectly via `frameBounds`), and every tour stop.

Geometry's `getWorldAABB()` calls `grid.updateMatrixWorld(true)` before `getBounds()`. Navigation must do the same.

Fix: Add `grids[idx].updateMatrixWorld(true)` inside `unionBoundsFromIndices()` before `getBounds()`.

### E2: Navigation `createTourAnnotation` also skips `updateMatrixWorld` (BUG)

Line 207 in navigation calls `grid.getBounds()` without updating the matrix first. The annotation placement coordinates (`bounds.min.x`, `bounds.max.y`, `bounds.max.z`) may be stale.

### E3: Composition uses `updateWorldMatrix(true, true)` vs geometry uses `updateMatrixWorld(true)` (INCONSISTENCY)

Composition calls `grid.updateWorldMatrix(true, true)` (Three.js r152+ method: updates ancestors, then descendants). Geometry calls `grid.updateMatrixWorld(true)` (older Three.js method: force-updates the entire subtree). Both work, but they have different semantics. `updateWorldMatrix(true, true)` is the modern API and more correct for ensuring the full chain. `updateMatrixWorld(true)` with the `force` flag bypasses dirty-checking and walks the full subtree, which is slightly wasteful for a leaf node. Pick one and share it.

### E4: Tour `tour.play` duplicates `zDistanceForFit` math inline (BUG-PRONE)

Lines 544-549 of navigation recompute the FOV/aspect Z-distance calculation inline instead of calling `zDistanceForFit()`. The logic is identical today, but this is a copy-paste maintenance hazard. If `zDistanceForFit` gains a margin correction or min-distance clamp, `tour.play` will silently diverge.

## Gaps

### G1: Navigation's `unionBoundsFromIndices` silently skips invalid indices

If an index is out of range, it `continue`s and returns partial results. Geometry's `resolveGrid` returns an error immediately. Navigation should fail loudly on bad indices rather than silently computing a union of fewer grids than requested.

### G2: Navigation's `unionBoundsFromIndices` does not handle empty bounds

If `getBounds()` returns an empty Box3 (grid has no content), the min/max will be wrong. Navigation pushes `Infinity`/-`Infinity` values from an empty box into the union. Geometry checks `box3.isEmpty()` explicitly.

### G3: No shared AABB type across the three modules

Geometry returns `{ min, max, width, height, depth, center }`. Navigation returns `{ min, max, center, size: {x, y, z} }`. Composition returns the raw `THREE.Box3`. Three different shapes for the same concept. Downstream code that chains commands (e.g., get bounds, then frame them) must know which shape each returns.

### G4: Composition's `grid.bounds` data payload omits `center`

Geometry's `grid.bounds` returns `center` in the data. Composition's version does not. An agent chaining `grid.bounds` -> `camera.frame.bounds` would need to compute center manually from composition's output but gets it for free from geometry's.

## Tensions

### T1: Who owns `grid.bounds`?

Both geometry and composition register a `grid.bounds` command. They cannot both be loaded -- the second registration will overwrite the first (or the router will reject duplicates). Geometry's version returns richer data (center, width/height/depth as numbers). Composition's version adds anchor point listings in the TUI output. These need to merge into one command.

### T2: Anchor implementations are duplicated

Geometry defines `ANCHORS` as a map of `name -> function(aabb)`. Composition defines `getAnchorPoint(bounds, name)` as a switch statement operating on `THREE.Box3`. Same 9 anchors, same math, different input types (plain object vs Box3). This must be a single shared function that both import.

### T3: `resolveGrid` signature differs

Geometry: `resolveGrid(arg, grids)` -- arg first, grids second. Composition: `resolveGrid(grids, rawIndex, label)` -- grids first, with a label parameter. Both do the same validation. Unify.

## Recommendations

1. **Create `spatialHelpers.js`** with shared functions: `resolveGrid`, `getWorldAABB`, `computeAnchor`, `unionBounds`, and the canonical AABB shape. All three modules import from it. Eliminates E3, T2, T3, and G3.

2. **Fix `unionBoundsFromIndices`** to call `updateMatrixWorld(true)` and check `isEmpty()` before accumulating. Fixes E1, E2, G2.

3. **Delete the inline Z-distance math in `tour.play`** and call `frameBounds` or at minimum `zDistanceForFit`. Fixes E4.

4. **Merge `grid.bounds`** into one registration that includes both anchor listings (from composition) and the full data payload with center (from geometry). Fixes T1, G4.

5. **Fail on invalid indices** in `unionBoundsFromIndices` rather than silently skipping. Fixes G1.

## Key Insight

The three modules independently solved the same problem -- "get a grid's world-space bounding box reliably" -- with three slightly different implementations, two of which have bugs. Navigation's omission of `updateMatrixWorld` before `getBounds()` is the most dangerous defect: after any composition command repositions grids, the very next `camera.frame` call will frame stale positions. This is the exact workflow an agent would execute (align grids, then frame them), making it a guaranteed bug in practice.
