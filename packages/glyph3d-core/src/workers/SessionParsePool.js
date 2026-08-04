/**
 * SessionParsePool — the main-thread handle on the transcript codec.
 *
 * parseSessionOffThread(bytes, { harness, cwd, cap }) → { events, total, cwd, meta, … }.
 *
 * Two backends behind the ONE result shape:
 *   - a dedicated parse worker (production): the transcript's ArrayBuffer is
 *     TRANSFERRED in (zero-copy), the sync parser crunches on the worker
 *     thread (no slicing needed there), only the capped event tail clones back.
 *   - the main-thread sliced parsers (fallback: no Worker — tests, headless):
 *     parseClaudeSessionAsync / parseKimiSessionAsync, frame-budgeted.
 *
 * One worker, FIFO: restore's 6-wide book pour queues its parses on the port;
 * the win is keeping megabyte JSON.parse + pairing off the main thread, not
 * parallel books (Σparse measured ~0.5s across a whole 12-book restore).
 */

import { runSessionParseJob } from './sessionParseJob.js';
import { parseClaudeSessionAsync, parseKimiSessionAsync } from '../collections/sessionAdapter.js';

export class SessionParsePool {
    constructor() {
        /** @private */ this._worker = null;
        /** @private */ this._workerFailed = false;
        /** @private */ this._nextJobId = 0;
        /** @private */ this._pending = new Map();   // jobId -> { resolve, reject }
    }

    /** @returns {boolean} worker backend live (false = main-thread fallback) */
    get offThread() { return !!this._worker; }

    /**
     * Parse a transcript's raw bytes into the event stream.
     * @param {Uint8Array} bytes - raw JSONL transcript (its buffer is TRANSFERRED
     *        to the worker when the worker path runs — read byteLength BEFORE calling)
     * @param {{ harness?: string, cwd?: string|null, cap?: number }} [opts]
     * @returns {Promise<{ events: Array, total: number, cwd: string|null, meta: Object,
     *           firstTs: number|null, lastTs: number|null }>}
     */
    async parse(bytes, { harness = 'claude', cwd = null, cap = Infinity } = {}) {
        if (this._ensureWorker()) {
            const jobId = ++this._nextJobId;
            return new Promise((resolve, reject) => {
                this._pending.set(jobId, { resolve, reject });
                const parcel = { buffer: bytes.buffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength };
                this._worker.postMessage({ jobId, bytes: parcel, harness, cwd, cap }, [bytes.buffer]);
            });
        }
        // Fallback: decode + slice on the main thread, frame-budgeted.
        const text = new TextDecoder().decode(bytes);
        const out = harness === 'kimi'
            ? await parseKimiSessionAsync(text, cwd)
            : await parseClaudeSessionAsync(text);
        const total = out.events.length;
        const events = Number.isFinite(cap) && total > cap ? out.events.slice(-cap) : out.events;
        return { events, total, cwd: out.cwd, meta: out.meta, firstTs: out.firstTs, lastTs: out.lastTs };
    }

    /** Lazily spawn the singleton worker; false when workers are unavailable/broken. @private */
    _ensureWorker() {
        if (this._worker) return true;
        if (this._workerFailed || typeof Worker === 'undefined') return false;
        try {
            const w = new Worker(new URL('./SessionParseWorker.js', import.meta.url), { type: 'module' });
            w.onmessage = (e) => {
                const { jobId, type, message, ...result } = e.data || {};
                const p = this._pending.get(jobId);
                if (!p) return;
                this._pending.delete(jobId);
                type === 'ERROR' ? p.reject(new Error(message)) : p.resolve(result);
            };
            w.onerror = (err) => {
                // A dead worker rejects its queue once and retires — the next
                // parse falls back to the main thread instead of hanging.
                console.warn('[SessionParsePool] worker error — falling back to main thread:', err?.message || err);
                this._worker = null;
                this._workerFailed = true;
                for (const [, p] of this._pending) p.reject(new Error('parse worker died'));
                this._pending.clear();
            };
            this._worker = w;
            return true;
        } catch {
            this._workerFailed = true;
            return false;
        }
    }

    /** Terminate the worker (app teardown). */
    dispose() {
        this._worker?.terminate();
        this._worker = null;
        this._pending.clear();
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
