import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * AgentTrailPanel — the moment-stream viewport. A 2D scrolling log onto the same AgentTrail the
 * in-world rolodex pager drives: one row per MOMENT of the focused corridor (oldest → newest), with
 * its verb, target, and age. It is a pure VIEWPORT — it owns no trail state; it reads getStream and
 * fires the same `trail.*` bus the 3D deck obeys, so the list view and the spatial pager stay one
 * source of truth (the [[project_2d_companion_views]] model: the grid owns the deck, the panel scrubs it).
 *
 *   click a row        → trail.dock <agent> + trail.page <n>  (slide that moment to the front plane)
 *   ⏮ ◀ ▶ ⏭            → trail.page first|prev|next|last
 *   dock / undock      → trail.dock <agent> / trail.undock
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
    const [pager, setPager] = useState(null);
    const [selected, setSelected] = useState(null);
    const [stream, setStream] = useState([]);
    const focusRef = useRef(null);

    // Selected corridor: sticky to the user's pick, but follow the pager when it's docked, and fall
    // back to the newest corridor. Recomputed against the live roster each refresh.
    const refresh = useCallback(() => {
        const t = trail();
        if (!t) { setAgents([]); setStream([]); setPager(null); return; }
        const list = t.agents?.() || [];
        const p = t.pagerState?.() || null;
        setAgents(list);
        setPager(p);
        setSelected((cur) => {
            const has = (id) => id && list.some((a) => a.id === id);
            if (p && has(p.agentId)) return p.agentId;       // docked corridor wins
            if (has(cur)) return cur;                        // keep the user's pick
            return list.length ? list[list.length - 1].id : null;   // else newest corridor
        });
    }, [client]);

    useEffect(() => {
        const mgr = client?.ctx?.visitorManager;
        refresh();
        const off = mgr?.onChange?.(refresh);
        const t = setInterval(refresh, 1000);   // liveness + a net for changes the trail makes without an event
        return () => { off?.(); clearInterval(t); };
    }, [client, refresh]);

    // Re-read the focused corridor's stream whenever the selection, roster, or pager moves.
    useEffect(() => {
        const t = trail();
        setStream(selected && t ? (t.getStream?.(selected) || []) : []);
    }, [selected, agents, pager, client]);

    // Keep the focused row in view as the pager scrubs.
    useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [pager?.focus, selected]);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);
    const after = useCallback((cmd) => { const r = exec(cmd); refresh(); return r; }, [exec, refresh]);

    const docked = !!pager && pager.agentId === selected;

    // Ensure the pager is on `selected`, then run a trail.page argument against it.
    const page = useCallback((arg) => {
        if (!selected) return;
        if (!pager || pager.agentId !== selected) exec(['trail.dock', selected]);
        after(['trail.page', String(arg)]);
    }, [selected, pager, exec, after]);

    const onRow = useCallback((index) => {
        if (!selected) return;
        if (!pager || pager.agentId !== selected) exec(['trail.dock', selected]);
        after(['trail.page', String(index + 1)]);   // trail.page is 1-based
    }, [selected, pager, exec, after]);

    const toggleDock = useCallback(() => {
        if (docked) after(['trail.undock']);
        else if (selected) after(['trail.dock', selected]);
    }, [docked, selected, after]);

    const atFirst = docked && pager.focus <= 0;
    const atLast = docked && pager.focus >= (pager.count - 1);

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>Trail · moments</span>
                {selected && (
                    <span style={S.btn(docked)} onClick={toggleDock}
                        title={docked ? 'Leave the rolodex pager (trail.undock)' : 'Dock this corridor into the pager (trail.dock)'}>
                        {docked ? '◉ docked' : '○ dock'}
                    </span>
                )}
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
                <span style={S.nav(!docked || atFirst)} onClick={() => !atFirst && page('first')} title="Oldest (trail.page first)">⏮</span>
                <span style={S.nav(!docked || atFirst)} onClick={() => !atFirst && page('prev')} title="Older (trail.page prev)">◀</span>
                <span style={S.pos}>
                    {docked ? `moment ${pager.focus + 1} / ${pager.count}`
                        : stream.length ? `${stream.length} moment${stream.length === 1 ? '' : 's'} — undocked`
                            : '—'}
                </span>
                <span style={S.nav(!docked || atLast)} onClick={() => !atLast && page('next')} title="Newer (trail.page next)">▶</span>
                <span style={S.nav(!docked || atLast)} onClick={() => !atLast && page('last')} title="Newest (trail.page last)">⏭</span>
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
