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
 * The ROLODEX CAROUSEL drives a corridor like a drawer of sheets: each corridor keeps its
 * own HEAD (the moment at the front slot), live-following the newest until you scrub it back.
 * Paging just moves that head and the cards ease to their slots — the camera is never touched
 * (use trail.focus to deliberately look at a corridor). The agentId is optional (first corridor):
 *
 *   trail.scroll [agentId] <delta>                  move the head by ±N moments (− older / + newer)
 *   trail.page   [agentId] <next|prev|first|last|N> move the head to a neighbour / end / index
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

    router.register('trail.move', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        if (args.length < 4) return { text: 'ERR: usage: trail.move <id> <x> <y> <z>', data: null };
        const [id, x, y, z] = args;
        const ok = t.moveGroup?.(id, Number(x) || 0, Number(y) || 0, Number(z) || 0);
        return ok
            ? { text: `OK: moved ${id}`, data: { id, x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 } }
            : { text: `ERR: no trail group '${id}'`, data: null };
    }, { description: 'Reposition (pin) an agent corridor — drag-release / CLI', usage: '<id> <x> <y> <z>' });

    // A page-arg keyword/index, optionally preceded by an agentId. One trailing arg → default corridor.
    const splitTarget = (args) => (args.length >= 2 ? [args[0], args[1]] : [undefined, args[0]]);
    const fmtHead = (s) => (s ? `moment ${s.head + 1}/${s.count}${s.following ? ' · live' : ''}` : '');

    router.register('trail.scroll', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        const [id, delta] = splitTarget(args);
        const ok = t.scroll?.(id, Number(delta) || 0);
        const s = ok ? t.headState?.(id) : null;
        return ok
            ? { text: `OK: ${fmtHead(s)}`, data: s }
            : { text: 'ERR: no corridor to scroll', data: null };
    }, { description: 'Move a corridor head by ±N moments (− older / + newer)', usage: '[agentId] <delta>' });

    router.register('trail.page', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        const [id, arg] = splitTarget(args);
        const s0 = t.headState?.(id);
        if (!s0) return { text: 'ERR: no corridor to page', data: null };
        const a = String(arg ?? '').toLowerCase();
        // next/prev step ±1 in time; first/last jump to the ends; a bare number is a 1-based index.
        const ok = a === 'next' ? t.scroll(s0.agentId, +1)
                 : a === 'prev' ? t.scroll(s0.agentId, -1)
                 : a === 'first' ? t.pageTo(s0.agentId, 0)
                 : a === 'last' ? t.pageTo(s0.agentId, s0.count - 1)
                 : t.pageTo(s0.agentId, (Number(a) || 1) - 1);
        const s = t.headState?.(s0.agentId);
        return ok
            ? { text: `OK: ${fmtHead(s)}`, data: s }
            : { text: 'ERR: could not page', data: null };
    }, { description: 'Move a corridor head — next|prev|first|last or a 1-based index', usage: '[agentId] <next|prev|first|last|N>' });

    router.register('trail.config', (args, ctx) => {
        const t = ctx.agentTrail;
        if (!t) return noTrail;
        if (args.length < 2) return { text: `trail cfg: ${JSON.stringify(t.cfg)}`, data: t.cfg };
        const [key, val] = args;
        const n = Number(val);
        // booleans first ("false" is a truthy string and Number("false") is NaN),
        // then numbers, else the raw string.
        t.cfg[key] = (val === 'true' || val === 'false') ? (val === 'true')
                   : Number.isFinite(n) ? n : val;
        (t.applyScales || t._relayout)?.call(t);   // re-scale live (header/info) + re-flow the trail
        return { text: `OK: trail.${key} = ${t.cfg[key]} (re-flowed)`, data: { [key]: t.cfg[key] } };
    }, { description: 'Get or set a trail layout constant — re-flows the trail live', usage: '[key value]' });
}
