/** @import { AppContext } from './CommandProvider.jsx' */

/**
 * AgentVisibility — which agents get a book at all. A hidden agent is listed (the Agents
 * panel, dimmed, so it can be shown again) but its book is never opened: no read, no
 * follower, no GPU objects, no seat, no screen — the point is what a reload costs.
 *
 * THE RULE. An agent is hidden when its own override says so (hidden / shown, set by
 * agent.hide / agent.show / agent.open), else when its GROUP says so:
 *   shown   every agent of the group gets its book (the default)
 *   hidden  none does
 *   ended   only the ones still running do (an agent that ends closes its book)
 * Groups are the desks the owners seat books at: `gomux` (GomuxHub — the gomuxai tree) and
 * `local` (SessionDesk — the sessions no workgroup owns). An agent that appears later
 * follows its group's rule. Setting a group drops its current members' own overrides, so
 * one gesture hides (or shows) the whole group.
 *
 * ONE MEMORY. This is also what "a book you cleared stays closed" is for the books the hub
 * and the agents desk open by themselves: agent.clear on one hides it. The owners CONVERGE
 * on the rule — open what's shown, close what's hidden — on every tree / list push and on
 * every change here.
 *
 * THE HOME. One durable surface of the workspace model, `agents:visibility` (the
 * Visibility component's `hidden` key: `{ agents: {lane: true|false}, groups: {gomux:
 * 'hidden'|'ended', …} }`), saved as the snapshot's `agentVisibility`. Not on the books'
 * own `agent:book:<id>` surfaces: a book that closes drops its surface, and hiding closes
 * it. Writing through the model is what makes a hide autosave.
 *
 * THE GATE. The hub and the desk open books the moment the relay answers — which can beat
 * the session file's load. They wait on `ready` (settled by the restore's first stage, or
 * when there is no saved session to read), so a reload never opens a hidden agent, even
 * for a moment.
 *
 * Verbs own the writes (agent.hide / agent.show / agent.group / agent.open / agent.clear);
 * the panel reads this and issues them.
 */

/** The model surface the hidden set lives on. */
export const VISIBILITY_SURFACE = 'agents:visibility';

/** The groups an agent belongs to — the desks that open books by themselves. */
export const AGENT_GROUPS = ['gomux', 'local'];

/** A group's states. */
export const GROUP_STATES = ['shown', 'hidden', 'ended'];

/**
 * @typedef {Object} VisibilityState
 * @property {Object<string, boolean>} agents  lane → its own override (true = hidden)
 * @property {Object<string, string>} groups   group → 'hidden' | 'ended' (absent = shown)
 */

/** A stored value → a clean state (drops what isn't one). @returns {VisibilityState} */
function clean(raw) {
    const agents = {};
    const groups = {};
    if (raw && typeof raw === 'object') {
        for (const [lane, v] of Object.entries(raw.agents || {})) {
            if (lane && typeof v === 'boolean') agents[lane] = v;
        }
        for (const [g, v] of Object.entries(raw.groups || {})) {
            if (AGENT_GROUPS.includes(g) && (v === 'hidden' || v === 'ended')) groups[g] = v;
        }
    }
    return { agents, groups };
}

export default class AgentVisibility {
    /** @param {AppContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.ready = false;
        this._waiters = [];
        this._listeners = new Set();
        this._sig = JSON.stringify(this.state());
        // A write here (or the restore putting the saved set back) moves the model: tell the owners.
        this._offModel = ctx.workspace?.on?.('change:surfaces', () => this._changed()) ?? null;
    }

    /** The current state (from the model). @returns {VisibilityState} */
    state() {
        return clean(this.ctx.workspace?.getSurface?.(VISIBILITY_SURFACE)?.view?.hidden);
    }

    /**
     * Whether an agent's book stays closed.
     * @param {{lane: string, group?: string|null, ended?: boolean}} who
     */
    isHidden({ lane, group = null, ended = false }) {
        const st = this.state();
        if (lane && lane in st.agents) return st.agents[lane];
        const g = group ? st.groups[group] : null;
        return g === 'hidden' || (g === 'ended' && !!ended);
    }

    /** A group's state: 'shown' | 'hidden' | 'ended'. @param {string} group */
    groupState(group) {
        return this.state().groups[group] || 'shown';
    }

    /** An agent's own override: true (hidden), false (shown), or null (its group decides). */
    override(lane) {
        const v = this.state().agents[lane];
        return typeof v === 'boolean' ? v : null;
    }

    /**
     * Give an agent its own override — true hides it, false shows it, null hands it back to
     * its group. Returns whether anything changed.
     * @param {string} lane @param {boolean|null} hidden
     */
    setAgent(lane, hidden) {
        if (!lane) return false;
        const st = this.state();
        if (hidden == null) {
            if (!(lane in st.agents)) return false;
            delete st.agents[lane];
        } else {
            if (st.agents[lane] === !!hidden) return false;
            st.agents[lane] = !!hidden;
        }
        return this._write(st);
    }

