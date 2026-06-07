/**
 * Forward browser console output to a WebSocketBridge as `browser.log` events,
 * so a relay / server log mirrors what the browser sees in real time. This is
 * the single canonical forwarder — both the IDE command center and HomeShell
 * install it (it used to be copy-pasted between them, drifted on MAX_LEN and
 * uncaught-error handling).
 *
 * Patches console.log/warn/error in place (original output is preserved) and,
 * unless disabled, also captures the two failure surfaces plain console.* miss:
 * window.onerror (uncaught sync errors) and unhandledrejection (uncaught promise
 * rejections). Forwarding is a no-op until `bridge.connected` flips true —
 * `bridge.send` already guards on `ws && connected`, so callers needn't.
 *
 * Idempotent at module scope: console is patched once per page regardless of how
 * many times this is called.
 */

let _installed = false;

// In-memory ring of recent console output (ALL levels) — the single, consistent log sink
// the log.tail verb reads. Captured here because this is the one place every console.* call
// is intercepted; relay forwarding stays log/warn/error only (no debug/info spam on the wire).
const RING_MAX = 500;
const ring = [];
/** Recent console entries, oldest→newest. @param {number} [limit] @returns {Array<{ts:number,level:string,text:string}>} */
export function recentConsole(limit) {
    return limit ? ring.slice(-limit) : ring.slice();
}

/**
 * @param {import('./WebSocketBridge.js').default} bridge - the relay bridge;
 *   only its `send(raw)` method is used (it self-guards on connection state).
 * @param {Object} [options]
 * @param {number} [options.maxLen=400] - truncate each forwarded message to this
 *   many characters (an ellipsis is appended when clipped).
 * @param {boolean} [options.captureWindowErrors=true] - also forward
 *   window.onerror and unhandledrejection as error-level entries.
 * @returns {boolean} true if it installed the forwarder, false if it was already
 *   installed (and this call did nothing).
 */
export function installConsoleForwarder(bridge, options = {}) {
    if (_installed) return false;
    if (!bridge || typeof bridge.send !== 'function') return false;
    _installed = true;

    const { maxLen = 400, captureWindowErrors = true } = options;

    const send = (level, text) => {
        if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
        try {
            bridge.send(JSON.stringify({ event: 'browser.log', level, text }));
        } catch { /* bridge not ready / serialization failed — drop silently */ }
    };

    // Serialize console args to a single string. Error instances need special
    // handling — their enumerable own-props are empty, so JSON.stringify(err)
    // === "{}" and the relay log would lose the actual failure.
    const serialize = (args) => {
        try {
            return args.map((a) => {
                if (typeof a === 'string') return a;
                if (a instanceof Error) {
                    return a.stack ? `${a.message}\n${a.stack}` : a.message || String(a);
                }
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(' ');
        } catch {
            return String(args[0] ?? '');
        }
    };

    // The single, consistent capture path: ring (all levels, local + verbose) + relay
    // (log/warn/error only). Raw console.*, Logger output, and command traces all land here
    // uniformly, so log.tail sees everything regardless of how a module chose to log.
    const RELAY_LEVELS = new Set(['log', 'warn', 'error']);
    const capture = (level, text) => {
        if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
        ring.push({ ts: Date.now(), level, text });
        if (ring.length > RING_MAX) ring.shift();
        if (RELAY_LEVELS.has(level)) send(level, text);
    };

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            capture(level, serialize(args));
        };
    }

    if (captureWindowErrors && typeof window !== 'undefined') {
        window.addEventListener('error', (e) => {
            capture('error', `[uncaught] ${e.error?.stack || e.message || String(e)}`);
        });
        window.addEventListener('unhandledrejection', (e) => {
            const r = e.reason;
            capture('error', `[unhandled-rejection] ${r?.stack || r?.message || String(r)}`);
        });
    }

    return true;
}
