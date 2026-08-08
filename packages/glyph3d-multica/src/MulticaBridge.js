/**
 * MulticaBridge — Multica's board, expressed as glyph3d verbs.
 *
 * The analogy that makes this small: a Multica agent is already a *run with a
 * history*, and an AgentBook is already *a run bound as page-pair spreads*. So the
 * bridge introduces no new rendering primitive. It subscribes to the live stream and
 * replays it onto the command bus — `agent.spawn`, `agent.meta`, `agent.state`,
 * `agent.activity`, `agent.message` — the same verbs a local Claude session drives.
 * Everything the books already do (paging, framing, attention, retention) comes free,
 * and a Multica agent is inspectable by hand: `agent.state mc-1a2b3c4d active`.
 *
 * Normalization happens here and only here. Above this line the wire is Multica's;
 * below it, everything is glyph3d's.
 *
 * Commands are dispatched as **arrays**, not strings — the router accepts
 * `[name, ...args]`, so titles and message bodies carrying spaces need no quoting
 * and no base64 hatch.
 */

import { BOUND_EVENTS } from './types.js';

/** Multica agent status → the AgentBook lifecycle state. */
const STATE_BY_STATUS = Object.freeze({
    working: 'active',
    idle: 'idle',
    blocked: 'stalled',
    error: 'stalled',
    offline: 'idle',
});

/** Task lifecycle event → (activity action, book state). A null state leaves it alone. */
const TASK_EVENTS = Object.freeze({
    'task:queued': { action: 'queue', state: 'idle' },
    'task:dispatch': { action: 'dispatch', state: 'active' },
    'task:running': { action: 'run', state: 'active' },
    'task:progress': { action: 'progress', state: 'active' },
    'task:completed': { action: 'complete', state: 'idle', terminal: true },
    'task:failed': { action: 'fail', state: 'stalled', terminal: true },
    'task:cancelled': { action: 'cancel', state: 'idle', terminal: true },
    'task:waiting_local_directory': { action: 'wait', state: 'stalled' },
});

/**
 * Book id for a Multica agent. The UUID prefix keeps it collision-free and short
 * enough to type at the command bar; the display name rides in `agent.meta`, which
 * is what the nameplate reads.
 * @param {string} agentId
 * @returns {string}
 */
export const bookIdForAgent = (agentId) => `mc-${String(agentId).slice(0, 8)}`;

export default class MulticaBridge {
    /**
     * @param {Object} opts
     * @param {import('./MulticaClient.js').default} opts.client
     * @param {import('./MulticaSocket.js').default} opts.socket
     * @param {(input: string[]|string) => Promise<any>} opts.execute the router's execute
     * @param {(msg: string, ...rest: unknown[]) => void} [opts.warn]
     */
    constructor({ client, socket, execute, warn } = {}) {
        if (!client || !socket || !execute) {
            throw new Error('MulticaBridge: client, socket and execute are all required');
        }
        this.client = client;
        this.socket = socket;
        this.execute = execute;
        this._warn = warn || (() => {});

        /** agentId → book id, for the agents we've bound. */
        this.books = new Map();
        /**
         * task id → book id. Mid-lifecycle frames are lean: `task:progress` carries
         * only `{ task_id, summary, step, total }` with no agent at all, so the only
         * way to route it is to remember who owned the task when it was dispatched.
         * Entries are dropped on a terminal event so a long session doesn't grow this
         * without bound.
         */
        this.taskOwners = new Map();
        /** task id → issue id, so a progress frame can still name the work. */
        this.taskIssues = new Map();
        /**
         * chat session id → book id. `chat:done` names its session but not its agent,
         * and the task ledger can't cover it — the task may terminate (releasing its
         * entry) before the reply is published. The session roster is the stable key.
         */
        this.chatSessions = new Map();
        /**
         * runtime id → { name, provider }. An agent carries only `runtime_id`; the
         * provider (which CLI actually runs it — claude, kimi, codex…) lives on the
         * runtime. Resolving it here is what lets a book say what it is, and what lets
         * the board column by CLI.
         */
        this.runtimes = new Map();
        /** Unsubscribe thunks from every socket binding. */
        this._unsubs = [];
        /** Frames seen but not mapped — a newer backend, surfaced on demand not per-frame. */
        this.unhandled = new Map();
        this.started = false;
    }

