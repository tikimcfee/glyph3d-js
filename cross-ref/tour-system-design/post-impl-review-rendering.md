# Post-Implementation Review: rendering

Reviewer perspective: GPU rendering pipeline, buffer management, draw call architecture.
Files read: ConnectionRenderer.js, index.js, TourAnnotator.js, TourSequencer.js, tourCommands.js,
GlyphRenderer.js, CodeGrid.js, GridVirtualizer.js, GitHubRepoViewer.js.

---

## Bugs Found

### 1. `_zeroSlot` does not zero the color buffer — GPU renders stale color data

**File:** `src/annotations/ConnectionRenderer.js`, lines 263–269

`_zeroSlot` fills `_posArr` with zeros and marks `_posBuf.needsUpdate`, but it never touches
`_colArr` or `_colBuf`. The position vertices collapse to world origin (0,0,0), which makes the
line degenerate in clip space, but the color attribute upload for those vertices is never cleared.
On the next frame where both grids re-enter the frustum, `_writeSlot` is called and correctly
repopulates everything — so in the happy path this is latent. The scenario where it bites: if
`remove()` is called (not just `_zeroSlot` via `refreshVisibility`), the slot goes back to
`_slotFree` and can be reassigned to a new connection. The new connection's `_writeSlot` writes
correct positions but the stale color is already in `_colArr` from the old connection. If the new
connection's color write somehow fails (e.g., a future code change short-circuits before the color
loop), the wrong color leaks through. More critically, `_zeroSlot` is also called from
`refreshVisibility` when a grid goes off-screen (line 167). Those slots are still "occupied" (not
freed). If the caller then calls `setColor()` on such a connection, `_writeSlot` runs, writes
positions back, writes the correct color, and marks both bufs `needsUpdate` — that is fine.
However, if the slot stays zeroed across many frames without a position re-write, the color upload
from the initial `_zeroSlot` path is simply missing, which means the GPU retains whatever was
uploaded last. For `LineSegments` with degenerate (0,0,0) vertices this is harmless in practice,
but it is a correctness hole that violates the contract implied by the comment "GPU discards
degenerate lines."

**Fix:** add `this._colArr.fill(0, base, base + VERTS_PER_CONNECTION * 3)` and
`this._colBuf.addUpdateRange(vertBase * 3, VERTS_PER_CONNECTION * 3); this._colBuf.needsUpdate =
true;` to `_zeroSlot`.

---

### 2. `clear()` mutates the Map while iterating its keys — undefined behavior

**File:** `src/annotations/ConnectionRenderer.js`, lines 123–125

```javascript
clear() {
    for (const id of this._connections.keys()) this.remove(id);
}
```

`this.remove(id)` calls `this._connections.delete(id)` on line 117. The ECMAScript spec for Map
iteration guarantees that entries added during iteration are not visited, and entries deleted
before they are reached are not visited — so in V8 this will silently skip approximately half the
connections. The iterator snapshot is the live Map; deleting visited keys is safe, but whether
future keys (not yet visited) are skipped depends on internal hash table compaction. In practice,
on a densely packed integer-indexed Map, alternating slots will be skipped.

Concrete trigger: `tour.clear` → `TourSequencer.clear()` → `connectionRenderer.clear()`. Any tour
with 2+ connections will leave orphaned GPU vertices and leaked slot entries.

**Fix:**
```javascript
clear() {
    for (const id of [...this._connections.keys()]) this.remove(id);
}
```

---

### 3. `_refreshDrawRange` uses max occupied slot, not actual vertex count — gaps produce garbage draws

**File:** `src/annotations/ConnectionRenderer.js`, lines 276–286

The draw range is set to `(maxSlot + 1) * VERTS_PER_CONNECTION`. Slots are allocated via a free
list (`_slotFree`) popped in reverse order (highest slot first due to `.reverse()` at line 49, but
`.pop()` gives the last element which is index 0 first). After connections are removed and slots
recycled, the max occupied slot can be lower than the previously set range, which is correct — but
there is a subtler issue: slots between 0 and `maxSlot` that are currently freed (zeroed) are
included in the draw range. `LineSegments` with degenerate (0,0,0) vertices is a zero-length line
segment. The GPU will attempt to rasterize it (or clip it immediately), but it consumes vertex
shader invocations for those 6 zeroed vertices every frame. At 256 max connections this is
negligible (1536 wasted VS invocations), but it is worth naming since it compounds with bug #2:
connections that were not properly cleared stay in the draw range permanently.

This is a performance concern, not a hard bug. Documented in Performance Concerns below. Named here
because it interacts with bug #2.

---

### 4. The perpendicular vector construction degenerates when direction is exactly `(0, ±1, 0)`

