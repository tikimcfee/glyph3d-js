# Round 3: Compatibility Convergence

## Settled

All three agents agree on the following points with no remaining tension:

### 1. `resolveGridByIdOrIndex` adoption is Phase 0a, zero-risk
All agents confirm that swapping `resolveGrid` to `resolveGridByIdOrIndex` across command files is safe because the fallback to numeric index preserves existing behavior. Each command file is independently migratable. No disagreement.

### 2. Keep live `viewer.grids` array during Phase 0; defer cached getter to Phase 1
Commands assumed the live array. Viewer proposed the cached getter. All three reviews independently concluded the cached getter is premature: it requires an `_onChange` hook that does not exist, introduces cache-invalidation bugs, and gains nothing until all direct `push`/`splice` mutations are eliminated. Settled: Phase 0 keeps the live array as source of truth.

### 3. `removeGrid` needs an ID-based path before `grid.remove` is migrated
All three agents identified that `ctx.removeGrid(idx)` with `idx === -1` is a correctness bug (accesses last array element via negative indexing). Commands and viewer both flagged it; compatibility confirmed. Settled: add `removeGridById(id)` to the context bag in Phase 0a, before any command handler is rewritten to resolve by registry ID.

### 4. Integer-string ambiguity in `resolveGridByIdOrIndex` must be fixed in Phase 0a
Commands identified the shadowing bug (registry ID `"3"` hijacks index lookup). Compatibility proposed the guard (`isNaN(parseInt(arg))` skips registry for pure-integer args). Viewer agreed this is the highest-impact single fix. Settled: when the argument is a pure non-negative integer string (`/^\d+$/`), prefer numeric index; skip registry lookup. Registry IDs containing at least one non-digit character are looked up normally.

### 5. AgentWindowManager migration to registry IDs is highest-value change
All agents agree Phase 0c (switching from parsed `grid #(\d+)` to `result.data.registryId`) eliminates the entire `_refreshIndices` workaround and the index-drift bug class. No disagreement on approach or ordering.

### 6. `grid.list` must show usable registry IDs
Commands proposed 20-char truncation; both viewer and compatibility flagged this as defeating the purpose (users cannot copy-paste truncated IDs into commands). Settled: widen to at least 30 chars or show full ID in the text output; the `data` payload always contains the full ID regardless.

### 7. `loadDiff` migration needs explicit code
Commands and compatibility both flagged this as under-specified in the viewer plan. Settled: the migration must (1) unregister all existing grid-type entries, (2) register each diff grid with `diff:` prefix, (3) be written out as actual code, not prose.

### 8. `camera.focus` lookup order stays index-first during Phase 0
Compatibility identified that the commands proposal silently reverses the lookup order (registry-first vs current index-first). All reviews agree: keep current behavior (index, then substring) during Phase 0; add registry as a third fallback. Align with registry-first only in Phase 1.

### 9. Tour stops should store `registryId` at creation time
Viewer and compatibility both identified that `tour.stop` stores numeric `gridIndex` which is stale after mutations. Settled: store `registryId` alongside `gridIndex` in tour stops; `tour.play` resolves via `resolveGridByIdOrIndex` using the stored ID with index as fallback.

### 10. `grid.create` double-registers (minor cleanup)
Compatibility noted `grid.create` calls `register()` then `addGrid()` which auto-registers again. The silent overwrite makes this harmless but wasteful. Settled: remove the explicit `register()` call since `addGrid()` handles it; or skip auto-register in `addGrid()` when already registered. Low priority but include in Phase 0a cleanup.

---

## Implementation Plan

### Phase 0a: Foundation (no behavior changes, all additive)

**Files**: `spatialHelpers.js`, `websocket/index.js`, all command files

1. **Fix integer-string ambiguity** in `resolveGridByIdOrIndex` (spatialHelpers.js ~line 46):
   - Guard: if `arg` matches `/^\d+$/`, skip registry lookup, go straight to numeric index
   - This is a one-line change that eliminates the entire ambiguity class

