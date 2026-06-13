import React, { useCallback, useEffect, useState } from 'react';

/**
 * FieldVisitorsPanel — the crew roster. The list view onto the same
 * FieldVisitorManager the in-world HUD reads: one row per agent, with live state,
 * its raised hand ("follow me!"), and per-row controls that fire the same command
 * bus the spatial visitors respond to. Spatial view + list view, one source of truth.
 *
 *   + summon          → agent.spawn   (request an instance)
 *   clear done        → agent.clear done   (sweep finished visitors off the field)
 *   ✕ (per row)       → agent.clear   (remove this visitor; 'done' ones persist until you do)
 *   ○ follow / ◉      → camera.follow / camera.free  (ride a visitor)
 *
 * House style mirrors FileTree / TerminalsPanel: a `client` prop, subscription-driven
 * state (here, visitorManager.onChange), inline styles, command-bus side effects only.
 */

const STATE_DOT = {
    active:  '#7ad7a0',  // mint — working
    idle:    '#8aa0b8',  // cool grey — between tasks
    stalled: '#e0b54a',  // amber — gone quiet
    done:    '#6a6a72',  // dim — finished (persists until cleared)
};

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
    count: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    summon: { flex: '0 0 auto', cursor: 'pointer', color: '#7c8596', padding: '0 4px', borderRadius: 3 },
    list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
    msg: { padding: '12px', color: '#7c8596' },
    row: (hot) => ({
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        userSelect: 'none',
        borderLeft: `2px solid ${hot ? '#e0b54a' : 'transparent'}`,
        background: hot ? 'rgba(224,181,74,0.07)' : 'transparent',
    }),
    dot: { flex: '0 0 auto', fontSize: 10 },
    body: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.3 },
    who: { color: '#dfe3ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    tag: { color: '#7c8596' },
    sub: { color: '#7c8596', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 },
    hist: { display: 'flex', flexDirection: 'column', minWidth: 0 },
    histLine: (fresh) => ({
        color: fresh ? '#aeb6c4' : '#6b727e',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11,
    }),
    beacon: { color: '#e0b54a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 },
    act: (on) => ({
        flex: '0 0 auto', cursor: 'pointer', padding: '0 5px', borderRadius: 3,
        color: on ? '#7ad7a0' : '#7c8596', whiteSpace: 'nowrap',
    }),
};

function readRoster(client) {
    const mgr = client?.ctx?.visitorManager;
    return mgr ? mgr.getRoster() : [];
}

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((performance.now() - ts) / 1000));
    return s < 1 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export default function FieldVisitorsPanel({ client }) {
    const [roster, setRoster] = useState(() => readRoster(client));

    // Subscribe to the manager's discrete roster changes; a slow interval keeps the
    // "Xs ago" liveness honest and is a cheap safety net if a change slips by.
    useEffect(() => {
        const mgr = client?.ctx?.visitorManager;
        const refresh = () => setRoster(readRoster(client));
        refresh();
        const off = mgr?.onChange?.(refresh);
        const t = setInterval(refresh, 1000);
        return () => { off?.(); clearInterval(t); };
    }, [client]);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);

    const summon = useCallback(() => {
        const id = `visitor-${Math.random().toString(36).slice(2, 6)}`;
        exec(['agent.spawn', id, 'agent']);
    }, [exec]);

    const doneCount = roster.reduce((n, v) => n + (v.state === 'done' ? 1 : 0), 0);

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.count}>Field Visitors ({roster.length})</span>
                {doneCount > 0 && (
                    <span style={S.summon} onClick={() => exec(['agent.clear', 'done'])}
                        title="Clear finished visitors (agent.clear done)">clear done ({doneCount})</span>
                )}
                <span style={S.summon} onClick={summon} title="Summon a visitor (agent.spawn)">+ summon</span>
            </div>
            <div style={S.list}>
                {roster.length === 0 && (
                    <div style={S.msg}>No agents in the field. Activity spawns a visitor; “+ summon” makes one.</div>
                )}
                {roster.map((v) => (
                    <div key={v.id} style={S.row(!!v.beacon)}>
                        <span style={{ ...S.dot, color: STATE_DOT[v.state] || '#8aa0b8' }}>●</span>
                        <span style={S.body}>
                            <span style={S.who}>
                                {v.type}:{v.id}<span style={S.tag}>  [{v.state}] · {ago(v.lastActivityTs)}</span>
                            </span>
                            {v.beacon
                                ? <span style={S.beacon}>✋ {v.beacon}</span>
                                : v.recent && v.recent.length
                                    ? (
                                        <span style={S.hist}>
                                            {v.recent.slice(-3).reverse().map((e, i) => (
                                                <span key={`${e.ts}:${i}`} style={S.histLine(i === 0)} title={e.text}>{e.text}</span>
                                            ))}
                                        </span>
                                    )
                                    : null}
                        </span>
                        <span
                            style={S.act(v.following)}
                            onClick={() => exec(v.following ? 'camera.free' : ['camera.follow', v.id])}
                            title={v.following ? 'Release camera (camera.free)' : 'Ride this visitor (camera.follow)'}
                        >{v.following ? '◉ following' : '○ follow'}</span>
                        <span
                            style={S.act(false)}
                            onClick={() => exec(['agent.clear', v.id])}
                            title="Remove from field (agent.clear)"
                        >✕</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
