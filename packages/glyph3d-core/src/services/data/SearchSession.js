/**
 * SearchSession — one directory content search, as a cancellable, disposable object.
 *
 * The relay walks the tree and PUSHES matches (fs/searchMatch → fs/searchDone); this is
 * the browser-side half that owns the run's identity, its result cache, and its
 * lifecycle. It holds no scene objects and imports nothing from Three — the cache is
 * the durable thing, and a view over it (SearchBook) is disposable and rebuildable.
 * That split is what makes "page 40 of 900 results" cost nothing: the results are
 * already here, only the visible sheets are GPU objects.
 *
 * IDENTITY IS PER RUN, not per session. Each start() mints a fresh run id
 * (`<session>#<n>`), so a refinement's matches can never be confused with the previous
 * query's — batches already in flight when the old run was cancelled arrive with a
 * stale id and are dropped by construction rather than by a race-sensitive flag.
 *
 * LIFECYCLE (`state`):
 *   idle → running → done | cancelled | error
 * `clear()` cancels whatever is in flight and returns to idle with an empty cache;
 * `dispose()` does that AND unsubscribes from the bridge. Both are idempotent, and
 * after either, a late notification for a retired run is a no-op — the session never
 * writes state it did not set, and never holds state it did not clear.
 *
 * Coordinates are GRID coordinates throughout: 0-based line, 0-based col, length in
 * runes (the relay converts from bytes). They hand directly to CodeGrid.highlightRange.
 */

/** @typedef {{ path:string, line:number, col:number, length:number, text:string }} SearchMatch */
/** @typedef {{ path:string, matches:SearchMatch[] }} SearchFileGroup */

/** Lifecycle states a session can hold. */
export const SEARCH_STATES = Object.freeze(['idle', 'running', 'done', 'cancelled', 'error']);

let _sessionSeq = 0;

export default class SearchSession {
    /**
     * Both dependencies are resolved LAZILY, per run. The file provider is swapped at
     * connect time (the GitHub baseline gives way to the relay's local source) and the
     * bridge is wired after the scene objects are built — a session constructed with the
     * ctx's values frozen at construction would hold whatever was there first and search
     * the wrong filesystem, or none.
     * @param {Object} deps
     * @param {() => import('./RemoteFileSystemProvider.js').default} deps.getProvider - the fs RPC surface
     * @param {() => import('../orchestration/WebSocketBridge.js').default} deps.getBridge - the push channel
     * @param {string} [deps.id] - session id (run ids derive from it)
     */
    constructor({ getProvider, getBridge, id = null } = {}) {
        if (typeof getProvider !== 'function') throw new Error('SearchSession requires a getProvider() accessor');
        if (typeof getBridge !== 'function') throw new Error('SearchSession requires a getBridge() accessor');
        this._getProvider = getProvider;
        this._getBridge = getBridge;
        this.id = id || `search-${++_sessionSeq}`;

        /** @type {'idle'|'running'|'done'|'cancelled'|'error'} */
        this.state = 'idle';
        /** The query that produced the current cache (null when idle). */
        this.params = null;
        /** The run id currently accepting matches — the ONLY authority on relevance. */
        this.runId = null;
        this._runSeq = 0;
        /** Server-reported base the match paths are relative to. */
        this.base = '';
        /** Why the run ended, when that isn't obvious (error message / cap note). */
        this.note = '';

        // -- the cache: grouped by file, insertion-ordered ------------------------
        /** @type {SearchFileGroup[]} files in first-match order — the page address space */
        this.files = [];
        /** @type {Map<string, SearchFileGroup>} */
        this._byPath = new Map();
        /** Total individual matches (files.length is the SHEET count). */
        this.total = 0;
        /** True when a server cap (total / per-file / file size) shortened the results. */
        this.truncated = false;
        /** Files scanned by the walk — progress, reported even before the first match. */
        this.scanned = 0;

        this._listeners = new Set();
        this._flushScheduled = false;
        this._disposed = false;

        // The subscription is installed on first start() (the bridge may not exist yet)
        // and then held for the session's life. Runs come and go behind it; the run-id
        // check is what admits or drops a batch.
        this._unsubscribe = null;
    }

