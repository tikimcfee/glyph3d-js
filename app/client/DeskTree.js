/** @import { AppContext } from './CommandProvider.jsx' */
/** @import Carrel from '@glyph3d/core/services/interaction/Carrel.js' */

import FieldLabel from '@glyph3d/core/collections/FieldLabel.js';
import { buildCarrel } from '../commands/handlers/carrelCommands.js';
import { getSetting } from './settings.js';

/**
 * DeskTree — a tree of agents as books at desks: the one seating rule the gomuxai hub
 * (GomuxHub: the workgroup's agents at the `gomux` desk) and the agents desk (SessionDesk:
 * local sessions at the `agents` desk) share.
 *
 *   the hub   — one world-managed desk, a sibling of the file tree;
 *   a team    — a node with shown helpers, or one that OWNS a desk (the owner's `ownsDesk`:
 *               a gomuxai agent with a live screen — its book and screen pinned together),
 *               gets its own desk, `<hub>/<id>`, seated where its book would be: its own book
 *               first, then its helpers (books, or their own teams) in the order given.
 *               Nesting is as deep as the tree. A team whose helpers (and screen) have all
 *               gone folds its desk. Team desks are born in the owner's `teamForm` (the hub's:
 *               a plane — Settings ▸ gomuxai `gomux.teamMode`).
 *
 * Every desk the tree builds is `derived` — rebuilt from its owner's data every boot, never
 * saved (each keeps the values set on it by hand: those persist by desk name). A book the
 * tree seated stays the tree's to move when the tree changes; one taken elsewhere (docked,
 * dragged, seated at a desk of your own) is yours, and the tree leaves it alone. That holds
 * across a reload too: a book whose RESIDENCE (Holding's durable `view.carrel` fact) names a
 * desk that isn't a tree's is never seated by the tree — not even while that desk is still
 * standing back up (Holding seats it there when it does) — the rule per-instance knobs follow:
 * what's set on one instance is its own. `carrel.release` clears the residence; the tree then
 * seats the book again (watchCloses hears the release).
 *
 * @typedef {Object} DeskNode
 * @property {string} id        the node's identity (a gomuxai name, a session id)
 * @property {string} [parent]  its parent's id — absent, or not among the nodes: the hub
 * @property {string|null} book the agent-book lane id seated for it (null: no book yet)
 * @property {string} label     the name a team desk's title wears
 */

export default class DeskTree {
    /**
     * @param {AppContext} ctx
     * @param {{hub: string, hubTitle?: string|null, hubForm: () => Object,
     *          teamForm?: () => Object, ownsDesk?: (id: string) => boolean,
     *          gap?: () => number|null}} opts
     *        hubForm: the hub desk's birth form (a cylinder, a wall); teamForm: a team desk's
     *        (default a wall); ownsDesk: a node that gets its own desk without helpers; gap: the
     *        space desks are born spacing their members (world units; null = Settings ▸ Carrel's)
     */
    constructor(ctx, { hub, hubTitle = null, hubForm, teamForm = () => ({ mode: 'grid' }), ownsDesk = () => false, gap = () => null }) {
        this.ctx = ctx;
        this.hub = hub;
        this.hubTitle = hubTitle;
        this._hubForm = hubForm;
        this._teamForm = teamForm;
        this._ownsDesk = ownsDesk;
        this._gap = gap;
        /** Team desks built, by desk name → the desk the team sits at. */
        this._teamParent = new Map();
        /** Lane id → the desk the tree last seated that book at. */
        this.seated = new Map();
    }

    /** A team desk's name. @param {string} id */
    teamDesk(id) { return `${this.hub}/${id}`; }

    /** The desks this tree built (or took over) that stand now. @returns {Carrel[]} */
    desks() {
        return [...(this.ctx.carrels?.values() || [])].filter((d) => d.derived
            && (d.carrelName === this.hub || d.carrelName.startsWith(`${this.hub}/`)));
    }

