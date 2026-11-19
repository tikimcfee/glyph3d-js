/**
 * WebSocketBridge - browser-side WebSocket client for command relay.
 *
 * Connects to the Python/Node relay server, registers as "display",
 * routes incoming commands through the CommandRouter, sends responses back.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - LAN address detection and display in status bar
 * - Connection modes: localhost, LAN, custom URL
 * - Structured JSON responses for programmatic controllers
 * - Status bar UI element showing connection state and address
 */

import { decodeBase64 } from '../../utils/encoding.js';

const TOKEN_STORAGE_PREFIX = 'g3d.relayToken.';

// A token rides in a Sec-WebSocket-Protocol entry, so it must be an RFC 7230 token.
export const TOKEN_CHARS = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Normalize a single host string: trim, lowercase, and strip at most one pair
 * of outer `[` `]` brackets (so `'[::1]'` and `'::1'` both yield `'::1'`).
 * @param {unknown} raw
 * @returns {string}
 */
function cleanHostString(raw) {
    if (typeof raw !== 'string') return '';
    let h = raw.trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) {
        h = h.slice(1, -1).trim();
    }
    return h;
}

/**
 * Normalize a relay hostname for storage keying and comparisons.
 * Falls back to normalized `window?.location?.hostname` or `'localhost'`.
 * @param {string|null|undefined} host
 * @returns {string}
 */
export function normalizeRelayHost(host) {
    const direct = cleanHostString(host);
    if (direct) return direct;
    if (typeof window !== 'undefined') {
        const fromLoc = cleanHostString(window.location?.hostname);
        if (fromLoc) return fromLoc;
    }
    return 'localhost';
}

/**
 * Build the `sessionStorage` key for a `(host, port)` relay endpoint.
 * @param {number|string|null|undefined} port
 * @param {string|null|undefined} [host]
 * @returns {string}
 */
export function relayTokenStorageKey(port, host) {
    return `${TOKEN_STORAGE_PREFIX}${normalizeRelayHost(host)}:${port || 'default'}`;
}

/**
 * Return true if the query portion before `#` carries a `token` key
 * (case-insensitive, `&` or `;` separated, including percent-encoded keys).
 * @param {string} raw
 * @returns {boolean}
 */
function hasQueryTokenParam(raw) {
    if (typeof raw !== 'string') return false;
    const hashIdx = raw.indexOf('#');
    const beforeHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const qIdx = beforeHash.indexOf('?');
    if (qIdx < 0) return false;
    const query = beforeHash.slice(qIdx + 1);
    for (const part of query.split(/[&;]/)) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const rawKey = (eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, ' ');
        let key = rawKey;
        try { key = decodeURIComponent(rawKey); } catch { /* keep rawKey on malformed escape */ }
        if (key.trim().toLowerCase() === 'token') return true;
    }
    return false;
}

/**
 * Extract a relay token from either a bare RFC-7230 token string or a URL/fragment
 * carrying `#token=<tok>`. Query-string `?token=` is never accepted, and neither is
 * a URL with no `#token=` (a relay address is not a token: Go `parseRelayTokenValue`).
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
export function parseRelayTokenInput(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (hasQueryTokenParam(trimmed)) return null;
    let tok = trimmed;
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx >= 0) {
        tok = new URLSearchParams(trimmed.slice(hashIdx + 1)).get('token') || '';
    } else if (trimmed.startsWith('token=')) {
        tok = new URLSearchParams(trimmed).get('token') || '';
    } else if (trimmed.includes('://')) {
        return null;
    }
    tok = tok.trim();
    return tok && TOKEN_CHARS.test(tok) ? tok : null;
}

/**
 * Parse either a bare port (`"8080"` or `8080`) or a `ws:`/`wss:`/`http:`/`https:` URL
 * into a canonical relay endpoint descriptor without ever throwing or echoing secrets.
 * @param {string|number|null|undefined} input
 * @param {{ defaultHost?: string, pageProtocol?: string }} [opts]
 * @returns {{ ok: true, host: string, port: number, wsUrl: string, token: string|null, hadHashToken: boolean } | { ok: false, error: string }}
 */
export function parseRelayEndpoint(input, opts = {}) {
    const { defaultHost = undefined, pageProtocol = undefined } = opts || {};

    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input < 1 || input > 65535 || !/^\d+$/.test(String(input))) {
            return { ok: false, error: 'invalid relay port (must be 1..65535)' };
        }
        const host = normalizeRelayHost(defaultHost);
        const proto = (pageProtocol ?? (typeof window !== 'undefined' ? window.location?.protocol : 'http:')) === 'https:' ? 'wss:' : 'ws:';
        const urlHost = host.includes(':') ? `[${host}]` : host;
        return {
            ok: true,
            host,
            port: input,
            wsUrl: `${proto}//${urlHost}:${input}`,
            token: null,
            hadHashToken: false,
        };
    }

    if (typeof input !== 'string') {
        return { ok: false, error: 'invalid relay endpoint' };
    }
    const raw = input.trim();
    if (!raw) {
        return { ok: false, error: 'empty relay endpoint' };
    }

    if (/^\d+$/.test(raw)) {
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, error: 'invalid relay port (must be 1..65535)' };
        }
        const host = normalizeRelayHost(defaultHost);
        const proto = (pageProtocol ?? (typeof window !== 'undefined' ? window.location?.protocol : 'http:')) === 'https:' ? 'wss:' : 'ws:';
        const urlHost = host.includes(':') ? `[${host}]` : host;
        return {
            ok: true,
            host,
            port,
            wsUrl: `${proto}//${urlHost}:${port}`,
            token: null,
            hadHashToken: false,
        };
    }

    let u;
    try {
        u = new URL(raw);
    } catch {
        return { ok: false, error: 'invalid relay endpoint (expected port or ws/wss/http/https URL)' };
    }

    if (u.protocol !== 'ws:' && u.protocol !== 'wss:' && u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, error: 'unsupported relay URL scheme (expected ws, wss, http, or https)' };
    }
    if (!u.hostname) {
        return { ok: false, error: 'missing host in relay URL' };
    }
    if (hasQueryTokenParam(raw) || hasQueryTokenParam(u.search)) {
        return { ok: false, error: 'relay token must not be passed in URL query string' };
    }

    let token = null;
    let hadHashToken = false;
    const hashIdx = raw.indexOf('#');
    if (hashIdx >= 0) {
        const fragParams = new URLSearchParams(raw.slice(hashIdx + 1));
        if (fragParams.has('token')) {
            hadHashToken = true;
            const tok = (fragParams.get('token') || '').trim();
            if (!tok || !TOKEN_CHARS.test(tok)) {
                return { ok: false, error: 'invalid #token= in URL' };
            }
            token = tok;
        }
    }

    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const host = normalizeRelayHost(u.hostname);
    const urlHost = host.includes(':') ? `[${host}]` : host;

    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.searchParams.has('relay')) {
        const relayRaw = (u.searchParams.get('relay') || '').trim();
        const port = /^\d+$/.test(relayRaw) ? Number(relayRaw) : NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, error: 'invalid ?relay= port in URL' };
        }
        return {
            ok: true,
            host,
            port,
            wsUrl: `${secure ? 'wss:' : 'ws:'}//${urlHost}:${port}`,
            token,
            hadHashToken,
        };
    }

    const port = u.port ? Number(u.port) : (secure ? 443 : 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: 'invalid port in relay URL' };
    }
    const path = (u.protocol === 'ws:' || u.protocol === 'wss:') && u.pathname && u.pathname !== '/' ? u.pathname : '';
    const wsUrl = `${secure ? 'wss:' : 'ws:'}//${urlHost}${u.port ? `:${port}` : ''}${path}`;
    return { ok: true, host, port, wsUrl, token, hadHashToken };
}