    /** @private Install the match-stream subscription once, on the live bridge. */
    _ensureSubscribed() {
        if (this._unsubscribe) return;
        const bridge = this._getBridge();
        if (!bridge) throw new Error('search needs a relay connection (no bridge)');
        this._unsubscribe = bridge.onRpcNotification((method, params) => this._onNotification(method, params));
    }

    /** @private The live file provider. */
    get provider() {
        const p = this._getProvider();
        if (!p) throw new Error('search needs a file provider');
        return p;
    }

    // -- subscriptions -------------------------------------------------------------

    /**
     * Subscribe to cache/state changes. Fires COALESCED — a walk delivers batches far
     * faster than a view can rebuild, so many batches collapse into one notification per
     * tick. Returns an unsubscribe fn.
     * @param {(session: SearchSession) => void} fn
     * @returns {() => void}
     */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    /** @private Coalesce a change notification into this tick. */
    _emitChange() {
        if (this._flushScheduled || this._disposed) return;
        this._flushScheduled = true;
        setTimeout(() => {
            this._flushScheduled = false;
            if (this._disposed) return;
            for (const fn of this._listeners) {
                try { fn(this); } catch (e) { console.warn('[search] change listener failed:', e?.message ?? e); }
            }
        }, 0);
    }

    // -- the run -------------------------------------------------------------------

    /**
     * Start (or REFINE) a search. Any in-flight run is cancelled and its results dropped
     * first — a refinement is a new question, not an addition to the old answer.
     *
     * Resolves when the relay has acknowledged the walk; results arrive afterwards via
     * onChange. Rejects only if the walk could not be STARTED (bad pattern, unreachable
     * directory, no relay) — a walk that starts and then fails reports through `state`.
     *
     * @param {string} query
     * @param {Object} [opts]
     * @param {string} [opts.uri='file:///'] - directory to walk
     * @param {boolean} [opts.regex] @param {boolean} [opts.caseSensitive] @param {boolean} [opts.wholeWord]
     * @param {number} [opts.maxMatches] @param {number} [opts.maxFileMatches]
     * @returns {Promise<{ started: boolean, runId: string }>}
     */
    async start(query, opts = {}) {
        if (this._disposed) throw new Error('SearchSession disposed');
        if (!query) throw new Error('search requires a query');
        // Fail here, before any state moves: a search with nowhere to receive its matches
        // must not leave the session looking "running" forever.
        this._ensureSubscribed();
        await this.cancel();
        this._resetCache();

        const runId = `${this.id}#${++this._runSeq}`;
        const { uri = 'file:///', ...rest } = opts;
        const params = { id: runId, uri, query, ...rest };
        this.params = { query, uri, ...rest };
        this.runId = runId;
        this.state = 'running';
        this.note = '';
        this._emitChange();

        try {
            const res = await this.provider.search(params);
            // A slow ack can land after a cancel/dispose overtook it. The run is already
            // retired; adopting its base now would resurrect dead state.
            if (this._disposed || this.runId !== runId) return { started: false, runId };
            this.base = res?.base || '';
            return { started: true, runId };
        } catch (e) {
            if (this._disposed || this.runId !== runId) throw e;
            this.state = 'error';
            this.note = e?.message ?? String(e);
            this.runId = null;
            this._emitChange();
            throw e;
        }
    }

    /**
     * Stop the in-flight run, KEEPING what it has already found (a cancelled search is
     * usually "that's enough, I can see it"). Idempotent; safe when nothing is running.
     * @returns {Promise<void>}
     */
    async cancel() {
        const runId = this.runId;
        if (!runId) return;
        // Retire the id FIRST: from this instant, in-flight batches for this run are
        // stale and drop on arrival, whether or not the relay's cancel round-trips.
        this.runId = null;
        if (this.state === 'running') this.state = 'cancelled';
        this._emitChange();
        try { await this.provider.cancelSearch(runId); }
        catch (e) { console.warn('[search] cancel failed (run left to finish server-side):', e?.message ?? e); }
    }

