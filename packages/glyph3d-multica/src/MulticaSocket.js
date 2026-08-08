/**
 * MulticaSocket — the live half of the Multica binding.
 *
 * Multica reports every mutation as a frame on one socket: agents changing state,
 * tasks moving through their lifecycle, issues and comments appearing, chat replies
 * streaming. That stream is what makes a spatial view worth building — the board
 * doesn't need polling, it needs a subscriber.
 *
 * Protocol, as the backend speaks it:
 *   - connect to `<origin>/ws?workspace_slug=<slug>`;
 *   - the token is NOT a query parameter (proxies and history log those) — it goes
 *     as the first frame, `{ type: 'auth', payload: { token } }`;
 *   - the server answers `auth_ack`, and only then is the subscription live;
 *   - every later frame is `{ type, payload, actor_id?, actor_type? }`.
 *
 * Reconnection is exponential with jitter, matching the backend's expectation that
 * many clients drop together on a restart and must not return in lockstep.
 */

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** ±20% so a fleet of clients spreads its return across the window. */
const RECONNECT_JITTER = 0.2;

export default class MulticaSocket {
    /**
     * @param {Object} opts
     * @param {string} opts.baseUrl backend origin — http(s) is rewritten to ws(s)
     * @param {string} opts.token bearer token, sent as the first frame
     * @param {string} [opts.workspaceSlug] scopes the subscription
     * @param {{platform?: string, version?: string, os?: string}} [opts.identity]
     * @param {typeof WebSocket} [opts.WebSocketImpl] injectable for tests / node hosts
     * @param {(msg: string, ...rest: unknown[]) => void} [opts.warn]
     */
    constructor({ baseUrl, token, workspaceSlug = null, identity, WebSocketImpl, warn } = {}) {
        if (!baseUrl) throw new Error('MulticaSocket: baseUrl is required');
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = token || null;
        this.workspaceSlug = workspaceSlug;
        this.identity = identity || { platform: 'glyph3d' };
        this._WebSocket = WebSocketImpl || globalThis.WebSocket;
        if (!this._WebSocket) throw new Error('MulticaSocket: no WebSocket implementation');
        this._warn = warn || (() => {});

        /** @type {WebSocket|null} */
        this.ws = null;
        /** @type {Map<string, Set<(payload: any, msg: any) => void>>} */
        this._handlers = new Map();
        /** @type {Set<(msg: import('./types.js').MulticaWSMessage) => void>} */
        this._anyHandlers = new Set();
        this._reconnectTimer = null;
        this._attempt = 0;
        this._closedByUs = false;
        this.authenticated = false;
        /** One warn per connection for out-of-protocol frames — a bad proxy can repeat. */
        this._badFrameLogged = false;
    }

    /** The `/ws` URL with the non-secret query parameters attached. */
    get url() {
        const url = new URL(`${this.baseUrl}/ws`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        if (this.workspaceSlug) url.searchParams.set('workspace_slug', this.workspaceSlug);
        if (this.identity.platform) url.searchParams.set('client_platform', this.identity.platform);
        if (this.identity.version) url.searchParams.set('client_version', this.identity.version);
        if (this.identity.os) url.searchParams.set('client_os', this.identity.os);
        return url.toString();
    }

    /**
     * Subscribe to one event type. Returns an unsubscribe thunk.
     * @param {string} type e.g. `task:running`
     * @param {(payload: any, msg: import('./types.js').MulticaWSMessage) => void} handler
     * @returns {() => void}
     */
    on(type, handler) {
        if (!this._handlers.has(type)) this._handlers.set(type, new Set());
        this._handlers.get(type).add(handler);
        return () => this._handlers.get(type)?.delete(handler);
    }

    /**
     * Subscribe to every frame — the catch-all the bridge uses so an unrecognized
     * event from a newer backend is observable rather than silently dropped.
     * @param {(msg: import('./types.js').MulticaWSMessage) => void} handler
     * @returns {() => void}
     */
    onAny(handler) {
        this._anyHandlers.add(handler);
        return () => this._anyHandlers.delete(handler);
    }

    /** Open the socket. Safe to call again after `close()`. */
    connect() {
        this._closedByUs = false;
        this._badFrameLogged = false;
        this.authenticated = false;

        const ws = new this._WebSocket(this.url);
        this.ws = ws;

        ws.onopen = () => {
            if (this.token) {
                ws.send(JSON.stringify({ type: 'auth', payload: { token: this.token } }));
                return;  // wait for auth_ack before declaring the subscription live
            }
            this._onAuthenticated();
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            } catch {
                this._warnOnce('multica ws: unparseable frame');
                return;
            }
            // Trust boundary: a frame must be an object carrying a string `type`. A
            // proxy or extension can inject anything; validate once here so every
            // downstream subscriber can trust the shape.
            if (!msg || typeof msg.type !== 'string') {
                this._warnOnce('multica ws: frame without a string type');
                return;
            }
            if (msg.type === 'auth_ack') {
                this._onAuthenticated();
                return;
            }
            const handlers = this._handlers.get(msg.type);
            if (handlers) for (const h of handlers) h(msg.payload, msg);
            for (const h of this._anyHandlers) h(msg);
        };

        ws.onclose = () => {
            this.authenticated = false;
            if (!this._closedByUs) this._scheduleReconnect();
        };

        // Errors always precede a close; onclose owns the reconnect so this stays quiet.
        ws.onerror = () => {};
    }

    /** Close and stop reconnecting. */
    close() {
        this._closedByUs = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this.authenticated = false;
        try { this.ws?.close(); } catch { /* already gone */ }
        this.ws = null;
    }

    _onAuthenticated() {
        this.authenticated = true;
        this._attempt = 0;  // a completed handshake, not merely a TCP connect, resets backoff
    }

    _scheduleReconnect() {
        const base = Math.min(RECONNECT_BASE_MS * 2 ** this._attempt, RECONNECT_MAX_MS);
        const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
        this._attempt += 1;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._closedByUs) this.connect();
        }, Math.max(0, base + jitter));
    }

    /** @param {string} message */
    _warnOnce(message) {
        if (this._badFrameLogged) return;
        this._badFrameLogged = true;
        this._warn(message);
    }
}
