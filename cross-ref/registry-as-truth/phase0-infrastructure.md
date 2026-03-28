# Phase 0 Infrastructure: SceneRegistry as Source of Truth

Agent: **infrastructure**
Focus: SceneRegistry enhancements, context bag rewrite, integer-guard fix

---

## 1. SceneRegistry Enhancements

The current `SceneRegistry` is a passive Map wrapper. To become the source of truth
it needs: change callbacks for cache invalidation, cached `toArray()` for stable
derived views, and `removeById()` returning the removed entry (already exists as
`unregister()` but we add the alias for API clarity).

### Implementation: SceneRegistry.js (replace entire file)

```js
/**
 * SceneRegistry -- source of truth for all scene objects.
 *
 * All grid creation/removal flows through register/unregister.
 * The grids array is a cached derived view via toArray('grid').
 *
 * Types: 'grid', 'window', 'annotation', 'label', 'agent', 'tour-annotation'
 */

/**
 * @typedef {Object} RegistryEntry
 * @property {string} id - stable string identifier
 * @property {Object} grid - CodeGrid instance (or any scene object)
 * @property {string} type - one of the known types
 * @property {Object} meta - arbitrary metadata
 */

export default class SceneRegistry {
    constructor() {
        /** @type {Map<string, RegistryEntry>} id -> entry */
        this._entries = new Map();

        /** @type {Map<Object, string>} grid -> id (reverse lookup) */
        this._gridToId = new Map();

        /** @type {Map<string, Object[]>} type -> cached array of grid objects */
        this._typeCache = new Map();

        /** @type {Function|null} external change listener */
        this._onChange = null;
    }

    // ── Mutation ──────────────────────────────────────────────

    /**
     * Register a scene object with a stable ID and type tag.
     * @param {string} id - unique identifier (caller-chosen)
     * @param {Object} grid - CodeGrid or scene object
     * @param {Object} opts
     * @param {string} opts.type
     * @param {Object} [opts.*] - additional metadata fields
     * @returns {RegistryEntry}
     */
    register(id, grid, { type, ...meta }) {
        if (this._entries.has(id)) {
            const existing = this._entries.get(id);
            this._gridToId.delete(existing.grid);
            if (existing.grid !== grid || existing.type !== type) {
                console.warn(`[registry] overwriting "${id}" (type: ${existing.type} -> ${type})`);
            }
        }

        const entry = { id, grid, type, meta };
        this._entries.set(id, entry);
        this._gridToId.set(grid, id);
        this._invalidateCache(type);
        return entry;
    }

    /**
     * Remove a registered object by ID.
     * @param {string} id
     * @returns {RegistryEntry|null} the removed entry, or null
     */
    unregister(id) {
        const entry = this._entries.get(id);
        if (!entry) return null;
        this._entries.delete(id);
        this._gridToId.delete(entry.grid);
        this._invalidateCache(entry.type);
        return entry;
    }

    /**
     * Alias for unregister -- reads better at call sites doing removal.
     * @param {string} id
     * @returns {RegistryEntry|null}
     */
    removeById(id) {
        return this.unregister(id);
    }

    // ── Queries ──────────────────────────────────────────────

    /**
     * Get an entry by ID.
     * @param {string} id
     * @returns {RegistryEntry|null}
     */
    get(id) {
        return this._entries.get(id) || null;
    }

    /** @param {string} id @returns {boolean} */
    has(id) {
        return this._entries.has(id);
    }

    /**
     * Find all entries of a given type.
     * Returns a fresh array each call (not cached -- use toArray for caching).
     * @param {string} type
     * @returns {RegistryEntry[]}
     */
    findByType(type) {
        const results = [];
        for (const entry of this._entries.values()) {
            if (entry.type === type) results.push(entry);
        }
        return results;
    }

    /**
     * Cached array of grid objects for a given type.
     * Rebuilt only when entries of that type change.
     * Insertion-order stable (Map preserves insertion order).
     * @param {string} type
     * @returns {Object[]} array of grid/scene objects (not entries)
     */
    toArray(type) {
        if (!this._typeCache.has(type)) {
            const arr = [];
            for (const entry of this._entries.values()) {
                if (entry.type === type) arr.push(entry.grid);
            }
            this._typeCache.set(type, arr);
        }
        return this._typeCache.get(type);
    }

    /**
     * Find entries by a metadata key-value match.
     * @param {string} key
     * @param {*} value
     * @returns {RegistryEntry[]}
     */
    findByMeta(key, value) {
        const results = [];
        for (const entry of this._entries.values()) {
            if (entry.meta[key] === value) results.push(entry);
        }
        return results;
    }

    /** @returns {RegistryEntry[]} all entries in insertion order */
    list() {
        return [...this._entries.values()];
    }

    /**
     * Reverse lookup: get the registry ID for a grid object.
     * @param {Object} grid
     * @returns {string|null}
     */
    getIdByGrid(grid) {
        return this._gridToId.get(grid) || null;
    }

    /**
     * Index into the cached toArray for a given type.
     * Replaces the old getByIndex(index, grids) -- no external array needed.
     * @param {number} index
     * @param {string} [type='grid']
     * @returns {RegistryEntry|null}
     */
    getByIndex(index, type = 'grid') {
        const arr = this.toArray(type);
        if (index < 0 || index >= arr.length) return null;
        const grid = arr[index];
        const id = this._gridToId.get(grid);
        return id ? this._entries.get(id) : null;
    }

    /** @returns {Object<string, number>} */
    typeCounts() {
        const counts = {};
        for (const entry of this._entries.values()) {
            counts[entry.type] = (counts[entry.type] || 0) + 1;
        }
        return counts;
    }

    /** @returns {number} */
    get size() {
        return this._entries.size;
    }

    // ── Internal ─────────────────────────────────────────────

    /**
     * Invalidate the cached array for a type and fire the onChange hook.
     * @param {string} type
     * @private
     */
    _invalidateCache(type) {
        this._typeCache.delete(type);
        if (this._onChange) {
            try { this._onChange(type); } catch (e) {
                console.error('[registry] onChange error:', e);
            }
        }
    }
}
```

