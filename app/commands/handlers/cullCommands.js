/**
 * cull.* commands — the occlusion-query culler (OcclusionCuller).
 *
 * Settings ▸ Culling owns the dials (cull.enabled / cull.holdFrames via settings.set);
 * this verb is the observability side: what is tracked, what is dark right now.
 * The loadcurve rig reads it to put NUMBERS on the win.
 */

export default function registerCullCommands(router) {
    router.register('cull.stats', (_args, ctx) => {
        const c = ctx.occlusionCuller;
        if (!c) return { text: 'ERR: occlusion culler not ready', data: null };
        const s = c.stats();
        const names = s.culled.map((id) => String(id).split('/').pop());
        return {
            text: `OK: culling ${s.enabled ? 'ON' : 'off'} — ${s.culled.length}/${s.tracked} dark${names.length ? ` (${names.join(', ')})` : ''}`,
            data: s,
        };
    }, { description: 'Occlusion-culling stats: tracked candidates and who is dark', returns: '{ enabled, tracked, culled:[ids] }' });
}
