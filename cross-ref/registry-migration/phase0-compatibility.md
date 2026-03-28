# Phase 0: Backward Compatibility Layer for Registry Migration

## Agent: compatibility
## Focus: Numeric index stability, transition strategy, edge cases

---

## 1. `getGrids()` Semantics

**Current**: `getGrids: () => viewer.grids` returns a live array reference. Every call returns the same object.

**Recommendation: Keep the live array during migration; deprecate later.**

Three options considered:

| Option | Perf | Consistency | Migration cost |
|--------|------|-------------|----------------|
| Live array (current) | Best -- zero alloc | Mutates under you | None |
| Cached snapshot from registry | O(n) per call | Stable within frame | Medium |
| Proxy wrapping registry | Moderate overhead | Best | High |

Layout managers (`hierarchicalManager.layoutHierarchy(this.grids)`, `spiralManager.layoutSpiral(this.grids)`, etc. -- see GitHubRepoViewer.js lines 699-731) iterate the array synchronously in a single frame. They never interleave mutations with reads, so live-array consistency is fine.

**Decision**: Keep `getGrids()` returning the live `viewer.grids` array throughout Phase 0. The array becomes a *derived view* of the registry only in a later phase, once all direct `viewer.grids.push()` / `splice()` calls are eliminated.

---

## 2. Numeric Index Stability

### The problem

Indices into `viewer.grids` are **positional and unstable**. Any `splice()` (via `removeGrid`) shifts all subsequent indices. This is already a known bug: `AgentWindowManager._refreshIndices()` (line 470) exists specifically because indices drift after removals.

### Current consumers of numeric indices

1. **gridCommands.js** -- `grid.info`, `grid.color`, `grid.visibility`, `grid.remove`, `grid.text`, `grid.position`, `grid.scale` all do `parseInt(args[0])` then index into `grids[]`
2. **spatialCommands.js** -- `grid.bounds`, `grid.boundsmulti`, `grid.distance`, `grid.overlap` use `resolveGrid(grids, arg)`
3. **compositionCommands.js** -- `grid.anchor`, `grid.align`, `grid.distribute` use `resolveGrid(grids, arg)`
4. **navigationCommands.js** -- `camera.focus`, `camera.fitmulti`, `camera.tour` use `resolveGrid(grids, arg)`
5. **AgentWindowManager.mjs** (CLI side) -- stores `gridIndex` per label, uses it in `grid.position <idx>`, `grid.color <idx>`, `grid.remove <idx>`
6. **glyph-cli.mjs** -- passes through user-typed indices verbatim; no special handling

### Recommendation: Indices are display-order aliases, IDs are canonical

Indices remain valid as a convenience (users type `grid.info 42`) but are explicitly **display-order aliases** -- their meaning is "row 42 in the most recent `grid.list` output." They are not stable across mutations.

Registry string IDs become the canonical, stable reference. The existing `resolveGridByIdOrIndex` already implements the right precedence:
1. Try registry ID lookup (string match)
2. Fall back to numeric index into `getGrids()`

This means **no behavior change** for users who already use numeric indices -- they keep working exactly as before. But scripts that need stability across add/remove operations should switch to registry IDs.

---

## 3. The AgentWindowManager Problem

### Current fragility

`AgentWindowManager` (lines 86-93, 470-484):
- Parses `grid #(\d+)` from `grid.create` response text to get initial index
- Calls `_refreshIndices()` which parses `grid.list` data, matching `agent:` prefix in filenames
- Stores `label -> index` in `_indexMap`
- Every command uses the stored index: `grid.position ${index} ...`

This is fragile because:
- Any `grid.remove` by another consumer shifts indices silently
- `_refreshIndices()` must be called before every batch of operations that follows a removal
- The name-matching heuristic (`name.startsWith('agent:')`) breaks if naming conventions change

### Fix: grid.create returns registryId; AgentWindowManager uses IDs

**Step 1**: `grid.create` response already includes `registryId` in its data payload (gridCommands.js line 153). The CLI just needs to use `result.data.registryId` instead of parsing `grid #(\d+)`.

**Step 2**: Commands accept registry IDs (via `resolveGridByIdOrIndex`). So `grid.position agent:protocol 100 0 0` works once commands are migrated.

**Step 3**: `AgentWindowManager._indexMap` becomes `_idMap: Map<string, string>` (label -> registryId). All commands use the ID instead of a numeric index.

**Step 4**: `_refreshIndices()` becomes unnecessary and can be removed.

This is the single highest-value change in the migration because it eliminates the entire class of index-drift bugs.

---

## 4. Migration Order (Dependency Chain)

### Phase 0a: Make `resolveGridByIdOrIndex` the standard resolver

**Files changed**: All command files that import `resolveGrid`
**Risk**: Zero -- `resolveGridByIdOrIndex` falls back to numeric index, so existing behavior is preserved

1. `spatialCommands.js` -- 6 call sites, replace `resolveGrid(grids, arg)` with `resolveGridByIdOrIndex(ctx, arg)`
2. `compositionCommands.js` -- 5 call sites, same pattern
3. `navigationCommands.js` -- 4 call sites, same pattern
4. `gridCommands.js` -- 8 commands with inline `parseInt` + bounds check, wrap each in `resolveGridByIdOrIndex`

**This can be done incrementally.** Each command file is independent. Mixed state (some commands use old resolver, some use new) is safe because both accept numeric indices.

