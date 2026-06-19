/**
 * Agent field-visitor commands — the addressable surface over FieldVisitorManager.
 *
 * Each agent is a self-driving "field visitor" you can address by id. The Claude
 * Code hook will drive these automatically (replacing the old singular camera.focus
 * spam), but they're plain commands first: you can spawn, move, and follow visitors
 * by typing them, which is how this whole spine is verified before the hook is wired.
 *
 *   agent.activity <id> <type> <action> [target] [detail] [result]   spawn/move + log
 *       (detail/result with spaces ride the `call` base64 hatch — see cli/hook.go)
 *   agent.state    <id> <active|idle|stalled|done>  set lifecycle state
 *   agent.stop     <id>                             mark finished ('done' — PERSISTS)
 *   agent.clear    <id|all|done>                    remove visitor(s) from the field
 *   agent.request  <id> [message...]                raise a hand ("follow me!")
 *   camera.follow  <id>                             ride a visitor (opt-in)
 *   camera.free                                     release the camera (free flight)
 */

import { resolveGridByIdOrIndex } from './spatialHelpers.js';

const noMgr = { text: 'ERR: visitor manager not wired', data: null };

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
        // simple <id> <type> <action> <target> case. See cli/hook.go sendActivity.
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
        let targetGrid = null;
        let label = target || null;
        if (target) {
            const r = resolveGridByIdOrIndex(ctx, target, 'grid', { byName: true });
            if (!r.error) { targetGrid = r.grid; label = r.registryId || target; }
        }
        mgr.activity(id, type, { action, target: label, detail, result, meta, targetGrid });
        const echo = [label, detail, result].filter(Boolean).join('  ');
        return {
            text: `OK: ${id} ${action}${echo ? ' ' + echo : ''}`,
            data: { id, action, target: label, detail, result },
        };
    }, { description: 'Agent acted — spawn/move its field visitor', usage: '<id> <type> <action> [target] [detail] [result]' });

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
