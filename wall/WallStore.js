/**
 * WallStore — the wall's durable per-browser state: where each terminal sits and the names the
 * person gave them, both keyed by terminal id, in localStorage. Storage can be unavailable
 * (private windows, blocked site data); then nothing persists and the wall still works.
 */

const POSITIONS_KEY = 'glyph3d.wall.positions';
const NAMES_KEY = 'glyph3d.wall.names';

function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch { return {}; }
}
function write(key, map) {
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* storage blocked: it just won't persist */ }
}

export default class WallStore {
    constructor() {
        this._positions = read(POSITIONS_KEY);
        this._names = read(NAMES_KEY);
    }

    /** @param {string} id @returns {{x:number, y:number}|null} */
    position(id) { return this._positions[id] ?? null; }

    /** @param {string} id @param {{x:number, y:number}} p */
    setPosition(id, p) {
        this._positions[id] = { x: p.x, y: p.y };
        write(POSITIONS_KEY, this._positions);
    }

    /** @param {string} id @returns {string|null} the name the person gave it, if any */
    name(id) { return this._names[id] || null; }

    /** @param {string} id @param {string} name - empty clears it */
    setName(id, name) {
        const n = (name || '').trim();
        if (n) this._names[id] = n; else delete this._names[id];
        write(NAMES_KEY, this._names);
    }
}
