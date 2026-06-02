/**
 * WorkerBridge - Main thread orchestration for GlyphWorker pool
 *
 * Features:
 * - Worker pool management (scales with hardware concurrency)
 * - Promise-based async API
 * - Round-robin job distribution
 * - Automatic worker lifecycle management
 *
 * Text shaping runs once on the main thread (single HarfBuzz WASM instance).
 * When a MonospaceShapeCache is registered, shaping is O(1) Map lookups with
 * no WASM calls. Workers receive pre-shaped arrays and do only buffer math.
 */

// Import builder for sync fallback (tree-shaken if unused)
import { buildBatchBuffers } from './builders/index.js';
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

        // Lazy initialization flag
        this._initialized = false;

        // Main-thread HarfBuzz shaper (set via setShaper())
        this._shaper = null;
        this._upem = 0;
        // Optional MonospaceShapeCache — eliminates WASM calls when present
        this._shapeCache = null;
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

        // If a shape cache was registered before the pool existed, deliver it now
        // so these workers can shape locally on their first BUILD_BATCH.
        this._sendGlyphMapToWorkers();
    }

    /**
     * Register the main-thread HarfBuzz shaper and optional per-codepoint cache.
     *
     * When a MonospaceShapeCache is supplied, all shaping becomes O(1) Map lookups
     * with no WASM calls after the initial priming pass. The glyph map is transferred
     * to each worker once so workers are ready for future worker-side reconstruction
     * (Tier 3 optimization — not yet active).
     *
     * Workers no longer run WASM. Text is shaped here on the main thread and
     * the pre-shaped glyph arrays are attached to each item before posting.
     * This eliminates N×16MB WASM heaps (one per worker) and prevents OOM
     * when loading large repositories.
     *
     * @param {import('../shaping/HarfBuzzShaper.js').default} shaper - Initialized HarfBuzzShaper
     * @param {import('../shaping/MonospaceShapeCache.js').default} [shapeCache] - Optional per-codepoint cache
     */
    setShaper(shaper, shapeCache) {
        this._shaper = shaper;
        this._shapeCache = shapeCache || null;
        this._upem = shaper ? shaper.upem : 0;
        console.debug(
            `[WorkerBridge] Main-thread shaper registered (upem=${this._upem}, cached=${!!shapeCache})`
        );

        // Push the shape cache to any workers that already exist. Workers created
        // later get it in _ensureInitialized — between the two, every worker is
        // guaranteed to have the cache before its first BUILD_BATCH.
        this._sendGlyphMapToWorkers();
    }

    /**
     * Transfer the monospace shape cache to every worker so they shape raw text
     * locally (keeping bulky pre-shaped arrays out of postMessage). Each worker
     * needs its own copy — Transferable transfer neuters the source buffer.
     * No-op without a cache or workers; safe to call repeatedly.
     * @private
     */
    _sendGlyphMapToWorkers() {
        if (!this._shapeCache || this.workers.length === 0) return;
        const glyphMapArr = this._shapeCache.toTransferArray();
        for (const w of this.workers) {
            const copy = new Uint32Array(glyphMapArr);
            w.postMessage({ type: 'GLYPH_MAP', glyphMap: copy }, [copy.buffer]);
        }
        console.debug(
            `[WorkerBridge] Shape cache → ${this.workers.length} workers ` +
            `(${glyphMapArr.byteLength} bytes each)`
        );
    }

    /** @returns {boolean} Whether the main-thread shaper is ready */
    get fontReady() { return this._shaper != null && this._shaper.ready; }

    /**
     * Build buffers for multiple texts (batch).
     *
     * Text is shaped here on the main thread — single WASM instance, no per-worker copies.
     * The pre-shaped result is plain JSON (arrays of {g, cl, ax, ay, dx, dy}) and transfers
     * cleanly via structured clone.
     *
     * @param {Array<{text, position, color?, scale?, alignment?}>} items
     * @param {Object} shared
     * @param {Object} shared.metrics - Font metrics
     * @param {{r,g,b}} shared.defaultColor - Default color
     * @param {GlyphAtlas} [atlas] - Unused (kept for call-site compatibility)
     * @returns {Promise<{positions, sizes, codepoints, colors, count}>}
     */
    async buildBatchBuffers(items, shared) {
        this._ensureInitialized();

        // Fallback if no workers
        if (this.workers.length === 0) {
            return this.buildBatchBuffersSync(items, shared);
        }

        const worker = this._getNextWorker();
        const jobId = String(this.nextJobId++);

        // Shape all items on the main thread. When a MonospaceShapeCache is available,
        // shaping is O(1) Map lookups per character with no WASM calls. The result is
        // plain arrays of {g, ax, dx, dy} and transfers cleanly via structured clone.
        //
        // Only the fields buildBatchBuffers actually reads are included in each item.
        // Dead fields (text, id, options) are omitted to reduce structured clone cost:
        //   text  — ~12KB per file, never read by the builder
        //   id    — string key, never read by the builder
        //   options — object, never read by the builder
        // With a monospace cache, the worker shapes raw text locally — ship the
        // small text string instead of cloning the bulky pre-shaped {g,ax,dx,dy}
        // arrays (that structured clone was the dominant main-thread reload cost).
        // _ensureInitialized() above guarantees the worker has the cache before
        // this BUILD_BATCH (postMessage is FIFO per worker). Without a cache
        // (raw HarfBuzz shaper only, no WASM in workers) we still shape here.
        const workerItems = this._shapeCache
            ? items.map(item => ({
                position: item.position,
                color: item.color,
                scale: item.scale,
                groupId: item.groupId,
                text: item.text || '',
            }))
            : items.map(item => ({
                position: item.position,
                color: item.color,
                scale: item.scale,
                groupId: item.groupId,
                shaped: shapeText(this._shaper, item.text || ''),
            }));

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(jobId, { resolve, reject });
            worker.postMessage({
                type: 'BUILD_BATCH',
                jobId,
                payload: {
                    items: workerItems,
                    shared: {
                        metrics: shared.metrics,
                        defaultColor: shared.defaultColor,
                        upem: this._upem,
                        layout: shared.layout,  // per-grid layout params (structured-clone-safe)
                        scrollOffset: shared.scrollOffset,  // visual rows scrolled (Step 3c)
                    }
                }
            });
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
     * Synchronous batch build on the main thread — same builder as the worker
     * path, just without the postMessage round-trip. Used when no workers are
     * available and by callers that must build synchronously (e.g. CodeGrid's
     * loadText, where highlights are applied immediately after).
     */
    buildBatchBuffersSync(items, shared) {
        const shaperOrCache = this._shapeCache || this._shaper;
        const shapedItems = items.map(item => ({
            position: item.position,
            color: item.color,
            scale: item.scale,
            groupId: item.groupId,
            shaped: shapeText(shaperOrCache, item.text || ''),
        }));
        return buildBatchBuffers(shapedItems, {
            metrics: shared.metrics,
            defaultColor: shared.defaultColor,
            upem: this._upem,
            layout: shared.layout,  // per-grid layout params
            scrollOffset: shared.scrollOffset,  // visual rows scrolled (Step 3c)
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
        this._shaper = null;
        this._shapeCache = null;
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
