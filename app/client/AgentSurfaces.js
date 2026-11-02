/** @import { AppContext } from './CommandProvider.jsx' */

import { buildCarrel } from '../commands/handlers/carrelCommands.js';

/**
 * AgentSurfaces — the surfaces an AGENT made: its terminals and desktops, kept at its own desk.
 *
 * A surface an identified caller creates (`glyph3d-cli --as <name>` — the per-call `ctx.caller`:
 * terminal.spawn, terminal.create, desktop.start) is OWNED by that agent: `claim` writes the
 * durable fact `view.owner` on the surface (the workspace model, saved with the session), stamps
 * the live registry entry (SceneRegistry.setMeta), attaches the agent to its desk as a participant and
 * attributes the seat to it (the entry's `meta.agent` — `meta.owner` is a terminal's controlling
 * adapter, a different fact). An anonymous caller's surfaces aren't claimed — they behave as they
 * always did.
 *
 * WHERE IT LIVES: its owner's plane desk, `gomux/<owner>` — the gomuxai hub's team desk for that
 * agent (GomuxHub's ownsDesk counts owned surfaces, read from the model, so a reload rebuilds the
 * desk before the surfaces re-adopt), or, for a caller the hub doesn't know, a plane desk of that
 * name set down on its own. `converge` seats every live owned surface that nothing holds and that
 * has no residence of its own; once seated, its residence (Holding's `view.carrel`) is what brings
 * it back to that desk after a reload (Holding.reconcile). Moved elsewhere by the person, it stays
 * where they put it.
 *
 * Its owner ending stops nothing: the surface is MARKED (`ownerEnded`, on the fact and the entry's meta)
 * and stays until the person closes it.
 */

/** The desk an agent's surfaces sit at. @param {string} owner */
export const ownerDesk = (owner) => `gomux/${owner}`;

/** The one AgentSurfaces of an app context (made on first use). @param {AppContext} ctx */
export function agentSurfacesOf(ctx) {
    return (ctx.agentSurfaces ??= new AgentSurfaces(ctx));
}

export default class AgentSurfaces {
    /** @param {AppContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this._converging = false;
        // A surface (re-)registering — a terminal's adapter connecting, a desktop's grid landing — may
        // be one to seat.
        this._onRegistry = () => this.converge();
        ctx.registry?.addChangeListener?.(this._onRegistry);
    }

    /** The owner a surface's fact names, or null. @param {string} id */
    ownerOf(id) {
        return this.ctx.workspace?.getSurface?.(id)?.view?.owner ?? null;
    }

    /**
     * Claim a surface for its creator. No owner (an anonymous caller): nothing — null.
     * @param {string|null|undefined} owner the caller's name @param {string} id registry id
     * @param {string} kind 'terminal' | 'frame'
     * @returns {{owner:string, id:string, desk:string|null}|null}
     */
    claim(owner, id, kind) {
        if (!owner || !id) return null;
        this.ctx.workspace?.setSurfaceView?.(id, kind, { owner, ownerEnded: false });
        this.ctx.registry?.setMeta?.(id, { agent: owner, ownerEnded: false });
        console.info(`[surfaces] ${owner} owns '${id}' (${kind})`);
        this.converge();
        return { owner, id, desk: this.ctx.holding?.holderOf?.(id)?.carrelName ?? null };
    }

    /** Whether an agent owns any surface (live or waiting to re-adopt). @param {string} owner */
    ownsAny(owner) {
        for (const s of this.ctx.workspace?.listSurfaces?.() || []) if (s.view?.owner === owner) return true;
        return false;
    }

    /**
     * An agent's surfaces: `{id, kind, live, desk, ownerEnded}` each (desk: what holds it now).
     * @param {string} owner
     */
    list(owner) {
        const out = [];
        for (const s of this.ctx.workspace?.listSurfaces?.() || []) {
            if (s.view?.owner !== owner) continue;
            out.push({
                id: s.id, kind: s.kind, live: !!this.ctx.registry?.get?.(s.id),
                desk: this.ctx.holding?.holderOf?.(s.id)?.carrelName ?? null,
                residence: s.view?.carrel?.name ?? null, ownerEnded: !!s.view?.ownerEnded,
            });
        }
        return out;
    }

    /** Every owner with surfaces. @returns {string[]} */
    owners() {
        const set = new Set();
        for (const s of this.ctx.workspace?.listSurfaces?.() || []) if (s.view?.owner) set.add(s.view.owner);
        return [...set];
    }

    /**
     * Mark each owner's surfaces by whether it still runs (the hub's tree): an ended owner's
     * surfaces carry `ownerEnded` — nothing is stopped. @param {(owner:string) => boolean|null} runs
     *        true / false, or null for an owner the caller can't say about (left as it is)
     */
    noteRuns(runs) {
        for (const s of this.ctx.workspace?.listSurfaces?.() || []) {
            const owner = s.view?.owner;
            if (!owner) continue;
            const r = runs(owner);
            if (r == null) continue;
            const ended = !r;
            if (!!s.view.ownerEnded === ended) continue;
            this.ctx.workspace.setSurfaceView(s.id, s.kind, { ownerEnded: ended });
            this.ctx.registry?.setMeta?.(s.id, { ownerEnded: ended });
            console.info(`[surfaces] '${s.id}': its owner ${owner} ${ended ? 'ended — kept, marked' : 'runs again'}`);
        }
    }

    /**
     * Seat every live owned surface that nothing holds and that has no residence of its own at its
     * owner's desk — the hub's team desk (the hub builds it: it counts owned surfaces), else a plane
     * desk of that name set down on its own. Idempotent.
     */
    converge() {
        if (this._converging) return;
        const holding = this.ctx.holding, reg = this.ctx.registry;
        if (!holding || !reg || !(this.ctx.carrels instanceof Map)) return;
        this._converging = true;
        try {
            for (const s of this.ctx.workspace?.listSurfaces?.() || []) {
                const owner = s.view?.owner;
                if (!owner || s.view?.carrel) continue;            // unowned, or it has a residence (Holding brings it there)
                const entry = reg.get(s.id);
                if (!entry || holding.holderOf(s.id)) continue;     // not live yet, or held (docked, seated)
                if (entry.meta?.agent !== owner) reg.setMeta?.(s.id, { agent: owner, ownerEnded: !!s.view.ownerEnded });
                const desk = this._deskFor(owner);
                if (!desk) continue;
                if (holding.seat({ id: entry.id, grid: entry.grid }, desk) === 'seated') {
                    const ps = this.ctx.participants;
                    if (ps) { ps.attach(owner, desk.carrelName); ps.noteSeated(owner, desk.carrelName, entry.id); }
                    console.info(`[surfaces] '${entry.id}' seated at its owner's desk '${desk.carrelName}'`);
                }
            }
        } finally { this._converging = false; }
    }

    /** The owner's desk: standing, built by the hub for a hub agent, else set down here. @private */
    _deskFor(owner) {
        const name = ownerDesk(owner);
        const have = this.ctx.carrels.get(name);
        if (have && !have._dissolving) return have;
        const hub = this.ctx.gomuxHub;
        if (hub?.nodes?.has?.(owner)) {
            hub.relayout?.();   // its ownsDesk now counts these surfaces: the team desk stands
            const built = this.ctx.carrels.get(name);
            if (built && !built._dissolving) return built;
            return null;        // the hub seats the agent's book first; the next registry change seats these
        }
        return buildCarrel(this.ctx, name, { managed: true, form: { mode: 'plane' } });
    }

    dispose() {
        this.ctx.registry?.removeChangeListener?.(this._onRegistry);
    }
}
