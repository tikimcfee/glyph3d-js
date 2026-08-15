import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * AgentWaitPanel — the experiment in INTENT-DRIVEN chrome: the editing environment
 * rearranges itself around what the agent needs, without you asking.
 *
 * When a book's parsing says an agent is waiting on YOU — a blocking question in flight
 * (`ask`), a turn that ended on the agent's prose (`say`), or a hand raised by the
 * `agent.request` verb — that message docks over the RIGHT HALF of the screen and stays
 * there until you answer it. Nothing waits → nothing renders (no empty frame, no
 * placeholder); the panel IS the notification.
 *
 * One-way state→view, the HUD's law: it reads AgentBooks.waiting() and issues verbs. It
 * owns no waiting state of its own, so the CLI drives it exactly as the hook does —
 *
 *   glyph3d-cli agent.pretool dev claude AskUserQuestion '{"questions":[{"question":"…"}]}'
 *   glyph3d-cli agent.request dev "which way do you want this?"
 *   glyph3d-cli agent.waiting          # who's up, and why
 *   glyph3d-cli agent.answered dev     # panel closes
 *
 * Buttons issue the same verbs the CLI does: ✕ / "answered" → `agent.answered <id>`,
 * "find the book" → `camera.focus agent:book:<id>` (the ONE camera verb; the panel never
 * moves the camera itself). Several agents waiting → a chip per hand, longest wait first.
 */

const REASON = {
    ask:     { label: 'asked you a question', color: '#f2a25c' },
    say:     { label: 'ended its turn talking to you', color: '#9fd3ff' },
    request: { label: 'raised a hand', color: '#f2a25c' },
};

const S = {
    // The dock: the right half of the row, over the canvas. Absolute (not a flex
    // sibling) on purpose — the WebGPU canvas keeps its size, so opening this never
    // costs a surface resize + relayout, the same reason the left dock defaults to
    // overlay mode.
    dock: {
        position: 'absolute', top: 0, right: 0, bottom: 0, width: '50%',
        zIndex: 11, display: 'flex', flexDirection: 'column',
        background: 'rgba(8,10,14,0.94)', borderLeft: '1px solid #2a3140',
        boxShadow: '-12px 0 32px rgba(0,0,0,0.45)',
        font: '13px/1.6 ui-monospace, "JetBrains Mono", Menlo, monospace',
        color: '#c8ccd6',
    },
    header: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        padding: '8px 10px', borderBottom: '1px solid #1b1f29', color: '#7c8596', fontSize: 12,
    },
    dot: { flex: '0 0 auto', fontSize: 10 },
    who: { flex: '0 0 auto', color: '#dfe3ea' },
    why: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    age: { flex: '0 0 auto', color: '#5a616c', fontSize: 11 },
    x: { flex: '0 0 auto', cursor: 'pointer', color: '#7c8596', padding: '0 4px' },

    // The other raised hands — one chip each, longest wait first.
    chips: {
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: '0 0 auto',
        padding: '5px 10px', borderBottom: '1px solid #1b1f29',
    },
    chip: (on) => ({
        cursor: 'pointer', padding: '1px 7px', borderRadius: 10, fontSize: 11,
        border: `1px solid ${on ? '#6c8fc0' : '#232b34'}`,
        background: on ? 'rgba(120,150,200,0.16)' : 'transparent',
        color: on ? '#dfe3ea' : '#8a92a0',
    }),

    // The message itself, whole — the panel frames it, it is never truncated.
    body: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#dfe3ea',
    },
    footer: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        padding: '7px 10px', borderTop: '1px solid #1b1f29',
    },
    hint: { flex: '1 1 auto', color: '#5a616c', fontSize: 11 },
    btn: {
        flex: '0 0 auto', cursor: 'pointer', padding: '2px 9px', borderRadius: 4,
        border: '1px solid #232b34', color: '#c8ccd6', background: '#0f141b', fontSize: 12,
    },
};

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((performance.now() - ts) / 1000));
    return s < 1 ? 'now' : s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export default function AgentWaitPanel({ client }) {
    const [hands, setHands] = useState([]);
    const [pick, setPick] = useState(null);   // the hand you're reading; sticky while it waits

    // Same liveness discipline as the Agents panel: the books' change event for the
    // edges, a 1s tick for the ages (and as a net for a change we didn't hear about).
    const refresh = useCallback(() => {
        setHands(client?.ctx?.agentBooks?.waiting?.() || []);
    }, [client]);

    useEffect(() => {
        refresh();
        const off = client?.ctx?.agentBooks?.onChange?.(refresh);
        const t = setInterval(refresh, 1000);
        return () => { off?.(); clearInterval(t); };
    }, [client, refresh]);

    // The shown hand: your pick while it is still waiting, else the one that has been
    // waiting longest (waiting() is already ordered that way).
    const shown = useMemo(
        () => hands.find((h) => h.id === pick) || hands[0] || null,
        [hands, pick],
    );

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);

    if (!shown) return null;   // nobody waiting — the panel is its own notification

    const reason = REASON[shown.reason] || { label: shown.reason, color: '#f2a25c' };
    return (
        <div style={S.dock}>
            <div style={S.header}>
                <span style={{ ...S.dot, color: shown.color }}>●</span>
                <span style={S.who}>{shown.id}</span>
                <span style={{ ...S.why, color: reason.color }}>{reason.label}</span>
                <span style={S.age}>{ago(shown.ts)}</span>
                <span style={S.x} title={`Lower this hand (agent.answered ${shown.id})`}
                    onClick={() => exec(['agent.answered', shown.id])}>✕</span>
            </div>

            {hands.length > 1 && (
                <div style={S.chips}>
                    {hands.map((h) => (
                        <span key={h.id} style={S.chip(h.id === shown.id)} onClick={() => setPick(h.id)}
                            title={`${h.id} — ${(REASON[h.reason] || {}).label || h.reason}`}>
                            {h.id}
                        </span>
                    ))}
                </div>
            )}

            <div style={S.body}>{shown.message}</div>

            <div style={S.footer}>
                <span style={S.hint}>{shown.sheets} sheet{shown.sheets === 1 ? '' : 's'} in its book</span>
                <span style={S.btn} title={`camera.focus agent:book:${shown.id}`}
                    onClick={() => exec(['camera.focus', `agent:book:${shown.id}`])}>find the book</span>
                <span style={S.btn} title={`agent.answered ${shown.id}`}
                    onClick={() => exec(['agent.answered', shown.id])}>answered</span>
            </div>
        </div>
    );
}
