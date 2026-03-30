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

        /** @type {Map<string, Object[]>} type -> cached frozen array of grid objects */
        this._typeCache = new Map();

        /** @type {Function|null} external change listener */
        this._onChange = null;
    }

    // -- Mutation -------------------------------------------------------

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
     * Alias for unregister -- reads better at removal call sites.
     * @param {string} id
     * @returns {RegistryEntry|null}
     */
    removeById(id) {
        return this.unregister(id);
    }

    /**
     * Remove all entries of a given type.
     * Returns removed entries (caller iterates for disposal).
     * Fires a single cache invalidation after all removals.
     * @param {string} type
     * @returns {RegistryEntry[]}
     */
    unregisterByType(type) {
        const removed = [];
        for (const [id, entry] of this._entries) {
            if (entry.type === type) {
                this._entries.delete(id);
                this._gridToId.delete(entry.grid);
                removed.push(entry);
            }
        }
        if (removed.length > 0) {
            this._invalidateCache(type);
        }
        return removed;
    }

    /**
     * Re-order entries of a given type according to a comparator.
     * Compares RegistryEntry objects (access .grid, .meta, .id).
     * Rebuilds Map insertion order via delete + re-insert (ES2015 spec).
     * @param {string} type
     * @param {(a: RegistryEntry, b: RegistryEntry) => number} compareFn
     */
    sortByType(type, compareFn) {
        const entries = this.findByType(type);
        entries.sort(compareFn);
        // Rebuild Map insertion order: delete then re-insert in sorted order
        for (const entry of entries) {
            this._entries.delete(entry.id);
        }
        for (const entry of entries) {
            this._entries.set(entry.id, entry);
        }
        this._invalidateCache(type);
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
     * Cached frozen array of grid objects for a given type.
     * Rebuilt only when entries of that type change.
     * Insertion-order stable (Map preserves insertion order).
     * @param {string} type
     * @returns {Object[]} frozen array of grid/scene objects (not entries)
     */
    toArray(type) {
        if (!this._typeCache.has(type)) {
            const arr = [];
            for (const entry of this._entries.values()) {
                if (entry.type === type) arr.push(entry.grid);
            }
            this._typeCache.set(type, Object.freeze(arr));
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
     * No external array needed -- indexes into registry's own cache.
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

    /**
     * Get type counts summary.
     * @returns {Object<string, number>}
     */
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

    // -- Internal -------------------------------------------------------

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
