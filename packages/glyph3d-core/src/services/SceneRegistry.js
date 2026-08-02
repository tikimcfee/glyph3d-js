/**
 * SceneRegistry -- source of truth for all scene objects.
 *
 * All grid creation/removal flows through register/unregister.
 * The grids array is a cached derived view via toArray('grid').
 *
 * SPECIES vs ROLE — one identity, many presentations. `type` says what an
 * object IS ('grid', 'terminal', 'book', 'carrel', 'frame', ...) and never
 * changes with presentation. `role` says how it is currently carried
 * ('card' = a sheet inside an agent book, 'volume' = a directory bound as a
 * library volume, 'agent' = an agent lane's deck root) and is absent for a
 * loose world citizen. The machinery keys on the TAG (`role || type`):
 * pickability, culling, toArray/index spaces — so a role-less world behaves
 * exactly as before, and identity queries (findByType) see every member of
 * a species no matter what carries it. IDs are IDs; a grid that becomes a
 * book page stays findable and readable as the grid it is.
 */

/**
 * @typedef {Object} RegistryEntry
 * @property {string} id - stable string identifier
 * @property {Object} grid - CodeGrid instance (or any scene object)
 * @property {string} type - SPECIES: what the object is
 * @property {string|null} role - presentation role, null when loose
 * @property {Object} meta - arbitrary metadata
 */

export default class SceneRegistry {
    constructor() {
        /** @type {Map<string, RegistryEntry>} id -> entry */
        this._entries = new Map();

        /** @type {Map<Object, string>} grid -> id (reverse lookup) */
        this._gridToId = new Map();

        /** @type {Map<string, Object[]>} type -> cached frozen array of grid objects */
        this._typeCache = new Map();

        /** @type {Set<Function>} change listeners */
        this._changeListeners = new Set();

        /** @type {Set<string>} types whose entries are pick-targets (hover / click / drag). */
        this._pickableTypes = new Set(['grid', 'terminal', 'frame']);

        /**
         * @type {Set<RegistryEntry>} entries of a pickable type — maintained
         * incrementally on register/unregister so the input layer reads ONE set
         * instead of re-scanning + concatenating findByType per change (which is O(N)
         * on every registry mutation → O(N²) over a bulk tree load).
         */
        this._pickable = new Set();

        // The holdChanges window: while > 0, mutations still land (and type caches
        // still invalidate) but listener notification COALESCES — one fire per
        // distinct changed type at the outermost close, instead of the full
        // listener suite (surface projector, workspace reconcile, every mirroring
        // React panel) running once per grid across a bulk load.
        this._holdDepth = 0;
        /** @type {Set<string>} */
        this._heldTypes = new Set();
    }

    // -- Mutation -------------------------------------------------------

    /**
     * Register a scene object with a stable ID, species type, and optional role.
     * @param {string} id - unique identifier (caller-chosen)
     * @param {Object} grid - CodeGrid or scene object
     * @param {Object} opts
     * @param {string} opts.type - species (what it IS)
     * @param {string} [opts.role] - presentation role (how it's carried)
     * @param {Object} [opts.*] - additional metadata fields
     * @returns {RegistryEntry}
     */
    register(id, grid, { type, role = null, ...meta }) {
        if (this._entries.has(id)) {
            const existing = this._entries.get(id);
            this._gridToId.delete(existing.grid);
            this._pickable.delete(existing);
            if (existing.grid !== grid || existing.type !== type) {
                console.warn(`[registry] overwriting "${id}" (type: ${existing.type} -> ${type})`);
            }
        }

        const entry = { id, grid, type, role, meta };
        this._entries.set(id, entry);
        this._gridToId.set(grid, id);
        if (this._pickableTypes.has(this._tag(entry))) this._pickable.add(entry);
        this._invalidateCache(this._tag(entry));
        return entry;
    }

    /** The machinery key: presentation role when carried, species when loose. @private */
    _tag(entry) {
        return entry.role || entry.type;
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
        this._pickable.delete(entry);
        this._invalidateCache(this._tag(entry));
        return entry;
    }

