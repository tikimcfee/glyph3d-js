# Round 1: Viewer Reviews Commands & Compatibility

## Errors Found

### Commands: call-site count for spatialCommands.js is wrong
Compatibility claims 6 `resolveGrid` call sites in `spatialCommands.js` (line 91). Actual count is 8:
`grid.bounds` (1), `grid.bounds.union` loop (1), `grid.anchor` (1), `grid.distance` (2), `grid.overlap` (2), totaling 8 calls on lines 28, 71, 108, 137, 139, 174, 176 -- plus the loop call at line 71 which the commands doc omits from its diff section. The commands doc lists 7 call sites in section 5 header but only shows 6 in the diff block (`grid.bounds.union` shows one `resolveGrid` call but the actual loop at line 71 calls it per-arg).

### Commands: `grid.remove` still calls `ctx.removeGrid(idx)` by index
The commands doc's rewritten `grid.remove` (section 2d) resolves the grid via `resolveGridByIdOrIndex` but then passes `idx` to `ctx.removeGrid(idx)`. When the grid was resolved by registry ID and is not in the `viewer.grids` array, `idx` is -1 (as compatibility notes on line 151). The rewritten handler does not guard against `idx === -1`. This would cause `removeGrid(-1)` to silently fail or return null.

### Commands: "Remove `const grids = ctx.getGrids()`" advice is premature
Section 4 says to remove the `const grids = ctx.getGrids()` line from each handler since `resolveGridByIdOrIndex` gets grids internally. But `grid.bounds.union` still needs `grids` for the "all grids" path (when no args given, it unions all grid bounds). The commands doc acknowledges this parenthetically but doesn't show the fix. Same issue for `camera.focus` (section 3) which uses `grids.findIndex` for the substring-match fallback on line 210.

### Compatibility: `grid.create` registryId in data payload (line 72)
Compatibility says `grid.create` response "already includes `registryId` in its data payload (gridCommands.js line 153)." This is correct -- verified at actual line 152. Minor line-number discrepancy (153 vs 152), but the claim holds.

---

## Gaps

### No `removeGrid(id)` overload specified
Both docs acknowledge that `removeGrid` in the context bag (`websocket/index.js` line 55) takes a numeric index. Compatibility identifies the need for an ID-based overload (line 151-152) but neither doc specifies the implementation. Since commands' `grid.remove` delegates to `ctx.removeGrid(idx)`, this is a blocking gap for the registry-by-ID removal path. One of two things needs to happen:
1. `grid.remove` handler does the disposal + scene removal + unregister itself (bypassing `ctx.removeGrid`), or
2. `ctx.removeGrid` gains an ID-based overload.

### No `_onChange` hook exists on SceneRegistry today
My viewer doc proposes adding `_onChange` to SceneRegistry for cache invalidation. The actual `SceneRegistry.js` has no such hook. The commands doc and compatibility doc both assume the registry exists as-is and don't mention this gap. If we proceed with the cached-getter approach later, this hook needs adding. For Phase 0, this is not blocking since both other agents recommend keeping the live array.

### Tour stops store `gridIndex` -- no migration to registry ID
Commands doc section 6 rewrites `tour.play` to call `resolveGridByIdOrIndex(ctx, String(stop.gridIndex))`. This works for numeric indices but tour stops are persisted objects -- if we want tours to survive grid add/remove, they need a `registryId` field. Neither doc addresses enriching the tour data model.

### `grid.list` truncates registry IDs at 20 chars
Commands doc truncates registry IDs to 20 chars in the table display (line 43). Source paths like `src/collections/HierarchicalLayoutManager.js` are 46 chars. The truncated ID in the display will not be copy-pasteable for use in commands. The data payload has the full ID, so programmatic consumers are fine, but human REPL users lose the ability to copy IDs from `grid.list` output.

---

## Tensions

### Cached getter (viewer) vs. live array (compatibility)
My viewer doc proposes replacing `this.grids` with a cached getter backed by the registry. Compatibility explicitly recommends keeping the live array during Phase 0, deferring the getter until all direct `push`/`splice` calls are eliminated. This is the core tension.

**Assessment**: Compatibility is right for Phase 0. The cached getter requires the `_onChange` hook, introduces a new cache-invalidation bug surface, and gains us nothing until *all* mutation paths go through the registry. Currently, `loadRepo` (line 888) does `this.grids.push(grid)` outside the context bag, and `loadDiff` does `this.grids = result.grids`. Both would need rewiring before a getter could be the sole interface. The commands migration (Phase 0a) is independent of this choice -- it only touches command handlers, not the viewer's grid storage.

### "Remove `const grids = ctx.getGrids()`" (commands) vs. handlers that still need it
Commands doc repeatedly advises removing the `grids` local variable. But several handlers still need the array for fallback paths (substring search, union-all, grid.list iteration). The cleaner approach is to keep the local variable and use `resolveGridByIdOrIndex` only for the argument-resolution step, not as a replacement for all array access.

### Incremental vs. atomic migration
Commands doc implies all 7 files can be migrated independently ("each command file is independent"). Compatibility agrees and provides the dependency chain. But the commands doc's `grid.remove` rewrite implicitly depends on an ID-based `removeGrid` that doesn't exist yet. If `grid.remove` is migrated before `removeGrid(id)` exists, the registry-ID path silently breaks (idx=-1). Migration order matters more than either doc admits.

---

## Recommendations

1. **Do Phase 0a first, exactly as compatibility specifies**: swap `resolveGrid` to `resolveGridByIdOrIndex` in all command files. This is zero-risk and the highest-value change per line. But keep `const grids = ctx.getGrids()` in handlers that use the array beyond argument resolution.

2. **Add `removeGrid(id)` to the context bag before migrating `grid.remove`**: Either as an overload (`removeGrid(idOrIndex)` that checks `typeof`) or as a separate `removeGridById(id)` method. This unblocks the full ID path.

3. **Defer the cached getter**: Compatibility's incremental position is correct. The viewer's cached-getter design is sound but premature for Phase 0. File it as Phase 1 work, gated on eliminating all direct `this.grids.push()` / `this.grids = ...` mutations.

4. **Fix the `grid.bounds.union` loop call site**: The commands doc misses the per-arg loop at spatialCommands.js line 71. Add it to the migration checklist.

5. **Guard `idx === -1` in any handler that passes idx to index-based APIs**: Until `removeGrid(id)` exists, the `grid.remove` handler must check `resolved.idx >= 0` before calling `ctx.removeGrid`.

---

## Key Insight

The three documents converge on the same fundamental point: `resolveGridByIdOrIndex` already exists, works, and just needs adoption. The disagreements are about how far to push the registry as source of truth *in Phase 0*. The answer is: adopt the resolver everywhere (cheap, safe), but don't restructure the viewer's grid storage yet. The highest-impact single change is not in the viewer at all -- it is in `AgentWindowManager` switching from parsed `grid #(\d+)` to `result.data.registryId`, because that eliminates a real bug class (`_refreshIndices` drift) that has already caused issues. Everything else is incremental improvement on an already-working system.
