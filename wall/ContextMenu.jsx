import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { menuItems, placeMenu, checkSize } from './contextMenu.js';
import { holdPress } from './holdPress.js';
import FitText from './FitText.jsx';

/** What the menu is on, in a few words — its quiet caption. */
function captionOf(target, state) {
  if (target.kind === 'terminal') return state.terminals.find((t) => t.id === target.id)?.name ?? target.id;
  if (target.kind === 'group') return state.groups.find((g) => g.id === target.id)?.name ?? target.id;
  return 'canvas';
}

/** The close row: held over closeHoldMs (the ring fills in its mark), then the verb runs. Enter held drives the same ring. */
function HoldRow({ wall, item, active, onHover, holdRef, onDone }) {
  const rowRef = useRef(null);
  const markRef = useRef(null);
  useEffect(() => {
    const h = holdPress(rowRef.current, { ms: () => wall.config.closeHoldMs, ring: markRef.current, onDone });
    holdRef.current = h;
    return () => { h.dispose(); if (holdRef.current === h) holdRef.current = null; };
  }, [wall, item.id]);
  return (
    <div ref={rowRef} data-menu-item={item.id} onPointerMove={onHover} style={{ ...styles.row, ...(active ? styles.active : null) }}>
      <span ref={markRef} style={styles.mark}>×</span>
      <span style={styles.label}>{item.label}</span>
      {item.detail && <span style={styles.detail}>{item.detail}</span>}
    </div>
  );
}

/**
 * The wall's right-click menu (contextMenu.js decides who a right-click belongs to and what's in
 * here; the wall holds the open menu: `state.menu`). Small and quiet, the sidebar's dress: a caption
 * naming what it's on, rows that each run a wall verb, and a footer saying a second right-click
 * gives the browser's own menu (the `menuHint` knob). It sits by the pointer, flipped at the view's
 * edges (placeMenu on WallCamera.view), and takes the keys while open: ↑ ↓ move, ← → pick in a row
 * of options, Enter runs (on close it's HELD, as the pointer is), Esc closes. Choosing closes it,
 * except stepping a group's columns. The size row's `custom…` turns it into cols × rows fields on
 * the terminal's own size (Tab between them, Enter resizes, Esc goes back to the chips; a refusal —
 * checkSize's or terminal.resize's — shows under the row).
 */
export default function ContextMenu({ wall, state }) {
  const menu = state.menu;
  if (!menu) return null;
  const key = `${menu.target.kind}:${menu.target.id ?? ''}@${menu.at.x},${menu.at.y}`;
  return <MenuBox key={key} wall={wall} state={state} menu={menu} />;
}

