/**
 * agentEvents — the reader of gomuxai's agent event stream (`agent transcript <session>`, the
 * contract in gomuxai's docs/EVENTS.md; the relay forwards its lines as `agentEvents/lines`
 * and answers `agentEvents/read` windows with them). gomuxai is the one parser of the
 * harnesses' transcripts; this module never reads a transcript. It reads the stream gomuxai
 * serves and turns its events into the records an agent book renders, one sheet per event.
 *
 * The stream is JSON lines:
 *   {"type":"session", …Session}            what the session is; again whenever it changes
 *   {"type":"event", "op":"add"|"update", …} one thing that happened
 * Nothing is ever reordered. An event that changes later (a tool's result lands, a
 * provisional reply is confirmed) comes again as an `update` with the same `id`: the whole
 * event, carrying the `at`/`line`/`ts` of the line that changed it. The reader keeps events
 * by id, so an update REPLACES its event in place, and the event keeps its POSITION: the
 * `at`/`line`/`seq` of the add that introduced it. Identity is the `id`; the byte offset
 * `at` (the transcript line the event came from) is what a book pages back by, and what a
 * follow resumes from (`lastAt`: the newest line read that isn't a provisional reply).
 *
 * Pure: no THREE, no DOM — the relay-side tooling and the tests import it.
 *
 *   AgentEventReader      push(bytes|text) → changes; the folded events by id (or, built
 *                         with retain:false, a framing-only reader for a live follow)
 *   eventRecord(ev, pos)  one event → the record a sheet renders (null: noise, when hidden)
 *   eventFacts(record)    the event's own facts as info rows (turn, status, final, …)
 *   sessionMeta(session)  a session line → the lane meta the nameplate reads
 *   eventLane(ev, …)      the book an event belongs in
 *   parseEventSlice(…)    a window of stream lines → folded records (a book's open + history)
 */

/** Whose words a prompt is, by its origin — the prompt sheet's tag. */
export const PROMPT_ORIGINS = Object.freeze({
    human: 'you',                       // typed by the person at the session
    queued: 'you · queued',             // the person, sent mid-turn
    delivered: 'delivered',             // gomuxai's held delivery (its text names the sender)
    'task-notification': 'notification', // the harness: a background task finished
    peer: 'peer',                       // another agent (a subagent's task is its parent's words)
    command: 'command',                 // a slash command
    system: 'harness',                  // hook context the harness injected
});

/** A tool result status, as an info row (ok says nothing — the output speaks). */
const STATUS_ROWS = Object.freeze({
    pending: 'pending',
    background: 'running in background',
    error: 'error',
    interrupted: 'interrupted',
});

const EVENT_KINDS = new Set(['prompt', 'think', 'say', 'tool', 'system', 'request']);

/**
 * Validate one parsed stream frame at the seam: the shape this reader relies on, or a loud
 * error naming what is wrong (a stream that drifted from the contract must not render as
 * a quietly wrong book).
 * @param {any} f @param {string} where
 */
function checkFrame(f, where) {
    if (!f || typeof f !== 'object') throw new Error(`[agentEvents] ${where}: not a JSON object`);
    if (f.type === 'session') return;
    if (f.type !== 'event') throw new Error(`[agentEvents] ${where}: unknown frame type ${JSON.stringify(f.type)}`);
    if (typeof f.id !== 'string' || !f.id) throw new Error(`[agentEvents] ${where}: event without an id`);
    if (f.op !== 'add' && f.op !== 'update') throw new Error(`[agentEvents] ${where}: event ${f.id} has op ${JSON.stringify(f.op)}`);
    if (!EVENT_KINDS.has(f.kind)) throw new Error(`[agentEvents] ${where}: event ${f.id} has kind ${JSON.stringify(f.kind)}`);
    if (!f[f.kind] || typeof f[f.kind] !== 'object') throw new Error(`[agentEvents] ${where}: event ${f.id} (${f.kind}) has no ${f.kind} body`);
    if (!Number.isFinite(f.at)) throw new Error(`[agentEvents] ${where}: event ${f.id} has no byte offset (at)`);
}

/**
 * @typedef {Object} AgentEvent  an EVENTS.md event line (type 'event')
 * @property {string} id @property {'add'|'update'} op @property {number} seq
 * @property {number} at @property {number} line @property {string} ts
 * @property {{id:string, index:number, derived?:boolean}} turn
 * @property {string} [agent]   the subagent id, on a subagent's own events
 * @property {'prompt'|'think'|'say'|'tool'|'system'|'request'} kind
 */

