import React, { useEffect, useState, useCallback } from 'react';

/**
 * HudPanel — the window helper + state HUD for apps/home (the first modal-interface). DOM chrome
 * (outside the r3f Canvas, fed `client` via CommandProvider.onReady). Two stacked, composable
 * sections, both pure bindings of { fire: a command-bus verb, reflect: live state } — the panel
 * owns NO behavior:
 *
 *   1. WINDOW LIST (always shown when any window exists): every registry window (grid/terminal),
 *      click to focus-back (select + go to it). This is the "see all windows / get back to one"
 *      surface — and the focus SOURCE the state section needs. (Replaces the framework-heavy
 *      apps/ide dock; here windows are command-bus-managed, never lost behind a closed tab.)
 *   2. STATE controls (shown for the focused window): focus/reset/cam-lock, layout mode, edit
 *      toggle (lit = editing — the explicit, no-silent-edit affordance), scroll/frame readout.
 *
 * State flows ONE WAY: subscribe to AttentionManager change events + registry changes for instant
 * retarget, + a light ~150ms poll for the readouts that don't emit (scroll/frame/layout/edit).
 */

const LAYOUT_MODES = ['newspaper', 'long-column', 'no-wrap', 'z-pages'];

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
function short(s, n = 22) {
  s = String(s || '');
  return s.length <= n ? s : '…' + s.slice(-(n - 1));
}

// Every registry window (grid + terminal) → a flat list for the window strip. Pure read.
function readWindows(client) {
  const reg = client?.ctx?.registry;
  if (!reg) return [];
  const grids = reg.findByType?.('grid') || [];
  const terms = reg.findByType?.('terminal') || [];
  return [...grids, ...terms].map((e) => ({
    id: e.id,
    type: e.type || 'grid',
    name: e.grid?.getFilename?.() || e.id,
  }));
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
  const [windows, setWindows] = useState(() => readWindows(client));
  const [f, setF] = useState(() => readFocus(client));

  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => { setWindows(readWindows(client)); setF(readFocus(client)); };
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    const unsubs = [am?.on?.('change:primary', refresh), am?.on?.('change:key', refresh)].filter(Boolean);
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

  if (windows.length === 0 && !f) return null;  // nothing to show yet
  const focusedId = f?.id ?? null;

  return (
    <div style={S.panel} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      {/* 1. window list — click to focus-back (select + go to it) */}
      {windows.length > 0 && (
        <div style={S.windows}>
          {windows.map((w) => (
            <button key={w.id} type="button" title={w.id}
              style={{ ...S.tab, ...(w.id === focusedId ? S.tabOn : null) }}
              onClick={() => { fire('attention.set', 'primary', w.id); fire('camera.focus', w.id); }}>
              {w.type === 'terminal' ? '▤' : '▦'} {short(w.name)}
            </button>
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

const S = {
  panel: {
    position: 'fixed', left: 12, bottom: 12, zIndex: 20,
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    background: 'rgba(10,12,16,0.82)', color: '#aebccb',
    border: '1px solid #283341', borderRadius: 7, padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: 8, minWidth: 210, maxWidth: 320,
    userSelect: 'none', backdropFilter: 'blur(6px)', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  windows: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 220, overflowY: 'auto' },
  tab: {
    font: 'inherit', textAlign: 'left', color: '#9ab', background: '#141a22',
    border: '1px solid #232b34', borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  tabOn: { color: '#08101a', background: '#6cf', borderColor: '#6cf', fontWeight: 600 },
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
};
