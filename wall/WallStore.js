/**
 * WallStore — the wall's durable per-browser state: where each terminal sits and the names the
 * person gave them, keyed by terminal id, and how the termd status window stands, in localStorage. Storage can be unavailable (private
 * windows, blocked site data); then nothing persists and the wall still works.
 *
 * Ids are the relay's, and they recycle: another relay (port) mints its own `term-1`, and a relay
 * whose terminals are all gone (a reboot, a stopped termd) mints `term-1` again. So the store is
 * scoped per relay — its keys carry the relay port the page dials — and the wall prunes it against
 * the relay's live terminals on every (re)connect: an entry outlives a detach (a closed grid whose
 * session runs on is re-adopted under the same id) but not its session.
 */

/**
 * The termd status window: open or not, floating or stuck to an edge, and where it floats (null:
 * its default spot, under the topbar at the right).
 * @typedef {{ open: boolean, side: 'left'|'right'|'float', float: { x: number, y: number }|null }} StatusWindowState
 */

/** @type {StatusWindowState} */
const STATUS_WINDOW_DEFAULT = Object.freeze({ open: false, side: 'float', float: null });

/** @param {string} key */
function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch { return {}; }
}
/** @param {string} key @param {Object} map */
function write(key, map) {
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* storage blocked: it just won't persist */ }
}

export default class WallStore {
    /** @param {number} relayPort - the relay this page dials; the store's scope */
    constructor(relayPort) {
        /** The localStorage keys — the e2e reads them. */
        this.keys = {
            positions: `glyph3d.wall.relay-${relayPort}.positions`,
            names: `glyph3d.wall.relay-${relayPort}.names`,
            status: `glyph3d.wall.relay-${relayPort}.status`,
        };
        this._positions = read(this.keys.positions);
        this._names = read(this.keys.names);
        /** @type {StatusWindowState} */
        this._status = { ...STATUS_WINDOW_DEFAULT, ...read(this.keys.status) };
    }

    /** @returns {StatusWindowState} */
    statusWindow() { return this._status; }

    /** @param {Partial<StatusWindowState>} patch */
    setStatusWindow(patch) {
        this._status = { ...this._status, ...patch };
        write(this.keys.status, this._status);
    }

    /** @param {string} id @returns {{x:number, y:number}|null} */
    position(id) { return this._positions[id] ?? null; }

    /** @param {string} id @param {{x:number, y:number}} p */
    setPosition(id, p) {
        this._positions[id] = { x: p.x, y: p.y };
        write(this.keys.positions, this._positions);
    }

    /** Forget a terminal for good — its spot and its name. @param {string} id */
    forget(id) {
        if (id in this._positions) { delete this._positions[id]; write(this.keys.positions, this._positions); }
        if (id in this._names) { delete this._names[id]; write(this.keys.names, this._names); }
    }

    /**
     * Forget every terminal not in `live` — the relay's live sessions (plus any grid on the wall).
     * @param {Set<string>} live @returns {string[]} the ids forgotten
     */
    prune(live) {
        const gone = new Set([...Object.keys(this._positions), ...Object.keys(this._names)].filter((id) => !live.has(id)));
        for (const id of gone) this.forget(id);
        return [...gone];
    }

    /** @param {string} id @returns {string|null} the name the person gave it, if any */
    name(id) { return this._names[id] || null; }

    /** @param {string} id @param {string} name - empty clears it */
    setName(id, name) {
        const n = (name || '').trim();
        if (n) this._names[id] = n; else delete this._names[id];
        write(this.keys.names, this._names);
    }
}