/**
 * @typedef {Object} EventChange  what one frame did to the reader
 * @property {'session'|'add'|'update'} op  `update` also covers an add of an id already held
 * @property {Object} [session]             op 'session': the session line
 * @property {AgentEvent} [event]           the event as it now stands (the whole event)
 * @property {{at:number, line:number, seq:number}} [pos] the event's position (its first add);
 *           null for an update of an event this reader never saw added
 */

/** A provisional reply (the Stop hook's, ahead of the transcript): a follow never resumes
 *  from it — its line isn't in the transcript yet (EVENTS.md, `say`). */
const isProvisional = (f) => f.kind === 'say' && !!f.say?.provisional;

/**
 * The stream reader: JSONL in (any chunking — a line split across pushes, a UTF-8 codepoint
 * split across byte chunks), the folded events out. One reader per stream.
 *
 * `retain: false` frames and checks without keeping events: every frame is reported as it
 * came (an add with its own position, an update positionless) — the live follow's reader,
 * whose books are the store (AgentBooks.applyEvents replaces by id), so a session followed
 * for days isn't held twice.
 */
export class AgentEventReader {
    /** @param {{retain?: boolean}} [opts] */
    constructor({ retain = true } = {}) {
        this.retain = retain;
        /** The `at` of the newest line read that isn't a provisional reply — where a follow
         *  resumes (`agentEvents/follow {from}`); null until an event arrives. */
        this.lastAt = null;
        /** @type {Object|null} the latest session line */
        this.session = null;
        /** @type {Map<string, {event:AgentEvent, pos:{at:number, line:number, seq:number}|null}>} id → event + position */
        this.byId = new Map();
        /** @type {string[]} ids in position order (the order their adds arrived) */
        this.order = [];
        this._tail = '';
        this._lineNo = 0;
        this._decoder = new TextDecoder();
    }

    /**
     * Feed stream bytes or text. Complete lines are read now; a trailing partial line waits
     * for the next push (or end()).
     * @param {Uint8Array|string} chunk
     * @returns {EventChange[]}
     */
    push(chunk) {
        const text = typeof chunk === 'string' ? chunk : this._decoder.decode(chunk, { stream: true });
        const buf = this._tail + text;
        const cut = buf.lastIndexOf('\n');
        if (cut < 0) { this._tail = buf; return []; }
        this._tail = buf.slice(cut + 1);
        return this._readLines(buf.slice(0, cut));
    }

    /** The stream ended: read a final line that had no newline. @returns {EventChange[]} */
    end() {
        const rest = this._tail + this._decoder.decode();
        this._tail = '';
        return rest.trim() ? this._readLines(rest) : [];
    }

    /** @private */
    _readLines(text) {
        const out = [];
        for (const line of text.split('\n')) {
            const n = this._lineNo++;
            if (!line.trim()) continue;
            let f;
            try { f = JSON.parse(line); }
            catch (e) { throw new Error(`[agentEvents] stream line ${n}: not JSON (${e.message}): ${line.slice(0, 200)}`); }
            const c = this.accept(f, `stream line ${n}`);
            if (c) out.push(c);
        }
        return out;
    }

    /**
     * Take one parsed frame.
     * @param {Object} f @param {string} [where] for the error message
     * @returns {EventChange|null}
     */
    accept(f, where = 'frame') {
        checkFrame(f, where);
        if (f.type === 'session') {
            const { type: _t, ...session } = f;
            this.session = session;
            return { op: 'session', session };
        }
        if (!isProvisional(f) && (this.lastAt == null || f.at > this.lastAt)) this.lastAt = f.at;   // (null >= 0 is true in JS: compare explicitly)
        if (!this.retain) {
            return f.op === 'add'
                ? { op: 'add', event: f, pos: { at: f.at, line: f.line, seq: f.seq } }
                : { op: 'update', event: f, pos: null };
        }
        const have = this.byId.get(f.id);
        if (have) {
            // An update — or a resumed stream re-sending an add the reader already holds
            // (`--from` the last held `at` re-reads that line): either way it replaces in place.
            have.event = f;
            return { op: 'update', event: f, pos: have.pos };
        }
        if (f.op === 'update') {
            // An update of an event this reader never saw added (it began after the add):
            // reported, not invented — the reader has no position for it.
            return { op: 'update', event: f, pos: null };
        }
        const pos = { at: f.at, line: f.line, seq: f.seq };
        this.byId.set(f.id, { event: f, pos });
        this.order.push(f.id);
        return { op: 'add', event: f, pos };
    }

    /** @param {string} id @returns {{event:AgentEvent, pos:Object|null}|undefined} */
    get(id) { return this.byId.get(id); }

    /** Events held, in position order. @returns {AgentEvent[]} */
    events() { return this.order.map((id) => this.byId.get(id).event); }

