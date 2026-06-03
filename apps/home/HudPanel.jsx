import React, { useEffect, useState, useCallback } from 'react';

/**
 * HudPanel — the first modal-interface: a DOM-overlay "state HUD" that reflects + controls the
 * currently-focused window (attention.primary). It owns NO behavior — every control is a thin
 * binding of { fire: a command-bus verb, reflect: live state }. That makes it composable (add a
 * control = add a binding) and makes it the payoff of command-bus-first: chrome is bindings.
 *
 * State flows ONE WAY (state → view): we subscribe to AttentionManager change events for instant
 * focus/edit retargeting + poll lightly (~150ms) for the readouts that don't emit (scroll/frame/
 * layout). The lit state of the edit toggle IS the affordance — editing is explicit + visible,
 * never a silent click-to-edit. See [[project_control_state_layer]] / LAYOUT_PLAN §3c.
 */

// Layout-mode presets exposed in the HUD (match gridCommands.js LAYOUT_PRESETS).
const LAYOUT_MODES = ['newspaper', 'long-column', 'no-wrap', 'z-pages'];

// Best-guess the active preset from the grid's layout params. Modes are param bundles, so this
// is an inference for the highlight (not authoritative — a --flag combo may not map to a preset).
function inferMode(L) {
  if (!L) return null;
  if (L.axis === 'z') return 'z-pages';
  if ((L.wrapWidth ?? 200) === 0) return 'no-wrap';
  if ((L.pageHeight ?? 150) === 0) return 'long-column';
  return 'newspaper';
}

// Read the focused window's live state from the command client. Pure read — no mutation.
function readFocus(client) {
  const am = client?.ctx?.attentionManager;
  const reg = client?.ctx?.registry;
  if (!am || !reg) return null;
  const p = am.get?.('primary');
  if (!p?.id) return null;
  const entry = reg.get(p.id);
  if (!entry?.grid) return null;
  const { id, grid, type } = entry;
  const isGrid = typeof grid.getLayout === 'function';     // duck-type: terminals lack getLayout
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

  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => setF(readFocus(client));
    const am = client.ctx?.attentionManager;
    const unsubs = [am?.on?.('change:primary', refresh), am?.on?.('change:key', refresh)].filter(Boolean);
    const iv = setInterval(refresh, 150);  // scroll/frame/layout don't emit — poll lightly
    refresh();
    return () => { unsubs.forEach((u) => u?.()); clearInterval(iv); };
  }, [client]);

  const fire = useCallback((...argv) => client?.router?.execute(argv), [client]);

  if (!f) return null;  // nothing focused → no HUD (the panel is the focused window's chrome)

  return (
    <div
      style={S.panel}
      onPointerDown={(e) => e.stopPropagation()}  // the panel owns its clicks; don't start a camera drag
      onWheel={(e) => e.stopPropagation()}
    >
      <div style={S.title} title={f.id}>{f.type === 'terminal' ? '▤' : '▦'} {f.name}</div>

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
  );
}

// ── composable primitives — each is a thin binding of { onClick: fire(verb), reflect: on } ──
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
    display: 'flex', flexDirection: 'column', gap: 6, minWidth: 210,
    userSelect: 'none', backdropFilter: 'blur(6px)',
    boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  title: {
    color: '#6cf', fontWeight: 600, maxWidth: 280,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
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