    /**
     * Hydrate from REST, then bind the live stream. Hydration first so the field is
     * populated before the first frame lands — otherwise an early `task:running`
     * addresses a book that doesn't exist yet.
     * @returns {Promise<{agents: number, issues: number}>}
     */
    async start() {
        if (this.started) return { agents: this.books.size, issues: 0 };
        this.started = true;

        // Runtimes before agents: a book's provider is looked up as it binds.
        await this._loadRuntimes();

        const agents = await this.client.listAgents();
        for (const agent of agents) await this._bindAgent(agent);

        // Issues assigned to an agent are that agent's work — they land as activity on
        // its book. Unassigned issues have no book to belong to and are skipped here;
        // they're the project view's problem, not the agent view's.
        const issues = await this.client.listIssues();
        let placed = 0;
        for (const issue of issues) {
            if (issue.assignee_type === 'agent' && this.books.has(issue.assignee_id)) {
                await this._issueActivity(issue);
                placed += 1;
            }
        }

        await this._loadChatSessions();

        this._bindSocket();
        return { agents: this.books.size, issues: placed };
    }

    /** Unbind the stream. Books stay on the field — they're history, not a live view. */
    stop() {
        for (const off of this._unsubs) off();
        this._unsubs = [];
        this.started = false;
    }

    // -- binding ------------------------------------------------------------

    /**
     * Summon a book for an agent and stamp its provenance.
     * @param {import('./types.js').MulticaAgent} agent
     */
    async _bindAgent(agent) {
        const bookId = bookIdForAgent(agent.id);
        this.books.set(agent.id, bookId);

        const runtime = this.runtimes.get(agent.runtime_id) || null;
        // `provider` is the CLI behind the agent (claude / kimi / codex / a custom
        // profile). It rides in meta so it reaches book.userData, which is what a layout
        // scheme can group on — `multica.board provider` gives a column per CLI.
        const provider = runtime?.provider || 'unknown';

        await this.execute(['agent.spawn', bookId, provider]);
        await this.execute(['agent.meta', bookId, JSON.stringify({
            title: agent.name,
            slug: agent.name,
            source: 'multica',
            multica_agent_id: agent.id,
            runtime: agent.runtime_id || null,
            runtimeName: runtime?.name || null,
            provider,
            model: provider,        // the nameplate's third line — "what is this agent"
            description: agent.description || '',
        })]);
        if (agent.status) await this._setState(bookId, agent.status);
        return bookId;
    }

