/**
 * Agent commands — the addressable surface over AgentBooks (every agent's run, bound
 * as a book of page-pair spreads on the field).
 *
 * The Claude Code hook drives these automatically via `agent.tool` (the raw tool event
 * → the shared tool registry), but they're plain commands first: you can spawn and page
 * agents by typing them, which is how this whole spine is verified.
 *
 *   agent.tool     <id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]  raw tool event → normalized record
 *   agent.message  <id> <type> <kind> <text>         a conversation block (text/thinking) → say/think sheet
 *   agent.meta     <id> <json>                      provenance metadata (slug/title/model/cwd/…) → lane + nameplate
 *   agent.kimi-wire <id> <b64line>                  one raw kimi wire.jsonl line → shared dialect → tool/message events
 *   agent.activity <id> <type> <action> [target] [detail] [result]   the normalized record directly (manual/CLI/tests)
 *       (detail/result/text with spaces ride the `call` base64 hatch)
 *   agent.spawn    <id> [type]                      summon an empty book (request an instance)
 *   agent.state    <id> <active|idle|stalled|done>  set lifecycle state
 *   agent.stop     <id>                             mark finished ('done' — PERSISTS)
 *   agent.clear    <id|all|done>                    remove agent book(s) from the field
 *   agent.request  <id> [message...]                raise a hand ("needs you")
 *
 * Paging/tuning the books themselves is the book.* family (bookCommands) — paging is a
 * BOOK capability, not an agent one. Framing a book is the ordinary camera verb on its
 * registry id: `camera.focus agent:book:<id>`.
 *
 * To populate a book without a live agent, drive the verb by hand, e.g.:
 *   agent.activity dev claude read app/main.jsx
 *   agent.activity dev claude bash "npm test" "" "5 passing"
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { normalizeToolCall, normalizeMessage } from '@glyph3d/core/collections/toolRegistry.js';
import { parseClaudeSessionAsync, parseKimiSessionAsync, agentIdForSession, kimiAgentIdForSession,
         createKimiWireState, kimiWireLineToEvents }
    from '@glyph3d/core/collections/sessionAdapter.js';
import { decodeBase64 } from '@glyph3d/core/utils/encoding.js';

const noBooks = { text: 'ERR: agent books not wired', data: null };

/** The lane id an archive entry opens under — per-harness derivation (the kimi ids'
 *  `session_` prefix would collapse every kimi lane to one id under the claude rule). */
const agentIdForEntry = (s) => (s.harness === 'kimi' ? kimiAgentIdForSession(s.id) : agentIdForSession(s.id));

/**
 * Open a stored agent session as a book: fetch the harness's own record (the durable
 * state), parse it through the harness's adapter, and bulk-hydrate a lane whose id matches
 * the harness's derivation — for claude that's the live hook's, so a still-running
 * session's stream converges on the same book. The ONE open path: the agent.open verb and
 * session restore both ride it. Parse AND hydrate are frame-sliced (the ...Async adapters,
 * AgentBooks.hydrate) — a deep history streams in over a few frames instead of one long task.
 * @param {Object} ctx
 * @param {string} sessionId full session id (the record's filename stem)
 * @param {{limit?: number, harness?: string}} [opts] limit = turns to keep (0 = all) —
 *        becomes the book's retention override; omitted → the book's cap (its override,
 *        else cfg.maxSheets). harness = which archive/adapter ('claude' default | 'kimi').
 * @returns {Promise<{agentId: string, added: number, total: number}>}
 */
export async function openAgentSession(ctx, sessionId, { limit, harness = 'claude' } = {}) {
    const provider = ctx.sessionProvider;
    if (!provider) throw new Error('no session provider (relay offline — the archive is a relay feature)');
    if (!ctx.agentBooks) throw new Error('agent books not wired');
    if (harness === 'kimi') {
        const { content, cwd: indexCwd } = await provider.read(sessionId, { harness: 'kimi' });
        const { events, cwd, meta } = await parseKimiSessionAsync(content, indexCwd);
        const agentId = kimiAgentIdForSession(sessionId);
        const added = await ctx.agentBooks.hydrate(agentId, events, { agentType: 'kimi', sessionId, cwd, meta, limit });
        return { agentId, added, total: events.length };
    }
    const { content } = await provider.read(sessionId);
    const { events, cwd, meta } = await parseClaudeSessionAsync(content);
    const agentId = agentIdForSession(sessionId);
    const added = await ctx.agentBooks.hydrate(agentId, events, { agentType: 'claude', sessionId, cwd, meta, limit });
    return { agentId, added, total: events.length };
}

