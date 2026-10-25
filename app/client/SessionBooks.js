/** @import { AppContext } from './CommandProvider.jsx' */
/** @import { AgentSessionProvider, AgentSession } from '@glyph3d/core/services/data/AgentSessionProvider.js' */

import { AgentEventReader, eventRecord, parseEventSlice, sessionMeta } from '@glyph3d/core/collections/agentEvents.js';

/**
 * SessionBooks — every agent book's content, from its session's event stream. gomuxai is
 * the one reader of agent transcripts; the relay forwards its lines (AgentSessionProvider)
 * and this is the ONE open path: the gomuxai hub, the agents desk, agent.open, the Agents
 * panel's archive and session restore all open a book through open().
 *
 * OPEN: the book is born at once (ensure — its owner seats it before the auto-shelf sweep
 * looks), then
 *   1. read {tail}  — the session's recent window (cfg.tailReadBytes, doubling until it holds
 *                     the book's cap of records or reaches the transcript's start) →
 *                     parseEventSlice → hydrate (sheet numbers count from the run's start
 *                     when the read reached it, else from an estimate the first page back
 *                     makes exact);
 *   2. history      — paging back reads `read {from, until}` windows by each record's `at`
 *                     (AgentBooks.setHistory);
 *   3. follow {from: the last `at` read} — live from there: each `agentEvents/lines` push is
 *                     framed (AgentEventReader, retain:false) and applied (applyEvents: an
 *                     add is a sheet, an update rebuilds its sheet in place).
 * ENDED: a follower that exits (the transcript removed or replaced, the binary failed) is
 * re-followed from the last `at` after the book drops its provisional replies (EVENTS.md),
 * backing off; REFOLLOW_TRIES failures in a row stop it, loudly. A reconnect re-follows
 * every open stream (the relay drops a display's followers when it goes).
 * DELTA: a live call that lands ok taps the delta books' watch lane with its event record
 * (its meta carries an edit's patch).
 * CLOSE: a lane removed (agent.clear) closes its stream; close() unfollows.
 *
 * Lane ids: a workgroup agent's book is its gomuxai name, any other session's its session
 * id (laneForSession — the one rule).
 *
 * @typedef {Object} SessionStream
 * @property {string} session        the session id (or a transcript path)
 * @property {string} lane           the book it feeds
 * @property {string} agentType      the harness, for a lane born here
 * @property {'opening'|'open'|'failed'|'closed'} phase
 * @property {number|null} last      where a follow resumes: the newest line read that isn't a provisional reply
 * @property {Object|null} info      the latest session line
 * @property {boolean} live          a follower is subscribed now
 * @property {Promise<Object>} opening
 */

/** Delays between re-follows of an ended stream (ms; the last repeats). */
const REFOLLOW_MS = [1000, 2000, 5000, 10000, 30000];
/** Consecutive failed re-follows before a stream stops trying. */
const REFOLLOW_TRIES = 8;

/**
 * The book a session lives in: a workgroup agent's gomuxai name, else its session id.
 * @param {AgentSession} s @returns {string}
 */
export function laneForSession(s) {
    return s?.workgroup?.name || s?.session_id;
}

/**
 * A session by reference against a session list: its exact id, a workgroup agent's name,
 * or the start of one session id only (dashes ignored).
 * @param {AgentSession[]} sessions @param {string} ref
 * @returns {AgentSession}
 */
export function resolveSession(sessions, ref) {
    const key = String(ref ?? '');
    if (!key) throw new Error('no session named');
    const exact = sessions.find((s) => s.session_id === key);
    if (exact) return exact;
    const named = sessions.filter((s) => s.workgroup?.name === key);
    if (named.length) return named[0];   // newest first: the agent's current session
    const norm = key.replace(/-/g, '');
    const hits = sessions.filter((s) => String(s.session_id).replace(/-/g, '').startsWith(norm));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`ambiguous session '${key}' (${hits.length} match)`);
    throw new Error(`no session '${key}'`);
}

export default class SessionBooks {
    /**
     * @param {AppContext} ctx
     * @param {AgentSessionProvider} provider
     */
    constructor(ctx, provider) {
        this.ctx = ctx;
        this.provider = provider;
        /** @type {Map<string, SessionStream>} session id → its stream */
        this.streams = new Map();
        this._listeners = new Set();
        this._disposed = false;
        // A lane removed (agent.clear, the panel's ✕) closes its stream.
        this._offBooks = ctx.agentBooks?.onChange?.(() => this._sweep()) ?? null;
    }

