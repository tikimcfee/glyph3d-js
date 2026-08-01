import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * AgentsPanel — the one 2D browser onto AgentBooks. A master-detail view: the agent
 * ROSTER up top (who's on the field: identity color, lifecycle state, raised-hand
 * beacon, sheet count, liveness), and underneath it a detail pane for the selected
 * agent — a scrub bar plus the scrollable stream of its book's sheets (oldest →
 * newest). Picking a roster row selects that book.
 *
 * A list (not tabs) because subagents multiply: a dozen books is a scrollable column
 * where tabs would run off the panel's edge. Both regions scroll to fit — the roster
 * caps its height; the sheet stream fills the rest.
 *
 * It owns no agent state; it reads agents()/getStream() and fires the same command bus
 * the 3D shelf obeys (the [[project_2d_companion_views]] model: the book owns the deck,
 * the panel turns it). Each book live-follows its newest sheet until you page back;
 * NOTHING here moves the camera.
 *
 *   click a roster row → select that agent's book (detail pane follows)
 *   + summon           → agent.spawn (an empty book — request an instance)
 *   clear done / ✕     → agent.clear done / agent.clear <id>
 *   click a sheet row  → book.page <agent> <n>   (open that sheet)
 *   ⏮ ◀ ▶ ⏭            → book.page first|prev|next|last
 *
 * Identity dots come from getStream()'s per-row `color` — the live hue table in
 * AgentBooks.cfg.hues (seeded from the tool registry's ONE action-hue home), so the 2D
 * dots and the 3D cards can never drift apart.
 */

const STATE_STYLE = {
    active:  { color: '#7ad79a', label: 'active' },
    idle:    { color: '#8fa0b8', label: 'idle' },
    stalled: { color: '#e8c25a', label: 'STALLED' },
    done:    { color: '#8a8f98', label: 'done' },
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
    btn: { flex: '0 0 auto', cursor: 'pointer', padding: '0 5px', borderRadius: 3, color: '#7c8596', whiteSpace: 'nowrap' },

    // -- master: the agent roster (capped height, scrolls when subagents pile up) --
    roster: { flex: '0 1 auto', maxHeight: '45%', overflowY: 'auto', borderBottom: '1px solid #1b1f29', padding: '3px 0' },
    agentRow: (on) => ({
        display: 'flex', alignItems: 'center', gap: 7, padding: '3px 8px',
        cursor: 'pointer', userSelect: 'none',
        borderLeft: `2px solid ${on ? '#6c8fc0' : 'transparent'}`,
        background: on ? 'rgba(120,150,200,0.12)' : 'transparent',
    }),
    adot: { flex: '0 0 auto', fontSize: 9 },
    aid: { flex: '1 1 auto', minWidth: 0, color: '#dfe3ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    astate: (c) => ({ flex: '0 0 auto', color: c, fontSize: 10 }),
    abeacon: { flex: '0 0 auto', color: '#f2a25c', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '35%', whiteSpace: 'nowrap' },
    acount: { flex: '0 0 auto', color: '#7c8596', fontSize: 11 },
    alive: { flex: '0 0 auto', color: '#7ad79a', fontSize: 11 },
    aage: { flex: '0 0 auto', color: '#5a616c', fontSize: 11, minWidth: 26, textAlign: 'right' },
    ax: { flex: '0 0 auto', cursor: 'pointer', color: '#5a616c', padding: '0 2px' },

    // -- detail: scrub bar + the selected book's sheet stream --
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
    list: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '4px 0' },
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

export default function AgentsPanel({ client }) {
    const books = () => client?.ctx?.agentBooks || null;
    const [agents, setAgents] = useState([]);
    const [selected, setSelected] = useState(null);
    const [stream, setStream] = useState([]);
    const focusRef = useRef(null);

    // Roster + selection: sticky to the user's pick, else the newest lane. Recomputed each refresh.
    const refresh = useCallback(() => {
        const b = books();
        if (!b) { setAgents([]); setStream([]); return; }
        const list = b.agents?.() || [];
        setAgents(list);   // new array ref each poll → the stream effect below re-reads, staying live
        setSelected((cur) => {
            const has = (id) => id && list.some((a) => a.id === id);
            return has(cur) ? cur : (list.length ? list[list.length - 1].id : null);
        });
    }, [client]);

    useEffect(() => {
        refresh();
        const off = books()?.onChange?.(refresh);
        const t = setInterval(refresh, 1000);   // liveness ("Xs ago") + a net for head moves with no event
        return () => { off?.(); clearInterval(t); };
    }, [client, refresh]);

    // Re-read the selected book's stream whenever the selection or roster moves (the poll hands
    // us a fresh `agents` array, so this also re-reads on every tick — stream + head stay live).
    useEffect(() => {
        const b = books();
        setStream(selected && b ? (b.getStream?.(selected) || []) : []);
    }, [selected, agents, client]);

    const sel = agents.find((a) => a.id === selected) || null;

    // Keep the open sheet in view as the head turns.
    useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [sel?.head, selected]);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);
    const after = useCallback((cmd) => { const r = exec(cmd); refresh(); return r; }, [exec, refresh]);

    const summon = useCallback(() => {
        after(['agent.spawn', `visitor-${Math.random().toString(36).slice(2, 6)}`]);
    }, [after]);

    // Turn the selected book (keyword or 1-based index). No camera, no dock — just paging.
    const page = useCallback((arg) => { if (selected) after(['book.page', selected, String(arg)]); }, [selected, after]);
    const onRow = useCallback((index) => { if (selected) after(['book.page', selected, String(index + 1)]); }, [selected, after]);

    const atFirst = !sel || sel.head <= 0;
    const atLast = !sel || sel.head >= (sel.count - 1);
    const anyDone = agents.some((a) => a.state === 'done');

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>Agents{agents.length ? ` (${agents.length})` : ''}</span>
                <span style={S.btn} onClick={summon} title="Summon an empty agent book (agent.spawn)">+ summon</span>
                {anyDone && (
                    <span style={S.btn} onClick={() => after(['agent.clear', 'done'])}
                        title="Clear finished agents (agent.clear done)">clear done</span>
                )}
            </div>

            {/* master — the agent roster */}
            <div style={S.roster}>
                {agents.length === 0 && <div style={S.msg}>No agents yet. Activity pages a book in here.</div>}
                {agents.map((a) => {
                    const st = STATE_STYLE[a.state] || STATE_STYLE.active;
                    return (
                        <div key={a.id} style={S.agentRow(a.id === selected)} onClick={() => setSelected(a.id)}
                            title={`${a.type}:${a.id} — ${a.count} sheet(s)${a.recent?.length ? '\n' + a.recent.join('\n') : ''}`}>
                            <span style={{ ...S.adot, color: a.color }}>●</span>
                            <span style={S.aid}>{a.id}</span>
                            {a.beacon && <span style={S.abeacon} title={a.beacon}>(!) {a.beacon}</span>}
                            <span style={S.astate(st.color)}>{st.label}</span>
                            <span style={S.acount}>{a.count}</span>
                            {a.following && <span style={S.alive}>live</span>}
                            <span style={S.aage}>{ago(a.lastTs)}</span>
                            <span style={S.ax} onClick={(e) => { e.stopPropagation(); after(['agent.clear', a.id]); }}
                                title={`Clear ${a.id} (agent.clear)`}>✕</span>
                        </div>
                    );
                })}
            </div>

            {/* detail — scrub bar for the selected book */}
            <div style={S.scrub}>
                <span style={S.nav(atFirst)} onClick={() => !atFirst && page('first')} title="Oldest (book.page first)">⏮</span>
                <span style={S.nav(atFirst)} onClick={() => !atFirst && page('prev')} title="Older (book.page prev)">◀</span>
                <span style={S.pos}>
                    {sel ? <>sheet {sel.head + 1} / {sel.count}{sel.following && <span style={S.live}> · live</span>}</> : '—'}
                </span>
                <span style={S.nav(atLast)} onClick={() => !atLast && page('next')} title="Newer (book.page next)">▶</span>
                <span style={S.nav(atLast)} onClick={() => !atLast && page('last')} title="Newest — resume live (book.page last)">⏭</span>
            </div>

            {/* detail — the selected book's sheet stream */}
            <div style={S.list}>
                {stream.length === 0 && (
                    <div style={S.msg}>No sheets yet. An agent's tool calls and replies page in here as they arrive.</div>
                )}
                {stream.map((m) => (
                    <div key={m.index} ref={m.focused ? focusRef : null} style={S.row(m.focused)}
                        onClick={() => onRow(m.index)} title={m.label}>
                        <span style={S.seq}>{m.index + 1}</span>
                        <span style={{ ...S.dot, color: m.color }}>●</span>
                        <span style={S.verb}>{m.action}</span>
                        <span style={S.label}>{m.label || '—'}</span>
                        <span style={S.age}>{ago(m.ts)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
