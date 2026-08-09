import React, { useEffect, useRef, useState, useCallback } from 'react';
import { stateController } from '@glyph3d/core/services/state';
import { DEFAULT_LAYOUT } from '@glyph3d/core/workers/builders/index.js';

/**
 * HudPanel — THE one floating helper over the canvas: what you're locked into, and
 * what you can do about it. The old pair (a bottom-center context breadcrumb that
 * REFLECTED focus/edit/key state, a bottom-right panel that CONTROLLED the focused
 * window) merged into one deterministic window — bottom-right by default, draggable,
 * collapsible, position + toggles persisted as hud.*.
 *
 * Top-down, each row earning its place only when its subject is in play:
 *
 *   header        grip · focused name (the FOCUS accent) · address toggle · collapse
 *   context chips AST scope · EDIT caret · KEY target — rendered 1:1 from the
 *                 InteractionContext's composable nodes, SUBSCRIPTION-driven (the
 *                 itests assert cursor moves land without polling)
 *   address bar   the focus path as clickable segments → focus.path (the same
 *                 absolute focus the keyboard walk lands on)
 *   LSP row       def + references at the caret (LspNavigator) → lsp.goto / panel
 *   controls      camera row · dir-volume splay⇄collapse · layout modes · edit + readout
 *
 * The HUD owns no behavior: every control is a thin { fire: a bus verb, reflect:
 * live state } binding. Reflection subscribes to InteractionContext + LspNavigator +
 * AttentionManager + registry, and polls only the readouts that don't emit
 * (scroll/frame/layout/edit).
 */

const LAYOUT_MODES = ['long-column', 'newspaper', 'no-wrap', 'z-pages'];

// kind → chip accent. FOCUS pale blue (hover/selection family), AST violet (the
// semantic family), EDIT caret yellow (CodeGrid.CARET_COLOR), KEY green (live
// capture), LSP teal (the navigator). Future kinds add a row here and a renderer.
const ACCENT = { focus: '#9fd2ff', ast: '#c8a9ff', edit: '#ffd84d', key: '#7fe0a0', lsp: '#6fe0c8' };

// Best-guess the active preset from the grid's layout params (modes are param bundles, so this is
// an inference for the highlight, not authoritative). Missing params read as DEFAULT_LAYOUT.
function inferMode(L) {
  if (!L) return null;
  if (L.axis === 'z') return 'z-pages';
  if ((L.wrapWidth ?? DEFAULT_LAYOUT.wrapWidth) === 0) return 'no-wrap';
  if ((L.pageHeight ?? DEFAULT_LAYOUT.pageHeight) === 0) return 'long-column';
  return 'newspaper';
}

// Trim a label (filename/path) for the header, keeping the tail (the basename).
function short(s, n = 26) {
  s = String(s || '');
  return s.length <= n ? s : '…' + s.slice(-(n - 1));
}

const tailName = (s, n = 24) => {
  const t = String(s || '').split('/').pop();
  return t.length > n ? '…' + t.slice(-(n - 1)) : t;
};

// Split a flattened path into its address-bar segments (drop empties so a
// leading/trailing slash doesn't render a blank chip).
const segmentsOf = (p) => String(p || '').split('/').filter(Boolean);

// The FOCUS node dedupes into the header title; every other kind renders a chip.
function chipLabel(n) {
  if (n.kind === 'edit') return `EDIT ${n.cursor.line}:${n.cursor.col}`;
  if (n.kind === 'ast') return n.label;
  if (n.kind === 'key') return `KEY ${n.entityType || tailName(n.id)}`;
  return `${n.kind.toUpperCase()} ${tailName(n.id)}`;
}

