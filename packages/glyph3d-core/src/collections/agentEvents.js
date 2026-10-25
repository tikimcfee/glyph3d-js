/**
 * agentEvents — the reader of gomuxai's agent event stream (`agent events <session> --json`,
 * the contract in gomuxai's docs/EVENTS.md). gomuxai is the one parser of the harnesses'
 * transcripts; this module never reads a transcript. It reads the stream gomuxai serves and
 * turns its events into the records an agent book renders, one sheet per event.
 *
 * The stream is JSON lines:
 *   {"type":"session", …Session}            what the session is; again whenever it changes
 *   {"type":"event", "op":"add"|"update", …} one thing that happened
 * Nothing is ever reordered. An event that changes later (a tool's result lands, a
 * provisional reply is confirmed) comes again as an `update` with the same `id`: the whole
 * event, carrying the `at`/`line`/`ts` of the line that changed it. The reader keeps events
 * by id, so an update REPLACES its event in place, and the event keeps its POSITION: the
 * `at`/`line`/`seq` of the add that introduced it. Position orders events within one
 * stream; `seq` restarts with every stream (a `--from` resume renumbers), so identity is
 * the `id`, and the byte offset `at` (the transcript line the event came from) is what a
 * book pages back by.
 *
 * Pure: no THREE, no DOM — the worker, the relay-side tooling and the tests import it.
 *
 *   AgentEventReader      push(bytes|text) → changes; the folded events by id
 *   eventRecord(ev, pos)  one event → the record a sheet renders (null: hidden noise)
 *   eventFacts(record)    the event's own facts as info rows (turn, status, final, …)
 *   sessionMeta(session)  a session line → the lane meta the nameplate reads
 *   eventLane(ev, lane)   the book an event belongs in (a subagent's events: its own)
 *   parseEventSlice(…)    a window of stream bytes → folded records (a book's history parse)
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

/**
 * The stream reader: JSONL in (any chunking — a line split across pushes, a UTF-8 codepoint
 * split across byte chunks), the folded events out. One reader per stream.
 */
export class AgentEventReader {
    constructor() {
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
 * One event → the record a sheet renders: the book's `action/target/detail/result/meta`
 * (what the verso and recto draw), plus the event's own facts. Text is carried whole.
 *
 *   prompt  action 'prompt', tag = whose words (PROMPT_ORIGINS), result = the text
 *   think   action 'think', result = the text; a redacted block has detail 'redacted'
 *   say     action 'say', result = the text; final / provisional ride as flags
 *   tool    the tool table's action/target/detail/meta as gomuxai sent them; result = the
 *           output, except a file target that succeeded (its snapshot is the content)
 *   system  action 'system', detail = the subtype, result = the text (else the data as JSON)
 *   request action 'request', detail = the model (only a `--requests` stream has these)
 *
 * A tool the table calls noise is null (hidden) unless `showNoise`.
 * @param {AgentEvent} ev
 * @param {{at:number, line?:number, seq?:number}|null} [pos] the event's position (its add);
 *        defaults to the event's own
 * @param {{showNoise?:boolean}} [opts]
 * @returns {Object|null}
 */
export function eventRecord(ev, pos = null, { showNoise = false } = {}) {
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
                target, detail: String(b.detail ?? ''),
                result: target && status !== 'error' ? '' : out,
                meta: b.meta && typeof b.meta === 'object' ? b.meta : null,
                status, subSession: b.sub_session ?? null,
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
        if (rec.subSession) rows.push(`started ${rec.subSession}`);
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
 * The book an event belongs in: a subagent's own events (they carry `agent`) are its book —
 * named by the subagent id, as the subagent's session id is — whatever stream fed them;
 * everything else is the stream's.
 * @param {AgentEvent} ev @param {string} streamLane @returns {string}
 */
export function eventLane(ev, streamLane) {
    return ev.agent || streamLane;
}

/**
 * The book a session line describes: a subagent's session (it names its parent) is the
 * subagent's book, its session id being the subagent id; any other is the stream's.
 * @param {Object} session @param {string} streamLane @returns {string}
 */
export function sessionLane(session, streamLane) {
    return session?.parent_session && session.session_id ? session.session_id : streamLane;
}

/**
 * A WINDOW of a stream (the events of transcript bytes [offset, offset + n)) → its folded
 * records, the parse half of a book's history source. Events fold by id in arrival order;
 * an update whose add lies before the window belongs to an older window and is dropped
 * here. The shape matches what AgentBooks' history reads back ({records, count, total}).
 * @param {Uint8Array|string} bytes stream lines
 * @param {{cap?:number, countOnly?:boolean, showNoise?:boolean}} [opts]
 *        cap keeps the newest N records; countOnly returns only the count
 * @returns {{records:Object[], count:number, total:number, session:Object|null}}
 */
export function parseEventSlice(bytes, { cap = Infinity, countOnly = false, showNoise = false } = {}) {
    const r = new AgentEventReader();
    r.push(bytes);
    r.end();
    const all = r.records({ showNoise });
    const total = all.length;
    if (countOnly) return { records: [], count: total, total, session: r.session };
    const records = Number.isFinite(cap) && total > cap ? all.slice(-cap) : all;
    return { records, count: records.length, total, session: r.session };
}
