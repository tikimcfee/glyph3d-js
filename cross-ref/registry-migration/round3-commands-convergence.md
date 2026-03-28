# Round 3: commands convergence

## Settled

1. **Integer-first resolution in `resolveGridByIdOrIndex`**: All three agents converged on this. If the argument matches `/^\d+$/`, treat it as a numeric index; skip the registry lookup. This preserves backward compatibility and eliminates the integer-string shadowing bug. Concrete fix: guard the registry branch with `if (ctx.registry && isNaN(parseInt(arg)))`. This lands in Phase 0a as the very first change.

2. **Phase 0 keeps the live `viewer.grids` array**: All three agents agree. The cached getter backed by `_onChange` is sound design but premature -- it requires eliminating every direct `this.grids.push()` and `this.grids = ...` mutation first. Registry is a parallel index in Phase 0, not the source of truth. The getter moves to Phase 1.

3. **Add `removeGridById(id)` to the context bag in Phase 0a**: All agents identified the `idx === -1` bug in `grid.remove` when resolving by registry ID. The fix is a new `removeGridById(id)` method on the context bag that does: registry lookup, scene removal, dispose, unregister -- without touching the index-based splice path. This must exist before any command handler resolves by registry ID.

4. **Keep `const grids = ctx.getGrids()` in handlers that need it**: The commands Phase 0 proposal to remove the local `grids` variable was premature. `grid.bounds.union` (all-grids path), `camera.focus` (substring fallback), and `grid.list` (iteration) all still need the array. `resolveGridByIdOrIndex` replaces only the argument-resolution step, not all array access.

5. **`camera.focus` keeps index-first lookup order in Phase 0**: The current code tries numeric index, then filename substring. Adding registry-first would be a silent behavior change. In Phase 0, registry lookup is added as a third fallback (after substring). Phase 1 aligns it with `resolveGridByIdOrIndex` once registry IDs are fully established.

6. **Fix `grid.list` ID column width to 30+ chars**: All agents noted that 20-char truncation makes IDs unusable for copy-paste. Widen to 35 chars or show full ID. The `data` payload already has the full value, but human REPL users need the display to be functional.

7. **Fix `grid.create` double-registration**: `grid.create` currently calls `ctx.registry.register()` then `ctx.addGrid()` which auto-registers again. Remove the explicit `register()` call; let `addGrid` handle it. Or guard `addGrid` to skip registration if already registered.

8. **`loadDiff` migration must be explicitly specified**: Both commands and compatibility flagged this as under-specified. The concrete steps: (a) call `clearGrids()` to unregister all existing grid entries, (b) register each diff grid with `diff:` prefixed ID via `addGrid`, (c) do not assign to `this.grids` directly.

9. **Store `registryId` in tour stops at creation time**: `tour.stop` currently stores `gridIndex` (numeric). This is fragile across grid add/remove. Store `registryId` alongside `gridIndex` so `tour.play` can resolve stably. Backward-compatible: if `registryId` is present, use it; otherwise fall back to `gridIndex`.

10. **`spatialCommands.js` has 8 `resolveGrid` call sites, not 6 or 7**: Viewer agent's count is authoritative. The migration checklist must include the `grid.bounds.union` loop call at line 71.

## Implementation Plan

### File: `src/commands/spatialHelpers.js`
- **`resolveGridByIdOrIndex`**: Add integer-detection guard. If `arg` matches `/^\d+$/`, skip registry lookup, go straight to numeric index resolution. Registry lookup only for non-numeric strings.
- No other changes to the function signature or return shape.

### File: `src/commands/websocket/index.js` (context bag)
- **Add `removeGridById(id)`**: New method that takes a string registry ID, looks up the entry, removes the grid from the scene, calls dispose, removes from `viewer.grids` array by reference (not index), and unregisters from the registry.
- **Keep `removeGrid(index)`** unchanged for backward compat.

### File: `src/commands/gridCommands.js`
- **All handlers**: Replace `resolveGrid(ctx, arg)` with `resolveGridByIdOrIndex(ctx, arg)`. Keep `const grids = ctx.getGrids()` where needed.
- **`grid.remove`**: After resolving, check if `resolved.idx >= 0`. If yes, use `ctx.removeGrid(idx)`. If no (idx === -1), use `ctx.removeGridById(resolved.registryId)`.
- **`grid.create`**: Remove the explicit `ctx.registry.register()` call; rely on `ctx.addGrid()` auto-registration.
- **`grid.list`**: Widen registry ID column to 35 chars.

### File: `src/commands/spatialCommands.js`
- **All 8 call sites**: Replace `resolveGrid` with `resolveGridByIdOrIndex`. Include the loop call at line 71.
- Keep `const grids = ctx.getGrids()` for the `grid.bounds.union` all-grids path.

### File: `src/commands/cameraCommands.js`
- **`camera.focus`**: Keep current order (numeric index first, substring second). Add registry ID lookup as third fallback only. Do NOT use `resolveGridByIdOrIndex` here in Phase 0 -- the lookup order differs intentionally.

### File: `src/commands/tourCommands.js`
- **`tour.stop`**: Store `registryId` (from `ctx.registry.getIdByGrid(grid)`) alongside `gridIndex` in the stop object.
- **`tour.play`**: Use `resolveGridByIdOrIndex(ctx, stop.registryId || String(stop.gridIndex))` for re-validation.

### File: `src/commands/animationCommands.js`
- Replace `resolveGrid` with `resolveGridByIdOrIndex`. Straightforward swap, no special cases.

### Files NOT changed in Phase 0:
- `GitHubViewer.js` -- no changes to `this.grids` storage, `loadDiff`, or `loadRepo`. These are Phase 1.
- `SceneRegistry.js` -- no `_onChange` hook added. That is Phase 1 prerequisite for the cached getter.

### Migration order:
1. `spatialHelpers.js` (integer guard) -- unblocks everything
2. `websocket/index.js` (add `removeGridById`) -- unblocks `grid.remove`
3. Command files in any order: `gridCommands.js`, `spatialCommands.js`, `cameraCommands.js`, `tourCommands.js`, `animationCommands.js`

## Implementer Vote

**Compatibility** should implement. Their Phase 0 output defined the phasing strategy and dependency chain that all three agents converged on. The implementation is fundamentally a compatibility exercise: swap resolvers, add guards, preserve backward compat. Compatibility's perspective -- incremental migration without breaking existing behavior -- is exactly the lens needed for this work. The commands agent (me) defined what the commands should look like; the viewer agent defined the viewer-side target state; but the actual Phase 0 implementation is about threading the needle between old and new, which is compatibility's domain.
