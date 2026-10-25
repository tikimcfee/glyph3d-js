/** @import { AppContext } from './CommandProvider.jsx' */
/** @import { AgentSessionProvider, AgentSession, AgentSessionList } from '@glyph3d/core/services/data/AgentSessionProvider.js' */
/** @import SessionBooks from './SessionBooks.js' */

import DeskTree from './DeskTree.js';
import { cylinderForm } from '../commands/handlers/carrelCommands.js';
import { getSetting } from './settings.js';

/**
 * SessionDesk — the agent sessions no workgroup owns (a plain Claude Code, agy or Kimi
 * session on this host), as books at the `agents` desk: a world-managed cylinder beside the
 * file tree, as the gomuxai hub is for the workgroup.
 *
 * WHICH BOOKS: from the relay's session list (agentSessions/changed — gomuxai's
 * `agent sessions --json`), the local sessions that are LIVE (idle, processing, waiting or
 * error) or were written within `gomux.historyHours` — the newest `agents.maxBooks` of them
 * (default 24; the list is newest first) — get a book of their own (lane id = the session
 * id), opened through SessionBooks: tail read, hydrate, and a FOLLOW only while the session
 * isn't exited (a follower is a relay process and the relay caps them; a book whose session
 * ends stops following, one whose session comes back follows again). Older sessions open on
 * demand (agent.open, the Agents panel's archive, a saved book's restore) and are seated here
 * too, outside the cap. A session's subagents sit on its own team desk (`agents/<session id>`,
 * titled `<name> · N helpers`) — the DeskTree rule the hub's teams follow. A book you cleared
 * stays closed while its session lives on. A failed open retries (SessionBooks), its book
 * saying why.
 *
 * Status rides the lane: the session's status (its list row, or its stream's newest session
 * line) maps onto the book's lifecycle as the hub's does, and `waiting` raises its hand.
 *
 * Read-only by construction: nothing here types into, starts, or stops a session.
 */

/** The desk local session books sit at. */
export const AGENTS_DESK = 'agents';

/** A session status that says it runs now (`unknown` doesn't: a session's status is unknown
 *  when the harness can't be asked — the history window decides those). */
const LIVE = new Set(['idle', 'processing', 'waiting', 'error']);

/** Whether a session with this status wants a follower: anything but exited (`unknown` may
 *  be running — an agy conversation held open, a Kimi session written lately). */
export const followable = (status) => status !== 'exited';

/** Session status → the book's lifecycle (the hub's table). */
export const LIFECYCLE = { processing: 'active', waiting: 'active', idle: 'idle', error: 'stalled', exited: 'done', unknown: 'idle' };

export default class SessionDesk {
    /**
     * @param {AppContext} ctx
     * @param {AgentSessionProvider} provider
     * @param {SessionBooks} sessionBooks
     */
    constructor(ctx, provider, sessionBooks) {
        this.ctx = ctx;
        this.provider = provider;
        this.sessionBooks = sessionBooks;
        this.tree = new DeskTree(ctx, { hub: AGENTS_DESK, hubForm: () => cylinderForm() });
        /** @type {Map<string, AgentSession>} session id → its latest list row */
        this.sessions = new Map();
        /** Session ids this desk opened or seats (an on-demand open joins) — a cleared one stays here, closed. */
        this.known = new Set();
        /** Session ids the desk opened by itself — what agents.maxBooks counts. */
        this._autoOpened = new Set();
        /** Session id → the newest status word on it (list row or session line). */
        this._statusOf = new Map();
        this._offList = provider.onSessions((list) => this.apply(list));
        this._offStream = sessionBooks.onStream((event, st) => this._stream(event, st));
        this._disposed = false;
    }

    /** Pull the list (on connect — pushes only announce changes). */
    async refresh() {
        try {
            await this.provider.list();   // answers through onSessions
        } catch (e) {
            console.info('[sessions] no agent session list from the relay:', e?.message || e);
        }
    }

    /** The sessions the desk would open by itself: local, and live or recently written —
     *  newest first, as the list comes. @param {AgentSession[]} sessions */
    _auto(sessions) {
        const hours = Number(getSetting('gomux.historyHours'));
        const since = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3600e3 : -Infinity;
        return sessions.filter((s) => !s.workgroup && s.path
            && (LIVE.has(s.status) || Date.parse(s.mtime) >= since));
    }