### Key design decisions

1. **`toArray(type)` returns the same array reference** until invalidated. This means
   `ctx.getGrids()` returns a stable reference that layout managers can hold. When
   a grid is added/removed, the cache is invalidated and the next `getGrids()` call
   rebuilds. Code that caches the reference across frames must call `getGrids()` each
   frame (which is already the pattern -- nobody stores `const g = ctx.getGrids()`
   in a constructor).

2. **`_onChange` is a single callback, not an EventEmitter.** The only consumer is the
   context bag's cache-warming logic. If multiple listeners are needed later, upgrade
   to an array. YAGNI for now.

3. **`getByIndex(index, type)` no longer needs an external array.** It indexes into
   `toArray(type)`. The old signature `getByIndex(index, grids)` is removed -- callers
   should use the new one-arg form.

4. **`console.warn` on overwrites** where the grid object differs. Catches the
   double-register bug from `grid.create` + `addGrid` without breaking anything.

---

## 2. Context Bag Rewrite

The context bag in `websocket/index.js` currently owns the grids array via
`viewer.grids`. After this change, the registry is the owner. `viewer.grids` is
eliminated as a data store; `getGrids()` returns the registry's cached view.

### Implementation: buildContext changes in websocket/index.js

```js
function buildContext(viewer) {
    const registry = new SceneRegistry();

    // Seed registry with any grids that already exist on the viewer
    // (loaded before command center init)
    if (viewer.grids && viewer.grids.length > 0) {
        for (const grid of viewer.grids) {
            const sourcePath = grid.getSourcePath?.() || null;
            const filename = grid.getFilename?.() || grid.name || null;
            const id = sourcePath || filename
                || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            registry.register(id, grid, {
                type: 'grid',
                sourcePath,
                filename,
            });
        }
    }

    return {
        // Core Three.js
        scene: viewer.scene,
        camera: viewer.camera,
        renderer: viewer.renderer,
        atlas: viewer.atlas,

        // Scene object registry (THE source of truth)
        registry,

        // Data accessor -- cached derived view from registry
        getGrids: () => registry.toArray('grid'),

        // Grid mutation -- all creation/removal through registry
        addGrid(grid, id) {
            // Determine ID
            if (!id) {
                const sourcePath = grid.getSourcePath?.() || null;
                const filename = grid.getFilename?.() || grid.name || null;
                id = sourcePath || filename
                    || `grid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            }

            // Register first (registry is source of truth)
            if (!registry.getIdByGrid(grid)) {
                registry.register(id, grid, {
                    type: 'grid',
                    sourcePath: grid.getSourcePath?.() || null,
                    filename: grid.getFilename?.() || grid.name || null,
                });
            }

            // Add to scene
            if (!grid.parent) {
                viewer.scene.add(grid);
            }
        },

        removeGrid(index) {
            const grids = registry.toArray('grid');
            if (index < 0 || index >= grids.length) return null;
            const grid = grids[index];

            // Unregister (triggers cache invalidation)
            const regId = registry.getIdByGrid(grid);
            if (regId) registry.unregister(regId);

            grid.dispose();
            viewer.scene.remove(grid);
            return grid;
        },

        removeGridById(id) {
            const entry = registry.removeById(id);
            if (!entry) return null;

            entry.grid.dispose();
            viewer.scene.remove(entry.grid);
            return entry.grid;
        },

        // ... rest of context unchanged (subsystems, layout, etc.)
    };
}
```

### What changed

| Before | After |
|--------|-------|
| `viewer.grids.push(grid)` | `registry.register(id, grid, {...})` |
| `viewer.grids.splice(index, 1)` | `registry.unregister(id)` |
| `getGrids: () => viewer.grids` | `getGrids: () => registry.toArray('grid')` |
| No `removeGridById` | `removeGridById(id)` for direct ID-based removal |
| `addGrid(grid)` | `addGrid(grid, id?)` accepts optional ID |

### Backward compatibility notes

- `getGrids()` still returns an array. Same shape, same iteration. The only difference
  is it is rebuilt on mutation instead of being mutated in place.
- `removeGrid(index)` still works by integer index. The index is into the
  registry-derived array, which preserves insertion order (Map iteration order).
- `addGrid(grid)` without an ID still auto-generates one. Callers that already
  pass a grid and call `registry.register()` themselves will see the
  `getIdByGrid()` guard and skip double-registration.

### What `viewer.grids` becomes

The viewer's own `.grids` property should become a getter that delegates to the
registry. This is a viewer-agent concern, but for context:

```js
// In GitHubRepoViewer, after command center init:
// Replace: this.grids = [];
// With: get grids() { return this._commandContext.getGrids(); }
```

Until that migration happens, `viewer.grids` and `registry.toArray('grid')` can
drift. The seed loop in `buildContext` handles the initial sync. Any code that
calls `viewer.grids.push()` directly (outside the context bag) is a bug -- grep
for it and migrate.

---

## 3. Integer-First Guard in resolveGridByIdOrIndex

The shadowing bug: `resolveGridByIdOrIndex` tries registry lookup first. If a
registry ID is `"42"`, then `grid.info 42` resolves to that entry instead of
array index 42. Users type numbers meaning indices. Registry IDs that are pure
integers are a caller mistake, not a user intent.

### Implementation: spatialHelpers.js

```js
/**
 * Resolve a grid by registry ID or array index.
 *
 * Integer-first rule: if arg is a pure digit string (/^\d+$/), treat as
 * numeric index. Registry lookup only for args containing non-digit chars.
 * This prevents ID "42" from shadowing array index 42.
 *
 * @param {Object} ctx - command context bag (must have .registry and .getGrids)
 * @param {string} arg - registry ID or numeric index string
 * @param {string} [label='grid'] - label for error messages
 * @returns {{ grid: Object, idx: number, registryId: string|null } | { error: string }}
 */