/**
 * Scrub `token` from `window.location.hash` via `history.replaceState` if present.
 * @returns {{ hadToken: boolean, tok: string }}
 */
function scrubTokenFromLocationHash() {
    if (typeof window === 'undefined') return { hadToken: false, tok: '' };
    const rawHash = typeof window.location?.hash === 'string' ? window.location.hash : '';
    if (rawHash.length <= 1) return { hadToken: false, tok: '' };
    const params = new URLSearchParams(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash);
    if (!params.has('token')) return { hadToken: false, tok: '' };
    const tok = (params.get('token') || '').trim();
    params.delete('token');
    const rest = params.toString();
    const clean = `${window.location.pathname || '/'}${window.location.search || ''}${rest ? `#${rest}` : ''}`;
    try { window.history?.replaceState?.(window.history.state ?? null, '', clean); } catch { /* ignore */ }
    return { hadToken: true, tok };
}

/**
 * Read `#token=<tok>` from `window.location.hash` (always scrubbing `token` from the
 * address bar via `history.replaceState`, and caching valid `TOKEN_CHARS` tokens in
 * tab-scoped `sessionStorage` under `g3d.relayToken.<host>:<port>`), or fall back to
 * this tab's `sessionStorage` entry for `(host, port)`.
 * Never touches `localStorage`, so closing the tab leaves no saved token state.
 * @param {number|string|null|undefined} port
 * @param {string|null|undefined} [host]
 * @returns {string|null}
 */
export function consumeRelayTokenFromLocation(port, host) {
    if (typeof window === 'undefined') return null;
    const key = relayTokenStorageKey(port, host);
    const { hadToken, tok } = scrubTokenFromLocationHash();
    if (hadToken && tok && TOKEN_CHARS.test(tok)) {
        try { window.sessionStorage?.setItem?.(key, tok); } catch { /* ignore */ }
        return tok;
    }
    try {
        const saved = window.sessionStorage?.getItem?.(key);
        if (saved == null) return null;
        const trimmed = saved.trim();
        if (!trimmed) {
            if (saved.length > 0) {
                try { window.sessionStorage?.removeItem?.(key); } catch { /* ignore */ }
            }
            return null;
        }
        if (TOKEN_CHARS.test(trimmed)) return trimmed;
        try { window.sessionStorage?.removeItem?.(key); } catch { /* ignore */ }
        return null;
    } catch {
        return null;
    }
}

/**
 * Scrub `#token=...` fragments, `?token=...` query leaks, and `g3d-token.<tok>`
 * subprotocol strings from free-form log/error text. Idempotent on already-redacted text.
 * @template T
 * @param {T} text
 * @returns {T|string}
 */
