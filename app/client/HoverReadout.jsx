import React, { useEffect, useRef, useState } from 'react';
/** @import { AppClient } from './CommandProvider.jsx' */

/**
 * HoverReadout — what an agent book IS and what it's DOING, beside the cursor while it
 * rests on that book (its cover or any of its pages). One-way state→view: it reads the
 * attention HOVER slot + the registry entry under it, asks AgentBooks.readout (the same
 * source the 3D nameplate and the Agents panel rows read), and owns no behavior — no
 * verbs, no pointer capture (pointer-events: none).
 *
 *   ● name                                    ~id
 *   status · step N · age ago · sheet h/n live
 *   verb  the current call
 *   where it runs (cwd · type · model · branch · backend · parent)
 *   this page: verb  head  (L…–… framed)       ← when the hovered page isn't the newest
 *
 * Re-reads on hover changes, on AgentBooks changes, and once a second (ages move).
 * Text wraps; nothing is cut.
 */

const OFFSET = 16;   // px from the cursor

function read(client) {
    const ctx = client?.ctx;
    const am = ctx?.attentionManager, reg = ctx?.registry, books = ctx?.agentBooks;
    const id = am?.get?.('hover')?.id;
    if (!id || !reg || !books) return null;
    const entry = reg.get(id);
    if (!entry) return null;
    const m = entry.meta || {};
    // A page card carries its lane id; the cover's entry IS the Book (the resolver matches
    // the object). Anything else isn't an agent book.
    const ref = m.agentId ?? (entry.type === 'book' && entry.role === 'agent' ? entry.grid : null);
    if (ref == null) return null;
    const r = books.readout(ref, m.sheetId);
    if (!r) return null;
    const lane = books.lanes.get(r.agentId);
    const pal = books.cfg.palette;
    const hex = lane ? pal[lane.hueIdx % pal.length] : 0x8090b0;
    return { ...r, color: '#' + ((hex >>> 0) & 0xffffff).toString(16).padStart(6, '0') };
}

/** @param {{ client: AppClient | null }} props */
export default function HoverReadout({ client }) {
    const [r, setR] = useState(null);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const rootRef = useRef(null);
    const posRef = useRef({ x: 0, y: 0 });
    const shownRef = useRef(false);   // only a SHOWN card re-renders on pointer moves

    useEffect(() => {
        if (!client) return undefined;
        const refresh = () => {
            const next = read(client);
            shownRef.current = !!next;
            if (next) setPos(posRef.current);
            setR(next);
        };
        const am = client.ctx?.attentionManager;
        const offHover = am?.on?.('change:hover', refresh);
        const offBooks = client.ctx?.agentBooks?.onChange?.(refresh);
        const iv = setInterval(refresh, 1000);
        const move = (e) => {
            posRef.current = { x: e.clientX, y: e.clientY };
            if (shownRef.current) setPos(posRef.current);
        };
        window.addEventListener('pointermove', move, { passive: true });
        refresh();
        return () => { offHover?.(); offBooks?.(); clearInterval(iv); window.removeEventListener('pointermove', move); };
    }, [client]);

    if (!r) return null;
    // Keep the card on screen: flip to the cursor's other side near the right/bottom edges.
    const w = rootRef.current?.offsetWidth ?? 320, h = rootRef.current?.offsetHeight ?? 90;
    const left = pos.x + OFFSET + w > window.innerWidth ? Math.max(0, pos.x - OFFSET - w) : pos.x + OFFSET;
    const top = pos.y + OFFSET + h > window.innerHeight ? Math.max(0, pos.y - OFFSET - h) : pos.y + OFFSET;
    const age = r.age ? (r.age === 'now' ? 'now' : `${r.age} ago`) : null;
    const p = r.page;
    const row1 = [r.status, r.step ? `step ${r.step}` : null, age,
        p?.count ? `sheet ${p.head + 1}/${p.count}${p.following ? ' live' : ''}` : null].filter(Boolean).join(' · ');
    const s = r.sheet;
    const showSheet = s && p && s.index !== p.count - 1;
    const win = s?.window ? ` (L${s.window.first + 1}–${s.window.last + 1} framed)` : '';

    return (
        <div ref={rootRef} data-g3d-hover-readout style={{ ...S.card, left, top, borderLeft: `3px solid ${r.color}` }}>
            <div style={S.head}>
                <span style={{ color: r.color }}>●</span>
                <span style={S.name}>{r.name}</span>
                <span style={S.id}>~{r.agentId}</span>
            </div>
            <div style={S.status}>{row1}{r.beacon ? <span style={S.beacon}> · needs you: {r.beacon}</span> : null}</div>
            {r.action && <div style={S.action}>{r.action}</div>}
            {r.where && <div style={S.where}>{r.where}</div>}
            {showSheet && <div style={S.sheet}>this page: {[s.verb, s.head].filter(Boolean).join('  ')}{win}</div>}
        </div>
    );
}

const S = {
    card: {
        position: 'fixed', zIndex: 30, pointerEvents: 'none', maxWidth: 440,
        font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
        background: 'rgba(10,12,16,0.88)', color: '#aebccb',
        border: '1px solid #283341', borderRadius: 6, padding: '6px 9px',
        boxShadow: '0 4px 18px rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    },
    head: { display: 'flex', gap: 6, alignItems: 'baseline' },
    name: { color: '#e6eaf0', fontWeight: 600, flex: '1 1 auto' },
    id: { color: '#4a5468', fontSize: 10 },
    status: { color: '#8fa0b8', fontSize: 11 },
    beacon: { color: '#f2a25c' },
    action: { color: '#dfe3ea' },
    where: { color: '#5a6472', fontSize: 11 },
    sheet: { color: '#8a92a0', fontSize: 11, borderTop: '1px solid #1c222c', marginTop: 3, paddingTop: 3 },
};
