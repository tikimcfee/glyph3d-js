/** @import { AppContext } from './CommandProvider.jsx' */
/** @import { GomuxProvider, GomuxAgent, GomuxSnapshot } from '@glyph3d/core/services/data/GomuxProvider.js' */
/** @import SessionBooks from './SessionBooks.js' */

import DeskTree from './DeskTree.js';
import { LIFECYCLE } from './SessionDesk.js';
import { cylinderForm } from '../commands/handlers/carrelCommands.js';
import { getSetting } from './settings.js';

/**
 * GomuxHub — the gomuxai agent tree, as books at desks.
 *
 * gomuxai (the `agent` CLI) runs agents in tmux sessions and records who spawned whom; the
 * relay watches its stores (cli/gomux.go) and pushes the tree. Here each agent becomes an
 * agent BOOK (lane id = its gomuxai name) opened from its session's event stream through
 * SessionBooks — the one open path (tail read → hydrate → follow; live lines append, a tool's
 * result updates its sheet in place) — and the tree becomes DESKS (DeskTree):
 *
 *   the hub        — one world-managed carrel, `gomux`, a sibling of the file tree;
 *   a team         — an agent with helpers gets its own carrel, `gomux/<name>`, seated
 *                    where its book would be: its own book first, then its helpers (books,
 *                    or their own teams) in spawn order. Nesting is as deep as the tree.
 *
 * The hub is BORN a CYLINDER by default (`gomux.hubForm`: a natural-seat ring — every book
 * and team at its own size around you, so seeing them is a turn of the camera, not a flight;
 * rows stack up to Settings ▸ Carrel's cylinder rows, then the ring widens);
 * team desks are born flat walls standing on it. Each desk wears a title (the hub: `gomuxai`; a
 * team: `<name> · N helpers`), and the hub's desks are born spacing their members `gomux.gap`
 * apart — books are seated by the room they draw in (Book.getSeatBounds: nameplate, tabs,
 * cover, screen), so nothing overlaps. The form is chosen at birth only: a value set on one
 * hub desk (the HUD's Desk section, carrel.set) is that desk's own — no tree push re-stamps
 * it, and it persists by desk name though the desks themselves are rebuilt every boot.
 *
 * CENTER ON LOAD: once per page load (`gomux.centerOnLoad`), when the tree has arrived,
 * every shown book has opened, the desks have stopped moving and the world has stopped
 * placing the hub — the same answer three checks running, since the load is part event-
 * and part state-driven — the camera stands at the hub's center (carrel.enter).
 *
 * An agent's book follows its CURRENT session (the tree's `sessionId`, else its
 * transcript's path): a new session (the agent restarted) is opened into the same book and
 * the old stream closed. A book you cleared stays closed.
 *
 * Status rides the lane: `lane.meta.gomux` is the agent's node (status/detail/tool/…),
 * its lifecycle maps onto the book's (processing → active, idle → idle, error → stalled,
 * exited or cleaned up → done), and `waiting` (blocked on a person) raises the book's hand.
 * The agent's own status wins over what a live batch did to the book.
 *
 * SCREENS: with `gomux.autoScreens` on, every live agent with a tmux session gets its screen
 * (gomux.attach) riding beside its book — the book's aside, height-fit to the spread — as
 * soon as the book is open. A screen READS its agent's pane size (the relay pushes
 * `gomux/paneSize` when it moves) and a resize WRITES back (terminal.resize → the relay
 * resizes the agent's tmux window, and its CLI reflows).
 * Detaching one (gomux.detach) is remembered: the hub won't reopen it.
 *
 * Read-only by construction: nothing here types into, starts, or stops an agent.
 */

/** Desk name of the hub. */
export const GOMUX_HUB = 'gomux';

/**
 * @typedef {Object} HubLane
 * @property {string} name     the agent (and its book's lane id)
 * @property {string} session  the session its book follows (a session id, or a transcript path)
 */

