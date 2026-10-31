import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { laneForSession } from './client/SessionBooks.js';
import { bookInSlot } from './client/bookFocus.js';
/** @import { AppClient, AppContext } from './client/CommandProvider.jsx' */

/**
 * AgentsPanel — a list of the agent books in space, grouped by the desk they sit at,
 * with every other session on the host underneath.
 *
 *   gomuxai   the hub's agents (GomuxHub), each one's helpers indented under it
 *   local     the `agents` desk's sessions (SessionDesk), subagents under their session,
 *             and any other open book
 *   history   every session on the host with no open book (the relay's session list),
 *             folded until opened or filtered
 *
 * A row is a status lamp, the name, the status word and its age; a working agent's
 * current action, the reason a waiting one needs you, or a failure sits under it.
 *
 *   click a row          → agent.focus <id>   (primary slot → the HUD; the camera flies there)
 *   ✕ on a row           → agent.clear <id>   (the book closes; history still lists it)
 *   close done           → agent.clear done
 *   click a history row  → agent.open <session>, then agent.focus
 *   filter               → narrows every group by name, id, project or workgroup
 *
 * The selected row is whatever book holds the primary slot, so clicking a book in space
 * selects its row too. The panel owns no agent state: it reads AgentBooks.agents(), the
 * hub and desk rosters and the session list, and acts through verbs.
 */

/** Status → lamp colour and word. */
const LAMP = {
    waiting: { color: '#f2a25c', word: 'waiting' },
    working: { color: '#7ad79a', word: 'working' },
    error:   { color: '#e8908a', word: 'error' },
    idle:    { color: '#8fa0b8', word: 'idle' },
    done:    { color: '#4f5661', word: 'done' },
};

/** A book's (or a session's) status words → one of LAMP's keys. */
function phaseOf(status, beacon) {
    if (beacon || status === 'waiting') return 'waiting';
    if (status === 'processing' || status === 'active') return 'working';
    if (status === 'error' || status === 'stalled') return 'error';
    if (status === 'exited' || status === 'done') return 'done';
    return 'idle';
}

const S = {
    content: {
        width: '100%', height: '100%',
        background: 'rgba(8,10,14,0.92)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        font: '12px/1.5 ui-monospace, "JetBrains Mono", Menlo, monospace',
        color: '#c8ccd6',
    },
    header: {
        padding: '7px 8px 5px', flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 8, color: '#7c8596',
    },
    title: { flex: '0 0 auto', color: '#aeb6c4', letterSpacing: '0.04em' },
    summary: { flex: '1 1 auto', minWidth: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    btn: { flex: '0 0 auto', cursor: 'pointer', padding: '0 5px', borderRadius: 3, color: '#7c8596', fontSize: 11, whiteSpace: 'nowrap' },
    filterWrap: { padding: '0 8px 6px', flex: '0 0 auto', borderBottom: '1px solid #1b1f29' },
    filter: {
        width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 11, color: '#c8ccd6',
        background: '#0f141b', border: '1px solid #232b34', borderRadius: 4, padding: '2px 6px', outline: 'none',
    },
    body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingBottom: 8 },
    msg: { padding: '10px 12px', color: '#5a616c', fontSize: 11 },

    group: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 3px',
        color: '#5a616c', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
        cursor: 'pointer', userSelect: 'none',
    },
    groupCount: { color: '#444b56' },

    row: (selected, waiting, depth) => ({
        padding: `3px 8px 3px ${8 + depth * 14}px`, cursor: 'pointer', userSelect: 'none',
        borderLeft: `2px solid ${selected ? '#6c8fc0' : waiting ? '#f2a25c' : 'transparent'}`,
        background: selected ? 'rgba(120,150,200,0.13)' : 'transparent',
    }),
    line: { display: 'flex', alignItems: 'center', gap: 7 },
    lamp: (color, hollow) => ({
        flex: '0 0 auto', width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box',
        background: hollow ? 'transparent' : color, border: `1.5px solid ${color}`,
    }),
    name: (dim) => ({
        flex: '1 1 auto', minWidth: 0, color: dim ? '#7c8596' : '#dfe3ea',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }),
    word: (color) => ({ flex: '0 0 auto', color, fontSize: 10 }),
    age: { flex: '0 0 auto', color: '#5a616c', fontSize: 10, minWidth: 24, textAlign: 'right' },
    x: (show) => ({ flex: '0 0 auto', cursor: 'pointer', color: show ? '#7c8596' : 'transparent', padding: '0 2px', fontSize: 11 }),
    sub: (color) => ({
        paddingLeft: 14, color, fontSize: 11,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }),
    tag: { flex: '0 0 auto', color: '#4f5661', fontSize: 10 },
};

