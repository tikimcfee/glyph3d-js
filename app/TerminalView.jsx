import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// TerminalView — a 2D interactive xterm bound to ONE TerminalGrid (by `termId`). Separate
// from the code EditorPanel on purpose: a terminal's input (ctrl-capture, escape sequences,
// paste, IME) is handled NATIVELY by xterm's own DOM input, so giving it its own widget keeps
// that regime cleanly isolated rather than conditionally toggled against CodeMirror.
//
// One PTY stream, two projections: OUTPUT mirrors grid.onBytes → xterm.write; INPUT goes
// xterm.onData → grid.onInput (the exact path the 3D terminal uses, so both surfaces drive the
// same shell). EntityKeystrokeRouter yields while the xterm DOM is focused, so keys aren't
// double-delivered.
//
// One view per terminal: TerminalsPanel mounts these as nested dockview panels (one per live
// shell, kept mounted via the 'always' renderer so scrollback survives tab switches). It binds
// to a fixed `termId` — the panel's tab, not this view, owns selection. The optional `panelApi`
// (the dockview panel's api) lets the view grab keyboard focus when its tab becomes active.
//
// SIZE IS OWNED BY THE 3D GRID, never the panel. This view is a pure VIEWPORT: it renders the
// xterm at the grid's cols×rows and FOLLOWS grid resizes (the 3D SE-grip) via grid.onResize, so
// its VT interpretation always matches the PTY. It does NOT fit-to-panel — making the 2D panel
// drive the PTY/grid size reflows the shell to whatever scrap of panel space it has (illegible)
// and fights the 3D grid for real estate. Instead the host clips and scrolls: the panel can be
// any size; you scroll to see the rest. (Replay on attach comes from terminal.refresh, not a
// resize.)

const styles = {
  content: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0b0e13' },
  host: { flex: '1 1 auto', minHeight: 0, padding: '4px', overflow: 'auto' },
  empty: { padding: 12, color: '#5c6675', font: '12px ui-monospace, "JetBrains Mono", monospace' },
};

export default function TerminalView({ client, termId, panelApi }) {
  const hostRef = useRef(null);

  // Mount an xterm bound to this terminal's grid; remount if the bound id changes.
  useEffect(() => {
    if (!termId || !hostRef.current) return undefined;
    const grid = client?.ctx?.registry?.get?.(termId)?.grid;
    if (!grid) return undefined;

    const term = new Terminal({
      cols: grid.cols || 80,
      rows: grid.rows || 24,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
      fontSize: 12,
      theme: { background: '#0b0e13', foreground: '#d1d9e0', cursor: '#7ad7a0' },
      cursorBlink: true,
      scrollback: 2000,
    });

    // OUTPUT: same PTY stream the 3D emulator renders. (xterm parses writes into its buffer even
    // before open(), so output streamed while a tab is hidden renders once it's shown.)
    const offBytes = grid.onBytes?.((payload) => { try { term.write(payload); } catch { /* disposed */ } });
    // INPUT: xterm emits the correct terminal bytes (as a string) → the grid's input hook.
    const onData = term.onData((data) => { grid.onInput?.(data, termId); });
    // SIZE: follow the grid (the size owner) so the xterm re-interprets the shared byte stream at
    // the new dimensions whenever the 3D grid is resized. Never the reverse — no fit-to-panel.
    const offResize = grid.onResize?.((cols, rows) => { try { term.resize(cols, rows); } catch { /* disposed */ } });

    // Open the xterm only once its host is actually visible: a hidden dockview 'always' panel has
    // zero size, and xterm measures its font cell at open() — measuring against a zero-size host
    // yields a broken cell with no clean re-measure hook. Deferring open() until the host is shown
    // guarantees a correct first measure. On open, request a full repaint (terminal.refresh) so a
    // freshly-attached view shows the CURRENT screen — replay WITHOUT resizing anything.
    let opened = false;
    const openIfVisible = () => {
      if (opened || !hostRef.current || (panelApi && !panelApi.isVisible)) return;
      opened = true;
      term.open(hostRef.current);
      client?.router?.execute?.(['terminal.refresh', termId]);
      if (!panelApi || panelApi.isActive) term.focus();
    };
    openIfVisible();

    // Focus when this tab becomes active; open (if still deferred) when it becomes visible.
    const offActive = panelApi?.onDidActiveChange?.(() => { if (opened && panelApi.isActive) term.focus(); });
    const offVisible = panelApi?.onDidVisibilityChange?.(() => { if (panelApi.isVisible) openIfVisible(); });

    return () => {
      offBytes?.();
      offResize?.();
      onData?.dispose?.();
      offActive?.dispose?.();
      offVisible?.dispose?.();
      term.dispose();
    };
  }, [termId, client, panelApi]);

  if (!termId) {
    return <div style={styles.empty}>No terminal — ＋ to spawn one.</div>;
  }
  return (
    <div style={styles.content}>
      <div ref={hostRef} style={styles.host} />
    </div>
  );
}
