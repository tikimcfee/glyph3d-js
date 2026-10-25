/** @import { AppContext } from './CommandProvider.jsx' */
/** @import Carrel from '@glyph3d/core/services/interaction/Carrel.js' */
/** @import { GomuxProvider, GomuxAgent, GomuxSnapshot } from '@glyph3d/core/services/data/GomuxProvider.js' */

import { readSessionTail } from '@glyph3d/core/services/data/sessionTailRead.js';
import { parseSessionOffThread } from '@glyph3d/core/workers/SessionParsePool.js';
import { parseClaudeSession } from '@glyph3d/core/collections/sessionAdapter.js';
import { buildCarrel } from '../commands/handlers/carrelCommands.js';
import { getSetting } from './settings.js';

/**
 * GomuxHub — the gomuxai agent tree, as books at desks.
 *
 * gomuxai (the `agent` CLI) runs agents in tmux sessions and records who spawned whom; the
 * relay watches its stores (cli/gomux.go) and pushes the tree. Here each agent becomes an
 * agent BOOK (lane id = its gomuxai name) that reads the harness's own transcript and
 * follows it live, and the tree becomes DESKS:
 *
 *   the hub        — one world-managed grid carrel, `gomux`, a sibling of the file tree;
 *   a team         — an agent with helpers gets its own grid carrel, `gomux/<name>`, seated
 *                    where its book would be: its own book first, then its helpers (books,
 *                    or their own teams) in spawn order. Nesting is as deep as the tree.
 *
 * The hub owns the STRUCTURE (which desk a book or team sits at) and rebuilds it from the
 * snapshot every boot — its desks are `derived`, never saved. A book the hub seated stays
 * the hub's to move when the tree changes; one you've taken elsewhere (docked, dragged,
 * seated at your own desk) is yours, and the hub leaves it alone.
 *
 * LIVE FOLLOW: the push carries each transcript's size. A grown transcript is read
 * forward from the lane's cursor (the byte after the last complete line), parsed, and
 * appended. A tool call whose result hasn't been written yet is held back — the cursor
 * stays, and the next read re-parses from it, skipping what was already committed — so a
 * Bash sheet arrives with its output instead of without it.
 *
 * Status rides the lane: `lane.meta.gomux` is the agent's node (status/detail/tool/…),
 * its lifecycle maps onto the book's (processing → active, idle → idle, error → stalled,
 * exited or cleaned up → done), and `waiting` (blocked on a person) raises the book's hand.
 *
 * Read-only by construction: nothing here types into, starts, or stops an agent.
 */

/** Desk name of the hub, and the team desk prefix. */
export const GOMUX_HUB = 'gomux';
const teamDesk = (name) => `${GOMUX_HUB}/${name}`;

/** gomuxai status → the book's lifecycle. */
const LIFECYCLE = { processing: 'active', waiting: 'active', idle: 'idle', error: 'stalled', exited: 'done', unknown: 'idle' };

/** Live-follow parsers by harness (raw adapter events; hydrate normalizes them). */
const FOLLOW_PARSE = {
    claude: (text) => parseClaudeSession(text).events,
};

/** A held-back pending tool stops holding once the re-read window passes this — a
 *  call that never resolves (an interrupted run) must not pin the cursor forever. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {Object} HubLane
 * @property {string} name
 * @property {'opening'|'open'|'failed'} phase
 * @property {number} cursor        absolute byte the next forward read starts at
 * @property {number} skip          events already committed from the window at `cursor`
 * @property {boolean} reading      a forward read is in flight
 * @property {boolean} again        the transcript grew during it — read again after
 * @property {string|null} harness
 * @property {string|null} desk     the desk the hub last seated this book at
 */