    /**
     * Converge on a session list: a book for each local session shown (up to the cap), the
     * desk tree, status onto lanes (and their following).
     * @param {AgentSessionList} list
     */
    apply(list) {
        if (this._disposed || !this.ctx.agentBooks || !Array.isArray(list?.sessions)) return;
        this.sessions = new Map(list.sessions.map((s) => [s.session_id, s]));
        const max = Math.max(0, Math.floor(Number(getSetting('agents.maxBooks'))) || 0);
        let open = [...this._autoOpened].filter((id) => this.ctx.agentBooks.lanes.has(id)).length;
        let opened = false;
        for (const s of this._auto(list.sessions)) {
            if (open >= max) break;
            if (this.known.has(s.session_id)) continue;
            this.known.add(s.session_id);
            this._autoOpened.add(s.session_id);
            open++;
            opened = true;
            this.sessionBooks.open(s.session_id, { agentType: s.harness, follow: followable(s.status) })
                .catch(() => { /* SessionBooks said it (and retries) */ });
        }
        // The list arrives whole (every session on the host, re-pushed whenever any of it
        // moves): the desks rebuild only when what they show changed.
        const sig = [...this.known].map((id) => {
            const s = this.sessions.get(id);
            return `${id}|${s?.parent_session?.session_id ?? ''}|${s?.status ?? ''}|${s?.title ?? ''}`;
        }).join('\n');
        if (!opened && sig === this._sig) return;
        this._sig = sig;
        this._layout();
        for (const id of this.known) this._status(id, this.sessions.get(id)?.status);
    }

    /** SessionBooks' events: an on-demand open of a local session joins the desk. @private */
    _stream(event, st) {
        if (this._disposed) return;
        const s = this.sessions.get(st.session);
        if (event === 'open') {
            if (s?.workgroup || st.lane !== st.session) return;   // a workgroup agent's book: the hub's, or yours
            this.known.add(st.session);
            this._layout();
        } else if (event === 'opened' || event === 'session' || event === 'applied') {
            if (!this.known.has(st.session)) return;
            if (event === 'opened') this._layout();   // its session line may name a parent now
            // A session line is the newest word on its status; a batch only re-asserts it
            // (activity marks a book active).
            this._status(st.session, event === 'applied' ? undefined : st.info?.status);
        }
    }

    /** The desk nodes: every known session whose book is open, its subagents under it, in
     *  the order the desk first saw them (seats never reshuffle as sessions are written). @private */
    _layout() {
        const books = this.ctx.agentBooks;
        if (!books) return;
        const nodes = [];
        for (const id of this.known) {
            if (!books.lanes.has(id)) continue;
            const s = this.sessions.get(id);
            const meta = books.lanes.get(id).meta || {};
            const parent = s?.parent_session?.session_id ?? meta.parentSession?.session_id ?? '';
            nodes.push({ id, parent, book: id, label: s?.title || s?.agent_name || meta.title || meta.agentName || id });
        }
        this.tree.layout(nodes);
    }

    /**
     * A session's status onto its lane: lifecycle, the waiting hand. `status` is the newest
     * word on it (its list row, or its stream's session line — whichever came last); without
     * one, the last word is re-asserted. @private
     */
    _status(id, status) {
        if (status) this._statusOf.set(id, status);
        const books = this.ctx.agentBooks;
        const lane = books?.lanes.get(id);
        const st = this.sessionBooks.streams.get(id);
        if (!lane || !st) return;
        status = this._statusOf.get(id) || 'unknown';
        this.sessionBooks.setLive(id, followable(status));   // a follower only while it can say something
        if (st.phase === 'opening') return;
        const life = LIFECYCLE[status] ?? 'idle';
        if (lane.state !== life) books.state(id, life);
        if (status === 'waiting') {
            if (lane.beacon !== 'waiting') books.request(id, 'waiting');
        } else if (lane.beacon) {
            books.clearRequest(id);
        }
    }

    dispose() {
        this._disposed = true;
        this._offList?.();
        this._offStream?.();
    }
}
