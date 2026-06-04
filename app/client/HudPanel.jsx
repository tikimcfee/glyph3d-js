import React, { useEffect, useState, useCallback } from 'react';

/**
 * HudPanel — the workspace HUD: the companion control overlay on the canvas. DOM chrome
 * (outside the r3f Canvas, fed `client` via CommandProvider.onReady). Stacked, composable
 * sections, each a pure binding of { fire: a command-bus verb, reflect: live state } — the
 * panel owns NO behavior:
 *
 *   1. TABS — the open-tab bar (the active field's sheets): the small, user-curated set of
 *      files opened AS tabs, NOT a mirror of everything loaded in the field (a repo can load
 *      thousands of grids — those live in the file tree, not here). Each tab is marked with the
 *      open/rendered/focused triple ● ◐ ○. Click → sheet.focus (render-if-needed + frame +
 *      focus); × → sheet.close. Addable/removable like editor tabs; browse-everything is the
 *      file-tree panel's job.
 *   2. STATE controls (for the focused window — the selection): focus/reset/cam-lock, layout
 *      mode, edit toggle (lit = editing — the explicit, no-silent-edit affordance), scroll/
 *      frame readout. Works for ANY focused grid, tab or not.
 *
 * State flows ONE WAY: subscribe to WorkspaceModel change events (sheets/fields) + AttentionManager
 * + registry changes for instant retarget, + a light ~150ms poll for readouts that don't emit
 * (scroll/frame/layout/edit).
 */

const LAYOUT_MODES = ['newspaper', 'long-column', 'no-wrap', 'z-pages'];
const GLYPH = { focused: '●', rendered: '◐', open: '○' };

// Best-guess the active preset from the grid's layout params (modes are param bundles, so this is
// an inference for the highlight, not authoritative).
function inferMode(L) {
  if (!L) return null;
  if (L.axis === 'z') return 'z-pages';
  if ((L.wrapWidth ?? 200) === 0) return 'no-wrap';
  if ((L.pageHeight ?? 150) === 0) return 'long-column';
  return 'newspaper';
}

// Trim a label (filename/path) to something tab-sized, keeping the tail (the basename).
function short(s, n = 20) {
  s = String(s || '');
  return s.length <= n ? s : '…' + s.slice(-(n - 1));
}

// The active field's sheets = the working set, each annotated with the derived triple. Pure read.
function readSheets(client) {
  const ws = client?.ctx?.workspace;
  if (!ws) return [];
  const reg = client.ctx?.registry;
  const am = client.ctx?.attentionManager;
  return ws.listActiveSheets(reg, am).map((s) => {
    const grid = s.panelId ? (reg?.get(s.panelId)?.grid ?? null) : null;
    return {
      id: s.id,                                 // sheetId ("sheet:"+path) — what the verbs take
      title: s.title,
      panelId: s.panelId,
      state: s.focused ? 'focused' : s.rendered ? 'rendered' : 'open',
      dirty: !!(grid && grid.isModified?.()),   // unsaved edits → the • marker
    };
  });
}

// The focused window's live state (attention.primary) for the control section. Pure read.
function readFocus(client) {
  const am = client?.ctx?.attentionManager;
  const reg = client?.ctx?.registry;
  if (!am || !reg) return null;
  const p = am.get?.('primary');
  if (!p?.id) return null;
  const entry = reg.get(p.id);
  if (!entry?.grid) return null;
  const { id, grid, type } = entry;
  const isGrid = typeof grid.getLayout === 'function';   // duck-type: terminals lack getLayout
  const cc = client.ctx.cameraController;
  return {
    id,
    type: type || (isGrid ? 'grid' : 'window'),
    name: grid.getFilename?.() || id,
    isGrid,
    layoutMode: isGrid ? inferMode(grid.getLayout?.()) : null,
    scroll: isGrid ? (grid.getScrollOffset?.() ?? 0) : 0,
    total: isGrid ? (grid.getTotalVisualRows?.() ?? 0) : 0,
    frameRows: isGrid ? (grid.getFrameRows?.() ?? 0) : 0,
    editing: isGrid ? (grid.getCursor?.() != null) : false,
    cameraLocked: cc?.isLocked?.() ?? false,
  };
}