2. **Add `removeGridById(id)` to context bag** (websocket/index.js):
   - Looks up registry entry by ID, calls dispose/scene-removal/unregister
   - Does NOT go through `viewer.grids.splice()` if the grid is registry-only (idx === -1)
   - If grid IS in the array, also splices it out to keep the live array consistent

3. **Swap `resolveGrid` to `resolveGridByIdOrIndex`** in command files:
   - `spatialCommands.js` -- 8 call sites (not 6; the `grid.bounds.union` loop at line 71 was miscounted)
   - `compositionCommands.js` -- 5 call sites
   - `navigationCommands.js` -- 4 call sites
   - `gridCommands.js` -- 8 commands with inline `parseInt`, wrap in `resolveGridByIdOrIndex`
   - Keep `const grids = ctx.getGrids()` in handlers that still need the array (union-all, substring search, grid.list iteration)

4. **Guard `idx === -1`** in `grid.remove` handler: use `removeGridById(id)` when `resolved.registryId` is present and `resolved.idx === -1`

5. **Fix `grid.create` double-register**: remove explicit `ctx.registry.register()` call since `ctx.addGrid()` handles registration

### Phase 0b: Enrich outputs (additive, parallel with 0a)

**Files**: `gridCommands.js` (grid.list handler)

1. Add `registryId` column to `grid.list` table output, minimum 30 chars wide
2. Add `registryId` to the `data` payload (full, untruncated)
3. Keep `#` column for numeric index (human convenience)

### Phase 0c: AgentWindowManager migration (depends on 0a + 0b)

**Files**: `AgentWindowManager.mjs`, `AgentWindow.mjs`

1. `createWindow`: capture `result.data.registryId` instead of parsing `grid #(\d+)` from text
2. Replace `_indexMap: Map<string, number>` with `_idMap: Map<string, string>` (label -> registryId)
3. All command emissions use registry ID: `grid.position ${id} 100 0 0`
4. `ensureWindow`: match on `registryId` in grid.list data instead of filename prefix heuristic
5. Remove `_refreshIndices()` entirely

### Phase 0d: Close registration gaps (independent, best after 0a-0c)

**Files**: `GitHubRepoViewer.js`

1. After repo loading completes, iterate `viewer.grids` and register any unregistered grids
2. This is a post-load pass, not a restructure of the loading pipeline

### Phase 0e: Tour stop enrichment (independent, low priority)

**Files**: `tourCommands.js` or equivalent

1. `tour.stop` stores `registryId` alongside `gridIndex`
2. `tour.play` resolves via `resolveGridByIdOrIndex(ctx, stop.registryId || String(stop.gridIndex))`

### Phase 0f: Viewer-side migration prep (depends on 0a-0d complete)

**Files**: `GitHubRepoViewer.js`

1. Write explicit `clearGrids` implementation: iterate `findByType('grid')`, unregister each, then clear the live array
2. Write explicit `loadDiff` migration: `clearGrids()`, then register each diff grid with `diff:` prefix
3. Keep `camera.focus` as index-first, substring-second, registry-third
4. Add `console.warn` on registry overwrites where the grid object differs

### Deferred to Phase 1

- `viewer.grids` as cached getter backed by registry (requires `_onChange` hook on SceneRegistry)
- `camera.focus` switching to registry-first lookup order
- Eliminating all direct `viewer.grids.push()` / `splice()` mutations
- Layout managers receiving snapshots instead of live array reference

---

## Implementer Vote

**Commands agent** should implement this plan.

Rationale: Phase 0a is the largest and most critical chunk of work, and it lives entirely in command files and `spatialHelpers.js` -- the commands agent's home territory. The integer-ambiguity fix, `removeGridById`, and the `resolveGridByIdOrIndex` swap across all command files are all code the commands agent has already analyzed line-by-line with correct call-site counts. The viewer-side changes (Phase 0f) are minimal and mechanical once the command infrastructure is in place. The AgentWindowManager migration (Phase 0c) is CLI-side code that the commands agent interfaces with directly through the WebSocket protocol.