export default class GomuxHub {
    /**
     * @param {AppContext} ctx
     * @param {GomuxProvider} provider
     */
    constructor(ctx, provider) {
        this.ctx = ctx;
        this.provider = provider;
        /** @type {GomuxSnapshot|null} */
        this.snapshot = null;
        /** @type {Map<string, GomuxAgent>} */
        this.nodes = new Map();
        /** @type {Map<string, HubLane>} */
        this.lanes = new Map();
        /** Team desks the hub built, by agent name → the desk the team sits at. */
        this._teamParent = new Map();
        this._off = provider.onChange((snap) => this.apply(snap));
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
     * Converge on a snapshot: books for every shown agent with a transcript, the desk tree,
     * status onto lanes, and a forward read for every transcript that grew.
     * @param {GomuxSnapshot} snap
     */
    apply(snap) {
        if (this._disposed || !snap || !Array.isArray(snap.agents) || !this.ctx.agentBooks) return;
        if (getSetting('gomux.enabled') === false) return;
        this.snapshot = snap;
        const shown = this._shown(snap);
        this.nodes = new Map(shown.map((a) => [a.name, a]));
        for (const a of shown) {
            if (!a.transcript) continue;
            const hl = this.lanes.get(a.name);
            if (!hl) this._open(a);
            else if (hl.phase === 'open' && (a.transcriptSize ?? 0) > hl.cursor) this._follow(a.name);
        }
        this._layout();
        for (const a of shown) this._status(a);
    }

    // ── books ────────────────────────────────────────────────────────────────

    /** Open an agent's book: the transcript's tail, through the archive's one open path. */
    async _open(a) {
        const books = this.ctx.agentBooks;
        const harness = a.harness || 'claude';
        /** @type {HubLane} */
        const hl = { name: a.name, phase: 'opening', cursor: 0, skip: 0, reading: false, again: false, harness, desk: null };
        this.lanes.set(a.name, hl);
        books.ensure(a.name, harness);   // born now, so the hub seats it before the auto-shelf sweep looks
        this._layout();
        try {
            const cap = books.capForHydration(a.name);
            const r = await readSessionTail(this.provider, a.name, {
                harness, cap,
                startBytes: books.cfg.tailReadBytes,
                headMetaBytes: books.cfg.headMetaBytes,
                parse: (bytes, opts) => parseSessionOffThread(bytes, opts),
            });
            if (this._disposed) return;
            await books.hydrate(a.name, r.records, { agentType: harness, sessionId: a.sessionId || null, cwd: r.cwd || a.cwd || '', meta: r.meta });
            hl.cursor = r.end;
            hl.phase = 'open';
            const node = this.nodes.get(a.name);
            if (node) {
                this._status(node);
                if ((node.transcriptSize ?? 0) > hl.cursor) this._follow(a.name);
            }
        } catch (e) {
            hl.phase = 'failed';
            console.warn(`[gomux] ${a.name}: transcript open failed —`, e?.message || e);
        }
    }

    /** Read a grown transcript forward and append what's complete. Single-flight per lane. */
    async _follow(name) {
        const hl = this.lanes.get(name);
        if (!hl || hl.phase !== 'open') return;
        if (hl.reading) { hl.again = true; return; }
        const parse = FOLLOW_PARSE[hl.harness];
        if (!parse) {
            console.warn(`[gomux] ${name}: no live-follow parser for harness '${hl.harness}' — the book shows its open-time tail`);
            hl.phase = 'failed';
            return;
        }
        hl.reading = true;
        try {
            const r = await this.provider.read(name, { fromOffset: hl.cursor });
            const last = r.bytes.lastIndexOf(0x0A);
            if (last < 0) return;                                   // no complete line yet
            const end = r.offset + last + 1;
            const events = parse(new TextDecoder().decode(r.bytes.subarray(0, last + 1)));
            const pending = events.findIndex((e) => e.kind === 'tool' && e.response == null);
            const hold = pending >= 0 && end - r.offset < MAX_PENDING_BYTES;
            const upto = hold ? pending : events.length;
            const fresh = events.slice(hl.skip, upto);
            if (hold) { hl.cursor = r.offset; hl.skip = upto; }
            else { hl.cursor = end; hl.skip = 0; }
            if (fresh.length && !this._disposed) {
                const node = this.nodes.get(name);
                await this.ctx.agentBooks.hydrate(name, fresh, { agentType: hl.harness, cwd: node?.cwd || '' });
                if (node) this._status(node);   // hydrate rests the book at idle; the agent's own status wins
            }
        } catch (e) {
            console.warn(`[gomux] ${name}: follow read failed —`, e?.message || e);
        } finally {
            hl.reading = false;
            if (hl.again) { hl.again = false; this._follow(name); }
        }
    }

    /** The agent's node onto its lane: meta.gomux, lifecycle, the waiting hand. */
    _status(a) {
        const books = this.ctx.agentBooks;
        const lane = books?.lanes.get(a.name);
        if (!lane || this.lanes.get(a.name)?.phase === 'opening') return;
        const g = {
            name: a.name, parent: a.parent, backend: a.backend, session: a.session,
            status: a.live ? (a.status || 'unknown') : 'exited', detail: a.detail || '', tool: a.tool || '',
            live: a.live, attached: a.attached, statusAt: a.statusAt || null,
        };
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

    // ── desks ────────────────────────────────────────────────────────────────

    /** A desk by name — built (grid mode, derived) when absent. The hub is world-managed;
     *  a team desk is built loose and seated into its parent's desk by the layout. */
    _desk(name) {
        const map = this.ctx.carrels;
        const have = map?.get(name);
        if (have && !have._dissolving) return have;
        const desk = buildCarrel(this.ctx, name, { managed: name === GOMUX_HUB, nested: name !== GOMUX_HUB });
        desk.setMode('grid');
        desk.derived = true;
        return desk;
    }

    /**
     * Seat every book and team at its desk. An agent's place is its parent's team desk, or
     * the hub when it has no shown parent; an agent with shown helpers is represented by its
     * team desk there, and its book moves inside it. Spawn order is seat order.
     */
    _layout() {
        if (!this.ctx.carrels || !this.ctx.holding) return;
        const shown = [...this.nodes.values()];
        const kids = new Map();
        for (const a of shown) {
            const p = a.parent && this.nodes.has(a.parent) ? a.parent : '';
            if (!kids.has(p)) kids.set(p, []);
            kids.get(p).push(a);
        }
        const hasTeam = (name) => (kids.get(name) || []).some((k) => this.lanes.has(k.name) || kids.has(k.name));
        if (!shown.some((a) => this.lanes.has(a.name))) return;   // nothing to seat yet — no empty hub

        const place = (parentDesk, a, order) => {
            if (hasTeam(a.name)) {
                const team = this._desk(teamDesk(a.name));
                this._seatDesk(parentDesk, team, order);
                if (this.lanes.has(a.name)) this._seatBook(team, a.name, 0);
                (kids.get(a.name) || []).forEach((k, i) => place(team, k, i + 1));
            } else if (this.lanes.has(a.name)) {
                this._seatBook(parentDesk, a.name, order);
            }
        };
        const hub = this._desk(GOMUX_HUB);
        (kids.get('') || []).forEach((a, i) => place(hub, a, i));
    }

    /** Seat a book at a desk — unless it isn't the hub's to move any more. */
    _seatBook(desk, name, order) {
        const lane = this.ctx.agentBooks?.lanes.get(name);
        const hl = this.lanes.get(name);
        if (!lane || !hl) return;
        const holding = this.ctx.holding;
        const holder = holding.holderOf(lane.groupId);
        if (holder === desk) { hl.desk = desk.carrelName; return; }
        // The hub's to move while it sits at a hub desk (or nowhere yet); docked, dragged,
        // or seated at your own desk, it's yours.
        if ((holder && !holder.derived) || lane.pinned) return;
        if (holding.seat({ id: lane.groupId, grid: lane.book }, desk, { order }) === 'seated') hl.desk = desk.carrelName;
    }

    /** Seat a team desk inside its parent desk (desks aren't cargo — the hub holds them). */
    _seatDesk(parentDesk, team, order) {
        const cur = this._teamParent.get(team.carrelName);
        if (cur === parentDesk.carrelName && parentDesk.has(team.name)) return;
        if (cur) this.ctx.carrels.get(cur)?.release(team.name);
        parentDesk.lock(team.name, team, { order });
        this._teamParent.set(team.carrelName, parentDesk.carrelName);
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
                out.push({ depth, agent: a, shown: this.nodes.has(a.name), book: this.lanes.get(a.name)?.phase ?? null });
                walk(a.name, depth + 1);
            }
        };
        walk('', 0);
        return out;
    }

    dispose() {
        this._disposed = true;
        this._off?.();
    }
}
