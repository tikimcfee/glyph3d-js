/**
 * calib.* commands — the live hand model on the bus. Nothing to start: the model learns from
 * every frame of the followed hand device. These verbs read it, reset it, and manage its warm
 * start; the Hand panel shows `calib.status`.
 *
 *   calib.status                       every quantity per hand (value · weight · drift · state),
 *                                      the device, the live stage vectors
 *   calib.inspect <hand> <part>        one estimate in full (bones|volume|noise|pinch|template|neutral)
 *   calib.reset [hand|all] [part]      re-learn: everything, one hand, or a part (…|device)
 *   calib.save                         write the warm start now (it also saves itself every 10 s)
 *   calib.forget                       drop the warm start and start cold
 *   calib.pin [source|none]            follow one device, or whichever is streaming
 *   calib.view on|off                  the in-scene desk model (phone, hand, measured volume)
 */

const PARTS = ['bones', 'pinch', 'volume', 'noise', 'template', 'neutral'];

/** @param {import('../../client/CommandProvider.jsx').AppContext} ctx */
const calib = (ctx) => ctx.handCalib || null;
const NOT_READY = { text: 'ERR: hand model not ready (no sensor plane)', data: null };

const mark = { settled: '●', settling: '◐', idle: '◌', unknown: '○' };
const fmt = (v) => {
    if (v == null) return '—';
    if (typeof v !== 'object') return String(v);
    if ('x' in v && 'y' in v && 'z' in v && Object.keys(v).length <= 4) return `(${v.x}, ${v.y}, ${v.z})${'rms' in v ? ` rms ${v.rms}` : ''}`;
    return Object.entries(v).map(([k, x]) => `${k} ${fmt(x)}`).join(' · ');
};

