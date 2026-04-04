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
import { buildGlyphBuffers, buildBatchBuffers, buildShapedBatchBuffers } from './builders/index.js';
import { shapeText } from '../shaping/shapeText.js';

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
        // Tracks the atlas._uvMapVersion at time of last serialization.
        // Initialized to -1 so the first call always serializes fresh.
        this._uvMapVersion = -1;

        // Lazy initialization flag
        this._initialized = false;

        // Main-thread HarfBuzz shaper (set via setShaper())
        this._shaper = null;
        this._upem = 0;
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

        console.debug(`[WorkerBridge] Initialized ${this.workers.length} workers`);
        this._initialized = true;
    }

    /**
     * Register the main-thread HarfBuzz shaper.
     *
     * Workers no longer run WASM. Text is shaped here on the main thread and
     * the pre-shaped glyph arrays are attached to each item before posting.
     * This eliminates N×16MB WASM heaps (one per worker) and prevents OOM
     * when loading large repositories.
     *
     * @param {import('../shaping/HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     */
    setShaper(shaper) {
        this._shaper = shaper;
        this._upem = shaper ? shaper.upem : 0;
        console.debug(`[WorkerBridge] Main-thread shaper registered (upem=${this._upem})`);
    }

    /** @returns {boolean} Whether the main-thread shaper is ready */
    get fontReady() { return this._shaper != null && this._shaper.ready; }

    /**
     * Get serialized UV map from atlas (version-aware cache).
     *
     * Caches on atlas identity AND atlas._uvMapVersion. When either changes
     * (new atlas or ensureCodepoints() added new glyphs), the cache is busted,
     * all workers have their _hasUVMap flag cleared (forcing re-send of the
     * fresh UV map on their next dispatch), and the new serialized map is stored.
     *
     * @param {GlyphAtlas} atlas
     * @returns {Object} Plain object map: charCode → {u0, v0, u1, v1}
     */
    getSerializedUVMap(atlas) {
        const version = atlas._uvMapVersion || 0;

        // Return cached if same atlas and UV map has not changed
        if (this._uvMapAtlas === atlas && this._uvMapVersion === version && this._uvMapCache) {
            return this._uvMapCache;
        }

        // Atlas changed or version advanced — bust cache and reset per-worker warm
        // flags so each worker receives the fresh UV map on its next job dispatch.
        for (const worker of this.workers) {
            worker._hasUVMap = false;
        }

        // Serialize UV map from atlas
        if (typeof atlas.getSerializableUVMap === 'function') {
            this._uvMapCache = atlas.getSerializableUVMap();
        } else {
            // Fallback: iterate over uvMap (grapheme string → UV) and _graphemeIds for numericId
            const map = {};
            if (atlas.uvMap) {
                for (const [grapheme, uv] of atlas.uvMap) {
                    const numericId = atlas._graphemeIds ? atlas._graphemeIds.get(grapheme) : undefined;
                    map[grapheme] = numericId !== undefined ? { ...uv, numericId } : uv;
                }
            }
            this._uvMapCache = map;
        }

        this._uvMapAtlas = atlas;
        this._uvMapVersion = version;

        // Serialize per-glyph widths alongside UV map (same cache lifecycle).
        // Stored in canvas pixels — the builder multiplies by worldScale
        // (sent via metrics) to get world-space widths.
        // Keys are grapheme cluster strings (matching the new string-keyed uvMap).
        if (typeof atlas.getSerializableGlyphWidths === 'function') {
            this._glyphWidthsCache = atlas.getSerializableGlyphWidths();
        } else {
            // Fallback for atlas instances that haven't been updated yet
            const widths = {};
            if (atlas.metrics) {
                for (const [key, m] of atlas.metrics) {
                    widths[key] = m.width;
                }
            }
            this._glyphWidthsCache = widths;
        }

        return this._uvMapCache;
    }

    /**
     * Get cached per-glyph widths (serialized from atlas.metrics).
     * Must call getSerializedUVMap() first to populate the cache.
     * @returns {Object} Plain object map: charCode → width (number)
     */
    getSerializedGlyphWidths() {
        return this._glyphWidthsCache || {};
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
     * @returns {Promise<{positions, sizes, codepoints, colors, count}>}
     */
    async buildBuffers(input, metrics, atlas) {
        this._ensureInitialized();

        // Fallback if no workers
        if (this.workers.length === 0) {
            return this._buildBuffersSync(input, metrics, atlas);
        }

        const uvMap = this.getSerializedUVMap(atlas);
        const glyphWidths = this.getSerializedGlyphWidths();
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
                    uvMap,
                    glyphWidths
                }
            });
        });
    }

    /**
     * Build buffers for multiple texts (batch)
     *
     * When a main-thread shaper is available (set via setShaper()), each item's
     * text is shaped here before being posted to a worker. The worker receives
     * item.shaped = {lines, totalGlyphs} and calls buildShapedBatchBuffers()
     * without any WASM involvement.
     *
     * Falls back to the grapheme/UV-map path when no shaper is registered.
     *
     * @param {Array<{text, position, color?, scale?, alignment?}>} items
     * @param {Object} shared
     * @param {Object} shared.metrics - Font metrics
     * @param {{r,g,b}} shared.defaultColor - Default color
     * @param {GlyphAtlas} atlas - For UV map (legacy fallback path)
     * @returns {Promise<{positions, sizes, codepoints, colors, count}>}
     */
    async buildBatchBuffers(items, shared, atlas) {
        this._ensureInitialized();

        // Fallback if no workers
        if (this.workers.length === 0) {
            return this._buildBatchBuffersSync(items, shared, atlas);
        }

        const worker = this._getNextWorker();
        const jobId = String(this.nextJobId++);

        if (this._shaper && this._shaper.ready) {
            // Shape all items on the main thread — single WASM instance, no per-worker copies.
            // shapeText() is fast (< 1ms per average file). The shaped result is plain JSON
            // (arrays of {g, cl, ax, ay, dx, dy}) and transfers cleanly via structured clone.
            const shapedItems = items.map(item => {
                const shapedResult = shapeText(this._shaper, item.text || '');
                return { ...item, shaped: shapedResult };
            });

            return new Promise((resolve, reject) => {
                this.pendingRequests.set(jobId, { resolve, reject });
                worker.postMessage({
                    type: 'BUILD_BATCH',
                    jobId,
                    payload: {
                        items: shapedItems,
                        shared: {
                            metrics: shared.metrics,
                            defaultColor: shared.defaultColor,
                            upem: this._upem,
                            emptyGlyphs: shared.emptyGlyphs || null,
                        }
                    }
                });
            });
        }

        // Legacy path: send UV map for grapheme-based building
        const uvMap = this.getSerializedUVMap(atlas);
        const needsUVMap = !worker._hasUVMap;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(jobId, { resolve, reject });

            const glyphWidths = needsUVMap ? this.getSerializedGlyphWidths() : null;
            worker.postMessage({
                type: 'BUILD_BATCH',
                jobId,
                payload: {
                    items,
                    shared: {
                        metrics: shared.metrics,
                        defaultColor: shared.defaultColor,
                        uvMap: needsUVMap ? uvMap : null,
                        glyphWidths
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
        const glyphWidths = this.getSerializedGlyphWidths();

        return buildGlyphBuffers({
            text: input.text,
            position: input.position,
            color: input.color,
            scale: input.scale || 1.0,
            alignment: input.alignment || 'left',
            groupId: input.groupId || 0,
            metrics,
            uvMap,
            glyphWidths
        });
    }

    /**
     * Synchronous fallback for batch
     * @private
     */
    _buildBatchBuffersSync(items, shared, atlas) {
        if (this._shaper && this._shaper.ready) {
            // Shaped path — single WASM instance on main thread
            const shapedItems = items.map(item => ({
                ...item,
                shaped: shapeText(this._shaper, item.text || '')
            }));
            return buildShapedBatchBuffers(shapedItems, {
                metrics: shared.metrics,
                defaultColor: shared.defaultColor,
                upem: this._upem,
                emptyGlyphs: shared.emptyGlyphs || null,
            }, shared.emptyGlyphs ? new Set(shared.emptyGlyphs) : undefined);
        }

        const uvMap = this.getSerializedUVMap(atlas);
        const glyphWidths = this.getSerializedGlyphWidths();

        return buildBatchBuffers(items, {
            metrics: shared.metrics,
            defaultColor: shared.defaultColor,
            uvMap,
            glyphWidths
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
            shaperReady: this.fontReady,
            uvMapCached: !!this._uvMapCache
        };
    }

    /**
     * Dispose all workers.
     */
    dispose() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.pendingRequests.clear();
        this._uvMapCache = null;
        this._uvMapAtlas = null;
        this._shaper = null;
        this._upem = 0;
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
