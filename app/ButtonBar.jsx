import React, { useEffect, useRef, useState } from 'react';

// ButtonBar — the top toolbar of text-label buttons (no icons, per the house
// style). Each button is a thin command-bus surface: it runs a router command,
// identical to how FileTree's clicks do — so a button and a CLI invocation are
// indistinguishable downstream.

const styles = {
  bar: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 8px',
    background: 'rgba(8,10,14,0.92)',
    borderBottom: '1px solid #1b1f29',
    font: '12px/1.4 ui-monospace, "JetBrains Mono", Menlo, monospace',
    userSelect: 'none',
    position: 'relative',  // stacking context so the panels menu paints over the canvas
    zIndex: 20,
  },
  btn: (enabled) => ({
    appearance: 'none',
    border: '1px solid #1b1f29',
    borderRadius: 4,
    background: enabled ? 'rgba(255,255,255,0.03)' : 'transparent',
    color: enabled ? '#c8ccd6' : '#4a515f',
    font: 'inherit',
    padding: '3px 9px',
    cursor: enabled ? 'pointer' : 'default',
  }),
  sep: {
    width: 1, alignSelf: 'stretch', margin: '2px 4px',
    background: '#1b1f29', flex: '0 0 auto',
  },
  menuWrap: { position: 'relative', flex: '0 0 auto' },
  menu: {
    position: 'absolute', top: 'calc(100% + 5px)', left: 0, zIndex: 50,
    background: 'rgba(10,12,17,0.98)', border: '1px solid #1b1f29', borderRadius: 5,
    padding: 4, minWidth: 150, boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
  },
  menuItem: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
    borderRadius: 4, cursor: 'pointer', color: '#c8ccd6', whiteSpace: 'nowrap',
  },
  menuDot: (open) => ({ width: 12, flex: '0 0 auto', color: open ? '#7ad7a0' : '#4a515f' }),
  conn: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' },
  connDot: (ok) => ({ color: ok ? '#7ad7a0' : '#4a515f', fontSize: 10 }),
  connLabel: { color: '#9aa3b2' },
  connPort: {
    width: 46, font: 'inherit', color: '#c8ccd6', background: '#0f141b',
    border: '1px solid #232b34', borderRadius: 4, padding: '2px 5px', outline: 'none',
  },
};

/** A single text button that runs a command and surfaces hover. */
function Btn({ label, title, cmd, client }) {
  const enabled = !!client;
  return (
    <button
      type="button"
      title={title}
      disabled={!enabled}
      style={styles.btn(enabled)}
      onMouseEnter={(e) => { if (enabled) e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
      onMouseLeave={(e) => { if (enabled) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
      onClick={() => client?.router.execute(cmd)}
    >
      {label}
    </button>
  );
}

// Panels menu — the way back for a closed dock tab. Lists the catalog with its
// open/closed state; a click toggles via the bus (panel.toggle), so it's the same
// action the CLI/Claude can run. The list is read on open (no live subscription
// needed — it's a momentary menu).
function PanelsMenu({ client }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const wrapRef = useRef(null);
  // Gate on `client` (reactive state) — NOT on ctx.dock: the dock controller is
  // attached by IdeDock's onReady via a plain mutation, which triggers no
  // re-render, so a dock-gated button would render disabled once and stay stuck.
  // The dock is set right after the client mounts; we read it fresh on click.
  const enabled = !!client;

  const refresh = () => setItems(client?.ctx?.dock?.list?.() || []);
  const toggleMenu = () => { if (!enabled) return; refresh(); setOpen((o) => !o); };

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (id) => { client?.router.execute(['panel.toggle', id]); refresh(); };

  return (
    <div ref={wrapRef} style={styles.menuWrap}>
      <button
        type="button"
        title="show / hide dock panels"
        disabled={!enabled}
        style={styles.btn(enabled)}
        onClick={toggleMenu}
      >panels ▾</button>
      {open && (
        <div style={styles.menu}>
          {items.map((p) => (
            <div
              key={p.id}
              style={styles.menuItem}
              onClick={() => pick(p.id)}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={styles.menuDot(p.open)}>{p.open ? '●' : '○'}</span>
              <span>{p.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ConnectionChip — the relay on/off switch. The relay is pure enhancement (local
// files + terminals + the bus); this shows whether it's live and toggles it via the
// bus (relay.connect/disconnect), same as the CLI. The port field overrides the
// boot-resolved target (blank = same origin as the page — the binary's case).
function ConnectionChip({ client }) {
  const [connected, setConnected] = useState(false);
  const [port, setPort] = useState('');
  const bridge = client?.bridge;

  useEffect(() => {
    if (!bridge?.onConnectionChange) return undefined;
    setPort(bridge.port ? String(bridge.port) : '');
    return bridge.onConnectionChange(setConnected);
  }, [bridge]);

  if (!client) return null;

  const toggle = () => {
    if (connected) client.router.execute('relay.disconnect');
    else client.router.execute(port ? ['relay.connect', port] : 'relay.connect');
  };
  // Keep keystrokes in the field (don't drive the camera/grid); Enter (re)connects.
  const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') toggle(); };

  return (
    <div style={styles.conn}>
      <span style={styles.connDot(connected)} title={connected ? bridge?.url : 'no relay'}>●</span>
      <span style={styles.connLabel}>{connected ? 'relay' : 'no relay'}</span>
      <input
        style={styles.connPort}
        value={port}
        onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
        onKeyDown={onKey}
        placeholder="port"
        title="relay port — blank connects to the page's origin (the binary)"
        spellCheck={false}
      />
      <button type="button" style={styles.btn(true)} onClick={toggle}>
        {connected ? 'disconnect' : 'connect'}
      </button>
    </div>
  );
}

export default function ButtonBar({ client, onOpenPalette }) {
  return (
    <div style={styles.bar}>
      <PanelsMenu client={client} />
      <button
        type="button"
        title="command palette (⌘K / Ctrl-K)"
        disabled={!client}
        style={styles.btn(!!client)}
        onClick={onOpenPalette}
      >commands ⌘K</button>
      <span style={styles.sep} />
      <Btn label="fit" title="frame all grids in view" cmd="camera.fitall" client={client} />
      <Btn label="reset" title="reset the camera to its home view" cmd="camera.reset" client={client} />
      <Btn label="relayout" title="re-pack the open grids into a flow layout" cmd="layout.flow" client={client} />
      <span style={styles.sep} />
      <Btn label="clear" title="remove all open code grids (terminals stay)" cmd="scene.clear_grids" client={client} />
      <ConnectionChip client={client} />
    </div>
  );
}
