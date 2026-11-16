import { useEffect, useRef } from 'react';
import { chordLabel } from './chord.js';
import { holdPress } from './holdPress.js';
import FitText from './FitText.jsx';
import { Btn, DockButtons, useHeadDrag } from './Panel.jsx';
import { dockLayout, DOCK_WIDTHS } from './dockLayout.js';
import { busStatus, busAttachable } from './WallBus.js';

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
        <Btn title={`agent view (${chordLabel(['A'])})`} data-action="agent" on={!!t.agentView?.open}
          onClick={() => wall.run(['wall.agent', t.id, 'toggle'])}>≡</Btn>
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

/** One gomuxai agent's row: its status dot, its name, its status; click attaches (wall.attach). */
function AgentRow({ wall, a, on, focused }) {
  const st = busStatus(a.status);
  const can = busAttachable(a);
  const title = [a.target, st.word + (a.endReason ? ` (${a.endReason})` : ''), a.detail, a.cwd, on ? `attached in ${on}` : can ? 'click to attach' : 'no tmux session to attach to']
    .filter(Boolean).join('\n');
  return (
    <div data-row={`agent:${a.target}`} data-status={a.status || 'unknown'} title={title} className="wall-sidebar-row"
      onClick={() => wall.run(['wall.attach', a.target])}
      style={{ ...styles.row, paddingLeft: 16, background: focused ? '#16251e' : undefined, cursor: can || on ? 'pointer' : 'default' }}>
      <span style={{ ...styles.dot, background: st.colour }} />
      <FitText text={a.name} maxPx={12.5} style={{ color: !can && !on ? '#6b7383' : focused ? '#8ef0b8' : '#d4d9e2' }} />
      {on && <span style={styles.tag}>on wall</span>}
      <span style={{ ...styles.tag, color: st.colour }}>{st.word}</span>
    </div>
  );
}

/** The gomuxai agents the relay sees (WallBus), under a header per host. */
function AgentsSection({ wall, state }) {
  const { hosts, reason } = state.bus;
  const attachedTo = new Map();
  for (const t of state.terminals) if (t.attached) attachedTo.set(t.attached, t.id);
  return (
    <div data-agents="">
      <div style={{ ...styles.section }}>agents</div>
      {hosts.map((h) => (
        <div key={h.host} data-host={h.host || 'local'}>
          <div style={{ ...styles.row, paddingLeft: 8, cursor: 'default', color: '#aeb7c6' }}>
            <FitText text={h.host || 'this host'} maxPx={12.5} />
            <span style={styles.count}>{h.agents.length}</span>
          </div>
          {h.agents.map((a) => {
            const on = attachedTo.get(a.target);
            return <AgentRow key={a.target} wall={wall} a={a} on={on} focused={!!on && on === state.focusedId} />;
          })}
        </div>
      ))}
      {!hosts.length && <div style={{ ...styles.row, color: '#6b7383', cursor: 'default' }} title={reason}>{reason ? 'no gomuxai on this relay' : 'no live agents'}</div>}
    </div>
  );
}

/**
 * The sidebar — every terminal as a list of tabs: groups first, as top-level rows that fold, their
 * members under them, then the terminals in no group. Hidden terminals stay listed (dimmed, marked).
 * A row's click reveals its terminal (or frames its group); its tools — hide/show, hold-to-close,
 * take out of a group, a group's columns, layout and ungroup — run the same wall verbs as the canvas
 * buttons and the palette. Below them, the gomuxai agents the relay sees, by host, each with its
 * status; a click attaches (wall.attach). It floats (drag its head) or sticks to the left or right edge (Panel.jsx);
 * open, side, float spot and folded groups persist per relay (WallStore). Toggled by the chord + B or
 * `wall.sidebar`.
 */
export default function Sidebar({ wall, state }) {
  const sb = state.sidebar;
  const boxRef = useRef(null);
  const { dragAt, onHeadDown } = useHeadDrag(wall, 'wall.sidebar', sb.side, boxRef);
  if (!sb.open) return null;

  const pos = dragAt ?? sb.float;
  const box = sb.side === 'float'
    ? { left: pos.x, top: pos.y, maxHeight: 'calc(100% - 120px)', borderRadius: 7, border: '1px solid #2a303c' }
    : { top: 0, bottom: 0, [sb.side]: dockLayout(state).sidebar, [sb.side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid #222834' };

  const byId = new Map(state.terminals.map((t) => [t.id, t]));
  const loose = state.terminals.filter((t) => !t.group);
  return (
    <div ref={boxRef} data-sidebar="" data-side={sb.side} style={{ ...styles.panel, ...box }}>
      <style>{'.wall-sidebar-row .wall-sidebar-tools{visibility:hidden}.wall-sidebar-row:hover .wall-sidebar-tools{visibility:visible}.wall-sidebar-row:hover{background:#151a24}'}</style>
      <div style={{ ...styles.head, cursor: sb.side === 'float' ? 'move' : 'default' }} onPointerDown={onHeadDown}>
        <span style={{ flex: 1, color: '#7c8596' }}>terminals</span>
        <DockButtons wall={wall} verb="wall.sidebar" side={sb.side} close={{ title: `close (${chordLabel(['B'])})`, action: 'close-sidebar' }} />
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
        <AgentsSection wall={wall} state={state} />
      </div>
    </div>
  );
}

const styles = {
  panel: {
    position: 'absolute', zIndex: 7, width: DOCK_WIDTHS.sidebar, display: 'flex', flexDirection: 'column', background: 'rgba(12, 14, 20, 0.96)',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)', font: '12.5px ui-monospace, SFMono-Regular, Menlo, monospace', userSelect: 'none', boxSizing: 'border-box',
  },
  head: { display: 'flex', alignItems: 'center', gap: 2, padding: '6px 6px 6px 10px', borderBottom: '1px solid #1e2430' },
  body: { overflowY: 'auto', padding: '4px 0', flex: '1 1 auto' },
  row: { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px 3px 10px', cursor: 'pointer', minHeight: 20 },
  tools: { display: 'flex', alignItems: 'center', gap: 1, flex: '0 0 auto' },
  tag: { color: '#5d6574', fontSize: 10.5, flex: '0 0 auto' },
  count: { color: '#5d6574', fontSize: 11, flex: '0 0 auto', minWidth: 14, textAlign: 'right' },
  cols: { color: '#8b95a7', fontSize: 11, minWidth: 10, textAlign: 'center' },
  section: { color: '#7c8596', padding: '10px 10px 4px', marginTop: 6, borderTop: '1px solid #1e2430' },
  dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', marginRight: 2 },
};
