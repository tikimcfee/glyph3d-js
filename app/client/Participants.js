/**
 * Participants — who is AT a carrel besides the person: presence, not control.
 *
 * An identified caller (`glyph3d-cli --as <name>`, the per-call `ctx.caller`) attaches to a desk
 * with `carrel.attach <carrel>`; it is then listed there (`carrel.who`, the Carrels panel) in its
 * own hue — the hue its points draw in (Deixis.callerHue) — and attributed: what it seats there
 * and where it points carry its name. Attaching grants nothing the bus didn't already allow; it
 * says who is in the room. Attention stays the person's (attention.* refuses identified callers).
 *
 * Ephemeral by design: nothing here is saved. A participant leaves by `carrel.detach`, when its
 * desk dissolves (`prune`), or when gomuxai reports its agent ended (`dropEnded`, from every hub
 * tree push).
 */

import { callerHue } from './Deixis.js';

/** @typedef {{name: string, carrel: string, since: number, hue: {r:number,g:number,b:number}, seated: string[]}} Participant */

export default class Participants {
    /** @param {Object} ctx AppContext (reads `carrels`, `agentBooks` for the hue) */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Map<string, Map<string, Participant>>} carrel name → participant name → record */
        this._at = new Map();
        /** @type {Set<() => void>} */
        this._listeners = new Set();
    }

    /**
     * Attach `name` to `carrel`. @param {string} name @param {string} carrel
     * @returns {{ok: true, participant: Participant, already: boolean}|{ok: false, error: string}}
     */
    attach(name, carrel) {
        if (!name) return { ok: false, error: 'an anonymous caller cannot attach — identify with glyph3d-cli --as <name> (AGENT_NAME)' };
        if (!(this.ctx.carrels instanceof Map) || !this.ctx.carrels.has(carrel)) return { ok: false, error: `no carrel '${carrel}'` };
        let at = this._at.get(carrel);
        if (!at) { at = new Map(); this._at.set(carrel, at); }
        const had = at.get(name);
        if (had) return { ok: true, participant: had, already: true };
        const p = { name, carrel, since: Date.now(), hue: callerHue(this.ctx, name), seated: [] };
        at.set(name, p);
        console.info(`[participants] ${name} attached to '${carrel}'`);
        this._changed();
        return { ok: true, participant: p, already: false };
    }

    /**
     * Detach `name` from one carrel, or from every carrel when `carrel` is null.
     * @param {string} name @param {string|null} carrel @returns {string[]} the carrels it left
     */
    detach(name, carrel = null) {
        const left = [];
        for (const [c, at] of this._at) {
            if (carrel != null && c !== carrel) continue;
            if (at.delete(name)) left.push(c);
            if (!at.size) this._at.delete(c);
        }
        if (left.length) { console.info(`[participants] ${name} left ${left.map((c) => `'${c}'`).join(', ')}`); this._changed(); }
        return left;
    }

    /**
     * Attribute a seat: `name` seated `id` at `carrel` (a participant there; else nothing to record).
     * @param {string|null} name @param {string} carrel @param {string} id @returns {boolean} recorded
     */
    noteSeated(name, carrel, id) {
        const p = name ? this._at.get(carrel)?.get(name) : null;
        if (!p) return false;
        if (!p.seated.includes(id)) p.seated.push(id);
        console.info(`[participants] ${name} seated '${id}' at '${carrel}'`);
        this._changed();
        return true;
    }

    /** Who is at `carrel` (oldest first), or every participant when null. @returns {Participant[]} */
    who(carrel = null) {
        const all = carrel != null ? [...(this._at.get(carrel)?.values() ?? [])] : [...this._at.values()].flatMap((m) => [...m.values()]);
        return all.sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
    }

    /** The carrels `name` is attached to. @param {string} name @returns {string[]} */
    carrelsOf(name) {
        return [...this._at].filter(([, at]) => at.has(name)).map(([c]) => c);
    }

    /** Whether `name` is at `carrel`. */
    isAt(name, carrel) { return !!this._at.get(carrel)?.has(name); }

    /**
     * gomuxai's tree: every agent it reports ENDED leaves every desk. An attached name gomuxai
     * doesn't know (a caller outside its tree) stays until it detaches.
     * @param {Array<{name: string}>} agents @param {(a: {name: string}) => boolean} runs
     */
    dropEnded(agents, runs) {
        for (const a of agents || []) if (a?.name && !runs(a) && this.carrelsOf(a.name).length) this.detach(a.name);
    }

    /** Desks that no longer stand take their participants with them. */
    prune() {
        const map = this.ctx.carrels instanceof Map ? this.ctx.carrels : new Map();
        let n = 0;
        for (const c of [...this._at.keys()]) {
            const desk = map.get(c);
            if (desk && !desk._dissolving) continue;
            n += this._at.get(c).size;
            this._at.delete(c);
        }
        if (n) this._changed();
    }

    /** Listen for any change (attach / detach / drop). @param {() => void} fn @returns {() => void} */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    /** @private */
    _changed() { for (const fn of this._listeners) { try { fn(); } catch (e) { console.error('[participants] listener threw', e); } } }
}
