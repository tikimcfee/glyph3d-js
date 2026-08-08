/**
 * MulticaClient — the REST half of the Multica binding.
 *
 * One `fetch` wrapper plus the handful of resource calls the spatial view needs:
 * agents (books), issues (pages), runtimes (where an agent actually executes), and
 * chat (terminal input). Every request carries the bearer token and the workspace
 * header; nothing else is stateful.
 *
 * Two protocol details worth keeping in one place, because both cost a debugging
 * round-trip if you assume the usual:
 *   - list endpoints answer `{ issues: [...] }`, not a bare array;
 *   - issue updates are **PUT**, not PATCH (PATCH answers 405).
 *
 * @see types.js for the wire shapes.
 */

/** Thrown for any non-2xx response, carrying the status so callers can branch. */
export class MulticaError extends Error {
    /**
     * @param {number} status HTTP status
     * @param {string} message server-provided `error` field, or the status text
     * @param {string} [path] request path, for the message
     */
    constructor(status, message, path) {
        super(path ? `multica ${status} on ${path}: ${message}` : `multica ${status}: ${message}`);
        this.name = 'MulticaError';
        this.status = status;
    }
}

export default class MulticaClient {
    /**
     * @param {Object} opts
     * @param {string} opts.baseUrl backend origin, e.g. `http://localhost:8099`
     * @param {string} [opts.token] bearer token from `verifyCode` (or a minted CLI token)
     * @param {string} [opts.workspaceId] workspace UUID — sent as `X-Workspace-Id`
     * @param {typeof fetch} [opts.fetch] injectable for tests / non-browser hosts
     */
    constructor({ baseUrl, token = null, workspaceId = null, fetch: fetchImpl } = {}) {
        if (!baseUrl) throw new Error('MulticaClient: baseUrl is required');
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = token;
        this.workspaceId = workspaceId;
        this._fetch = fetchImpl || globalThis.fetch?.bind(globalThis);
        if (!this._fetch) throw new Error('MulticaClient: no fetch available');
    }

    /** @param {string} token */
    setToken(token) { this.token = token; }

    /** @param {string} workspaceId */
    setWorkspace(workspaceId) { this.workspaceId = workspaceId; }