    _bindSocket() {
        const bind = (type, handler) => this._unsubs.push(this.socket.on(type, handler));

        bind('agent:created', async (payload) => {
            const agent = asAgent(payload);
            if (agent?.id && !this.books.has(agent.id)) await this._bindAgent(agent);
        });

        bind('agent:status', async (payload) => {
            const agent = asAgent(payload);
            const bookId = agent && this.books.get(agent.id);
            if (bookId && agent.status) await this._setState(bookId, agent.status);
        });

        for (const type of ['agent:archived', 'agent:restored']) {
            bind(type, async (payload) => {
                const agent = asAgent(payload);
                const bookId = agent && this.books.get(agent.id);
                // Archived persists as 'done'; restoring drops it back to idle.
                if (bookId) await this.execute(['agent.state', bookId, type === 'agent:archived' ? 'done' : 'idle']);
            });
        }

        for (const [type, spec] of Object.entries(TASK_EVENTS)) {
            bind(type, async (payload) => {
                const task = asObject(payload);
                const bookId = this._bookForTask(task);
                if (!bookId) return;

                // Remember the owner while the frame still names one, so the lean
                // mid-lifecycle frames can be routed. Terminal events release it.
                if (task.task_id) {
                    if (spec.terminal) {
                        this.taskOwners.delete(task.task_id);
                        this.taskIssues.delete(task.task_id);
                    } else {
                        this.taskOwners.set(task.task_id, bookId);
                        if (task.issue_id) this.taskIssues.set(task.task_id, task.issue_id);
                    }
                }

                const issueId = task.issue_id || this.taskIssues.get(task.task_id) || '';
                // `summary` is the progress frame's human line ("Launching claude");
                // `status` is the lifecycle frames'. Prefer whichever the frame carries.
                const detail = task.summary
                    ? (task.total ? `${task.summary} (${task.step}/${task.total})` : String(task.summary))
                    : String(task.title || task.status || '');

                await this.execute([
                    'agent.activity', bookId, 'multica', spec.action,
                    String(task.issue_identifier || issueId || task.task_id || ''),
                    detail,
                    String(task.error || task.result || ''),
                ]);
                if (spec.state) await this.execute(['agent.state', bookId, spec.state]);
            });
        }

        // A task's own narration is the agent speaking.
        bind('task:message', async (payload) => {
            const msg = asObject(payload);
            const bookId = this._bookForTask(msg);
            const text = String(msg.content || msg.text || msg.message || '');
            if (bookId && text) await this.execute(['agent.message', bookId, 'multica', 'say', text]);
        });

        // `chat:done` — NOT `chat:message` — is the agent's reply.
        //
        // `chat:message` is published with actor "member" at both of its sites: it is
        // the operator's own input, echoed so other clients can render it. Mapping it
        // to a say-sheet put the operator's words in the agent's mouth. The assistant's
        // completed turn arrives here instead, carrying the content directly.
        bind('chat:done', async (payload) => {
            const done = asObject(payload);
            const text = String(done.content || '');
            if (!text) return;  // a turn can complete with no reply (message_kind "no_response")
            const bookId = await this._bookForChatSession(done.chat_session_id);
            if (bookId) await this.execute(['agent.message', bookId, 'multica', 'say', text]);
        });

        for (const type of ['issue:created', 'issue:updated']) {
            bind(type, async (payload) => {
                // Issue frames arrive wrapped: `{ issue: {...} }`.
                const issue = unwrap(payload, 'issue');
                if (issue.assignee_type === 'agent' && this.books.has(issue.assignee_id)) {
                    await this._issueActivity(issue);
                }
            });
        }

        // An agent's comment is how it reports back — including the failure text when a
        // run dies. It is the most load-bearing say-sheet on the board.
        bind('comment:created', async (payload) => {
            const comment = unwrap(payload, 'comment');
            const bookId = this._bookForAuthor(comment);
            const text = String(comment.content || comment.body || '');
            if (bookId && text) await this.execute(['agent.message', bookId, 'multica', 'say', text]);
        });

        // Anything we don't map is counted, not logged per-frame: on a busy board an
        // unknown type arrives thousands of times, and the storm brake exists precisely
        // because that kind of logging is what drowns a session.
        this._unsubs.push(this.socket.onAny((msg) => {
            if (BOUND_EVENTS.includes(msg.type)) return;
            this.unhandled.set(msg.type, (this.unhandled.get(msg.type) || 0) + 1);
        }));
    }

    // -- helpers ------------------------------------------------------------

    /**
     * An issue as a line in its assignee's book. `stage` is carried through because
     * it is the pipeline: siblings sharing a stage are one barrier group.
     * @param {import('./types.js').MulticaIssue} issue
     */
    async _issueActivity(issue) {
        const bookId = this.books.get(issue.assignee_id);
        if (!bookId) return;
        const stage = issue.stage == null ? '' : `stage ${issue.stage}`;
        await this.execute([
            'agent.activity', bookId, 'multica', 'issue',
            String(issue.identifier || issue.id),
            String(issue.title || ''),
            [issue.status, stage].filter(Boolean).join(' · '),
        ]);
    }

