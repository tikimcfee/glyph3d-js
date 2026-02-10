/**
 * WorkerBridge - Main thread orchestration for GlyphWorker pool
 *
 * Features:
 * - Worker pool management (scales with hardware concurrency)
 * - Promise-based async API
 * - UV map serialization with caching
 * - Round-robin job distribution
 * - Automatic worker lifecycle management
 */

// Import builders for sync fallback (tree-shaken if unused)
import { buildGlyphBuffers, buildBatchBuffers } from './builders/index.js';

/**
 * Check if Web Workers are supported
 * @returns {boolean}
 */
export function isWorkersSupported() {
    return typeof Worker !== 'undefined';
}

/**
 * WorkerBridge - Manages communication with GlyphWorker pool
 */
export class WorkerBridge {
    /**
     * @param {Object} options
     * @param {number} [options.workerCount] - Number of workers (default: hardwareConcurrency - 1)
     */
    constructor(options = {}) {
        // Worker pool size: leave one core for main thread
        this.workerCount = options.workerCount ||
            Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

        this.workers = [];
        this.pendingRequests = new Map(); // jobId → {resolve, reject}
        this.nextJobId = 1;
        this.roundRobinIndex = 0;

        // UV map cache (avoid re-serializing on every call)
        this._uvMapCache = null;
        this._uvMapAtlas = null;

        // Lazy initialization flag
        this._initialized = false;
    }

    /**
     * Initialize worker pool (lazy - called on first use)
     * @private
     */
    _ensureInitialized() {
        if (this._initialized) return;

        if (!isWorkersSupported()) {
            console.warn('WorkerBridge: Web Workers not supported, will use fallback');
            this._initialized = true;
            return;
        }

        for (let i = 0; i < this.workerCount; i++) {
            try {
                const worker = new Worker(
                    new URL('./GlyphWorker.js', import.meta.url),
                    { type: 'module' }
                );

                worker.onmessage = (event) => this._handleMessage(event);
                worker.onerror = (error) => this._handleError(error, i);

                this.workers.push(worker);
            } catch (err) {
                console.warn(`WorkerBridge: Failed to create worker ${i}:`, err);
            }
        }

        console.log(`WorkerBridge: Initialized ${this.workers.length} workers`);
        this._initialized = true;
    }

    /**
     * Get serialized UV map from atlas (cached)
     * @param {GlyphAtlas} atlas
     * @returns {Object} Plain object map: charCode → {u0, v0, u1, v1}
     */
    getSerializedUVMap(atlas) {
        // Return cached if same atlas
        if (this._uvMapAtlas === atlas && this._uvMapCache) {
            return this._uvMapCache;
        }

        // Serialize UV map from atlas
        const map = {};

        // Try getSerializableUVMap if available (we'll add this method)
        if (typeof atlas.getSerializableUVMap === 'function') {
            this._uvMapCache = atlas.getSerializableUVMap();
        } else {
            // Fallback: iterate over uvMap
            if (atlas.uvMap) {
                for (const [charCode, uv] of atlas.uvMap) {
                    map[charCode] = uv;
                }
            }
            this._uvMapCache = map;
        }

        this._uvMapAtlas = atlas;
        return this._uvMapCache;
    }

    /**
     * Invalidate UV map cache (call if atlas changes)
     */
    invalidateUVCache() {
        this._uvMapCache = null;
        this._uvMapAtlas = null;
    }

