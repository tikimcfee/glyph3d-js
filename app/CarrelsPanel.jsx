import React, { useCallback, useEffect, useState } from 'react';

/**
 * CarrelsPanel — the 2D roster of the world's reading desks (Carrel).
 *
 * One-way state→view (the HUD discipline): it reads ctx.carrels and fires the
 * same carrel.* verbs the CLI does — it owns no desk behavior. A desk row shows
 * the carrel's glow hue, name, seat count and active marker; its members nest
 * beneath as indented rows.
 *
 *   + desk              → carrel.create   (sets one down where you're looking)
 *   click a desk row    → carrel.focus    (fly the camera, make it active)
 *   ✕ on a desk         → carrel.dissolve (members slide home, desk folds)
 *   click a member row  → camera.focus + attention.set primary
 *   ↩ on a member       → carrel.release  (send it home)
 *
 * Reactivity: membership changes ride the workspace 'change:surfaces' event
 * (carrel.add/release write view facts through it); create/dissolve/move/set
 * have no event, so a 1s poll is the liveness net — the AgentsPanel pattern.
 * Verbs go through the ARRAY form of execute (ids are paths; the space-split
 * tokenizer must never see them).
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
    title: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    btn: { flex: '0 0 auto', cursor: 'pointer', padding: '0 5px', borderRadius: 3, color: '#7c8596', whiteSpace: 'nowrap' },

    body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '3px 0' },
    msg: { padding: '12px', color: '#7c8596' },

    deskRow: (on) => ({
        display: 'flex', alignItems: 'center', gap: 7, padding: '3px 8px',
        cursor: 'pointer', userSelect: 'none',
        borderLeft: `2px solid ${on ? '#6c8fc0' : 'transparent'}`,
        background: on ? 'rgba(120,150,200,0.12)' : 'transparent',
    }),
    dot: { flex: '0 0 auto', fontSize: 9 },
    name: { flex: '1 1 auto', minWidth: 0, color: '#dfe3ea', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    fading: { flex: '0 0 auto', color: '#e8c25a', fontSize: 10 },
    count: { flex: '0 0 auto', color: '#7c8596', fontSize: 11 },
    x: { flex: '0 0 auto', cursor: 'pointer', color: '#5a616c', padding: '0 2px' },

    memberRow: {
        display: 'flex', alignItems: 'center', gap: 7, padding: '2px 8px 2px 24px',
        cursor: 'pointer', userSelect: 'none',
    },
    memberName: { flex: '1 1 auto', minWidth: 0, color: '#8a92a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    home: { flex: '0 0 auto', cursor: 'pointer', color: '#5a616c', padding: '0 2px', fontSize: 11 },
};

const basename = (p) => {
    const s = String(p || '').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
};

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

export default function CarrelsPanel({ client }) {
    const [desks, setDesks] = useState([]);

    // Snapshot the live carrels map into plain rows. Small map, cheap read — the
    // 1s tick just re-snapshots (the AgentsPanel liveness pattern).
    const refresh = useCallback(() => {
        const ctx = client?.ctx;
        const map = ctx?.carrels;
        if (!map) { setDesks([]); return; }
        setDesks([...map.values()].map((c) => ({
            name: c.carrelName,
            active: c.carrelName === ctx.activeCarrel,
            glow: hex(c.glowColor),
            dissolving: !!c._dissolving,
            members: c.list().map((m) => m.id),
        })));
    }, [client]);

    useEffect(() => {
        refresh();
        const off = client?.ctx?.workspace?.on?.('change:surfaces', refresh);
        const t = setInterval(refresh, 1000);
        return () => { off?.(); clearInterval(t); };
    }, [client, refresh]);

    const exec = useCallback((cmd) => client?.router?.execute(cmd), [client]);
    const after = useCallback((cmd) => { const r = exec(cmd); refresh(); return r; }, [exec, refresh]);

    return (
        <div style={S.content}>
            <div style={S.header}>
                <span style={S.title}>Carrels{desks.length ? ` (${desks.length})` : ''}</span>
                <span style={S.btn} onClick={() => after(['carrel.create'])}
                    title="Set a desk down where you're looking (carrel.create)">+ desk</span>
            </div>

            <div style={S.body}>
                {desks.length === 0 && (
                    <div style={S.msg}>No desks. “+ desk” sets one down where you're looking; carrel.add seats windows at it.</div>
                )}
                {desks.map((d) => (
                    <React.Fragment key={d.name}>
                        <div style={S.deskRow(d.active)}
                            onClick={() => after(['carrel.focus', d.name])}
                            title={`${d.name} — fly to it and make it active (carrel.focus)`}>
                            <span style={{ ...S.dot, color: d.glow }}>●</span>
                            <span style={S.name}>{d.name}</span>
                            {d.dissolving && <span style={S.fading}>folding…</span>}
                            <span style={S.count}>{d.members.length}</span>
                            <span style={S.x}
                                onClick={(e) => { e.stopPropagation(); after(['carrel.dissolve', d.name]); }}
                                title={`Fold ${d.name} — members slide home (carrel.dissolve)`}>✕</span>
                        </div>
                        {d.members.map((id) => (
                            <div key={id} style={S.memberRow}
                                onClick={() => { exec(['camera.focus', id]); after(['attention.set', 'primary', id]); }}
                                title={`${id} — frame it (camera.focus)`}>
                                <span style={S.memberName}>{basename(id)}</span>
                                <span style={S.home}
                                    onClick={(e) => { e.stopPropagation(); after(['carrel.release', id]); }}
                                    title={`Send ${basename(id)} home (carrel.release)`}>↩</span>
                            </div>
                        ))}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}
