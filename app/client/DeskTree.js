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
 *   a team    — a node with shown helpers gets its own desk, `<hub>/<id>`, seated where its
 *               book would be: its own book first, then its helpers (books, or their own
 *               teams) in the order given. Nesting is as deep as the tree.
 *
 * Every desk the tree builds is `derived` — rebuilt from its owner's data every boot, never
 * saved (each keeps the values set on it by hand: those persist by desk name). A book the
 * tree seated stays the tree's to move when the tree changes; one taken elsewhere (docked,
 * dragged, seated at a desk of your own) is yours, and the tree leaves it alone.
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
     *          gap?: () => number|null}} opts
     *        hubForm: the hub desk's birth form (a cylinder, a wall); gap: the space desks are
     *        born spacing their members (world units; null = Settings ▸ Carrel's)
     */
    constructor(ctx, { hub, hubTitle = null, hubForm, gap = () => null }) {
        this.ctx = ctx;
        this.hub = hub;
        this.hubTitle = hubTitle;
        this._hubForm = hubForm;
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
        const ids = new Set(nodes.map((n) => n.id));
        const kids = new Map();
        for (const n of nodes) {
            const p = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : '';
            if (!kids.has(p)) kids.set(p, []);
            kids.get(p).push(n);
        }
        const hasTeam = (id) => (kids.get(id) || []).some((k) => k.book || kids.has(k.id));
        if (!nodes.some((n) => n.book)) return;   // nothing to seat yet — no empty hub

        const place = (parentDesk, n, order) => {
            if (hasTeam(n.id)) {
                const team = this.desk(this.teamDesk(n.id));
                const helpers = (kids.get(n.id) || []).length;
                this._title(team, `${n.label} · ${helpers} helper${helpers === 1 ? '' : 's'}`);
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
            ...(hub ? this._hubForm() : { mode: 'grid' }),
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

    /** Seat a book at a desk — unless it isn't the tree's to move any more. @private */
    _seatBook(desk, laneId, order) {
        const lane = this.ctx.agentBooks?.lanes.get(laneId);
        if (!lane) return;
        const holding = this.ctx.holding;
        const holder = holding.holderOf(lane.groupId);
        if (holder === desk) { this.seated.set(laneId, desk.carrelName); return; }
        // The tree's to move while it sits at a tree-built desk (or nowhere yet); docked,
        // dragged, or seated at your own desk, it's yours.
        if ((holder && !holder.derived) || lane.pinned) return;
        if (holding.seat({ id: lane.groupId, grid: lane.book }, desk, { order }) === 'seated') this.seated.set(laneId, desk.carrelName);
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
