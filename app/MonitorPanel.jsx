import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * MonitorPanel — where the memory went, and the levers to get it back.
 *
 * One-way state→view (the HUD discipline): it polls `monitor.stats` and fires
 * `monitor.reset` — it computes no numbers of its own and owns no cache behavior.
 * Every figure on screen comes from the verb, so the CLI (`glyph3d-cli
 * monitor.stats`) and this panel can never disagree.
 *
 * The organizing idea is that each row is a TRADE, not a statistic:
 *
 *   glyph atlas    space (texture VRAM)  ← bought with → encode compute
 *   byte arena     space (GPU buffer)    ← bought with → one shared pipeline
 *   slug cache     space (IndexedDB)     ← bought with → boot time
 *   worker pool    space (per-core heap) ← bought with → parse throughput
 *
 * Which trade is right differs per machine, which is why nothing here is a
 * recommendation — it reports what THIS device is spending and lets you reset.
 *
 * Polling: 2s while the panel is visible, paused when the document is hidden.
 * A monitor that keeps measuring in a background tab is itself a cost, and the
 * IndexedDB stat in monitor.stats is a real round-trip.
 */

const S = {
    content: {
        width: '100%', height: '100%',
        background: 'rgba(8,10,14,0.92)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace',
        color: '#c8ccd6',
    },
    header: {
        padding: '8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
        letterSpacing: '0.04em', flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 8,
    },
    title: { flex: '1 1 auto' },
    body: { flex: '1 1 auto', overflowY: 'auto', padding: '4px 0 12px' },
    section: { padding: '10px 10px 4px', color: '#7c8596', letterSpacing: '0.06em', fontSize: 11 },
    row: {
        display: 'flex', alignItems: 'baseline', gap: 8,
        padding: '2px 10px', whiteSpace: 'nowrap',
    },
    key: { flex: '0 0 116px', color: '#8b93a4', overflow: 'hidden', textOverflow: 'ellipsis' },
    val: { flex: '1 1 auto', color: '#d6dae4', overflow: 'hidden', textOverflow: 'ellipsis' },
    note: { color: '#5f6878', fontSize: 11 },
    btn: {
        background: '#161a22', border: '1px solid #262c38', color: '#9aa3b4',
        borderRadius: 3, padding: '2px 7px', cursor: 'pointer', font: 'inherit', fontSize: 11,
    },
    barTrack: {
        flex: '1 1 auto', height: 6, background: '#141821',
        borderRadius: 3, overflow: 'hidden', minWidth: 40,
    },
    err: { padding: '8px 10px', color: '#d98b7a' },
};

/** A filled proportion bar. Only drawn when BOTH numbers are real — a bar with an
 *  assumed denominator is a lie that looks like a measurement. */
function Bar({ used, total }) {
    if (used == null || !(total > 0)) return null;
    const pct = Math.max(0, Math.min(1, used / total));
    const hue = pct > 0.85 ? '#c2705d' : pct > 0.6 ? '#c2a25d' : '#5d8ec2';
    return (
        <div style={S.barTrack} title={`${(pct * 100).toFixed(1)}%`}>
            <div style={{ width: `${pct * 100}%`, height: '100%', background: hue }} />
        </div>
    );
}

function Row({ k, children }) {
    return (
        <div style={S.row}>
            <span style={S.key}>{k}</span>
            <span style={S.val}>{children}</span>
        </div>
    );
}

const KB = 1024, MB = 1024 * 1024;
/** Mirrors monitor.stats's formatter: null renders as an em dash, never as 0 B. */
function fmtBytes(b) {
    if (b == null || Number.isNaN(b)) return '—';
    if (b < KB) return `${b} B`;
    if (b < MB) return `${(b / KB).toFixed(1)} KB`;
    return `${(b / MB).toFixed(1)} MB`;
}

