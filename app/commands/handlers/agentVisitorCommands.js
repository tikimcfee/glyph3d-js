/**
 * Agent field-visitor commands — the addressable surface over FieldVisitorManager.
 *
 * Each agent is a self-driving "field visitor" you can address by id. The Claude Code
 * hook drives these automatically via `agent.tool` (the raw tool event → the shared tool
 * registry), but they're plain commands first: you can spawn, move, and follow visitors
 * by typing them, which is how this whole spine is verified.
 *
 *   agent.tool     <id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]  raw tool event → normalized record
 *   agent.message  <id> <type> <kind> <text>         a conversation block (text/thinking) → say/think moment
 *   agent.activity <id> <type> <action> [target] [detail] [result]   the normalized record directly (manual/CLI/tests)
 *       (detail/result/text with spaces ride the `call` base64 hatch)
 *   agent.state    <id> <active|idle|stalled|done>  set lifecycle state
 *   agent.stop     <id>                             mark finished ('done' — PERSISTS)
 *   agent.clear    <id|all|done>                    remove visitor(s) from the field
 *   agent.request  <id> [message...]                raise a hand ("follow me!")
 *   camera.follow  <id>                             ride a visitor (opt-in)
 *   camera.free                                     release the camera (free flight)
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';
import { normalizeToolCall, normalizeMessage } from '@glyph3d/core/collections/toolRegistry.js';

const noMgr = { text: 'ERR: visitor manager not wired', data: null };

/** Resolve a record's target to a live grid (if any), then push the record to the visitor manager.
 *  The shared sink for BOTH the manual `agent.activity` verb and the raw `agent.tool` ingress. */
function emitActivity(ctx, mgr, id, type, { action, target, detail, result, meta }) {
    let targetGrid = null;
    let label = target || null;
    if (target) {
        const r = resolveGridByIdOrIndex(ctx, target, 'grid', { byName: true });
        if (!r.error) { targetGrid = r.grid; label = r.registryId || target; }
    }
    mgr.activity(id, type, { action, target: label, detail, result, meta, targetGrid });
    return label;
}

