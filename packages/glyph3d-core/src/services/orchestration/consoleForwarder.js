/**
 * Structured browser-log capture + relay forwarding.
 *
 * Every log record — raw console.* calls, Logger output (via the structured sink),
 * window error/unhandledrejection, and direct emitLogRecord() callers — lands in one
 * in-memory ring of structured records and forwards to the relay as a `browser.log`
 * wire message:
 *
 *   {"event":"browser.log","rec":{ts,level,scope,msg,attrs,page,trunc?}}
 *
 * ALL levels forward (trace|debug|info|log|warn|error); filtering is the relay's job
 * (it stores records in SQLite and answers log.query / log.search / log.errors).
 *
 * Logger calls arrive structured through setLogRecordSink (scope = logger fullName,
 * attrs = context); the console.* patch skips Logger-originated console output via
 * isLoggerEmitting() so each Logger line lands exactly once.
 *
 * Idempotent at module scope: console is patched once per page regardless of how
 * many times installConsoleForwarder is called. emitLogRecord works before install
 * (ring only) — records emitted before the bridge connects are flushed
 * opportunistically: on each emit, any unsent backlog still in the ring goes out
 * (oldest first) before the current record. No timer — the next emit after connect
 * drains the backlog, which is the accepted boot-time behavior.
 */

import { setLogRecordSink, isLoggerEmitting } from '../../utils/Logger.js';

const RING_MAX = 500;
const MSG_MAX = 4096;
const ATTRS_MAX = 4096;

// Storm brake. A single fault can emit an identical error/warn record per FRAME,
// unbounded (the 2026-08-04 WebGPU storm: a dead device turned three's occlusion
// readback into ~8k unhandled rejections in minutes, burying the ring, the wire,
// and the relay store until the page died). Brake per signature (level+scope+msg —
// storms interleave scopes, so a consecutive-run brake never trips): the first
// BRAKE_PASS of each signature go through, the rest are dropped and counted, and
// every BRAKE_HEARTBEAT drops a single summary warn carries the count. No timer —
// the heartbeat rides the flood itself.
const BRAKE_LEVELS = new Set(['error', 'warn']);
const BRAKE_PASS = 5;
const BRAKE_HEARTBEAT = 500;
const BRAKE_SIG_MAX = 256;
const _brakeCounts = new Map();   // sig → records seen (passed + suppressed)
let _brakeSuppressed = 0;         // suppressed since the last heartbeat

/** Short page-load id, minted once per page so the relay can group records by load. */
const PAGE_ID = Math.random().toString(36).slice(2, 10);

/** @typedef {{ts:number, level:string, scope:string|null, msg:string, attrs:Object|null, page:string, trunc?:boolean}} LogRecord */

/** @type {LogRecord[]} */
const ring = [];

let _installed = false;
/** @type {{send: (raw:string)=>void, connected?: boolean}|null} */
let _bridge = null;
let _pushed = 0; // total records ever pushed to the ring
let _sent = 0;   // records handed to a connected bridge

/**
 * Recent structured log records, oldest→newest.
 * @param {number} [limit]
 * @returns {LogRecord[]}
 */
export function recentConsole(limit) {
    return limit ? ring.slice(-limit) : ring.slice();
}

/**
 * Wire form of attrs: the object itself when its JSON form fits the cap, otherwise
 * the clipped JSON text (or String(attrs) when not JSON-stringifiable). The ring
 * always keeps the original object.
 * @param {Object|null} attrs
 * @returns {Object|string|null}
 */
function wireAttrs(attrs) {
    if (attrs == null) return null;
    let s;
    try { s = JSON.stringify(attrs); } catch { s = undefined; }
    if (typeof s !== 'string') s = String(attrs);
    else if (s.length <= ATTRS_MAX) return attrs;
    return s.slice(0, ATTRS_MAX);
}

/**
 * @param {LogRecord} record
 * @returns {string} the serialized browser.log wire message
 */
function wireForm(record) {
    const rec = {
        ts: record.ts,
        level: record.level,
        scope: record.scope,
        msg: record.msg,
        attrs: wireAttrs(record.attrs),
        page: record.page,
    };
    if (record.trunc) rec.trunc = true;
    return JSON.stringify({ event: 'browser.log', rec });
}

