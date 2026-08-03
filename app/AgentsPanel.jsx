import React, { useCallback, useEffect, useRef, useState } from 'react';
import { kimiAgentIdForSession } from '@glyph3d/core/collections/sessionAdapter.js';

/**
 * AgentsPanel — the one 2D browser onto AgentBooks. ONE list of agent sessions, no
 * master-detail split: every OPEN book is a single row (identity color, lifecycle
 * state, raised-hand beacon, sheet count, liveness) that EXPANDS IN PLACE to its
 * detail — the scrub bar, the kept-turns cap, and the scrollable stream of its
 * sheets (oldest → newest) — and CLOSES via its ✕. One lane expanded at a time;
 * expanding a row folds whichever was open.
 *
 * Below the open books, separated by a slim divider, sit the relay's ARCHIVED
 * session transcripts (ctx.sessionProvider — both harnesses, kimi tagged): id
 * prefix, age, size. Clicking one pages it in as a lane (agent.open) and expands
 * it; sessions already open are not listed twice — their lane row above IS their
 * row. The archive group exists only when a session provider is connected.
 *
 * It owns no agent state; it reads agents()/getStream() and fires the same command bus
 * the 3D shelf obeys (the [[project_2d_companion_views]] model: the book owns the deck,
 * the panel turns it). Each book live-follows its newest sheet until you page back;
 * NOTHING here moves the camera.
 *
 *   click a lane row   → expand / collapse its sheet stream
 *   ✕ on a lane row    → agent.clear <id>
 *   + summon           → agent.spawn (an empty book — request an instance)
 *   clear done         → agent.clear done
 *   click a sheet row  → book.page <agent> <n>   (open that sheet)
 *   ⏮ ◀ ▶ ⏭            → book.page first|prev|next|last
 *   keep [n] / ↺       → book.limit <agent> <n|default>   (this book's kept-turns cap;
 *                        0 keeps everything, ↺ follows the shelf default again)
 *   click an archive row → agent.open <session-id>   (page a past session in as a lane)
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

    // -- the ONE scroll: lane rows (each with its expandable detail) and archive rows
    //    flow at natural height in a single scrolling column. No nested scrollboxes.
    body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },

    // -- lane rows: an open book, collapsed to one line --
    agentRow: (on) => ({
        display: 'flex', alignItems: 'center', gap: 7, padding: '3px 8px',
        cursor: 'pointer', userSelect: 'none',
        borderLeft: `2px solid ${on ? '#6c8fc0' : 'transparent'}`,
        background: on ? 'rgba(120,150,200,0.12)' : 'transparent',
    }),
    acaret: { flex: '0 0 auto', width: 10, textAlign: 'center', fontSize: 9, color: '#5a616c' },
    adot: { flex: '0 0 auto', fontSize: 9 },
    aid: { flex: '1 1 auto', minWidth: 0, color: '#dfe3ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    aharness: { flex: '0 0 auto', color: '#5a616c', fontSize: 10 },
    astate: (c) => ({ flex: '0 0 auto', color: c, fontSize: 10 }),
    abeacon: { flex: '0 0 auto', color: '#f2a25c', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '35%', whiteSpace: 'nowrap' },
    acount: { flex: '0 0 auto', color: '#7c8596', fontSize: 11 },
    alive: { flex: '0 0 auto', color: '#7ad79a', fontSize: 11 },
    aage: { flex: '0 0 auto', color: '#5a616c', fontSize: 11, minWidth: 26, textAlign: 'right' },
    ax: { flex: '0 0 auto', cursor: 'pointer', color: '#5a616c', padding: '0 2px' },

    // -- a lane's expanded detail: scrub bar + kept-turns cap + the sheet stream --
    detail: { borderBottom: '1px solid #1b1f29', background: 'rgba(255,255,255,0.015)' },
    scrub: {
        display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', flex: '0 0 auto',
        borderBottom: '1px solid #1b1f29',
    },
    nav: (dim) => ({
        cursor: dim ? 'default' : 'pointer', padding: '0 6px', borderRadius: 3,
        color: dim ? '#444b56' : '#9aa6ba', fontSize: 13, userSelect: 'none',
    }),
    pos: { flex: '1 1 auto', textAlign: 'center', color: '#7c8596', fontSize: 11 },
    keep: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', flex: '0 0 auto',
        borderBottom: '1px solid #1b1f29', color: '#5a616c', fontSize: 11,
    },
    keepInput: {
        width: 46, font: 'inherit', color: '#c8ccd6', background: '#0f141b',
        border: '1px solid #232b34', borderRadius: 4, padding: '1px 5px', outline: 'none', textAlign: 'right',
    },
    keepHint: { flex: '1 1 auto', color: '#444b56', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    keepReset: { flex: '0 0 auto', cursor: 'pointer', padding: '0 4px', borderRadius: 3, color: '#7c8596' },
    live: { color: '#7ad79a' },
    list: { padding: '4px 0' },
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

    // -- archive: stored session transcripts, dimmer rows under a slim divider --
    divider: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
        color: '#5a616c', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
        borderTop: '1px solid #1b1f29', marginTop: 2,
    },
    dividerHint: { color: '#444b56', fontSize: 10, textTransform: 'none', letterSpacing: 0 },
    sessRow: {
        display: 'flex', alignItems: 'center', gap: 7, padding: '2px 8px', userSelect: 'none',
        cursor: 'pointer',
    },
    sessId: { flex: '0 0 auto', color: '#8a92a0', minWidth: 70 },
    sessHarness: { flex: '0 0 auto', color: '#5a616c', fontSize: 10 },
    sessAge: { flex: '1 1 auto', textAlign: 'right', color: '#5a616c', fontSize: 11 },
    sessSize: { flex: '0 0 auto', color: '#5a616c', fontSize: 11, minWidth: 38, textAlign: 'right' },
};

// Archive list poll cadence (ms) — deliberately slower than the 1s roster tick;
// the archive is disk-backed and only moves when a session file grows or appears.
const ARCHIVE_POLL_MS = 10_000;

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((performance.now() - ts) / 1000));
    return s < 1 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

// Wall-clock age (archive mtimes are unix ms, not performance.now() ticks) — days-scale.
function wallAgo(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
}

function humanSize(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n}b`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}k`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}M`;
}

// Session ids are UUIDs; lanes opened from the archive carry the 8-char prefix
// (dashes stripped). Normalizing both sides makes the open-lane match symmetric.
const sessPrefix = (id) => String(id).replace(/-/g, '').slice(0, 8);

// The lane id an archive entry opens under — per harness (a kimi id's `session_`
// prefix would otherwise show/match as "session_x"; its derivation strips it).
const sessLaneId = (s) => (s.harness === 'kimi' ? kimiAgentIdForSession(s.id) : sessPrefix(s.id));

export default function AgentsPanel({ client }) {
    const books = () => client?.ctx?.agentBooks || null;
    const [agents, setAgents] = useState([]);
    const [expanded, setExpanded] = useState(null);   // the ONE lane whose detail is open
    const [stream, setStream] = useState([]);
    const [sessions, setSessions] = useState(null);   // null = no provider (group absent), [] = provider + empty
    const focusRef = useRef(null);
    const aliveRef = useRef(true);

    // Roster + expansion: sticky to the user's open row, collapsing when its lane goes
    // away (cleared). Recomputed each refresh.
    const refresh = useCallback(() => {
        const b = books();
        if (!b) { setAgents([]); setStream([]); return; }
        const list = b.agents?.() || [];
        setAgents(list);   // new array ref each poll → the stream effect below re-reads, staying live
        setExpanded((cur) => (cur && list.some((a) => a.id === cur)) ? cur : null);
    }, [client]);

    useEffect(() => {
        refresh();
        const off = books()?.onChange?.(refresh);
        const t = setInterval(refresh, 1000);   // liveness ("Xs ago") + a net for head moves with no event
        return () => { off?.(); clearInterval(t); };
    }, [client, refresh]);

    // Re-read the expanded book's stream whenever the expansion or roster moves (the poll hands
    // us a fresh `agents` array, so this also re-reads on every tick — stream + head stay live).
    useEffect(() => {
        const b = books();
        setStream(expanded && b ? (b.getStream?.(expanded) || []) : []);
    }, [expanded, agents, client]);

    // Archive: the relay's stored session list. Its own slow poll — the 1s roster tick
    // above is liveness for in-memory lanes; this one is a disk listing over RPC.
    const refreshArchive = useCallback(async () => {
        const p = client?.ctx?.sessionProvider;
        if (!p) { if (aliveRef.current) setSessions(null); return; }
        try {
            const list = await p.list();
            if (aliveRef.current) setSessions(Array.isArray(list) ? list : []);
        } catch {
            // A transient list failure (relay reconnecting, a mid-reload window) must not
            // UNMOUNT the archive — that reads as the group randomly vanishing. Keep the
            // last-good listing; only an ABSENT provider hides it.
        }
    }, [client]);

    useEffect(() => {
        aliveRef.current = true;
        refreshArchive();
        const t = setInterval(refreshArchive, ARCHIVE_POLL_MS);
        return () => { aliveRef.current = false; clearInterval(t); };
    }, [refreshArchive]);

    const sel = agents.find((a) => a.id === expanded) || null;

    // Keep the open sheet in view as the head turns.
    useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [sel?.head, expanded]);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);
    const after = useCallback((cmd) => { const r = exec(cmd); refresh(); return r; }, [exec, refresh]);

    const summon = useCallback(() => {
        after(['agent.spawn', `visitor-${Math.random().toString(36).slice(2, 6)}`]);
    }, [after]);

    // Turn the expanded book (keyword or 1-based index). No camera, no dock — just paging.
    const page = useCallback((arg) => { if (expanded) after(['book.page', expanded, String(arg)]); }, [expanded, after]);
    const onRow = useCallback((index) => { if (expanded) after(['book.page', expanded, String(index + 1)]); }, [expanded, after]);

    // Kept-turns cap: a draft string while editing (so the 1s poll can't snap the field
    // mid-keystroke), committed on Enter/blur as `book.limit <id> <n>` — the same verb
    // the CLI speaks. Escape abandons the draft; ↺ returns the book to the shelf default.
    const [capDraft, setCapDraft] = useState(null);
    useEffect(() => setCapDraft(null), [expanded]);
    const commitCap = useCallback((liveCap) => {
        const t = capDraft?.trim?.();
        setCapDraft(null);
        if (!expanded || t == null || t === '' || t === String(liveCap)) return;
        const n = Number(t);
        if (!Number.isFinite(n) || n < 0) return;   // the field mirrors live state again
        after(['book.limit', expanded, String(Math.floor(n))]);
    }, [capDraft, expanded, after]);

    // Page a past session in as a lane (fire-and-forget — the book arrives when the
    // adapter feeds it), expand its row, and re-list so it leaves the archive group.
    const openSession = useCallback((s) => {
        exec(['agent.open', s.id]);
        setExpanded(sessLaneId(s));
        refreshArchive();
    }, [exec, refreshArchive]);

    const atFirst = !sel || sel.head <= 0;
    const atLast = !sel || sel.head >= (sel.count - 1);
    const anyDone = agents.some((a) => a.state === 'done');
    // Sessions already open as lanes are not listed again — their lane row IS their row.
    const openLanes = new Set(agents.map((a) => sessPrefix(a.id)));
    const archived = (sessions || []).filter((s) => !openLanes.has(sessLaneId(s)));

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

            <div style={S.body}>
                {agents.length === 0 && archived.length === 0 && (
                    <div style={S.msg}>No agents yet. Activity pages a book in here.</div>
                )}

                {/* open books — one row per lane, expanding in place to its sheet stream */}
                {agents.map((a) => {
                    const st = STATE_STYLE[a.state] || STATE_STYLE.active;
                    const on = a.id === expanded;
                    return (
                        <React.Fragment key={a.id}>
                            <div style={S.agentRow(on)} onClick={() => setExpanded(on ? null : a.id)}
                                title={`${a.type}:${a.id} — ${a.count} sheet(s)${a.recent?.length ? '\n' + a.recent.join('\n') : ''}`}>
                                <span style={S.acaret}>{on ? '▾' : '▸'}</span>
                                <span style={{ ...S.adot, color: a.color }}>●</span>
                                <span style={S.aid}>{a.id}</span>
                                {a.type && a.type !== 'claude' && <span style={S.aharness}>{a.type}</span>}
                                {a.beacon && <span style={S.abeacon} title={a.beacon}>(!) {a.beacon}</span>}
                                <span style={S.astate(st.color)}>{st.label}</span>
                                <span style={S.acount}>{a.count}</span>
                                {a.following && <span style={S.alive}>live</span>}
                                <span style={S.aage}>{ago(a.lastTs)}</span>
                                <span style={S.ax} onClick={(e) => { e.stopPropagation(); after(['agent.clear', a.id]); }}
                                    title={`Clear ${a.id} (agent.clear)`}>✕</span>
                            </div>

                            {on && sel && (
                                <div style={S.detail}>
                                    <div style={S.scrub}>
                                        <span style={S.nav(atFirst)} onClick={() => !atFirst && page('first')} title="Oldest (book.page first)">⏮</span>
                                        <span style={S.nav(atFirst)} onClick={() => !atFirst && page('prev')} title="Older (book.page prev)">◀</span>
                                        <span style={S.pos}>
                                            sheet {sel.head + 1} / {sel.count}{sel.following && <span style={S.live}> · live</span>}
                                        </span>
                                        <span style={S.nav(atLast)} onClick={() => !atLast && page('next')} title="Newer (book.page next)">▶</span>
                                        <span style={S.nav(atLast)} onClick={() => !atLast && page('last')} title="Newest — resume live (book.page last)">⏭</span>
                                    </div>

                                    {/* retention — this book's kept-turns cap (older sheets shed as new turns land) */}
                                    <div style={S.keep}
                                        title="Turns kept in space for this book — older sheets shed as new ones land. 0 keeps everything; ↺ follows the shelf default (Settings ▸ Agent Books). Fires book.limit.">
                                        <span>keep</span>
                                        <input
                                            type="number" min={0} step={1} style={S.keepInput}
                                            value={capDraft ?? String(sel.cap)}
                                            onChange={(e) => setCapDraft(e.target.value)}
                                            onBlur={() => commitCap(sel.cap)}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === 'Enter') e.currentTarget.blur();
                                                else if (e.key === 'Escape') setCapDraft(null);
                                            }}
                                        />
                                        <span>turns</span>
                                        <span style={S.keepHint}>
                                            {sel.limit == null ? 'shelf default' : sel.cap === 0 ? 'this book · keeps everything' : 'this book'}
                                        </span>
                                        {sel.limit != null && (
                                            <span style={S.keepReset} onClick={() => after(['book.limit', expanded, 'default'])}
                                                title="Follow the shelf default again (book.limit default)">↺</span>
                                        )}
                                    </div>

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
                            )}
                        </React.Fragment>
                    );
                })}

                {/* archive — past session transcripts on the relay (only when a provider is
                    connected and something isn't already open) */}
                {sessions && archived.length > 0 && (<>
                    <div style={S.divider}>
                        <span>archive</span>
                        <span style={S.dividerHint}>click to open</span>
                    </div>
                    {archived.map((s) => (
                        <div key={s.id} style={S.sessRow}
                            onClick={() => openSession(s)}
                            title={`${s.id} — open as a lane (agent.open)`}>
                            <span style={S.sessId}>{sessLaneId(s)}</span>
                            {s.harness === 'kimi' && <span style={S.sessHarness}>kimi</span>}
                            <span style={S.sessAge}>{wallAgo(s.mtime)}</span>
                            <span style={S.sessSize}>{humanSize(s.size)}</span>
                        </div>
                    ))}
                </>)}
            </div>
        </div>
    );
}
