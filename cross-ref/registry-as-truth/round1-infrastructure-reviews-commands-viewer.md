# Round 1: Infrastructure Reviews Commands + Viewer

Agent: **infrastructure**
Reviewing: **phase0-commands.md** and **phase0-viewer.md**

---

## Errors Found

### E1. Promise.all destroys Map insertion order (CRITICAL -- both agents affected)

Viewer claims (section 10, section 16): "Map preserves insertion order. `register()` order = load order."

Commands claims (section 1): "Map iteration order in JS is insertion order. This gives us stable indices that match the old `viewer.grids` array as long as registration order matches push order."

Both are technically correct about Map semantics but wrong about the actual registration order. The real code:

```js
// GitHubRepoViewer.js line 860-864
gridPromises.push(this.createGridForFileAsync(file.path, fileData.content));
// ...
const createdGrids = await Promise.all(gridPromises);
```

Viewer's proposal puts `registry.register()` inside `createGridForFileAsync`. That call is async -- `loadFileAsync` takes variable time per file. `Promise.all` resolves all promises concurrently, and the `register()` calls fire whenever each individual promise resolves, not in declaration order. A 10-line file finishes before a 500-line file. Map insertion order reflects completion order, not `sourceFiles` iteration order.

The old code was immune because `this.grids.push(grid)` happened *after* `Promise.all` returned, iterating `createdGrids` in declaration order (line 886-888). That sequential push loop is what gave stable ordering.

**Fix**: Do NOT register inside `createGridForFileAsync`. Keep registration in the post-`Promise.all` loop where `createdGrids` preserves declaration order:

```js
const createdGrids = await Promise.all(gridPromises);
for (const grid of createdGrids) {
    this.scene.add(grid);
    this.registry.register(grid.userData.sourcePath, grid, { type: 'grid', ... });
}
```

Both agents must update their proposals. This is not a minor ordering concern -- layout managers depend on array index stability for `focusOnGrid(index)`, minimap rendering, and tab traversal.

### E2. Commands: `resolveGridByIdOrIndex` integer-first disagrees with current code

Commands proposes (section 3) that pure-integer args return an error if out of range -- no registry fallback. Infrastructure proposes (section 3) an out-of-range fallthrough to registry. The current live code (spatialHelpers.js line 43-64) does registry-first, integer-second (the opposite of both proposals).

Commands' version is stricter: `"999"` with 50 grids returns an error. Infrastructure's version falls through to registry lookup for `"999"`. Commands' approach silently breaks any code that registers numeric-string IDs and expects them to resolve. Infrastructure's fallthrough is safer -- adopt it.

### E3. Viewer: `_invalidateGridsCache` is manual and fragile

Viewer proposes (section 2) a manual `_invalidateGridsCache()` call after every `register()`/`unregister()`. This is the exact pattern Infrastructure's `_onChange` callback was designed to eliminate. If any code path forgets the invalidation call, the cache serves stale data silently. Viewer should use Infrastructure's `_onChange` hook:

```js
registry._onChange = () => { this._registryVersion++; };
```

One line, no manual calls to forget.

### E4. Commands: `grids()` method rebuilds array on every call

Commands section 1 proposes a `grids()` method that iterates the full Map every call. Infrastructure's `toArray(type)` with cache invalidation is strictly better. Commands should use `toArray('grid')`, not add a redundant `grids()` method.

---

## Gaps

### G1. Neither agent addresses `loadDiff` ordering

`loadDiff` (viewer line 1065) does `this.grids = result.grids` where `result.grids` comes from DiffController. DiffController also uses `Promise.all` (line 117) to create grids concurrently. The same completion-order problem applies. Viewer acknowledges the site but does not address ordering.

### G2. Commands: no migration for `camera.focus` duplicate logic

Commands section 11 implements a three-step lookup (numeric, registry ID, filename substring) that partially duplicates `resolveGridByIdOrIndex`. This should call `resolveGridByIdOrIndex` for steps 1-2, then add the filename-substring fallback as step 3. DRY.

### G3. Viewer: no setter trap in initial proposal

Viewer section 16 mentions a setter trap as an afterthought but does not include it in the implementation sections. The `set grids(_) { throw ... }` should be in section 2 next to the getter definition, not buried in risks.

