import React, { useEffect, useRef, useState } from 'react';
import { stateController } from '@glyph3d/core/services/state';

/**
 * ContextBreadcrumb — the vim-like text heads-up of what the user is locked
 * into: <FOCUS file>-<EDIT line:col>-<KEY target>. Renders 1:1 from the
 * InteractionContext's composable nodes (no string-building in the state
 * layer); compact but complete, tucked in a corner, collapsible, and movable —
 * deliberately a free-floating component so it can grow into a richer state
 * panel without re-homing. Position + collapsed state persist (g3d.contextHud.*).
 *
 * It also renders the LSP row — a SEPARATE subscription to the LspNavigator (the
 * def/refs model for the symbol at the caret) — as its first, compact view: a
 * launcher-grade summary of definition + references, each chip click jumping via
 * lsp.goto. The full, previewed list is the dedicated panel's job.
 */

// kind → chip accent. FOCUS pale blue (hover/selection family), AST violet
// (the semantic family), EDIT caret yellow (CodeGrid.CARET_COLOR), KEY green
// (live capture), LSP teal (the navigator). Future kinds add a row here and a
// renderer below — nothing else.
const ACCENT = { focus: '#9fd2ff', ast: '#c8a9ff', edit: '#ffd84d', key: '#7fe0a0', lsp: '#6fe0c8' };

const tail = (s, n = 24) => {
  const t = String(s || '').split('/').pop();
  return t.length > n ? '…' + t.slice(-(n - 1)) : t;
};

// Split a flattened path into its address-bar segments (drop empties so a
// leading/trailing slash doesn't render a blank chip).
const segmentsOf = (p) => String(p || '').split('/').filter(Boolean);

function chipLabel(n) {
  if (n.kind === 'edit') return `EDIT ${n.cursor.line}:${n.cursor.col}`;
  if (n.kind === 'ast') return n.label;
  if (n.kind === 'key') return `KEY ${n.entityType || tail(n.id)}`;
  return `${n.kind.toUpperCase()} ${tail(n.id)}`;
}

const wrapStyle = {
  position: 'fixed', zIndex: 40, display: 'flex', flexDirection: 'column',
  background: 'rgba(11,14,19,0.82)', border: '1px solid #2a3140', borderRadius: 6,
  font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#aeb8c6', userSelect: 'none', maxWidth: '60vw',
};

// The chip row (grip + state chips + controls), the optional address bar, and
// the optional LSP row — each a horizontal strip stacked vertically.
const rowStyle = { display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px' };
const addrStyle = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 3,
  padding: '3px 8px', borderTop: '1px solid #1c222c',
};
const lspRowStyle = {
  display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
  borderTop: '1px solid #1c222c',
};
const lspBtn = (color) => ({ cursor: 'pointer', color, padding: '0 4px', whiteSpace: 'nowrap' });