    /**
     * Subscribe to stream events: 'open' (the book was just born — seat it now), 'opened'
     * (hydrated and following), 'session' (a live session line: `info` changed), 'applied'
     * (a live batch landed), 'failed', 'closed'.
     * Returns the unsubscribe fn.
     * @param {(event: string, stream: SessionStream) => void} fn
     */
    onStream(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /** The stream feeding a lane, or null. @param {string} lane */
    streamOfLane(lane) {
        for (const st of this.streams.values()) if (st.lane === lane) return st;
        return null;
    }

    /**
     * Open a session's book: tail read → hydrate → follow. Idempotent per session — a
     * session already open (or opening) answers with its open; a `limit` then becomes the
     * book's cap (book.limit's rule).
     * @param {string} session the session id (or a transcript path)
     * @param {{lane?: string, agentType?: string, limit?: number}} [opts]
     *        lane: the book (default the session id); limit: records to keep (0 = all)
     * @returns {Promise<{lane: string, session: string, added: number, total: number,
     *          whole: boolean, reads: number, ms: number}>}
     */
    open(session, { lane = session, agentType = 'claude', limit } = {}) {
        const books = this.ctx.agentBooks;
        if (!books) return Promise.reject(new Error('agent books not wired'));
        const have = this.streams.get(session);
        if (have && (have.phase === 'opening' || have.phase === 'open')) {
            if (limit != null && Number.isFinite(Number(limit))) books.setLimit(have.lane, Number(limit));
            return have.opening;
        }
        books.ensure(lane, agentType);   // born now, so its owner seats it before the auto-shelf sweep looks
        /** @type {SessionStream} */
        const st = { session, lane, agentType, phase: 'opening', last: null, info: null, live: false,
                     reader: null, off: null, timer: null, tries: 0, opening: null };
        this.streams.set(session, st);
        this._emit('open', st);
        st.opening = this._open(st, limit);
        return st.opening;
    }

    /** Stop following a session (its book stays, as it stands). @param {string} session */
    close(session) {
        const st = this.streams.get(session);
        if (!st) return false;
        this.streams.delete(session);
        const followed = st.live;
        this._stop(st);
        st.phase = 'closed';
        if (followed) {
            this.provider.unfollow(session).catch(() => { /* the provider said it, with the request */ });
        }
        this._emit('closed', st);
        return true;
    }

    /** The relay (re)connected: it dropped this display's followers — re-follow every open stream. */
    reconnect() {
        for (const st of this.streams.values()) {
            if (st.phase !== 'open') continue;
            this._stop(st);
            this.ctx.agentBooks?.dropProvisional(st.lane);
            this._follow(st).catch(() => { /* _follow said it */ });
        }
    }

    dispose() {
        this._disposed = true;
        this._offBooks?.();
        for (const st of this.streams.values()) { this._stop(st); st.phase = 'closed'; }
        this.streams.clear();
        this._listeners.clear();
    }

    // ── open ─────────────────────────────────────────────────────────────────

    /** @private */
    async _open(st, limit) {
        const books = this.ctx.agentBooks;
        const t0 = performance.now();
        try {
            const cap = books.capForHydration(st.lane, limit);
            let tail = Math.max(1, Math.floor(books.cfg.tailReadBytes) || 1), r, slice, whole, reads = 0;
            for (;;) {
                r = await this.provider.read(st.session, Number.isFinite(cap) ? { tail } : {});
                reads++;
                slice = parseEventSlice(r.lines, { showNoise: books.cfg.showNoise });
                whole = !Number.isFinite(cap) || (r.size != null && tail >= r.size);
                if (whole || slice.total >= cap || r.size == null) break;
                tail *= 2;
            }
            if (st.phase !== 'opening' || this._disposed) return this._result(st, 0, slice, whole, reads, t0);
            // The kept tail's place in the whole run: the records the cap sliced off this
            // window precede it — exact only when the window began at the transcript's start.
            const skipped = Number.isFinite(cap) ? Math.max(0, slice.total - cap) : 0;
            const sid = slice.session?.session_id || st.session;
            const before = books.lanes.get(st.lane);
            const other = !!before?.sessionId && before.sessionId !== sid && (before.entries.length > 0 || before.older?.length > 0);
            st.info = slice.session;
            const added = await books.hydrate(st.lane, slice.records, {
                agentType: slice.session?.harness || st.agentType, sessionId: sid,
                meta: slice.session ? sessionMeta(slice.session) : null, limit,
                seqBase: skipped, seqExact: whole && skipped === 0,
            });
            if (st.phase !== 'opening' || this._disposed) return this._result(st, added, slice, whole, reads, t0);
            st.last = slice.lastAt;
            // A book that already held another session's sheets (an agent that moved on to a
            // new session) can't page back through this one's offsets into them: sealed.
            books.setHistory(st.lane, { read: (window) => this.provider.read(st.session, window), sealed: other });
            st.phase = 'open';
            await this._follow(st);
            this._emit('opened', st);
            return this._result(st, added, slice, whole, reads, t0);
        } catch (e) {
            if (st.phase === 'opening') {
                st.phase = 'failed';
                this.streams.delete(st.session);
                console.warn(`[sessions] ${st.session}: opening its book (${st.lane}) failed —`, e?.message || e);
                this._emit('failed', st);
            }
            throw e;
        }
    }

    /** @private */
    _result(st, added, slice, whole, reads, t0) {
        return { lane: st.lane, session: st.session, added, total: slice?.total ?? 0, whole: !!whole, reads,
                 ms: Math.round(performance.now() - t0) };
    }

    // ── follow ───────────────────────────────────────────────────────────────

    /** Subscribe to the session's pushes and ask the relay to follow it from `last`. @private */
    async _follow(st) {
        st.reader = new AgentEventReader({ retain: false });
        st.off ??= this.provider.subscribe(st.session, {
            lines: (lines) => this._lines(st, lines),
            ended: (e) => this._ended(st, e),
        });
        try {
            await this.provider.follow(st.session, { from: st.last });
            st.live = st.phase === 'open';
        } catch (e) {
            // No live follow (the relay's follower cap, an older relay): the book shows what
            // the open read — said, with the request, by the provider; the stream retries.
            this._ended(st, { error: e?.message || String(e) });
        }
    }

    /** One `agentEvents/lines` batch onto the book. @private */
    _lines(st, lines) {
        if (st.phase !== 'open' || !st.reader) return;
        const changes = [];
        for (const line of lines) {
            try { changes.push(...st.reader.push(line + '\n')); }
            catch (e) { console.error(`[sessions] ${st.session}: a stream line off the contract was dropped —`, e?.message || e); }
        }
        if (st.reader.lastAt != null && !(st.last >= st.reader.lastAt)) st.last = st.reader.lastAt;
        if (!changes.length) return;
        st.tries = 0;
        let session = false;
        for (const c of changes) if (c.op === 'session') { st.info = c.session; session = true; }
        const books = this.ctx.agentBooks;
        books.applyEvents(st.lane, changes, { agentType: st.agentType });
        this._tapDeltas(st, changes);
        if (session) this._emit('session', st);
        this._emit('applied', st);
    }

    /** A live call that landed ok → the delta books' watch lane (unwatched lanes fall through). @private */
    _tapDeltas(st, changes) {
        const deltas = this.ctx.deltaBooks;
        if (!deltas?.ingestTool) return;
        const cwd = this.ctx.agentBooks?.lanes.get(st.lane)?.cwd || st.info?.cwd || '';
        for (const c of changes) {
            if (c.event?.kind !== 'tool' || c.event.tool?.result?.status !== 'ok') continue;
            const rec = eventRecord(c.event, c.pos);
            if (rec) deltas.ingestTool(st.lane, rec, cwd);
        }
    }

    /** A follower exited: re-follow from the last `at`, backing off. @private */
    _ended(st, { code, error } = {}) {
        if (st.phase !== 'open') return;
        st.live = false;
        clearTimeout(st.timer);
        if (st.tries >= REFOLLOW_TRIES) {
            console.error(`[sessions] ${st.session}: its follower ended ${st.tries} times running — the book (${st.lane}) stops following`
                + `${error ? ` (last: ${error})` : ''}`);
            return;
        }
        const delay = REFOLLOW_MS[Math.min(st.tries, REFOLLOW_MS.length - 1)];
        st.tries++;
        console.warn(`[sessions] ${st.session}: its follower ended${code != null ? ` (code ${code})` : ''}${error ? ` — ${error}` : ''};`
            + ` re-following from byte ${st.last ?? 0} in ${delay}ms`);
        this.ctx.agentBooks?.dropProvisional(st.lane);
        st.timer = setTimeout(() => {
            st.timer = null;
            if (st.phase === 'open' && this.streams.get(st.session) === st) this._follow(st);
        }, delay);
    }

    /** @private */
    _stop(st) {
        clearTimeout(st.timer);
        st.timer = null;
        st.off?.();
        st.off = null;
        st.live = false;
    }

    /** Close the streams whose book is gone. @private */
    _sweep() {
        const lanes = this.ctx.agentBooks?.lanes;
        if (!lanes) return;
        for (const st of [...this.streams.values()]) if (!lanes.has(st.lane)) this.close(st.session);
    }

    /** @private */
    _emit(event, st) {
        for (const fn of this._listeners) {
            try { fn(event, st); } catch (e) { console.error(`[sessions] a stream listener threw on '${event}'`, e); }
        }
    }
}
