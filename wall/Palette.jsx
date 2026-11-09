import React, { useEffect, useMemo, useRef, useState } from 'react';

/** Subsequence match score: lower is better, null when `q` isn't a subsequence of `s`. */
function score(q, s) {
  if (!q) return 0;
  const a = q.toLowerCase();
  const b = s.toLowerCase();
  let j = 0, gaps = 0, last = -1;
  for (let i = 0; i < b.length && j < a.length; i++) {
    if (b[i] === a[j]) { if (last >= 0) gaps += i - last - 1; last = i; j++; }
  }
  return j === a.length ? gaps : null;
}

/**
 * The floating find-by-name palette. FIND mode: type to filter terminals (by name, id and last
 * screen line), ↑/↓ to choose, Enter to focus + frame, Esc to close; actions ride along (new
 * terminal, fit all, rename the focused terminal). RENAME mode: the input edits the focused
 * terminal's name — Enter saves, an empty name goes back to the shell's title.
 */
export default function Palette({ wall, state, onClose }) {
  const [mode, setMode] = useState('find');
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, [mode]);

  const focused = state.terminals.find((t) => t.id === state.focusedId) || null;

  const items = useMemo(() => {
    if (mode !== 'find') return [];
    const terms = state.terminals
      .map((t) => ({
        kind: 'terminal', id: t.id, label: t.name,
        detail: [t.name !== t.id ? t.id : null, t.preview].filter(Boolean).join(' · '),
        s: score(query, `${t.name} ${t.id} ${t.preview}`),
      }))
      .filter((t) => t.s != null)
      .sort((x, y) => x.s - y.s);
    const actions = [
      { kind: 'action', id: 'spawn', label: '+ new terminal', detail: '⌘⇧↵', run: () => { wall.spawn(); onClose(); } },
      { kind: 'action', id: 'fit', label: 'fit all', detail: '⌘0', run: () => { wall.fitAll(); onClose(); } },
      focused && {
        kind: 'action', id: 'rename', label: `rename "${focused.name}"…`, detail: 'focused terminal',
        run: () => { setMode('rename'); setQuery(focused.named ? focused.name : ''); },
      },
    ].filter(Boolean).filter((a) => score(query, a.label) != null);
    return [...terms, ...actions];
  }, [mode, query, state, wall, focused, onClose]);

  const choose = (item) => {
    if (!item) return;
    if (item.kind === 'terminal') { wall.focus(item.id, { frame: true }); onClose(); }
    else item.run();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (mode === 'rename') {
      if (e.key === 'Enter') { e.preventDefault(); wall.rename(focused.id, query); onClose(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[Math.min(index, items.length - 1)]); }
  };

  return (
    <div style={styles.scrim} onMouseDown={onClose}>
      <div style={styles.box} onMouseDown={(e) => e.stopPropagation()}>
        {mode === 'rename' && <div style={styles.caption}>rename {focused?.id} — empty uses the shell's title</div>}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={onKeyDown}
          placeholder={mode === 'rename' ? (focused?.name ?? '') : 'find a terminal…'}
          style={styles.input}
        />
        {mode === 'find' && (
          <div>
            {items.map((it, i) => (
              <div
                key={`${it.kind}:${it.id}`}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={() => choose(it)}
                style={{ ...styles.row, background: i === index ? '#1b2130' : 'transparent' }}
              >
                <span style={{ color: it.kind === 'action' ? '#8ab4f8' : '#e6e9ef' }}>{it.label}</span>
                <span style={styles.detail}>{it.detail}</span>
              </div>
            ))}
            {!items.length && <div style={{ ...styles.row, color: '#6b7383' }}>no match</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  scrim: { position: 'absolute', inset: 0, zIndex: 20, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '14vh' },
  box: {
    width: 'min(560px, calc(100vw - 32px))', background: '#0e1118', border: '1px solid #2a303c',
    borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.6)', overflow: 'hidden',
  },
  caption: { padding: '8px 12px 0', color: '#6b7383' },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', background: '#0b0d13', color: '#e6e9ef',
    border: 'none', borderBottom: '1px solid #2a303c', outline: 'none', font: 'inherit', fontSize: 14,
  },
  row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 12px', cursor: 'pointer' },
  detail: { color: '#6b7383', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' },
};