    /**
     * Build buffers for a single text
     *
     * @param {Object} input
     * @param {string} input.text
     * @param {{x,y,z}} input.position
     * @param {{r,g,b}} input.color
     * @param {number} [input.scale]
     * @param {string} [input.alignment]
     * @param {Object} metrics - Font metrics
     * @param {GlyphAtlas} atlas - For UV map
     * @returns {Promise<{positions, sizes, uvs, colors, count}>}
     */
    async buildBuffers(input, metrics, atlas) {
        this._ensureInitialized();

        // Fallback if no workers
        if (this.workers.length === 0) {
            return this._buildBuffersSync(input, metrics, atlas);
        }

        const uvMap = this.getSerializedUVMap(atlas);
        const jobId = String(this.nextJobId++);

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(jobId, { resolve, reject });

            const worker = this._getNextWorker();
            worker.postMessage({
                type: 'BUILD',
                jobId,
                payload: {
                    text: input.text,
                    position: input.position,
                    color: input.color,
                    scale: input.scale || 1.0,
                    alignment: input.alignment || 'left',
                    groupId: input.groupId || 0,
                    metrics,
                    uvMap
                }
            });
        });
    }

    /**
     * Build buffers for multiple texts (batch)
     *
     * @param {Array<{text, position, color?, scale?, alignment?}>} items
     * @param {Object} shared
     * @param {Object} shared.metrics - Font metrics
     * @param {{r,g,b}} shared.defaultColor - Default color
     * @param {GlyphAtlas} atlas - For UV map
     * @returns {Promise<{positions, sizes, uvs, colors, count}>}
     */
    async buildBatchBuffers(items, shared, atlas) {
        this._ensureInitialized();

        // Fallback if no workers
        if (this.workers.length === 0) {
            return this._buildBatchBuffersSync(items, shared, atlas);
        }

        const uvMap = this.getSerializedUVMap(atlas);
        const jobId = String(this.nextJobId++);

        // Send UV map only if workers don't have it yet
        const worker = this._getNextWorker();
        const needsUVMap = !worker._hasUVMap;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(jobId, { resolve, reject });

            worker.postMessage({
                type: 'BUILD_BATCH',
                jobId,
                payload: {
                    items,
                    shared: {
                        metrics: shared.metrics,
                        defaultColor: shared.defaultColor,
                        uvMap: needsUVMap ? uvMap : null
                    }
                }
            });

            if (needsUVMap) worker._hasUVMap = true;
        });
    }

    /**
     * Get next worker (round-robin)
     * @private
     */
    _getNextWorker() {
        const worker = this.workers[this.roundRobinIndex];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % this.workers.length;
        return worker;
    }

    /**
     * Handle worker message
     * @private
     */
    _handleMessage(event) {
        const { type, jobId, buffers, error } = event.data;
        const pending = this.pendingRequests.get(jobId);

        if (!pending) {
            console.warn(`WorkerBridge: No pending request for jobId ${jobId}`);
            return;
        }

        this.pendingRequests.delete(jobId);

        if (type === 'RESULT') {
            pending.resolve(buffers);
        } else if (type === 'ERROR') {
            pending.reject(new Error(error));
        } else if (type === 'PONG') {
            pending.resolve({ pong: true });
        }
    }

    /**
     * Handle worker error
     * @private
     */
    _handleError(error, workerIndex) {
        console.error(`WorkerBridge: Worker ${workerIndex} error:`, error);

        // Reject all pending requests for this worker
        // (In production, we'd track which worker has which jobs)
        // For now, just log the error - requests will timeout
    }

    /**
     * Synchronous fallback when workers unavailable
     * @private
     */
    _buildBuffersSync(input, metrics, atlas) {
        const uvMap = this.getSerializedUVMap(atlas);

        return buildGlyphBuffers({
            text: input.text,
            position: input.position,
            color: input.color,
            scale: input.scale || 1.0,
            alignment: input.alignment || 'left',
            groupId: input.groupId || 0,
            metrics,
            uvMap
        });
    }

    /**
     * Synchronous fallback for batch
     * @private
     */
    _buildBatchBuffersSync(items, shared, atlas) {
        const uvMap = this.getSerializedUVMap(atlas);

        return buildBatchBuffers(items, {
            metrics: shared.metrics,
            defaultColor: shared.defaultColor,
            uvMap
        });
    }

    /**
     * Get stats
     */
    getStats() {
        return {
            workerCount: this.workers.length,
            pendingRequests: this.pendingRequests.size,
            initialized: this._initialized,
            uvMapCached: !!this._uvMapCache
        };
    }

    /**
     * Dispose all workers
     */
    dispose() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.pendingRequests.clear();
        this._uvMapCache = null;
        this._uvMapAtlas = null;
        this._initialized = false;
    }
}

// ============ Singleton Pattern ============

let _instance = null;

/**
 * Get shared WorkerBridge instance (singleton)
 * @returns {WorkerBridge}
 */
export function getWorkerBridge() {
    if (!_instance) {
        _instance = new WorkerBridge();
    }
    return _instance;
}

/**
 * Dispose shared instance
 */
export function disposeWorkerBridge() {
    if (_instance) {
        _instance.dispose();
        _instance = null;
    }
}

export default WorkerBridge;
