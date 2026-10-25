/**
 * Agent commands — the addressable surface over AgentBooks (every agent's run, bound
 * as a book of page-pair spreads on the field).
 *
 * A book's content is its session's event stream (gomuxai is the one reader of agent
 * transcripts; SessionBooks opens and follows it). The gomuxai hub and the agents desk open
 * books by themselves; these verbs open any other session, and drive a book by hand:
 *
 *   agent.sessions                                   every agent session on the host (the relay's list)
 *   agent.open     <session|prefix|name> [limit]     open a session as a book (tail → hydrate → follow)
 *   agent.activity <id> <type> <action> [target] [detail] [result]   a record directly (manual/CLI/tests)
 *       (detail/result/text with spaces ride the `call` base64 hatch)
 *   agent.spawn    <id> [type]                      summon an empty book (request an instance)
 *   agent.state    <id> <active|idle|stalled|done>  set lifecycle state
 *   agent.stop     <id>                             mark finished ('done' — PERSISTS)
 *   agent.clear    <id|all|done>                    remove agent book(s) from the field (stops following)
 *   agent.request  <id> [message...]                raise a hand ("needs you")
 *
 * Paging/tuning the books themselves is the book.* family (bookCommands) — paging is a
 * BOOK capability, not an agent one. Framing a book is the ordinary camera verb on its
 * registry id: `camera.focus agent:book:<id>`.
 *
 * To populate a book without an agent, drive the verb by hand, e.g.:
 *   agent.activity dev claude read app/main.jsx
 *   agent.activity dev claude bash "npm test" "" "5 passing"
 */

import { canonicalPath } from './pathResolve.js';
import { laneForSession, resolveSession } from '../../client/SessionBooks.js';
import { followable } from '../../client/SessionDesk.js';
/** @import { AppContext } from '../../client/CommandProvider.jsx' */
/** @import { AgentSession } from '@glyph3d/core/services/data/AgentSessionProvider.js' */

const noBooks = { text: 'ERR: agent books not wired', data: null };
const noSessions = { text: 'ERR: no agent sessions (the session list is a relay feature)', data: null };

/**
 * Open a session as a book — the one open path (SessionBooks) under the one lane rule
 * (laneForSession: a workgroup agent's name, else the session id). agent.open, the Agents
 * panel's archive and session restore ride it.
 * @param {AppContext} ctx
 * @param {AgentSession} session a row of the relay's session list
 * @param {{limit?: number}} [opts] limit = records to keep (0 = all) — becomes the book's cap
 */
export function openSession(ctx, session, { limit } = {}) {
    if (!ctx.sessionBooks) return Promise.reject(new Error('no session books (relay offline — sessions are a relay feature)'));
    // A session that ended needs no follower (the relay caps them): its book is its record.
    return ctx.sessionBooks.open(session.session_id, {
        lane: laneForSession(session), agentType: session.harness, limit, follow: followable(session.status),
    });
}

/**
 * The session list — the provider's latest, else asked for.
 * @param {AppContext} ctx @returns {Promise<AgentSession[]>}
 */
export async function sessionList(ctx) {
    const p = ctx.sessionProvider;
    if (!p) throw new Error('no session provider');
    return p.latest ? p.sessions : (await p.list()).sessions;
}

const fmtAge = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'M' : b >= 1024 ? Math.round(b / 1024) + 'K' : b + 'B');