/** Resolve a session id or unique prefix against the archive listing (dash-insensitive).
 *  Returns the full entry {id, harness} — the harness tags which adapter opens it. */
async function resolveSessionEntry(provider, idOrPrefix) {
    const sessions = await provider.list();
    const exact = sessions.find((s) => s.id === idOrPrefix);
    if (exact) return exact;
    const norm = String(idOrPrefix).replace(/-/g, '');
    const hits = sessions.filter((s) => s.id.replace(/-/g, '').startsWith(norm));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`ambiguous session '${idOrPrefix}' (${hits.length} matches)`);
    throw new Error(`no session '${idOrPrefix}'`);
}

const fmtAge = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'M' : b >= 1024 ? Math.round(b / 1024) + 'K' : b + 'B');

/** Canonicalize a record's target against the live registry (an open file's registry id
 *  is its canonical path), then sink the record into the books. The shared sink for the
 *  manual `agent.activity` verb and the raw `agent.tool`/`agent.message` ingress. */
function emitActivity(ctx, books, id, type, { action, target, detail, result, meta }) {
    let label = target || null;
    if (target) {
        const r = resolveGridByIdOrIndex(ctx, target, 'grid', { byName: true });
        if (!r.error) label = r.registryId || target;
    }
    books.activity(id, type, { action, target: label, detail, result, meta });
    return label;
}

/** A `call`-hatch arg that may be a parsed object, a JSON string, or empty → object | null. */
function parseJSONArg(a) {
    if (a && typeof a === 'object') return a;
    if (typeof a === 'string' && a.trim()) { try { return JSON.parse(a); } catch { /* malformed */ } }
    return null;
}

/** Live kimi ingress state per lane. Entries are tiny and bounded by session count; a
 *  cleared lane's entry just goes quiet (the Go-side cursor is the real memory). */
const kimiWireLanes = new Map();   // laneId -> { state, pending: [], timer, metaSent: {} }

/** Sink a kimi lane's translated batch: normalize each event through the ONE registry and
 *  page it in, then forward any newly-appeared provenance (llm.request model, first
 *  turn.prompt title, cwd…) to the lane — setLaneMeta merges and rebakes the nameplate. */
function flushKimiWireLane(ctx, books, id, lane) {
    lane.timer = null;
    const events = lane.pending;
    lane.pending = [];
    for (const ev of events) {
        if (ev.kind === 'tool') {
            const rec = normalizeToolCall(ev.name, ev.input, ev.response, lane.state.cwd || '');
            if (rec) emitActivity(ctx, books, id, 'kimi', rec);
        } else if (ev.kind === 'message') {
            const rec = normalizeMessage(ev.mtype, ev.text);
            if (rec) emitActivity(ctx, books, id, 'kimi', rec);
        }
    }
    const s = lane.state, meta = {};
    for (const k of ['cwd', 'title', 'model', 'modelAlias', 'provider', 'createdAt', 'firstTs', 'lastTs']) {
        if (s[k] != null && lane.metaSent[k] !== s[k]) { meta[k] = s[k]; lane.metaSent[k] = s[k]; }
    }
    if (Object.keys(meta).length) books.setLaneMeta(id, { harness: 'kimi', ...meta });
}

