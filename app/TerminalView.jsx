import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// TerminalView — a 2D interactive companion to the focused 3D TerminalGrid. Separate from
// the code EditorPanel on purpose: a terminal's input (ctrl-capture, escape sequences, paste,
// IME) is handled NATIVELY by xterm's own DOM input, so giving it its own widget keeps that
// regime cleanly isolated rather than conditionally toggled against CodeMirror.
//
// One PTY stream, two projections: OUTPUT mirrors grid.onBytes → xterm.write; INPUT goes
// xterm.onData → grid.onInput (the exact path the 3D terminal uses, so both surfaces drive the
// same shell). EntityKeystrokeRouter yields while the xterm DOM is focused, so keys aren't
// double-delivered. First cut shows output from attach-time forward (current-screen replay is a
// later refinement); the 3D view still shows the full live state.

const styles = {
  content: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0b0e13' },
  header: {
    padding: '6px 8px', borderBottom: '1px solid #1b1f29', color: '#7c8596',
    font: '11px ui-monospace, "JetBrains Mono", monospace', flex: '0 0 auto',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  host: { flex: '1 1 auto', minHeight: 0, padding: '4px' },
  empty: { padding: 12, color: '#5c6675', font: '12px ui-monospace, "JetBrains Mono", monospace' },
};

export default function TerminalView({ client }) {
  const hostRef = useRef(null);
  const [termId, setTermId] = useState(null);

  // Follow the focused terminal: primary/key slot whose entry is a terminal.
  useEffect(() => {
    if (!client) return undefined;
    const am = client.ctx?.attentionManager;
    const reg = client.ctx?.registry;
    const resolve = () => {
      const slot = am?.get?.('primary') || am?.get?.('key');
      const entry = slot?.id ? reg?.get?.(slot.id) : null;
      setTermId(entry?.type === 'terminal' ? entry.id : null);
    };
    const unsubs = [am?.on?.('change:primary', resolve), am?.on?.('change:key', resolve)].filter(Boolean);
    reg?.addChangeListener?.(resolve); // a killed/spawned terminal re-evaluates focus
    resolve();
    return () => { unsubs.forEach((u) => u?.()); reg?.removeChangeListener?.(resolve); };
  }, [client]);

  // Mount an xterm bound to the focused terminal grid; remount when the focus changes.
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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    // Fit the xterm to the dock panel, then resize the whole terminal (PTY + 3D grid) to match.
    // Two birds, one surface: (1) SIZING — nothing clipped, no manual-resize-to-see; (2) REPLAY —
    // the resize SIGWINCHs the program, which repaints the full screen, so the freshly-attached
    // xterm gets the CURRENT state, not just bytes-from-now. Skip until the panel has real dims.
    const syncSize = () => {
      try {
        fit.fit();
        const { cols, rows } = term;
        if (!cols || !rows || cols < 2 || rows < 2) return;
        if (cols !== grid.cols || rows !== grid.rows) {
          client?.router?.execute?.(['terminal.resize', termId, String(cols), String(rows)]);
        }
      } catch { /* renderer not ready yet */ }
    };

    // OUTPUT: same PTY stream the 3D emulator renders (incl. the resize-triggered repaint).
    const offBytes = grid.onBytes?.((payload) => { try { term.write(payload); } catch { /* disposed */ } });
    // INPUT: xterm emits the correct terminal bytes (as a string) → the grid's input hook.
    const onData = term.onData((data) => { grid.onInput?.(data, termId); });

    // Refit on mount (after layout settles) and live as the dock panel resizes (debounced).
    let timer = null;
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(syncSize, 150); });
    ro.observe(hostRef.current);
    requestAnimationFrame(syncSize);
    term.focus();

    return () => {
      ro.disconnect();
      clearTimeout(timer);
      offBytes?.();
      onData?.dispose?.();
      term.dispose();
    };
  }, [termId, client]);

  if (!termId) {
    return <div style={styles.empty}>No terminal focused — click one in the Terminals tab.</div>;
  }
  return (
    <div style={styles.content}>
      <div style={styles.header}>{termId}</div>
      <div ref={hostRef} style={styles.host} />
    </div>
  );
}