    /** How many events the reader holds. */
    get size() { return this.order.length; }

    /**
     * The held events as book records, in position order (hidden noise dropped).
     * @param {{showNoise?:boolean}} [opts] @returns {Object[]}
     */
    records(opts = {}) {
        const out = [];
        for (const id of this.order) {
            const { event, pos } = this.byId.get(id);
            const r = eventRecord(event, pos, opts);
            if (r) out.push(r);
        }
        return out;
    }
}

/** A tool result's output text: the contract's `output` (a string), else nothing. */
function outputOf(result) {
    return typeof result?.output === 'string' ? result.output : '';
}

/**
 * An event's target as a path to read: gomuxai relativizes a target under the session's
 * cwd, so a relative one joins it; an absolute one (or one with no cwd) stays as it is.
 * @param {string} target @param {string|null} [cwd] @returns {string}
 */
export function sessionPath(target, cwd) {
    const t = String(target || '');
    if (!t || !cwd || t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) return t;
    return `${String(cwd).replace(/[\\/]+$/, '')}/${t}`;
}

/**
 * One event → the record a sheet renders: the book's `action/target/detail/result/meta`
 * (what the verso and recto draw), plus the event's own facts. Text is carried whole.
 *
 *   prompt  action 'prompt', tag = whose words (PROMPT_ORIGINS), result = the text
 *   think   action 'think', result = the text; a redacted block has detail 'redacted'
 *   say     action 'say', result = the text; final / provisional ride as flags
 *   tool    the tool table's action/target/detail/meta as gomuxai sent them; result = the
 *           output, except a file target that succeeded (its snapshot is the content); file =
 *           the target's text as the call saw or left it ({text, start, total}), when the
 *           event carries it. A call the table calls noise keeps action 'noise' and heads
 *           with its tool's name
 *   system  action 'system', detail = the subtype, result = the text (else the data as JSON)
 *   request action 'request', detail = the model (only a `--requests` stream has these)
 *
 * Every event is a record by default (1:1); `showNoise: false` makes a noise call null.
 * @param {AgentEvent} ev
 * @param {{at:number, line?:number, seq?:number}|null} [pos] the event's position (its add);
 *        defaults to the event's own
 * @param {{showNoise?:boolean}} [opts]
 * @returns {Object|null}
 */
export function eventRecord(ev, pos = null, { showNoise = true } = {}) {
    const at = pos?.at ?? ev.at;
    const base = {
        id: ev.id, eventKind: ev.kind, at, ts: ev.ts ?? null,
        turn: ev.turn ? { id: ev.turn.id, index: ev.turn.index ?? 0, derived: !!ev.turn.derived } : null,
        agent: ev.agent || null,
        target: '', detail: '', result: '', meta: null,
    };
    const b = ev[ev.kind];
    switch (ev.kind) {
        case 'prompt': {
            const images = Array.isArray(b.images) ? b.images.length : 0;
            return {
                ...base, action: 'prompt', tag: PROMPT_ORIGINS[b.origin] ?? String(b.origin || 'prompt'),
                origin: b.origin ?? null, command: b.command ?? null, images,
                result: String(b.text ?? ''),
            };
        }
        case 'think':
            return { ...base, action: 'think', redacted: !!b.redacted, detail: b.redacted ? 'redacted' : '', result: String(b.text ?? '') };
        case 'say':
            return { ...base, action: 'say', final: !!b.final, provisional: !!b.provisional, result: String(b.text ?? '') };
        case 'tool': {
            if (b.action === 'noise' && !showNoise) return null;
            const status = b.result?.status ?? 'pending';
            const target = String(b.target ?? '');
            const out = outputOf(b.result);
            return {
                ...base, action: String(b.action || b.name || 'tool').toLowerCase(), name: b.name ?? null,
                ...(b.action === 'noise' && b.name ? { tag: String(b.name) } : {}),
                target, detail: String(b.detail ?? ''),
                result: target && status !== 'error' ? '' : out,
                meta: b.meta && typeof b.meta === 'object' ? b.meta : null,
                file: typeof b.file?.text === 'string'
                    ? { text: b.file.text, start: Math.max(1, Math.floor(b.file.start) || 1), total: b.file.total > 0 ? b.file.total : null }
                    : null,
                status, subSessions: Array.isArray(b.sub_sessions) ? b.sub_sessions.map(String) : [],
            };
        }
        case 'system':
            return {
                ...base, action: 'system', subtype: b.subtype ?? null, detail: String(b.subtype ?? ''),
                result: b.text != null ? String(b.text) : (b.data != null ? JSON.stringify(b.data, null, 2) : ''),
            };
        case 'request':
            return { ...base, action: 'request', detail: String(b.model ?? '') };
        default:
            throw new Error(`[agentEvents] event ${ev.id}: unknown kind ${JSON.stringify(ev.kind)}`);
    }
}

