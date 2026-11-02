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
 * hasn't ended (a follower is a relay process and the relay caps them; a book whose session
 * ends stops following, one whose session comes back follows again). Older sessions open on
 * demand (agent.open, the Agents panel's archive, a saved book's restore) and are seated here
 * too, outside the cap — a workgroup's session (a hub agent's subagent) excepted: it sits at
 * the hub under its agent. A session's subagents sit on its own team desk (`agents/<session id>`,
 * titled `<name> · N helpers`) — the DeskTree rule the hub's teams follow. A failed open
 * retries (SessionBooks), its book saying why.
 *
 * HIDDEN sessions (AgentVisibility — agent.hide, the `local` group hidden or ended, or a book
 * you cleared) get no book: the desk converges on the rule on every list push and every
 * change of it, and waits for the rule to be known (restored) before it opens anything. A
 * hidden session still holds its place in the `agents.maxBooks` window — hiding a book never
 * opens an older one in its place.
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

/** Whether a session with this status wants a follower: anything but ended (`unknown` may
 *  be running — an agy conversation held open, a Kimi session written lately). */
export const followable = (status) => status !== 'ended';

/** Session status → the book's lifecycle (the hub's table). */
export const LIFECYCLE = { processing: 'active', waiting: 'active', idle: 'idle', error: 'stalled', ended: 'done', unknown: 'idle' };

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
        /** Session ids this desk opened or seats (an on-demand open joins). */
        this.known = new Set();
        /** Session ids the desk took into its window by itself, shown or hidden — what agents.maxBooks counts. */
        this._autoOpened = new Set();
        /** Session id → the newest status word on it (list row or session line). */
        this._statusOf = new Map();
        this._offList = provider.onSessions((list) => this.apply(list));
        this._offStream = sessionBooks.onStream((event, st) => this._stream(event, st));
        this._offCloses = this.tree.watchCloses(() => this._layout());
        this._offVisibility = ctx.agentVisibility?.onChange(() => { if (this._list) this.apply(this._list); }) ?? null;
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
        this._list = list;
        this.sessions = new Map(list.sessions.map((s) => [s.session_id, s]));
        // Nothing opens before the hidden set is known (the restore's first stage puts it back).
        const vis = this.ctx.agentVisibility;
        if (vis && !vis.ready) {
            if (!this._parked) { this._parked = true; vis.whenReady(() => { this._parked = false; if (this._list) this.apply(this._list); }); }
            return;
        }
        const books = this.ctx.agentBooks;
        const max = Math.max(0, Math.floor(Number(getSetting('agents.maxBooks'))) || 0);
        // The window: every session the desk took by itself, shown or hidden (a book of the
        // desk's closes only by being hidden — it keeps its slot).
        let open = this._autoOpened.size;
        let opened = false;
        for (const s of this._auto(list.sessions)) {
            if (open >= max) break;
            if (this.known.has(s.session_id) || this._autoOpened.has(s.session_id)) continue;
            this._autoOpened.add(s.session_id);
            open++;
        }
        // Converge the window on the rule: a shown session's book opens, a hidden one's closes.
        for (const id of this._autoOpened) {
            const s = this.sessions.get(id);
            if (this._hiddenId(id)) {
                if (books.lanes.has(id)) books.remove(id);   // its stream closes with it (SessionBooks' sweep)
                this.known.delete(id);
                continue;
            }
            if (books.lanes.has(id) || this.sessionBooks.streams.has(id) || !s) continue;
            this.known.add(id);
            opened = true;
            this.sessionBooks.open(id, { agentType: s.harness, follow: followable(s.status) })
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

    /** Whether a session's book stays closed (AgentVisibility; its group is `local`). */
    hidden(s) {
        return !!this.ctx.agentVisibility?.isHidden({ lane: s.session_id, group: 'local', ended: s.status === 'ended' });
    }

    /** @private */
    _hiddenId(id) {
        const s = this.sessions.get(id);
        return s ? this.hidden(s) : !!this.ctx.agentVisibility?.isHidden({ lane: id, group: 'local' });
    }

    /** The sessions in the desk's window whose books are hidden — the Agents panel lists them,
     *  dimmed. @returns {AgentSession[]} */
    hiddenSessions() {
        return [...this._autoOpened].map((id) => this.sessions.get(id)).filter((s) => s && this.hidden(s));
    }

    /** Whether the desk took this session into its window by itself (its book is the desk's
     *  to open and close — agent.clear on it hides it). @param {string} id */
    owns(id) {
        return this._autoOpened.has(id);
    }

    /** SessionBooks' events: an on-demand open of a local session joins the desk. @private */
    _stream(event, st) {
        if (this._disposed) return;
        const s = this.sessions.get(st.session);
        if (event === 'open') {
            if (st.lane !== st.session) return;   // a workgroup agent's book (named for it): the hub's
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
     *  the order the desk first saw them (seats never reshuffle as sessions are written). A
     *  workgroup's session — a hub agent's subagent, opened from history or a restore — sits
     *  at the hub under its agent (GomuxHub), so it isn't seated here. @private */
    _layout() {
        const books = this.ctx.agentBooks;
        if (!books) return;
        const nodes = [];
        for (const id of this.known) {
            if (!books.lanes.has(id)) continue;
            const s = this.sessions.get(id);
            const meta = books.lanes.get(id).meta || {};
            if (s?.workgroup || meta.workgroup) continue;
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
        this._offCloses?.();
        this._offVisibility?.();
    }
}