/**
 * @param {import('../CommandRouter.js').default} router
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
        // simple <id> <type> <action> <target> case. (Live agents arrive via agent.tool instead.)
        const [id, type, action] = args;
        const target = args[3] || '';
        const detail = args[4] || '';
        const result = args[5] || '';
        // Optional structured per-tool details (lines read/written, +/−, tokens…). The `call`
        // hatch coerces non-string args to strings, so meta rides as a JSON STRING; accept
        // that or a direct object. A bare typed line just omits it.
        const meta = parseJSONArg(args[6]);
        const label = emitActivity(ctx, books, id, type, { action, target, detail, result, meta });
        const echo = [label, detail, result].filter(Boolean).join('  ');
        return {
            text: `OK: ${id} ${action}${echo ? ' ' + echo : ''}`,
            data: { id, action, target: label, detail, result },
        };
    }, { description: "Agent acted — page a sheet into its book", usage: '<id> <type> <action> [target] [detail] [result]' });

    router.register('agent.tool', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        if (args.length < 3) {
            return { text: 'ERR: usage: agent.tool <id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]', data: null };
        }
        // The RAW tool event — both the live Go hook and the replay forward it here and let the
        // ONE tool registry derive action/target/detail/result/meta. input/response ride as JSON
        // strings (the `call` hatch String-coerces objects), parsed back here.
        const [id, type, name] = args;
        const input = parseJSONArg(args[3]) || {};
        const response = parseJSONArg(args[4]);
        const cwd = typeof args[5] === 'string' ? args[5] : '';
        const rec = normalizeToolCall(name, input, response, cwd);
        if (!rec) return { text: `OK: ${name} dropped (noise)`, data: { dropped: name } };   // TodoWrite/ToolSearch/…
        const label = emitActivity(ctx, books, id, type, rec);
        return {
            text: `OK: ${id} ${rec.action}${label ? ' ' + label : ''}`,
            data: { id, action: rec.action, target: label, detail: rec.detail },
        };
    }, { description: 'Agent tool call (raw event) — normalized via the tool registry, then paged in', usage: '<id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]' });

    router.register('agent.message', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        if (args.length < 4) {
            return { text: 'ERR: usage: agent.message <id> <type> <kind> <text>', data: null };
        }
        // A conversation turn — the agent's prose, not a tool call. The hook reads
        // `text`/`thinking` blocks off the transcript and forwards them here (same
        // pure-transport contract as agent.tool): the ONE registry maps kind→action
        // (say/think). text rides the `call` hatch so its newlines/quotes survive the
        // tokenizer. A whitespace-only block drops (normalizeMessage → null).
        const [id, type, kind] = args;
        const text = typeof args[3] === 'string' ? args[3] : String(args[3] ?? '');
        const rec = normalizeMessage(kind, text);
        if (!rec) return { text: `OK: ${kind} dropped (empty)`, data: { dropped: kind } };
        emitActivity(ctx, books, id, type, rec);
        return {
            text: `OK: ${id} ${rec.action}`,
            data: { id, action: rec.action },
        };
    }, { description: 'Agent conversation turn (text/thinking) → a say/think sheet in its book', usage: '<id> <type> <kind> <text>' });

    router.register('agent.meta', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        if (args.length < 2) return { text: 'ERR: usage: agent.meta <id> <json>', data: null };
        // Provenance push from the Go hook (claude) — slug/title/model/cwd/gitBranch, sent
        // once per session on the first transcript flush. Merges onto the lane and rebakes
        // its nameplate. The lane may not exist yet (meta can beat the first tool event).
        const [id] = args;
        const meta = parseJSONArg(args[1]);
        if (!meta) return { text: 'ERR: agent.meta needs a JSON object', data: null };
        books.ensure(id, typeof meta.harness === 'string' ? meta.harness : 'agent');
        const ok = books.setLaneMeta(id, meta);
        return ok
            ? { text: `OK: ${id} meta`, data: { id, meta } }
            : { text: `ERR: no agent '${id}'`, data: null };
    }, { description: 'Agent provenance metadata (slug/title/model/cwd/…) → lane + nameplate', usage: '<id> <json>' });

    router.register('agent.kimi-wire', (args, ctx) => {
        const books = ctx.agentBooks;
        if (!books) return noBooks;
        if (args.length < 2) return { text: 'ERR: usage: agent.kimi-wire <id> <b64line>', data: null };
        // Live kimi ingress: the Go hook (--kimi) tails the session's wire.jsonl on each
        // harness poke and ships RAW lines here — the ONE dialect implementation
        // (kimiWireLineToEvents, shared with the archive parse) translates them, so live
        // and archive can never drift. The lane id was derived Go-side (lockstep mirror
        // of kimiAgentIdForSession); the lane is ensured with the kimi type.
        const [id, b64] = args;
        let obj;
        try { obj = JSON.parse(decodeBase64(b64)); }
        catch { return { text: 'OK: wire line dropped (malformed)', data: null }; }
        books.ensure(id, 'kimi');
        let lane = kimiWireLanes.get(id);
        if (!lane) {
            lane = { state: createKimiWireState(), pending: [], timer: null, metaSent: {} };
            kimiWireLanes.set(id, lane);
        }
        lane.pending.push(...kimiWireLineToEvents(obj, lane.state));
        // Sink on a 0ms debounce: a tool.call emits with response null and its tool.result
        // (a later line in the SAME poke's flush) fills it in place — translating the whole
        // batch before normalizing means live sheets carry the responses the archive would.
        if (!lane.timer) lane.timer = setTimeout(() => flushKimiWireLane(ctx, books, id, lane), 0);
        return { text: `OK: ${id} wire`, data: { id } };
    }, { description: 'One raw kimi wire.jsonl line → shared dialect → tool/message events (live kimi ingress)', usage: '<id> <b64line>' });

    router.register('agent.sessions', async (_args, ctx) => {
        const provider = ctx.sessionProvider;
        if (!provider) return { text: 'ERR: no session provider (the archive is a relay feature)', data: null };
        let sessions;
        try { sessions = await provider.list(); }
        catch (e) { return { text: `ERR: archive list failed — ${e?.message || e}`, data: null }; }
        const open = new Set([...(ctx.agentBooks?.lanes.keys() ?? [])]);
        const rows = sessions.map((s) => {
            const isOpen = open.has(agentIdForEntry(s));
            const tag = s.harness === 'kimi' ? 'kimi   ' : '';
            return `${s.id.replace(/-/g, '').slice(0, 8)}  ${tag}${fmtAge(s.mtime).padStart(4)}  ${fmtSize(s.size).padStart(6)}${isOpen ? '  · open' : ''}`;
        });
        return {
            text: `ARCHIVE (${sessions.length} session${sessions.length === 1 ? '' : 's'})\n` + (rows.length ? rows.join('\n') : '(none)'),
            data: { sessions: sessions.map((s) => ({ id: s.id, mtime: s.mtime, size: s.size, harness: s.harness || 'claude', open: open.has(agentIdForEntry(s)) })) },
        };
    }, { description: 'List the stored agent session records (the archive)', returns: '{ sessions:[{id,mtime,size,open}] }' });

    router.register('agent.open', async (args, ctx) => {
        const provider = ctx.sessionProvider;
        if (!provider) return { text: 'ERR: no session provider (the archive is a relay feature)', data: null };
        if (!ctx.agentBooks) return noBooks;
        const [idArg, limitArg] = args;
        if (!idArg) return { text: 'ERR: usage: agent.open <sessionId|prefix> [limit]', data: null };
        try {
            const entry = await resolveSessionEntry(provider, idArg);
            const limit = limitArg != null ? Number(limitArg) : undefined;
            const r = await openAgentSession(ctx, entry.id, { limit, harness: entry.harness });
            const capped = r.added < r.total ? ` (of ${r.total} — tail)` : '';
            return {
                text: `OK: opened ${entry.id.slice(0, 8)} as ${r.agentId} — ${r.added} sheet${r.added === 1 ? '' : 's'}${capped}`,
                data: { sessionId: entry.id, harness: entry.harness || 'claude', ...r },
            };
        } catch (e) {
            return { text: `ERR: ${e?.message || e}`, data: null };
        }
    }, { description: 'Open a stored session as an agent book (hydrates via the adapter; a live stream converges). limit = turns to keep (0 = all) — sets the book\'s cap', usage: '<sessionId|prefix> [limit]' });

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
    }, { description: "Remove an agent's book, or all/done ('done' books persist until cleared)", usage: '<id|all|done>' });

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