    /**
     * Hide or show one agent: it gets its own override only where that differs from its
     * group's rule (showing an agent of a shown group just hands it back to the group).
     * @param {{lane: string, group?: string|null, ended?: boolean}} who @param {boolean} hidden
     */
    setHidden(who, hidden) {
        const g = who.group ? this.state().groups[who.group] : null;
        const byGroup = g === 'hidden' || (g === 'ended' && !!who.ended);
        return this.setAgent(who.lane, byGroup === !!hidden ? null : !!hidden);
    }

    /**
     * Who a lane is, for the rule: its group (`gomux` — a gomuxai agent, or a session of a
     * workgroup; else `local`) and whether it has ended — from the hub's tree, else the relay's
     * session list, else its book. @param {string} lane
     * @returns {{lane: string, group: string, ended: boolean, session: string|null}}
     */
    who(lane) {
        const ctx = this.ctx;
        const node = ctx.gomuxHub?.nodes.get(lane);
        if (node) return { lane, group: 'gomux', ended: !ctx.gomuxHub.runs(node), session: node.sessionId || node.transcript || null };
        const rows = ctx.sessionProvider?.sessions || [];
        const row = rows.find((s) => s.session_id === lane) || rows.find((s) => !s.parent_session && s.workgroup?.name === lane);
        if (row) return { lane, group: row.workgroup ? 'gomux' : 'local', ended: row.status === 'ended', session: row.session_id };
        const book = ctx.agentBooks?.lanes.get(lane);
        return { lane, group: book?.meta?.workgroup ? 'gomux' : 'local', ended: book?.state === 'done',
                 session: ctx.sessionBooks?.streamOfLane(lane)?.session ?? book?.sessionId ?? null };
    }

    /**
     * Close every open book the rule hides — the books opened from history or a restore,
     * which no desk converges (the hub's and the agents desk's own close themselves). A book
     * with no session (agent.spawn by hand) isn't an agent's to hide. @returns {string[]} closed lanes
     */
    closeHidden() {
        const books = this.ctx.agentBooks;
        const closed = [];
        for (const lane of [...(books?.lanes.keys() ?? [])]) {
            if (!this.ctx.sessionBooks?.streamOfLane(lane)) continue;
            if (this.isHidden(this.who(lane)) && books.remove(lane)) closed.push(lane);
        }
        return closed;
    }

    /**
     * Set a group's state; its current members' own overrides are dropped (one gesture
     * covers the whole group).
     * @param {string} group @param {'shown'|'hidden'|'ended'} state
     * @param {string[]} [members] the group's lanes (default: every lane with an override whose group it is)
     */
    setGroup(group, state, members = Object.keys(this.state().agents).filter((lane) => this.who(lane).group === group)) {
        if (!AGENT_GROUPS.includes(group)) throw new Error(`no agent group '${group}' (${AGENT_GROUPS.join(' | ')})`);
        if (!GROUP_STATES.includes(state)) throw new Error(`no group state '${state}' (${GROUP_STATES.join(' | ')})`);
        const st = this.state();
        if (state === 'shown') delete st.groups[group];
        else st.groups[group] = state;
        for (const lane of members) delete st.agents[lane];
        return this._write(st);
    }

    /** The saved set, put back by the restore (its first stage) — and the gate opens. */
    restore(raw) {
        const st = clean(raw);
        if (Object.keys(st.agents).length || Object.keys(st.groups).length) this._write(st);
        this.settle();
    }

    /** What the snapshot saves, or null when nothing is hidden. */
    capture() {
        const st = this.state();
        return Object.keys(st.agents).length || Object.keys(st.groups).length ? st : null;
    }

    /** The hidden set is known (restored, or there is none to restore): open the gate. */
    settle() {
        if (this.ready) return;
        this.ready = true;
        const waiters = this._waiters;
        this._waiters = [];
        for (const fn of waiters) {
            try { fn(); } catch (e) { console.error('[agents] a visibility waiter threw', e); }
        }
    }

    /** Run `fn` once the gate is open (now, if it is). */
    whenReady(fn) {
        if (this.ready) fn();
        else this._waiters.push(fn);
    }

    /** Subscribe to changes of the rule. Returns the unsubscribe fn. @param {() => void} fn */
    onChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    dispose() {
        this._offModel?.();
        this._listeners.clear();
        this._waiters = [];
    }

    /** @private */
    _write(st) {
        const ws = this.ctx.workspace;
        if (!ws?.setSurfaceView) throw new Error('agent visibility: no workspace model to keep it in');
        ws.setSurfaceView(VISIBILITY_SURFACE, 'agentVisibility', { hidden: st });
        this._changed();   // a model without change events still tells the owners
        return true;
    }

    /** @private */
    _changed() {
        const sig = JSON.stringify(this.state());
        if (sig === this._sig) return;
        this._sig = sig;
        for (const fn of this._listeners) {
            try { fn(); } catch (e) { console.error('[agents] a visibility listener threw', e); }
        }
    }
}