export default class GomuxHub {
    /**
     * @param {AppContext} ctx
     * @param {GomuxProvider} provider
     * @param {SessionBooks} sessionBooks the one open path
     * @param {{exec?: (cmd: string|string[]) => Promise<any>}} [opts] exec runs a verb (screens)
     */
    constructor(ctx, provider, sessionBooks, { exec = null } = {}) {
        this.ctx = ctx;
        this.provider = provider;
        this.sessionBooks = sessionBooks;
        this._exec = exec;
        this.tree = new DeskTree(ctx, {
            hub: GOMUX_HUB, hubTitle: 'gomuxai',
            hubForm: () => (getSetting('gomux.hubForm') !== 'grid' ? cylinderForm() : { mode: 'grid' }),
            gap: () => getSetting('gomux.gap'),
        });
        /** Agents whose screen the hub asked for (or that were detached) — asked once. */
        this._screens = new Set();
        /** @type {GomuxSnapshot|null} */
        this.snapshot = null;
        /** @type {Map<string, GomuxAgent>} */
        this.nodes = new Map();
        /** @type {Map<string, HubLane>} */
        this.lanes = new Map();
        this._off = provider.onChange((snap) => this.apply(snap));
        this._offPane = provider.onPaneSize((e) => this._paneSize(e));
        this._offStream = sessionBooks.onStream((event, st) => this._stream(event, st));
        this._disposed = false;
    }

    /** Pull the tree (on connect — pushes only announce changes). */
    async refresh() {
        try {
            this.apply(await this.provider.list());
        } catch (e) {
            // An old relay (no gomux/*) or one started with --no-gomuxai: no hub, said once.
            console.info('[gomux] no gomuxai tree from the relay:', e?.message || e);
        }
    }

    /** The agents the hub shows: live ones, plus departed ones inside the history window. */
    _shown(snap) {
        const hours = Number(getSetting('gomux.historyHours'));
        const since = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3600e3 : -Infinity;
        return snap.agents.filter((a) => a.live || Date.parse(a.createdAt) >= since);
    }

    /**
     * Where an agent's book is: 'opening' | 'open' | 'failed' | 'closed' (cleared, or its
     * stream stopped), or null when the hub never opened one.
     * @param {string} name @returns {string|null}
     */
    phase(name) {
        const hl = this.lanes.get(name);
        if (!hl) return null;
        const st = this.sessionBooks.streams.get(hl.session);
        return st && st.lane === name ? st.phase : 'closed';
    }

    /**
     * Converge on a snapshot: a book for every shown agent with a session, the desk tree,
     * status onto lanes.
     * @param {GomuxSnapshot} snap
     */
    apply(snap) {
        if (this._disposed || !snap || !Array.isArray(snap.agents) || !this.ctx.agentBooks) return;
        if (getSetting('gomux.enabled') === false) return;
        this.snapshot = snap;
        const shown = this._shown(snap);
        this.nodes = new Map(shown.map((a) => [a.name, a]));
        for (const a of shown) {
            const session = a.sessionId || a.transcript;   // gomuxai reads a session by its id, or its transcript's path
            if (!session) continue;                         // no record yet (or a backend that keeps none)
            const hl = this.lanes.get(a.name);
            if (!hl) this._open(a, session);
            else if (hl.session !== session && this.ctx.agentBooks.lanes.has(a.name)) {
                this.sessionBooks.close(hl.session);        // the agent moved on to a new session: same book
                this._open(a, session);
            }
        }
        this._layout();
        for (const a of shown) this._status(a);
        this._autoScreens(shown);
        this._centerWhenSettled();
    }

    /** Open an agent's book from its session (SessionBooks: tail read → hydrate → follow). @private */
    _open(a, session) {
        this.lanes.set(a.name, { name: a.name, session });
        // A follower only for an agent that runs (the relay caps followers); a departed one's
        // book is its record. A failed open retries in SessionBooks, its book saying why.
        const opening = this.sessionBooks.open(session, { lane: a.name, agentType: a.harness || a.backend, follow: this._runs(a) });
        this._layout();   // the book was born just now: seat it before the auto-shelf sweep looks
        opening.catch(() => { /* SessionBooks said it, and retries */ });
    }