**File:** `src/annotations/ConnectionRenderer.js`, lines 222–226

```javascript
if (Math.abs(ux) < 0.9) { px = 0; py = -uz; pz = uy; }
else                     { px = uz; py = 0;  pz = -ux; }
```

The first branch handles "direction is not mostly along X" by crossing with the Y axis:
`cross(u, Y) = (uy*0 - uz*1, uz*0 - ux*0, ux*1 - uy*0)` — wait, the code computes
`(0, -uz, uy)` which is `cross(X_hat, u)` if u = (ux, uy, uz):
`X × u = (1,0,0) × (ux,uy,uz) = (0*uz - 0*uy, 0*ux - 1*uz, 1*uy - 0*ux) = (0, -uz, uy)`. That
is correct.

The second branch (`px = uz; py = 0; pz = -ux`) = `cross(u, Z_hat)`:
`u × Z = (ux,uy,uz) × (0,0,1) = (uy*1 - uz*0, uz*0 - ux*1, ux*0 - uy*0) = (uy, -ux, 0)`.
The code has `(uz, 0, -ux)` — this is `cross(Z_hat, u)` with a sign flip. The magnitude is the
same (will be normalized), but the perpendicular plane orientation is different from the first
branch. This causes a visual discontinuity: arrowheads connecting two segments that straddle the
`|ux| = 0.9` threshold will snap orientation. In a code visualization where connections are mostly
horizontal (large X component), this is the common case.

**Correct form for the second branch** (cross with Z when X dominates):
`cross(u, Z) = (uy, -ux, 0)` → `px = uy; py = -ux; pz = 0`.

The current `(uz, 0, -ux)` is `Z × u` and produces a perpendicular but in a different half-plane.
The arrowhead will still render (it will not degenerate), but it may point "down" rather than
"left" relative to the shaft direction, and the two branches produce different visual results for
similar connection directions near the threshold.

---

### 5. `TourAnnotator.removeHighlights` does not track token highlights — they accumulate

**File:** `src/services/tour/TourAnnotator.js`, lines 95–104 and 134–145

`apply()` tracks range highlights in `_stepHighlights` and tears them down via
`clearLineHighlight` per line. But `_highlightToken()` (lines 134–145) calls `highlightRange` for
every token occurrence and those ranges are NOT added to `_stepHighlights`. When `removeHighlights`
runs for that step, only the non-token ranges are cleared. Token highlights persist across step
transitions and accumulate across repeated visits to a step.

Concrete scenario: step 0 has `ref.token = "handleClick"`. Navigate to step 0, forward to step 1,
back to step 0. The token highlight from the first visit is never cleared; the second visit adds
another additive layer. After N round-trips the token glyphs will be over-saturated.

---

### 6. Double-dispose of label grids in `TourSequencer.clear()`

**File:** `src/services/tour/TourSequencer.js`, lines 167–182

`clear()` at line 169 calls `_teardownStep(this.stepIndex)`, which calls
`this._annotator.remove(step.annotations)`. `TourAnnotator.remove()` (line 83) calls
`entry.grid.dispose?.()` and `this._ctx.registry.unregister(id)` for each annotation label grid.

Then, on line 174, `clear()` calls `this._ctx.registry.unregisterByType('tour-annotation')` and
again calls `entry.grid.dispose?.()` and `this._ctx.scene.remove(entry.grid)` for the returned
entries (lines 175–178).

If the current step has annotations, those grids are disposed twice. `CodeGrid.dispose()` must be
idempotent for this to be safe. Whether it is depends on CodeGrid's implementation — if
`_collection.dispose()` is called twice and GlyphRenderer.dispose() calls
`this._geo.dispose(); this._mat.dispose();`, Three.js geometry disposal on an already-disposed
geometry is a no-op (WebGLGeometries deregisters by object reference), so this does not cause a
WebGL error. However, any internal cleanup flags in CodeGrid or GlyphCollection that are not
idempotent would leave the object in a bad state. The risk is low but real; the double-dispose
path is an unambiguous logic error regardless of whether Three.js handles it gracefully.

---

## Performance Concerns

### A. `refreshVisibility()` runs per-frame even when no connections exist

**File:** `src/annotations/ConnectionRenderer.js`, line 158 / `app/GitHubRepoViewer.js`, line 1676

The animate loop checks `ctx.connectionRenderer` for null (line 1676), but once a tour is loaded,
`connectionRenderer` is never set back to null even after `tour.clear`. Every frame thereafter
iterates the (empty) `_connections` Map. This is O(0) cost but the Map size check and the
conditional in the animate loop are dead overhead. A `_dirty` flag or a `size === 0` early exit
would be cleaner.

### B. `refreshVisibility()` calls `_writeSlot` (full 6-vertex rewrite) on every grid re-appearance

