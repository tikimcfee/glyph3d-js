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
        const r = ctx.renderer?.info?.render;
        const calls = r ? (r.drawCalls ?? r.calls ?? null) : null;
        return {
            text: `OK: culling ${s.enabled ? 'ON' : 'off'} — ${s.culled.length}/${s.tracked} dark${calls != null ? `, ${calls} draw calls this frame` : ''}`,
            data: { ...s, drawCalls: calls },
        };
    }, { description: 'Occlusion-culling stats: dark/tracked + live draw calls (toggle culling and diff this)', returns: '{ enabled, tracked, culled:[ids], drawCalls }' });
}