    /** Whether an agent runs now — its book follows only then. @private */
    _runs(a) {
        return !!a.live && a.status !== 'exited';
    }

    /** SessionBooks' events for the hub's books: once open, status + screen; after a live
     *  batch, the agent's own status again (a batch marks the book active). @private */
    _stream(event, st) {
        if (this._disposed || (event !== 'opened' && event !== 'applied')) return;
        const node = this.nodes.get(st.lane);
        if (!node || this.lanes.get(st.lane)?.session !== st.session) return;
        this._status(node);
        if (event === 'opened') this._autoScreens([node]);
    }

    /**
     * Stand the camera at the hub's center once everything has landed — once per page load.
     * Polled (not event-driven): the load is part events (tree pushes, book opens, async
     * card loads) and part state (desk animations, the world's placement), so the only
     * honest "done" is the same answer three checks running. Gives up after 30s; a person
     * already flying (drag or a flight key held) is never yanked.
     * @private
     */
    _centerWhenSettled() {
        if (this._centering || this._centered || !this._exec || getSetting('gomux.centerOnLoad') === false) return;
        this._centering = true;
        const t0 = performance.now();
        let last = null, same = 0;
        const tick = () => {
            if (this._disposed) return;
            const hub = this.ctx.carrels?.get(GOMUX_HUB);
            const opening = [...this.lanes.keys()].some((name) => this.phase(name) === 'opening');
            const moving = this.tree.desks().some((d) => d.animator?.isAnimating);
            let sig = null;
            if (hub && !opening && !moving) {
                hub.updateWorldMatrix(true, false);
                const b = hub.getBounds();
                sig = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, this.lanes.size].map((v) => Math.round(v)).join(',');
            }
            same = sig && sig === last ? same + 1 : 0;
            last = sig;
            if (same >= 2) {
                this._centering = false;
                this._centered = true;
                const cc = this.ctx.cameraController;
                if (cc?.input?.drag?.active || Object.values(cc?.input?.keys || {}).some(Boolean)) return;
                Promise.resolve(this._exec(['carrel.enter', GOMUX_HUB]))
                    .catch((e) => console.warn('[gomux] centering on the hub failed —', e?.message || e));
                return;
            }
            if (performance.now() - t0 > 30000) {
                this._centering = false;
                console.info('[gomux] the hub never settled within 30s — not centering the camera');
                return;
            }
            setTimeout(tick, 250);
        };
        setTimeout(tick, 250);
    }

    /** Open each live, attached agent's screen beside its open book — once per agent. */
    _autoScreens(shown) {
        if (!this._exec || getSetting('gomux.autoScreens') === false || !this.ctx.wsbridge?.connected) return;
        for (const a of shown) {
            if (!a.live || !a.attached || this._screens.has(a.name)) continue;
            if (this.phase(a.name) !== 'open') continue;
            this._screens.add(a.name);
            if (this.ctx.registry?.get(this.screenId(a.name))) continue;   // already up (a reload re-adopted it)
            Promise.resolve(this._exec(['gomux.attach', a.name])).then((r) => {
                if (String(r?.text ?? '').startsWith('ERR')) console.warn(`[gomux] ${a.name}: screen —`, r.text);
            }).catch((e) => console.warn(`[gomux] ${a.name}: screen failed —`, e?.message || e));
        }
    }

    /** The agent's screen was closed on purpose — don't reopen it. */
    declineScreen(name) { this._screens.add(name); }

    /** The agent's node onto its lane: meta.gomux, lifecycle, the waiting hand. */
    _status(a) {
        const books = this.ctx.agentBooks;
        const lane = books?.lanes.get(a.name);
        if (!lane || this.phase(a.name) === 'opening') return;
        const g = {
            name: a.name, parent: a.parent, backend: a.backend, session: a.session,
            status: a.live ? (a.status || 'unknown') : 'exited', detail: a.detail || '', tool: a.tool || '',
            live: a.live, attached: a.attached, statusAt: a.statusAt || null,
        };
        this.sessionBooks.setLive(this.lanes.get(a.name)?.session, this._runs(a));
        const prev = lane.meta?.gomux;
        if (!prev || Object.keys(g).some((k) => prev[k] !== g[k])) books.setLaneMeta(a.name, { gomux: g });
        const life = LIFECYCLE[g.status] ?? 'idle';
        if (lane.state !== life) books.state(a.name, life);
        if (g.status === 'waiting') {
            const msg = `waiting · ${a.detail || 'needs you'}`;
            if (lane.beacon !== msg) books.request(a.name, msg);
        } else if (lane.beacon) {
            books.clearRequest(a.name);
        }
    }

    /** Seat every book and team at its desk — spawn order is seat order (DeskTree). @private */
    _layout() {
        this.tree.layout([...this.nodes.values()].map((a) => ({
            id: a.name, parent: a.parent, label: a.name,
            book: this.lanes.has(a.name) && this.ctx.agentBooks?.lanes.has(a.name) ? a.name : null,
        })));
    }

    // ── screens ──────────────────────────────────────────────────────────────

    /** The terminal id an agent's screen shows in — the relay's gomuxTerminalID. */
    screenId(name) {
        return 'gx-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');
    }

    /** An agent's pane changed size elsewhere: its screen follows (terminal.resize — whose
     *  write-back to the agent is then a no-op at the same size). @private */
    _paneSize({ id, cols, rows } = {}) {
        const grid = this.ctx.terminals?.get(id);
        if (!grid || !this._exec || (grid.cols === cols && grid.rows === rows)) return;
        Promise.resolve(this._exec(['terminal.resize', id, String(cols), String(rows)]))
            .catch((e) => console.warn(`[gomux] ${id}: following the agent's pane size failed —`, e?.message || e));
    }

    /** The agent whose screen terminal `id` is, or null — a lookup over the tree. */
    screenAgent(id) {
        for (const a of this.snapshot?.agents || []) if (this.screenId(a.name) === id) return a.name;
        return null;
    }

    /**
     * Give an agent's screen terminal to its book as the book's ASIDE — parked right of
     * the spread, its height fit to the book's (Book.setAside), riding the book wherever
     * its desk puts it. A screen held elsewhere (docked, or seated by hand) stays put.
     * @returns {string|null} 'book' when it rides the book, else what holds it, or null
     */
    seatScreen(name, id) {
        const lane = this.ctx.agentBooks?.lanes.get(name);
        const entry = this.ctx.registry?.get(id);
        if (!lane || !entry) return null;
        const held = this.ctx.holding?.holderOf(id);
        if (held) return held.carrelName ?? 'dock';
        lane.book.setAside(entry.grid, { gap: Number(getSetting('gomux.screenGap')) || 24 });
        this.ctx.agentBooks._requestRelayout();   // the book's seat grew by the screen
        return 'book';
    }

    // ── read side ────────────────────────────────────────────────────────────

    /** The tree as rows for gomux.list: depth-first in spawn order. */
    rows() {
        const all = this.snapshot?.agents || [];
        const byParent = new Map();
        const names = new Set(all.map((a) => a.name));
        for (const a of all) {
            const p = a.parent && names.has(a.parent) ? a.parent : '';
            if (!byParent.has(p)) byParent.set(p, []);
            byParent.get(p).push(a);
        }
        const out = [];
        const walk = (p, depth) => {
            for (const a of byParent.get(p) || []) {
                out.push({ depth, agent: a, shown: this.nodes.has(a.name), book: this.phase(a.name) });
                walk(a.name, depth + 1);
            }
        };
        walk('', 0);
        return out;
    }

    dispose() {
        this._disposed = true;
        this._offPane?.();
        this._off?.();
        this._offStream?.();
    }
}
