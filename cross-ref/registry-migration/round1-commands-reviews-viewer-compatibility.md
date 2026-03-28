# Round 1: Commands Agent Reviews Viewer & Compatibility

## Errors Found

### Viewer: `clearGrids` iterates and mutates the same collection

The proposed `clearGrids` (viewer, line 99-106) calls `this._registry.unregister(entry.id)` inside a `for...of` loop over `this._registry.findByType('grid')`. Since `findByType` returns a fresh array (SceneRegistry line 89-95), this is actually safe -- but the prose says "no more `this.grids = []`" without accounting for the fact that `_gridsCacheDirty` must be set **once** after the loop, not on every `unregister` call. If the `_onChange` hook fires per-unregister, the cache rebuilds N times during teardown. Minor perf issue, not a correctness bug, but worth batching (e.g., `_registry.unregisterAll('grid')` or suppress onChange during bulk ops).

### Viewer: `loadDiff` migration is under-specified

The proposal says "the diff controller registers each grid with `diff:` prefixed IDs" but gives no code. The current `this.grids = result.grids` is a **full replacement** -- it clears old grids and sets new ones. The migration must (1) unregister all existing grids, (2) register diff grids. Without explicit code, this is the most likely site for a missed unregister, leaving ghost entries in the registry.

### Compatibility: Phase 0c depends on more than 0b

Compatibility's dependency chain says Phase 0c (AgentWindowManager IDs) depends on 0b (grid.list enrichment). But it also depends on Phase 0a (commands accepting registry IDs via `resolveGridByIdOrIndex`). If AgentWindowManager sends `grid.position agent:protocol 100 0 0` but `grid.position` still does inline `parseInt`, the command fails. The dependency should be `0a + 0b -> 0c`.

---

## Gaps

### Neither agent addresses the numeric-ID shadowing bug in `resolveGridByIdOrIndex`

This is the critical gap. `resolveGridByIdOrIndex` tries the registry **first** (line 48), then falls back to numeric index (line 57). If a registry ID happens to be a string that parses as an integer -- e.g., `"3"` -- the registry lookup wins and the numeric index is never tried.

Concrete scenario: a user runs `grid.create` and the auto-generated ID is `"3"` (perhaps from a filename like `3` or a short hash). Now `grid.info 3` resolves to the registry entry for ID `"3"`, **not** grid index 3. The user sees the wrong grid. Worse, if ID `"3"` maps to grid index 7, `grid.remove 3` removes the wrong grid.

The fix is straightforward: registry IDs should be validated at registration time to reject pure-integer strings, or `resolveGridByIdOrIndex` should try numeric index first when the arg is a pure integer (`/^\d+$/.test(arg)`), with registry lookup as the fallback for non-numeric strings. The second approach preserves backward compat for index-based workflows.

### Viewer: no mention of `getIdByGrid` returning null for unregistered grids

The `grid.list` proposal (commands, line 38) calls `ctx.registry.getIdByGrid(g)`. During Phase 0, grids loaded before the command center initializes are unregistered (compatibility acknowledges this in edge case section 5.2). The `grid.list` code handles this with `|| ''`, which is fine. But `grid.info` (commands, line 78) uses `resolved.registryId` which comes from `resolveGridByIdOrIndex` line 62 -- this correctly returns `null` for unregistered grids. The display code uses `registryId || '(none)'`. Consistent, but neither agent explicitly calls out that Phase 0 will show `(none)` for all repo-loaded grids until Phase 0d runs. Users may be confused.

### Viewer: `focusOnGridById` error handling is silent

The proposed `focusOnGridById` (viewer, line 130-134) silently returns if the entry is not found. No error, no console warning. All other resolution paths return `{ error: '...' }` strings. This inconsistency means the tree panel click on a removed grid silently does nothing -- no feedback to the user.

### Compatibility: no mention of `camera.focus` triple-fallback

The commands plan (section 3) proposes a three-step fallback for `camera.focus`: registry ID, then numeric index, then filename substring. The compatibility agent does not analyze whether the filename substring search can conflict with registry IDs. For example, if a user types `camera.focus index` intending the substring match against `index.js`, but a registry entry with ID `"index"` exists, the registry match wins. This is probably correct behavior, but it is a semantic change from the current code which only does index + substring.

---

## Tensions

### Live array vs. cached getter -- timing disagreement

Compatibility (section 1) explicitly recommends keeping the live `viewer.grids` array during Phase 0 and deferring the cached getter. Viewer proposes the cached getter as part of its core migration design (viewer, line 53-60). These are contradictory. If the cached getter ships in Phase 0, the compatibility analysis about "live array consistency" is moot. If the live array stays, the viewer's `clearGrids` migration that relies on cache invalidation does not work.

**Resolution**: Compatibility's phasing is more conservative and correct. The cached getter should be Phase 1, not Phase 0. Phase 0 keeps the live array; commands and context bag funnel mutations through the registry as a side-channel; the array remains the source of truth for iteration.

### `removeGrid` by index vs. by ID

Commands (section 2d) proposes `ctx.removeGrid(idx)` (by index). Viewer (section 7, line 246-253) proposes `registry.unregister(id)` (by ID) in the WS context bag. Compatibility (section 5.1) notes that `idx` can be -1 for registry-only objects. If `grid.remove` resolves by registry ID and gets `idx: -1`, then `ctx.removeGrid(-1)` will fail or corrupt the array.

**Resolution**: `grid.remove` should call `ctx.removeGrid` with the resolved grid object or registry ID, not the index. The context bag's `removeGrid` needs an ID-based overload as viewer proposes.

---

## Recommendations

1. **Fix the numeric-ID shadowing in `resolveGridByIdOrIndex` before shipping any command rewrites.** Add a guard: if `arg` matches `/^\d+$/`, try numeric index first, registry second. This preserves backward compat and prevents the shadowing bug. Alternatively, enforce a naming convention (e.g., registry IDs must contain at least one non-digit character) at registration time.

2. **Align on Phase 0 = live array.** Do not ship the cached getter in Phase 0. Keep `viewer.grids` as a plain array. Registry is a parallel index, not the source of truth yet. This matches compatibility's recommendation and avoids the cache-invalidation complexity.

3. **Specify `loadDiff` migration explicitly.** The viewer plan hand-waves this. Write the actual code: clear existing grids from registry, register diff grids with `diff:` prefix, ensure `clearGrids` is called before diff load.

4. **Make `removeGrid` accept ID or index.** The context bag `removeGrid` should resolve via `resolveGridByIdOrIndex` internally, same as commands do. This eliminates the idx=-1 bug.

5. **Add a `console.warn` on registry overwrites** where the grid object differs (compatibility mentions this in section 5.3 -- promote it to a concrete action item).

6. **Show `(unregistered)` instead of `(none)`** for grids not yet in the registry during the Phase 0 transition. Makes it clearer that this is a temporary state, not a permanent property of the grid.

---

## Key Insight

The numeric-ID shadowing bug is a latent correctness issue that neither the viewer nor compatibility plans catch. Because `resolveGridByIdOrIndex` checks the registry before trying numeric parse, any registry ID that looks like an integer silently hijacks index-based lookups. This is not hypothetical -- auto-generated IDs from short filenames (e.g., a file literally named `3` or `42`) or hash truncations will trigger it. The fix must land before the command rewrites, because once all commands route through `resolveGridByIdOrIndex`, the bug surface area expands from zero call sites to 20+. The simplest fix: if the argument is a pure digit string, prefer numeric index; require registry IDs to contain at least one non-digit character.
