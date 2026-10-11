/** @import { AppContext } from './CommandProvider.jsx' */
/** @import CameraDock from '@glyph3d/core/services/interaction/CameraDock.js' */
/** @import Carrel from '@glyph3d/core/services/interaction/Carrel.js' */

/**
 * Holding — who carries a window, and the one place that changes it.
 *
 * Two holder kinds, two concepts, never merged:
 *   RESIDENCE — a carrel: where a window lives by choice. Durable fact `view.carrel`.
 *   VEHICLE   — the camera dock: how a window rides with you. Durable fact `view.docked`.
 * A window has at most one of each. Docking a seated window BORROWS it — pick it up from
 * its desk to review — and undocking puts it back in its seat: the dock captures the seat
 * as the ride's home, and the carrel keeps the entry hands-off until it returns.
 *
 * Each holder owns its internal state (CameraDock: tiles, pane tree, bar layout; Carrel:
 * seats, arrangement). Each SIDE here is the one writer of its fact and drives its live
 * holder; the Holding methods are the handoffs that touch both (seat a docked window,
 * unseat a borrowed one, lift a window out of everything). Membership is durable: only an
 * explicit verb (or the window itself closing) ends it.
 *
 * Addresses: a holder keys a window by its REGISTRY id — an agent book is
 * `agent:book:<lane>`, a delta book `delta:book:<set>`. `resolve` accepts the friendlier
 * forms verbs see (a lane id, the `agent:<id>` label, `delta:<id>`, a surface index) and
 * hands back the canonical id; the model and the holders only ever see that.
 */

/** Holdable kinds (registry role || type): whole windows and whole books. A book's pages
 *  (`card`, `delta-page`), the library's per-relayout `volume` covers, and carrels
 *  themselves (places, not cargo) are refused. */
const HOLDABLE = new Set(['grid', 'terminal', 'frame', 'agent', 'delta', 'search']);

/** What to say when an address names something that can't be held. */
const REFUSAL = {
    card: 'is a page of a book — hold the book instead',
    'delta-page': 'is a page of a delta book — hold the book instead',
    volume: 'is a library volume (rebuilt with the tree) — hold its files instead',
    carrel: 'is a carrel — a place things are held at, not cargo',
};

/** The live projection of `view.docked` — the camera dock. */
class DockSide {
    /** @param {AppContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        /** The window restore wants re-raised into the view-frame once it's a live tile. */
        this.pendingFrame = null;
    }

    /** @returns {CameraDock|null} */
    get live() { return this.ctx.cameraDock || null; }

    has(id) { return !!this.live?.has?.(id); }

    homeOf(id) { return this.live?.homeOf?.(id) ?? null; }

    _fact(id, patch) {
        this.ctx.workspace?.setSurfaceView?.(id, this.ctx.registry?.get?.(id)?.type, patch);
    }

    _clear(id) {
        const pinned = this.ctx.workspace?.getSurface?.(id)?.view?.pinAutoDocked;
        this._fact(id, pinned ? { docked: false, pinAutoDocked: false } : { docked: false });
    }

    /**
     * Dock a window (a seated one is borrowed, not unseated). Order: the hint, else the
     * next bar slot from the model.
     * @param {{id:string, grid:Object}} r
     */
    lock(r, { order } = {}) {
        const dock = this.live;
        if (!dock || dock.has(r.id)) return false;
        const o = Number.isFinite(order) ? order : (this.ctx.workspace?.nextDockOrder?.() ?? 0);
        this._fact(r.id, { docked: true, dockOrder: o });
        return dock.lock(r.id, r.grid, { order: o });
    }

    /** Release a tile to its home (a borrowed window's seat), or re-aimed via opts. */
    release(id, opts = {}) {
        if (!this.has(id)) return false;
        this._clear(id);
        return this.live.release(id, opts);
    }

    /** End the ride without moving the window; returns the ride's home record. */
    handOff(id) {
        if (!this.has(id)) return null;
        this._clear(id);
        return this.live.handOff(id);
    }

    rehome(id, home) { return !!this.live?.rehome?.(id, home); }

    releaseAll() {
        for (const s of this.ctx.workspace?.listDocked?.() || []) this._clear(s.id);
        this.live?.releaseAll?.();
    }

    /**
     * Converge the live dock to the model: lock each docked window that's live but not yet a
     * tile, re-apply its zoom, re-raise the pending frame occupant. ADDITIVE — verbs release
     * live and the removal cascade dismisses the gone, so this never fights them. A window
     * whose residence is still waiting to seat it (`awaitingSeat`) is skipped: it seats
     * first, so the ride captures the seat as its home (the sweep re-runs this after).
     * @param {(id:string) => boolean} awaitingSeat
     */
    reconcile(awaitingSeat) {
        const dock = this.live;
        const ws = this.ctx.workspace;
        if (!dock || !ws?.listDocked) return;
        for (const s of ws.listDocked()) {
            if (dock.has(s.id) || awaitingSeat(s.id)) continue;
            const grid = this.ctx.registry?.get?.(s.id)?.grid;
            if (!grid) continue;                            // not live yet — caught on a later pass
            const v = s.view || {};
            try {
                dock.lock(s.id, grid, { order: v.dockOrder });
                if (v.zoom && v.zoom !== 1) { grid.setZoom?.(v.zoom); dock.reflowTile?.(s.id); }
                if (this.pendingFrame === s.id && dock.focusedPane !== s.id) {
                    dock.spotlight(s.id);
                    this.pendingFrame = null;
                }
            } catch (e) {
                console.warn(`[holding] dock reconcile failed for '${s.id}' — skipping:`, e?.message || e);
            }
        }
    }
}