/** A `call`-hatch arg that may be a parsed object, a JSON string, or empty → object | null. */
function parseJSONArg(a) {
    if (a && typeof a === 'object') return a;
    if (typeof a === 'string' && a.trim()) { try { return JSON.parse(a); } catch { /* malformed */ } }
    return null;
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerAgentCommands(router) {
    router.register('agent.activity', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        if (args.length < 3) {
            return { text: 'ERR: usage: agent.activity <id> <type> <action> [target] [detail] [result]', data: null };
        }
        // Positional record. Fields that carry spaces/quotes (detail, result) arrive intact
        // via the `call` hatch (base64'd arg vector); a bare typed line still works for the
        // simple <id> <type> <action> <target> case.
        const [id, type, action] = args;
        const target = args[3] || '';
        const detail = args[4] || '';
        const result = args[5] || '';
        // Optional structured per-tool details (lines read/written, +/−, tokens…). The `call`
        // hatch coerces non-string args to strings, so meta rides as a JSON STRING; accept
        // that or a direct object. A bare typed line just omits it.
        const meta = parseJSONArg(args[6]);
        // An open file's registry id is its canonical path — an exact lookup, so `/a/b.js`
        // never lands on an open `b.jsx`.
        let label = target || null;
        if (target) {
            const key = canonicalPath(ctx, target);
            if (ctx.registry?.has?.(key)) label = key;
        }
        books.activity(id, type, { action, target: label, detail, result, meta });
        const echo = [label, detail, result].filter(Boolean).join('  ');
        return {
            text: `OK: ${id} ${action}${echo ? ' ' + echo : ''}`,
            data: { id, action, target: label, detail, result },
        };
    }, { description: "Agent acted — page a sheet into its book", usage: '<id> <type> <action> [target] [detail] [result]' });

    router.register('agent.sessions', async (_args, ctx) => {
        if (!ctx.sessionProvider) return noSessions;
        let sessions;
        try { sessions = await sessionList(ctx); }
        catch (e) { return { text: `ERR: session list failed — ${e?.message || e}`, data: null }; }
        const open = new Set([...(ctx.agentBooks?.lanes.keys() ?? [])]);
        const rows = sessions.map((s) => {
            const lane = laneForSession(s);
            const who = s.workgroup ? `${s.workgroup.name} (workgroup)` : s.title || s.agent_name || s.project || '';
            return `${s.session_id}  ${String(s.harness || '').padEnd(6)} ${String(s.status || '').padEnd(10)} `
                + `${fmtAge(Date.parse(s.mtime)).padStart(4)}  ${fmtSize(s.size || 0).padStart(6)}  ${who}${open.has(lane) ? '  · open' : ''}`;
        });
        return {
            text: `SESSIONS (${sessions.length})\n` + (rows.length ? rows.join('\n') : '(none)'),
            data: { sessions: sessions.map((s) => ({
                id: s.session_id, lane: laneForSession(s), harness: s.harness, status: s.status, mtime: s.mtime, size: s.size,
                title: s.title || null, workgroup: s.workgroup?.name || null, parent: s.parent_session?.session_id || null,
                open: open.has(laneForSession(s)),
            })) },
        };
    }, { description: 'List every agent session on the host (workgroup and local) — the relay\'s session list', returns: '{ sessions:[{id,lane,harness,status,mtime,size,title,workgroup,parent,open}] }' });

    router.register('agent.open', async (args, ctx) => {
        if (!ctx.sessionProvider || !ctx.sessionBooks) return noSessions;
        if (!ctx.agentBooks) return noBooks;
        const [idArg, limitArg] = args;
        if (!idArg) return { text: 'ERR: usage: agent.open <session|prefix|name> [limit]', data: null };
        try {
            const s = resolveSession(await sessionList(ctx), idArg);
            const limit = limitArg != null ? Number(limitArg) : undefined;
            const r = await openSession(ctx, s, { limit });
            const capped = r.whole ? (r.added < r.total ? ` (of ${r.total} — tail)` : '') : ' (tail)';
            return {
                text: `OK: opened ${s.session_id} as ${r.lane} — ${r.added} sheet${r.added === 1 ? '' : 's'}${capped}${followable(s.status) ? ', following' : ' (ended — not followed)'}`,
                data: { sessionId: s.session_id, harness: s.harness, ...r },
            };
        } catch (e) {
            return { text: `ERR: ${e?.message || e}`, data: null };
        }
    }, { description: 'Open an agent session as a book (its event stream: the recent tail, then live). limit = records to keep (0 = all) — sets the book\'s cap', usage: '<session|prefix|name> [limit]' });

    router.register('agent.spawn', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        const [id, type] = args;
        if (!id) return { text: 'ERR: usage: agent.spawn <id> [type]', data: null };
        books.ensure(id, type || 'agent');
        return { text: `OK: summoned ${id}`, data: { id, type: type || 'agent' } };
    }, { description: 'Summon an agent book with no activity yet (request an instance)', usage: '<id> [type]' });

    router.register('agent.state', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        const [id, state] = args;
        if (!id || !state) return { text: 'ERR: usage: agent.state <id> <active|idle|stalled|done>', data: null };
        const ok = books.state(id, state);
        return ok
            ? { text: `OK: ${id} -> ${state}`, data: { id, state } }
            : { text: `ERR: no agent '${id}' (or bad state '${state}')`, data: null };
    }, { description: 'Set an agent lifecycle state', usage: '<id> <state>' });

    router.register('agent.stop', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        const [id] = args;
        if (!id) return { text: 'ERR: usage: agent.stop <id>', data: null };
        books.stop(id);
        return { text: `OK: ${id} finished`, data: { id } };
    }, { description: "Mark an agent finished ('done') — its book persists until cleared", usage: '<id>' });

    router.register('agent.clear', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        const [target] = args;
        if (!target) return { text: 'ERR: usage: agent.clear <id|all|done>', data: null };
        if (target === 'all' || target === 'done') {
            const n = books.clear(target);
            return { text: `OK: cleared ${n} agent book${n === 1 ? '' : 's'}`, data: { cleared: n } };
        }
        const ok = books.remove(target);
        return ok
            ? { text: `OK: cleared ${target}`, data: { id: target } }
            : { text: `ERR: no agent '${target}'`, data: null };
    }, { description: "Remove an agent's book, or all/done ('done' books persist until cleared) — its stream stops following", usage: '<id|all|done>' });

    router.register('agent.request', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        const [id] = args;
        if (!id) return { text: 'ERR: usage: agent.request <id> [message...]', data: null };
        const msg = args.slice(1).join(' ') || 'needs you';
        const ok = books.request(id, msg);
        return ok
            ? { text: `OK: ${id} raised a hand: "${msg}"`, data: { id, msg } }
            : { text: `ERR: no agent '${id}'`, data: null };
    }, { description: 'Agent raises a hand ("needs you") for input/advice', usage: '<id> [message]' });
}