/**
 * The event's own facts as info rows, beside the tool table's meta: its turn, a prompt's
 * images, a reply's final/provisional mark, a redacted thought, a call's status (ok is
 * silent) and the subagent it started. (A subagent's own events sit in its own book, so
 * their `agent` needs no row.) A record that came from no event (an agent.activity
 * record) has none.
 * @param {Object} rec @returns {string[]}
 */
export function eventFacts(rec) {
    if (!rec?.eventKind) return [];
    const rows = [];
    if (rec.turn) rows.push(`turn ${rec.turn.index}${rec.turn.derived ? ' (derived)' : ''}`);
    if (rec.eventKind === 'prompt' && rec.images) rows.push(`${rec.images} image${rec.images === 1 ? '' : 's'}`);
    if (rec.eventKind === 'say' && rec.final) rows.push(rec.provisional ? 'final reply · provisional' : 'final reply');
    else if (rec.eventKind === 'say' && rec.provisional) rows.push('provisional');
    if (rec.eventKind === 'think' && rec.redacted) rows.push('redacted (signature only)');
    if (rec.eventKind === 'tool') {
        if (STATUS_ROWS[rec.status]) rows.push(STATUS_ROWS[rec.status]);
        if (rec.subSessions?.length) rows.push(`started ${rec.subSessions.join(', ')}`);
    }
    return rows;
}

/**
 * A session line → the lane meta an agent book's nameplate and readout read.
 * @param {Object} s @returns {Object}
 */
export function sessionMeta(s) {
    const m = {
        harness: s.harness, sessionId: s.session_id, cwd: s.cwd, project: s.project,
        title: s.title, agentName: s.agent_name, model: s.model, version: s.version,
        gitBranch: s.git_branch, workgroup: s.workgroup ?? null,
        parentSession: s.parent_session ?? null, continuedIn: s.continued_in ?? null,
    };
    for (const k of Object.keys(m)) if (m[k] === undefined || m[k] === '') delete m[k];
    return m;
}

/**
 * The book an event belongs in. A stream is one session's (`agent transcript <session>`), so
 * its events are its book's — a subagent's own stream included (its events carry `agent`,
 * the subagent's id, which for Claude is not its session id: that is `agent-<id>`). The one
 * exception is an old Claude main transcript that still holds its subagents' records
 * (sidechains with an agentId, the subagent keeping no transcript of its own): those
 * events are another agent's and land in a book of their own, named by that `agent`.
 * @param {AgentEvent} ev
 * @param {string} streamLane the book the stream feeds
 * @param {boolean} streamIsSubagent the stream is a subagent's own session (its session
 *        line names a parent_session)
 * @returns {string}
 */
export function eventLane(ev, streamLane, streamIsSubagent) {
    return ev.agent && !streamIsSubagent ? ev.agent : streamLane;
}

/**
 * A WINDOW of a stream (the lines an `agentEvents/read` returned) → its folded records, the
 * parse half of a book's open and history reads. Events fold by id in arrival order. An
 * update whose add lies before the window (a result landing far from its call) is not a
 * record of this window — it comes back in `orphans`, the event's state as of the window's
 * end, for the book to hold until that add pages in (AgentBooks adopts it then).
 * @param {Uint8Array|string|string[]} lines stream lines (an array: one line each, no newline)
 * @param {{cap?:number, showNoise?:boolean}} [opts] cap keeps the newest N records
 * @returns {{records:Object[], count:number, total:number, session:Object|null, lastAt:number|null,
 *            orphans:Map<string, Object>}}
 *          total: the window's records before the cap; lastAt: where a follow resumes after
 *          this window (AgentEventReader.lastAt); orphans: id → the record of an update whose
 *          add isn't in the window (hidden noise left out)
 */
export function parseEventSlice(lines, { cap = Infinity, showNoise = true } = {}) {
    const r = new AgentEventReader();
    const changes = r.push(Array.isArray(lines) ? (lines.length ? lines.join('\n') + '\n' : '') : lines);
    changes.push(...r.end());
    const orphans = new Map();
    for (const c of changes) {
        if (c.op !== 'update' || c.pos) continue;
        const rec = eventRecord(c.event, null, { showNoise });
        if (rec) orphans.set(rec.id, rec);
    }
    const all = r.records({ showNoise });
    const total = all.length;
    const records = Number.isFinite(cap) && total > cap ? all.slice(-cap) : all;
    return { records, count: records.length, total, session: r.session, lastAt: r.lastAt, orphans };
}
