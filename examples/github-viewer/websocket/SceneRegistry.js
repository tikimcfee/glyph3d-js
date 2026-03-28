/**
 * SceneRegistry -- stable ID-based registry for all scene objects.
 *
 * Replaces ad-hoc discovery via array indices and 5+ naming conventions
 * (agent:, tui-, [title], filename, name) with a single Map keyed by
 * user-provided string IDs.
 *
 * Types: 'grid', 'window', 'annotation', 'label', 'agent', 'tour-annotation'
 *
 * The registry is additive — it augments the existing grids array, not replaces it.
 * Backward compat: index-based commands continue to work via getByIndex().
 */

/**
 * @typedef {Object} RegistryEntry
 * @property {string} id - stable string identifier
 * @property {Object} grid - CodeGrid instance (or any scene object)
 * @property {string} type - one of: grid, window, annotation, label, agent, tour-annotation
 * @property {Object} meta - arbitrary metadata (sourcePath, windowId, etc.)
 */

export default class SceneRegistry {
    constructor() {
        /** @type {Map<string, RegistryEntry>} id → entry */
        this._entries = new Map();

        /** @type {Map<Object, string>} grid → id (reverse lookup) */
        this._gridToId = new Map();
    }

    /**
     * Register a scene object with a stable ID and type tag.
     * @param {string} id - unique identifier (caller-chosen)
     * @param {Object} grid - CodeGrid or scene object
     * @param {Object} opts
     * @param {string} opts.type - 'grid' | 'window' | 'annotation' | 'label' | 'agent' | 'tour-annotation'
     * @param {Object} [opts.*] - additional metadata fields
     * @returns {RegistryEntry}
     */
    register(id, grid, { type, ...meta }) {
        if (this._entries.has(id)) {
            // Update existing entry (re-register with new grid/meta)
            const existing = this._entries.get(id);
            this._gridToId.delete(existing.grid);
        }

        const entry = { id, grid, type, meta };
        this._entries.set(id, entry);
        this._gridToId.set(grid, id);
        return entry;
    }

    /**
     * Remove a registered object.
     * @param {string} id
     * @returns {RegistryEntry|null} the removed entry, or null if not found
     */
    unregister(id) {
        const entry = this._entries.get(id);
        if (!entry) return null;
        this._entries.delete(id);
        this._gridToId.delete(entry.grid);
        return entry;
    }

    /**
     * Get an entry by ID.
     * @param {string} id
     * @returns {RegistryEntry|null}
     */
    get(id) {
        return this._entries.get(id) || null;
    }

    /**
     * Check if an ID is registered.
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
        return this._entries.has(id);
    }

    /**
     * Find all entries of a given type.
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
     * Find entries by a metadata key-value match.
     * @param {string} key - metadata key
     * @param {*} value - value to match
     * @returns {RegistryEntry[]}
     */
    findByMeta(key, value) {
        const results = [];
        for (const entry of this._entries.values()) {
            if (entry.meta[key] === value) results.push(entry);
        }
        return results;
    }

    /**
     * List all registered entries.
     * @returns {RegistryEntry[]}
     */
    list() {
        return [...this._entries.values()];
    }

    /**
     * Reverse lookup: get the registry ID for a grid object reference.
     * @param {Object} grid
     * @returns {string|null}
     */
    getIdByGrid(grid) {
        return this._gridToId.get(grid) || null;
    }

    /**
     * Index compatibility: look up grids[index] and find its registry entry.
     * Supports legacy index-based commands.
     * @param {number} index - array index
     * @param {Array} grids - the grids array from ctx.getGrids()
     * @returns {RegistryEntry|null}
     */
    getByIndex(index, grids) {
        if (index < 0 || index >= grids.length) return null;
        const grid = grids[index];
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
}
