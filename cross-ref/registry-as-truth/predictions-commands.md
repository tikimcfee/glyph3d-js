# Predictions from Commands Agent

## About Viewer Agent

Viewer likely focused on replacing `this.grids = []` with a getter backed by the registry, and mapping each mutation site (push, splice, assignment in loadDiff) to registry calls. They probably introduced a cache-invalidation mechanism on the getter to avoid per-frame `findByType` scans in the minimap hot path. However, they may have missed the interaction between `viewer.grids` as a getter and the context bag's `getGrids()` -- if both independently derive from the registry, there is a question of whether the viewer owns a registry instance or shares the one from the context bag, and viewer likely did not fully resolve that ownership boundary. They also probably punted on SelectionManager migration, leaving it as a Phase 1 concern, which means `grids.find()` O(n) scans survive.

## About Infrastructure Agent

Infrastructure likely rewrote SceneRegistry with `toArray(type)` caching and cache invalidation on register/unregister, plus the integer-first guard in `resolveGridByIdOrIndex`. They probably added a `findByMeta` or similar query method for richer lookups. What they likely missed: the context bag's `removeGrid` still accepts only numeric indices in their version, lacking a `removeGridById(id)` path -- or if they added it, they may not have coordinated with how `grid.remove` command resolves by registryId vs index. They also likely did not address the seed-sync problem: when the command center initializes after grids are already loaded, the registry starts empty while `viewer.grids` already has entries, creating a drift window that needs explicit seeding logic.
