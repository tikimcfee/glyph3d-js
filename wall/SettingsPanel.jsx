import { useEffect, useMemo, useRef, useState } from 'react';
import { chordLabel, isChord } from './chord.js';
import { Btn, DockButtons, useHeadDrag, dockLayout, DOCK_WIDTHS } from './Panel.jsx';
import { searchSettings } from './wallSettings.js';

const C = {
  border: '#2a303c', text: '#c8ced8', muted: '#6b7383', label: '#d4d9e2', accent: '#8ab4f8',
  on: '#6ee7a0', err: '#e5534b', mark: '#e3b341', active: '#18202d', field: '#0b0d13',
};

/** `text` with its hit ranges marked. @param {{ text: string, hits: [number, number][] }} p */
function Marked({ text, hits }) {
  if (!hits.length) return <>{text}</>;
  const out = [];
  let at = 0;
  for (const [a, b] of hits) {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a} data-hit="" style={styles.mark}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * A text field that commits through `onCommit` on Enter or blur and gives the keyboard back to the
 * search on Enter or Escape (Escape drops the draft). It shows the knob's value whenever it isn't
 * being edited.
 */
function Field({ id, value, onCommit, back, style, ...rest }) {
  const [draft, setDraft] = useState(null);
  // The draft as typed, read by commit: Enter commits and then moves the keys (a blur), and the blur
  // must not commit the same draft again.
  const live = useRef(null);
  const edit = (v) => { live.current = v; setDraft(v); };
  const commit = () => {
    const d = live.current;
    edit(null);
    if (d != null && d !== String(value)) onCommit(d);
  };
  return (
    <input
      data-field={id}
      value={draft ?? String(value)}
      onChange={(e) => edit(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); back(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); edit(null); back(); }
      }}
      spellCheck={false}
      style={{ ...styles.field, ...style }}
      {...rest}
    />
  );
}

/** One knob's control, by its type; every change is a `wall.config` verb. */
function Control({ k, def, value, set, back }) {
  if (def.type === 'bool') {
    return (
      <button data-control="bool" aria-pressed={value} tabIndex={-1} onMouseDown={(e) => e.preventDefault()}
        onClick={() => set(String(!value))} style={{ ...styles.toggle, ...(value ? styles.toggleOn : null) }}>
        <span style={{ ...styles.knob, ...(value ? styles.knobOn : null) }} />
      </button>
    );
  }
  if (def.type === 'enum') {
    return (
      <span data-control="enum" style={styles.seg}>
        {def.options.map((o) => (
          <Btn key={o} data-option={o} on={o === value} onClick={() => set(o)} style={styles.segBtn}>{o}</Btn>
        ))}
      </span>
    );
  }
  if (def.type === 'color') {
    return (
      <span data-control="color" style={styles.colorRow}>
        <input type="color" value={value} tabIndex={-1} onChange={(e) => set(e.target.value)} style={styles.swatch} />
        <Field id={k} value={value} onCommit={set} back={back} style={{ width: 70 }} />
      </span>
    );
  }
  if (def.type === 'text') {
    return (
      <span data-control="text" style={styles.colorRow}>
        <Field id={k} value={value} onCommit={set} back={back} placeholder="(none)" style={{ width: 150 }} />
      </span>
    );
  }
  return (
    <span data-control="number" style={styles.colorRow}>
      <Field id={k} value={value} onCommit={set} back={back} inputMode="decimal" style={{ width: 64, textAlign: 'right' }} />
      {def.unit && <span style={styles.unit}>{def.unit}</span>}
    </span>
  );
}