**File:** `src/annotations/ConnectionRenderer.js`, lines 164–166

When a grid re-enters the frustum, `_writeSlot` is called, which computes the full arrowhead
geometry from scratch and marks both position and color bufs `needsUpdate`. This is correct but
slightly wasteful: the position data is already in `_posArr` from the original `set()` call.
A direct `_posBuf.needsUpdate = true` without recomputing the geometry would suffice. At 256 max
connections this is negligible, but it is architecturally inconsistent with the "direct buffer
write" philosophy.

### C. Each `setGlyphHighlight` call in `clearLineHighlight` issues `needsUpdate = true` per glyph

**File:** `src/collections/CodeGrid.js` lines 620–628 / `src/GlyphRenderer.js` lines 634–643

`clearLineHighlight` loops over every character in a line and calls `setGlyphHighlight` per
character. Each call sets `this._highlightTexture.needsUpdate = true`. The texture is only
re-uploaded once per frame by Three.js, so the repeated `needsUpdate = true` assignments are
harmless, but each individual call to `setGlyphHighlight` also calls `addUpdateRange` — except it
does not; looking at the code, `setGlyphHighlight` does NOT call `addUpdateRange` on the texture,
it just sets `needsUpdate`. DataTexture uploads are always full-texture in Three.js (no partial
texture update path via `addUpdateRange`). This is correct but means clearing a 1000-glyph line
triggers 1000 JS function calls each frame step, plus one 4KB texture re-upload. For tour teardown
this is a one-shot cost, not per-frame.

### D. `_refreshDrawRange` scans all connections on every `set()` and `remove()`

**File:** `src/annotations/ConnectionRenderer.js`, lines 276–286

It iterates `_connections.values()` to find the max slot. At 256 connections this is O(256). A
cached `_maxOccupiedSlot` field updated incrementally would reduce this to O(1).

---

## GPU Resource Lifecycle

### Dispose path is correct and complete

`ConnectionRenderer.dispose()` (lines 184–188) removes the mesh from the scene, disposes the
geometry, and disposes the material. The two `Float32Array` backing stores are GC'd when the
`ConnectionRenderer` instance is released. No leak in the dispose path.

### ConnectionRenderer is never disposed

**File:** `app/commands/handlers/tourCommands.js`, lines 31–40

`getSequencer()` lazily creates `ctx.connectionRenderer` and stores it on the context bag.
`tour.clear` clears connections but does not call `connectionRenderer.dispose()`. There is no
command, lifecycle hook, or viewer teardown that calls `dispose()`. The mesh, geometry, and
material persist for the lifetime of the page. At one instance per scene this is acceptable memory
usage (~200 KB for 256 connections × 6 verts × 3 floats × 2 bufs × 4 bytes), but if the viewer
is ever re-initialized (hot reload, scene reset) without a page reload, the previous mesh and
its ~200 KB buffers are orphaned in the GPU.

### Label grid dispose in `TourAnnotator.remove()` is correct for the happy path

**File:** `src/services/tour/TourAnnotator.js`, lines 79–88

