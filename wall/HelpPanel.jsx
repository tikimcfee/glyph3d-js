import { useEffect, useMemo, useRef, useState } from 'react';
import { chordLabel, isChord } from './chord.js';
import { DockButtons, useHeadDrag, dockLayout, DOCK_WIDTHS } from './Panel.jsx';
import { KEYMAP, PLAIN_KEYS, HELP_SECTIONS, chordText, gestures } from './wallKeymap.js';

const C = { border: '#2a303c', text: '#c8ced8', muted: '#6b7383', label: '#d4d9e2', key: '#8ab4f8', field: '#0b0d13' };

/**
 * Every row the help holds: the chords (wallKeymap.KEYMAP — what WallKeys dispatches), the plain keys
 * and the gestures under their sections, then every verb the router holds (`help`'s own list), so
 * nothing here can say what the wall doesn't do.
 * @param {{ router: { listCommands(): { name: string, usage: string, description: string }[] }, config: { zoomKeys: string } }} wall
 * @returns {{ id: string, title: string, rows: { how: string, does: string }[] }[]}
 */
export function helpSections(wall) {
    const rows = (id) => [
        ...KEYMAP.filter((c) => c.section === id).map((c) => ({ how: chordText(c), does: c.does })),
        ...PLAIN_KEYS.filter((k) => k.section === id).map((k) => ({ how: k.key, does: k.does })),
        ...gestures(wall.config).filter((g) => g.section === id).map((g) => ({ how: g.how, does: g.does })),
    ];
    const verbs = wall.router.listCommands().map((c) => ({ how: c.usage ? `${c.name} ${c.usage}` : c.name, does: c.description }));
    return [
        ...HELP_SECTIONS.map((s) => ({ id: s.id, title: s.title, rows: rows(s.id) })),
        { id: 'verbs', title: 'Verbs (palette or ./glyph3d-cli)', rows: verbs },
    ];
}

/** The sections with only the rows holding every word of `query` (in `how` or `does`); empty ones go. */
export function searchHelp(sections, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return sections;
    return sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => { const t = `${r.how} ${r.does} ${s.title}`.toLowerCase(); return words.every((w) => t.includes(w)); }) }))
        .filter((s) => s.rows.length);
}

/**
 * The help panel — the wall's keys, gestures and verbs, searchable (every word must match
 * somewhere). Opening it puts the keys in the search box; Escape clears the search, then closes;
 * the chord + / toggles it. Floats or docks like the other panels (Panel.jsx); open, side and spot
 * persist per relay. Toggled by the chord + /, the topbar's ?, the palette or `wall.help`.
 */
export default function HelpPanel({ wall, state }) {
    const hp = state.helpPanel;
    const boxRef = useRef(null);
    const searchRef = useRef(null);
    const { dragAt, onHeadDown } = useHeadDrag(wall, 'wall.help', hp.side, boxRef);
    const [query, setQuery] = useState('');
    const all = useMemo(() => helpSections(wall), [wall, state.config.zoomKeys, hp.open]);
    const shown = useMemo(() => searchHelp(all, query), [all, query]);

    useEffect(() => { if (hp.open) searchRef.current?.focus(); }, [hp.open]);
    if (!hp.open) return null;

    const onSearchKey = (e) => {
        if (isChord(e) && e.code === 'Slash') { e.preventDefault(); wall.run(['wall.help', 'close']); return; }
        if (e.key === 'Escape') { e.preventDefault(); if (query) setQuery(''); else wall.run(['wall.help', 'close']); }
    };
    const floatAt = dragAt ?? hp.float;
    const box = hp.side === 'float'
        ? { ...(floatAt ? { left: floatAt.x, top: floatAt.y } : { right: 12, top: 46 }), maxHeight: 'calc(100% - 120px)', borderRadius: 7, border: `1px solid ${C.border}`, width: DOCK_WIDTHS.help, maxWidth: 'calc(100vw - 32px)' }
        : { top: 0, bottom: 0, [hp.side]: dockLayout(state).help, width: DOCK_WIDTHS.help, [hp.side === 'left' ? 'borderRight' : 'borderLeft']: `1px solid ${C.border}` };

    return (
        <div ref={boxRef} data-help="" data-side={hp.side} style={{ ...styles.panel, ...box }}>
            <div style={{ ...styles.head, cursor: hp.side === 'float' ? 'move' : 'default' }} onPointerDown={onHeadDown}>
                <span style={{ flex: 1, color: C.muted }}>help</span>
                <DockButtons wall={wall} verb="wall.help" side={hp.side} close={{ title: `close (${chordLabel(['/'])})`, action: 'close-help' }} />
            </div>
            <input ref={searchRef} data-help-search="" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
                placeholder="search keys, gestures, verbs…" spellCheck={false} style={styles.search} />
            <div style={styles.body}>
                {shown.map((s) => (
                    <div key={s.id} data-help-section={s.id}>
                        <div style={styles.sectionHead}>{s.title}</div>
                        {s.rows.map((r, i) => (
                            <div key={i} data-help-row="" style={s.id === 'verbs' ? styles.verbRow : styles.row}>
                                <span style={s.id === 'verbs' ? styles.verb : styles.how}>{r.how}</span>
                                <span style={styles.does}>{r.does}</span>
                            </div>
                        ))}
                    </div>
                ))}
                {!shown.length && <div style={{ ...styles.row, color: C.muted }}>nothing matches “{query}”</div>}
            </div>
        </div>
    );
}

const styles = {
    panel: {
        position: 'absolute', zIndex: 7, display: 'flex', flexDirection: 'column', background: 'rgba(14, 17, 24, 0.97)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.45)', font: '12px ui-monospace, SFMono-Regular, Menlo, monospace', color: C.text,
        boxSizing: 'border-box',
    },
    head: { display: 'flex', alignItems: 'center', gap: 2, padding: '5px 6px 5px 10px', borderBottom: '1px solid #1e2430', userSelect: 'none' },
    search: {
        margin: '8px 10px 4px', padding: '6px 8px', background: C.field, color: '#e6e9ef', border: `1px solid ${C.border}`,
        borderRadius: 5, outline: 'none', font: 'inherit', fontSize: 12.5,
    },
    body: { overflowY: 'auto', padding: '2px 0 10px', flex: '1 1 auto' },
    sectionHead: { color: C.label, padding: '10px 10px 4px', userSelect: 'none' },
    row: { display: 'flex', gap: 10, padding: '3px 10px 3px 16px', lineHeight: 1.4 },
    how: { flex: '0 0 140px', color: C.key },
    does: { flex: '1 1 auto', color: '#9aa3b2', minWidth: 0 },
    verbRow: { display: 'flex', flexDirection: 'column', padding: '3px 10px 4px 16px', lineHeight: 1.35 },
    verb: { color: C.key, wordBreak: 'break-word' },
};