    /**
     * Cancel and drop everything — back to a fresh idle session. This is the "clear"
     * half of the control object's contract: state this session set, this session unsets.
     * @returns {Promise<void>}
     */
    async clear() {
        await this.cancel();
        this._resetCache();
        this.state = 'idle';
        this.params = null;
        this.note = '';
        this._emitChange();
    }

    /**
     * Tear down for good: cancel the run, drop the cache, unsubscribe from the push
     * channel, forget listeners. After this the session emits nothing and holds nothing.
     * Idempotent.
     */
    dispose() {
        if (this._disposed) return;
        const runId = this.runId;
        this.runId = null;
        this._disposed = true;
        // Fire-and-forget: dispose is synchronous by contract (callers unmount on it),
        // and the relay drops the walk on display disconnect regardless.
        if (runId) { try { this.provider.cancelSearch(runId); } catch (_e) { /* best effort */ } }
        try { this._unsubscribe?.(); } catch (_e) { /* best effort */ }
        this._unsubscribe = null;
        this._resetCache();
        this.state = 'idle';
        this._listeners.clear();
    }

    // -- the cache -----------------------------------------------------------------

    /** Files matched so far — the sheet address space (one file = one sheet). */
    get fileCount() { return this.files.length; }

    /** @param {number} i @returns {SearchFileGroup|null} */
    fileAt(i) { return this.files[i] || null; }

    /**
     * A window of file groups — what a paged view materializes. Clamped to the cache, so
     * a window past the end is short (or empty), never padded with holes.
     * @param {number} start @param {number} count @returns {SearchFileGroup[]}
     */
    window(start, count) {
        const s = Math.max(0, Math.min(start | 0, this.files.length));
        return this.files.slice(s, s + Math.max(0, count | 0));
    }

    /** A terse status line for the HUD / CLI. */
    summary() {
        const q = this.params?.query ? `'${this.params.query}'` : '(no query)';
        const cap = this.truncated ? ' (truncated)' : '';
        return `${q} — ${this.total} matches in ${this.files.length} files, ${this.scanned} scanned [${this.state}]${cap}`;
    }

    /** @private Drop every result. Never touches lifecycle fields — callers own those. */
    _resetCache() {
        this.files = [];
        this._byPath.clear();
        this.total = 0;
        this.scanned = 0;
        this.truncated = false;
        this.base = '';
    }

    // -- the stream ----------------------------------------------------------------

    /** @private The bridge fan-out lands here for EVERY notification; filter hard. */
    _onNotification(method, params) {
        if (this._disposed) return;
        if (method !== 'fs/searchMatch' && method !== 'fs/searchDone') return;
        // The run-id gate: a retired run's late batches are dropped, not merged.
        if (!params || params.id !== this.runId) return;
        if (method === 'fs/searchMatch') this._ingest(params.matches);
        else this._finish(params);
    }

    /** @private Merge a batch into the grouped cache. */
    _ingest(matches) {
        if (!Array.isArray(matches) || matches.length === 0) return;
        for (const m of matches) {
            if (!m || typeof m.path !== 'string') continue;
            let group = this._byPath.get(m.path);
            if (!group) {
                group = { path: m.path, matches: [] };
                this._byPath.set(m.path, group);
                this.files.push(group);
            }
            group.matches.push(m);
            this.total++;
        }
        this._emitChange();
    }

    /** @private The run's single terminal notification. */
    _finish(params) {
        this.scanned = params.scanned ?? this.scanned;
        this.truncated = !!params.truncated;
        this.state = params.cancelled ? 'cancelled' : 'done';
        if (params.capped) this.note = `stopped at the match cap (${this.total})`;
        else if (this.truncated) this.note = 'some files were skipped (size cap) or trimmed (per-file cap)';
        this.runId = null;
        this._emitChange();
    }
}
