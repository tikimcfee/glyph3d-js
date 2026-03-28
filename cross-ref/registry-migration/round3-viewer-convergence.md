# Round 3: Viewer Agent Convergence

## Settled

### 1. Phase 0 keeps `viewer.grids` as a live array
All three agents converge: the cached getter is premature for Phase 0. The registry operates as a parallel index alongside the existing array. No `_onChange` hook needed yet. The cached getter moves to Phase 1, gated on eliminating all direct `this.grids.push()` and `this.grids = ...` mutations.

### 2. `resolveGridByIdOrIndex` must skip registry lookup for pure-integer args
All three agents independently flagged the integer-string ambiguity as a critical issue. The fix is consensus: when `arg` matches `/^\d+$/`, treat it as a numeric index and skip registry lookup. This preserves backward compatibility (integers always mean array indices) and eliminates the entire collision class. Land this in Phase 0a before any command handler rewrites.

### 3. `removeGridById(id)` must exist before `grid.remove` is migrated
All three agents identified that `ctx.removeGrid(idx)` with `idx === -1` is a correctness bug (accesses last array element via negative index). The agreed fix: add `removeGridById(id)` to the context bag in Phase 0a. The `grid.remove` handler calls the ID-based path when resolved by registry ID, the index-based path when resolved by numeric index.

### 4. `grid.remove` idx === -1 guard
Until `removeGridById` lands, any handler passing `idx` to `ctx.removeGrid` must guard `idx >= 0`. Commands and compatibility both flagged this; viewer concurs.

### 5. Keep `const grids = ctx.getGrids()` in handlers that need the array
Commands agent proposed removing this line universally, but viewer and compatibility both noted that `grid.bounds.union` (all-grids path), `camera.focus` (substring fallback), and `grid.list` (iteration) still need the array. The resolver replaces argument resolution, not array access.

### 6. `loadDiff` migration needs explicit specification
Commands and compatibility both called this under-specified. Agreed: the migration must (1) unregister all existing grid-type entries, (2) register each diff grid with `diff:`-prefixed IDs, (3) push to the live `grids` array (since Phase 0 keeps the array as source of truth).

### 7. `camera.focus` keeps index-first lookup order in Phase 0
Compatibility correctly identified that switching to registry-first is a silent behavior change. During Phase 0, `camera.focus` stays: numeric index first, filename substring second, registry ID third. Align with `resolveGridByIdOrIndex` in Phase 1.

### 8. `grid.list` ID column width should be at least 30 chars
Commands' 20-char truncation renders most source paths unusable for copy-paste. Viewer and compatibility agree: widen to 30+ or show full path. The data payload already has the full ID; the display should be usable too.

### 9. Tour stops should store `registryId` at creation time
Viewer and compatibility both flagged that `tour.stop` stores a numeric index which goes stale on grid add/remove. The fix: store `registryId` alongside `gridIndex` in tour stop creation, resolve via `resolveGridByIdOrIndex` on playback.

### 10. `grid.create` double-registration is wasteful but non-blocking
Compatibility noted that `grid.create` calls `register()` then `addGrid()` which auto-registers again. The silent overwrite masks this. Not a Phase 0 blocker, but should be cleaned up: either `addGrid` skips registration if already registered, or `grid.create` skips the explicit `register()` call.

### 11. `clearGrids` iteration is safe but deserves a comment
`findByType('grid')` returns a fresh array, so iterating it while calling `unregister` is safe. All three agents agree. Add a one-line comment noting the fresh-array guarantee so future readers don't flag it as a concurrent-modification bug.

---

## Implementation Plan

### Phase 0a: Resolver Foundation (no viewer changes)
1. **Guard `resolveGridByIdOrIndex`**: Add `if (/^\d+$/.test(arg))` check to skip registry lookup for pure-integer strings. Land in `spatialHelpers.js`.
2. **Add `removeGridById(id)`** to the context bag in `websocket/index.js`. It looks up the registry entry, disposes the grid, removes from `viewer.grids` array, and calls `registry.unregister(id)`.
3. **Swap all `resolveGrid` calls to `resolveGridByIdOrIndex`** across the 7 command files. Keep `const grids = ctx.getGrids()` in handlers that need the full array (`grid.bounds.union`, `camera.focus`, `grid.list`).
4. **Fix `grid.remove`**: Use `removeGridById` when resolved by registry ID; guard `idx >= 0` for index path.
5. **Fix `spatialCommands.js` call-site count**: 8 call sites, not 6 or 7. Migrate all 8.

### Phase 0b: `grid.list` enrichment
1. **Widen registry ID column** to 30 chars minimum in display output.
2. **Add `registryId` to all command response `data` payloads** where grid resolution occurs.

### Phase 0c: AgentWindowManager migration
1. Switch from parsed `grid #(\d+)` pattern to `result.data.registryId`.
2. Depends on 0a (resolver) + 0b (enriched responses).

### Phase 0d: Viewer-side registration
1. **Register grids created by `loadRepo`**: After `this.grids.push(grid)`, also `registry.register(id, grid, 'grid')`.
2. **Specify `loadDiff` migration**: Clear existing grid-type entries from registry, register diff grids with `diff:` prefix, push to live array.
3. **Add comment to `clearGrids`** noting `findByType` returns a fresh array.
4. **Add `console.warn` on registry overwrites** where the grid object differs.
5. **Show `(unregistered)` label** (not `(none)`) for grids not yet in registry during transition.

### Phase 0e: Tour stabilization
1. **Store `registryId` in tour stops** at `tour.stop` creation time.
2. **Resolve via `resolveGridByIdOrIndex`** on `tour.play` playback.

### Phase 1 (future, not Phase 0)
- Cached `get grids()` getter backed by registry with `_onChange` hook
- Eliminate all direct `this.grids.push()` / `this.grids = ...` mutations
- Align `camera.focus` to registry-first lookup order
- Clean up `grid.create` double-registration
- `_registry.unregisterAll('grid')` batch operation for `clearGrids`

---

## Implementer Vote

**Compatibility agent** should implement this.

Rationale: The core changes in Phase 0a are in the resolver (`spatialHelpers.js`), context bag (`websocket/index.js`), and the command files -- all of which fall squarely in the compatibility agent's domain of ensuring backward-compatible transitions. The compatibility agent demonstrated the most precise understanding of the lookup-order semantics, the `idx === -1` bug surface, and the phasing dependencies. The viewer-side changes (Phase 0d) are small and well-specified enough to be executed by any agent, but getting the resolver guard and `removeGridById` right on the first pass is critical, and the compatibility agent's Round 1 analysis shows the deepest understanding of those code paths.
