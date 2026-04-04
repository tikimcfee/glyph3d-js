# phase0-Queries.md — Caching `getGlyphCount`, `getBounds`, `getStats`

**Agent**: Queries
**Target**: `getGlyphCount` (5.9%) + `getBounds` (5.2%) + `getStats` (4.9%) = ~16% total frame time
**Status**: IMPLEMENTED

---

## What the profiler was seeing

All three functions were being called with high frequency (per-frame or per-update-cycle) despite returning values that rarely change:

- `GlyphRenderer.getStats()` iterates all `renderedTexts` entries via a `for...of` loop — O(n) where n is the number of text items. With thousands of items this adds up. Called from both `GlyphCollection.getGlyphCount()` and `GlyphCollection.getStats()`, so a single frame could trigger multiple full iterations.
- `GlyphCollection.getGlyphCount()` called `this._renderer.getStats().glyphCount`, paying the full O(n) iteration cost just to get one integer.
- `CodeGrid.getBounds()` allocated a `new THREE.Box3()` on every call and called `box.applyMatrix4(this.matrixWorld)` — both involve object allocation and matrix multiplication. Called from layout managers in tight loops (e.g., `StackLayoutManager`, `TreemapLayoutManager`, `SpiralLayoutManager` all loop over grids calling `getBounds()`).

The `GlyphCollection.getBounds()` already had a dirty-flag cache (`_boundsDirty` / `_boundsCache`), but `CodeGrid.getBounds()` — the layer above it — did not, so `applyMatrix4` and `new THREE.Box3()` ran on every invocation.

---

## Callers identified

### `getGlyphCount` callers
- `app/GitHubRepoViewer.js:2170` — loops `grid.getGlyphCount()` building a total
- `app/IDEShell.js:937` — same pattern
- `app/commands/handlers/systemCommands.js:50`
- `app/commands/handlers/sceneCommands.js:15`
- `app/commands/handlers/gridCommands.js:32,42,66,80,149,150,180,181`
- `app/commands/handlers/agentLayoutCommands.js:389,400`

Most are command responses (user-triggered, not per-frame). Some loops over all grids could fire per-frame if triggered by UI.

### `getBounds` callers
- `src/collections/GridVirtualizer.js` — `register()`, `refreshBounds()`, `refreshBoundsAll()`
- `src/collections/GridLayoutManager.js:68,186,260,295,564`
- `src/collections/StackLayoutManager.js:298,441,617`
- `src/collections/HierarchicalLayoutManager.js:418`
- `src/collections/TreemapLayoutManager.js:67,147,148,219,251,271`
- `src/collections/SpiralLayoutManager.js:85,206,299,321,367,371,411`
- `src/services/visual/TreemapLabelManager.js:171`
- `src/services/camera/ViewerCameraController.js:404`
- `src/services/interaction/HitDispatcher.js:255,270` — called on drag events
- `src/services/tour/TourAnnotator.js:126`
- `app/components/GroupsPanel.js:181,240`
- `app/commands/handlers/spatialHelpers.js:90,104`
- `app/commands/handlers/annotationCommands.js:285`
- `app/commands/handlers/agentLayoutCommands.js:58`
- `src/components/MinimapOverlay.js:92,126` — called per minimap refresh frame

### `getStats` callers
- `app/GitHubRepoViewer.js:1392,1597` — per HUD update interval
- `src/collections/GridVirtualizer.js:353`
- `GlyphCollection.getGlyphCount()` — O(n) chain
- `GlyphCollection.getStats()` — O(n) chain

---

## What changed

### `src/GlyphRenderer.js`

**Added `_cachedGlyphCount` field** (initialized to 0 in constructor) that is maintained incrementally by all mutation paths:

