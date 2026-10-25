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
 *                     parseEventSlice → hydrate (the window's records past the cap wait in
 *                     the older buffer; its results whose calls lie further back are held as
 *                     orphans for when those calls page in; sheet numbers count from the
 *                     run's start when the read reached it, else they're an estimate);
 *   2. history      — paging back reads `read {until, tail}` windows before each record's
 *                     `at` (AgentBooks.setHistory);
 *   3. follow {from: the last `at` read} — only for a LIVE book (open's `follow`; setLive
 *                     turns it on and off as the session's status moves — a follower is a
 *                     relay process, and the relay caps them): each `agentEvents/lines` push
 *                     is framed (AgentEventReader, retain:false) and applied (applyEvents: an
 *                     add is a sheet, an update rebuilds its sheet in place).
 * Every follow first drops the book's provisional replies (EVENTS.md: a reader resuming
 * drops them — the first follow after an open is a resume of its tail read too).
 * ENDED / A FOLLOW REFUSED: re-followed from the last `at`, backing off (REFOLLOW_MS);
 * REFOLLOW_TRIES failures in a row stop it. Either way the book SAYS it isn't live (its
 * notice — "not live: <why>"), not only the console.
 * AN OPEN THAT FAILS keeps its book and retries, backing off (REOPEN_MS, REOPEN_TRIES), the
 * book's notice saying why. A reconnect re-opens what was still opening (the bridge doesn't
 * fail RPCs in flight when the socket drops) and re-follows every live stream (the relay
 * drops a display's followers when it goes).
 * DELTA: a live call that lands ok taps the delta books' watch lane with its event record
 * (its meta carries an edit's patch).
 * CLOSE: a lane removed (agent.clear) closes its stream; close() always unfollows (the
 * relay takes an unfollow of a session it doesn't hold), so no follower leaks.
 *
 * Lane ids: a workgroup agent's book is its gomuxai name, any other session's — a workgroup
 * agent's subagents included — its session id (laneForSession — the one rule).
 *
 * @typedef {Object} SessionStream
 * @property {string} session        the session id (or a transcript path)
 * @property {string} lane           the book it feeds
 * @property {string} agentType      the harness, for a lane born here
 * @property {'opening'|'open'|'failed'|'closed'} phase  'failed': the open failed and retries
 * @property {boolean} wantLive      the book should follow (a live session)
 * @property {boolean} live          a follower is subscribed now
 * @property {number|null} last      where a follow resumes: the newest line read that isn't a provisional reply
 * @property {Object|null} info      the latest session line
 * @property {Promise<Object>} opening
 */

/** Delays between re-follows of an ended (or refused) stream (ms; the last repeats). */
const REFOLLOW_MS = [1000, 2000, 5000, 10000, 30000];
/** Consecutive failed re-follows before a stream stops trying. */
const REFOLLOW_TRIES = 8;
/** Delays between retries of a failed open (ms; the last repeats). */
const REOPEN_MS = [2000, 5000, 15000, 30000, 60000];
/** Failed opens in a row before a book stops retrying. */
const REOPEN_TRIES = 6;

/**
 * The book a session lives in: a workgroup agent's gomuxai name — its main session, not its
 * subagents (they carry the parent's workgroup too) — else the session id.
 * @param {AgentSession} s @returns {string}
 */
export function laneForSession(s) {
    return (!s?.parent_session && s?.workgroup?.name) || s?.session_id;
}

/**
 * A session by reference against a session list: its exact id, a workgroup agent's name
 * (its newest main session — never a subagent's), or the start of one session id only
 * (dashes ignored).
 * @param {AgentSession[]} sessions @param {string} ref
 * @returns {AgentSession}
 */
export function resolveSession(sessions, ref) {
    const key = String(ref ?? '');
    if (!key) throw new Error('no session named');
    const exact = sessions.find((s) => s.session_id === key);
    if (exact) return exact;
    const named = sessions.filter((s) => s.workgroup?.name === key && !s.parent_session);
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
     * (hydrated, following if live), 'session' (a live session line: `info` changed),
     * 'applied' (a live batch landed), 'failed' (an open failed; it retries), 'closed'.
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
     * Open a session's book: tail read → hydrate → follow (when `follow`). Idempotent per
     * session — a session already open (or opening, or retrying a failed open, which it
     * then retries now) answers with its open; a `limit` then becomes the book's cap
     * (book.limit's rule), a `follow` turns its following on.
     * @param {string} session the session id (or a transcript path)
     * @param {{lane?: string, agentType?: string, limit?: number, follow?: boolean}} [opts]
     *        lane: the book (default the session id); limit: records to keep (0 = all);
     *        follow: follow it live (default true — a session that ended needs no follower)
     * @returns {Promise<{lane: string, session: string, added: number, total: number,
     *          whole: boolean, reads: number, ms: number}>}
     */
    open(session, { lane = session, agentType = 'claude', limit, follow = true } = {}) {
        const books = this.ctx.agentBooks;
        if (!books) return Promise.reject(new Error('agent books not wired'));
        const have = this.streams.get(session);
        if (have) {
            if (limit != null && Number.isFinite(Number(limit))) books.setLimit(have.lane, Number(limit));
            if (follow) this.setLive(session, true);
            if (have.phase === 'failed') { have.tries = 0; this._reopen(have); }
            return have.opening;
        }
        books.ensure(lane, agentType);   // born now, so its owner seats it before the auto-shelf sweep looks
        /** @type {SessionStream} */
        const st = { session, lane, agentType, phase: 'opening', wantLive: !!follow, live: false, last: null, info: null,
                     limit, gen: 0, reader: null, off: null, timer: null, tries: 0, opening: null };
        this.streams.set(session, st);
        this._emit('open', st);
        st.opening = this._open(st);
        return st.opening;
    }

    /**
     * Follow a session's book live, or stop (its book stays as it stands). An owner calls
     * this as the session's status moves: a follower per live session only.
     * @param {string} session @param {boolean} on
     */
    setLive(session, on) {
        const st = this.streams.get(session);
        if (!st || st.wantLive === !!on) return false;
        st.wantLive = !!on;
        if (st.phase !== 'open') return true;   // the open follows when it lands
        if (on) { st.tries = 0; this._follow(st); }
        else {
            const held = !!st.off;
            this._stop(st);
            this.ctx.agentBooks?.setNotice(st.lane, null);
            if (held) this._unfollow(st.session);
        }
        return true;
    }

    /** Stop following a session (its book stays, as it stands). @param {string} session */
    close(session) {
        const st = this.streams.get(session);
        if (!st) return false;
        this.streams.delete(session);
        this._stop(st);
        st.gen++;   // an open in flight lands nowhere
        st.phase = 'closed';
        this._unfollow(session);   // always: a follow in flight (or backing off) must not leak a follower
        this._emit('closed', st);
        return true;
    }

    /** The relay (re)connected: it dropped this display's followers, and an RPC in flight
     *  when the socket went may never answer — re-open what was still opening (or failed),
     *  re-follow every live stream. */
    reconnect() {
        for (const st of this.streams.values()) {
            if (st.phase === 'opening' || st.phase === 'failed') { st.tries = 0; this._reopen(st); continue; }
            if (st.phase !== 'open' || !st.wantLive) continue;
            this._stop(st);
            st.tries = 0;
            this._follow(st);
        }
    }

    dispose() {
        this._disposed = true;
        this._offBooks?.();
        for (const st of this.streams.values()) { this._stop(st); st.gen++; st.phase = 'closed'; }
        this.streams.clear();
        this._listeners.clear();
    }

    // ── open ─────────────────────────────────────────────────────────────────

    /** @private */
    async _open(st) {
        const books = this.ctx.agentBooks;
        const gen = ++st.gen;
        const t0 = performance.now();
        const stale = () => st.gen !== gen || this._disposed;
        try {
            const cap = books.capForHydration(st.lane, st.limit);
            let tail = Math.max(1, Math.floor(books.cfg.tailReadBytes) || 1), r, slice, whole, reads = 0;
            for (;;) {
                r = await this.provider.read(st.session, Number.isFinite(cap) ? { tail } : {});
                reads++;
                slice = parseEventSlice(r.lines, { showNoise: books.cfg.showNoise });
                whole = !Number.isFinite(cap) || (r.size != null && tail >= r.size);
                if (whole || slice.total >= cap || r.size == null || stale()) break;
                tail *= 2;
            }
            if (stale()) return this._result(st, 0, slice, whole, reads, t0);
            // The kept tail's place in the whole run: the records the cap leaves in the older
            // buffer precede it — exact only when the window began at the transcript's start.
            const skipped = Number.isFinite(cap) ? Math.max(0, slice.total - cap) : 0;
            const sid = slice.session?.session_id || st.session;
            const before = books.lanes.get(st.lane);
            const other = !!before?.sessionId && before.sessionId !== sid && (before.entries.length > 0 || before.older?.length > 0);
            st.info = slice.session;
            const added = await books.hydrate(st.lane, slice.records, {
                agentType: slice.session?.harness || st.agentType, sessionId: sid,
                meta: slice.session ? sessionMeta(slice.session) : null, limit: st.limit,
                seqBase: skipped, seqExact: whole && skipped === 0, orphans: slice.orphans,
            });
            if (stale()) return this._result(st, added, slice, whole, reads, t0);
            st.last = slice.lastAt;
            // A book that already held another session's sheets (an agent that moved on to a
            // new session) can't page back through this one's offsets into them: sealed.
            books.setHistory(st.lane, { read: (window) => this.provider.read(st.session, window), sealed: other });
            books.setNotice(st.lane, null);
            st.phase = 'open';
            st.tries = 0;
            if (st.wantLive) await this._follow(st);
            this._emit('opened', st);
            return this._result(st, added, slice, whole, reads, t0);
        } catch (e) {
            if (!stale()) this._openFailed(st, e);
            throw e;
        }
    }

    /** An open failed: the book says so and the open retries, backing off. @private */
    _openFailed(st, e) {
        const why = e?.message || String(e);
        st.phase = 'failed';
        const give = st.tries >= REOPEN_TRIES;
        console.warn(`[sessions] ${st.session}: opening its book (${st.lane}) failed — ${why}`
            + (give ? ` (${st.tries} tries; it stops retrying — agent.open retries it)` : ''));
        this.ctx.agentBooks?.setNotice(st.lane, give ? `open failed: ${why}` : `open failed, retrying: ${why}`);
        this._emit('failed', st);
        if (give) return;
        clearTimeout(st.timer);
        st.timer = setTimeout(() => { st.timer = null; if (st.phase === 'failed' && this.streams.get(st.session) === st) this._reopen(st); },
            REOPEN_MS[Math.min(st.tries, REOPEN_MS.length - 1)]);
        st.tries++;
    }

    /** Run the open again (a retry, or a reconnect's re-open); the old attempt lands nowhere. @private */
    _reopen(st) {
        clearTimeout(st.timer);
        st.timer = null;
        st.phase = 'opening';
        st.opening = this._open(st);
        st.opening.catch(() => { /* said by _openFailed */ });
    }

    /** @private */
    _result(st, added, slice, whole, reads, t0) {
        return { lane: st.lane, session: st.session, added, total: slice?.total ?? 0, whole: !!whole, reads,
                 ms: Math.round(performance.now() - t0) };
    }

    // ── follow ───────────────────────────────────────────────────────────────

    /** Subscribe to the session's pushes and ask the relay to follow it from `last`. @private */
    async _follow(st) {
        // A follow is a resume (of the open's read, or of a stream that ended): the book's
        // provisional replies drop first — the copy may land in what comes (EVENTS.md).
        this.ctx.agentBooks?.dropProvisional(st.lane);
        st.reader = new AgentEventReader({ retain: false });
        st.off ??= this.provider.subscribe(st.session, {
            lines: (lines) => this._lines(st, lines),
            ended: (e) => this._ended(st, e),
        });
        try {
            await this.provider.follow(st.session, { from: st.last });
            if (st.phase === 'open' && st.wantLive) {
                st.live = true;
                if (st.tries) this.ctx.agentBooks?.setNotice(st.lane, null);
            }
        } catch (e) {
            // Refused (the relay's follower cap, a session it can't resolve): the book says
            // it isn't live; the stream retries.
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
        if (st.reader.lastAt != null && (st.last == null || st.reader.lastAt > st.last)) st.last = st.reader.lastAt;
        if (!changes.length) return;
        if (st.tries) { st.tries = 0; this.ctx.agentBooks?.setNotice(st.lane, null); }
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

    /** A follower exited, or a follow was refused: the book says it isn't live, and it
     *  re-follows from the last `at`, backing off. @private */
    _ended(st, { code, error } = {}) {
        if (st.phase !== 'open' || !st.wantLive) return;
        st.live = false;
        clearTimeout(st.timer);
        const why = error || (code != null ? `its follower exited (code ${code})` : 'its follower ended');
        if (st.tries >= REFOLLOW_TRIES) {
            console.error(`[sessions] ${st.session}: not live — ${st.tries} follows in a row failed; the book (${st.lane}) stops following (last: ${why})`);
            this.ctx.agentBooks?.setNotice(st.lane, `not live: ${why}`);
            return;
        }
        const delay = REFOLLOW_MS[Math.min(st.tries, REFOLLOW_MS.length - 1)];
        if (st.tries === 0) {
            console.warn(`[sessions] ${st.session}: ${why}; re-following from byte ${st.last ?? 0}, backing off from ${delay}ms`);
        }
        st.tries++;
        this.ctx.agentBooks?.setNotice(st.lane, `not live, retrying: ${why}`);
        st.timer = setTimeout(() => {
            st.timer = null;
            if (st.phase === 'open' && st.wantLive && this.streams.get(st.session) === st) this._follow(st);
        }, delay);
    }

    /** @private */
    _unfollow(session) {
        this.provider.unfollow(session).catch(() => { /* the provider said it, with the request */ });
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
