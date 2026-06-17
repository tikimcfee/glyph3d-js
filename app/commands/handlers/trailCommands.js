/**
 * Agent-trail commands — the addressable surface over AgentTrail.
 *
 * The trail builds itself from FieldVisitorManager.onActivity (every agent.activity
 * record drops a card receding into depth, with the file it touched on a parallel
 * rail, tethered). These verbs are for driving/tuning it by hand:
 *
 *   trail.clear  [agentId|all]   wipe a corridor (or all) — reset between tests
 *   trail.focus  [agentId]       point the camera at a corridor
 *   trail.config [key value]     get/set a layout constant (applies to new cards)
 *
 * To populate a trail without a live agent, drive the existing verb, e.g.:
 *   agent.activity dev claude read app/main.jsx
 *   agent.activity dev claude bash "npm test" "" "5 passing"
 */

const noTrail = { text: 'ERR: agent trail not wired', data: null };

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerTrailCommands(router) {
    router.register('trail.clear', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        const which = args[0] || 'all';
        t.clear(which);
        return { text: `OK: trail cleared (${which})`, data: { cleared: which } };
    }, { description: 'Clear an agent-trail corridor (or all)', usage: '[agentId|all]' });

    router.register('trail.focus', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        const ok = t.focus(args[0]);
        return ok
            ? { text: `OK: framed trail${args[0] ? ' ' + args[0] : ''}`, data: null }
            : { text: 'ERR: no trail to frame', data: null };
    }, { description: 'Point the camera at an agent corridor', usage: '[agentId]' });

    router.register('trail.config', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        if (args.length < 2) return { text: `trail cfg: ${JSON.stringify(t.cfg)}`, data: t.cfg };
        const [key, val] = args;
        const n = Number(val);
        t.cfg[key] = Number.isFinite(n) ? n : val;
        return { text: `OK: trail.${key} = ${t.cfg[key]} (applies to new cards)`, data: { [key]: t.cfg[key] } };
    }, { description: 'Get or set a trail layout constant (applies to new cards)', usage: '[key value]' });
}