    /**
     * Alias for unregister -- reads better at removal call sites.
     * @param {string} id
     * @returns {RegistryEntry|null}
     */
    removeById(id) {
        return this.unregister(id);
    }

    /**
     * Remove all entries of a given TAG (role||type — lifecycle scope, so
     * clearing 'tour-annotation' or 'grid' never guts a book's pages).
     * Returns removed entries (caller iterates for disposal).
     * Fires a single cache invalidation after all removals.
     * @param {string} tag
     * @returns {RegistryEntry[]}
     */
    unregisterByType(tag) {
        const removed = [];
        for (const [id, entry] of this._entries) {
            if (this._tag(entry) === tag) {
                this._entries.delete(id);
                this._gridToId.delete(entry.grid);
                this._pickable.delete(entry);
                removed.push(entry);
            }
        }
        if (removed.length > 0) {
            this._invalidateCache(tag);
        }
        return removed;
    }

    /**
     * Re-order entries of a given tag according to a comparator.
     * Compares RegistryEntry objects (access .grid, .meta, .id).
     * Rebuilds Map insertion order via delete + re-insert (ES2015 spec).
     * @param {string} tag
     * @param {(a: RegistryEntry, b: RegistryEntry) => number} compareFn
     */
    sortByType(tag, compareFn) {
        const entries = this.list().filter((e) => this._tag(e) === tag);
        entries.sort(compareFn);
        // Rebuild Map insertion order: delete then re-insert in sorted order
        for (const entry of entries) {
            this._entries.delete(entry.id);
        }
        for (const entry of entries) {
            this._entries.set(entry.id, entry);
        }
        this._invalidateCache(tag);
    }

    // -- Queries --------------------------------------------------------

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
     * Find all entries of a given SPECIES — every member, however carried
     * (loose in the field, a card in a book, bound in a volume). The
     * identity/read query: "all the grids there are".
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
     * Find the LOOSE entries of a species — members not carried by anything
     * (role == null). The lifecycle query: what clear/dispose/census sweeps
     * may touch without reaching inside a book.
     * @param {string} type
     * @returns {RegistryEntry[]}
     */
    findLoose(type) {
        const results = [];
        for (const entry of this._entries.values()) {
            if (entry.type === type && !entry.role) results.push(entry);
        }
        return results;
    }

    /**
     * Find all entries carried under a given role, any species.
     * @param {string} role
     * @returns {RegistryEntry[]}
     */
    findByRole(role) {
        const results = [];
        for (const entry of this._entries.values()) {
            if (entry.role === role) results.push(entry);
        }
        return results;
    }

