import React from 'react';

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

export default function ButtonBar({ client }) {
  return (
    <div style={styles.bar}>
      <Btn label="+ terminal" title="spawn a shell in the canvas" cmd="terminal.spawn" client={client} />
      <span style={styles.sep} />
      <Btn label="fit" title="frame all grids in view" cmd="camera.fitall" client={client} />
      <Btn label="reset" title="reset the camera to its home view" cmd="camera.reset" client={client} />
      <Btn label="relayout" title="re-pack the open grids into a flow layout" cmd="layout.flow" client={client} />
      <span style={styles.sep} />
      <Btn label="clear" title="remove all open code grids (terminals stay)" cmd="scene.clear_grids" client={client} />
    </div>
  );
}