    /**
     * Seat every book and team at its desk. A node's place is its parent's team desk, or the
     * hub when it has no shown parent; a node with shown helpers is represented by its team
     * desk there, and its book moves inside it. Node order is seat order.
     * @param {DeskNode[]} nodes
     */
    layout(nodes) {
        if (!this.ctx.carrels || !this.ctx.holding) return;
        this._laying = true;
        try { this._layout(nodes); } finally { this._laying = false; }
    }

    /** layout's body (a seat inside it writes the model — watchCloses waits it out). @private */
    _layout(nodes) {
        const ids = new Set(nodes.map((n) => n.id));
        const kids = new Map();
        for (const n of nodes) {
            const p = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : '';
            if (!kids.has(p)) kids.set(p, []);
            kids.get(p).push(n);
        }
        const hasTeam = (id) => (kids.get(id) || []).some((k) => k.book || kids.has(k.id))
            || (!!nodes.find((n) => n.id === id)?.book && this._ownsDesk(id));
        const books = this.ctx.agentBooks?.lanes;
        this._nodes = nodes;
        for (const id of [...this.seated.keys()]) if (!books?.has(id)) this.seated.delete(id);
        const teams = new Set(nodes.filter((n) => hasTeam(n.id)).map((n) => this.teamDesk(n.id)));
        for (const d of this.desks()) if (d.carrelName !== this.hub && !teams.has(d.carrelName)) this._retire(d);
        if (!nodes.some((n) => n.book)) return;   // nothing to seat yet — no empty hub

        const place = (parentDesk, n, order) => {
            if (hasTeam(n.id)) {
                const team = this.desk(this.teamDesk(n.id));
                const helpers = (kids.get(n.id) || []).length;
                this._title(team, helpers ? `${n.label} · ${helpers} helper${helpers === 1 ? '' : 's'}` : n.label);
                this._seatDesk(parentDesk, team, order);
                if (n.book) this._seatBook(team, n.book, 0);
                (kids.get(n.id) || []).forEach((k, i) => place(team, k, i + 1));
            } else if (n.book) {
                this._seatBook(parentDesk, n.book, order);
            }
        };
        const hub = this.desk(this.hub);
        if (this.hubTitle) this._title(hub, this.hubTitle);
        (kids.get('') || []).forEach((n, i) => place(hub, n, i));
    }

    /**
     * A desk by name — built (derived) when absent, BORN in the tree's form: the hub
     * world-managed in its hubForm, a team built loose as a wall and seated into its parent's
     * desk by the layout; every one spaced `gap` apart. A desk that already stands keeps
     * whatever it has — including values set on it by hand — and becomes the tree's (derived:
     * a desk restored from an older save, or set down by the auto-shelf, is this tree's hub).
     * @param {string} name @returns {Carrel}
     */
    desk(name) {
        const map = this.ctx.carrels;
        const have = map?.get(name);
        if (have && !have._dissolving) { have.derived = true; return have; }
        const hub = name === this.hub;
        const g = this._gap();
        const gap = g == null ? NaN : Number(g);
        const boxH = Number(getSetting('carrel.boxH'));
        const form = {
            ...(hub ? this._hubForm() : this._teamForm()),
            ...(Number.isFinite(gap) && gap >= 0 && boxH > 0 ? { gapFrac: gap / boxH } : {}),
        };
        const desk = buildCarrel(this.ctx, name, { managed: hub, nested: !hub, form });
        desk.derived = true;
        return desk;
    }

    /** Set a desk's title text (a FieldLabel in the hubs' chrome tint), built on first need. @private */
    _title(desk, text) {
        const atlas = this.ctx.atlas;
        if (!atlas) return;
        const lh = Number(getSetting('gomux.titleLine')) || 28;
        let t = desk.title;
        if (!t) {
            t = new FieldLabel({ atlas, text, lineHeight: lh, plate: { color: 0x2a3a52, opacity: 0.85 } });
            t.name = `carrel-title:${desk.carrelName}`;
            desk.setTitle(t);
            return;
        }
        if (t.text === text && t.lineHeight === lh) return;
        t.setText(text);
        t.setLineHeight(lh);
        desk.setTitle(t);   // re-place + re-measure the footprint
    }