function MenuBox({ wall, state, menu }) {
  const items = useMemo(() => menuItems({ ...menu.target, world: menu.world }, state, wall.config), [menu, state, wall]);
  const rows = items.filter((it) => it.kind !== 'sep');
  const [index, setIndex] = useState(-1);   // no row lit until the pointer or a key picks one
  const [option, setOption] = useState(0);
  const [renaming, setRenaming] = useState(null);   // the rename row's id while its box is up
  const [text, setText] = useState('');
  /** The size row's own size, being typed: { cols, rows } as text, and the last refusal. */
  const [sizing, setSizing] = useState(/** @type {{ cols: string, rows: string, error: string }|null} */ (null));
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const colsRef = useRef(null);
  const rowsRef = useRef(null);
  const holdRef = useRef(null);

  const close = () => wall.run(['wall.menu', 'close']);
  const run = (verb, stay = false) => { wall.run(verb); if (!stay) close(); };
  const active = index < 0 ? null : rows[Math.min(index, rows.length - 1)];

  useLayoutEffect(() => {
    const r = boxRef.current.getBoundingClientRect();
    setPos(placeMenu(menu.at, { w: r.width, h: r.height }, wall.viewport.view));
  }, [menu, items.length, renaming, !!sizing, sizing?.error]);
  // Focus once placed (a box still visibility: hidden can't take it); back from the rename box and the size fields too.
  const placed = pos != null;
  useEffect(() => { if (placed && !renaming && !sizing) boxRef.current?.focus({ preventScroll: true }); }, [placed, renaming, !!sizing]);
  useEffect(() => { if (!items.length) close(); }, [items.length]);
  useLayoutEffect(() => {   // a row of options lights its current one (before the next key reads it)
    const c = active?.kind === 'choice' ? active.options.findIndex((o) => o.on) : -1;
    setOption(Math.max(0, c));
  }, [active?.id]);

  /** An option chosen: a custom one opens its row's fields, prefilled with the current value; any other runs its verb. */
  const pick = (it, o) => {
    if (o.custom) { setIndex(rows.indexOf(it)); setSizing({ cols: String(it.edit.cols), rows: String(it.edit.rows), error: '' }); }
    else run(o.verb, it.id === 'columns');
  };
  const choose = (it) => {
    if (!it) return;
    if (it.kind === 'action') run(it.verb);
    else if (it.kind === 'rename') { setRenaming(it.id); setText(it.value); }
    else if (it.kind === 'choice') pick(it, it.options[Math.min(option, it.options.length - 1)]);
  };
  /** Enter in the size fields: refused with a reason under the row, or resized and closed. */
  const applySize = async (it) => {
    let size;
    try { size = checkSize(sizing.cols, sizing.rows); } catch (err) { setSizing((z) => z && { ...z, error: err.message }); return; }
    const r = await wall.run([...it.edit.verb, String(size.cols), String(size.rows)]);
    if (r.text.startsWith('ERR')) setSizing((z) => z && { ...z, error: r.text.replace(/^ERR:\s*/, '') });
    else close();
  };
  const sizeKey = (it, which) => (e) => {
    e.stopPropagation();
    if (e.key === 'Tab') { e.preventDefault(); (which === 'cols' ? rowsRef : colsRef).current?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); applySize(it); }
    else if (e.key === 'Escape') { e.preventDefault(); setSizing(null); }   // back to the row's chips; Esc again closes
  };

  const onKeyDown = (e) => {
    if (renaming || sizing) return;
    const k = e.key;
    const claim = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Escape') { claim(); close(); }
    else if (k === 'ArrowDown' || k === 'ArrowUp') {
      claim();
      setIndex((i) => (i < 0 ? (k === 'ArrowDown' ? 0 : rows.length - 1) : (i + (k === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length));
    }
    else if (k === 'Home' || k === 'End') { claim(); setIndex(k === 'Home' ? 0 : rows.length - 1); }
    else if ((k === 'ArrowLeft' || k === 'ArrowRight') && active?.kind === 'choice') {
      claim();
      const n = active.options.length;
      setOption((o) => (o + (k === 'ArrowRight' ? 1 : -1) + n) % n);
    } else if (k === 'Enter' || k === ' ') {
      claim();
      if (active?.kind === 'hold') { if (!e.repeat) holdRef.current?.start(); }
      else choose(active);
    } else if (k === 'Tab') claim();
  };
  const onKeyUp = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && active?.kind === 'hold') holdRef.current?.cancel();
  };
  // The keys are the menu's wherever the browser's focus sits (WallKeys yields while it's open); the
  // rename box keeps its own. Each key commits before the next is read (flushSync: a native listener's
  // update would otherwise wait for a task, and a fast ↓ Enter would choose the row ↓ left).
  const keys = useRef({ onKeyDown, onKeyUp });
  keys.current = { onKeyDown, onKeyUp };
  useEffect(() => {
    const own = (e) => e.target instanceof Element && e.target.closest('[data-menu-rename], [data-menu-field]');
    const down = (e) => { if (!own(e)) flushSync(() => keys.current.onKeyDown(e)); };
    const up = (e) => { if (!own(e)) keys.current.onKeyUp(e); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, []);

  const target = menu.target;
  return (
    <div
      ref={boxRef}
      tabIndex={-1}
      data-wall-menu=""
      data-target={`${target.kind}${target.id ? `:${target.id}` : ''}`}
      role="menu"
      style={{ ...styles.box, left: pos?.x ?? menu.at.x, top: pos?.y ?? menu.at.y, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div style={styles.caption}><FitText text={captionOf(target, state)} maxPx={11} style={{ color: '#6b7383' }} /></div>
      {items.map((it) => {
        if (it.kind === 'sep') return <div key={it.id} style={styles.sep} />;
        const i = rows.indexOf(it);
        const on = active === it;
        // The pointer lights a row only by really moving: a menu that opens under a still pointer (the
        // menu key) keeps the row the keys chose (a browser's layout-driven hover has no movement).
        const hover = (e) => { if (e.movementX || e.movementY) setIndex(i); };
        if (it.kind === 'hold') {
          return <HoldRow key={it.id} wall={wall} item={it} active={on} onHover={hover} holdRef={holdRef} onDone={() => run(it.verb)} />;
        }
        if (it.kind === 'rename' && renaming === it.id) {
          return (
            <div key={it.id} data-menu-item={it.id} style={{ ...styles.row, ...styles.active }}>
              <input
                autoFocus
                data-menu-rename=""
                value={text}
                placeholder={it.placeholder}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); const t = text.trim(); run([...it.verb, ...(t ? [t] : [])]); }
                  else if (e.key === 'Escape') { e.preventDefault(); close(); }
                }}
                style={styles.input}
              />
            </div>
          );
        }
        if (it.kind === 'choice' && it.edit && sizing) {
          const field = (which, ref, auto) => (
            <input
              ref={ref}
              autoFocus={auto}
              data-menu-field={which}
              aria-label={which}
              inputMode="numeric"
              value={sizing[which]}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setSizing({ ...sizing, [which]: e.target.value, error: '' })}
              onKeyDown={sizeKey(it, which)}
              spellCheck={false}
              style={styles.cell}
            />
          );
          return (
            <div key={it.id} data-menu-item={it.id} data-sizing="">
              <div style={{ ...styles.row, ...styles.active }}>
                <span style={styles.mark} />
                <span style={styles.label}>{it.label}</span>
                <span style={styles.options}>
                  {field('cols', colsRef, true)}<span style={styles.times}>×</span>{field('rows', rowsRef, false)}
                </span>
              </div>
              {sizing.error && <div data-menu-refused="" style={styles.refused}>{sizing.error}</div>}
            </div>
          );
        }
        if (it.kind === 'choice') {
          return (
            <div key={it.id} data-menu-item={it.id} onPointerMove={hover} style={{ ...styles.row, ...(on ? styles.active : null) }}>
              <span style={styles.mark} />
              <span style={styles.label}>{it.label}</span>
              {it.detail && <span style={{ ...styles.detail, marginLeft: 0 }}>{it.detail}</span>}
              <span style={styles.options}>
                {it.options.map((o, k) => (
                  <span
                    key={o.id}
                    data-menu-option={o.id}
                    data-on={o.on ? '' : undefined}
                    onPointerMove={(e) => { if (e.movementX || e.movementY) setOption(k); }}
                    onClick={() => pick(it, o)}
                    style={{ ...styles.option, ...(it.id === 'add-to' ? styles.optionFit : null), ...(o.on ? styles.optionOn : null), ...(on && k === option ? styles.optionActive : null) }}
                  >{it.id === 'add-to' ? <FitText text={o.label} maxPx={12} style={{}} /> : o.label}</span>
                ))}
              </span>
            </div>
          );
        }
        return (
          <div key={it.id} data-menu-item={it.id} onPointerMove={hover} onClick={() => choose(it)} style={{ ...styles.row, ...(on ? styles.active : null) }}>
            <span style={styles.mark} />
            <span style={styles.label}>{it.label}</span>
            {'detail' in it && it.detail && <span style={styles.detail}>{it.detail}</span>}
          </div>
        );
      })}
      {wall.config.menuHint && <div data-menu-hint="" style={styles.hint}>right-click again: browser menu</div>}
    </div>
  );
}

