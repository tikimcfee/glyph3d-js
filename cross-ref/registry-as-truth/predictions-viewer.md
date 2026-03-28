# Predictions from Viewer Agent

## About Commands Agent

Commands likely rewrote every command handler to use `resolveGridByIdOrIndex(ctx, arg)` instead of `resolveGrid(grids, arg)`, and changed iteration from `ctx.getGrids()` array to `ctx.registry.findByType('grid')` for commands like `grid.list`, `search`, and `scene.info`. They probably added `registryId` to all command response `data` objects. What they likely missed: the `grid.create` double-register problem -- if `grid.create` calls both `ctx.registry.register()` and `ctx.addGrid()`, they need a guard to prevent duplicate entries, and commands agent may have assumed addGrid handles dedup without specifying the mechanism. They also probably did not address what happens to `tour.play` when a grid referenced by `registryId` has been removed and re-added (the ID is stable but the grid object changed).

## About Infrastructure Agent

Infrastructure likely enhanced SceneRegistry with cached type queries, an onChange callback for external cache invalidation, and the integer-first guard for `resolveGridByIdOrIndex`. They probably defined `toArray(type)` with lazy rebuild semantics. What they likely got wrong: returning the same cached array reference from `toArray` is dangerous -- if a consumer does `grids.push(x)` or `grids[i] = y` the cache is silently corrupted without invalidation. They should return a frozen or fresh copy. They also likely did not account for the viewer-side cache: if the viewer has its own `_gridsCache` with version tracking, and the registry also has `_typeCache`, there are two redundant caching layers that need to stay in sync, creating a subtle coherence problem.
