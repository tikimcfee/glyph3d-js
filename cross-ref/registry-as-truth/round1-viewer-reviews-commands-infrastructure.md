# Round 1: Viewer Reviews Commands + Infrastructure

Reviewer: **viewer**
Reviewed: **commands** (phase0-commands.md), **infrastructure** (phase0-infrastructure.md)

---

## Errors Found

### E1. `toArray()` returns a mutable cached reference — corruption risk (infrastructure)

`toArray(type)` (infrastructure lines 137-146) returns the raw cached array from
`this._typeCache`. Any caller that mutates the returned array — `push()`, `splice()`,
`pop()`, bracket assignment — silently corrupts the registry's internal cache. The
context bag wires `getGrids: () => registry.toArray('grid')`, so every command that
calls `ctx.getGrids()` receives this same mutable reference.

The infrastructure doc (line 229) says "code that caches the reference across frames
must call `getGrids()` each frame" but never addresses the mutation vector. It even
says layout managers "hold" the reference. One `grids.push(phantom)` anywhere and
every subsequent `toArray('grid')` returns a poisoned array until the next cache
invalidation.

**Fix**: Return a frozen shallow copy: `return Object.freeze([...cached])`. Or return
`[...cached]` (cheap — these arrays are typically <200 entries). The cache still avoids
the Map scan; the spread is the only added cost. Alternatively, use a Proxy that traps
mutation methods, but freeze is simpler.

Infrastructure's own risk section (section 6) lists "layout managers hold stale array
reference" but frames it as a staleness issue, not a corruption issue. These are
different failure modes: staleness means missing a new grid, corruption means the
registry itself returns wrong data.

### E2. Commands `grids()` vs infrastructure `toArray()` — API divergence

Commands (section 1, line 32-38) adds a `grids()` method to SceneRegistry that builds
a fresh array every call. Infrastructure instead adds `toArray(type)` with caching.
The context bag in commands (line 61) uses `registry.grids()`, while infrastructure
(line 285) uses `registry.toArray('grid')`.

These are two different methods with different semantics on the same class. If both
proposals are merged, `grids()` always rebuilds while `toArray('grid')` caches.
Callers using `grids()` pay O(n) per call; callers using `toArray()` get O(1) but
risk E1. Pick one.

**Recommendation**: Use `toArray('grid')` with the freeze fix from E1. Delete the
proposed `grids()` method from commands. One path, one behavior.

### E3. Commands `addGrid` signature differs from infrastructure `addGrid`

Commands (section 2, lines 64-78): `addGrid(grid, opts = {})` where `opts` is an
object with `.id`, `.type`, `.meta`.

Infrastructure (section 2, lines 287-309): `addGrid(grid, id)` where `id` is a
plain string.

These are incompatible signatures. Command handlers that call `ctx.addGrid(grid,
{ id: name })` will break under infrastructure's implementation (it would use the
object as the ID string). Must converge on one signature.

### E4. Commands `removeGrid` accepts ID or index; infrastructure `removeGrid` only accepts index

Commands (section 2, lines 82-97): `removeGrid(idOrIndex)` with string/number
dispatch.

Infrastructure (section 2, lines 311-320): `removeGrid(index)` — only integer. It
adds a separate `removeGridById(id)` method.

This means `grid.remove` in commands calls `ctx.removeGrid(resolved.registryId)` (a
string) which would pass the `index < 0` check in infrastructure's version (NaN is
not >= 0, not < 0 — falls through to `grids[NaN]` which is `undefined`). Returns
null silently instead of removing.

---

## Gaps

### G1. No `unregisterByType` in infrastructure

Viewer's `clearGrids()` (viewer section 5) needs `registry.unregisterByType('grid')`.
Infrastructure's SceneRegistry enhancement does not include this method. Commands'
`scene.reset` (section 9) manually iterates `findByType` then calls `unregister` per
entry, which works but is verbose and error-prone (mutating a Map while iterating its
derived array — safe only because `findByType` returns a fresh array).

Infrastructure should add `unregisterByType(type)` as viewer proposed it (viewer
section 3). It is a natural registry primitive.

### G2. No `_onChange` integration in commands

Infrastructure adds `_onChange` callback to SceneRegistry (line 47). Commands never
reference it or wire it up. The viewer plan uses a manual `_invalidateGridsCache()`
call after every register/unregister. These are three different invalidation strategies
that need to converge.