/**
 * Structured log ingest: cap, ring, forward. The single path every capture surface
 * (console patch, Logger sink, window errors, dispatch telemetry) funnels through.
 * @param {string} level - trace|debug|info|log|warn|error
 * @param {string|null} scope - Logger fullName, or null for raw console output
 * @param {string} msg
 * @param {Object|null} attrs - structured context; stored as the object in the ring,
 *   defensively serialized (capped at 4096 chars) for the wire
 */
export function emitLogRecord(level, scope, msg, attrs) {
    if (typeof msg !== 'string') msg = String(msg ?? '');
    /** @type {LogRecord} */
    const record = { ts: Date.now(), level, scope: scope ?? null, msg, attrs: attrs ?? null, page: PAGE_ID };
    if (msg.length > MSG_MAX) {
        record.msg = msg.slice(0, MSG_MAX);
        record.trunc = true;
    }

    // Storm brake (see the constants above): pass the first few of each error/warn
    // signature, drop the rest, heartbeat the count.
    if (BRAKE_LEVELS.has(level)) {
        const sig = `${level}\n${record.scope ?? ''}\n${record.msg}`;
        if (!_brakeCounts.has(sig) && _brakeCounts.size >= BRAKE_SIG_MAX) _brakeCounts.clear();
        const seen = (_brakeCounts.get(sig) ?? 0) + 1;
        _brakeCounts.set(sig, seen);
        if (seen > BRAKE_PASS) {
            _brakeSuppressed++;
            if (_brakeSuppressed >= BRAKE_HEARTBEAT) {
                const n = _brakeSuppressed;
                _brakeSuppressed = 0;
                emitLogRecord('warn', 'log-brake',
                    `suppressed ${n} repeated error/warn records (latest: ${record.msg.slice(0, 160)})`, null);
            }
            return;
        }
    }

    ring.push(record);
    if (ring.length > RING_MAX) ring.shift();
    _pushed++;

    // bridge.send no-ops until bridge.connected, so boot-time records would otherwise
    // never reach the relay. Opportunistic flush: send any unsent backlog still in the
    // ring (oldest first) — the slice includes the record just pushed.
    if (_bridge && _bridge.connected) {
        const backlog = Math.min(_pushed - _sent, ring.length);
        for (let i = ring.length - backlog; i < ring.length; i++) {
            try { _bridge.send(wireForm(ring[i])); } catch { /* bridge hiccup — drop silently */ }
        }
        _sent = _pushed;
    }
}

/**
 * @param {import('./WebSocketBridge.js').default} bridge - the relay bridge;
 *   `send(raw)` self-guards on connection state, `connected` gates forwarding.
 * @param {Object} [options]
 * @param {boolean} [options.captureWindowErrors=true] - also capture
 *   window.onerror and unhandledrejection as error-level records.
 * @returns {boolean} true if it installed the forwarder, false if it was already
 *   installed (and this call did nothing).
 */
export function installConsoleForwarder(bridge, options = {}) {
    if (_installed) return false;
    if (!bridge || typeof bridge.send !== 'function') return false;
    _installed = true;
    _bridge = bridge;

    const { captureWindowErrors = true } = options;

    // Serialize console args to a single string. Error instances need special
    // handling — their enumerable own-props are empty, so JSON.stringify(err)
    // === "{}" and the record would lose the actual failure.
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

    // Logger output arrives here structured (scope = fullName, attrs = context); the
    // console patch below skips Logger-originated calls so each line lands once.
    // Logger level names are uppercase (TRACE..ERROR, plus METRIC which Logger routes
    // to console.log — it maps to 'log' to stay inside the wire's level vocabulary).
    setLogRecordSink((record) => {
        const level = record.level === 'METRIC' ? 'log' : String(record.level).toLowerCase();
        const attrs = record.context && Object.keys(record.context).length > 0 ? record.context : null;
        emitLogRecord(level, record.name ?? null, record.message, attrs);
    });

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            if (isLoggerEmitting()) return; // structured via the Logger sink
            emitLogRecord(level, null, serialize(args), null);
        };
    }

    if (captureWindowErrors && typeof window !== 'undefined') {
        window.addEventListener('error', (e) => {
            emitLogRecord('error', null, `[uncaught] ${e.error?.stack || e.message || String(e)}`, null);
        });
        window.addEventListener('unhandledrejection', (e) => {
            const r = e.reason;
            emitLogRecord('error', null, `[unhandled-rejection] ${r?.stack || r?.message || String(r)}`, null);
        });
    }

    return true;
}
