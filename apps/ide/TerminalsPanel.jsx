import React, { useEffect, useState, useCallback } from 'react';

// TerminalsPanel — the IDE's live terminal roster, a dockview panel sibling of
// FileTree. Lists every live shell in the canvas, focuses one on click, and
// tears one down with ×. The second panel proves the dock is general — not a
// FileTree special-case.
//
// Like FileTree, it issues NO bespoke logic: every action is a command-bus verb
// (terminal.focus / camera.focus / terminal.kill / terminal.spawn), identical to
// a CLI invocation. It stays in sync WITHOUT polling: terminal.create/.close
// mutate ctx.registry IN THIS BROWSER (the display is this page), so a registry
// change-listener fires synchronously on every spawn/teardown. Focus highlight
// rides the AttentionManager's change events the same way.
//
// `client` is the wired command client (CommandProvider → main.jsx → addPanel
// params). The panel only mounts once client is ready.

const styles = {
  content: {
    width: '100%', height: '100%',
    background: 'rgba(8,10,14,0.92)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    font: '12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace', color: '#c8ccd6',
  },
  header: {
    padding: '8px', borderBottom: '1px solid #1b1f29',
    color: '#7c8596', letterSpacing: '0.04em', flex: '0 0 auto',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  count: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  newBtn: {
    flex: '0 0 auto', border: '1px solid #1b1f29', borderRadius: 3,
    background: 'rgba(255,255,255,0.03)', color: '#c8ccd6',
    font: 'inherit', padding: '1px 7px', cursor: 'pointer',
  },
  list: { overflowY: 'auto', flex: '1 1 auto', padding: '4px 0' },
  row: (focused) => ({
    display: 'flex', alignItems: 'center', gap: 6,
    cursor: 'pointer', userSelect: 'none',
    padding: '3px 8px 3px 6px',
    borderLeft: `2px solid ${focused ? '#7ad7a0' : 'transparent'}`,
    background: focused ? 'rgba(122,215,160,0.06)' : 'transparent',
    color: focused ? '#dfe3ea' : '#c8ccd6',
  }),
  dot: { color: '#7ad7a0', flex: '0 0 auto' },
  name: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dims: { flex: '0 0 auto', color: '#5c6675' },
  kill: {
    flex: '0 0 auto', marginLeft: 2, padding: '0 5px', borderRadius: 3,
    color: '#7c8596', cursor: 'pointer',
  },
  msg: { padding: '12px', color: '#7c8596' },
};

// Read the live terminal set straight from the scene registry — the in-process
// source of truth. Each entry is {id, grid, type, meta}; grid.cols/rows are the
// live dims (post-resize), so we read the grid, not the (possibly stale) meta.
function readTerminals(client) {
  const registry = client?.ctx?.registry;
  if (!registry?.findByType) return [];
  return registry.findByType('terminal').map((e) => ({
    id: e.id,
    cols: e.grid?.cols ?? e.meta?.cols ?? '?',
    rows: e.grid?.rows ?? e.meta?.rows ?? '?',
  }));
}

export default function TerminalsPanel({ client }) {
  const [terminals, setTerminals] = useState(() => readTerminals(client));
  const [focusedId, setFocusedId] = useState(
    () => client?.ctx?.attentionManager?.get('primary')?.id ?? null,
  );

  // Live list: re-read on every registry change (terminal create/close fire it
  // synchronously, in-process) and on reconnect (refresh after a relay restart).
  useEffect(() => {
    const registry = client?.ctx?.registry;
    const bridge = client?.bridge;
    if (!registry?.addChangeListener) return undefined;

    const refresh = () => setTerminals(readTerminals(client));
    refresh();
    registry.addChangeListener(refresh);
    const offConn = bridge?.onConnectionChange ? bridge.onConnectionChange(refresh) : null;
    return () => {
      registry.removeChangeListener(refresh);
      if (offConn) offConn();
    };
  }, [client]);

  // Focus highlight: follow the primary attention slot (what a canvas click or
  // terminal.focus sets). Initialise + subscribe to its change events.
  useEffect(() => {
    const am = client?.ctx?.attentionManager;
    if (!am?.on) return undefined;
    setFocusedId(am.get('primary')?.id ?? null);
    return am.on('change:primary', (v) => setFocusedId(v?.id ?? null));
  }, [client]);

  const focus = useCallback((id) => {
    if (!client) return;
    // Take focus (primary + key = keystroke target), then frame it. Same verbs
    // the CLI/Claude use; id == registry id.
    client.router.execute(`terminal.focus ${id}`);
    client.router.execute(`camera.focus ${id}`);
  }, [client]);

  const kill = useCallback((id) => {
    if (!client) return;
    // Full teardown: signals the adapter to kill the shell + tmux session and
    // dispose the grid. The resulting registry change refreshes this list.
    client.router.execute(`terminal.kill ${id}`);
  }, [client]);

  const spawn = useCallback(() => {
    client?.router.execute('terminal.spawn');
  }, [client]);

  let body;
  if (!client) {
    body = <div style={styles.msg}>starting…</div>;
  } else if (terminals.length === 0) {
    body = <div style={styles.msg}>no terminals — “+ new” or the toolbar’s “+ terminal”</div>;
  } else {
    body = (
      <div style={styles.list}>
        {terminals.map((t) => (
          <div
            key={t.id}
            title={`focus ${t.id}`}
            onClick={() => focus(t.id)}
            style={styles.row(t.id === focusedId)}
          >
            <span style={styles.dot}>●</span>
            <span style={styles.name}>{t.id}</span>
            <span style={styles.dims}>{t.cols}×{t.rows}</span>
            <span
              title={`kill ${t.id} (shell + tmux session)`}
              onClick={(e) => { e.stopPropagation(); kill(t.id); }}
              style={styles.kill}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#e0888f'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#7c8596'; }}
            >×</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={styles.content}>
      <div style={styles.header}>
        <span style={styles.count}>
          {terminals.length ? `${terminals.length} terminal${terminals.length === 1 ? '' : 's'}` : 'terminals'}
        </span>
        <span
          title="spawn a shell in the canvas"
          onClick={spawn}
          style={styles.newBtn}
          role="button"
        >+ new</span>
      </div>
      {body}
    </div>
  );
}
