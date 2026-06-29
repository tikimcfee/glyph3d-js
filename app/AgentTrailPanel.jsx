import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * AgentTrailPanel — the moment-stream viewport. A 2D scrolling log onto the same AgentTrail the
 * in-world carousel drives: one row per MOMENT of the selected corridor (oldest → newest), with its
 * verb, target, and age. It is a pure VIEWPORT — it owns no trail state; it reads getStream/headState
 * and fires the same `trail.*` bus the 3D deck obeys, so the list view and the spatial deck stay one
 * source of truth (the [[project_2d_companion_views]] model: the grid owns the deck, the panel scrubs it).
 *
 * Each corridor keeps its own HEAD (the front-slot moment), live-following the newest until you scrub
 * it back. Paging moves that head and the cards ease to their slots — NOTHING here moves the camera.
 *
 *   click a row        → trail.page <agent> <n>   (rotate that moment to the front)
 *   ⏮ ◀ ▶ ⏭            → trail.page first|prev|next|last
 *   ✕ clear            → trail.clear <agent>
 *
 * House style mirrors FieldVisitorsPanel: a `client` prop, subscription-driven state, inline styles,
 * command-bus side effects only.
 */

// Per-verb identity dots — the panel echo of AgentTrail's classify() hues (say/think near-white &
// violet for conversation; warm for edits; cool for reads). Keyed by getStream()'s `kind`.
const KIND_DOT = {
    read:   '#5aa8e8',  // cool blue
    search: '#b07ad8',  // violet
    edit:   '#e6a85c',  // amber
    write:  '#e6a85c',
    run:    '#7ad79a',  // mint
    say:    '#eef1f7',  // near-white — the agent speaking
    think:  '#948cc8',  // dim violet — interior reasoning
    other:  '#9aa0aa',
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
    title: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    btn: (on) => ({
        flex: '0 0 auto', cursor: 'pointer', padding: '0 5px', borderRadius: 3,
        color: on ? '#7ad7a0' : '#7c8596', whiteSpace: 'nowrap',
    }),
    tabs: {
        display: 'flex', gap: 4, padding: '6px 8px', flex: '0 0 auto',
        borderBottom: '1px solid #1b1f29', overflowX: 'auto',
    },
    tab: (on) => ({
        cursor: 'pointer', padding: '1px 7px', borderRadius: 3, whiteSpace: 'nowrap',
        color: on ? '#dfe3ea' : '#7c8596',
        background: on ? 'rgba(120,150,200,0.14)' : 'transparent',
        border: `1px solid ${on ? '#36507a' : 'transparent'}`,
    }),
    scrub: {
        display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', flex: '0 0 auto',
        borderBottom: '1px solid #1b1f29',
    },
    nav: (dim) => ({
        cursor: dim ? 'default' : 'pointer', padding: '0 6px', borderRadius: 3,
        color: dim ? '#444b56' : '#9aa6ba', fontSize: 13, userSelect: 'none',
    }),
    pos: { flex: '1 1 auto', textAlign: 'center', color: '#7c8596', fontSize: 11 },
    live: { color: '#7ad79a' },
    list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
    msg: { padding: '12px', color: '#7c8596' },
    row: (on) => ({
        display: 'flex', alignItems: 'center', gap: 7, padding: '3px 8px',
        cursor: 'pointer', userSelect: 'none',
        borderLeft: `2px solid ${on ? '#7ad7a0' : 'transparent'}`,
        background: on ? 'rgba(122,215,154,0.09)' : 'transparent',
    }),
    seq: { flex: '0 0 auto', color: '#5a616c', fontSize: 11, minWidth: 22, textAlign: 'right' },
    dot: { flex: '0 0 auto', fontSize: 9 },
    verb: { flex: '0 0 auto', color: '#aeb6c4', minWidth: 52 },
    label: { flex: '1 1 auto', minWidth: 0, color: '#8a92a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    age: { flex: '0 0 auto', color: '#5a616c', fontSize: 11 },
};

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((performance.now() - ts) / 1000));
    return s < 1 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export default function AgentTrailPanel({ client }) {
    const trail = () => client?.ctx?.agentTrail || null;
    const [agents, setAgents] = useState([]);
    const [selected, setSelected] = useState(null);
    const [head, setHead] = useState(null);     // { agentId, head, count, following } for the selected corridor
    const [stream, setStream] = useState([]);
    const focusRef = useRef(null);

    // Roster + selection: sticky to the user's pick, else the newest corridor. Recomputed each refresh.
    const refresh = useCallback(() => {
        const t = trail();
        if (!t) { setAgents([]); setStream([]); setHead(null); return; }
        const list = t.agents?.() || [];
        setAgents(list);   // new array ref each poll → the stream/head effect below re-reads, staying live
        setSelected((cur) => {
            const has = (id) => id && list.some((a) => a.id === id);
            return has(cur) ? cur : (list.length ? list[list.length - 1].id : null);
        });
    }, [client]);

    useEffect(() => {
        const mgr = client?.ctx?.visitorManager;
        refresh();
        const off = mgr?.onChange?.(refresh);
        const t = setInterval(refresh, 1000);   // liveness ("Xs ago") + a net for head moves with no event
        return () => { off?.(); clearInterval(t); };
    }, [client, refresh]);

    // Re-read the selected corridor's stream + head whenever the selection or roster moves (the poll
    // hands us a fresh `agents` array, so this also re-reads on every tick — keeping the head live).
    useEffect(() => {
        const t = trail();
        if (!selected || !t) { setStream([]); setHead(null); return; }
        setStream(t.getStream?.(selected) || []);
        setHead(t.headState?.(selected) || null);
    }, [selected, agents, client]);

    // Keep the focused row in view as the head scrubs.
    useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [head?.head, selected]);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);
    const after = useCallback((cmd) => { const r = exec(cmd); refresh(); return r; }, [exec, refresh]);

    // Move the selected corridor's head (keyword or 1-based index). No camera, no dock — just paging.
    const page = useCallback((arg) => { if (selected) after(['trail.page', selected, String(arg)]); }, [selected, after]);
    const onRow = useCallback((index) => { if (selected) after(['trail.page', selected, String(index + 1)]); }, [selected, after]);

    const atFirst = !head || head.head <= 0;
    const atLast = !head || head.head >= (head.count - 1);

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>Trail · moments</span>
                {selected && (
                    <span style={S.btn(false)} onClick={() => after(['trail.clear', selected])}
                        title="Clear this corridor (trail.clear)">✕ clear</span>
                )}
            </div>

            {agents.length > 1 && (
                <div style={S.tabs}>
                    {agents.map((a) => (
                        <span key={a.id} style={S.tab(a.id === selected)} onClick={() => setSelected(a.id)}
                            title={`${a.id} — ${a.count} moment(s)`}>{a.id} ({a.count})</span>
                    ))}
                </div>
            )}

            <div style={S.scrub}>
                <span style={S.nav(atFirst)} onClick={() => !atFirst && page('first')} title="Oldest (trail.page first)">⏮</span>
                <span style={S.nav(atFirst)} onClick={() => !atFirst && page('prev')} title="Older (trail.page prev)">◀</span>
                <span style={S.pos}>
                    {head ? <>moment {head.head + 1} / {head.count}{head.following && <span style={S.live}> · live</span>}</> : '—'}
                </span>
                <span style={S.nav(atLast)} onClick={() => !atLast && page('next')} title="Newer (trail.page next)">▶</span>
                <span style={S.nav(atLast)} onClick={() => !atLast && page('last')} title="Newest — resume live (trail.page last)">⏭</span>
            </div>

            <div style={S.list}>
                {stream.length === 0 && (
                    <div style={S.msg}>No moments yet. An agent's tool calls and replies deck here as they arrive.</div>
                )}
                {stream.map((m) => (
                    <div key={m.index} ref={m.focused ? focusRef : null} style={S.row(m.focused)}
                        onClick={() => onRow(m.index)} title={m.label}>
                        <span style={S.seq}>{m.index + 1}</span>
                        <span style={{ ...S.dot, color: KIND_DOT[m.kind] || KIND_DOT.other }}>●</span>
                        <span style={S.verb}>{m.action}</span>
                        <span style={S.label}>{m.label || '—'}</span>
                        <span style={S.age}>{ago(m.ts)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