    /**
     * The single request path. Adds auth + workspace headers, parses JSON, and turns
     * a non-2xx into a MulticaError carrying the server's own `error` string.
     * @param {string} method
     * @param {string} path path under the origin, e.g. `/api/agents`
     * @param {unknown} [body] JSON-encoded when present
     * @returns {Promise<any>} parsed JSON, or null for an empty body (204)
     */
    async request(method, path, body) {
        const headers = { Accept: 'application/json' };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        if (this.workspaceId) headers['X-Workspace-Id'] = this.workspaceId;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const res = await this._fetch(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const text = await res.text();
        // A 204 and an empty 200 both mean "no document" — don't make callers guard.
        const parsed = text ? safeJson(text) : null;
        if (!res.ok) {
            const message = (parsed && typeof parsed === 'object' && parsed.error) || res.statusText || 'request failed';
            throw new MulticaError(res.status, String(message), path);
        }
        return parsed;
    }

    // -- auth ---------------------------------------------------------------

    /**
     * Ask the backend to mail (or, on a dev instance, log) a verification code.
     * @param {string} email
     */
    sendCode(email) { return this.request('POST', '/auth/send-code', { email }); }

    /**
     * Exchange the code for a bearer token. Stores the token on this client.
     * @param {string} email
     * @param {string} code
     * @returns {Promise<{token: string, user: Object}>}
     */
    async verifyCode(email, code) {
        const out = await this.request('POST', '/auth/verify-code', { email, code });
        if (out?.token) this.token = out.token;
        return out;
    }

    /** Mint a token for daemon/CLI use. @returns {Promise<{token: string}>} */
    cliToken() { return this.request('POST', '/api/cli-token', {}); }

    /** The authenticated user. */
    me() { return this.request('GET', '/api/me'); }

    // -- workspaces ---------------------------------------------------------

    /** @returns {Promise<Object[]>} */
    async listWorkspaces() { return unwrap(await this.request('GET', '/api/workspaces'), 'workspaces'); }

    /**
     * @param {{name: string, slug: string, issue_prefix?: string, description?: string}} input
     * @returns {Promise<Object>} the created workspace (its `id` is what setWorkspace wants)
     */
    createWorkspace(input) { return this.request('POST', '/api/workspaces', input); }

    // -- runtimes -----------------------------------------------------------

    /**
     * Registered runtime devices. Empty until a daemon pairs — and an agent cannot
     * be created without one, so this is the first thing to check when
     * `createAgent` answers "runtime_id is required".
     * @returns {Promise<import('./types.js').MulticaRuntime[]>}
     */
    async listRuntimes() { return unwrap(await this.request('GET', '/api/runtimes'), 'runtimes'); }

    // -- agents -------------------------------------------------------------

    /** @returns {Promise<import('./types.js').MulticaAgent[]>} */
    async listAgents() { return unwrap(await this.request('GET', '/api/agents'), 'agents'); }

    /**
     * @param {{name: string, runtime_id: string, description?: string,
     *          instructions?: string, visibility?: 'workspace'|'private'}} input
     * @returns {Promise<import('./types.js').MulticaAgent>}
     */
    createAgent(input) { return this.request('POST', '/api/agents', input); }

    // -- issues -------------------------------------------------------------

    /**
     * @param {Record<string, string|number>} [query]
     * @returns {Promise<import('./types.js').MulticaIssue[]>}
     */
    async listIssues(query) {
        const qs = query ? `?${new URLSearchParams(/** @type {any} */ (query))}` : '';
        return unwrap(await this.request('GET', `/api/issues${qs}`), 'issues');
    }

    /** @param {string} id @returns {Promise<import('./types.js').MulticaIssue>} */
    getIssue(id) { return this.request('GET', `/api/issues/${id}`); }

    /**
     * Sub-issues of a parent, which is how a pipeline is stored: siblings sharing a
     * `stage` form one barrier group, and the parent advances only when the whole
     * group finishes.
     * @param {string} id parent issue id
     * @returns {Promise<import('./types.js').MulticaIssue[]>}
     */
    async listChildren(id) { return unwrap(await this.request('GET', `/api/issues/${id}/children`), 'issues'); }

    /**
     * @param {{title: string, description?: string, status?: string, priority?: string,
     *          parent_issue_id?: string, stage?: number, assignee_type?: string,
     *          assignee_id?: string, project_id?: string}} input
     *   `stage` is 1-based — the server rejects 0 with "stage must be >= 1".
     * @returns {Promise<import('./types.js').MulticaIssue>}
     */
    createIssue(input) { return this.request('POST', '/api/issues', input); }

    /**
     * Update an issue. PUT, not PATCH — the route answers 405 for PATCH.
     * @param {string} id
     * @param {Record<string, unknown>} patch
     * @returns {Promise<import('./types.js').MulticaIssue>}
     */
    updateIssue(id, patch) { return this.request('PUT', `/api/issues/${id}`, patch); }

    /** @param {string} id @returns {Promise<Object[]>} */
    async listComments(id) { return unwrap(await this.request('GET', `/api/issues/${id}/comments`), 'comments'); }

    // -- chat ---------------------------------------------------------------

    /** Chat sessions — one per agent conversation; each backs an attached terminal. */
    async listChatSessions() { return unwrap(await this.request('GET', '/api/chat/sessions'), 'sessions'); }

    /**
     * @param {string} sessionId
     * @returns {Promise<Object[]>} the thread's messages
     */
    async chatThread(sessionId) {
        return unwrap(await this.request('GET', `/api/chat/thread?session_id=${encodeURIComponent(sessionId)}`), 'messages');
    }
}

/**
 * List endpoints answer `{ <key>: [...] }`; a few answer a bare array. Accept both so
 * a caller never has to know which, and never hand back undefined.
 * @param {any} payload
 * @param {string} key
 * @returns {any[]}
 */
function unwrap(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload[key])) return payload[key];
    return [];
}

/** @param {string} text @returns {any} the parsed body, or the raw text when it isn't JSON */
function safeJson(text) {
    try { return JSON.parse(text); } catch { return text; }
}
