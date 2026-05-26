/**
 * RepositoryContentCache - In-memory cache for repository content
 *
 * Provides fast access to previously fetched repository trees and files.
 * Supports TTL-based expiration and max size limits.
 */

export class RepositoryContentCache {
    constructor(options = {}) {
        // Cache storage: Map<key, CacheEntry>
        this.cache = new Map();

        // Cache TTL in milliseconds (default: 5 minutes)
        this.ttl = options.ttl || 5 * 60 * 1000;

        // Maximum cache size in entries (default: 1000)
        this.maxSize = options.maxSize || 1000;

        // Statistics
        this.stats = {
            hits: 0,
            misses: 0,
            size: 0,
            evictions: 0,
        };
    }

    /**
     * Generate cache key for repository content
     * @param {string} type - 'tree' or 'file'
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} path - File path or branch
     * @param {string} branch - Branch name
     * @returns {string} - Cache key
     */
    static makeKey(type, owner, repo, path, branch = 'main') {
        return `${type}:${owner}/${repo}@${branch}:${path || ''}`;
    }

    /**
     * Get data from cache
     * @param {string} key - Cache key
     * @returns {Object|null} - Cached data or null if not found/expired
     */
    async get(key) {
        const entry = this.cache.get(key);

        if (!entry) {
            this.stats.misses++;
            return null;
        }

        // Check if entry has expired
        if (this._isExpired(entry)) {
            this.cache.delete(key);
            this.stats.misses++;
            this.stats.size = this.cache.size;
            return null;
        }

        // Update access time for LRU-like behavior
        entry.accessedAt = Date.now();
        this.stats.hits++;
        return entry.data;
    }

    /**
     * Set data in cache
     * @param {string} key - Cache key
     * @param {Object} data - Data to cache
     */
    async set(key, data) {
        // Enforce max size by evicting oldest entries
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            this._evictOldest();
        }

        const entry = {
            data: data,
            fetchedAt: Date.now(),
            accessedAt: Date.now(),
        };

        this.cache.set(key, entry);
        this.stats.size = this.cache.size;
    }

    /**
     * Check if cache has a valid entry for key
     * @param {string} key - Cache key
     * @returns {Promise<boolean>}
     */
    async has(key) {
        const result = await this.get(key);
        return result !== null;
    }

    /**
     * Remove entry from cache
     * @param {string} key - Cache key
     * @returns {boolean} - True if entry was in cache
     */
    remove(key) {
        const result = this.cache.delete(key);
        this.stats.size = this.cache.size;
        return result;
    }

    /**
     * Clear entire cache
     */
    clear() {
        this.cache.clear();
        this.stats.size = 0;
        this.stats.hits = 0;
        this.stats.misses = 0;
        this.stats.evictions = 0;
    }

    /**
     * Clear only expired entries
     * @returns {number} - Number of entries removed
     */
    clearExpired() {
        let removed = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (this._isExpired(entry)) {
                this.cache.delete(key);
                removed++;
            }
        }

        this.stats.size = this.cache.size;
        return removed;
    }

    /**
     * Get cache statistics
     * @returns {Object} - Cache statistics
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(2) : 0;

        return {
            size: this.stats.size,
            maxSize: this.maxSize,
            hits: this.stats.hits,
            misses: this.stats.misses,
            evictions: this.stats.evictions,
            hitRate: `${hitRate}%`,
            ttl: this.ttl,
        };
    }

    /**
     * Check if cache entry has expired
     * @private
     */
    _isExpired(entry) {
        const age = Date.now() - entry.fetchedAt;
        return age > this.ttl;
    }

    /**
     * Evict oldest (least recently accessed) entry
     * @private
     */
    _evictOldest() {
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.accessedAt < oldestTime) {
                oldestTime = entry.accessedAt;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.stats.evictions++;
            this.stats.size = this.cache.size;
        }
    }

    /**
     * Get all keys in cache
     * @returns {string[]} - Array of cache keys
     */
    getKeys() {
        return Array.from(this.cache.keys());
    }

    /**
     * Invalidate all entries for a repository
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @returns {number} - Number of entries invalidated
     */
    invalidateRepository(owner, repo) {
        const prefix = `:${owner}/${repo}@`;
        let removed = 0;

        for (const key of this.cache.keys()) {
            if (key.includes(prefix)) {
                this.cache.delete(key);
                removed++;
            }
        }

        this.stats.size = this.cache.size;
        return removed;
    }

    /**
     * Get cache size in bytes (approximate)
     * @returns {number} - Approximate size in bytes
     */
    getSizeBytes() {
        let totalSize = 0;

        for (const entry of this.cache.values()) {
            // Rough estimate of entry size
            totalSize += JSON.stringify(entry.data).length;
        }

        return totalSize;
    }

    /**
     * Export cache as JSON (for debugging/persistence)
     * @returns {Object} - Serializable cache data
     */
    export() {
        const data = {
            version: 1,
            exportedAt: Date.now(),
            ttl: this.ttl,
            entries: [],
        };

        for (const [key, entry] of this.cache.entries()) {
            // Skip expired entries during export
            if (!this._isExpired(entry)) {
                data.entries.push({
                    key,
                    data: entry.data,
                    fetchedAt: entry.fetchedAt,
                    accessedAt: entry.accessedAt,
                });
            }
        }

        return data;
    }

    /**
     * Import cache from JSON
     * @param {Object} data - Exported cache data
     * @returns {number} - Number of entries imported
     */
    import(data) {
        if (!data || !data.entries) {
            throw new Error('Invalid cache data');
        }

        let imported = 0;

        for (const entry of data.entries) {
            // Check entry hasn't expired based on original fetchedAt
            const age = Date.now() - entry.fetchedAt;
            if (age <= this.ttl) {
                this.cache.set(entry.key, {
                    data: entry.data,
                    fetchedAt: entry.fetchedAt,
                    accessedAt: Date.now(),
                });
                imported++;
            }
        }

        this.stats.size = this.cache.size;
        return imported;
    }
}

export default RepositoryContentCache;