export default function MonitorPanel({ client }) {
    const [stats, setStats] = useState(null);
    const [err, setErr] = useState(null);
    const [busy, setBusy] = useState(null);
    const [flash, setFlash] = useState(null);
    const aliveRef = useRef(true);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);

    const refresh = useCallback(async () => {
        try {
            const res = await exec(['monitor.stats']);
            if (!aliveRef.current) return;
            if (res?.data) { setStats(res.data); setErr(null); }
            else setErr(res?.text || 'monitor.stats returned no data');
        } catch (e) {
            if (aliveRef.current) setErr(e?.message || String(e));
        }
    }, [exec]);

    useEffect(() => {
        aliveRef.current = true;
        refresh();
        let timer = null;
        const tick = () => {
            // Skip the round-trip while hidden; resume on the next visible tick.
            if (typeof document === 'undefined' || !document.hidden) refresh();
        };
        timer = setInterval(tick, 2000);
        return () => { aliveRef.current = false; clearInterval(timer); };
    }, [refresh]);

    const reset = useCallback(async (target, label) => {
        setBusy(target);
        try {
            const res = await exec(['monitor.reset', target]);
            setFlash(res?.text?.replace(/^OK:\s*/, '') || `${label} reset`);
            setTimeout(() => aliveRef.current && setFlash(null), 6000);
            await refresh();
        } catch (e) {
            setFlash(`failed: ${e?.message || e}`);
        } finally {
            if (aliveRef.current) setBusy(null);
        }
    }, [exec, refresh]);

    const s = stats;
    const heap = s?.heap, gpu = s?.gpu, atlas = s?.atlas, arena = s?.arena;
    const workers = s?.workers, scene = s?.scene, slug = s?.caches?.slugCore;

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>MONITOR</span>
                <button style={S.btn} onClick={refresh} title="Re-read now">↻</button>
            </div>

            {err && <div style={S.err}>{err}</div>}
            {flash && <div style={{ ...S.row, color: '#7fae86', whiteSpace: 'normal' }}>{flash}</div>}

            <div style={S.body}>
                <div style={S.section}>MEMORY</div>
                <Row k="js heap">
                    {heap?.available
                        ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {fmtBytes(heap.used)} / {fmtBytes(heap.limit)}
                            <Bar used={heap.used} total={heap.limit} />
                          </span>
                        : <span style={S.note}>not exposed by this browser</span>}
                </Row>
                <Row k="canvas">
                    {gpu?.backing
                        ? `${gpu.backing.width}x${gpu.backing.height} @dpr ${gpu.backing.pixelRatio} · ~${fmtBytes(gpu.backingBytesEstimate)}`
                        : '—'}
                </Row>
                <Row k="three objects">
                    {gpu ? `${gpu.geometries ?? '—'} geometries · ${gpu.textures ?? '—'} textures` : '—'}
                </Row>

                <div style={S.section}>GLYPH PIPELINE</div>
                <Row k="atlas">
                    {atlas?.ready
                        ? `${atlas.encodedGlyphs} glyphs · v${atlas.version} · ~${fmtBytes(atlas.textureBytes)}`
                        : <span style={S.note}>not ready</span>}
                </Row>
                {atlas?.ready && (
                    <Row k="textures">
                        <span style={S.note}>
                            curve {atlas.curveTexture ?? '—'} · glyphmap {atlas.glyphMapTexture ?? '—'}
                        </span>
                    </Row>
                )}
                <Row k="arena items">
                    {arena?.ready
                        ? `${arena.liveItems} live / ${arena.stagedItems} staged${arena.deadItems ? ` (${arena.deadItems} dead)` : ''}`
                        : <span style={S.note}>not ready</span>}
                </Row>
                {arena?.ready && (
                    <>
                        <Row k="arena bytes">
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {fmtBytes(arena.watermarkBytes)} / {fmtBytes(arena.capacityBytes)}
                                <Bar used={arena.watermarkBytes} total={arena.capacityBytes} />
                            </span>
                        </Row>
                        {/* The multiplier is the point: a slot is 44 B of GPU buffer per
                            source byte, so 1 MB of source is ~44 MB of VRAM. */}
                        <Row k="arena gpu">
                            ~{fmtBytes(arena.bufferBytesEstimate)}{' '}
                            <span style={S.note}>({arena.bytesPerSlot} B/byte)</span>
                        </Row>
                    </>
                )}
                <Row k="workers">
                    {workers
                        ? (workers.spawned
                            ? `${workers.workers} spawned · ${workers.hardwareConcurrency ?? '—'} cores`
                            : <span style={S.note}>pool not built · {workers.hardwareConcurrency ?? '—'} cores</span>)
                        : '—'}
                </Row>

                <div style={S.section}>CACHES</div>
                <Row k="slug core">
                    {slug?.available
                        ? `${slug.entries} entr${slug.entries === 1 ? 'y' : 'ies'} · ${fmtBytes(slug.bytes)}`
                        : <span style={S.note}>unavailable{slug?.error ? ` (${slug.error})` : ''}</span>}
                </Row>
                {slug?.last && (
                    <Row k="last op">
                        <span style={S.note}>
                            {slug.last.op}
                            {slug.last.ms != null ? ` · ${slug.last.ms.toFixed(0)}ms` : ''}
                            {slug.last.glyphs != null ? ` · ${slug.last.glyphs} glyphs` : ''}
                        </span>
                    </Row>
                )}
                <div style={{ ...S.row, gap: 6, paddingTop: 6 }}>
                    <span style={S.key} />
                    <button
                        style={{ ...S.btn, opacity: busy === 'slug-cache' ? 0.5 : 1 }}
                        disabled={busy === 'slug-cache' || !slug?.available}
                        onClick={() => reset('slug-cache', 'slug cache')}
                        title="Clear the slug-core prebake. Re-encodes and re-caches on next reload."
                    >
                        {busy === 'slug-cache' ? 'clearing…' : 'clear + rebuild'}
                    </button>
                    <button
                        style={S.btn}
                        disabled={busy === 'renderer-info'}
                        onClick={() => reset('renderer-info', 'frame counters')}
                        title="Zero three's cumulative frame counters so the next reading is attributable."
                    >
                        zero counters
                    </button>
                </div>

                <div style={S.section}>SCENE</div>
                <Row k="objects">{scene?.ready ? scene.total : '—'}</Row>
                {scene?.ready && Object.entries(scene.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
                    <Row k={t} key={t}><span style={S.note}>{n}</span></Row>
                ))}
            </div>
        </div>
    );
}
