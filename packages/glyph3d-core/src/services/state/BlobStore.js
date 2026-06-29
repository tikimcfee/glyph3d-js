/**
 * BlobStore — namespaced, async LOCAL BINARY storage.
 *
 * The binary/large peer to {@link StateController}. The two split the local-
 * persistence space by substrate, and deliberately do NOT overlap:
 *
 *   StateController  small JSON   localStorage `g3d.*`   SYNC   settings, dials, camera
 *   BlobStore        large bytes  IndexedDB              ASYNC  slug core, cached content
 *
 * localStorage is the wrong home for a gzipped slug-core blob (string-only,
 * ~5 MB cap, base64 bloat), so this is a complementary store — not a second
 * settings layer. Clients (slugCoreCache, a future persistent RepositoryContent
 * cache, …) layer their OWN versioning/keys/compression on top; the store itself
 * is dumb: namespaced key → bytes (+ small meta). Each entry is `{ns}.{id}`.
 *
 * The surface mirrors StateController (get/put/delete/clearNamespace/clearAll/
 * listAll/listNamespace/stat*) so the Local Data panel can view both substrates
 * uniformly, and it dispatches a `local-data-changed` CustomEvent on every
 * mutation (parallel to StateController's `state-changed`) for poll-free refresh.
 *
 * The backend is swappable: {@link IndexedDBBackend} in the browser, {@link
 * MemoryBackend} where IndexedDB is absent (private mode, SSR) or under headless
 * tests. The store logic (namespacing, listing, events) is identical across both.
 */

const DB_NAME = 'glyph3d-local';
const STORE_NAME = 'blobs';

/** @typedef {{ bytes: Uint8Array, meta: object, createdAt: number }} BlobRecord */

/** Normalize an ArrayBuffer / TypedArray / Uint8Array to a standalone Uint8Array. */
function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('BlobStore: value must be an ArrayBuffer or a typed array');
}

// ── backends ─────────────────────────────────────────────────────────────────

/** In-memory backend — the no-IndexedDB fallback and the headless-test substrate. */
export class MemoryBackend {
    constructor() { /** @type {Map<string, BlobRecord>} */ this._map = new Map(); }
    async getRaw(key) { return this._map.get(key) ?? null; }
    async putRaw(key, record) { this._map.set(key, record); }
    async deleteRaw(key) { this._map.delete(key); }
    async keys() { return [...this._map.keys()]; }
    async clearKeys(keys) { for (const k of keys) this._map.delete(k); }
}

/** IndexedDB backend — one object store keyed by the namespaced string. */
export class IndexedDBBackend {
    constructor(dbName = DB_NAME, storeName = STORE_NAME) {
        this._dbName = dbName;
        this._storeName = storeName;
        /** @private lazily-opened connection */
        this._dbPromise = null;
    }

    _db() {
        if (!this._dbPromise) {
            this._dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(this._dbName, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(this._storeName)) db.createObjectStore(this._storeName);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return this._dbPromise;
    }

    async _tx(mode, fn) {
        const db = await this._db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this._storeName, mode);
            const store = tx.objectStore(this._storeName);
            let result;
            Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    _await(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

    getRaw(key) { return this._tx('readonly', (s) => this._await(s.get(key)).then((r) => r ?? null)); }
    putRaw(key, record) { return this._tx('readwrite', (s) => { s.put(record, key); }); }
    deleteRaw(key) { return this._tx('readwrite', (s) => { s.delete(key); }); }
    keys() { return this._tx('readonly', (s) => this._await(s.getAllKeys())); }
    clearKeys(keys) { return this._tx('readwrite', (s) => { for (const k of keys) s.delete(k); }); }
}

/** Pick a backend for the ambient environment (IndexedDB if present, else in-memory). */
function defaultBackend() {
    try { if (typeof indexedDB !== 'undefined' && indexedDB) return new IndexedDBBackend(); } catch { /* locked-down env */ }
    return new MemoryBackend();
}

// ── store ──────────────────────────────────────────────────────────────────

export class BlobStore {
    /** @param {{ backend?: object }} [opts] */
    constructor({ backend } = {}) {
        /** @private */ this._backend = backend || defaultBackend();
    }

    _changed(op, key) {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('local-data-changed', { detail: { store: 'blob', op, key } }));
        }
    }

    /**
     * Store bytes under a namespaced key. `bytes` may be an ArrayBuffer or any typed
     * array; it is copied-by-reference as a Uint8Array view. `meta` is small, arbitrary
     * JSON the client owns (version, hash, source, …). `createdAt` is stamped now unless
     * provided (pass-through keeps re-imported entries faithful).
     * @param {string} key   e.g. 'slug-core.<hash>'
     * @param {ArrayBuffer|ArrayBufferView} bytes
     * @param {object} [meta]
     * @param {number} [createdAt]
     */
    async put(key, bytes, meta = {}, createdAt = Date.now()) {
        await this._backend.putRaw(key, { bytes: toBytes(bytes), meta, createdAt });
        this._changed('put', key);
    }

    /** @returns {Promise<BlobRecord|null>} the full record, or null if absent. */
    async get(key) { return this._backend.getRaw(key); }

    /** @returns {Promise<Uint8Array|null>} just the bytes, or null. */
    async getBytes(key) { const r = await this._backend.getRaw(key); return r ? r.bytes : null; }

    /** @returns {Promise<boolean>} */
    async has(key) { return (await this._backend.getRaw(key)) !== null; }

    /** Delete one key. */
    async delete(key) { await this._backend.deleteRaw(key); this._changed('delete', key); }

    /** @returns {Promise<string[]>} every key, sorted. */
    async listAll() { return (await this._backend.keys()).sort(); }

    /** @returns {Promise<string[]>} keys under `{ns}.`, sorted. */
    async listNamespace(ns) {
        const p = ns + '.';
        return (await this._backend.keys()).filter((k) => k === ns || k.startsWith(p)).sort();
    }

    /**
     * Lightweight metadata for a key (no full payload returned to the caller, though the
     * backend reads the record). @returns {Promise<{key,bytes,createdAt,meta}|null>}
     */
    async stat(key) {
        const r = await this._backend.getRaw(key);
        return r ? { key, bytes: r.bytes.byteLength, createdAt: r.createdAt, meta: r.meta } : null;
    }

    /** Stat for every key (the Local Data panel's listing). @returns {Promise<Array>} */
    async statAll() { return this._statKeys(await this.listAll()); }

    /** Stat for a namespace. @returns {Promise<Array>} */
    async statNamespace(ns) { return this._statKeys(await this.listNamespace(ns)); }

    /** @private */
    async _statKeys(keys) {
        const out = [];
        for (const key of keys) { const s = await this.stat(key); if (s) out.push(s); }
        return out;
    }

    /** Delete every key under `{ns}.`. @returns {Promise<number>} count removed. */
    async clearNamespace(ns) {
        const keys = await this.listNamespace(ns);
        if (keys.length) { await this._backend.clearKeys(keys); this._changed('clearNamespace', ns); }
        return keys.length;
    }

    /** Delete every key. @returns {Promise<number>} count removed. */
    async clearAll() {
        const keys = await this.listAll();
        if (keys.length) { await this._backend.clearKeys(keys); this._changed('clearAll', null); }
        return keys.length;
    }
}

/** Singleton — import this everywhere (parallels `stateController`). */
export const blobStore = new BlobStore();
