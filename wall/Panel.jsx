import { useState } from 'react';

/**
 * The parts the wall's side panels share — the sidebar (Sidebar.jsx), the termd status window
 * (StatusWindow.jsx), the settings panel (SettingsPanel.jsx) and the help (HelpPanel.jsx): a button that never takes the
 * keyboard, the head's dock buttons, the floating head's drag, and where each panel docks. Each panel
 * floats (drag its head) or sticks to the left or right edge; panels stuck to the same edge sit side
 * by side — the sidebar at the edge, then the status window, then the settings, then the help — and
 * the topbar makes room for whatever is docked.
 */

/** A docked panel's width, CSS px. */
export const DOCK_WIDTHS = Object.freeze({ sidebar: 248, status: 440, settings: 380, help: 400 });

/** The gap the topbar keeps from the canvas edge (or from a docked panel), CSS px. */
const EDGE = 12;

/**
 * Where the docked panels sit: each one's offset from its edge, and how far the topbar stays in from
 * each edge. (A state without a settings or help panel has it closed.)
 * @param {{ sidebar: { open: boolean, side: string }, statusWindow: { open: boolean, side: string },
 *           settingsPanel?: { open: boolean, side: string }, helpPanel?: { open: boolean, side: string } }} state
 * @returns {{ sidebar: number, status: number, settings: number, help: number, inset: { left: number, right: number } }}
 */
export function dockLayout(state) {
  const docked = (p) => p.open && (p.side === 'left' || p.side === 'right');
  const used = { left: 0, right: 0 };
  let sidebar = 0, status = 0, settings = 0, help = 0;
  if (docked(state.sidebar)) { sidebar = used[state.sidebar.side]; used[state.sidebar.side] += DOCK_WIDTHS.sidebar; }
  if (docked(state.statusWindow)) { status = used[state.statusWindow.side]; used[state.statusWindow.side] += DOCK_WIDTHS.status; }
  if (state.settingsPanel && docked(state.settingsPanel)) { settings = used[state.settingsPanel.side]; used[state.settingsPanel.side] += DOCK_WIDTHS.settings; }
  if (state.helpPanel && docked(state.helpPanel)) { help = used[state.helpPanel.side]; used[state.helpPanel.side] += DOCK_WIDTHS.help; }
  return { sidebar, status, settings, help, inset: { left: used.left + EDGE, right: used.right + EDGE } };
}

/** A small button that never takes the keyboard (keys stay with the focused terminal). */
export function Btn({ title, onClick, children, style, on, ...rest }) {
  return (
    <button
      tabIndex={-1}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      style={{ ...btnStyles.btn, ...(on ? btnStyles.on : null), ...style }}
      {...rest}
    >{children}</button>
  );
}

/**
 * The head's buttons: stick left, float, stick right, close — each runs `verb` (wall.sidebar,
 * wall.status) with the place.
 * @param {{ wall: any, verb: string, side: string, close: { title: string, action: string } }} p
 */
export function DockButtons({ wall, verb, side, close }) {
  return (
    <>
      <Btn title="stick to the left edge" data-action="left" on={side === 'left'} onClick={() => wall.run([verb, 'left'])}>⇤</Btn>
      <Btn title="float" data-action="float" on={side === 'float'} onClick={() => wall.run([verb, 'float'])}>◫</Btn>
      <Btn title="stick to the right edge" data-action="right" on={side === 'right'} onClick={() => wall.run([verb, 'right'])}>⇥</Btn>
      <Btn title={close.title} data-action={close.action} onClick={() => wall.run([verb, 'close'])}>×</Btn>
    </>
  );
}

/**
 * Drag a floating panel by its head; on release the spot goes through `verb float x y` (so it
 * persists like any placement). Returns where it is while dragged (null otherwise) and the head's
 * pointerdown handler.
 * @param {any} wall @param {string} verb @param {string} side - the panel's side (only 'float' drags)
 * @param {{ current: HTMLElement|null }} boxRef - the panel's box
 * @returns {{ dragAt: {x: number, y: number}|null, onHeadDown: (e: PointerEvent) => void }}
 */
export function useHeadDrag(wall, verb, side, boxRef) {
  const [dragAt, setDragAt] = useState(null);
  const onHeadDown = (e) => {
    if (side !== 'float' || e.button !== 0 || /** @type {Element} */ (e.target).closest('button')) return;
    e.preventDefault();
    const r = boxRef.current.getBoundingClientRect();
    const start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    let last = { x: r.left, y: r.top };
    setDragAt(last);
    const move = (ev) => { last = { x: Math.max(0, ev.clientX - start.dx), y: Math.max(0, ev.clientY - start.dy) }; setDragAt(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragAt(null);
      wall.run([verb, 'float', String(Math.round(last.x)), String(Math.round(last.y))]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { dragAt, onHeadDown };
}

const btnStyles = {
  btn: {
    width: 18, height: 18, padding: 0, border: 'none', borderRadius: 4, background: 'transparent', color: '#8b95a7',
    font: '12px/18px ui-monospace, monospace', cursor: 'pointer', position: 'relative', textAlign: 'center', flex: '0 0 auto',
  },
  on: { color: '#e6e9ef', background: '#1d2330' },
};
