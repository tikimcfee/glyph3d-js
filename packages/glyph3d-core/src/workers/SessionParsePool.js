/**
 * SessionParsePool — the main-thread handle on the transcript codec.
 *
 * parseSessionOffThread(bytes, { harness, cwd, cap }) → { records, total, cwd, meta, … }.
 *
 * Two backends behind the ONE result shape:
 *   - a POOL of dedicated parse workers (production): jobs are idempotent pure
 *     functions (bytes + harness + cap in, records out — no shared state), so
 *     any worker can take any job. The transcript's ArrayBuffer is TRANSFERRED
 *     in (zero-copy); parse AND normalize run off-thread; only the capped,
 *     noise-filtered record tail clones back. A restore's 6-wide book pour fans
 *     out across the pool instead of serializing on one thread.
 *   - the main-thread sliced parsers (fallback: no Worker — tests, headless):
 *     parseClaudeSessionAsync / parseKimiSessionAsync, frame-budgeted, then the
 *     same eventsToRecords.
 */

import { runSessionParseJob, eventsToRecords } from './sessionParseJob.js';
import { parseClaudeSessionAsync, parseKimiSessionAsync } from '../collections/sessionAdapter.js';

// The pool is DEMAND-DRIVEN: one worker at first job, spawning another whenever
// work queues behind busy workers, capped at the project's hardware convention
// (WorkerBridge: hardwareConcurrency - 1). A single agent.open costs one worker;
// a restore's 12-book pour grows the pool to its wave width. The usual worker
// restraint — per-worker WASM heaps — does NOT apply (pure JS workers), and
// idle workers sleep, so grown workers stay for reuse rather than churning.
const POOL_MAX = Math.max(1, (globalThis.navigator?.hardwareConcurrency || 4) - 1);

export class SessionParsePool {
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
     * Parse a transcript's raw bytes into normalized book records.
     * @param {Uint8Array} bytes - raw JSONL transcript (its buffer is TRANSFERRED
     *        to a worker when the pool path runs — read byteLength BEFORE calling)
     * @param {{ harness?: string, cwd?: string|null, cap?: number }} [opts]
     * @returns {Promise<{ records: Array, total: number, cwd: string|null, meta: Object,
     *           firstTs: number|null, lastTs: number|null }>}
     */
    async parse(bytes, { harness = 'claude', cwd = null, cap = Infinity } = {}) {
        if (this._ensureWorkers()) {
            return new Promise((resolve, reject) => {
                this._queue.push({
                    msg: {
                        jobId: ++this._nextJobId,
                        bytes: { buffer: bytes.buffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength },
                        harness, cwd, cap,
                    },
                    transfer: [bytes.buffer],
                    resolve, reject,
                });
                this._pump();
            });
        }
        // Fallback: decode + parse on the main thread, frame-budgeted; the
        // normalize pass over the capped tail is trivial at any sane cap.
        const text = new TextDecoder().decode(bytes);
        const out = harness === 'kimi'
            ? await parseKimiSessionAsync(text, cwd)
            : await parseClaudeSessionAsync(text);
        const total = out.events.length;
        const slice = Number.isFinite(cap) && total > cap ? out.events.slice(-cap) : out.events;
        const records = eventsToRecords(slice, out.cwd ?? cwd ?? '');
        return { records, total, cwd: out.cwd, meta: out.meta, firstTs: out.firstTs, lastTs: out.lastTs };
    }

    /**
     * Feed queued jobs to idle workers, GROWING the pool while work queues
     * behind busy ones (bounded by POOL_MAX and the queue itself — a 3-job
     * burst never wants a 4th worker).
     * @private
     */
    _pump() {
        while (this._queue.length > 0) {
            let entry = this._workers.find((e) => !e.busy);
            if (!entry) {
                if (this._workers.length >= Math.min(POOL_MAX, this._queue.length + this._byJobId.size)) break;
                entry = this._spawnWorker();
                if (!entry) break;
            }
            const job = this._queue.shift();
            entry.busy = true;
            this._byJobId.set(job.msg.jobId, { worker: entry, resolve: job.resolve, reject: job.reject });
            entry.w.postMessage(job.msg, job.transfer);
        }
    }

    /** Spawn one pool worker; null when spawning is broken. @private */
    _spawnWorker() {
        try {
            const w = new Worker(new URL('./SessionParseWorker.js', import.meta.url), { type: 'module' });
            const entry = { w, busy: false };
            w.onmessage = (e) => this._onResult(entry, e.data || {});
            w.onerror = (err) => this._retireWorker(entry, err);
            this._workers.push(entry);
            return entry;
        } catch (err) {
            console.warn('[SessionParsePool] worker spawn failed:', err?.message || err);
            this._spawnFailed = true;
            return null;
        }
    }

    /** Lazily create the pool shell (workers themselves spawn on demand). @private */
    _ensureWorkers() {
        if (this._workers) return true;
        if (this._spawnFailed || typeof Worker === 'undefined') return false;
        this._workers = [];
        return true;
    }

    /** A finished job frees its worker and settles its promise. @private */
    _onResult(entry, data) {
        const { jobId, type, message, ...result } = data;
        entry.busy = false;
        const p = this._byJobId.get(jobId);
        if (p) {
            this._byJobId.delete(jobId);
            type === 'ERROR' ? p.reject(new Error(message)) : p.resolve(result);
        }
        this._pump();
    }

    /**
     * A dead worker rejects its in-flight job and retires — the pool shrinks
     * instead of hanging; with none left, parses fall back to the main thread.
     * @private
     */
    _retireWorker(entry, err) {
        console.warn('[SessionParsePool] worker died — retiring it:', err?.message || err);
        const i = this._workers.indexOf(entry);
        if (i >= 0) this._workers.splice(i, 1);
        for (const [jobId, p] of this._byJobId) {
            if (p.worker === entry) {
                this._byJobId.delete(jobId);
                p.reject(new Error('parse worker died'));
            }
        }
        this._pump();
    }

    /** Terminate the pool (app teardown). */
    dispose() {
        for (const { w } of this._workers ?? []) w.terminate();
        this._workers = null;
        this._byJobId.clear();
        this._queue = [];
    }
}

/** The shared singleton (app-scope, like WorkerBridge). */
let _instance = null;
export function getSessionParsePool() {
    if (!_instance) _instance = new SessionParsePool();
    return _instance;
}

/**
 * Convenience: parse through the shared pool.
 * @param {Uint8Array} bytes @param {{ harness?: string, cwd?: string|null, cap?: number }} [opts]
 */
export function parseSessionOffThread(bytes, opts) {
    return getSessionParsePool().parse(bytes, opts);
}
