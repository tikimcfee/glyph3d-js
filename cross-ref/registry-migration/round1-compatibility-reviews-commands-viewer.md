# Round 1: Compatibility Reviews Commands & Viewer

## Errors Found

### 1. commands: `camera.focus` lookup order is inverted vs current code

The commands proposal (section 3) adds registry-first lookup to `camera.focus`.
But the *current* code at `cameraCommands.js:39-47` tries numeric index FIRST,
then falls back to filename substring. The proposal reverses this to registry-first,
index-second, substring-third. This is a **silent behavior change**, not a pure
migration. A user who types `camera.focus 3` today gets array index 3; after
the proposal, if registry ID `"3"` exists, they get a different grid.

This is the same class of issue the orchestrator raised about `resolveGridByIdOrIndex`.

### 2. commands: `grid.remove` uses `ctx.removeGrid(idx)` but idx may be -1

The proposed `grid.remove` (section 2d) calls `resolveGridByIdOrIndex` which can
return `idx: -1` for registry-only objects not in the grids array. It then passes
`idx` directly to `ctx.removeGrid(idx)`. Looking at `websocket/index.js:55-67`,
`removeGrid(index)` does `viewer.grids[index]` -- passing -1 accesses the last
element of the array, silently removing the wrong grid. The proposal needs a
guard: if `idx === -1`, remove via registry unregister + dispose, not via splice.

### 3. commands: `grid.create` double-registers

`gridCommands.js:144-147` calls `ctx.registry.register(registryId, grid, ...)` then
`ctx.addGrid(grid)`. But `addGrid` (websocket/index.js:43-53) auto-registers if
not already registered. The `register()` silent-overwrite means this works today,
but it is wasteful and masks a design issue. The proposal does not address this --
it carries the double-register forward.

### 4. viewer: `clearGrids` proposal iterates-and-mutates

The proposed `clearGrids` (viewer section) iterates `findByType('grid')` and calls
`unregister(id)` inside the loop. `findByType` returns a fresh array (safe), but
this is not stated -- a reader might assume it is a live view and see a
concurrent-modification bug. Worth a one-line comment.

### 5. viewer: `loadDiff` migration is under-specified

The proposal says "the diff controller registers each grid with `diff:` prefixed IDs"
but does not address where `this.grids = result.grids` is replaced. If `grids` is
now a cached getter derived from the registry, you cannot assign to it. The old
`this.grids = result.grids` would need to become: clear all existing grid-type
entries, then register each diff grid. This is a non-trivial change that needs
explicit steps.

---

## Gaps

### 1. No `removeGrid(id)` overload in the context bag

Both plans assume commands will resolve to `idx` and call `ctx.removeGrid(idx)`.
But the viewer plan proposes `removeGrid(id)` (string-based). Neither plan
specifies when the context bag gains the ID-based overload. During the transition,
`removeGrid` only accepts an index. Commands that resolve by registry ID but get
`idx: -1` have no removal path.

**Fix**: Add `removeGridById(id)` to the context bag in Phase 0a, alongside the
existing `removeGrid(index)`.

### 2. `resolveGridByIdOrIndex` return shape vs `resolveGrid` return shape

`resolveGrid` returns `{ grid, idx }`. `resolveGridByIdOrIndex` returns
`{ grid, idx, registryId }`. The commands proposal says `resolved[i].idx` still
works for composition commands (section 4, note), but does not verify that every
downstream usage site only accesses `.grid` and `.idx`. If any call site
destructures exactly `{ grid, idx }`, adding `registryId` is harmless. But if
any call site spreads the result into a response `data` field, the extra key
leaks into the API. Low risk but worth a grep.

### 3. `grid.list` truncation of registry IDs

The commands proposal truncates registry IDs at 20 chars with ellipsis. Many
source paths will exceed 20 chars (`src/collections/GlyphCollection.js` = 35).
The truncated ID is not usable as a command argument. The `data` payload has the
full ID, but the `text` display should either show more chars or indicate that
the `data` field has the full value.

### 4. No mention of `SceneRegistry._onChange` in commands plan

The viewer plan proposes adding `_onChange` to SceneRegistry for cache
invalidation. The commands plan does not reference this. If commands are
implemented first (Phase 0a before viewer changes), the registry has no onChange
hook yet. This is fine -- the hook is only needed when `grids` becomes a getter --
but the dependency should be documented.

### 5. Tour stops store `gridIndex` -- no migration to registry IDs