export function resolveGridByIdOrIndex(ctx, arg, label = 'grid') {
    const grids = ctx.getGrids();
    const isPureInteger = /^\d+$/.test(arg);

    // 1. Pure integer -> numeric index first
    if (isPureInteger) {
        const idx = parseInt(arg);
        if (idx >= 0 && idx < grids.length) {
            const registryId = ctx.registry ? ctx.registry.getIdByGrid(grids[idx]) : null;
            return { grid: grids[idx], idx, registryId };
        }
        // Integer but out of range -- fall through to registry as last resort
        // (handles case where someone deliberately used a numeric registry ID)
    }

    // 2. Non-integer string (or out-of-range integer) -> registry lookup
    if (ctx.registry) {
        const entry = ctx.registry.get(arg);
        if (entry) {
            const idx = grids.indexOf(entry.grid);
            return { grid: entry.grid, idx, registryId: entry.id };
        }
    }

    // 3. Nothing found
    if (isPureInteger) {
        return { error: `ERR: invalid ${label} index ${arg} (0-${grids.length - 1})` };
    }
    return { error: `ERR: no ${label} found for "${arg}" (not a registry ID or valid index 0-${grids.length - 1})` };
}
```

### Lookup order summary

| Arg | Step 1 | Step 2 | Step 3 |
|-----|--------|--------|--------|
| `"3"` | Array index 3 | Registry ID "3" (only if index OOB) | Error |
| `"my-window"` | Skip (non-integer) | Registry lookup | Error |
| `"agent:proto"` | Skip (non-integer) | Registry lookup | Error |
| `"999"` (OOB) | Index 999 fails | Registry ID "999" | Error |

The out-of-range fallthrough is deliberate: if someone registers ID `"999"` and there
are only 50 grids, `grid.info 999` should find the registry entry rather than error.
This is the only case where a pure-integer arg hits the registry, and it requires
the index to be out of bounds -- no shadowing possible.

---

## 4. resolveGrid Deprecation Path

The old `resolveGrid(grids, arg, label)` stays as-is. It is used by commands that
have not migrated to `resolveGridByIdOrIndex`. No changes needed now.

Migration plan:
1. Phase 0: commands migrate one-by-one from `resolveGrid` to `resolveGridByIdOrIndex`
2. Phase 1: grep for remaining `resolveGrid` calls, migrate them
3. Phase 2: remove `resolveGrid`, add a `console.warn` wrapper if needed for external callers

No code change required in this phase -- just the plan.

---

## 5. Migration Checklist

Ordered by dependency. Each step is independently deployable.

- [ ] **0a** Deploy enhanced `SceneRegistry.js` (this file's section 1)
  - New methods: `removeById`, `toArray`, `_onChange`, `_invalidateCache`
  - Changed: `getByIndex` takes `type` string instead of external array
  - Changed: `register`/`unregister` call `_invalidateCache`
  - No callers break -- new methods are additive, old `getByIndex(idx, grids)` callers
    need update but there are zero external callers today

- [ ] **0b** Deploy integer-first guard in `spatialHelpers.js` (section 3)
  - Zero risk -- only changes behavior for pure-integer args that happen to match
    a registry ID, which is currently a bug

- [ ] **0c** Deploy context bag rewrite in `websocket/index.js` (section 2)
  - `getGrids()` now returns `registry.toArray('grid')`
  - `addGrid(grid, id?)` registers in registry, adds to scene
  - `removeGrid(index)` indexes into registry-derived array
  - `removeGridById(id)` new method
  - Depends on 0a (enhanced registry)

- [ ] **0d** Migrate `viewer.grids` to getter (viewer-agent concern)
  - `get grids()` delegates to command context's `getGrids()`
  - Grep for `viewer.grids.push` / `viewer.grids.splice` / `viewer.grids = ` and
    migrate to `addGrid`/`removeGrid`/`clearGrids`

- [ ] **0e** Audit `grid.create` double-register
  - `grid.create` calls `ctx.registry.register()` then `ctx.addGrid()`
  - After 0c, `addGrid` checks `getIdByGrid` and skips re-registration
  - Verify no `console.warn` fires on normal `grid.create` flow

---

## 6. Risks and Mitigations

**Risk**: Code outside the context bag calls `viewer.grids.push()` directly.
**Mitigation**: After 0d, `viewer.grids` is a getter returning a frozen-ish array.
Direct push throws or is silently ignored. Grep and fix before deploying 0d.

**Risk**: `toArray('grid')` cache returns stale data if mutation bypasses registry.
**Mitigation**: All mutation paths go through `addGrid`/`removeGrid`/`removeGridById`.
There is no public API to mutate the array directly. The cache is invalidated on
every `register`/`unregister`.

**Risk**: `_onChange` fires per-item during bulk operations (e.g., `clearGrids`).
**Mitigation**: Acceptable for now. `_invalidateCache` just deletes a Map key --
sub-microsecond. The cache is rebuilt lazily on next `toArray()` call, which happens
once after the bulk op, not N times. If perf becomes an issue, add
`registry.batch(() => { ... })` that suppresses onChange until the batch completes.

**Risk**: Layout managers hold stale array reference after grid add/remove.
**Mitigation**: `toArray()` returns a new array only when the cache is dirty. Layout
managers that call `ctx.getGrids()` per-frame (the existing pattern) always get the
current array. Layout managers that cache the reference in a constructor field need
to switch to calling `ctx.getGrids()` when they access it. Grep for
`this.grids = ctx.getGrids()` or `this._grids = ` patterns.