/** The status as text: the device, then each hand's quantities with their state. */
function describe(st) {
    const d = st.model.device;
    const src = st.source;
    const lines = [
        `hand model — source ${src.current || 'none'}${src.pinned ? ' (pinned)' : ''}${src.fps ? ` ${src.fps.toFixed(1)} fps` : ''}`
        + `${src.latency ? ` · capture→send ${src.latency.captureToSendMs ?? '—'} ms · lag ${src.latency.arrivalLagMs ?? '—'} ms` : ''}`,
        `device ${d.wire ?? '—'} · mount ${d.mount ?? '—'} · tilt ${d.gravityTiltDeg ?? '—'}° · ceiling ${d.ceiling ?? '—'} m · moved ${d.bumps}×${d.lastBumpCause ? ` (last: ${d.lastBumpCause})` : ''}`,
        st.warmStart ? `warm start saved ${st.warmStart.savedAt}` : 'no warm start saved',
    ];
    const hands = Object.entries(st.model.hands);
    const undecided = st.model.tracks.filter((tr) => !tr.decided);
    if (undecided.length) lines.push(`deciding: ${undecided.map((tr) => `track ${tr.id} (${tr.frames} frames, vote ${tr.vote})`).join(', ')}`);
    if (!hands.length) lines.push('no hand seen yet');
    for (const [h, m] of hands) {
        lines.push(`${h} hand — ${m.frames} frames${m.rate ? ` @ ${m.rate} Hz` : ''}${m.idle ? ` · out of view ${m.idle} s` : ''}`
            + `${m.labelAgreement != null ? ` · Vision's label agrees ${Math.round(m.labelAgreement * 100)}%` : ''}${m.handednessMirrored ? ' (MIRRORED)' : ''}${m.still ? ' · still' : ''}`);
        lines.push(`  ${mark[m.scale.state]} palm length ${fmt(m.scale.value)} m   ${mark[m.handSize.state]} hand ${fmt(m.handSize.value)} m   ${mark[m.bones.state]} bones ${m.bones.settled}/${m.bones.of} settled`);
        lines.push(`  ${mark[m.volume.state]} volume ${m.volume.value ? `reach ${fmt(m.volume.value.reach)} centre ${fmt(m.volume.value.center)}` : '—'}`);
        lines.push(`  ${mark[m.noise.state]} rest noise ${fmt(m.noise.value)}   ${mark[m.pinch.state]} pinch ${fmt(m.pinch.value)}${m.pinch.prior ? ' (prior)' : ''}`);
        lines.push(`  ${mark[m.template.state]} palm template n ${m.template.n} (joint σ ${m.template.sigma.map((x) => (x == null ? '—' : (x * 1000).toFixed(1))).join('/')} mm)   ${mark[m.neutral.state]} neutral pose   ${mark[m.skin.state]} skin ${(m.skin.value * 1000).toFixed(1)} mm${m.skin.state === 'settled' ? '' : ' (prior)'}${m.skin.learned != null ? `, height fit ${(m.skin.learned * 1000).toFixed(1)}` : ''}`);
        const l = st.live[h];
        if (l?.stages) for (const g of l.stages) lines.push(`    ${g.id.padEnd(9)} ${JSON.stringify(g.value)}  v=${JSON.stringify(g.velocity)}`);
        if (l?.pose) lines.push(`    pose yaw ${l.pose.yaw}° pitch ${l.pose.pitch}° roll ${l.pose.roll}°${l.pose.fromNeutral ? '' : ' (absolute — no neutral yet)'}`);
        if (l?.pinch) lines.push(`    pinch ${l.pinch.pinching ? 'ON' : 'off'} d=${l.pinch.normalized ?? '—'}${l.pinch.why ? ` (${l.pinch.why})` : ''} · ${l.estimated} joints estimated`);
        if (l?.stability) {
            const st2 = l.stability;
            lines.push(`    displayed: still jitter p95 ${st2.worstJitterP95Mm ?? '—'} mm worst (joint ${st2.worstJoint ?? '—'}) · lag ${st2.lagP50Ms ?? '—'}/${st2.lagP95Ms ?? '—'} ms p50/p95 · ${st2.measured}/21 joints' noise measured${st2.enabled ? '' : ' · STABILIZER OFF'}`);
        }
        if (l?.fit) lines.push(`    cloud fit ${l.fit.ageMs} ms old (caught up ${l.fit.shiftMm} mm) · ${l.fit.cloud} cloud / ${l.fit.vision} vision / ${l.fit.prior} prior`);
        else if (l) lines.push('    no cloud fit (Vision + ray repair)');
    }
    return lines.join('\n');
}

/**
 * @param {import('../../client/CommandProvider.jsx').AppRouter} router
 */
export default function registerCalibCommands(router) {
    router.register('calib.status', (_args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        // The simulator is the sensor plane's (hand.simulate), reported here so the panel reads one verb.
        const st = { ...c.status(), sim: ctx._handSim ? { mode: ctx._handSim.mode } : null };
        return { text: describe(st), data: st };
    }, {
        description: 'The live hand model: every quantity per hand (value, weight, drift, state), the device, the live stage vectors',
        returns: '{ source, primary, model:{device, hands:{<h>:{scale,handSize,bones,volume,noise,pinch,template,neutral}}}, live, view, warmStart, sim }',
    });

    router.register('calib.inspect', (args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        const [h, part] = args;
        const m = h && c.model.status().hands[h];
        if (!m || !PARTS.includes(part)) {
            return { text: `ERR: usage: calib.inspect <${[...c.model.hands.keys()].join('|') || 'hand'}> <${PARTS.join('|')}>`, data: null };
        }
        return { text: JSON.stringify(m[part], null, 1), data: m[part] };
    }, { description: 'One estimate of the live hand model in full', usage: `<hand> <${PARTS.join('|')}>` });

    router.register('calib.reset', (args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        let [h = null, part = null] = args;
        if (h && (PARTS.includes(h) || h === 'device')) { part = h; h = null; }
        if (h === 'all') h = null;
        if (part && !PARTS.includes(part) && part !== 'device') {
            return { text: `ERR: usage: calib.reset [hand|all] [${PARTS.join('|')}|device]`, data: null };
        }
        c.reset(h, part);
        return { text: `OK: re-learning ${part || 'everything'}${h ? ` for the ${h} hand` : ''}`, data: { hand: h, part } };
    }, { description: 'Re-learn the live hand model: everything, one hand, or one part', usage: `[hand|all] [${PARTS.join('|')}|device]` });

    router.register('calib.save', (_args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        const snap = c.persist();
        const hands = Object.keys(snap.hands);
        return hands.length
            ? { text: `OK: warm start saved (${hands.join(', ')})`, data: snap }
            : { text: 'OK: nothing learned yet — not saved', data: null };
    }, { description: 'Save the live model as the warm start now (it also saves itself every 10 s)' });

    router.register('calib.forget', (_args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        c.forget();
        return { text: 'OK: warm start dropped; the model starts cold', data: null };
    }, { description: 'Drop the saved warm start and start the live hand model cold' });

    router.register('calib.pin', (args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        const id = args[0];
        if (!id) return { text: `OK: ${c.pinned ? `pinned to ${c.pinned}` : 'following whichever device streams'}`, data: { pinned: c.pinned } };
        if (id === 'none') { c.pin(null); return { text: 'OK: following whichever device streams', data: { pinned: null } }; }
        if (!ctx.sourceStream.get(id)) {
            const ids = ctx.sourceStream.list().map((s) => s.id);
            return { text: `ERR: no source '${id}' (attached: ${ids.join(', ') || 'none'})`, data: null };
        }
        c.pin(id);
        return { text: `OK: pinned to ${id}`, data: { pinned: id } };
    }, { description: 'Follow one hand device, or `none` for whichever is streaming', usage: '[source-id|none]' });

    router.register('calib.view', (args, ctx) => {
        const c = calib(ctx);
        if (!c) return NOT_READY;
        if (args[0] !== 'on' && args[0] !== 'off') return { text: 'ERR: usage: calib.view on|off', data: null };
        c.view.setVisible(args[0] === 'on');
        return { text: `OK: hand model view ${args[0]}`, data: { view: args[0] === 'on' } };
    }, { description: 'Show or hide the in-scene desk model (phone, tracked hand, measured volume)', usage: 'on|off' });
}