/** A `call`-hatch arg that may be a parsed object, a JSON string, or empty → object | null. */
function parseJSONArg(a) {
    if (a && typeof a === 'object') return a;
    if (typeof a === 'string' && a.trim()) { try { return JSON.parse(a); } catch { /* malformed */ } }
    return null;
}

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerAgentVisitorCommands(router) {
    router.register('agent.activity', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
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
        // Optional structured per-tool details (lines read/written, +/−, tokens…). The `call` hatch
        // coerces non-string args to strings, so meta rides as a JSON STRING; accept that or a
        // direct object. A bare typed line just omits it.
        let meta = null;
        const m6 = args[6];
        if (m6 && typeof m6 === 'object') meta = m6;
        else if (typeof m6 === 'string' && m6.trim()) { try { meta = JSON.parse(m6); } catch { /* ignore malformed */ } }
        const label = emitActivity(ctx, mgr, id, type, { action, target, detail, result, meta });
        const echo = [label, detail, result].filter(Boolean).join('  ');
        return {
            text: `OK: ${id} ${action}${echo ? ' ' + echo : ''}`,
            data: { id, action, target: label, detail, result },
        };
    }, { description: 'Agent acted — spawn/move its field visitor', usage: '<id> <type> <action> [target] [detail] [result]' });

    router.register('agent.tool', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        if (args.length < 3) {
            return { text: 'ERR: usage: agent.tool <id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]', data: null };
        }
        // The RAW tool event — both the live Go hook and the replay forward it here and let the ONE
        // tool registry derive action/target/detail/result/meta. input/response ride as JSON strings
        // (the `call` hatch String-coerces objects — see systemCommands `call`), parsed back here.
        const [id, type, name] = args;
        const input = parseJSONArg(args[3]) || {};
        const response = parseJSONArg(args[4]);
        const cwd = typeof args[5] === 'string' ? args[5] : '';
        const rec = normalizeToolCall(name, input, response, cwd);
        if (!rec) return { text: `OK: ${name} dropped (noise)`, data: { dropped: name } };   // TodoWrite/ToolSearch/…
        const label = emitActivity(ctx, mgr, id, type, rec);
        return {
            text: `OK: ${id} ${rec.action}${label ? ' ' + label : ''}`,
            data: { id, action: rec.action, target: label, detail: rec.detail },
        };
    }, { description: 'Agent tool call (raw event) — normalized via the tool registry, then logged', usage: '<id> <type> <ToolName> [inputJSON] [responseJSON] [cwd]' });

    router.register('agent.message', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        if (args.length < 4) {
            return { text: 'ERR: usage: agent.message <id> <type> <kind> <text>', data: null };
        }
        // A conversation turn — the agent's prose, not a tool call. The hook reads `text`/`thinking`
        // blocks off the transcript and forwards them here (same pure-transport contract as agent.tool):
        // the ONE registry maps kind→action (say/think) + gist/full. text rides the `call` hatch so its
        // newlines/quotes survive the tokenizer. A whitespace-only block drops (normalizeMessage → null).
        const [id, type, kind] = args;
        const text = typeof args[3] === 'string' ? args[3] : String(args[3] ?? '');
        const rec = normalizeMessage(kind, text);
        if (!rec) return { text: `OK: ${kind} dropped (empty)`, data: { dropped: kind } };
        emitActivity(ctx, mgr, id, type, rec);
        return {
            text: `OK: ${id} ${rec.action}${rec.detail ? ' ' + rec.detail : ''}`,
            data: { id, action: rec.action, detail: rec.detail },
        };
    }, { description: 'Agent conversation turn (text/thinking) → a say/think moment in the trail', usage: '<id> <type> <kind> <text>' });

    router.register('agent.spawn', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        const [id, type] = args;
        if (!id) return { text: 'ERR: usage: agent.spawn <id> [type]', data: null };
        mgr.ensure(id, type || 'agent');
        return { text: `OK: summoned ${id}`, data: { id, type: type || 'agent' } };
    }, { description: 'Summon a field visitor with no activity yet (request an instance)', usage: '<id> [type]' });

    router.register('agent.state', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        const [id, state] = args;
        if (!id || !state) return { text: 'ERR: usage: agent.state <id> <active|idle|stalled|done>', data: null };
        mgr.state(id, state);
        return { text: `OK: ${id} -> ${state}`, data: { id, state } };
    }, { description: 'Set a field visitor lifecycle state', usage: '<id> <state>' });

    router.register('agent.stop', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        const [id] = args;
        if (!id) return { text: 'ERR: usage: agent.stop <id>', data: null };
        mgr.stop(id);
        return { text: `OK: ${id} finished`, data: { id } };
    }, { description: "Mark an agent finished ('done') — its visitor persists until cleared", usage: '<id>' });

    router.register('agent.clear', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        const [target] = args;
        if (!target) return { text: 'ERR: usage: agent.clear <id|all|done>', data: null };
        if (target === 'all' || target === 'done') {
            const n = mgr.clear(target);
            return { text: `OK: cleared ${n} visitor${n === 1 ? '' : 's'}`, data: { cleared: n } };
        }
        const ok = mgr.remove(target);
        return ok
            ? { text: `OK: cleared ${target}`, data: { id: target } }
            : { text: `ERR: no visitor '${target}'`, data: null };
    }, { description: "Remove a field visitor, or all/done ('done' agents persist until cleared)", usage: '<id|all|done>' });

    router.register('agent.request', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        const [id] = args;
        if (!id) return { text: 'ERR: usage: agent.request <id> [message...]', data: null };
        const msg = args.slice(1).join(' ') || 'needs you';
        mgr.request(id, msg);
        return { text: `OK: ${id} raised a hand: "${msg}"`, data: { id, msg } };
    }, { description: 'Agent raises a hand ("follow me!") for input/advice', usage: '<id> [message]' });

    router.register('camera.follow', (args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        const [id] = args;
        if (!id) return { text: 'ERR: usage: camera.follow <agentId>', data: null };
        const following = mgr.follow(id);
        return following
            ? { text: `OK: camera now riding ${id}`, data: { following } }
            : { text: `ERR: no visitor '${id}'`, data: null };
    }, { description: 'Ride a field visitor with the camera (opt-in)', usage: '<agentId>' });

    router.register('camera.free', (_args, ctx) => {
        const mgr = ctx.visitorManager;
        if (!mgr) return noMgr;
        mgr.free();
        return { text: 'OK: camera free', data: null };
    }, { description: 'Release the camera from agent-follow (free flight)' });
}