### Phase 0b: Enrich `grid.list` output with registry IDs

**Files changed**: `gridCommands.js` (grid.list handler only)
**Risk**: Low -- additive change to output format

Add `registryId` column to the table output and the data payload. The `#` column (numeric index) stays for human readability. Example output:

```
#   id                  filename        glyphs  lines  position
0   src/index.js        index.js        1240    45     0,0,0
1   agent:protocol      agent:protocol  890     32     120,0,0
```

### Phase 0c: Update AgentWindowManager to use registry IDs

**Files changed**: `AgentWindowManager.mjs`, `AgentWindow.mjs`
**Risk**: Medium -- this changes the CLI-side protocol

- `createWindow`: capture `result.data.registryId` instead of parsing `grid #(\d+)`
- `_positionByLabel`, `_colorByLabel`: use registryId instead of index
- `ensureWindow`: match on `registryId` in grid.list data instead of filename prefix
- Remove `_refreshIndices()` entirely
- Remove `_indexMap`, replace with `_idMap`

### Phase 0d: Auto-register existing grids at repo load time

**Files changed**: `GitHubRepoViewer.js` (the `_createGrid` / push path around line 888)
**Risk**: Low -- `addGrid()` in the context bag already auto-registers

Currently, grids created during repo loading go through `this.grids.push(grid)` (line 888) which bypasses the context bag's `addGrid()`. These grids are never registered. Two options:
- Route all grid creation through `ctx.addGrid()` (requires context to exist at load time)
- Add a registration pass after loading completes: iterate `this.grids`, register any unregistered

The second option is safer for Phase 0 since it doesn't restructure the loading pipeline.

### Dependency chain summary

```
0a (resolveGridByIdOrIndex) -- independent, do first
        |
0b (grid.list enrichment) -- independent of 0a, can parallel
        |
0c (AgentWindowManager IDs) -- depends on 0b (needs registryId in responses)
        |
0d (auto-register at load) -- independent, but most useful after 0a-0c
```

---

## 5. Edge Cases

### Grids in registry but not in `viewer.grids`

`resolveGridByIdOrIndex` already handles this (line 52): when a registry entry's grid is not in the array, `idx` is -1. Commands that need the index (e.g., `removeGrid(idx)`) must guard against this. Currently `removeGrid` takes an index -- it needs an ID-based overload.

### Grids in `viewer.grids` but not in registry

During Phase 0, grids loaded before the command center initializes are not registered. `resolveGridByIdOrIndex` falls back to numeric index for these, so they remain accessible. Phase 0d closes this gap.

### Duplicate registry IDs

`SceneRegistry.register()` silently overwrites (line 41-45). This is correct for re-registration (e.g., hot-reload) but dangerous if two different grids collide on ID. The auto-ID generation in `addGrid()` uses `sourcePath || filename || timestamp-random`, which should be unique in practice. Worth adding a console.warn on overwrites where the grid object differs.

### `removeGrid` index shift during batch operations

If a command removes grid 5 and then tries to remove grid 8, the second removal actually removes what was grid 9. This bug exists today and is unrelated to the registry migration, but the migration fixes it: once commands use registry IDs, removal by ID is position-independent.

### Layout managers receiving stale array

Layout managers receive `this.grids` by reference and iterate synchronously. No issue during Phase 0. In a future phase where `getGrids()` returns a snapshot, layout managers would get a consistent view automatically, which is actually better.

---

## 6. Testing Strategy (No Test Runner)

### Critical path scenarios

1. **Basic grid.list + grid.info round-trip**: Load a repo, run `grid.list`, pick an index, run `grid.info <idx>`. Verify output matches. Then use the registry ID shown in grid.list and run `grid.info <registryId>`. Both should return identical data.

2. **Index stability after removal**: Load repo, note grid count. Run `grid.remove <middle-index>`. Run `grid.list` again. Verify indices are renumbered 0..N-1. Verify registry IDs are unchanged for surviving grids.

3. **AgentWindowManager lifecycle**: Run the cross-ref skill (which creates multiple agent windows). Verify windows are created, positioned, colored, and removed without index-drift errors. Check that `_refreshIndices()` calls (or their replacement) work.

4. **Mixed ID/index usage**: In the REPL, alternate between `grid.info 0` and `grid.info src/index.js`. Both should resolve correctly.

5. **Layout after mutation**: Load repo, remove a grid, then trigger a layout change (e.g., switch from hierarchical to spiral). Layout manager should handle the shorter array without errors.

### How to execute

- Open `http://localhost:8000/examples/github-viewer/` with a repo loaded
- Open browser devtools console for `window.viewer` API access
- Open a second terminal with `node glyph-cli.mjs` for WebSocket commands
- Run each scenario above, checking console for errors and visual output for correctness

### Regression signal

The key regression signal is: **any command that previously accepted a numeric index should still accept that same numeric index and produce the same result, provided no grids were added or removed between the two invocations.** This is the backward-compat invariant.

---

## Summary

The migration is safe to do incrementally. The critical insight is that `resolveGridByIdOrIndex` already exists and implements the right fallback chain. Phase 0 is primarily about **adopting it everywhere** and **enriching outputs with registry IDs** so that callers can gradually shift from fragile indices to stable IDs. No big-bang cutover required.

The highest-value single change is Phase 0c (AgentWindowManager using IDs) because it eliminates the `_refreshIndices` workaround and the entire class of index-drift bugs that have already caused issues in practice.