With infrastructure's `_invalidateCache` being called internally by register/unregister,
the viewer's manual `_invalidateGridsCache()` calls are redundant. But the viewer plan
does not know about `_onChange` and so adds its own version-counter scheme. Should be
reconciled: viewer should set `registry._onChange` to bump its version counter, or
(better) just use `toArray('grid')` directly and drop the viewer-side cache entirely.

### G3. Seed loop timing

Infrastructure (section 2, lines 258-271) seeds the registry from `viewer.grids` at
`buildContext` time. But `buildContext` may run before any grids are loaded (WebSocket
connects on page load, repo loads async). The seed loop catches grids loaded before
command center init, but grids loaded after init but outside the command center (e.g.,
`viewer.grids.push()` in the main viewer code) will not be registered.

Viewer's plan (section 4) solves this by making `createGridForFileAsync` call
`registry.register()` directly. But until that viewer migration lands, there is a
window where the registry and `viewer.grids` can drift. Infrastructure acknowledges
this (line 370-375) but does not propose a safety net.

---

## Tensions

### T1. Who owns SceneRegistry construction?

- Viewer (section 2): `this.registry = new SceneRegistry()` in the GitHubRepoViewer
  constructor.
- Commands (section 2): `const registry = new SceneRegistry()` in `buildContext()`.
- Infrastructure (section 2): same as commands.

If viewer creates its own registry AND buildContext creates another, there are two
registries. The viewer plan assumes the viewer owns the registry. Commands and
infrastructure assume buildContext owns it. Must pick one. The viewer creating it
and passing it into the context bag is cleanest (viewer is the application, context
bag is the command interface to it).

### T2. `getByIndex` signature change

Current codebase: `getByIndex(index, grids)` takes an external array.
Infrastructure proposes: `getByIndex(index, type = 'grid')` — uses internal `toArray`.

If any existing command code calls `registry.getByIndex(idx, ctx.getGrids())`, the
second arg becomes the type string `'grid'` would need to change. Infrastructure
says "there are zero external callers today" — should verify via grep before merging.

### T3. Cache invalidation granularity

Infrastructure invalidates per-type: adding a 'grid' only invalidates the 'grid'
cache. Viewer invalidates a single global version counter. Commands rebuild per-call
(no cache). The per-type approach is correct and more efficient. Viewer's global
version counter is fine for Phase 0 since it only has one type ('grid') but is
technically over-invalidating if other types are added later.

---

## Recommendations

1. **Freeze or copy `toArray` returns.** This is the highest-priority fix. The cached
   mutable array is a time bomb. Use `Object.freeze(arr)` on the cached array at
   creation time (line 143 of infrastructure). Freezing in place means the cache itself
   is immutable, so returning the reference is safe. Cost: one freeze per invalidation
   cycle, zero cost per read.

2. **Converge on infrastructure's `toArray('grid')` + cache invalidation.** Drop the
   commands-proposed `grids()` method. Drop the viewer-proposed version-counter cache.
   Let the registry's internal `_typeCache` with `_invalidateCache` be the single
   caching layer. The viewer getter becomes `get grids() { return this.registry.toArray('grid'); }`.

3. **Converge on a single `addGrid` signature.** Use infrastructure's simpler
   `addGrid(grid, id?)` form. Commands' `opts` bag adds flexibility that is not
   needed — the registry `register()` call inside `addGrid` already accepts metadata
   derived from the grid object itself.

4. **Converge on a single `removeGrid` with type dispatch.** Use commands' approach:
   `removeGrid(idOrIndex)` with string/number dispatch. Drop infrastructure's
   separate `removeGridById`. One method, one call site pattern.

5. **Add `unregisterByType(type)` to SceneRegistry.** Both viewer and commands need
   bulk-remove-by-type. It is a natural registry operation. Five lines of code.

6. **Single registry owner.** Viewer creates the SceneRegistry in its constructor.
   `buildContext` receives it as a parameter: `buildContext(viewer, viewer.registry)`.
   No seed loop needed — the registry is already populated because viewer registered
   grids as they were created.

---

## Key Insight

The three plans agree on the destination (registry as truth, derived arrays, no raw
`this.grids` mutations) but diverge on the caching contract. Commands rebuilds arrays
per call (correct but wasteful). Viewer builds its own version-counter cache outside
the registry (redundant). Infrastructure caches inside the registry but returns mutable
references (fast but unsafe). The winning design is infrastructure's internal cache
with a one-line freeze fix, which gives O(1) reads, automatic invalidation, and
mutation safety — making both the commands per-call rebuild and the viewer external
cache unnecessary.