export default function HudPanel({ client }) {
  const [sheets, setSheets] = useState(() => readSheets(client));
  const [f, setF] = useState(() => readFocus(client));
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => {
      setSheets(readSheets(client));
      setF(readFocus(client));
    };
    const ws = client.ctx?.workspace;
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    const unsubs = [
      ws?.on?.('change:sheets', refresh), ws?.on?.('change:fields', refresh),
      am?.on?.('change:primary', refresh), am?.on?.('change:key', refresh),
    ].filter(Boolean);
    reg?.addChangeListener?.(refresh);                 // window added/removed → restrip
    const iv = setInterval(refresh, 150);              // scroll/frame/layout/edit don't emit — poll
    refresh();
    return () => {
      unsubs.forEach((u) => u?.());
      reg?.removeChangeListener?.(refresh);
      clearInterval(iv);
    };
  }, [client]);

  const fire = useCallback((...argv) => client?.router?.execute(argv), [client]);

  if (sheets.length === 0 && !f) return null;  // nothing to show yet

  return (
    <div style={S.panel} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      {/* header — the companion HUD's handle: collapse/expand the overlay */}
      <div style={S.header}>
        <span style={S.htitle}>tabs</span>
        <button type="button" style={S.collapse} title={collapsed ? 'expand' : 'collapse'}
          onClick={() => setCollapsed((c) => !c)}>{collapsed ? '▸' : '▾'}</button>
      </div>
      {!collapsed && <>
      {/* 1. sheets — the working set; click a tab → sheet.focus, × → sheet.close */}
      {sheets.length > 0 && (
        <div style={S.list}>
          {sheets.map((s) => (
            <div key={s.id} title={s.id}
              style={{ ...S.tabRow, ...(s.state === 'focused' ? S.tabRowOn : null) }}>
              <button type="button" style={S.tabMain}
                title={s.dirty ? 'unsaved edits' : undefined} onClick={() => fire('sheet.focus', s.id)}>
                <span style={{ ...S.dot, ...(s.state === 'focused' ? null : DOT[s.state]) }}>{GLYPH[s.state]}</span>
                {short(s.title)}
                {s.dirty ? <span style={S.dirtyDot}>•</span> : null}
              </button>
              <button type="button" style={S.close} title="close sheet"
                onClick={() => fire('sheet.close', s.id)}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* 2. focused-window controls */}
      {f && (
        <div style={S.controls}>
          <div style={S.row}>
            <Btn onClick={() => fire('camera.focus', f.id)}>focus</Btn>
            <Btn onClick={() => fire('camera.reset')}>reset</Btn>
            <Toggle on={f.cameraLocked} onStyle={S.cyanOn} onClick={() => fire('camera.lock')}>
              {f.cameraLocked ? 'cam ●' : 'cam ○'}
            </Toggle>
          </div>
          {f.isGrid && (
            <>
              <div style={S.row}>
                {LAYOUT_MODES.map((m) => (
                  <Mode key={m} on={f.layoutMode === m} onClick={() => fire('grid.layout', f.id, m)}>{m}</Mode>
                ))}
              </div>
              <div style={S.row}>
                <Toggle on={f.editing} onStyle={S.editOn}
                  onClick={() => fire(f.editing ? 'edit.stop' : 'edit.start', f.id)}>
                  {f.editing ? 'edit ●' : 'edit ○'}
                </Toggle>
                <span style={S.readout}>
                  {f.frameRows > 0 ? `frame ${f.frameRows} · ` : ''}row {f.scroll}/{f.total}
                </span>
              </div>
            </>
          )}
        </div>
      )}
      </>}
    </div>
  );
}

// ── composable primitives — each a thin binding of { onClick: fire(verb), reflect: on } ──
function Btn({ onClick, children }) {
  return <button type="button" style={S.btn} onClick={onClick}>{children}</button>;
}
function Toggle({ on, onStyle, onClick, children }) {
  return <button type="button" style={{ ...S.btn, ...(on ? (onStyle || S.cyanOn) : null) }} onClick={onClick}>{children}</button>;
}
function Mode({ on, onClick, children }) {
  return <button type="button" style={{ ...S.mode, ...(on ? S.cyanOn : null) }} onClick={onClick}>{children}</button>;
}

// dot color per non-focused state (focused dot rides the cyan-filled tab, so it inherits dark)
const DOT = { rendered: { color: '#6cf' }, open: { color: '#5b6675' } };

const S = {
  panel: {
    position: 'fixed', right: 12, bottom: 12, zIndex: 20,   // bottom-right: over the canvas, clear of the IDE's left dock
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    background: 'rgba(10,12,16,0.82)', color: '#aebccb',
    border: '1px solid #283341', borderRadius: 7, padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: 8, minWidth: 210, maxWidth: 320,
    userSelect: 'none', backdropFilter: 'blur(6px)', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 220, overflowY: 'auto' },
  // sheet tab = a row: a left-aligned focus button + a close ×. Highlighted when focused.
  tabRow: {
    display: 'flex', alignItems: 'stretch', gap: 2,
    background: '#141a22', border: '1px solid #232b34', borderRadius: 4, overflow: 'hidden',
  },
  tabRowOn: { color: '#08101a', background: '#6cf', borderColor: '#6cf' },  // dark-on-cyan: label, ● dot, × all flip via inherit
  tabMain: {
    flex: 1, minWidth: 0, font: 'inherit', textAlign: 'left', color: 'inherit',
    background: 'transparent', border: 'none', padding: '3px 8px', cursor: 'pointer',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  dot: { marginRight: 5 },
  dirtyDot: { marginLeft: 6, color: '#f0b45a', fontWeight: 700 },  // amber • = unsaved edits
  close: {
    font: 'inherit', color: 'inherit', opacity: 0.55, background: 'transparent', border: 'none',
    borderLeft: '1px solid rgba(255,255,255,0.08)', padding: '0 7px', cursor: 'pointer',
  },
  controls: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #232b34', paddingTop: 7 },
  row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  btn: {
    font: 'inherit', color: '#aebccb', background: '#1a212b',
    border: '1px solid #2a3340', borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
  },
  mode: {
    font: 'inherit', fontSize: 11, color: '#8b9aa8', background: '#141a22',
    border: '1px solid #232b34', borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
  },
  cyanOn: { color: '#08101a', background: '#6cf', borderColor: '#6cf' },        // active mode / cam-lock
  editOn: { color: '#1a1206', background: '#f0b45a', borderColor: '#f0b45a' },  // amber = editing
  readout: { color: '#6b7785', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  htitle: { color: '#6cf', fontWeight: 600, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', flex: 1 },
  collapse: { font: 'inherit', color: '#9ab', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 },
};
