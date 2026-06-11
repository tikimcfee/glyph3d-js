import React, { useEffect, useRef, useState } from 'react';
import { stateController } from '@glyph3d/core/services/state';

/**
 * ContextBreadcrumb — the vim-like text heads-up of what the user is locked
 * into: <FOCUS file>-<EDIT line:col>-<KEY target>. Renders 1:1 from the
 * InteractionContext's composable nodes (no string-building in the state
 * layer); compact but complete, tucked in a corner, collapsible, and movable —
 * deliberately a free-floating component so it can grow into a richer state
 * panel without re-homing. Position + collapsed state persist (g3d.contextHud.*).
 */

// kind → chip accent. FOCUS pale blue (hover/selection family), EDIT caret
// yellow (CodeGrid.CARET_COLOR), KEY green (live capture). Future kinds
// (visual, capture) add a row here and a renderer below — nothing else.
const ACCENT = { focus: '#9fd2ff', edit: '#ffd84d', key: '#7fe0a0' };

const tail = (s, n = 24) => {
  const t = String(s || '').split('/').pop();
  return t.length > n ? '…' + t.slice(-(n - 1)) : t;
};

function chipLabel(n) {
  if (n.kind === 'edit') return `EDIT ${n.cursor.line}:${n.cursor.col}`;
  if (n.kind === 'key') return `KEY ${n.entityType || tail(n.id)}`;
  return `${n.kind.toUpperCase()} ${tail(n.id)}`;
}

const wrapStyle = {
  position: 'fixed', zIndex: 40, display: 'flex', alignItems: 'center', gap: 4,
  background: 'rgba(11,14,19,0.82)', border: '1px solid #2a3140', borderRadius: 6,
  padding: '3px 6px', font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#aeb8c6', userSelect: 'none',
};

export default function ContextBreadcrumb({ client }) {
  const [nodes, setNodes] = useState([]);
  const [collapsed, setCollapsed] = useState(() => !!stateController.get('contextHud.collapsed', false));
  const [pos, setPos] = useState(() => stateController.get('contextHud.pos', null)); // {x,y} once dragged
  const posRef = useRef(pos);
  const rootRef = useRef(null);

  useEffect(() => {
    const ic = client?.ctx?.interactionContext;
    if (!ic) return;
    setNodes(ic.nodes());
    return ic.on(setNodes);
  }, [client]);

  if (!client) return null;

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

  // Until first drag: bottom-center, the vim command-line home — clear of the
  // HUD (bottom-right) and the dock (left). A drag switches to explicit x/y.
  const place = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', bottom: 36, transform: 'translateX(-50%)' };
  const innermost = nodes[nodes.length - 1];

  return (
    <div ref={rootRef} data-g3d-context style={{ ...wrapStyle, ...place }}>
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
          <span onClick={toggle} title="collapse" style={{ cursor: 'pointer', color: '#4a5468', padding: '0 2px' }}>–</span>
        </>
      )}
    </div>
  );
}