The commands plan (section 6) migrates `tour.play` to use `resolveGridByIdOrIndex`
for re-validation, passing `String(stop.gridIndex)`. But tour stop creation
(`tour.stop`) stores the numeric index. If grids are added/removed between
`tour.stop` and `tour.play`, the stored index is stale. The fix is to store
`registryId` in the tour stop and resolve on playback, but neither plan addresses
the `tour.stop` creation side.

---

## Tensions

### 1. Registry-first vs index-first lookup order

The compatibility plan (section 2) says indices are "display-order aliases" and
registry IDs are canonical, with `resolveGridByIdOrIndex` trying registry first.
But the current `camera.focus` tries index first. The commands plan adopts
registry-first for `camera.focus` (section 3) while all other commands use
`resolveGridByIdOrIndex` (also registry-first). This creates the integer-string
ambiguity the orchestrator flagged.

**The tension**: "no breaking changes" (commands plan header) vs "registry ID is
canonical" (compatibility plan). These conflict when an ID happens to parse as
an integer.

### 2. Viewer wants grids-as-getter; commands plan assumes grids-as-array

The viewer plan proposes `get grids()` returning a cached array rebuilt on
registry change. The commands plan assumes `ctx.getGrids()` returns a stable
live array and says "no change needed" for the context bag. These are compatible
only if the getter returns the *same* array object when the cache is clean. The
viewer plan's cache rebuild creates a *new* array each time the cache is dirty,
which means layout managers holding a reference to the old array see stale data.
The viewer plan acknowledges this ("layout managers treat their stored array as
a snapshot") but the commands plan does not.

### 3. `removeGrid` by index vs by ID

The commands plan uses `ctx.removeGrid(idx)` everywhere. The viewer plan proposes
`removeGrid(id)` as the new canonical form. Neither plan defines when the
transition happens or whether both coexist.

---

## Recommendations

1. **Add integer-detection guard to `resolveGridByIdOrIndex`**: If `arg` parses
   as an integer AND a registry entry exists for that string, prefer the numeric
   index interpretation. Rationale: users type numbers meaning indices 99% of
   the time. Registry IDs that are pure integers are an edge case created by
   callers, not users. If a caller genuinely wants the registry entry for ID
   `"42"`, they can prefix it (e.g., `id:42`) or use a non-numeric ID.

   Concrete change to `spatialHelpers.js:46-54`:
   ```js
   if (ctx.registry && isNaN(parseInt(arg))) {
       const entry = ctx.registry.get(arg);
       if (entry) { ... }
   }
   ```

2. **Add `removeGridById(id)` to context bag immediately** (Phase 0a). It is
   needed by the time any command resolves by registry ID and gets `idx: -1`.

3. **Keep `camera.focus` lookup order as index-first** during Phase 0 to avoid
   the silent behavior change. Add registry lookup as a third fallback after
   filename substring. Align it with `resolveGridByIdOrIndex` only in Phase 1.

4. **Fix `grid.list` ID column width** to at least 30 chars, or show full path
   in the `text` output. The whole point of showing IDs is enabling copy-paste
   into subsequent commands.

5. **Store `registryId` in tour stops at creation time** so `tour.play`
   re-validation is stable across mutations.

6. **Document the Phase 0a/0b/viewer-migration ordering explicitly** as a
   checklist. The two plans have compatible but interleaved dependency chains
   that are easy to execute out of order.

---

## Key Insight

The integer-string ambiguity in `resolveGridByIdOrIndex` is not a theoretical
edge case -- it is a guaranteed collision path. `grid.create` auto-generates IDs
from filenames and source paths, but `AgentWindowManager` names windows with
labels like `agent:protocol`. A user or script could name a grid with a pure
numeric string. More importantly, the `addGrid` auto-registration fallback
(`grid-${Date.now()}-xxxx`) is safe, but nothing prevents `grid.create "..." "42"`
from registering ID `"42"`.

The fix is simple and should be in Phase 0a: **`resolveGridByIdOrIndex` should
skip registry lookup when the arg parses as a non-negative integer.** This
preserves exact backward compatibility (integers always mean indices) while
allowing string IDs for everything else. If someone truly needs a numeric
registry ID, they can quote or prefix it -- but this is a caller concern, not
a resolver concern.

This one-line guard (`if (ctx.registry && isNaN(parseInt(arg)))`) eliminates the
entire class of ambiguity without any API changes, and both the commands and
viewer plans can proceed without modification.
