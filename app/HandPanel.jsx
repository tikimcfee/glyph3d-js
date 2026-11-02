import React, { useCallback, useEffect, useRef, useState } from 'react';
import { stateController } from '@glyph3d/core/services/state';
import { PANEL_SEEN_KEY } from './client/HandCalib.js';
/** @import { AppClient } from './client/CommandProvider.jsx' */

/**
 * HandPanel — the live hand model, converging. No steps: the model learns from every frame, and
 * this board shows each quantity as it settles — its value, how many samples it rests on, how
 * much it moved lately, and what is still unknown — then the live motion through the HandSpace
 * stages, the palm pose and the pinch.
 *
 * One-way state→view (the HUD discipline): it polls `calib.status` and issues `calib.*` /
 * `hand.simulate` verbs; every number comes from the verb, so the CLI and this panel never
 * disagree. Polls at 5 Hz while the document is visible — it's watched with a hand in the air.
 */

const S = {
    content: {
        width: '100%', height: '100%', background: 'rgba(8,10,14,0.92)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
    },
    header: {
        padding: '8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
        letterSpacing: '0.04em', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    },
    title: { flex: '1 1 auto' },
    body: { flex: '1 1 auto', overflowY: 'auto', padding: '4px 0 12px' },
    section: { padding: '10px 10px 4px', color: '#7c8596', letterSpacing: '0.06em', fontSize: 11 },
    row: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '1px 10px', whiteSpace: 'nowrap' },
    key: { flex: '0 0 112px', color: '#8b93a4', overflow: 'hidden', textOverflow: 'ellipsis' },
    val: { flex: '1 1 auto', color: '#d6dae4', overflow: 'hidden', textOverflow: 'ellipsis' },
    meta: { flex: '0 0 auto', color: '#5f6878', fontSize: 11 },
    note: { color: '#5f6878', fontSize: 11 },
    btn: {
        background: '#161a22', border: '1px solid #262c38', color: '#9aa3b4',
        borderRadius: 3, padding: '2px 7px', cursor: 'pointer', font: 'inherit', fontSize: 11,
    },
    err: { padding: '8px 10px', color: '#d98b7a' },
};

const DOT = { settled: '#7fae86', settling: '#c2a25d', idle: '#5d7a9a', unknown: '#4a5160' };
const WHY = {
    scale: 'needs the wrist and middle knuckle seen with depth',
    bones: 'needs both ends of each bone seen with depth',
    volume: 'move the hand around the space you use',
    noise: 'pause the hand for a moment',
    pinch: 'pinch thumb and index a few times',
    template: 'hold the hand flat for a moment',
    neutral: 'rest the hand for a moment',
    skin: 'move the hand up and down a few cm',
};