/** Wall-clock age, compact. */
function wallAgo(ms) {
    if (!Number.isFinite(ms)) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * Lay out a group as a tree: each book under its parent when the parent is in the same
 * group, in the order the books opened.
 * @param {Object[]} list @param {(a: Object) => string|null} parentOf
 * @returns {{a: Object, depth: number}[]}
 */
function asTree(list, parentOf) {
    const ids = new Set(list.map((a) => a.id));
    const kids = new Map();
    const roots = [];
    for (const a of list) {
        const p = parentOf(a);
        if (p && p !== a.id && ids.has(p)) {
            if (!kids.has(p)) kids.set(p, []);
            kids.get(p).push(a);
        } else roots.push(a);
    }
    const out = [];
    const seen = new Set();
    const walk = (a, depth) => {
        if (seen.has(a.id)) return;
        seen.add(a.id);
        out.push({ a, depth });
        for (const k of kids.get(a.id) || []) walk(k, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    for (const a of list) walk(a, 0);   // a parent cycle leaves nobody out
    return out;
}

/** @param {AppContext} ctx @param {Object[]} agents */
function groupBooks(ctx, agents) {
    const hub = ctx?.gomuxHub;
    const desk = ctx?.sessionDesk;
    const inHub = (a) => !!hub?.lanes.has(a.id);
    const parentOf = (a) => (inHub(a)
        ? hub.nodes.get(a.id)?.parent || null
        : desk?.sessions.get(a.id)?.parent_session?.session_id ?? a.meta?.parentSession?.session_id ?? null);
    return {
        gomux: asTree(agents.filter(inHub), parentOf),
        local: asTree(agents.filter((a) => !inHub(a)), parentOf),
    };
}

/** The text a filter matches a book or session against. */
const bookText = (a) => [a.name, a.id, a.meta?.cwd, a.meta?.project].filter(Boolean).join(' ').toLowerCase();
const sessionName = (s) => s.title || s.agent_name || s.project || s.session_id;
const sessionText = (s) => [sessionName(s), s.session_id, s.project, s.cwd, s.workgroup?.name].filter(Boolean).join(' ').toLowerCase();

/** History rows drawn at once — the filter narrows the rest. */
const HISTORY_ROWS = 150;

/** @param {{ a: Object, depth: number, selected: boolean, onSelect: Function, onClose: Function }} props */
function BookRow({ a, depth, selected, onSelect, onClose }) {
    const [hover, setHover] = useState(false);
    const phase = phaseOf(a.status, a.beacon);
    const lamp = LAMP[phase];
    const beacon = a.beacon && a.beacon !== 'waiting' ? a.beacon : 'needs you';
    const sub = a.notice ? { text: a.notice, color: '#e8908a' }
        : phase === 'waiting' ? { text: beacon, color: '#f2a25c' }
        : phase === 'working' && a.action ? { text: a.action, color: '#8a92a0' }
        : null;
    return (
        <div style={S.row(selected, phase === 'waiting', depth)}
            onClick={() => onSelect(a.id)}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
            title={`${a.name}\n${a.id}${a.meta?.cwd ? '\n' + a.meta.cwd : ''}\n${a.count} sheet${a.count === 1 ? '' : 's'}`}>
            <div style={S.line}>
                <span style={S.lamp(lamp.color, phase === 'done')} />
                <span style={S.name(phase === 'done')}>{a.name}</span>
                {a.type && a.type !== 'claude' && <span style={S.tag}>{a.type}</span>}
                <span style={S.word(lamp.color)}>{lamp.word}</span>
                <span style={S.age}>{wallAgo(a.wallTs)}</span>
                <span style={S.x(hover || selected)} title={`Close this book (agent.clear ${a.id})`}
                    onClick={(e) => { e.stopPropagation(); onClose(a.id); }}>✕</span>
            </div>
            {sub && <div style={S.sub(sub.color)} title={sub.text}>{sub.text}</div>}
        </div>
    );
}

/** @param {{ s: Object, opening: boolean, onOpen: Function }} props */
function SessionRow({ s, opening, onOpen }) {
    const phase = phaseOf(s.status);
    const lamp = LAMP[phase];
    return (
        <div style={S.row(false, false, 0)} onClick={() => !opening && onOpen(s)}
            title={`${s.session_id}${s.cwd ? '\n' + s.cwd : ''}\n${s.status || ''} — open as a book (agent.open)`}>
            <div style={S.line}>
                <span style={S.lamp(lamp.color, phase === 'done')} />
                <span style={S.name(true)}>{sessionName(s)}</span>
                {s.workgroup && <span style={S.tag}>{s.workgroup.name}</span>}
                {s.harness && s.harness !== 'claude' && <span style={S.tag}>{s.harness}</span>}
                <span style={S.word(opening ? '#8fa0b8' : '#4f5661')}>{opening ? 'opening…' : ''}</span>
                <span style={S.age}>{wallAgo(Date.parse(s.mtime))}</span>
            </div>
        </div>
    );
}

/** @param {{ client: AppClient | null }} props */
export default function AgentsPanel({ client }) {
    const ctx = client?.ctx || null;
    const [agents, setAgents] = useState([]);
    const [sessions, setSessions] = useState(null);   // null = no session provider
    const [selected, setSelected] = useState(null);
    const [filter, setFilter] = useState('');
    const [folded, setFolded] = useState({ history: true });
    const [opening, setOpening] = useState(() => new Set());

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);

    // The roster: AgentBooks' change event, plus a 1 s tick for ages and hub status.
    useEffect(() => {
        const books = ctx?.agentBooks;
        if (!books) { setAgents([]); return undefined; }
        const read = () => setAgents(books.agents());
        read();
        const off = books.onChange?.(read);
        const t = setInterval(read, 1000);
        return () => { off?.(); clearInterval(t); };
    }, [ctx]);

    // Selection = the book in the primary slot.
    useEffect(() => {
        const am = ctx?.attentionManager;
        if (!am) return undefined;
        const read = () => {
            const hit = bookInSlot(ctx, 'primary');
            setSelected(hit?.kind === 'agent' ? hit.agentId : null);
        };
        read();
        return am.on('change:primary', read);
    }, [ctx]);

    // History: the relay's session list, pushed as it changes. A failed list keeps the last one.
    useEffect(() => {
        const p = ctx?.sessionProvider;
        if (!p) { setSessions(null); return undefined; }
        let alive = true;
        const off = p.onSessions((list) => { if (alive) setSessions(list.sessions); });
        if (p.latest) setSessions(p.sessions);
        else p.list().catch(() => { /* the provider says why; a push fills the list */ });
        return () => { alive = false; off(); };
    }, [ctx]);

    const select = useCallback((id) => {
        setSelected(id);
        exec(['agent.focus', id]);
    }, [exec]);

    const close = useCallback((id) => exec(['agent.clear', id]), [exec]);

    const open = useCallback(async (s) => {
        setOpening((o) => new Set(o).add(s.session_id));
        try {
            const r = await exec(['agent.open', s.session_id]);
            if (String(r?.text ?? '').startsWith('OK')) select(laneForSession(s));
        } finally {
            setOpening((o) => { const n = new Set(o); n.delete(s.session_id); return n; });
        }
    }, [exec, select]);

    const q = filter.trim().toLowerCase();
    const shown = useMemo(() => (q ? agents.filter((a) => bookText(a).includes(q)) : agents), [agents, q]);
    const groups = useMemo(() => groupBooks(ctx, shown), [ctx, shown]);
    const history = useMemo(() => {
        if (!sessions) return null;
        const open = new Set(agents.map((a) => a.id));
        const rest = sessions.filter((s) => !open.has(laneForSession(s)));
        return q ? rest.filter((s) => sessionText(s).includes(q)) : rest;
    }, [sessions, agents, q]);

    const counts = { working: 0, waiting: 0, done: 0 };
    for (const a of agents) {
        const ph = phaseOf(a.status, a.beacon);
        if (ph in counts) counts[ph]++;
    }
    const summary = [
        counts.waiting ? `${counts.waiting} waiting` : null,
        counts.working ? `${counts.working} working` : null,
        `${agents.length} open`,
    ].filter(Boolean).join(' · ');

    const toggle = (key) => setFolded((f) => ({ ...f, [key]: !f[key] }));
    const isFolded = (key) => (key === 'history' && q ? false : !!folded[key]);

    const groupHeader = (key, label, n) => (
        <div style={S.group} onClick={() => toggle(key)}>
            <span>{isFolded(key) ? '▸' : '▾'}</span>
            <span>{label}</span>
            <span style={S.groupCount}>{n}</span>
        </div>
    );
    const bookRows = (rows) => rows.map(({ a, depth }) => (
        <BookRow key={a.id} a={a} depth={depth} selected={a.id === selected} onSelect={select} onClose={close} />
    ));

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>Agents</span>
                <span style={S.summary} title={summary}>
                    {counts.waiting ? <span style={{ color: LAMP.waiting.color }}>{counts.waiting} waiting · </span> : null}
                    {counts.working ? <span style={{ color: LAMP.working.color }}>{counts.working} working · </span> : null}
                    {agents.length} open
                </span>
                {counts.done > 0 && (
                    <span style={S.btn} onClick={() => exec(['agent.clear', 'done'])}
                        title="Close every finished book (agent.clear done)">close done ({counts.done})</span>
                )}
            </div>
            <div style={S.filterWrap}>
                <input style={S.filter} placeholder="filter" value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setFilter(''); }} />
            </div>

            <div style={S.body}>
                {groups.gomux.length > 0 && (<>
                    {groupHeader('gomux', 'gomuxai', groups.gomux.length)}
                    {!isFolded('gomux') && bookRows(groups.gomux)}
                </>)}
                {groups.local.length > 0 && (<>
                    {groupHeader('local', 'local', groups.local.length)}
                    {!isFolded('local') && bookRows(groups.local)}
                </>)}
                {!agents.length && <div style={S.msg}>No agent books open.</div>}
                {agents.length > 0 && !shown.length && <div style={S.msg}>No open book matches.</div>}

                {history && (<>
                    {groupHeader('history', 'history', history.length)}
                    {!isFolded('history') && history.slice(0, HISTORY_ROWS).map((s) => (
                        <SessionRow key={s.session_id} s={s} opening={opening.has(s.session_id)} onOpen={open} />
                    ))}
                    {!isFolded('history') && history.length > HISTORY_ROWS && (
                        <div style={S.msg}>{history.length - HISTORY_ROWS} more — filter to narrow</div>
                    )}
                </>)}
            </div>
        </div>
    );
}
