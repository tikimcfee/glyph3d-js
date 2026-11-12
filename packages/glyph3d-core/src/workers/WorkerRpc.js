/**
 * WorkerRpc — request/answer over one dedicated worker.
 *
 * Every request carries an `id`; the worker answers `{ id, …result }` or `{ id, error }`.
 * Answers resolve their request's promise; an `error` answer rejects it with the worker's
 * message, and a worker crash rejects everything in flight (and every later request) with
 * the crash — nothing is retried or done elsewhere instead. The caller constructs the
 * Worker itself (`new Worker(new URL('./X.js', import.meta.url), { type: 'module' })` must be
 * written literally at the call site for bundlers to find the worker).
 */

export default class WorkerRpc {
    /**
     * @param {Worker} worker
     * @param {string} name - prefixes every error ("EmojiRasterWorker: …")
     */
    constructor(worker, name) {
        /** @private */ this._worker = worker;
        /** @private */ this._name = name;
        /** @private id → { resolve, reject } */
        this._pending = new Map();
        /** @private */ this._nextId = 1;
        /** @private once set, every request rejects with it */
        this._failure = null;

        worker.onmessage = (e) => {
            const msg = e.data;
            const p = this._pending.get(msg.id);
            if (!p) return;
            this._pending.delete(msg.id);
            if (msg.error != null) p.reject(new Error(`${name}: ${msg.error}`));
            else p.resolve(msg);
        };
        worker.onerror = (e) => {
            e.preventDefault?.();
            this._fail(new Error(`${name} crashed: ${e.message || e.type || e}`));
        };
    }

    /** @returns {number} requests awaiting an answer */
    get inFlight() { return this._pending.size; }

    /**
     * @param {Object} msg - posted with an `id` added
     * @param {Transferable[]} [transfer]
     * @returns {Promise<Object>} the worker's answer
     */
    request(msg, transfer = []) {
        if (this._failure) return Promise.reject(this._failure);
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            this._worker.postMessage({ ...msg, id }, transfer);
        });
    }

    /** @private */
    _fail(err) {
        this._failure = err;
        for (const p of this._pending.values()) p.reject(err);
        this._pending.clear();
    }

    dispose() {
        this._fail(new Error(`${this._name} disposed`));
        this._worker.terminate();
    }
}