    /**
     * Resolve a chat session to its agent's book, refetching the roster once if the
     * session is unknown — a conversation opened after we hydrated is the common case,
     * and it would otherwise silently drop every reply on that session.
     * @param {string} sessionId
     * @returns {Promise<string|undefined>}
     */
    async _bookForChatSession(sessionId) {
        if (!sessionId) return undefined;
        if (this.chatSessions.has(sessionId)) return this.chatSessions.get(sessionId);
        await this._loadChatSessions();
        return this.chatSessions.get(sessionId);
    }

    /**
     * Load the runtime roster (device × CLI). Non-fatal: an agent whose provider can't be
     * resolved still binds, as `unknown` — a book you can see beats a book that never
     * appeared because a lookup failed.
     */
    async _loadRuntimes() {
        try {
            for (const rt of await this.client.listRuntimes()) {
                this.runtimes.set(rt.id, { name: rt.name, provider: rt.provider || 'unknown' });
            }
        } catch (err) {
            this._warn(`multica: runtime roster unavailable — ${err?.message || err}`);
        }
    }

    /** Refresh session id → book from the roster. Failures are non-fatal: no reply routing is
     *  worse than a crashed handler on a socket callback. */
    async _loadChatSessions() {
        try {
            for (const s of await this.client.listChatSessions()) {
                const bookId = this.books.get(s.agent_id);
                if (bookId) this.chatSessions.set(s.id, bookId);
            }
        } catch (err) {
            this._warn(`multica: chat session roster unavailable — ${err?.message || err}`);
        }
    }

    /**
     * @param {string} bookId
     * @param {import('./types.js').MulticaAgentStatus} status
     */
    _setState(bookId, status) {
        return this.execute(['agent.state', bookId, STATE_BY_STATUS[status] || 'idle']);
    }

    /**
     * Route a task frame to a book. Frames name their agent inconsistently — most
     * lifecycle events carry `agent_id`, issue-shaped ones carry `assignee_id`, and
     * `task:progress` carries neither. The ledger is the fallback that keeps the
     * middle of a task's life on the same book as its start.
     * @param {Record<string, any>} task
     * @returns {string|undefined}
     */
    _bookForTask(task) {
        return this.books.get(task.agent_id)
            || this.books.get(task.assignee_id)
            || this.taskOwners.get(task.task_id);
    }

    /**
     * Comments name their writer with `author_id`/`author_type` — not the `actor_*`
     * pair the socket envelope uses. Only an agent's own comment belongs in its book;
     * a human's belongs to the issue page.
     * @param {Record<string, any>} record
     * @returns {string|undefined}
     */
    _bookForAuthor(record) {
        const type = record.author_type || record.actor_type;
        if (type && type !== 'agent') return undefined;
        return this.books.get(record.author_id)
            || this.books.get(record.actor_id)
            || this.books.get(record.agent_id);
    }
}

/** @param {unknown} payload @returns {Record<string, any>} */
function asObject(payload) {
    return (payload && typeof payload === 'object') ? /** @type {any} */ (payload) : {};
}

/**
 * Entity frames arrive wrapped under their type — `{ issue: {...} }`,
 * `{ comment: {...} }` — but not uniformly: the lean task frames are bare, and some
 * agent frames come either way. Unwrap when the key is there, pass through when it
 * isn't, so a handler never has to care which it got.
 * @param {unknown} payload
 * @param {string} key
 * @returns {Record<string, any>}
 */
function unwrap(payload, key) {
    const obj = asObject(payload);
    const inner = obj[key];
    return (inner && typeof inner === 'object') ? inner : obj;
}

/**
 * @param {unknown} payload
 * @returns {import('./types.js').MulticaAgent|null}
 */
function asAgent(payload) {
    const agent = unwrap(payload, 'agent');
    return agent && agent.id ? /** @type {any} */ (agent) : null;
}