/** The live projection of `view.carrel` — the desks. */
class CarrelSide {
    /** @param {AppContext} ctx */
    constructor(ctx) { this.ctx = ctx; }

    /** @returns {Map<string, Carrel>|null} */
    get desks() { return this.ctx.carrels instanceof Map ? this.ctx.carrels : null; }

    /** The desk a window resides at (seated or borrowed), or null. */
    ownerOf(id) {
        for (const desk of this.desks?.values?.() || []) if (desk.has(id)) return desk;
        return null;
    }

    homeOf(id) { return this.ownerOf(id)?.homeOf(id) ?? null; }

    _fact(id, value) {
        this.ctx.workspace?.setSurfaceView?.(id, this.ctx.registry?.get?.(id)?.type, { carrel: value });
    }

    /** @param {{id:string, grid:Object}} r @param {Carrel} desk */
    seat(r, desk, { order, immediate, home } = {}) {
        if (!desk.lock(r.id, r.grid, { order, immediate, ...(home ? { home } : {}) })) return false;
        this._fact(r.id, { name: desk.carrelName, order: desk.entries.get(r.id).order });
        return true;
    }

    /** Send a member home (or re-aimed via opts); returns the desk it left. */
    release(id, opts = {}) {
        const desk = this.ownerOf(id);
        if (!desk) return null;
        this._fact(id, null);
        desk.release(id, opts);
        return desk;
    }

    /** Leave the desk without moving the window; returns its home record. */
    handOff(id) {
        const desk = this.ownerOf(id);
        if (!desk) return null;
        this._fact(id, null);
        return desk.handOff(id);
    }

    /** Clear every member's fact — the desk is folding (it sends them home itself). */
    forget(desk) {
        for (const m of desk.list()) this._fact(m.id, null);
    }

    /** A claim waiting on its desk: the desk stands, the window isn't seated yet. */
    awaitingSeat(id) {
        const claim = this.ctx.workspace?.getSurface?.(id)?.view?.carrel;
        const desk = claim ? this.desks?.get(claim.name) : null;
        return !!desk && !desk._dissolving && !desk.has(id);
    }
}

export default class Holding {
    /** @param {AppContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.dock = new DockSide(ctx);
        this.carrels = new CarrelSide(ctx);
    }

    // ── addresses ─────────────────────────────────────────────────────────────

    /** The holdable kind of a registry entry, or null. */
    holdableKind(entry) {
        const k = entry ? (entry.role || entry.type) : null;
        return HOLDABLE.has(k) ? k : null;
    }

    /**
     * The ONE address resolver for anything a holder takes. Exact registry id first; then a
     * surface index; then the book owners' own resolvers (lane id / `agent:<id>` label →
     * the lane's registry id; `delta:<id>` / set id → the set's) — lookups, never slicing.
     * @param {string} arg
     * @returns {{id:string, grid:Object, kind:string}|{error:string}}
     */
    resolve(arg) {
        const key = String(arg ?? '').trim();
        if (!key) return { error: 'no window named' };
        const reg = this.ctx.registry;
        let entry = reg?.get?.(key) || null;
        if (!entry && /^\d+$/.test(key)) {
            const grid = (this.ctx.getSurfaces?.() || [])[Number(key)];
            const id = grid ? reg?.getIdByGrid?.(grid) : null;
            entry = id ? reg.get(id) : null;
        }
        if (!entry) {
            const lane = this.ctx.agentBooks?.resolveLane?.(key)?.[1];
            if (lane) entry = reg?.get?.(lane.groupId) || null;
        }
        if (!entry) {
            const set = this.ctx.deltaBooks?.resolveSet?.(key)?.[1];
            if (set) entry = reg?.get?.(set.groupId) || null;
        }
        if (!entry) return { error: `nothing named "${key}" (registry id, surface index, or book id)` };
        const kind = this.holdableKind(entry);
        if (!kind) {
            const what = entry.role || entry.type;
            return { error: `'${entry.id}' ${REFUSAL[what] ?? `is a ${what}, not a holdable window`}` };
        }
        return { id: entry.id, grid: entry.grid, kind };
    }