1. `_registerText()` — increments by `glyphs.length` when text is added
2. `remove()` — decrements by `entry.glyphCount` before deleting from the map
3. `removeBatch()` — decrements for each removed entry before deleting
4. `clear()` — resets to 0
5. `applyPrebuiltBuffers()` — clears map and resets to 0, then accumulates as entries are added (worker path replaces all content)

**Added `getGlyphCount()` method** — returns `this._cachedGlyphCount` in O(1). No iteration.

**Updated `getStats()`** — reads `this._cachedGlyphCount` instead of iterating `renderedTexts`. Still O(1). The `utilization` string is computed from the cached count.

### `src/collections/GlyphCollection.js`

**Updated `getGlyphCount()`** — calls `this._renderer.getGlyphCount()` (new O(1) method) instead of `this._renderer.getStats().glyphCount` (old O(n) iteration).

**Updated `getStats()`** — calls `this._renderer.getGlyphCount()` directly and computes utilization locally. No longer calls `this._renderer.getStats()`, eliminating one O(n) scan per stats call.

### `src/collections/CodeGrid.js`

**Added `_boundsCache` and `_boundsCacheDirty` fields** in constructor.

**Added `_markBoundsDirty()` public method** for external invalidation.

**Overrode `updateMatrixWorld(force)`** — reads `this.matrixWorldNeedsUpdate` before calling `super` (since super clears it), then sets `_boundsCacheDirty = true` if the transform changed. Uses a snapshot of `matrixWorld.elements[12]` (translation X) as a fast change probe for the case where `force=true` but the matrix didn't actually change.

**Updated `_updateBackground()`** — sets `_boundsCacheDirty = true` at entry, since all callers of `_updateBackground` represent content changes that make the current world-space bounds stale.

**Updated `getBounds()`** to:
- Check `this._collection._boundsDirty` as an additional dirty signal (content bounds changed without going through `_updateBackground`)
- Return `_boundsCache` immediately if clean and allocated
- Reuse the existing `_boundsCache` `Box3` instance on recompute (no allocation after first call)
- Set min/max directly from `contentBounds` + padding, or call `box.makeEmpty()` when no content
- Set `_boundsCacheDirty = false` after computing

**Important**: callers must NOT mutate the returned `Box3`. The cache returns the same object reference. `GridVirtualizer` stores `entry.bounds = grid.getBounds()` — this is safe because the virtualizer only reads from `entry.bounds` within its `update()` pass, and the object is updated in-place before each use via `refreshBoundsAll()`.

---

## Performance impact

| Function | Before | After |
|---|---|---|
| `GlyphRenderer.getStats()` | O(n) loop over all text entries | O(1) |
| `GlyphRenderer.getGlyphCount()` | (new — replaces getStats call) | O(1) |
| `GlyphCollection.getGlyphCount()` | O(n) via getStats chain | O(1) |
| `GlyphCollection.getStats()` | O(n) via getStats chain | O(1) |
| `CodeGrid.getBounds()` | `new THREE.Box3()` + `applyMatrix4` every call | O(1) when clean; reuses allocation when dirty |

For a scene with 1500 grids, each with ~200 text entries, the old `getStats()`/`getGlyphCount()` pattern cost O(200) per call. Callers like the HUD update and layout managers iterate all 1500 grids — old cost: 300,000 iterations per update cycle. New cost: 1500 integer reads.

`getBounds()` improvement is most significant for layout managers that call it in nested loops (e.g., `TreemapLayoutManager.js:147-148` calls it twice per sort comparison).

---

## Conflicts with other agents

No conflicts detected. The Stats agent (phase0-Stats.md) is throttling `updateStats()` which calls `getStats()`. Our change makes `getStats()` itself O(1), so the throttled calls are now even cheaper. These two fixes are additive.

---

## Files modified

- `/home/user/dev/glyph3d-js/src/GlyphRenderer.js`
- `/home/user/dev/glyph3d-js/src/collections/GlyphCollection.js`
- `/home/user/dev/glyph3d-js/src/collections/CodeGrid.js`
