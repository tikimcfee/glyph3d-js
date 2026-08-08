/**
 * SyntaxParsePool — the main-thread handle on worker-pool colorization.
 *
 * colorize(text, descriptor) → { palette, packed, parseMs }.
 *
 * Two backends behind the ONE result shape (the SessionParsePool discipline):
 *   - a demand-driven POOL of SyntaxParseWorkers (production): jobs are pure
 *     (text + descriptor in, palette bytes out — no shared state), so any
 *     worker takes any job; results transfer back zero-copy. A bulk load's
 *     1500 parses fan out across the pool instead of blocking the frame loop
 *     (~1.4s of main-thread wasm at 1500 files, measured).
 *   - the main-thread job itself (fallback: no Worker — tests, headless).
 *
 * Pool cap: each worker carries its OWN tree-sitter wasm heap (runtime + every
 * grammar it has seen, ~MBs each), so the cap stays below the generic
 * hardware-concurrency convention — parse jobs are ~1ms, throughput saturates
 * with a few workers.
 */

import { runSyntaxPaletteJob } from './syntaxPaletteJob.js';

const POOL_MAX = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 4) - 1));

export class SyntaxParsePool {
    constructor() {
        /** @private */ this._workers = null;      // [{ w, busy }] — null until first job
        /** @private */ this._spawnFailed = false;
        /** @private */ this._nextJobId = 0;
        /** @private */ this._byJobId = new Map(); // jobId -> { worker, resolve, reject }
        /** @private */ this._queue = [];          // jobs waiting on a free worker
    }

    /** @returns {number} live worker count (0 = main-thread fallback) */
    get workerCount() { return this._workers?.length ?? 0; }

    /**
     * Colorize `text`. Resolves with the palette job's result whichever backend runs.
     * @param {string} text
     * @param {{ key:string, grammarUrl:string, query:string }} descriptor
     * @returns {Promise<{ palette: Uint8Array, packed: Uint32Array, parseMs: number }>}
     */
    colorize(text, descriptor) {
        if (!this._workersAvailable()) return runSyntaxPaletteJob(text, descriptor);
        return new Promise((resolve, reject) => {
            const job = { text, descriptor, resolve, reject };
            const free = this._workers.find((s) => !s.busy);
            if (free) this._dispatch(free, job);
            else if (this._workers.length < POOL_MAX) {
                const slot = this._spawn();
                if (slot) this._dispatch(slot, job);
                else this._queue.push(job);   // spawn failed mid-run — queue on existing
            } else this._queue.push(job);
        });
    }

    /** @private */
    _workersAvailable() {
        if (this._spawnFailed || typeof Worker === 'undefined') return false;
        if (this._workers === null) {
            this._workers = [];
            if (!this._spawn()) { this._spawnFailed = true; return false; }
        }
        return this._workers.length > 0 || !this._spawnFailed;
    }

    /** @private */
    _spawn() {
        try {
            const w = new Worker(new URL('./SyntaxParseWorker.js', import.meta.url), { type: 'module' });
            const slot = { w, busy: null };
            w.onmessage = (e) => this._onResult(slot, e.data);
            w.onerror = (err) => {
                // A dead worker fails its in-flight job loudly and leaves the pool;
                // queued jobs re-dispatch (or fall back once no workers remain).
                console.error('[syntax-pool] worker error:', err?.message ?? err);
                const inflight = slot.busy;
                slot.busy = null;
                this._workers = this._workers.filter((s) => s !== slot);
                try { w.terminate(); } catch { /* already gone */ }
                if (this._workers.length === 0) this._spawnFailed = true;
                if (inflight) inflight.reject(new Error(`syntax worker died: ${err?.message ?? err}`));
                this._drainQueue();
            };
            this._workers.push(slot);
            return slot;
        } catch (err) {
            console.warn('[syntax-pool] worker spawn failed — colorize runs on the main thread:', err?.message ?? err);
            this._spawnFailed = true;
            return null;
        }
    }

    /** @private */
    _dispatch(slot, job) {
        const jobId = this._nextJobId++;
        slot.busy = job;
        job.id = jobId;
        this._byJobId.set(jobId, { slot, job });
        slot.w.postMessage({ jobId, text: job.text, descriptor: job.descriptor });
    }

    /** @private */
    _onResult(slot, data) {
        const entry = this._byJobId.get(data?.jobId);
        if (!entry) return;
        this._byJobId.delete(data.jobId);
        slot.busy = null;
        if (data.ok) entry.job.resolve({ palette: data.palette, packed: data.packed, parseMs: data.parseMs });
        else entry.job.reject(new Error(data.error || 'syntax parse failed'));
        this._drainQueue();
    }

    /** @private */
    _drainQueue() {
        while (this._queue.length) {
            if (this._workersAvailable() && this._workers.length) {
                const free = this._workers.find((s) => !s.busy);
                if (!free) {
                    if (this._workers.length < POOL_MAX) {
                        const slot = this._spawn();
                        if (slot) { this._dispatch(slot, this._queue.shift()); continue; }
                    }
                    return;   // all busy at cap — results re-drain
                }
                this._dispatch(free, this._queue.shift());
            } else {
                // No workers left at all: run the remainder on the main thread.
                const job = this._queue.shift();
                runSyntaxPaletteJob(job.text, job.descriptor).then(job.resolve, job.reject);
            }
        }
    }
}

let _pool = null;
/** The app-wide pool (lazy). */
export function getSyntaxParsePool() {
    if (!_pool) _pool = new SyntaxParsePool();
    return _pool;
}
