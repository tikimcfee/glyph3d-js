# Round 1: composition reviews geometry, navigation

## Errors Found

1. **Geometry and composition both define `grid.bounds` with conflicting schemas.** Geometry's `grid.bounds` returns `data.bounds` with `{ min, max, width, height, depth, center }` where size fields are top-level. Composition's `grid.bounds` returns `data.size` as `{ width, height, depth }` nested, and has no `center` field. Both register as `'grid.bounds'` on the same router -- the second registration silently overwrites the first, or throws, depending on the router implementation. This is a hard conflict that must be resolved before implementation.

2. **Geometry uses `grid.updateMatrixWorld(true)` while composition uses `grid.updateWorldMatrix(true, true)`.** These are different Three.js methods. `updateMatrixWorld(force)` updates this object and all descendants. `updateWorldMatrix(updateParents, updateChildren)` updates ancestors first, then children. Both work but `updateWorldMatrix(true, true)` is more correct when parent transforms may also be stale (e.g., after a parent group was repositioned). Geometry should adopt `updateWorldMatrix(true, true)` for consistency and correctness.

3. **Navigation's `unionBoundsFromIndices` silently skips invalid indices** (line 62: `if (idx < 0 || idx >= grids.length) continue`). Geometry's `grid.bounds.union` returns an error on invalid indices. Navigation's `createTourAnnotation` also calls `grid.getBounds()` without `updateMatrixWorld` -- if composition just moved the grid via `grid.align`, the bounds will be stale.

4. **Navigation's `CodeTour.build()` sends arguments in wrong order.** Line 797: `tour.stop ${nameB64} ${stop.gridIndex} ${stop.durationMs} ${annotB64}` puts duration before annotation. But the `tour.stop` handler (line 427-485) expects `<base64-tour-name> <grid-index> [base64-annotation] [duration-ms]` -- annotation before duration. The `play()` method (line 764) gets this right. `build()` will create stops with annotation/duration swapped.

## Gaps

1. **No shared anchor module.** Geometry defines `ANCHORS` as a map of functions from AABB to point. Composition defines `ANCHOR_NAMES` as a Set plus `getAnchorPoint()` as a switch statement. Both compute identical results with identical anchor names. This should be a single shared module (`spatialHelpers.js` or similar) that both command files import.

2. **No shared `resolveGrid` / `getWorldAABB` helpers.** Geometry has `resolveGrid(arg, grids)` returning `{ grid, idx } | { error }`. Composition has `resolveGrid(grids, rawIndex, label)` with swapped argument order and a label parameter. Navigation inlines its own validation. Three independent implementations of the same logic.

3. **Navigation's `camera.frame` cannot accept composition's output directly.** After `grid.align` or `grid.stack`, a natural next step is to frame the result. But `camera.frame` takes grid indices, not bounds. If the user wants to frame the union of grids that were just stacked, they must manually list indices. A workflow like `grid.stack 0 1 2 horizontal 5 | camera.frame` has no path. The `camera.frame.bounds` command could accept the output of `grid.bounds.union`, but there is no piping mechanism -- the user must manually re-type coordinates.

4. **Tour annotations do not use `grid.attach`.** Navigation's `createTourAnnotation` hardcodes annotation placement: `x = bounds.min.x`, `y = bounds.max.y + 2`, `z = bounds.max.z + 1`. This is effectively `grid.attach <annot> <target> above 2` with a Z-forward offset. If composition's attach existed, the tour could use it for consistent annotation positioning. Currently the positioning logic is duplicated and divergent (composition puts Z at center-z, navigation pushes Z forward by 1).

5. **No `camera.frame` after `grid.stack` convenience.** The most common workflow is: stack grids, then frame them. Navigation provides no compound command or return value that feeds directly into framing.

## Tensions

1. **Geometry's read-only philosophy vs. composition's mutation commands.** Geometry treats all commands as pure queries (`grid.bounds`, `grid.anchor`, `grid.distance`, `grid.overlap`). Composition mutates grid positions (`grid.align`, `grid.attach`, `grid.stack`). Both live in `spatialCommands.js`. This is fine architecturally, but means geometry's `grid.bounds` results are invalidated by composition's commands within the same session. No staleness warning exists.

2. **Geometry's `grid.anchor` vs. composition's anchor computation.** Geometry exposes `grid.anchor <index> <name>` as a user-facing command returning a world-space point. Composition uses anchors internally for alignment math but does not expose them as a standalone query. If both are registered, the user gets `grid.anchor` from geometry (read-only query) alongside `grid.align` from composition (which uses anchors for mutation). This is actually complementary, not conflicting -- but it means geometry owns the "anchor query" command namespace while composition owns the "anchor action" namespace. They should share the computation.

3. **Navigation's bounds format uses `size: { x, y, z }` while geometry uses `{ width, height, depth }`.** Navigation's `unionBoundsFromIndices` returns `size: { x, y, z }`. Geometry's `getWorldAABB` returns `{ width, height, depth }`. Composition does not emit bounds in its response data at all. If a downstream consumer (like a future scripting API) chains these, the field name mismatch creates friction.

## Recommendations

1. **Extract a shared `spatialHelpers.js` module** containing: `getAnchorPoint(box3, name)`, `resolveGrid(grids, arg, label?)`, `getWorldBounds(grid)` (with `updateWorldMatrix`), and `fmtVec(v, decimals)`. All three command files import from it. This eliminates ~60 lines of duplication and ensures anchor computation is identical everywhere.

2. **Standardize the bounds return shape.** Pick one: `{ min, max, size: { x, y, z }, center: { x, y, z } }` or `{ min, max, width, height, depth, center }`. I recommend the former (`size.x/y/z`) since it is a proper vec3 and matches Three.js's `Box3.getSize()` output pattern. Apply consistently across all three agents.

3. **Resolve the `grid.bounds` ownership.** Either geometry owns it (composition imports and delegates) or merge into the shared helpers module. Do not register it twice.

4. **Navigation should call composition's attach for tour annotations** instead of hardcoding position math. Create the annotation grid, add it to the grid list, then call the attach logic (as a function, not a command) to position it above the target. This keeps annotation positioning consistent with the rest of the spatial API.

5. **Fix `CodeTour.build()` argument order** -- swap `${stop.durationMs}` and `${annotB64}` to match the handler's expected order.

6. **Add `updateWorldMatrix(true, true)` to navigation's `createTourAnnotation`** before reading bounds, matching composition's pattern.

## Key Insight

All three proposals independently implement the same two primitives: "get a grid's world-space bounding box" and "resolve a grid index from args." The anchor vocabulary is identical across geometry and composition (9 names, same coordinates). This is a strong signal that a shared spatial helpers module should exist before any of the three command files are written. The helpers are small (~80 lines), pure, and have no command-routing dependencies. Building them first eliminates the duplication and prevents the schema divergences (bounds format, matrix update method, error shape) that currently exist between the three proposals.