/** @type {Record<string, import('react').CSSProperties>} */
const styles = {
  box: {
    position: 'absolute', zIndex: 30, minWidth: 196, maxWidth: 360, padding: '4px 0', background: 'rgba(12, 14, 20, 0.97)',
    border: '1px solid #2a303c', borderRadius: 7, boxShadow: '0 8px 30px rgba(0,0,0,0.45)', outline: 'none',
    font: '12.5px ui-monospace, SFMono-Regular, Menlo, monospace', color: '#d4d9e2', userSelect: 'none', boxSizing: 'border-box',
  },
  caption: { display: 'flex', padding: '2px 10px 4px 26px' },
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 6px', minHeight: 20, cursor: 'default', position: 'relative' },
  active: { background: '#1b2130' },
  mark: { width: 14, height: 14, flex: '0 0 auto', color: '#8b95a7', font: '12px/14px ui-monospace, monospace', textAlign: 'center', position: 'relative' },
  label: { flex: '1 1 auto', whiteSpace: 'nowrap' },
  detail: { color: '#5d6574', fontSize: 10.5, flex: '0 0 auto', marginLeft: 12, whiteSpace: 'nowrap' },
  options: { display: 'flex', gap: 2, flex: '0 1 auto', minWidth: 0, marginLeft: 'auto', paddingLeft: 10 },
  option: { padding: '0 6px', borderRadius: 4, color: '#8b95a7', cursor: 'pointer', display: 'flex', flex: '0 0 auto', maxWidth: 120, whiteSpace: 'nowrap', borderWidth: 1, borderStyle: 'solid', borderColor: 'transparent' },
  optionFit: { flex: '0 1 auto', minWidth: 0 },   // a group's name shrinks to fit (FitText), never cut
  optionOn: { color: '#e6e9ef', background: '#1d2330' },
  optionActive: { borderColor: '#3b4352' },
  sep: { height: 1, background: '#1e2430', margin: '4px 0' },
  cell: {
    width: 52, background: '#0b0d13', color: '#e6e9ef', border: '1px solid #2a303c', borderRadius: 4,
    padding: '1px 5px', font: 'inherit', fontSize: 12, outline: 'none', textAlign: 'right',
  },
  times: { color: '#5d6574', padding: '0 4px' },
  refused: { color: '#e5534b', fontSize: 11, padding: '0 10px 3px 26px' },
  input: {
    flex: 1, minWidth: 0, background: '#0b0d13', color: '#e6e9ef', border: '1px solid #2a303c', borderRadius: 4,
    padding: '2px 6px', font: 'inherit', outline: 'none', marginLeft: 20,
  },
  hint: { color: '#4f5665', fontSize: 10.5, padding: '5px 10px 2px 26px', borderTop: '1px solid #1e2430', marginTop: 4 },
};