/**
 * The settings panel — every wall knob (wallSettings.KNOBS), in sections, searchable. Typing filters
 * the knobs by label, key, description and section title (every word must match somewhere): matching
 * sections open, the rest go, and the words are marked where they hit. Keyboard first: opening the
 * panel puts the keys in the search box; ↑/↓ choose a knob, Enter flips a switch, steps a choice or
 * puts the keys in its field (Enter there sets it and comes back; Escape drops the edit); Escape
 * clears the search, then closes. Every edit runs `wall.config <knob> <value>` (↺ runs `… default`),
 * so a refused value is the verb's own refusal, shown under its knob. Without a search a section
 * folds by its title (`wall.settings.collapse`). Floats or docks like the sidebar (Panel.jsx); open,
 * side, spot and folds persist per relay, and so do the knobs. Toggled by the chord + `,`, the
 * topbar, the palette or `wall.settings`.
 */
export default function SettingsPanel({ wall, state }) {
  const sp = state.settingsPanel;
  const boxRef = useRef(null);
  const searchRef = useRef(null);
  const { dragAt, onHeadDown } = useHeadDrag(wall, 'wall.settings', sp.side, boxRef);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** A refusal per knob, from the last edit of it. @type {[Record<string, string>, Function]} */
  const [refused, setRefused] = useState({});
  const groups = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim() !== '';
  const folded = (id) => !searching && sp.collapsed.includes(id);
  const keys = groups.flatMap((g) => (folded(g.section.id) ? [] : g.items.map((it) => it.key)));
  const at = Math.min(active, Math.max(0, keys.length - 1));

  useEffect(() => { if (sp.open) searchRef.current?.focus(); }, [sp.open]);
  useEffect(() => {
    boxRef.current?.querySelector(`[data-setting="${keys[at]}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at, keys[at]]);
  if (!sp.open) return null;

  const back = () => searchRef.current?.focus();
  const set = (key) => async (value) => {
    const r = await wall.run(['wall.config', key, value]);
    setRefused((m) => {
      const next = { ...m };
      if (r.text.startsWith('ERR')) next[key] = r.text.replace(/^ERR:\s*/, ''); else delete next[key];
      return next;
    });
  };
  const activate = (key) => {
    if (!key) return;
    const def = groups.flatMap((g) => g.items).find((it) => it.key === key).def;
    const v = state.config[key];
    if (def.type === 'bool') set(key)(String(!v));
    else if (def.type === 'enum') set(key)(def.options[(def.options.indexOf(v) + 1) % def.options.length]);
    else {
      const el = /** @type {HTMLInputElement|null} */ (boxRef.current?.querySelector(`[data-field="${key}"]`));
      el?.focus();
      el?.select();
    }
  };
  const onSearchKey = (e) => {
    if (isChord(e) && e.code === 'Comma') { e.preventDefault(); wall.run(['wall.settings', 'close']); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(keys.length - 1, at + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, at - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(keys[at]); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) { setQuery(''); setActive(0); } else wall.run(['wall.settings', 'close']);
    }
  };

  const floatAt = dragAt ?? sp.float;
  const box = sp.side === 'float'
    ? { ...(floatAt ? { left: floatAt.x, top: floatAt.y } : { right: 12, top: 46 }), maxHeight: 'calc(100% - 120px)', borderRadius: 7, border: `1px solid ${C.border}`, width: DOCK_WIDTHS.settings, maxWidth: 'calc(100vw - 32px)' }
    : { top: 0, bottom: 0, [sp.side]: dockLayout(state).settings, width: DOCK_WIDTHS.settings, [sp.side === 'left' ? 'borderRight' : 'borderLeft']: `1px solid ${C.border}` };

  return (
    <div ref={boxRef} data-settings="" data-side={sp.side} style={{ ...styles.panel, ...box }}>
      <div style={{ ...styles.head, cursor: sp.side === 'float' ? 'move' : 'default' }} onPointerDown={onHeadDown}>
        <span style={{ flex: 1, color: C.muted }}>settings</span>
        <DockButtons wall={wall} verb="wall.settings" side={sp.side} close={{ title: `close (${chordLabel([','])})`, action: 'close-settings' }} />
      </div>
      <input
        ref={searchRef}
        data-settings-search=""
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={onSearchKey}
        placeholder="search settings…"
        spellCheck={false}
        style={styles.search}
      />
      <div style={styles.body}>
        {groups.map((g) => {
          const id = g.section.id, isFolded = folded(id);
          return (
            <div key={id} data-section={id} data-folded={isFolded ? '' : undefined}>
              <div style={styles.sectionHead} onClick={() => { if (!searching) wall.run(['wall.settings.collapse', id]); }}>
                <span style={styles.fold}>{searching ? '' : isFolded ? '▸' : '▾'}</span>
                <span style={{ color: C.label }}><Marked text={g.section.title} hits={g.title} /></span>
                <span style={styles.sub}>{g.section.subtitle}</span>
                {searching && <span style={styles.count}>{g.items.length}</span>}
              </div>
              {!isFolded && g.items.map((it) => {
                const isActive = it.key === keys[at];
                const dialled = state.dialled.includes(it.key);
                return (
                  <div key={it.key} data-setting={it.key} data-active={isActive ? '' : undefined}
                    onMouseEnter={() => setActive(keys.indexOf(it.key))}
                    style={{ ...styles.item, background: isActive ? C.active : undefined }}>
                    <div style={styles.row}>
                      <span style={styles.label}><Marked text={it.def.label} hits={it.hits.label} /></span>
                      {dialled && <Btn title="back to the default" data-action="reset" onClick={() => set(it.key)('default')}>↺</Btn>}
                      <Control k={it.key} def={it.def} value={state.config[it.key]} set={set(it.key)} back={back} />
                    </div>
                    <div style={styles.desc}><Marked text={it.def.description} hits={it.hits.description} /></div>
                    <div style={styles.key}><Marked text={it.key} hits={it.hits.key} /></div>
                    {refused[it.key] && <div data-refused="" style={styles.refused}>{refused[it.key]}</div>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!groups.length && <div style={{ ...styles.item, color: C.muted }}>no setting matches “{query}”</div>}
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
  body: { overflowY: 'auto', padding: '2px 0 8px', flex: '1 1 auto' },
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: 6, padding: '8px 10px 4px', cursor: 'pointer', userSelect: 'none' },
  fold: { color: C.muted, width: 10, flex: '0 0 auto' },
  sub: { color: C.muted, fontSize: 11, flex: '1 1 auto', minWidth: 0 },
  count: { color: C.muted, fontSize: 11 },
  item: { padding: '5px 10px 6px 26px' },
  row: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 },
  label: { flex: '1 1 auto', color: C.label, minWidth: 0 },
  desc: { color: '#8b95a7', fontSize: 11, lineHeight: 1.4, marginTop: 2 },
  key: { color: '#4f5767', fontSize: 10.5, marginTop: 1 },
  refused: { color: C.err, fontSize: 11, marginTop: 2 },
  mark: { background: 'transparent', color: C.mark, textDecoration: 'underline', textUnderlineOffset: 2 },
  field: {
    padding: '2px 5px', background: C.field, color: '#e6e9ef', border: `1px solid ${C.border}`, borderRadius: 4,
    outline: 'none', font: 'inherit', fontSize: 12,
  },
  unit: { color: C.muted, fontSize: 10.5, maxWidth: 80 },
  colorRow: { display: 'flex', alignItems: 'center', gap: 5, flex: '0 0 auto' },
  swatch: { width: 22, height: 20, padding: 0, border: `1px solid ${C.border}`, borderRadius: 3, background: 'transparent', cursor: 'pointer' },
  toggle: {
    width: 30, height: 16, borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: C.border, background: '#1a1f2a', position: 'relative',
    cursor: 'pointer', padding: 0, flex: '0 0 auto',
  },
  toggleOn: { background: '#1d3a2b', borderColor: '#2f6b4b' },
  knob: { position: 'absolute', top: 2, left: 2, width: 10, height: 10, borderRadius: 5, background: '#6b7383' },
  knobOn: { left: 16, background: C.on },
  seg: { display: 'flex', gap: 2, flex: '0 0 auto' },
  segBtn: { width: 'auto', padding: '0 6px' },
};
