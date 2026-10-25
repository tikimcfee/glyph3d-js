/**
 * AgentSessionProvider — JSON-RPC client for the relay's agent sessions and their event
 * streams (the relay runs gomuxai: `agent sessions --json` and `agent transcript <session>`;
 * the contract is gomuxai's docs/EVENTS.md). gomuxai is the one reader of agent transcripts;
 * the relay moves its lines and this provider moves them on. No parsing here — the books'
 * reader (collections/agentEvents.js) folds the lines.
 *
 *   list()                       agentSessions/list → {gen, sessions}: every agent session on
 *                                the host (workgroup and local), newest first
 *   onSessions(fn)               the list as it changes (agentSessions/changed pushes, and
 *                                every list() answer) — `sessions` holds the latest
 *   follow(session, {from})      agentEvents/follow: start (or share) a live follower that
 *                                streams the session's lines after the line at `from`
 *   unfollow(session)            agentEvents/unfollow: drop this display's subscription
 *   read(session, window)        agentEvents/read {from?, until?, tail?} → {lines, size}: a
 *                                bounded one-shot window (an open's tail, a history page)
 *   subscribe(session, handlers) route the session's pushes: `lines(lines)` for each
 *                                agentEvents/lines batch (in order, whole lines), `ended(e)`
 *                                when its follower exits ({code, error?})
 *
 * @typedef {Object} AgentSession  gomuxai's discovery.Session (EVENTS.md "Session")
 * @property {string} session_id @property {string} harness   claude | agy | kimi
 * @property {string} path @property {number} size @property {string} mtime  RFC3339
 * @property {string} [cwd] @property {string} [project] @property {string} [title]
 * @property {string} [agent_name] @property {string} [model]
 * @property {{name:string, parent?:string, store?:string, host?:string}|null} workgroup
 * @property {string} status  idle|processing|waiting|error|exited|unknown
 * @property {string} [status_at]
 * @property {{session_id:string, tool_id?:string}} [parent_session]  set on a subagent's session
 * @property {string} [continued_in]
 *
 * @typedef {{gen: number, sessions: AgentSession[]}} AgentSessionList
 * @typedef {{lines?: (lines: string[]) => void, ended?: (e: {code?: number, error?: string}) => void}} StreamHandlers
 */

export class AgentSessionProvider {
    /** @param {import('../orchestration/WebSocketBridge.js').default} bridge */
    constructor(bridge) {
        this._bridge = bridge;
        /** @type {AgentSessionList|null} the latest list (null until the first) */
        this.latest = null;
        /** @type {Set<(list: AgentSessionList) => void>} */
        this._listeners = new Set();
        /** @type {Map<string, Set<StreamHandlers>>} session id → its subscribers */
        this._streams = new Map();
        this._off = bridge.onRpcNotification?.((method, params) => this._push(method, params)) ?? null;
    }

    /** The latest session list's sessions ([] until one arrives). @returns {AgentSession[]} */
    get sessions() { return this.latest?.sessions ?? []; }

    /** @returns {Promise<AgentSessionList>} */
    async list() {
        const r = await this._bridge.rpcRequest('agentSessions/list', {});
        const list = { gen: r?.gen ?? 0, sessions: Array.isArray(r?.sessions) ? r.sessions : [] };
        this._take(list);
        return list;
    }

    /**
     * Subscribe to the session list. Returns the unsubscribe fn.
     * @param {(list: AgentSessionList) => void} fn
     */
    onSessions(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /**
     * Follow a session live: its lines after the line starting at `from` (the whole
     * transcript when `from` is omitted) arrive through subscribe()'s `lines`.
     * @param {string} session @param {{from?: number|null}} [opts]
     */
    async follow(session, { from = null } = {}) {
        const params = { session };
        if (Number.isFinite(from)) params.from = from;
        return await this._call('agentEvents/follow', params);
    }

    /** Drop this display's follow of a session. @param {string} session */
    async unfollow(session) {
        return await this._call('agentEvents/unfollow', { session });
    }

    /**
     * A bounded window of a session's stream: the lines after the line starting at `from`
     * (from the start when omitted) and before byte `until` (to the end when omitted), or
     * `tail`: about the last N bytes. Returns the lines and the transcript size the relay saw.
     * @param {string} session
     * @param {{from?: number, until?: number, tail?: number}} [window]
     * @returns {Promise<{lines: string[], size: number|null}>}
     */
    async read(session, window = {}) {
        const params = { session };
        for (const k of ['from', 'until', 'tail']) if (Number.isFinite(window[k])) params[k] = window[k];
        const r = await this._call('agentEvents/read', params);
        return { lines: Array.isArray(r?.lines) ? r.lines : [], size: Number.isFinite(r?.size) ? r.size : null };
    }

    /**
     * Route one session's pushes to `handlers`. Returns the unsubscribe fn.
     * @param {string} session @param {StreamHandlers} handlers
     */
    subscribe(session, handlers) {
        let set = this._streams.get(session);
        if (!set) this._streams.set(session, (set = new Set()));
        set.add(handlers);
        return () => {
            set.delete(handlers);
            if (!set.size && this._streams.get(session) === set) this._streams.delete(session);
        };
    }

    dispose() {
        this._off?.();
        this._listeners.clear();
        this._streams.clear();
    }

    /** One RPC, loud at the seam: the exact request beside the relay's answer. @private */
    async _call(method, params) {
        try {
            return await this._bridge.rpcRequest(method, params);
        } catch (e) {
            console.error(`[sessions] ${method} failed`, params, e?.message || e);
            throw e;
        }
    }

    /** @private */
    _take(list) {
        this.latest = list;
        for (const fn of this._listeners) {
            try { fn(list); } catch (e) { console.error('[sessions] a session-list listener threw', e); }
        }
    }

    /** The relay's pushes: the list, a follower's lines, a follower's end. @private */
    _push(method, params) {
        if (method === 'agentSessions/changed') {
            if (Array.isArray(params?.sessions)) this._take({ gen: params.gen ?? 0, sessions: params.sessions });
            return;
        }
        if (method !== 'agentEvents/lines' && method !== 'agentEvents/ended') return;
        const set = this._streams.get(params?.session);
        if (!set) return;   // a follower this display no longer holds (its unfollow is in flight)
        for (const h of [...set]) {
            try {
                if (method === 'agentEvents/lines') h.lines?.(Array.isArray(params.lines) ? params.lines : []);
                else h.ended?.({ code: params.code, error: params.error });
            } catch (e) {
                console.error(`[sessions] ${params.session}: a ${method} handler threw`, e);
            }
        }
    }
}

export default AgentSessionProvider;