    // ── lookups ───────────────────────────────────────────────────────────────

    isDocked(id) { return this.dock.has(id); }

    /** The desk a window resides at, or null. */
    residenceOf(id) { return this.carrels.ownerOf(id); }

    /** Whatever physically carries the window now: the dock while it rides, else its desk. */
    holderOf(id) { return this.dock.has(id) ? this.dock.live : this.carrels.ownerOf(id); }

    /** The window's true home record — the residence chain, never a ride's seat. */
    homeOf(id) { return this.carrels.homeOf(id) ?? this.dock.homeOf(id); }

    // ── handoffs ──────────────────────────────────────────────────────────────

    /**
     * Seat a window at a desk. Seating where it already resides puts a borrowed window back
     * ('returned'); from another desk or the dock it hands over with its home record.
     * @param {{id:string, grid:Object}} r
     * @param {Carrel} desk
     * @returns {'seated'|'returned'|'already'|null}
     */
    seat(r, desk, { order, immediate } = {}) {
        const owner = this.carrels.ownerOf(r.id);
        if (owner === desk) {
            if (!this.dock.has(r.id)) return 'already';
            this.dock.release(r.id);
            return 'returned';
        }
        let home = owner ? this.carrels.handOff(r.id) : null;    // the desk it leaves knows its world home
        if (this.dock.has(r.id)) {
            const rideHome = this.dock.handOff(r.id);             // a borrowed ride's home is the old seat
            home ??= rideHome;
        }
        return this.carrels.seat(r, desk, { order, immediate, home }) ? 'seated' : null;
    }

    /**
     * Unseat a window. A borrowed one stays docked, its ride now ending at the desk's own home.
     * @returns {Carrel|null} the desk it left
     */
    unseat(id, opts = {}) {
        const owner = this.carrels.ownerOf(id);
        if (!owner) return null;
        if (this.dock.has(id)) this.dock.rehome(id, this.carrels.handOff(id));
        else this.carrels.release(id, opts);
        return owner;
    }

    /**
     * Lift a window out of every holder — dropped at a pose (`opts.to`) or where it hangs
     * (`opts.inPlace`, a drag picking it up).
     * @returns {'dock'|'carrel'|'dock+carrel'|null} what held it
     */
    lift(id, opts = {}) {
        const docked = this.dock.has(id);
        const owner = this.carrels.ownerOf(id);
        if (owner) this.unseat(id, docked ? {} : opts);
        if (docked) this.dock.release(id, opts);
        return docked ? (owner ? 'dock+carrel' : 'dock') : owner ? 'carrel' : null;
    }

    /**
     * A desk is folding: its members go home with it, so a borrowed member's ride must now
     * end at the desk's home (its seat is about to vanish). The caller dissolves the desk.
     * @param {Carrel} desk
     */
    fold(desk) {
        for (const m of desk.list()) {
            if (this.dock.has(m.id)) this.dock.rehome(m.id, desk.homeOf(m.id));
        }
        this.carrels.forget(desk);
    }

    // ── projection ────────────────────────────────────────────────────────────

    /**
     * Converge the live holders to the model: residence first (each claimed, live window
     * seats at its standing desk — immediately, load-is-not-replay), then the dock, so a
     * window both seated and docked rides FROM its seat. Idempotent.
     */
    reconcile() {
        const ws = this.ctx.workspace;
        const desks = this.carrels.desks;
        for (const s of (desks && ws?.listCarreled?.()) || []) {
            const desk = desks.get(s.view.carrel.name);
            if (!desk || desk._dissolving || desk.has(s.id)) continue;
            const entry = this.ctx.registry?.get?.(s.id);
            if (!this.holdableKind(entry)) continue;              // not live yet — a later change re-offers
            const r = { id: entry.id, grid: entry.grid };
            const order = s.view.carrel.order;
            // Docked before its desk could seat it (it went live mid-restore): end the ride,
            // seat it, and dock it again — now borrowed, so undocking returns it to the seat.
            const dockOrder = this.dock.has(s.id) ? ws.getSurface(s.id)?.view?.dockOrder : null;
            const home = dockOrder != null ? this.dock.handOff(s.id) : this.carrels.handOff(s.id);
            if (this.carrels.seat(r, desk, { order, immediate: true, home })) {
                (this.ctx._agentShelfSeen ??= new Set()).add(s.id);   // the default shelf never re-offers
                if (dockOrder != null) this.dock.lock(r, { order: dockOrder });
            }
        }
        this.dock.reconcile((id) => this.carrels.awaitingSeat(id));
    }
}
