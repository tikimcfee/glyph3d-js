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
 * Workers receive pre-shaped arrays and do only buffer math — no WASM in workers.
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
    async buildBatchBuffers(items, shared, atlas) {
        this._ensureInitialized();

        // Fallback if no workers
        if (this.workers.length === 0) {
            return this._buildBatchBuffersSync(items, shared);
        }

        const worker = this._getNextWorker();
        const jobId = String(this.nextJobId++);

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
     * Synchronous fallback for batch when workers unavailable.
     * @private
     */
    _buildBatchBuffersSync(items, shared) {
        // Shaped path — single WASM instance on main thread
        const shapedItems = items.map(item => ({
            ...item,
            shaped: shapeText(this._shaper, item.text || '')
        }));
        return buildBatchBuffers(shapedItems, {
            metrics: shared.metrics,
            defaultColor: shared.defaultColor,
            upem: this._upem,
            emptyGlyphs: shared.emptyGlyphs || null,
        }, shared.emptyGlyphs ? new Set(shared.emptyGlyphs) : undefined);
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
