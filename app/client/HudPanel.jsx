import React, { useEffect, useState, useCallback } from 'react';

/**
 * HudPanel — the focused-window control helper. A small companion overlay on the canvas
 * (bottom-right), it shows controls for the ONE grid that currently holds attention.primary
 * — the genuinely dynamic, contextual bit that doesn't fit a static panel:
 *
 *   focus / reset / cam-lock · layout mode · edit toggle (lit = editing) · scroll/frame readout · close
 *
 * It is NOT the open-file list — that's the FileTree (loaded rows + ✕ + the focused accent).
 * The HUD owns no behavior: each control is a thin binding of { fire: a bus verb, reflect: live
 * state }. State flows ONE WAY — subscribe to AttentionManager (primary/key) + registry changes
 * for instant retarget, plus a light poll for readouts that don't emit (scroll/frame/layout/edit).
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

// Trim a label (filename/path) for the header, keeping the tail (the basename).
function short(s, n = 26) {
  s = String(s || '');
  return s.length <= n ? s : '…' + s.slice(-(n - 1));
}

// The focused window's live state (attention.primary). Pure read.
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
  const [f, setF] = useState(() => readFocus(client));
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => setF(readFocus(client));
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    const unsubs = [
      am?.on?.('change:primary', refresh), am?.on?.('change:key', refresh),
    ].filter(Boolean);
    reg?.addChangeListener?.(refresh);                 // window removed/retargeted → restate
    const iv = setInterval(refresh, 150);              // scroll/frame/layout/edit don't emit — poll
    refresh();
    return () => {
      unsubs.forEach((u) => u?.());
      reg?.removeChangeListener?.(refresh);
      clearInterval(iv);
    };
  }, [client]);

  const fire = useCallback((...argv) => client?.router?.execute(argv), [client]);

  if (!f) return null;  // nothing focused → no helper

  return (
    <div style={S.panel} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div style={S.header}>
        <span style={S.htitle} title={f.name}>{short(f.name)}</span>
        <button type="button" style={S.collapse} title={collapsed ? 'expand' : 'collapse'}
          onClick={() => setCollapsed((c) => !c)}>{collapsed ? '▸' : '▾'}</button>
      </div>
      {!collapsed && (
        <div style={S.controls}>
          <div style={S.row}>
            <Btn onClick={() => fire('camera.focus', f.id)}>focus</Btn>
            <Btn onClick={() => fire('camera.reset')}>reset</Btn>
            <Toggle on={f.cameraLocked} onStyle={S.cyanOn} onClick={() => fire('camera.lock')}>
              {f.cameraLocked ? 'cam ●' : 'cam ○'}
            </Toggle>
            {/* close = remove the focused grid from the field (sheet.close if it's a tab) */}
            {f.isGrid && (
              <button type="button" style={S.closeBtn} title="close / remove this grid"
                onClick={() => fire('grid.close', f.id)}>close ✕</button>
            )}
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
    position: 'fixed', right: 12, bottom: 30, zIndex: 20,   // bottom-right over the canvas, raised to clear the inline status bar
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    background: 'rgba(10,12,16,0.82)', color: '#aebccb',
    border: '1px solid #283341', borderRadius: 7, padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: 8, minWidth: 210, maxWidth: 320,
    userSelect: 'none', backdropFilter: 'blur(6px)', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  controls: { display: 'flex', flexDirection: 'column', gap: 6 },
  row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  btn: {
    font: 'inherit', color: '#aebccb', background: '#1a212b',
    border: '1px solid #2a3340', borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
  },
  closeBtn: {
    font: 'inherit', color: '#d99', background: '#241a1d',
    border: '1px solid #4a2730', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', marginLeft: 'auto',
  },
  mode: {
    font: 'inherit', fontSize: 11, color: '#8b9aa8', background: '#141a22',
    border: '1px solid #232b34', borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
  },
  cyanOn: { color: '#08101a', background: '#6cf', border: '1px solid #6cf' },        // active mode / cam-lock
  editOn: { color: '#1a1206', background: '#f0b45a', border: '1px solid #f0b45a' },  // amber = editing
  readout: { color: '#6b7785', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  htitle: { color: '#6cf', fontWeight: 600, fontSize: 11, letterSpacing: 0.4, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  collapse: { font: 'inherit', color: '#9ab', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 },
};
