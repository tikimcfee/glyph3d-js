# Round 1: navigation reviews geometry, composition

## Errors Found

1. **Navigation's `unionBoundsFromIndices` skips `updateMatrixWorld`.**
   Geometry correctly calls `grid.updateMatrixWorld(true)` before every `getBounds()` in `getWorldAABB()` and `grid.bounds.union`. Navigation's `unionBoundsFromIndices` (lines 55-88) calls `grids[idx].getBounds()` directly with no matrix update. If a grid was just repositioned (e.g., by composition's `grid.attach` in the same frame), the bounds will be stale. This is the same bug geometry explicitly warns about in its design notes. The fix is a one-liner: add `grids[idx].updateMatrixWorld(true)` before `getBounds()` in the loop.

2. **Composition uses `updateWorldMatrix(true, true)` vs geometry uses `updateMatrixWorld(true)`.**
   These are different Three.js methods. `updateWorldMatrix(updateParents, updateChildren)` is a newer API that updates parents/children selectively. `updateMatrixWorld(force)` forces a full chain recompute. Both work, but mixing them across commands that run in sequence is a subtle inconsistency. If a parent's `matrixWorldNeedsUpdate` flag was cleared by one method, the other may behave differently. Pick one. Geometry's `updateMatrixWorld(true)` is the safer choice since `force=true` guarantees freshness regardless of flag state.

3. **Navigation `tour.play` re-derives `zDistanceForFit` inline (lines 544-549) instead of calling the existing `zDistanceForFit` helper declared at line 99.** This is duplicated math that will drift if the FOV calculation ever changes. Should call the helper directly.

## Gaps

4. **Navigation cannot leverage `grid.overlap` for smart framing.**
   When `camera.frame` unions multiple grids, overlapping grids inflate the bounding box wastefully if one grid fully contains another. Geometry's `grid.overlap` returns the intersection region and gap data. Navigation should consume this: if two grids overlap significantly, the union is already tight; if they have a large gap, navigation might want to warn or adjust the fill fraction. Currently no cross-domain data flow exists.

5. **`tour.stop` places annotations with raw positioning, ignoring composition's `grid.attach`.**
   `createTourAnnotation` (navigation lines 204-238) hardcodes annotation placement: `x = bounds.min.x`, `y = bounds.max.y + 2`, `z = bounds.max.z + 1`. Composition's `grid.attach` already solves this problem with `above` positioning and configurable gap. The tour annotation should use `grid.attach <annotation> <target> above <gap>` semantics internally, or at minimum use the same anchor math. The hardcoded `+2` / `+1` offsets will look wrong on grids with different scales or Z-wrapped content.

6. **No shared anchor module.**
   Geometry defines `ANCHORS` as a map of functions (line 113). Composition defines `getAnchorPoint` as a switch statement (line 79) plus `ANCHOR_NAMES` as a Set. Navigation has no anchor vocabulary at all -- its annotation placement is positional guesswork. All three agents need anchor resolution. This should be a single shared utility: `resolveAnchor(box3, name) -> {x,y,z}`.

7. **`camera.frame.bounds` ignores Z entirely, hardcoding `z: 0`.**
   Geometry's bounds always include Z (for Z-wrapped content). If a caller uses geometry's `grid.bounds.union` to get a region and then passes those coordinates to `camera.frame.bounds`, the Z information is silently dropped. The command should accept optional Z parameters or at least document that it is 2D-only.

## Tensions

8. **Geometry's `grid.bounds.union` and navigation's `unionBoundsFromIndices` do the same thing.**
   Geometry exposes `grid.bounds.union` as a command returning `{ indices, bounds }`. Navigation has a private `unionBoundsFromIndices()` function doing identical math (without the matrix update -- see error #1). These should not coexist. Navigation's `camera.frame` should call `grid.bounds.union` via the router or share the geometry helper. Two union implementations means two places to fix bugs.

9. **Geometry and composition both register `grid.bounds` with different signatures.**
   Geometry's `grid.bounds` returns `{ min, max, width, height, depth, center }`. Composition's `grid.bounds` returns `{ min, max, size: { width, height, depth } }` plus all anchor points. They cannot both register on the same router -- the second registration will silently overwrite the first. One must be chosen or they must be merged. Composition's version is strictly more informative (includes anchors), so geometry's should yield or be folded in.

10. **Composition's `resolveGrid(grids, rawIndex, label)` vs geometry's `resolveGrid(arg, grids)`.**
    Argument order is swapped. If these ever get extracted into a shared module, one signature must win. Composition's version with the `label` parameter is more useful for error messages.

## Recommendations

- **Extract a shared `spatialUtils.js`** containing: `resolveGrid`, `getWorldAABB` (with `updateMatrixWorld`), `resolveAnchor` (unified anchor map), `unionBounds`, and `fmtVec`/`fmtPos`. All three command modules import from it. This eliminates errors #1, #2, #3, and tensions #8, #10.

- **Merge `grid.bounds` registrations.** Use composition's richer version (with anchors) as the single implementation. Geometry adds `center` to the data payload, which composition omits -- merge both.

- **Replace `createTourAnnotation` positioning with anchor-based placement.** Use `resolveAnchor(bounds, 'top')` to get the attachment point, then offset by gap. This aligns tour annotations with composition's `grid.attach above` behavior and handles Z-wrapped grids correctly.

- **Have `camera.frame` call geometry's union** rather than maintaining a private copy. If calling via the router adds overhead, expose `unionBounds` as an importable function from the shared utils.

- **Add `camera.frame.region`** that accepts a geometry `grid.overlap` result directly, framing the intersection region. This creates a natural pipeline: detect overlap, then zoom to it.

## Key Insight

All three agents independently invented anchor/bounds resolution with slightly different implementations and slightly different bugs. The real deliverable from this spatial API is not three command files -- it is one shared spatial math module that all commands compose over. Without that, the N+1th command will introduce the N+1th copy of `resolveGrid` with the N+1th argument-order convention. The union of geometry + composition anchors + navigation framing is a clean three-layer stack (math -> positioning -> camera), but only if the bottom layer is shared.