    /**
     * Cached frozen array of grid objects for a given TAG (role||type) —
     * the machinery view: index spaces, culling, camera surfaces. A role-less
     * world makes tag == type, so toArray('grid') is exactly the loose grids.
     * Rebuilt only when entries of that tag change.
     * Insertion-order stable (Map preserves insertion order).
     * @param {string} tag
     * @returns {Object[]} frozen array of grid/scene objects (not entries)
     */
    toArray(tag) {
        if (!this._typeCache.has(tag)) {
            const arr = [];
            for (const entry of this._entries.values()) {
                if (this._tag(entry) === tag) arr.push(entry.grid);
            }
            this._typeCache.set(tag, Object.freeze(arr));
        }
        return this._typeCache.get(tag);
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
     * Mark a TAG (role||type) as pick-eligible (hover / click / drag),
     * back-filling any entries already registered under it. New entity kinds
     * (trail cards, volume covers) opt in HERE instead of editing the input
     * layer's hardcoded list — one seam. Keying on the tag means a deck root
     * (role 'agent') can pick differently from a loose 'book' without
     * forking species.
     * @param {string} tag
     * @param {boolean} [on=true]
     * @returns {this}
     */
    setPickable(tag, on = true) {
        if (on) {
            if (this._pickableTypes.has(tag)) return this;
            this._pickableTypes.add(tag);
            for (const e of this._entries.values()) if (this._tag(e) === tag) this._pickable.add(e);
        } else {
            this._pickableTypes.delete(tag);
            for (const e of this._entries.values()) if (this._tag(e) === tag) this._pickable.delete(e);
        }
        return this;
    }

    /**
     * Every entry whose type is pick-eligible, as a fresh array. O(pickable count) —
     * no full-registry rescan, no per-type concat (the hover wire runs this on every
     * registry change).
     * @returns {RegistryEntry[]}
     */
    pickables() {
        return [...this._pickable];
    }

    /**
     * Index into the cached toArray for a given tag.
     * No external array needed -- indexes into registry's own cache.
     * @param {number} index
     * @param {string} [tag='grid']
     * @returns {RegistryEntry|null}
     */
    getByIndex(index, tag = 'grid') {
        const arr = this.toArray(tag);
        if (index < 0 || index >= arr.length) return null;
        const grid = arr[index];
        const id = this._gridToId.get(grid);
        return id ? this._entries.get(id) : null;
    }

    /**
     * Get SPECIES counts summary.
     * @returns {Object<string, number>}
     */
    typeCounts() {
        const counts = {};
        for (const entry of this._entries.values()) {
            counts[entry.type] = (counts[entry.type] || 0) + 1;
        }
        return counts;
    }

    /**
     * Per-species role breakdown: type -> role -> count ('loose' for none).
     * @returns {Object<string, Object<string, number>>}
     */
    roleCounts() {
        const counts = {};
        for (const entry of this._entries.values()) {
            const t = counts[entry.type] ?? (counts[entry.type] = {});
            const r = entry.role || 'loose';
            t[r] = (t[r] || 0) + 1;
        }
        return counts;
    }

    /** @returns {number} */
    get size() {
        return this._entries.size;
    }

    /**
     * Run `fn` with change notifications HELD: every mutation inside records its
     * type; the OUTERMOST close fires each distinct type once. Listeners are
     * state-scanners (they read the registry, not the event), so one coalesced
     * fire is equivalent to N — this is ContentTree.batchRelayouts' discipline
     * for the registry. Re-entrant; works for sync and async `fn`; a throw still
     * closes (and fires what was recorded). Long-running holds (a streamed bulk
     * load) can flushHeld() at their own cadence so latency-sensitive listeners
     * (the dock projector) stay fresh without paying the per-grid storm.
     * @template T @param {() => T|Promise<T>} fn @returns {T|Promise<T>}
     */
    holdChanges(fn) {
        this._holdDepth++;
        let result;
        try {
            result = fn();
        } catch (e) {
            this._closeHold();
            throw e;
        }
        if (result && typeof result.then === 'function') {
            return result.finally(() => this._closeHold());
        }
        this._closeHold();
        return result;
    }

    /** Fire the types recorded so far WITHOUT closing the hold — the mid-stream
     *  heartbeat for long windows. No-op when nothing is held. */
    flushHeld() {
        if (this._heldTypes.size === 0) return;
        const types = [...this._heldTypes];
        this._heldTypes.clear();
        for (const t of types) this._fire(t);
    }

    /** @private */
    _closeHold() {
        if (--this._holdDepth === 0) this.flushHeld();
    }

    /**
     * Subscribe to change notifications.
     * @param {Function} fn - called with (type: string)
     */
    addChangeListener(fn) {
        this._changeListeners.add(fn);
    }

    /**
     * Unsubscribe from change notifications.
     * @param {Function} fn
     */
    removeChangeListener(fn) {
        this._changeListeners.delete(fn);
    }

    // -- Internal -------------------------------------------------------

    /**
     * Invalidate the cached array for a type and fire (or hold) the onChange hook.
     * @param {string} type
     * @private
     */
    _invalidateCache(type) {
        this._typeCache.delete(type);
        if (this._holdDepth > 0) { this._heldTypes.add(type); return; }
        this._fire(type);
    }

    /** @private */
    _fire(type) {
        for (const cb of this._changeListeners) {
            try { cb(type); } catch (e) {
                console.error('[registry] onChange error:', e);
            }
        }
    }
}