/** A value as text: numbers as-is, vectors as (x, y, z), null as an em dash. */
function fmt(v) {
    if (v == null) return '—';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return `${v.length} items`;
    if (typeof v === 'object') {
        if ('x' in v && 'y' in v && 'z' in v && Object.keys(v).length <= 4) return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})${'rms' in v ? ` rms ${fmt(v.rms)}` : ''}`;
        return Object.entries(v).map(([k, x]) => `${k} ${fmt(x)}`).join(' · ');
    }
    return String(v);
}

const speed = (v) => (v ? Math.hypot(v.x, v.y, v.z).toFixed(3) : '—');

function Row({ k, children, meta }) {
    return (
        <div style={S.row}>
            <span style={S.key}>{k}</span>
            <span style={S.val}>{children}</span>
            {meta != null && <span style={S.meta}>{meta}</span>}
        </div>
    );
}

/** One learned quantity: a state dot, its value, its weight and recent drift. */
function Quantity({ k, q, part, show }) {
    const state = q?.state || 'unknown';
    return (
        <Row
            k={<span><span style={{ color: DOT[state] }}>●</span> {k}</span>}
            meta={state === 'unknown' ? null : `n ${q.n ?? '—'}${q.drift != null ? ` · Δ ${q.drift}` : ''}`}
        >
            {q?.value == null
                ? <span style={S.note}>{WHY[part] || 'unknown'}</span>
                : (show ? show(q.value) : fmt(q.value))}
            {q?.prior ? <span style={S.note}> · prior ({q.why})</span> : null}
        </Row>
    );
}

/** @param {{ client: AppClient | null }} props */
export default function HandPanel({ client }) {
    const [st, setSt] = useState(null);
    const [err, setErr] = useState(null);
    const [flash, setFlash] = useState(null);
    const aliveRef = useRef(true);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);

    const refresh = useCallback(async () => {
        try {
            const res = await exec(['calib.status']);
            if (!aliveRef.current) return;
            if (res?.data) { setSt(res.data); setErr(null); } else setErr(res?.text || 'calib.status returned no data');
        } catch (e) {
            if (aliveRef.current) setErr(e?.message || String(e));
        }
    }, [exec]);

    // Shown once: the first hand device no longer needs to bring it forward.
    useEffect(() => { stateController.set(PANEL_SEEN_KEY, true); }, []);

    useEffect(() => {
        aliveRef.current = true;
        refresh();
        const timer = setInterval(() => {
            if (typeof document === 'undefined' || !document.hidden) refresh();
        }, 200);
        return () => { aliveRef.current = false; clearInterval(timer); };
    }, [refresh]);

    const run = useCallback(async (...cmd) => {
        const res = await exec(cmd);
        setFlash(res?.text?.split('\n')[0] || '');
        setTimeout(() => aliveRef.current && setFlash(null), 5000);
        refresh();
    }, [exec, refresh]);

    const d = st?.model?.device;
    const src = st?.source;
    const hands = Object.entries(st?.model?.hands || {});

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>HAND</span>
                <button style={S.btn} onClick={() => run('calib.view', st?.view ? 'off' : 'on')} title="The in-scene desk model: phone, hand, measured volume">
                    {st?.view ? 'hide desk' : 'show desk'}
                </button>
                <button style={S.btn} onClick={() => run('calib.reset')} title="Re-learn everything from the next frame">re-learn</button>
                <button style={S.btn} onClick={() => run('calib.save')} title="Save the warm start now (it saves itself every 10 s)">save</button>
                <button style={S.btn} onClick={() => run('calib.forget')} title="Drop the saved warm start; start cold">forget</button>
                {st?.sim
                    ? <>
                        <button style={S.btn} onClick={() => run('hand.simulate', 'bump')} title="Move the simulated phone">bump sim</button>
                        <button style={S.btn} onClick={() => run('hand.simulate', 'off')}>stop sim</button>
                    </>
                    : <button style={S.btn} onClick={() => run('hand.simulate', 'on')} title="A simulated hand over a face-down phone, just wandering">simulate</button>}
            </div>

            {err && <div style={S.err}>{err}</div>}
            {flash && <div style={{ ...S.row, color: '#7fae86', whiteSpace: 'normal' }}>{flash}</div>}

            <div style={S.body}>
                <div style={S.section}>DEVICE</div>
                <Row k="source">{src?.current || <span style={S.note}>no hand device — connect the phone, or simulate</span>}{src?.pinned ? ' (pinned)' : ''}</Row>
                {src?.current && <Row k="rate">{src.fps ? `${src.fps.toFixed(1)} fps` : '—'}</Row>}
                {src?.latency && <Row k="latency">capture→send {fmt(src.latency.captureToSendMs)} ms · arrival lag {fmt(src.latency.arrivalLagMs)} ms</Row>}
                {d && <Row k="phone">{d.mount ?? '—'} · tilt {fmt(d.gravityTiltDeg)}° · ceiling {fmt(d.ceiling)} m</Row>}
                {d && <Row k="moved">{d.bumps ? `${d.bumps}× — last: ${d.lastBumpCause}; the volume and neutral re-learn after each` : 'not since the model started'}</Row>}
                <Row k="warm start">
                    {st?.warmStart
                        ? <span>saved {st.warmStart.savedAt} <span style={S.note}>· kept in this browser</span></span>
                        : <span style={S.note}>none yet — saves itself every 10 s, in this browser</span>}
                </Row>

                {st?.model?.tracks?.filter((tr) => !tr.decided).map((tr) => (
                    <Row key={tr.id} k={`track ${tr.id}`}><span style={S.note}>deciding left/right — {tr.frames} frames, vote {tr.vote}</span></Row>
                ))}
                {!hands.length && <><div style={S.section}>HAND</div><Row k="—"><span style={S.note}>no hand seen yet</span></Row></>}
                {hands.map(([h, m]) => {
                    const l = st.live?.[h];
                    return (
                        <React.Fragment key={h}>
                            <div style={S.section}>
                                {h.toUpperCase()} HAND <span style={S.note}>· {m.frames} frames{m.rate ? ` @ ${m.rate} Hz` : ''}{m.idle ? ` · out of view ${m.idle} s` : ''}{m.still ? ' · still' : ''}
                                    {m.labelAgreement != null ? ` · Vision's label agrees ${Math.round(m.labelAgreement * 100)}%` : ''}{m.handednessMirrored ? ' (mirrored from below)' : ''}</span>
                            </div>
                            <Quantity k="palm length" q={m.scale} part="scale" show={(v) => `${v} m`} />
                            <Quantity k="hand length" q={m.handSize} part="bones" show={(v) => `${v} m`} />
                            <Quantity k="bones" q={{ ...m.bones, value: `${m.bones.settled}/${m.bones.of} settled` }} part="bones" show={(v) => v} />
                            <Quantity k="volume" q={m.volume} part="volume" show={(v) => `reach ${fmt(v.reach)} · centre ${fmt(v.center)}`} />
                            <Quantity k="rest noise" q={m.noise} part="noise" />
                            <Quantity k="pinch" q={m.pinch} part="pinch" show={(v) => (v.closed != null ? `closed ${v.closed} · open ${v.open} · on ${v.on} · off ${v.off}` : `on ${v.on} · off ${v.off}`)} />
                            <Quantity k="skin depth" q={m.skin} part="skin" show={(v) => `${(v * 1000).toFixed(1)} mm${m.skin.state === 'settled' ? '' : ' (prior)'}${m.skin.learned != null ? ` · height fit ${(m.skin.learned * 1000).toFixed(1)} mm` : ''}`} />
                            <Quantity k="palm template" q={{ ...m.template, value: m.template.value ? `learned · joint σ ${m.template.sigma.map((x) => (x == null ? '—' : (x * 1000).toFixed(1))).join(' / ')} mm` : null }} part="template" show={(v) => v} />
                            <Quantity k="neutral pose" q={{ ...m.neutral, value: m.neutral.value ? 'learned' : null }} part="neutral" show={(v) => v} />

                            <div style={{ ...S.section, paddingTop: 6 }}>{h.toUpperCase()} · LIVE</div>
                            {l?.stages
                                ? l.stages.map((g) => {
                                    const dd = l.space?.find((x) => x.id === g.id);
                                    return (
                                        <Row key={g.id} k={g.id} meta={`|v| ${speed(g.velocity)}`}>
                                            {fmt(g.value)}{dd && !dd.active ? <span style={S.note}> · pass-through: {dd.why}</span> : null}
                                            {dd?.from ? <span style={S.note}> · {dd.from}</span> : null}
                                        </Row>
                                    );
                                })
                                : <Row k="palm"><span style={S.note}>no palm in view</span></Row>}
                            <Row k="palm pose">
                                {l?.pose
                                    ? <span>yaw {l.pose.yaw}° · pitch {l.pose.pitch}° · roll {l.pose.roll}°{l.pose.fromNeutral ? '' : <span style={S.note}> (absolute — no neutral yet)</span>}</span>
                                    : <span style={S.note}>{WHY.template}</span>}
                            </Row>
                            <Row k="still jitter" meta={l?.stability ? `${l.stability.measured}/21 joints measured` : null}>
                                {l?.stability?.worstJitterP95Mm != null
                                    ? <span style={{ color: l.stability.worstJitterP95Mm <= 0.5 ? '#7fae86' : '#c2a25d' }}>
                                        p95 {l.stability.worstJitterP95Mm} mm worst (joint {l.stability.worstJoint}) <span style={S.note}>· target ≤ 0.5</span></span>
                                    : <span style={S.note}>hold the hand still a moment</span>}
                            </Row>
                            <Row k="lag moving">
                                {l?.stability?.lagP50Ms != null ? `${l.stability.lagP50Ms} ms p50 · ${l.stability.lagP95Ms} ms p95` : <span style={S.note}>move the hand</span>}
                            </Row>
                            <Row k="joints" meta={l?.fit ? `${l.fit.ageMs} ms old` : null}>
                                {l?.fit
                                    ? <span>cloud fit · {l.fit.cloud} cloud / {l.fit.vision} vision / {l.fit.prior} prior <span style={S.note}>· caught up {l.fit.shiftMm} mm</span></span>
                                    : <span style={S.note}>Vision + ray repair (no cloud fit){l ? ` · ${l.estimated} estimated` : ''}</span>}
                            </Row>
                            <Row k="pinch" meta={l ? `${l.estimated} joints estimated` : null}>
                                {l?.pinch
                                    ? <span>{l.pinch.pinching ? 'PINCH' : 'open'} · d {fmt(l.pinch.normalized)}{l.pinch.why ? <span style={S.note}> · {l.pinch.why}</span> : null}</span>
                                    : '—'}
                            </Row>
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
}