The registry is the source of truth; `remove()` looks up by ID, disposes, removes from scene, and
unregisters. This is correct. The double-dispose issue (bug #6 above) is the only lifecycle
problem.

---

## Integration Issues

### I. `refreshVisibility()` is wired after `gridVirtualizer.update()` — correct ordering

**File:** `app/GitHubRepoViewer.js`, lines 1671–1678

The virtualizer updates first, then `refreshVisibility()` reads `grid.parent` to determine
frustum state. This is the correct order. The `grid.parent !== null` test matches the virtualizer's
internal predicate (`alreadyInScene = grid.parent != null`, GridVirtualizer.js line 75). The
two-null-check forms (`!= null` vs `!== null`) are semantically identical here since `parent` is
either a `THREE.Object3D` instance or `null` — never `undefined`.

### II. No `dispose()` call wired to viewer teardown

As noted in GPU Resource Lifecycle, there is no teardown path. If `GitHubRepoViewer` gains a
`dispose()` or `reset()` method in the future, it would need to call
`ctx.connectionRenderer?.dispose()`.

### III. `tour.clear` does not null out `ctx.connectionRenderer`

**File:** `app/commands/handlers/tourCommands.js`, lines 220–224 / `TourSequencer.js`, lines 167–187

After `tour.clear`, `connectionRenderer` stays on the context, the mesh stays in the scene (empty
draw range), and `refreshVisibility()` is called every frame for the rest of the session. This is
intentional (the object is reused if `tour.load` is called again), but it means the mesh is always
in the scene graph, consuming one draw call for 0 visible lines. Three.js's frustum cull would
skip it only if `frustumCulled` were `true` and the geometry were empty — but `frustumCulled` is
explicitly `false` (line 69), and `setDrawRange(0, 0)` makes the draw call trivially cheap. Still
worth documenting.

### IV. `prev()` edge case: already at step 0 re-enters `goto(0)` and tears down unnecessarily

**File:** `src/services/tour/TourSequencer.js`, lines 159–161

```javascript
async prev() {
    return this.goto(Math.max((this.stepIndex || 0) - 1, 0));
}
```

When at step 0, this calls `goto(0)`. `goto(0)` sees `this.state === 'active'` and calls
`_teardownStep(0)`, then re-applies step 0. The visual result is correct but the step is torn down
and re-applied unnecessarily, causing a one-frame flash where highlights and connection lines are
absent. The same issue exists for `next()` at the final step (Math.min clamps to
`steps.length - 1`). A guard of `if (index === this.stepIndex) return this.currentStep` at the top
of `goto()` would prevent this.

### V. `TourSequencer.clear()` calls `_teardownStep` which removes annotations from the registry,
then `unregisterByType('tour-annotation')` which tries to remove the same IDs again

This is bug #6 rephrased as an integration issue. The second `unregisterByType` call returns empty
(entries already unregistered) because `SceneRegistry.unregisterByType` only returns entries still
in `_entries`. So the double-dispose only fires if `_teardownStep` unregistered them but
`_annotator.remove` was called inside `_teardownStep`... re-reading: `_teardownStep` calls
`this._annotator.remove(step.annotations)` (line 242), which calls `this._ctx.registry.unregister(id)`
(TourAnnotator line 86). Those IDs are now gone from the registry. Then `clear()` calls
`unregisterByType('tour-annotation')` — which will return no entries for those IDs (already gone)
but *will* catch any label grids from *other steps* that `_teardownStep` did not handle (since only
`this.stepIndex` is torn down). So for a multi-step tour where step 2 is active and `clear()` is
called: step 2 annotations are torn down by `_teardownStep`, then `unregisterByType` catches labels
from steps 0 and 1 that were never torn down because those steps were navigated away from already.
That secondary cleanup is correct and necessary. The double-dispose risk only exists for step 2's
annotations if `unregisterByType` returns them — but it cannot because they were already
unregistered. So bug #6 as stated is actually not triggered in practice, but the logic is still
fragile: any future code path that does not unregister before calling `unregisterByType` would
expose it.

---

## What Works Well

**Single-draw-call architecture is solid.** One `LineSegments` mesh for all connections regardless
of count is exactly right. `frustumCulled = false` is the correct setting since connection lines
span arbitrary world space and the geometry's bounding box would be meaningless.

**Partial buffer upload via `addUpdateRange` is correctly applied.** `_writeSlot` and `_zeroSlot`
both compute `vertBase * 3` as the float offset, and `VERTS_PER_CONNECTION * 3` as the float count.
The arithmetic matches Three.js's expectation (element indices into the flat Float32Array, not byte
offsets). This is a common source of bugs and it was done right.

**Slot free-list design is correct.** Using an array as a stack with `.pop()` and `.push()` gives
O(1) allocation and release. Slot 0 is allocated first (the reversed array starts with the highest
index and `.pop()` takes from the end, which is index 0 after reverse). Slots are recycled cleanly.

**`refreshVisibility()` is a pure reader after `gridVirtualizer.update()`.** It does not call the
virtualizer, does not modify the registry, and does not allocate. It is safe to call every frame.
The `grid.parent !== null` test is the correct and documented way to check virtualization state.

**`depthWrite: false` on the line material** prevents connections from occluding glyph quads in the
depth buffer. Combined with `renderOrder: 1`, connections draw over text without cutting holes in
it. This is the right choice for an overlay-style annotation.

**Arrow geometry math is correct for the common case.** The shaft (2 verts) plus two arrowhead
lines (4 verts) correctly uses `LineSegments` (pairs of vertices per segment). The fallback
perpendicular when the direction is near-vertical is handled. The `len < 1e-6` early-out prevents
NaN from a zero-length connection. The `ARROW_LENGTH_RATIO = 0.12` default produces a proportional
arrowhead across a wide range of connection lengths.

**Lazy init of `ConnectionRenderer` in `getSequencer()`** means the GPU mesh is only created when
the tour system is first used. The single shared instance per scene is correct — there is no reason
to create multiple meshes for connection lines.

**`setVisible(visible)` as a mesh-level toggle** is O(1) and correct. It gives callers a fast way
to hide all connections without clearing them.

**`TourSequencer._teardownStep` scopes cleanup to exactly what was applied.** Tracking annotation
IDs and connection IDs on the step object and clearing only those (rather than clearing
everything globally) is correct and lets multiple future steps coexist without interfering with
each other.
