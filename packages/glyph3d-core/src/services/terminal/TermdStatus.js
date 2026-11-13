/**
 * TermdStatus — a display's copy of its terminal daemon's state (docs/termd/DESIGN.md, "Status: in
 * the app"). The relay follows termd's status document on one connection and pushes each one to the
 * display as a `termd/status` notification, with its own view of the socket; this model keeps the
 * last one and answers from it. The display never asks termd anything per terminal.
 *
 *   state      the relay's view: 'ok' (a brain answers), 'absent' (no daemon: an empty namespace
 *              that left), 'restarting' (a holder, no brain yet), 'unreachable' (the same, past the
 *              relay's grace), 'failed' (the brain keeps crashing; the shells are alive, frozen),
 *              'lost' (the holder died with terminals in it), or 'unknown' (no word from the relay)
 *   doc        termd's own document (PROTOCOL.md "status_follow"), or null — kept through a restart
 *              (its terminals are still there), dropped when the namespace is gone
 *   lost       { ns, at } once 'lost' was seen, until dismissed (dismissLost) — a new namespace
 *              answering doesn't clear it: the shells that were lost stay lost
 *
 * Fed by attach(bridge) (the pushes, plus one request per registration so a reload renders at once);
 * listeners hear every change (onChange). Framework-free: any app renders it.
 */

/** @typedef {'ok'|'absent'|'restarting'|'unreachable'|'failed'|'lost'|'unknown'} TermdState */

/**
 * The relay's half of a notification.
 * `lacks`: the input ops (`key`, `paste`) the brain answering now doesn't offer (one from an
 * earlier build): the display's typing can't reach it until `g3d upgrade`.
 * @typedef {{ state: TermdState, since: number, ns: string, bundled: string, lacks?: string[] }} TermdRelayView
 */

export default class TermdStatus {
    constructor() {
        /** @type {TermdRelayView|null} */
        this.relay = null;
        /** termd's status document (PROTOCOL.md), or null. @type {any} */
        this.doc = null;
        /** @type {{ ns: string, at: number }|null} */
        this.lost = null;
        /** @type {Map<string, any>} */
        this._byId = new Map();
        /** @type {Set<() => void>} */
        this._listeners = new Set();
    }

    /** @returns {TermdState} */
    get state() { return this.relay?.state ?? 'unknown'; }

    /** The document's terminals (none without a document). @returns {any[]} */
    get terminals() { return this.doc?.terminals ?? []; }

    /** One terminal's row in the document, by id. @param {string} id */
    terminal(id) { return this._byId.get(id) ?? null; }

    /**
     * When the relay ships a different termd than the one running, the version it ships (the
     * operator runs `g3d upgrade`; nothing upgrades a daemon by itself). Null when they agree.
     * @returns {string|null}
     */
    get upgradeAvailable() {
        const ship = this.relay?.bundled, run = this.doc?.daemon?.version;
        return ship && run && ship !== run ? ship : null;
    }

    /**
     * The input ops the running brain lacks (`key`, `paste`): typing and pasting from this display
     * are dropped until the operator runs `g3d upgrade`. Empty when it has them.
     * @returns {string[]}
     */
    get lacks() {
        return this.state === 'ok' ? (this.relay?.lacks ?? []) : [];
    }

    /**
     * Follow a relay link: every `termd/status` push, and a request each time it registers as the
     * display (the relay answers with the same notification). Returns the detach.
     * @param {import('../orchestration/WebSocketBridge.js').default} bridge
     * @returns {() => void}
     */
    attach(bridge) {
        const off = bridge.onRpcNotification((method, params) => {
            if (method === 'termd/status') this.update(params);
        });
        return off;
    }

    /**
     * Ask the relay for its last notification (it pushes one on registration too).
     * @param {import('../orchestration/WebSocketBridge.js').default} bridge
     */
    async request(bridge) {
        try {
            const r = await bridge.rpcRequest('termd/status', {}, 5000);
            if (r) this.update(r);
        } catch (e) {
            console.warn(`[termd-status] the relay didn't answer termd/status: ${e?.message ?? e}`);
        }
    }

    /** @param {{ relay: TermdRelayView, status: any }} params */
    update(params) {
        if (!params?.relay) { console.warn('[termd-status] a termd/status notification with no relay view:', params); return; }
        this.relay = params.relay;
        this.doc = params.status ?? null;
        this._byId = new Map(this.terminals.map((t) => [t.id, t]));
        if (this.relay.state === 'lost' && !this.lost) this.lost = { ns: this.relay.ns, at: this.relay.since };
        this._emit();
    }

    /** No word from the relay (its link dropped): unknown, not empty. The lost latch stays. */
    clear() {
        if (!this.relay && !this.doc) return;
        this.relay = null;
        this.doc = null;
        this._byId = new Map();
        this._emit();
    }

    /** The person dismissed the lost notice, or started a terminal (a fresh termd). */
    dismissLost() {
        if (!this.lost) return false;
        this.lost = null;
        this._emit();
        return true;
    }

    /** @param {() => void} fn @returns {() => void} unsubscribe */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    _emit() {
        for (const fn of this._listeners) {
            try { fn(); } catch (e) { console.error('[termd-status] listener threw:', e); }
        }
    }
}
