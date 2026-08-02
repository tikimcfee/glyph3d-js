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
 * THE SEAT MENU — right-click a desk row (or its ⊕) for a categorized picker of
 * everything hostable: open files, terminals, agent books, frames. Each item is
 * a TOGGLE — seated here shows ✓ and clicks release; free shows · and clicks
 * seat; ⚓ marks a docked window (clicking adopts it out of the bar, home record
 * handed over); “⇢ desk” marks one seated at another desk (clicking moves it
 * here). The menu STAYS OPEN across clicks — rapid multi-seat is the point —
 * and closes on backdrop click.
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

    // -- the seat menu: a fixed popover over everything; backdrop click closes --
    backdrop: { position: 'fixed', inset: 0, zIndex: 1000 },
    menu: (x, y) => ({
        position: 'fixed', zIndex: 1001,
        left: Math.min(x, (window.innerWidth || 1280) - 280), top: Math.min(y, (window.innerHeight || 800) - 340),
        width: 260, maxHeight: 320, overflowY: 'auto',
        background: 'rgba(12,15,21,0.97)', border: '1px solid #262c38', borderRadius: 4,
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)', padding: '4px 0',
        font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace',
    }),
    menuTitle: {
        padding: '3px 10px 5px', color: '#7c8596', fontSize: 11,
        borderBottom: '1px solid #1b1f29', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    },
    menuSect: {
        padding: '4px 10px 1px', color: '#5a616c', fontSize: 10,
        letterSpacing: '0.08em', textTransform: 'uppercase',
    },
    menuItem: {
        display: 'flex', alignItems: 'center', gap: 7, padding: '2px 10px',
        cursor: 'pointer', userSelect: 'none', color: '#c8ccd6',
    },
    mark: (seated) => ({ flex: '0 0 auto', width: 14, textAlign: 'center', color: seated ? '#7ad79a' : '#5a616c', fontSize: 11 }),
    mlabel: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    mwhere: { flex: '0 0 auto', color: '#5a616c', fontSize: 10, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    menuEmpty: { padding: '8px 10px', color: '#7c8596' },
    seat: { flex: '0 0 auto', cursor: 'pointer', color: '#5a616c', padding: '0 2px' },
};

const basename = (p) => {
    const s = String(p || '').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
};

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

/**
 * Everything hostable, categorized — a fresh snapshot each render while the menu
 * is open. Registry surfaces by type (volumes excluded — they're per-pass
 * presentation objects, not seatable windows) + the agent shelf's lanes.
 */
function hostableSections(ctx) {
    const entries = ctx?.registry?.list?.() || [];
    const surf = (type) => entries
        .filter((en) => en.type === type && !String(en.id).startsWith('vol:'))
        .map((en) => ({ id: en.id, label: basename(en.id) }));
    const agents = (ctx?.agentBooks?.agents?.() || [])
        .map((a) => ({ id: a.id, label: a.id, color: a.color }));
    return [
        { key: 'files', label: 'files', items: surf('grid') },
        { key: 'terminals', label: 'terminals', items: surf('terminal') },
        { key: 'agents', label: 'agent books', items: agents },
        { key: 'frames', label: 'frames', items: surf('frame') },
    ].filter((s) => s.items.length);
}

export default function CarrelsPanel({ client }) {
    const [desks, setDesks] = useState([]);
    /** Open seat menu: { desk, x, y } | null. */
    const [menu, setMenu] = useState(null);

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

    const openMenu = useCallback((e, desk) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ desk, x: e.clientX, y: e.clientY });
    }, []);

    // A dissolved desk must not keep a live menu aimed at it.
    useEffect(() => {
        if (menu && !desks.some((d) => d.name === menu.desk)) setMenu(null);
    }, [menu, desks]);

    // The toggle: seated at THIS desk → release home; anywhere else (free, docked,
    // another desk) → carrel.add, which adopts/moves with the home-record handoff.
    const toggleSeat = useCallback((id, seatedHere) => {
        after(seatedHere ? ['carrel.release', id] : ['carrel.add', id, menu?.desk]);
    }, [after, menu]);

    const seatedAt = new Map();
    for (const d of desks) for (const id of d.members) seatedAt.set(id, d.name);

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
                        <div style={S.deskRow(d.active)} data-desk={d.name}
                            onClick={() => after(['carrel.focus', d.name])}
                            onContextMenu={(e) => openMenu(e, d.name)}
                            title={`${d.name} — fly to it and make it active (carrel.focus); right-click to seat things`}>
                            <span style={{ ...S.dot, color: d.glow }}>●</span>
                            <span style={S.name}>{d.name}</span>
                            {d.dissolving && <span style={S.fading}>folding…</span>}
                            <span style={S.count}>{d.members.length}</span>
                            <span style={S.seat}
                                onClick={(e) => openMenu(e, d.name)}
                                title={`Seat things at ${d.name} — files, terminals, agent books`}>⊕</span>
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

            {menu && (() => {
                const sections = hostableSections(client?.ctx);
                const docked = (id) => !!client?.ctx?.cameraDock?.has?.(id);
                return (<>
                    <div style={S.backdrop} onClick={() => setMenu(null)}
                        onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
                    <div style={S.menu(menu.x, menu.y)}>
                        <div style={S.menuTitle}>seat at {menu.desk}</div>
                        {sections.length === 0 && (
                            <div style={S.menuEmpty}>nothing hostable — open files, terminals, or summon agents first</div>
                        )}
                        {sections.map((sec) => (
                            <React.Fragment key={sec.key}>
                                <div style={S.menuSect}>{sec.label}</div>
                                {sec.items.map((it) => {
                                    const here = seatedAt.get(it.id) === menu.desk;
                                    const elsewhere = !here ? seatedAt.get(it.id) : null;
                                    const mark = here ? '✓' : docked(it.id) ? '⚓' : '·';
                                    return (
                                        <div key={it.id} style={S.menuItem} data-seat-item={it.id}
                                            onClick={() => toggleSeat(it.id, here)}
                                            title={here ? `Seated here — click to send home (carrel.release)`
                                                : elsewhere ? `Seated at ${elsewhere} — click to move here (carrel.add)`
                                                : docked(it.id) ? `Docked — click to adopt it out of the bar (carrel.add)`
                                                : `Click to seat at ${menu.desk} (carrel.add)`}>
                                            <span style={S.mark(here)}>{mark}</span>
                                            <span style={{ ...S.mlabel, ...(it.color ? { color: it.color } : {}) }}>{it.label}</span>
                                            {elsewhere && <span style={S.mwhere}>⇢ {elsewhere}</span>}
                                        </div>
                                    );
                                })}
                            </React.Fragment>
                        ))}
                    </div>
                </>);
            })()}
        </div>
    );
}