    /** Whether a desk name is a tree's (this one's hub or team desks, or any derived desk standing). @private */
    _treeDesk(name) {
        return name === this.hub || name.startsWith(`${this.hub}/`) || !!this.ctx.carrels?.get(name)?.derived;
    }

    /** The residence a book claims at a desk that isn't a tree's (Holding's view.carrel), or null. @private */
    _ownResidence(groupId) {
        const claim = this.ctx.workspace?.getSurface?.(groupId)?.view?.carrel;
        return claim?.name && !this._treeDesk(claim.name) ? claim : null;
    }

    /** Seat a book at a desk — unless it isn't the tree's to move any more. @private */
    _seatBook(desk, laneId, order) {
        const lane = this.ctx.agentBooks?.lanes.get(laneId);
        if (!lane) return;
        const holding = this.ctx.holding;
        const holder = holding.holderOf(lane.groupId);
        if (holder === desk) { this.seated.set(laneId, desk.carrelName); return; }
        // The tree's to move while it sits at a tree-built desk (or nowhere yet); docked,
        // dragged, or seated at your own desk, it's yours — and so is one whose residence is
        // your desk while that desk stands back up after a reload.
        if ((holder && !holder.derived) || lane.pinned || this._ownResidence(lane.groupId)) return;
        if (holding.seat({ id: lane.groupId, grid: lane.book }, desk, { order }) === 'seated') this.seated.set(laneId, desk.carrelName);
    }

    /**
     * Fold a team desk the tree no longer has a team for (its helpers' books closed or
     * moved on): out of its parent desk where it stands, then dissolved — the runner sweeps
     * it once its last member has gone home. Its own values stay with its name. @private
     */
    _retire(desk) {
        const parent = this.ctx.carrels.get(this._teamParent.get(desk.carrelName));
        parent?.release(desk.name, { inPlace: true });
        this._teamParent.delete(desk.carrelName);
        this.ctx.holding.fold(desk);
        this.ctx.registry?.unregister?.(`carrel:${desk.carrelName}`);
        desk.dissolve();
    }

    /**
     * Re-seat when a book the tree seated closes (agent.clear, the panel's ✕), or one is handed
     * back to the tree (carrel.release) — the owners' own pushes don't announce either.
     * @param {() => void} relayout @returns {() => void} unsubscribe
     */
    watchCloses(relayout) {
        const offBooks = this.ctx.agentBooks?.onChange?.(() => {
            const lanes = this.ctx.agentBooks?.lanes;
            for (const id of this.seated.keys()) if (!lanes?.has(id)) { relayout(); return; }
        }) ?? (() => {});
        // A book handed back (carrel.release clears its residence): loose, unpinned, claimed by
        // no desk of yours — the tree's to seat again.
        // Checked once the change settles (a release clears the residence before the desk lets go).
        let queued = false;
        const offModel = this.ctx.workspace?.on?.('change:surfaces', () => {
            if (this._laying || queued) return;
            queued = true;
            queueMicrotask(() => {
                queued = false;
                const lanes = this.ctx.agentBooks?.lanes;
                for (const n of this._nodes || []) {
                    const lane = n.book && lanes?.get(n.book);
                    if (lane && !lane.pinned && !this.ctx.holding?.holderOf(lane.groupId) && !this._ownResidence(lane.groupId)) { relayout(); return; }
                }
            });
        }) ?? (() => {});
        return () => { offBooks(); offModel(); };
    }

    /** Seat a team desk inside its parent desk (desks aren't cargo — the tree holds them). @private */
    _seatDesk(parentDesk, team, order) {
        const cur = this._teamParent.get(team.carrelName);
        if (cur === parentDesk.carrelName && parentDesk.has(team.name)) return;
        if (cur) this.ctx.carrels.get(cur)?.release(team.name);
        parentDesk.lock(team.name, team, { order });
        this._teamParent.set(team.carrelName, parentDesk.carrelName);
    }
}
