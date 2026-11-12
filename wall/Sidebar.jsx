import React, { useEffect, useRef, useState } from 'react';
import { chordLabel } from './chord.js';
import { holdPress } from './holdPress.js';
import FitText from './FitText.jsx';

const WIDTH = 248;

/** A small button that never takes the keyboard (keys stay with the focused terminal). */
function Btn({ title, onClick, children, style, ...rest }) {
  return (
    <button
      tabIndex={-1}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      style={{ ...styles.btn, ...style }}
      {...rest}
    >{children}</button>
  );
}

/** The close button: held over closeHoldMs (its ring fills), then the terminal is killed. */
function HoldClose({ wall, id }) {
  const ref = useRef(null);
  useEffect(() => {
    const h = holdPress(ref.current, { ms: () => wall.config.closeHoldMs, onDone: () => wall.run(['wall.close', id]) });
    return () => h.dispose();
  }, [wall, id]);
  return <Btn ref={ref} title="hold to close (kills the shell)" data-action="close">×</Btn>;
}

/** One terminal's row: click reveals it; hide/show, hold-close, and (in a group) take it out. */
function TermRow({ wall, t, depth, focused }) {
  return (
    <div
      data-row={`term:${t.id}`}
      data-hidden={t.hidden ? '' : undefined}
      onClick={() => wall.run(['wall.reveal', t.id])}
      style={{ ...styles.row, paddingLeft: 10 + depth * 16, background: focused ? '#16251e' : undefined }}
      className="wall-sidebar-row"
    >
      <FitText text={t.name} maxPx={12.5} style={{ color: t.hidden ? '#6b7383' : focused ? '#8ef0b8' : '#d4d9e2', fontStyle: t.hidden ? 'italic' : 'normal' }} />
      {t.hidden && <span style={styles.tag}>hidden</span>}
      <span className="wall-sidebar-tools" style={styles.tools}>
        {t.group && <Btn title="take it out of its group" data-action="leave" onClick={() => wall.run(['wall.group.remove', t.id])}>⇱</Btn>}
        {t.hidden
          ? <Btn title="show it, at its own spot" data-action="show" onClick={() => wall.run(['wall.show', t.id])}>○</Btn>
          : <Btn title={`hide it (it keeps running) — ${chordLabel(['-'])}`} data-action="hide" onClick={() => wall.run(['wall.hide', t.id])}>–</Btn>}
        <HoldClose wall={wall} id={t.id} />
      </span>
    </div>
  );
}

/** A group's row: fold/unfold, its name (click frames it), its layout, ungroup. */
function GroupRow({ wall, g, collapsed }) {
  const tile = g.layout === 'tile';
  return (
    <div data-row={`group:${g.id}`} data-collapsed={collapsed ? '' : undefined} style={{ ...styles.row, paddingLeft: 4 }} className="wall-sidebar-row"
      onClick={() => wall.run(['wall.group.frame', g.id])}>
      <Btn title={collapsed ? 'unfold' : 'fold'} data-action="collapse" onClick={() => wall.run(['wall.sidebar.collapse', g.id])} style={{ width: 16 }}>
        {collapsed ? '▸' : '▾'}
      </Btn>
      <FitText text={g.name} maxPx={12.5} style={{ color: '#aeb7c6' }} />
      <span style={styles.count}>{g.members.length}</span>
      <span className="wall-sidebar-tools" style={styles.tools}>
        {tile && <Btn title="fewer columns" data-action="cols-" onClick={() => wall.run(['wall.group.columns', g.id, '-1'])}>−</Btn>}
        {tile && <span style={styles.cols} title="columns">{g.columns}</span>}
        {tile && <Btn title="more columns" data-action="cols+" onClick={() => wall.run(['wall.group.columns', g.id, '+1'])}>+</Btn>}
        <Btn title={tile ? 'freeform: members keep their own spots' : 'tile: pack members in columns'} data-action="layout" style={{ width: 'auto', padding: '0 4px' }}
          onClick={() => wall.run(['wall.group.layout', g.id, tile ? 'freeform' : 'tile'])}>{tile ? 'tile' : 'free'}</Btn>
        <Btn title={`ungroup (members stay where they are) — ${chordLabel(['G'], { shift: true })}`} data-action="ungroup" onClick={() => wall.run(['wall.ungroup', g.id])}>⊘</Btn>
      </span>
    </div>
  );
}

/**
 * The sidebar — every terminal as a list of tabs: groups first, as top-level rows that fold, their
 * members under them, then the terminals in no group. Hidden terminals stay listed (dimmed, marked).
 * A row's click reveals its terminal (or frames its group); its tools — hide/show, hold-to-close,
 * take out of a group, a group's columns, layout and ungroup — run the same wall verbs as the canvas
 * buttons and the palette. It floats (drag its head) or sticks to the left or right edge; open, side,
 * float spot and folded groups persist per relay (WallStore). Toggled by the chord + B or
 * `wall.sidebar`.
 */