### G4. Commands: `scene.reset` iterates + mutates same registry

Commands section 9 does `for (const entry of ctx.registry.findByType(type)) { ctx.registry.unregister(entry.id); }`. `findByType` returns a fresh array (safe), but this should be called out explicitly. If `findByType` ever returned a live view, this would corrupt iteration. Infrastructure's `unregisterByType` (viewer section 3) is the right pattern -- atomic bulk removal.

---

## Tensions

### T1. Who owns `SceneRegistry` enhancements?

Infrastructure proposes: `toArray(type)` with `_typeCache`, `_invalidateCache`, `_onChange`, `removeById`, `getByIndex(index, type)`.

Commands proposes: a `grids()` convenience method.

Viewer proposes: `unregisterByType(type)`.

These are all additive and compatible, but the three agents propose them independently without cross-referencing. Implementation should combine: Infrastructure's full rewrite is the base, plus Viewer's `unregisterByType`. Commands' `grids()` is redundant with `toArray('grid')` and should be dropped.

### T2. `addGrid` signature diverges

Commands: `addGrid(grid, opts = {})` where `opts.id`, `opts.type`, `opts.meta`.
Infrastructure: `addGrid(grid, id?)` where id is an optional string.

Commands' version is more flexible (supports type and meta). Infrastructure's is simpler. Adopt Commands' signature -- the extra fields cost nothing and `grid.create` already needs `type` for non-grid scene objects.

### T3. `removeGrid` semantics differ

Commands: `removeGrid(idOrIndex)` accepts string or number, returns entry.
Infrastructure: separate `removeGrid(index)` and `removeGridById(id)`.

Commands' unified signature is more ergonomic. Infrastructure's split is more explicit. Since `resolveGridByIdOrIndex` already handles the disambiguation, callers should resolve first, then call `removeGridById(registryId)`. The unified `removeGrid` hides ambiguity that should be explicit at the call site.

### T4. `findByType` vs `toArray` -- which do commands use?

Commands section 7 uses `ctx.registry.findByType('grid')` returning entries. Infrastructure's `toArray('grid')` returns grid objects (not entries). Commands need entries (for `.id`, `.meta`). They should use `findByType` for iteration-with-metadata, and `toArray` for passing to layout managers that expect bare grid arrays. Both methods should exist.

---

## Recommendations

1. **Fix the Promise.all ordering bug before anything else.** Registration must happen in a sequential loop after `Promise.all`, not inside the async factory. This applies to both `loadRepository` and `loadDiff`. Tag this as a precondition for the entire registry-as-truth migration.

2. **Adopt Infrastructure's SceneRegistry as the canonical implementation**, plus Viewer's `unregisterByType`. Drop Commands' `grids()` method in favor of `toArray('grid')`.

3. **Use Infrastructure's `_onChange` callback** instead of Viewer's manual `_invalidateGridsCache()` calls. One wiring point, zero forgettable manual calls.

4. **Adopt Commands' `addGrid(grid, opts)` signature** for the context bag. It is a superset of Infrastructure's version.

5. **Keep `removeGrid(index)` and `removeGridById(id)` separate** (Infrastructure's approach). Callers resolve with `resolveGridByIdOrIndex` first, then call the appropriate removal method. No hidden type-checking in the removal path.

6. **Adopt Infrastructure's integer-first guard with out-of-range fallthrough** for `resolveGridByIdOrIndex`. Commands' strict version unnecessarily breaks numeric registry IDs.

7. **Deduplicate `camera.focus`** -- call `resolveGridByIdOrIndex` then add filename-substring as a third fallback, not a separate three-step function.

---

## Key Insight

The entire "registry as source of truth" migration hinges on one unstated assumption: that `register()` call order equals file declaration order. It does not. `Promise.all` + async grid creation produces nondeterministic registration order. Every downstream guarantee -- stable indices for `focusOnGrid`, tab traversal, minimap layout, tour stops -- breaks silently.

The fix is simple (register after `await Promise.all`, not inside the async factory), but neither the commands nor viewer agent identified the problem. This is the kind of bug that passes every manual test (order is often coincidentally correct with fast networks and small repos) and surfaces only under load or slow connections, making it extremely hard to diagnose after the fact. It must be addressed in the implementation, not discovered in production.
