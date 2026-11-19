import { useEffect, useMemo, useRef, useState } from 'react';
import { chordLabel } from './chord.js';
import FitText from './FitText.jsx';
import { busStatus, busAttachable } from './WallBus.js';

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

/** A group's layout in a few words. */
const layoutText = (g) => (g.layout === 'tile' ? `tile · ${g.columns} col${g.columns === 1 ? '' : 's'}` : 'freeform');

/** Extract `<val>` when a user types `wall.token <val>` or pastes a `#token=…` URL/fragment in find mode. */
function directTokenInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cmdMatch = trimmed.match(/^wall(?:\.|\s+)token\s+(.+)$/i);
  if (cmdMatch) return cmdMatch[1].trim();
  if (/#(?:[^#\s]*[&;])?token=/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * The floating find-by-name palette — the omnibar. FIND mode lists every terminal, shown or hidden
 * (marked), under its group: with no query, as the tree (each group, then its members, then the
 * terminals in no group); typing filters terminals (by name, id, group and last screen line) and
 * groups (by name), best first; then the gomuxai agents the relay sees (WallBus: `name`, or `name@host`
 * on another host), whose Enter attaches (wall.attach — the agent's terminal if one is attached, else
 * a new one running `agent attach`). ↑/↓ choose, Enter: a terminal is revealed (shown if hidden, focused,
 * framed), a group framed. Actions ride along — new terminal, fit all, the sidebar, the settings,
 * snapping, the grid, setting the relay token, and for the focused terminal and the selection: hide, close, rename, group,
 * add to / take out of a group, ungroup, tile columns, layout. RENAME mode edits the name of the terminal or group that rename
 * began on (focus may move meanwhile) — Enter saves, an empty name goes back to the default; if it
 * goes away, rename mode ends. TOKEN mode accepts a raw capability token or `#token=…` URL and connects.
 * Every choice runs a wall verb.
 */
export default function Palette({ wall, state, onClose, initialMode = 'find' }) {
  const relayPort = wall?.bridge?.port ?? wall?._relayPort
    ?? (typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('relay')) || 8080 : 8080);
  const [mode, setMode] = useState(initialMode);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  /** What rename edits: { kind: 'terminal'|'group', id }. */
  const [renameOf, setRenameOf] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { setMode(initialMode); setQuery(''); setIndex(0); }, [initialMode]);
  useEffect(() => { inputRef.current?.focus(); }, [mode]);

  const termById = useMemo(() => new Map(state.terminals.map((t) => [t.id, t])), [state]);
  const groupById = useMemo(() => new Map(state.groups.map((g) => [g.id, g])), [state]);
  const focused = termById.get(state.focusedId) || null;
  const target = mode !== 'rename' || !renameOf ? null
    : renameOf.kind === 'group' ? groupById.get(renameOf.id) || null : termById.get(renameOf.id) || null;
  useEffect(() => {
    if (mode === 'rename' && !target) { setMode('find'); setQuery(''); setIndex(0); }
  }, [mode, target]);

  const items = useMemo(() => {
    if (mode !== 'find') return [];
    const run = (cmd, close = true) => () => { wall.run(cmd); if (close) onClose(); };
    const termItem = (t, depth) => ({
      kind: 'terminal', id: t.id, label: t.name, depth, hidden: t.hidden,
      detail: [t.hidden ? 'hidden' : null, t.name !== t.id ? t.id : null, t.preview].filter(Boolean).join(' · '),
    });
    const groupItem = (g) => ({ kind: 'group', id: g.id, label: g.name, depth: 0, detail: `${g.members.length} · ${layoutText(g)}` });

    const attachedTo = new Map();
    for (const t of state.terminals) if (t.attached) attachedTo.set(t.attached, t.id);
    const agentItems = [];
    for (const h of state.bus.hosts) {
      for (const a of h.agents) {
        const on = attachedTo.get(a.target);
        agentItems.push({
          kind: 'agent', id: a.target, label: a.target, depth: 0, status: a.status, dim: !busAttachable(a),
          detail: [busStatus(a.status).word, on ? `on ${on}` : !busAttachable(a) ? 'no session' : null, a.detail].filter(Boolean).join(' · '),
          text: `${a.target} ${h.host} ${a.status ?? ''} ${a.detail ?? ''} ${a.cwd ?? ''}`,
        });
      }
    }

    let listed;
    if (!query) {
      listed = [];
      for (const g of state.groups) {
        listed.push(groupItem(g));
        for (const id of g.members) { const t = termById.get(id); if (t) listed.push(termItem(t, 1)); }
      }
      for (const t of state.terminals) if (!t.group) listed.push(termItem(t, 0));
      listed.push(...agentItems);
    } else {
      const scored = [];
      for (const t of state.terminals) {
        const g = t.group ? groupById.get(t.group) : null;
        const s = score(query, `${t.name} ${t.id} ${g ? g.name : ''} ${t.preview}`);
        if (s != null) scored.push({ ...termItem(t, 0), s, detail: [g ? `in ${g.name}` : null, termItem(t, 0).detail].filter(Boolean).join(' · ') });
      }
      for (const g of state.groups) {
        const s = score(query, g.name);
        if (s != null) scored.push({ ...groupItem(g), s });
      }
      for (const it of agentItems) {
        const s = score(query, it.text);
        if (s != null) scored.push({ ...it, s });
      }
      listed = scored.sort((x, y) => x.s - y.s);
    }

    const sel = state.selection;
    const fg = focused?.group ? groupById.get(focused.group) : null;
    const actions = [
      { id: 'spawn', label: '+ new terminal', detail: chordLabel(['↵'], { shift: true }), run: () => { wall.spawn(); onClose(); } },
      { id: 'fit', label: 'fit all', detail: chordLabel(['0']), run: () => { wall.fitAll(); onClose(); } },
      { id: 'sidebar', label: state.sidebar.open ? 'close the sidebar' : 'open the sidebar', detail: chordLabel(['B']), run: run(['wall.sidebar', 'toggle']) },
      { id: 'settings', label: state.settingsPanel.open ? 'close the settings' : 'open the settings', detail: chordLabel([',']), run: run(['wall.settings', 'toggle']) },
      { id: 'snap', label: state.config.snap ? 'stop snapping to the grid' : 'snap to the grid', detail: chordLabel(["'"]), run: run(['wall.snap', 'toggle']) },
      { id: 'grid', label: state.config.gridShow ? 'hide the grid' : 'show the grid', detail: chordLabel(["'"], { shift: true }), run: run(['wall.grid', 'toggle']) },
      { id: 'token', label: 'set relay token…', detail: `:${relayPort}`, run: () => { setMode('token'); setQuery(''); } },
      sel.length > 0 && { id: 'group-sel', label: `group the selection (${sel.length})`, detail: chordLabel(['G']), run: run(['wall.group']) },
      ...(sel.length > 0 ? state.groups.map((g) => ({ id: `add-sel:${g.id}`, label: `add the selection to "${g.name}"`, detail: g.id, run: run(['wall.group.add', g.id, ...sel]) })) : []),
      focused && {
        id: 'rename', label: `rename "${focused.name}"…`, detail: 'focused terminal',
        run: () => { setRenameOf({ kind: 'terminal', id: focused.id }); setMode('rename'); setQuery(focused.named ? focused.name : ''); },
      },
      focused && { id: 'hide', label: `hide "${focused.name}"`, detail: chordLabel(['-']), run: run(['wall.hide', focused.id]) },
      focused && { id: 'close', label: `close "${focused.name}" (kills its shell)`, detail: `hold ${chordLabel(['X'])}`, run: run(['wall.close', focused.id]) },
      focused && !fg && sel.length === 0 && { id: 'group-one', label: `group "${focused.name}"`, detail: chordLabel(['G']), run: run(['wall.group', focused.id]) },
      ...(focused && !fg ? state.groups.map((g) => ({ id: `add:${g.id}`, label: `add "${focused.name}" to "${g.name}"`, detail: g.id, run: run(['wall.group.add', g.id, focused.id]) })) : []),
      fg && { id: 'leave', label: `take "${focused.name}" out of "${fg.name}"`, detail: fg.id, run: run(['wall.group.remove', focused.id]) },
      fg && {
        id: 'rename-group', label: `rename group "${fg.name}"…`, detail: fg.id,
        run: () => { setRenameOf({ kind: 'group', id: fg.id }); setMode('rename'); setQuery(fg.named ? fg.name : ''); },
      },
      fg && fg.layout === 'tile' && { id: 'cols+', label: `"${fg.name}": tile in ${fg.columns + 1} columns`, detail: fg.id, run: run(['wall.group.columns', fg.id, '+1'], false) },
      fg && fg.layout === 'tile' && fg.columns > 1 && { id: 'cols-', label: `"${fg.name}": tile in ${fg.columns - 1} column${fg.columns - 1 === 1 ? '' : 's'}`, detail: fg.id, run: run(['wall.group.columns', fg.id, '-1'], false) },
      fg && { id: 'layout', label: `"${fg.name}": ${fg.layout === 'tile' ? 'freeform' : 'tile'}`, detail: fg.id, run: run(['wall.group.layout', fg.id, fg.layout === 'tile' ? 'freeform' : 'tile']) },
      fg && { id: 'ungroup', label: `ungroup "${fg.name}"`, detail: chordLabel(['G'], { shift: true }), run: run(['wall.ungroup', fg.id]) },
    ].filter(Boolean).map((a) => ({ ...a, kind: 'action', depth: 0 })).filter((a) => score(query, a.label) != null);
    return [...listed, ...actions];
  }, [mode, query, state, wall, focused, onClose, termById, groupById, relayPort]);

  useEffect(() => { setIndex((i) => Math.min(i, Math.max(0, items.length - 1))); }, [items.length]);

  const submitToken = (val) => {
    Promise.resolve(wall.run(['wall.token', val])).then((r) => {
      if (r?.text?.startsWith('ERR:')) wall.notify?.(r.text.replace(/^ERR:\s*/, ''));
    });
    onClose();
  };

  const choose = (item) => {
    if (!item) return;
    if (item.kind === 'terminal') { wall.run(['wall.reveal', item.id]); onClose(); }
    else if (item.kind === 'group') { wall.run(['wall.group.frame', item.id]); onClose(); }
    else if (item.kind === 'agent') { wall.run(['wall.attach', item.id]); onClose(); }
    else item.run();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (mode === 'token') {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitToken(query.trim());
      }
      return;
    }
    if (mode === 'rename') {
      if (e.key === 'Enter' && target) {
        e.preventDefault();
        wall.run([renameOf.kind === 'group' ? 'wall.group.rename' : 'wall.rename', target.id, ...(query.trim() ? [query.trim()] : [])]);
        onClose();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const tokVal = directTokenInput(query);
      if (tokVal) { submitToken(tokVal); return; }
      if (/^wall(?:\.|\s+)token$/i.test(query.trim())) { setMode('token'); setQuery(''); return; }
      choose(items[Math.min(index, items.length - 1)]);
    }
  };

  const labelColor = (it) => (it.kind === 'agent' ? (it.dim ? '#6b7383' : busStatus(it.status).colour) : it.kind === 'action' ? '#8ab4f8' : it.kind === 'group' ? '#aeb7c6' : it.hidden ? '#6b7383' : '#e6e9ef');
  return (
    <div style={styles.scrim} onMouseDown={onClose}>
      <div style={styles.box} onMouseDown={(e) => e.stopPropagation()} data-palette="" data-palette-mode={mode}>
        {mode === 'token' && <div style={styles.caption}>paste relay token or #token=… URL — Enter connects</div>}
        {target && <div style={styles.caption}>rename {target.id} — empty uses {renameOf.kind === 'group' ? `"group N"` : "the shell's title"}</div>}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={onKeyDown}
          placeholder={mode === 'token' ? `token or http://localhost:${relayPort}/#token=…` : target ? target.name : 'find a terminal, group or agent…'}
          spellCheck={false}
          autoComplete="off"
          style={styles.input}
        />
        {mode === 'find' && (
          <div style={styles.list}>
            {items.map((it, i) => (
              <div
                key={`${it.kind}:${it.id}`}
                data-item={`${it.kind}:${it.id}`}
                data-hidden={it.hidden ? '' : undefined}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={() => choose(it)}
                style={{ ...styles.row, paddingLeft: 12 + it.depth * 14, background: i === index ? '#1b2130' : 'transparent' }}
              >
                <FitText text={it.kind === 'group' ? `▤ ${it.label}` : it.kind === 'agent' ? `◆ ${it.label}` : it.label} style={{ color: labelColor(it), fontStyle: it.hidden ? 'italic' : 'normal' }} />
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
  list: { maxHeight: '60vh', overflowY: 'auto' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 12px', cursor: 'pointer' },
  detail: { color: '#6b7383', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%', flex: '0 1 auto' },
};