export default function Sidebar({ wall, state }) {
  const sb = state.sidebar;
  const [drag, setDrag] = useState(null);   // { dx, dy, x, y } while the floating head is dragged
  if (!sb.open) return null;

  const pos = drag ? { x: drag.x, y: drag.y } : sb.float;
  const box = sb.side === 'float'
    ? { left: pos.x, top: pos.y, maxHeight: 'calc(100% - 120px)', borderRadius: 7, border: '1px solid #2a303c' }
    : { top: 0, bottom: 0, [sb.side]: 0, [sb.side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid #222834' };

  const onHeadDown = (e) => {
    if (sb.side !== 'float' || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, x: pos.x, y: pos.y };
    setDrag(start);
    let last = start;
    const move = (ev) => { last = { ...start, x: Math.max(0, ev.clientX - start.dx), y: Math.max(0, ev.clientY - start.dy) }; setDrag(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      wall.run(['wall.sidebar', 'float', String(Math.round(last.x)), String(Math.round(last.y))]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const byId = new Map(state.terminals.map((t) => [t.id, t]));
  const loose = state.terminals.filter((t) => !t.group);
  return (
    <div data-sidebar="" data-side={sb.side} style={{ ...styles.panel, ...box }}>
      <style>{'.wall-sidebar-row .wall-sidebar-tools{visibility:hidden}.wall-sidebar-row:hover .wall-sidebar-tools{visibility:visible}.wall-sidebar-row:hover{background:#151a24}'}</style>
      <div style={{ ...styles.head, cursor: sb.side === 'float' ? 'move' : 'default' }} onPointerDown={onHeadDown}>
        <span style={{ flex: 1, color: '#7c8596' }}>terminals</span>
        <Btn title="stick to the left edge" data-action="left" onClick={() => wall.run(['wall.sidebar', 'left'])} style={sb.side === 'left' ? styles.on : null}>⇤</Btn>
        <Btn title="float" data-action="float" onClick={() => wall.run(['wall.sidebar', 'float'])} style={sb.side === 'float' ? styles.on : null}>◫</Btn>
        <Btn title="stick to the right edge" data-action="right" onClick={() => wall.run(['wall.sidebar', 'right'])} style={sb.side === 'right' ? styles.on : null}>⇥</Btn>
        <Btn title={`close (${chordLabel(['B'])})`} data-action="close-sidebar" onClick={() => wall.run(['wall.sidebar', 'close'])}>×</Btn>
      </div>
      <div style={styles.body}>
        {state.groups.map((g) => {
          const collapsed = sb.collapsed.includes(g.id);
          return (
            <div key={g.id} data-group={g.id}>
              <GroupRow wall={wall} g={g} collapsed={collapsed} />
              {!collapsed && g.members.map((id) => byId.get(id)).filter(Boolean).map((t) => (
                <TermRow key={t.id} wall={wall} t={t} depth={1} focused={t.id === state.focusedId} />
              ))}
            </div>
          );
        })}
        {loose.map((t) => <TermRow key={t.id} wall={wall} t={t} depth={0} focused={t.id === state.focusedId} />)}
        {!state.terminals.length && <div style={{ ...styles.row, color: '#6b7383', cursor: 'default' }}>no terminals</div>}
      </div>
    </div>
  );
}

const styles = {
  panel: {
    position: 'absolute', zIndex: 7, width: WIDTH, display: 'flex', flexDirection: 'column', background: 'rgba(12, 14, 20, 0.96)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)', font: '12.5px ui-monospace, SFMono-Regular, Menlo, monospace', userSelect: 'none',
  },
  head: { display: 'flex', alignItems: 'center', gap: 2, padding: '6px 6px 6px 10px', borderBottom: '1px solid #1e2430' },
  body: { overflowY: 'auto', padding: '4px 0', flex: '1 1 auto' },
  row: { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px 3px 10px', cursor: 'pointer', minHeight: 20 },
  tools: { display: 'flex', alignItems: 'center', gap: 1, flex: '0 0 auto' },
  btn: {
    width: 18, height: 18, padding: 0, border: 'none', borderRadius: 4, background: 'transparent', color: '#8b95a7',
    font: '12px/18px ui-monospace, monospace', cursor: 'pointer', position: 'relative', textAlign: 'center', flex: '0 0 auto',
  },
  on: { color: '#e6e9ef', background: '#1d2330' },
  tag: { color: '#5d6574', fontSize: 10.5, flex: '0 0 auto' },
  count: { color: '#5d6574', fontSize: 11, flex: '0 0 auto', minWidth: 14, textAlign: 'right' },
  cols: { color: '#8b95a7', fontSize: 11, minWidth: 10, textAlign: 'center' },
};