// The focused window's control state (attention.primary). Pure read — polled, since
// scroll/frame/layout/edit don't emit.
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
  // The VOLUME in play — the same resolution a bare book verb runs (the strata idiom):
  // the focused entity itself, or the volume the focused file's book is riding.
  const tree = client.ctx.contentTree;
  let volume = grid.userData?.isVolume ? grid : null;
  if (!volume && tree?.bookAt) {
    for (let n = tree.bookAt(id); n; n = n.parent) {
      if (n.userData?.isVolume) { volume = n; break; }
    }
  }
  return {
    id,
    type: type || (isGrid ? 'grid' : 'window'),
    name: grid.getFilename?.() || grid.userData?.name || id,
    isGrid,
    volume: volume ? {
      path: volume.userData.path, name: volume.userData.name,
      form: volume.form, head: volume.head, count: volume.sheets.length,
    } : null,
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
  const [nodes, setNodes] = useState([]);       // InteractionContext — subscription, no poll
  const [lsp, setLsp] = useState(null);         // LspNavigator state
  const [collapsed, setCollapsed] = useState(() => !!stateController.get('hud.collapsed', false));
  const [addr, setAddr] = useState(() => !!stateController.get('hud.addr', false)); // address bar open
  const [hoverSeg, setHoverSeg] = useState(-1); // address-bar segment under the cursor
  const [pos, setPos] = useState(() => stateController.get('hud.pos', null)); // {x,y} once dragged
  const posRef = useRef(pos);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!client) return undefined;
    const refresh = () => setF(readFocus(client));
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    const ic = client.ctx?.interactionContext;
    const nav = client.ctx?.lspNavigator;
    const unsubs = [
      am?.on?.('change:primary', refresh), am?.on?.('change:key', refresh),
    ].filter(Boolean);
    if (ic) { setNodes(ic.nodes()); unsubs.push(ic.on(setNodes)); }
    if (nav) { setLsp(nav.state()); unsubs.push(nav.on(setLsp)); }
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

  // Drag by the grip: fixed-position move clamped to the viewport; position
  // persists on release. Until first drag it anchors bottom-right above the
  // status bar.
  const onGripDown = (e) => {
    e.preventDefault();
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      const p = {
        x: Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)),
        y: Math.max(0, Math.min(window.innerHeight - r.height, ev.clientY - dy)),
      };
      posRef.current = p;
      setPos(p);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      if (posRef.current) stateController.set('hud.pos', posRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const toggle = () => setCollapsed((c) => {
    stateController.set('hud.collapsed', !c);
    return !c;
  });

  const toggleAddr = () => setAddr((a) => {
    stateController.set('hud.addr', !a);
    return !a;
  });

  // Jump to an ancestor directory (or the focused entity itself) by its full
  // path — the same absolute focus the keyboard walk lands on, via the bus.
  const focusPath = (p) => { if (p) fire('focus.path', p); };

  // Jump to a known LSP location (a def/ref chip) via the bus.
  const jumpLoc = (l) => fire('lsp.goto', l.uri, String(l.sL), String(l.sC), String(l.eL), String(l.eC));

  const focusNode = nodes.find((n) => n.kind === 'focus') || null;
  const chips = nodes.filter((n) => n.kind !== 'focus');   // FOCUS lives in the title
  if (!f && nodes.length === 0) return null;               // truly free → no helper

  const title = f?.name || (focusNode ? tailName(focusNode.path) : 'free');
  const segs = focusNode ? segmentsOf(focusNode.path) : [];
  const showChips = !collapsed && chips.length > 0;
  const showAddr = !collapsed && addr && segs.length > 0;
  const showLsp = !collapsed && lsp?.status === 'ready' && (lsp.def || lsp.refs.length > 0);

  // Until first drag: bottom-right over the canvas, raised to clear the inline
  // status bar. A drag switches to explicit x/y.
  const place = pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 30 };

  return (
    <div ref={rootRef} style={{ ...S.panel, ...place }}
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div style={S.header}>
        <span onPointerDown={onGripDown} title="drag to move" style={S.grip}>⠿</span>
        <span style={S.htitle} title={focusNode?.path || f?.id || title}>{short(title)}</span>
        {segs.length > 0 && (
          <button type="button" style={S.collapse} title={addr ? 'hide path' : 'show full path'}
            onClick={toggleAddr}>{addr ? '▾' : '▸'}</button>
        )}
        <button type="button" style={S.collapse} title={collapsed ? 'expand' : 'collapse'}
          onClick={toggle}>{collapsed ? '◂' : '▾'}</button>
      </div>
      {/* Context chips — the locked-in state (AST scope, caret, key target), 1:1 from
          the InteractionContext. data-g3d-context is the itests' ground-truth probe. */}
      {showChips && (
        <div style={S.chips} data-g3d-context>
          {chips.map((n, i) => (
            <span key={`${n.kind}:${n.id}:${i}`} data-kind={n.kind} title={n.id}
              style={{ ...S.chip, borderLeft: `2px solid ${ACCENT[n.kind] || '#4a5468'}` }}>
              {chipLabel(n)}
            </span>
          ))}
        </div>
      )}
      {showAddr && (
        <div style={S.addr} data-g3d-address onMouseLeave={() => setHoverSeg(-1)}>
          <span style={{ color: '#4a5468' }}>⌂</span>
          {segs.map((s, i) => {
            const prefix = segs.slice(0, i + 1).join('/');
            const isTail = i === segs.length - 1;
            const hot = hoverSeg === i;
            return (
              <React.Fragment key={i}>
                <span style={{ color: '#39424f' }}>›</span>
                <span onClick={() => focusPath(prefix)} onMouseEnter={() => setHoverSeg(i)}
                  title={`focus ${prefix}`}
                  style={{
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    color: isTail ? ACCENT.focus : (hot ? '#cdd6e2' : '#8893a3'),
                    textDecoration: hot ? 'underline' : 'none',
                  }}>{s}</span>
              </React.Fragment>
            );
          })}
        </div>
      )}
      {showLsp && (
        <div style={S.lspRow} data-g3d-lsp>
          <span style={{ color: '#4a5468' }} title="LSP — definition & references">⌖</span>
          {lsp.def && (
            <span onClick={() => jumpLoc(lsp.def)}
              title={`definition\n${lsp.def.uri}\n${lsp.def.preview}`}
              style={S.lspBtn(ACCENT.lsp)}>def {lsp.def.label}</span>
          )}
          {lsp.refsTotal > 0 && (
            <span onClick={() => fire('panel.open', 'lspResults')}
              title="open the LSP results panel"
              style={S.lspBtn(ACCENT.ast)}>{lsp.refsTotal} ref{lsp.refsTotal === 1 ? '' : 's'} ▸</span>
          )}
        </div>
      )}
      {!collapsed && f && (
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
          {/* The dir volume in play (the focused file's, or the focused cover itself):
              deck ⇄ splay — the button names the ACTION, the lit state means splayed. */}
          {f.volume && (
            <div style={S.row}>
              <Toggle on={f.volume.form === 'splay'}
                onClick={() => fire('book.form', f.volume.path, f.volume.form === 'splay' ? 'deck' : 'splay')}>
                {f.volume.form === 'splay' ? 'collapse ▧' : 'splay ▦'}
              </Toggle>
              <span style={S.readout} title={f.volume.path}>
                {short(f.volume.name, 14)} · page {f.volume.head + 1}/{f.volume.count}
              </span>
            </div>
          )}
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
    position: 'fixed', zIndex: 20,   // placed via `place` — bottom-right default, draggable
    font: '12px ui-monospace, Menlo, Consolas, monospace',
    background: 'rgba(10,12,16,0.82)', color: '#aebccb',
    border: '1px solid #283341', borderRadius: 7, padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: 6, minWidth: 210, maxWidth: 340,
    userSelect: 'none', backdropFilter: 'blur(6px)', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
  },
  controls: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #1c222c', paddingTop: 6 },
  row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  chips: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, fontSize: 11 },
  chip: { padding: '0 5px', whiteSpace: 'nowrap', color: '#aeb8c6' },
  addr: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3,
    fontSize: 11, borderTop: '1px solid #1c222c', paddingTop: 5,
  },
  lspRow: {
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
    borderTop: '1px solid #1c222c', paddingTop: 5,
  },
  lspBtn: (color) => ({ cursor: 'pointer', color, padding: '0 4px', whiteSpace: 'nowrap' }),
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
  grip: { cursor: 'grab', color: '#4a5468', letterSpacing: -1, padding: '0 2px' },
  htitle: { color: '#9fd2ff', fontWeight: 600, fontSize: 11, letterSpacing: 0.4, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  collapse: { font: 'inherit', color: '#9ab', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 },
};