export default function ContextBreadcrumb({ client }) {
  const [nodes, setNodes] = useState([]);
  const [lsp, setLsp] = useState(null); // LspNavigator state
  const [collapsed, setCollapsed] = useState(() => !!stateController.get('contextHud.collapsed', false));
  const [addr, setAddr] = useState(() => !!stateController.get('contextHud.addr', false)); // address bar open
  const [hoverSeg, setHoverSeg] = useState(-1); // address-bar segment under the cursor
  const [pos, setPos] = useState(() => stateController.get('contextHud.pos', null)); // {x,y} once dragged
  const posRef = useRef(pos);
  const rootRef = useRef(null);

  useEffect(() => {
    const ic = client?.ctx?.interactionContext;
    const nav = client?.ctx?.lspNavigator;
    const offs = [];
    if (ic) { setNodes(ic.nodes()); offs.push(ic.on(setNodes)); }
    if (nav) { setLsp(nav.state()); offs.push(nav.on(setLsp)); }
    return () => offs.forEach((o) => o?.());
  }, [client]);

  if (!client) return null;

  // Drag by the grip: fixed-position move clamped to the viewport; position
  // persists on release. Until first drag it anchors bottom-center.
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
      if (posRef.current) stateController.set('contextHud.pos', posRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const toggle = () => {
    setCollapsed((c) => {
      stateController.set('contextHud.collapsed', !c);
      return !c;
    });
  };

  const toggleAddr = () => {
    setAddr((a) => {
      stateController.set('contextHud.addr', !a);
      return !a;
    });
  };

  // Jump to an ancestor directory (or the focused entity itself) by its full
  // path — the same absolute focus the keyboard walk lands on, via the bus.
  const focusPath = (p) => { if (p) client?.router?.execute?.(['focus.path', p]); };

  // Jump to a known LSP location (a def/ref chip) via the bus.
  const jumpLoc = (l) => client?.router?.execute?.(
    ['lsp.goto', l.uri, String(l.sL), String(l.sC), String(l.eL), String(l.eC)]);

  // Until first drag: bottom-center, the vim command-line home — clear of the
  // HUD (bottom-right) and the dock (left). A drag switches to explicit x/y.
  const place = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', bottom: 36, transform: 'translateX(-50%)' };
  const innermost = nodes[nodes.length - 1];
  const focus = nodes.find((n) => n.kind === 'focus') || null;
  const segs = focus ? segmentsOf(focus.path) : [];
  const showAddr = !collapsed && addr && segs.length > 0;
  const showLsp = !collapsed && lsp?.status === 'ready' && (lsp.def || lsp.refs.length > 0);

  return (
    <div ref={rootRef} data-g3d-context style={{ ...wrapStyle, ...place }}>
      <div style={rowStyle}>
        <span
          onPointerDown={onGripDown}
          title="drag to move"
          style={{ cursor: 'grab', color: '#4a5468', letterSpacing: -1, padding: '0 2px' }}
        >⠿</span>
        {collapsed ? (
          <span
            onClick={toggle}
            title={nodes.map(chipLabel).join(' · ') || 'no locked context'}
            style={{ cursor: 'pointer', color: innermost ? ACCENT[innermost.kind] : '#4a5468' }}
          >
            ● {nodes.length}
          </span>
        ) : (
          <>
            {nodes.length === 0 && <span style={{ color: '#4a5468' }}>free</span>}
            {nodes.map((n, i) => (
              <span
                key={`${n.kind}:${n.id}:${i}`}
                data-kind={n.kind}
                title={n.id}
                style={{
                  borderLeft: `2px solid ${ACCENT[n.kind] || '#4a5468'}`,
                  padding: '0 5px', whiteSpace: 'nowrap',
                }}
              >
                {chipLabel(n)}
              </span>
            ))}
            {segs.length > 0 && (
              <span
                onClick={toggleAddr}
                title={addr ? 'hide path' : 'show full path'}
                style={{ cursor: 'pointer', color: addr ? ACCENT.focus : '#4a5468', padding: '0 2px' }}
              >{addr ? '▾' : '▸'}</span>
            )}
            <span onClick={toggle} title="collapse" style={{ cursor: 'pointer', color: '#4a5468', padding: '0 2px' }}>–</span>
          </>
        )}
      </div>
      {showAddr && (
        <div style={addrStyle} data-g3d-address onMouseLeave={() => setHoverSeg(-1)}>
          <span style={{ color: '#4a5468' }}>⌂</span>
          {segs.map((s, i) => {
            const prefix = segs.slice(0, i + 1).join('/');
            const isTail = i === segs.length - 1;
            const hot = hoverSeg === i;
            return (
              <React.Fragment key={i}>
                <span style={{ color: '#39424f' }}>›</span>
                <span
                  onClick={() => focusPath(prefix)}
                  onMouseEnter={() => setHoverSeg(i)}
                  title={`focus ${prefix}`}
                  style={{
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    color: isTail ? ACCENT.focus : (hot ? '#cdd6e2' : '#8893a3'),
                    textDecoration: hot ? 'underline' : 'none',
                  }}
                >{s}</span>
              </React.Fragment>
            );
          })}
        </div>
      )}
      {showLsp && (
        <div style={lspRowStyle} data-g3d-lsp>
          <span style={{ color: '#4a5468' }} title="LSP — definition & references">⌖</span>
          {lsp.def && (
            <span
              onClick={() => jumpLoc(lsp.def)}
              title={`definition\n${lsp.def.uri}\n${lsp.def.preview}`}
              style={lspBtn(ACCENT.lsp)}
            >def {lsp.def.label}</span>
          )}
          {lsp.refsTotal > 0 && (
            <span
              onClick={() => client?.router?.execute?.(['panel.open', 'lspResults'])}
              title="open the LSP results panel"
              style={lspBtn(ACCENT.ast)}
            >{lsp.refsTotal} ref{lsp.refsTotal === 1 ? '' : 's'} ▸</span>
          )}
        </div>
      )}
    </div>
  );
}