export function redactRelaySecrets(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/(#[^\s]*?\btoken=)[^&\s;"')\]}]*/gi, '$1[REDACTED]')
        .replace(/([?&;]\btoken=)[^&\s;"')\]}]+/gi, '$1[REDACTED]')
        .replace(/\bg3d-token\.(?:\[REDACTED\]|[!#$%&'*+.^_`|~0-9A-Za-z-]*)/g, 'g3d-token.[REDACTED]')
        .replace(/(\bBearer\s+)[^\s"'\\,)\];}]+/gi, '$1[REDACTED]');
}

/**
 * Tokenize a shell-like command line (mirroring `CommandRouter.parse`) without mutating state.
 * @param {string} line
 * @returns {string[]}
 */
function tokenizeCommandLine(line) {
    const tokens = [];
    let current = '';
    let inQuote = false;
    let escaped = false;
    for (const ch of line) {
        if (escaped) {
            if (ch === 'n') current += '\n';
            else if (ch === 't') current += '\t';
            else current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inQuote = !inQuote;
            continue;
        }
        if (/\s/.test(ch) && !inQuote) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

/**
 * Decode a `call <base64-json>` payload into an inner `[cmd, ...args]` vector if valid.
 * @param {string|undefined} b64
 * @returns {string[]|null}
 */
function decodeCallInvocation(b64) {
    if (typeof b64 !== 'string' || !b64) return null;
    try {
        const spec = JSON.parse(decodeBase64(b64));
        let inv = null;
        if (Array.isArray(spec)) inv = spec;
        else if (spec && typeof spec === 'object' && typeof spec.cmd === 'string') {
            inv = [spec.cmd, ...(Array.isArray(spec.args) ? spec.args : [])];
        }
        if (!inv || !inv.length || typeof inv[0] !== 'string') return null;
        return [inv[0], ...inv.slice(1).map((a) => (typeof a === 'string' ? a : String(a)))];
    } catch {
        return null;
    }
}

/**
 * Return true if `lineOrTokens` invokes a token-bearing command (`relay.token`,
 * `wall.token`, `relay.connect` with >=2 args or a non-port token-like arg, or a
 * `call` bundle wrapping one) or contains `#token=` / `?token=` / `g3d-token.`.
 * @param {string|string[]|null|undefined} lineOrTokens
 * @param {number} [_depth=0]
 * @returns {boolean}
 */
export function isSecretCommand(lineOrTokens, _depth = 0) {
    if (_depth > 3 || lineOrTokens == null) return false;
    let rawText = '';
    let tokens = [];
    if (Array.isArray(lineOrTokens)) {
        tokens = lineOrTokens.map((t) => String(t ?? ''));
        rawText = tokens.join(' ');
    } else if (typeof lineOrTokens === 'string') {
        rawText = lineOrTokens;
        tokens = tokenizeCommandLine(lineOrTokens.trim());
    } else {
        return false;
    }

    if (/(#[^\s]*?\btoken=|[?&;]\btoken=)/i.test(rawText) || /\bg3d-token\./.test(rawText)) {
        return true;
    }
    if (!tokens.length) return false;

    const t0 = tokens[0].toLowerCase();
    const t1 = (tokens[1] || '').toLowerCase();

    if (t0 === 'relay.token' || t0 === 'wall.token' || /^relay\.tok/.test(t0) || /^wall\.tok/.test(t0)) {
        return true;
    }
    if ((t0 === 'relay' || t0 === 'wall') && (t1 === 'token' || /^tok/.test(t1))) {
        return true;
    }

    let connectArgs = null;
    if (t0 === 'relay.connect') {
        connectArgs = tokens.slice(1);
    } else if (t0 === 'relay' && t1 === 'connect') {
        connectArgs = tokens.slice(2);
    }
    if (connectArgs !== null) {
        if (connectArgs.length >= 2) return true;
        if (connectArgs.length === 1) {
            const a0 = connectArgs[0].trim();
            if (a0 && !/^\d+$/.test(a0) && !a0.includes('://')) return true;
        }
        return false;
    }

    if (t0 === 'call' && tokens[1]) {
        const inner = decodeCallInvocation(tokens[1]);
        if (inner && isSecretCommand(inner, _depth + 1)) return true;
    }

    return false;
}

/**
 * Return a copy of `args` safe for telemetry, console debug output, and ErrorTracker.
 * @param {string} cmdName
 * @param {any[]} args
 * @returns {any[]}
 */
export function redactCommandArgs(cmdName, args) {
    if (!Array.isArray(args)) return [];
    const cmd = typeof cmdName === 'string' ? cmdName.trim().toLowerCase().replace(/\s+/g, '.') : '';
    if (cmd === 'relay.token' || cmd === 'wall.token') {
        return args.map(() => '[REDACTED]');
    }
    if (cmd === 'relay.connect') {
        return args.map((arg, idx) => {
            if (idx >= 1) return '[REDACTED]';
            const s0 = String(arg ?? '').trim();
            if (/^\d+$/.test(s0)) return typeof arg === 'string' ? redactRelaySecrets(arg) : arg;
            if (s0.includes('://')) return redactRelaySecrets(String(arg));
            return '[REDACTED]';
        });
    }
    if (cmd === 'call' && args.length > 0 && typeof args[0] === 'string') {
        const inner = decodeCallInvocation(args[0]);
        if (inner && isSecretCommand(inner, 1)) {
            return args.map((_, idx) => (idx === 0 ? '[REDACTED]' : '[REDACTED]'));
        }
    }
    return args.map((arg) => (typeof arg === 'string' ? redactRelaySecrets(arg) : arg));
}

/**
 * Scrub a full command/response text line for `_addLog`.
 * @param {string} text
 * @returns {string}
 */
function redactLogLine(text) {
    if (typeof text !== 'string' || !text) return '';
    const tokens = tokenizeCommandLine(text.trim());
    if (tokens.length > 0) {
        const t0 = tokens[0].toLowerCase();
        const t1 = (tokens[1] || '').toLowerCase();
        if (t0 === 'relay.token' || t0 === 'wall.token' || /^relay\.tok/.test(t0) || /^wall\.tok/.test(t0)) {
            const safe = redactCommandArgs('relay.token', tokens.slice(1));
            return [tokens[0], ...safe].join(' ');
        }
        if ((t0 === 'relay' || t0 === 'wall') && (t1 === 'token' || /^tok/.test(t1))) {
            const safe = redactCommandArgs('relay.token', tokens.slice(2));
            return [tokens[0], tokens[1], ...safe].join(' ');
        }
        if (t0 === 'relay.connect') {
            const safe = redactCommandArgs('relay.connect', tokens.slice(1));
            return [tokens[0], ...safe].join(' ');
        }
        if (t0 === 'relay' && t1 === 'connect') {
            const safe = redactCommandArgs('relay.connect', tokens.slice(2));
            return [tokens[0], tokens[1], ...safe].join(' ');
        }
        if (t0 === 'call' && tokens.length > 1) {
            const safe = redactCommandArgs('call', tokens.slice(1));
            if (safe[0] === '[REDACTED]') {
                return [tokens[0], ...safe].join(' ');
            }
        }
    }
    return redactRelaySecrets(text);
}

export default class WebSocketBridge {
    /**
     * @param {import('./CommandRouter.js').default} router
     * @param {Object} [options]
     * @param {string} [options.url] - override relay URL (default auto-detect)
     * @param {string} [options.host] - override relay host (default derived from `options.url` or `window.location.hostname`)
     * @param {number} [options.port=8080] - relay server port
     * @param {string|null} [options.token] - override relay capability token (default: URL `#token=` / tab sessionStorage)
     * @param {boolean} [options.autoConnect=true] - connect on construction
     * @param {boolean} [options.showStatus=true] - show status bar element
     */
    constructor(router, options = {}) {
        this.router = router;

        const rawUrl = typeof options.url === 'string' && options.url.trim() ? options.url.trim() : null;
        const parsedInit = rawUrl ? parseRelayEndpoint(rawUrl) : null;
        const optPort = Number(options.port);
        const validOptPort = Number.isInteger(optPort) && optPort >= 1 && optPort <= 65535 ? optPort : null;

        if (parsedInit && parsedInit.ok) {
            this.host = parsedInit.host;
            this.port = validOptPort ?? parsedInit.port;
            this.url = parsedInit.wsUrl;
        } else {
            this.host = normalizeRelayHost(options.host);
            const loc = typeof window !== 'undefined' ? window.location : null;
            if (!validOptPort && !rawUrl && loc && loc.port && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
                const locPort = Number(loc.port);
                this.port = Number.isInteger(locPort) && locPort >= 1 && locPort <= 65535 ? locPort : 8080;
            } else {
                this.port = validOptPort ?? 8080;
            }
            this.url = rawUrl ? (rawUrl.includes('#') ? rawUrl.slice(0, rawUrl.indexOf('#')) : rawUrl) : null;
        }

        if (options.token !== undefined) {
            scrubTokenFromLocationHash();
            this.token = parseRelayTokenInput(options.token);
        } else {
            this.token = consumeRelayTokenFromLocation(this.port, this.host);
        }

        if (rawUrl && rawUrl.includes('#')) {
            const urlTok = parseRelayTokenInput(rawUrl);
            if (urlTok) {
                this.token = urlTok;
                if (typeof window !== 'undefined') {
                    try { window.sessionStorage?.setItem?.(relayTokenStorageKey(this.port, this.host), urlTok); } catch { /* ignore */ }
                }
            }
        }

        this._bootHost = this.host;
        this._bootPort = this.port;
        this._bootUrl = this.url || this._resolveAutoUrl();

        this.ws = null;
        this.connected = false;
        this.clientId = null;  // assigned by relay on registration

        // Reconnect config
        this._reconnectDelay = 2000;
        this._maxReconnectDelay = 30000;
        this._currentDelay = this._reconnectDelay;
        this._reconnectTimer = null;
        this._intentionalClose = false;

        // LAN address detection
        this._lanAddress = null;
        this._detectLanAddress();

        // Status bar UI
        this._statusEl = null;
        if (options.showStatus !== false) {
            this._createStatusBar();
        }

        // JSON-RPC 2.0 support
        this._rpcId = 0;
        this._rpcPending = new Map();  // id -> { resolve, reject, timer }
        this._rpcNotificationHandler = null;

        // One-shot relay-event waiters: event name → FIFO queue of { resolve, timer }.
        // terminal.spawn awaits its `terminal.spawning` ack through here — a promise
        // per spawn instead of shared intent state. FIFO matches the relay's serial
        // per-socket message processing, so parallel spawns pair with their acks.
        this._eventWaiters = new Map();

        // Stats
        this._commandsReceived = 0;
        this._commandsSent = 0;
        this._connectedClients = new Set();

        // Command I/O log (ring buffer, max 200 entries)
        this._log = [];
        this._logMax = 200;
        this._logListeners = [];

        // Connection-state listeners — notified (true) on open, (false) on close.
        // Lets DOM chrome fetch-on-connect and refetch-on-reconnect instead of
        // racing a not-yet-open socket (the relay restarts often in dev).
        this._connectionListeners = new Set();
        // Last broadcast state — so a failed-reconnect storm (close after close,
        // each retry) doesn't spam listeners with repeated `false`.
        this._lastEmitted = null;

        // Binary data-plane frame demux: type byte → handler(id, payload). The bridge
        // is transport-only — byte/terminal semantics register here (terminal OUTPUT).
        this._binaryHandlers = new Map();

        // Sensor plane: device attach/detach + frames. Same transport-only stance
        // as the binary handlers — SourceStream registers here to give the
        // envelopes meaning.
        this._sourceListeners = new Set();

        // Reconcile a fresh `#token=...` pasted into an already-open tab with zero page reload.
        this._onHashChange = () => {
            if (typeof window === 'undefined') return;
            const rawHash = typeof window.location?.hash === 'string' ? window.location.hash : '';
            if (rawHash.length <= 1) return;
            const params = new URLSearchParams(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash);
            if (!params.has('token')) return;
            const hashTok = (params.get('token') || '').trim();
            const hashValid = Boolean(hashTok && TOKEN_CHARS.test(hashTok));
            const next = consumeRelayTokenFromLocation(this.port, this.host);
            if (hashValid && next && next !== this.token) {
                this.setToken(next);
            }
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('hashchange', this._onHashChange);
        }

        if (options.autoConnect !== false) {
            this.connect();
        }
    }

    // ============ Connection ============

    /**
     * Resolve the default WebSocket URL when `options.url` was not explicitly given.
     * Supports both `http:` -> `ws:` and `https:` -> `wss:`.
     * @private
     * @returns {string}
     */
    _resolveAutoUrl() {
        const loc = typeof window !== 'undefined' ? window.location : null;
        if (loc && loc.port && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
            const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = normalizeRelayHost(loc.hostname);
            const urlHost = host.includes(':') ? `[${host}]` : host;
            return `${proto}//${urlHost}:${loc.port}`;
        }
        const proto = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
        const urlHost = this.host.includes(':') ? `[${this.host}]` : this.host;
        return `${proto}//${urlHost}:${this.port}`;
    }

    /**
     * Set or replace the relay capability token (accepts either a raw token or a
     * URL carrying `#token=...`), update this tab's `sessionStorage` under
     * `g3d.relayToken.<host>:<port>`, and optionally reconnect immediately.
     * @param {string|null} token
     * @param {{ reconnect?: boolean }} [opts]
     */
    setToken(token, { reconnect = true } = {}) {
        const parsed = parseRelayTokenInput(token);
        this.token = parsed;
        if (typeof window !== 'undefined') {
            const key = relayTokenStorageKey(this.port, this.host);
            try {
                if (parsed) window.sessionStorage?.setItem?.(key, parsed);
                else window.sessionStorage?.removeItem?.(key);
            } catch { /* ignore */ }
        }
        if (reconnect && !this._intentionalClose) {
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
            }
            this._currentDelay = this._reconnectDelay;
            this.connect();
        }
    }

    /**
     * Point the bridge at a `(host, port)` relay endpoint. Each `(host, port)` pair owns
     * an isolated capability token in `sessionStorage`, so switching hosts or ports never
     * transmits one relay's token to another.
     * @param {string} host
     * @param {number} port
     */
    useEndpoint(host, port) {
        const nextPort = Number(port);
        if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) return;
        const normHost = normalizeRelayHost(host);
        if (normHost === this.host && nextPort === this.port) return;
        this.host = normHost;
        this.port = nextPort;
        this.token = consumeRelayTokenFromLocation(nextPort, normHost);
    }

    /**
     * Point the bridge at another relay port (and optional host, defaulting to `this.host`).
     * @param {number} port
     * @param {string} [host=this.host]
     */
    usePort(port, host = this.host) {
        this.useEndpoint(host, port);
    }

    /**
     * Restore the boot-resolved `(host, port, url)` target and reload its saved token.
     */
    resetToBootEndpoint() {
        this.host = this._bootHost;
        this.port = this._bootPort;
        this.url = this._bootUrl;
        this.token = consumeRelayTokenFromLocation(this.port, this.host);
    }

    /**
     * Connect to the relay server.
     * @param {string} [url] - override URL (or port) for this connection attempt
     */
    connect(url) {
        if (url !== undefined && url !== null && url !== '') {
            const parsed = parseRelayEndpoint(url, { defaultHost: this.host });
            if (!parsed.ok) {
                console.warn(`[ws-bridge] refusing invalid relay endpoint: ${parsed.error}`);
                return;
            }
            this.useEndpoint(parsed.host, parsed.port);
            if (parsed.token) {
                this.setToken(parsed.token, { reconnect: false });
            }
            this.url = parsed.wsUrl;
        }
        if (!this.url) {
            const loc = typeof window !== 'undefined' ? window.location : null;
            if (loc && loc.port && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
                const locPort = Number(loc.port);
                if (Number.isInteger(locPort) && locPort >= 1 && locPort <= 65535) {
                    this.useEndpoint(loc.hostname, locPort);
                }
            }
            this.url = this._resolveAutoUrl();
        } else if (this.url.includes('#')) {
            this.url = this.url.slice(0, this.url.indexOf('#'));
        }
        if (!this.token) {
            this.token = consumeRelayTokenFromLocation(this.port, this.host);
        }
        this._intentionalClose = false;
        this._doConnect();
    }

    /**
     * Connect via LAN address (for phone/tablet control), isolating token lookup to
     * `this._lanAddress` so `localhost`'s capability token is never transmitted over LAN.
     */
    connectLAN() {
        if (!this._lanAddress) {
            console.warn('[ws-bridge] LAN address not detected');
            return;
        }
        this.useEndpoint(this._lanAddress, this.port);
        const proto = (typeof window !== 'undefined' && window.location?.protocol === 'https:') ? 'wss:' : 'ws:';
        const urlHost = this.host.includes(':') ? `[${this.host}]` : this.host;
        this.url = `${proto}//${urlHost}:${this.port}`;
        if (!this.token) {
            this.token = consumeRelayTokenFromLocation(this.port, this.host);
        }
        this._intentionalClose = false;
        this._doConnect();
    }

    /**
     * Disconnect from the relay.
     */
    disconnect() {
        this._intentionalClose = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this._updateStatus();
        console.log('[ws-bridge] disconnected');
    }

    /**
     * Send a raw message to the relay (for display->controller responses).
     * @param {string} raw
     */
    send(raw) {
        if (this.ws && this.connected) {
            this.ws.send(raw);
        }
    }

    /**
     * Push an event to a specific controller client.
     * Used to forward terminal input, notifications, etc. to the owning agent.
     * @param {string} clientId - target controller
     * @param {Object} payload - { event, data }
     */
    push(clientId, payload) {
        if (!this.connected || !this.ws) return;
        this.ws.send(JSON.stringify({ to: clientId, ...payload }));
    }

    // ============ JSON-RPC 2.0 ============

    /**
     * Send a JSON-RPC 2.0 request and await the response.
     * @param {string} method - e.g. "fs/readFile"
     * @param {Object} params
     * @param {number} [timeoutMs=10000]
     * @returns {Promise<any>} - result field from JSON-RPC response
     * @throws on JSON-RPC error response or timeout
     */
    rpcRequest(method, params, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || !this.connected) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const id = ++this._rpcId;
            const timer = setTimeout(() => {
                this._rpcPending.delete(id);
                reject(new Error(`RPC timeout: ${method} (id=${id})`));
            }, timeoutMs);

            this._rpcPending.set(id, { resolve, reject, timer });

            const msg = JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
            this.ws.send(msg);
        });
    }

    /**
     * Subscribe to connection-state changes. The callback fires with `true` when
     * the socket opens (including reconnects) and `false` when it closes. If
     * already connected, fires `true` immediately so subscribers needn't special-
     * case the "subscribed after connect" race.
     * @param {(connected: boolean) => void} fn
     * @returns {() => void} unsubscribe
     */
    onConnectionChange(fn) {
        this._connectionListeners.add(fn);
        if (this.connected) {
            try { fn(true); } catch (e) { console.error('[ws-bridge] connection listener threw:', e); }
        }
        return () => this._connectionListeners.delete(fn);
    }

    /** @private */
    _emitConnection(state) {
        if (state === this._lastEmitted) return;  // ignore repeated false during a reconnect storm
        this._lastEmitted = state;
        for (const fn of this._connectionListeners) {
            try { fn(state); } catch (e) { console.error('[ws-bridge] connection listener threw:', e); }
        }
    }

    /**
     * Subscribe to the sensor plane: `source_connected`, `source_disconnected`,
     * and `source.frame` envelopes from the relay. The bridge stays schema-blind
     * here exactly as the relay does — it delivers envelopes and lets SourceStream
     * decide what a `handFrame` means.
     * @param {(envelope: {event: string, sourceId?: string, source?: string, kind?: string, data?: Object}) => void} fn
     * @returns {() => void} unsubscribe
     */
    onSourceEvent(fn) {
        this._sourceListeners.add(fn);
        return () => this._sourceListeners.delete(fn);
    }

    /** @private */
    _emitSource(envelope) {
        for (const fn of this._sourceListeners) {
            try { fn(envelope); } catch (e) { console.error('[ws-bridge] source listener threw:', e); }
        }
    }

    /**
     * Subscribe to JSON-RPC notifications (messages with method but no id) — the relay's
     * push channel: fs/didChange, fs/searchMatch, fs/searchDone, LSP diagnostics.
     * MANY subscribers: the stream carries unrelated subsystems, and each one owns its
     * own method filter. Returns an unsubscribe fn — a controller that disposes must
     * stop receiving, or a dead run's late matches would land in a freed cache.
     * @param {(method: string, params: Object) => void} fn
     * @returns {() => void} unsubscribe
     */
    onRpcNotification(fn) {
        if (!this._rpcNotificationHandlers) this._rpcNotificationHandlers = new Set();
        this._rpcNotificationHandlers.add(fn);
        return () => { this._rpcNotificationHandlers?.delete(fn); };
    }

    /**
     * Await the next relay event of a given name — one-shot, FIFO per name. Resolves
     * with the event envelope, or null on timeout (the waiter removes itself either
     * way, so a never-fired event can't leak). `client_connected`/`client_disconnected`
     * are reserved for the bridge's own bookkeeping and never reach waiters.
     * @param {string} event
     * @param {number} [timeoutMs=10000]
     * @returns {Promise<Object|null>}
     */
    waitForEvent(event, timeoutMs = 10000) {
        return new Promise((resolve) => {
            const entry = { resolve: (payload) => { clearTimeout(entry.timer); resolve(payload); }, timer: null };
            entry.timer = setTimeout(() => {
                const q = this._eventWaiters.get(event);
                if (q) {
                    const i = q.indexOf(entry);
                    if (i !== -1) q.splice(i, 1);
                }
                resolve(null);
            }, timeoutMs);
            let q = this._eventWaiters.get(event);
            if (!q) this._eventWaiters.set(event, (q = []));
            q.push(entry);
        });
    }

    /** @private — hand an event envelope to its oldest waiter. True when consumed. */
    _dispatchEvent(envelope) {
        const waiter = this._eventWaiters.get(envelope.event)?.shift();
        if (!waiter) return false;
        waiter.resolve(envelope);
        return true;
    }

    /**
     * Register a handler for binary data-plane frames of a given type byte. Wire
     * frame: [type:u8][idLen:u8][id:utf8][payload]; the handler receives
     * (id, payload:Uint8Array). Used for the terminal OUTPUT byte stream.
     * @param {number} type
     * @param {(id: string, payload: Uint8Array) => void} fn
     * @returns {() => void} unsubscribe
     */
    onBinaryFrame(type, fn) {
        this._binaryHandlers.set(type, fn);
        return () => this._binaryHandlers.delete(type);
    }

    /** @private — parse a binary frame and dispatch by its type byte. */
    _handleBinary(buf) {
        const view = new Uint8Array(buf);
        if (view.length < 2) return;
        const type = view[0];
        const idLen = view[1];
        if (view.length < 2 + idLen) return;
        const id = new TextDecoder().decode(view.subarray(2, 2 + idLen));

        // RPC binary result (relay → display, fs/sessions content plane):
        // [0x02][idLen][id][hdrLen:u32 BE][hdr JSON][raw payload] — the header carries
        // every result field except the content, the payload is the raw file bytes.
        if (type === 0x02) {
            this._handleRPCBinary(id, view.subarray(2 + idLen));
            return;
        }

        // OUTPUT frames carry the size the payload was drawn at, right after the id:
        // [type][idLen][id][cols:u16 BE][rows:u16 BE][payload]. See attach_unix.go (frameOutput).
        if (view.length < 2 + idLen + 4) return;
        const off = 2 + idLen;
        const cols = (view[off] << 8) | view[off + 1];
        const rows = (view[off + 2] << 8) | view[off + 3];
        const payload = view.subarray(off + 4);
        const handler = this._binaryHandlers.get(type);
        if (handler) handler(id, payload, cols, rows);
    }

    /**
     * Resolve a pending rpcRequest from a binary result frame. The promise settles
     * with { ...headerFields, bytes: Uint8Array } — the provider decodes (`bytes`
     * for readRange, TextDecoder→content for readFile). Errors never
     * ride this plane: they stay small JSON text responses on the regular path.
     * @param {string} idStr @param {Uint8Array} rest @private
     */
    _handleRPCBinary(idStr, rest) {
        if (rest.length < 4) return;
        const hdrLen = new DataView(rest.buffer, rest.byteOffset, 4).getUint32(0);
        if (rest.length < 4 + hdrLen) return;
        let hdr;
        try { hdr = JSON.parse(new TextDecoder().decode(rest.subarray(4, 4 + hdrLen))); }
        catch { return; }
        const pending = this._rpcPending.get(Number(idStr));
        if (!pending) return;
        this._rpcPending.delete(Number(idStr));
        clearTimeout(pending.timer);
        pending.resolve({ ...hdr, bytes: rest.subarray(4 + hdrLen) });
    }

    // ============ LAN Detection ============

    /**
     * Detect the LAN address using WebRTC ICE candidates.
     * Falls back to page hostname if not localhost.
     * @private
     */
    _detectLanAddress() {
        // If the page was loaded via a LAN IP, use that
        const hostname = typeof window !== 'undefined' ? cleanHostString(window.location?.hostname) : '';
        if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
            this._lanAddress = hostname;
            return;
        }

        // Try WebRTC-based detection (works in most browsers)
        try {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pc.createDataChannel('');
            pc.createOffer().then(offer => pc.setLocalDescription(offer));
            pc.onicecandidate = (event) => {
                if (!event || !event.candidate) return;
                const parts = event.candidate.candidate.split(' ');
                // ICE candidate format: ... <IP> <port> ...
                const ip = parts[4];
                if (ip && !ip.startsWith('127.') && !ip.includes(':')) {
                    this._lanAddress = ip;
                    this._updateStatus();
                    pc.close();
                }
            };
            // Cleanup after timeout
            setTimeout(() => { try { pc.close(); } catch(e) {} }, 5000);
        } catch (e) {
            // WebRTC not available
        }
    }

    /**
     * Get the detected LAN address.
     * @returns {string|null}
     */
    getLanAddress() {
        return this._lanAddress;
    }

    /**
     * Get the full connection URL for external controllers.
     * @returns {{ localhost: string, lan: string|null, connected: boolean, url: string|null }}
     */
    getConnectionInfo() {
        const proto = (typeof window !== 'undefined' && window.location?.protocol === 'https:') ? 'wss:' : 'ws:';
        const localhost = `${proto}//localhost:${this.port}`;
        const lanHost = this._lanAddress && this._lanAddress.includes(':') ? `[${this._lanAddress}]` : this._lanAddress;
        const lan = lanHost ? `${proto}//${lanHost}:${this.port}` : null;
        return { localhost, lan, connected: this.connected, url: this.url };
    }

    // ============ Status Bar UI ============

    /**
     * Create and inject the status bar element into the page.
     * @private
     */
    _createStatusBar() {
        if (typeof document === 'undefined' || !document.body) return;
        this._statusEl = document.createElement('div');
        this._statusEl.id = 'ws-status-bar';
        Object.assign(this._statusEl.style, {
            position: 'fixed',
            bottom: '8px',
            right: '8px',
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            fontFamily: 'monospace',
            color: '#888',
            backgroundColor: 'rgba(10, 10, 10, 0.85)',
            border: '1px solid #333',
            zIndex: '10000',
            cursor: 'pointer',
            userSelect: 'none',
            transition: 'all 0.3s ease',
            maxWidth: '350px',
        });

        this._statusEl.addEventListener('click', () => {
            this._showConnectionDetails();
        });

        document.body.appendChild(this._statusEl);
        this._updateStatus();
    }

    /**
     * Update the status bar text and color.
     * @private
     */
    _updateStatus() {
        if (!this._statusEl) return;

        if (this.connected) {
            const addr = this._lanAddress ? `LAN: ${this._lanAddress}:${this.port}` : `localhost:${this.port}`;
            this._statusEl.textContent = `WS: ${addr}`;
            this._statusEl.style.color = '#4ade80';
            this._statusEl.style.borderColor = '#166534';
        } else {
            this._statusEl.textContent = 'WS: disconnected';
            this._statusEl.style.color = '#888';
            this._statusEl.style.borderColor = '#333';
        }
    }

    /**
     * Show a temporary expanded view with full connection details.
     * @private
     */
    _showConnectionDetails() {
        if (!this._statusEl) return;

        const info = this.getConnectionInfo();
        const lines = [
            `Status: ${this.connected ? 'CONNECTED' : 'DISCONNECTED'}`,
            `URL: ${this.url || 'none'}`,
            `Localhost: ${info.localhost}`,
        ];
        if (info.lan) {
            lines.push(`LAN: ${info.lan}`);
        }
        lines.push(`Commands: ${this._commandsReceived} received`);

        this._statusEl.textContent = lines.join(' | ');
        this._statusEl.style.maxWidth = '600px';

        // Collapse back after 5 seconds
        setTimeout(() => {
            this._statusEl.style.maxWidth = '350px';
            this._updateStatus();
        }, 5000);
    }

    // ============ Internal Connection Logic ============

    /** @private */
    _doConnect() {
        // Close any existing socket before creating a new one
        if (this.ws) {
            try { this.ws.onopen = null; this.ws.onclose = null; this.ws.onerror = null; this.ws.close(); } catch (e) {}
        }

        try {
            const validToken = this.token && TOKEN_CHARS.test(this.token) ? this.token : null;
            if (this.token && !validToken) {
                console.warn('[ws-bridge] dropping malformed relay token (non-RFC-7230 characters)');
                this.token = null;
            }
            const protocols = validToken ? ['glyph3d', `g3d-token.${validToken}`] : ['glyph3d'];
            this.ws = new WebSocket(this.url, protocols);
            this.ws.binaryType = 'arraybuffer'; // terminal OUTPUT frames arrive as ArrayBuffer
        } catch (err) {
            console.warn(`[ws-bridge] failed to create WebSocket: ${redactRelaySecrets(err?.message || String(err))}`);
            this._scheduleReconnect();
            return;
        }

        // Capture socket reference — if _doConnect is called again before
        // this socket opens, the closure must use the socket it was bound to.
        const socket = this.ws;

        socket.onopen = () => {
            if (this.ws !== socket) return; // stale socket, ignore
            console.log(`[ws-bridge] connected to ${this.url}`);
            this.connected = true;
            this._currentDelay = this._reconnectDelay;
            // Register as display client
            socket.send('DISPLAY');
            this._updateStatus();
            this._emitConnection(true);
        };

        socket.onmessage = (event) => {
            this._handleMessage(event.data);
        };

        socket.onclose = () => {
            if (this.ws !== socket) return; // stale socket, ignore
            this.connected = false;
            this._updateStatus();
            this._emitConnection(false);
            if (!this._intentionalClose) {
                // Debug-level: when no relay is running this fires on every retry —
                // the visible signal is the connection chip, not the console.
                console.debug('[ws-bridge] disconnected, will retry...');
                this._scheduleReconnect();
            }
        };

        this.ws.onerror = () => {
            // Errors are always followed by onclose (which schedules the retry), so
            // this is just a quiet breadcrumb — no warn-level spam while polling.
            console.debug('[ws-bridge] connection error');
        };
    }

    /** @private */
    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            console.debug(`[ws-bridge] reconnecting...`);
            this._doConnect();
            this._currentDelay = Math.min(this._currentDelay * 1.5, this._maxReconnectDelay);
        }, this._currentDelay);
    }

    /**
     * Handle an incoming message from the relay.
     * @param {string} raw
     * @private
     */
    async _handleMessage(raw) {
        // Binary frames are the terminal OUTPUT data plane — demux by type byte and
        // return before the JSON path (JSON.parse on an ArrayBuffer would throw).
        if (raw instanceof ArrayBuffer) {
            this._handleBinary(raw);
            return;
        }
        let envelope;
        try {
            envelope = JSON.parse(raw);
        } catch {
            console.log(`[ws-bridge] non-JSON message: ${redactRelaySecrets(String(raw ?? ''))}`);
            return;
        }

        // JSON-RPC 2.0 response or notification — route before command handling
        if (envelope.jsonrpc === '2.0') {
            if (envelope.id != null) {
                // Response to a pending rpcRequest
                const pending = this._rpcPending.get(envelope.id);
                if (pending) {
                    this._rpcPending.delete(envelope.id);
                    clearTimeout(pending.timer);
                    if (envelope.error) {
                        const err = new Error(envelope.error.message || 'RPC error');
                        err.code = envelope.error.code;
                        err.data = envelope.error.data;
                        pending.reject(err);
                    } else {
                        pending.resolve(envelope.result);
                    }
                }
            } else if (envelope.method) {
                // Notification (no id) — e.g. fs/didChange, fs/searchMatch.
                // One subscriber's throw must not swallow the rest of the fan-out.
                if (this._rpcNotificationHandlers) {
                    for (const fn of this._rpcNotificationHandlers) {
                        try { fn(envelope.method, envelope.params); }
                        catch (e) { console.warn(`[bridge] notification handler failed for ${envelope.method}:`, e?.message ?? e); }
                    }
                }
            }
            return;
        }

        // Registration ack from relay. `sources` lists sensor devices that were
        // already streaming before this page loaded — replayed as connect events
        // so a reload re-adopts them without the device knowing anything happened.
        if (envelope.ok !== undefined) {
            console.log('[ws-bridge] registered as display');
            for (const src of envelope.sources || []) {
                this._emitSource({ event: 'source_connected', sourceId: src.id, kind: src.kind });
            }
            return;
        }

        // Sensor plane: device attach/detach and the frames themselves. Frames are
        // high-rate (~30fps per device) and land before the command path so they
        // never pay for command dispatch.
        if (envelope.event === 'source.frame' ||
            envelope.event === 'source_connected' ||
            envelope.event === 'source_disconnected') {
            this._emitSource(envelope);
            return;
        }

        // Client connect/disconnect notifications
        if (envelope.event === 'client_connected') {
            this._connectedClients.add(envelope.clientId);
            console.log(`[ws-bridge] controller connected: ${envelope.clientId}`);
            return;
        }
        if (envelope.event === 'client_disconnected') {
            this._connectedClients.delete(envelope.clientId);
            // Null out onInput for terminals owned by this client
            const registry = this.router.context?.registry;
            if (registry) {
                const owned = registry.findByMeta('owner', envelope.clientId) || [];
                for (const entry of owned) {
                    if (entry.grid && typeof entry.grid.onInput === 'function') {
                        entry.grid.onInput = null;
                    }
                }
            }
            console.log(`[ws-bridge] controller disconnected: ${envelope.clientId}`);
            return;
        }

        // One-shot event waiters (terminal.spawn awaiting its `terminal.spawning`
        // ack, carrying the id the forked adapter will register under) — resolved
        // FIFO, matching the relay's serial per-socket processing.
        if (envelope.event && this._dispatchEvent(envelope)) return;

        // Command from a controller
        if (envelope.from && envelope.cmd) {
            this._commandsReceived++;
            this._addLog('in', envelope.from, envelope.cmd);
            const result = await this.router.execute(envelope.cmd, { sender: envelope.from });

            // Send response back to the originating controller
            const response = {
                to: envelope.from,
                response: result.text,
            };

            // Include structured data if non-null (for programmatic controllers)
            if (result.data !== null) {
                response.data = result.data;
            }

            this._addLog('out', envelope.from, result.text);
            this.ws.send(JSON.stringify(response));
            return;
        }

        console.log('[ws-bridge] unhandled message:', envelope);
    }

    // ============ Command Log ============

    /** @private */
    _addLog(direction, clientId, text) {
        const raw = Array.isArray(text) ? text.map((t) => String(t ?? '')).join(' ') : String(text ?? '');
        const safe = redactLogLine(raw);
        const entry = {
            time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            dir: direction,    // 'in' or 'out'
            client: clientId,
            text: safe.length > 200 ? safe.slice(0, 197) + '...' : safe,
        };
        this._log.push(entry);
        if (this._log.length > this._logMax) this._log.shift();
        for (const fn of this._logListeners) fn(entry);
    }

    /**
     * Get all log entries.
     * @returns {Array<{time: string, dir: string, client: string, text: string}>}
     */
    getLog() { return this._log; }

    /**
     * Register a callback for new log entries.
     * @param {Function} fn - (entry) => void
     * @returns {Function} unsubscribe
     */
    onLog(fn) {
        this._logListeners.push(fn);
        return () => { this._logListeners = this._logListeners.filter(f => f !== fn); };
    }

    /**
     * Dispose: disconnect and remove UI elements.
     */
    dispose() {
        // Reject all pending RPC requests
        for (const [id, pending] of this._rpcPending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('WebSocketBridge disposed'));
        }
        this._rpcPending.clear();

        if (this._onHashChange && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('hashchange', this._onHashChange);
            this._onHashChange = null;
        }

        this.disconnect();
        if (this._statusEl && this._statusEl.parentNode) {
            this._statusEl.parentNode.removeChild(this._statusEl);
            this._statusEl = null;
        }
    }
}
