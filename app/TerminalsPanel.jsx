import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import './ide-dock.css';
import TerminalView from './TerminalView.jsx';
import { wireTerminalDock } from './client/terminalDockSync.js';

// TerminalsPanel — the IDE's terminal workspace: a NESTED dockview where each live shell is a
// real panel. Folding the old roster list and the standalone Terminal view into one tab, the
// panel tabs ARE the roster — so there's no separate list, one fewer core tab, and the tabs get
// dockview's native behaviour for free: drag-to-reorder, drag-to-split (two terminals
// side-by-side), and — via the 'always' renderer — kept-alive xterms whose scrollback survives
// tab switches.
//
// It owns no behaviour: every action is a command-bus verb (terminal.focus / camera.focus /
// terminal.kill / terminal.spawn), identical to a CLI invocation. The inner dock is kept in sync
// with the scene, both directions, around a single source of truth:
//   registry → panels: a registry change-listener (spawn/kill fire it synchronously, in-process)
//     adds/removes panels to match the live terminal set.
//   attention ↔ active tab: the AttentionManager's `primary` slot drives which tab is active, and
//     a user-initiated tab activation drives terminal.focus back. Activations WE initiate are
//     identity-matched and consumed silently (see client/terminalDockSync.js) so the two directions
//     can't echo into a loop — and so a restore-time activation can't fly the camera on launch.
//
// Containment: dockview gates drops by the originating instance's id, and each DockviewComponent
// gets a distinct module-counter id — so a terminal tab can't be dragged out into the main IDE
// dock, nor an Editor tab dropped in here. `disableFloatingGroups` + an explicit onWillDrop guard
// (reject foreign sources) make that fence belt-and-suspenders.
//
// `client` is the wired command client (CommandProvider → main.jsx → addPanel params).

const styles = {
  wrap: { width: '100%', height: '100%' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px 0 8px',
    font: '12px ui-monospace, "JetBrains Mono", Menlo, monospace', whiteSpace: 'nowrap',
  },
  dot: { color: '#7ad7a0', flex: '0 0 auto', fontSize: 10 },
  dims: { flex: '0 0 auto', color: '#5c6675' },
  drop: { flex: '0 0 auto', padding: '0 2px', borderRadius: 3, color: '#7c8596', cursor: 'pointer' },
  kill: { flex: '0 0 auto', padding: '0 4px', borderRadius: 3, color: '#7c8596', cursor: 'pointer' },
  spawn: {
    display: 'flex', alignItems: 'center', height: '100%', padding: '0 10px',
    cursor: 'pointer', color: '#7c8596',
    font: '13px ui-monospace, "JetBrains Mono", Menlo, monospace',
  },
  watermark: {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10,
    background: 'rgba(8,10,14,0.92)', color: '#5c6675',
    font: '12px ui-monospace, "JetBrains Mono", Menlo, monospace',
  },
  watermarkBtn: {
    border: '1px solid #1b1f29', borderRadius: 3, background: 'rgba(255,255,255,0.03)',
    color: '#c8ccd6', font: 'inherit', padding: '4px 12px', cursor: 'pointer',
  },
};

// Live terminal set straight from the scene registry — the in-process source of truth.
function readTerminals(client) {
  const registry = client?.ctx?.registry;
  if (!registry?.findByType) return [];
  return registry.findByType('terminal').map((e) => e.id);
}
// Live dims for one terminal — read off the grid (the live cache), the one place that always
// carries the rendered dimensions. (The registry no longer mirrors size; the model decides it.)
function readDims(client, id) {
  const e = client?.ctx?.registry?.get?.(id);
  return e ? `${e.grid?.cols ?? '?'}×${e.grid?.rows ?? '?'}` : '';
}

export default function TerminalsPanel({ client }) {
  // Live client read by the dockview component/tab factories (stable identities below).
  const clientRef = useRef(client);
  clientRef.current = client;
  const apiRef = useRef(null);
  const disposersRef = useRef([]);

  // Stable component + tab maps (dockview keys renderers by these). Each reads the live client
  // from the ref, so identity never churns across re-renders.
  const { components, tabComponents, Watermark, PrefixActions } = useMemo(() => {
    // The panel body: a 2D xterm bound to this panel's terminal. The dockview panel api lets the
    // view focus when its tab is active and refit when shown (it has no size while hidden).
    const Terminal = ({ params, api }) => (
      <TerminalView client={clientRef.current} termId={params.termId} panelApi={api} />
    );

    // The tab (titlebar): live id + dims + a ⌖ that drops the window camera-front (window.drop —
    // pulls it out of any dock/carrel holding it) + a × that kills the shell. Clicking the tab
    // body is dockview's own activate (→ terminal.focus via onDidActivePanelChange); both stop that.
    const Tab = ({ params }) => {
      const id = params.termId;
      const [dims, setDims] = useState(() => readDims(clientRef.current, id));
      useEffect(() => {
        const reg = clientRef.current?.ctx?.registry;
        if (!reg?.addChangeListener) return undefined;
        const r = () => setDims(readDims(clientRef.current, id));
        reg.addChangeListener(r);
        return () => reg.removeChangeListener(r);
      }, [id]);
      return (
        <div style={styles.tab}>
          <span style={styles.dot}>●</span>
          <span>{id}</span>
          <span style={styles.dims}>{dims}</span>
          <span
            title={`drop ${id} in front of the camera (window.drop)`}
            onClick={(e) => { e.stopPropagation(); clientRef.current?.router.execute(`window.drop ${id}`); }}
            style={styles.drop}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#8ab4f8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#7c8596'; }}
          >⌖</span>
          <span
            title={`kill ${id} (shell + tmux session)`}
            onClick={(e) => { e.stopPropagation(); clientRef.current?.router.execute(`terminal.kill ${id}`); }}
            style={styles.kill}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#e0888f'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#7c8596'; }}
          >×</span>
        </div>
      );
    };

    const spawn = () => clientRef.current?.router.execute('terminal.spawn');
    // ＋ in the tab bar (when terminals exist) and centred in the watermark (when none do).
    const Prefix = () => (
      <span title="spawn a shell in the canvas" role="button" onClick={spawn} style={styles.spawn}>＋</span>
    );
    const Wm = () => (
      <div style={styles.watermark}>
        <div>no terminals</div>
        <button type="button" onClick={spawn} style={styles.watermarkBtn}>＋ new terminal</button>
      </div>
    );

    return {
      components: { terminal: Terminal },
      tabComponents: { terminal: Tab },
      Watermark: Wm,
      PrefixActions: Prefix,
    };
  }, []);

  const onReady = useCallback((event) => {
    const api = event.api;
    apiRef.current = api;
    const disposers = [];

    // The registry↔panels↔attention state machine, incl. the identity-matched guard that keeps a
    // programmatic activation (restore re-adopt, attention sync) from flying the camera / hijacking
    // focus the way a real tab click does — robust to dockview's async activation events.
    const dock = wireTerminalDock(api, {
      getClient: () => clientRef.current,
      listTerminalIds: readTerminals,
    });
    dock.syncPanels();

    const reg = clientRef.current?.ctx?.registry;
    if (reg?.addChangeListener) {
      reg.addChangeListener(dock.syncPanels);
      disposers.push(() => reg.removeChangeListener(dock.syncPanels));
    }
    const am = clientRef.current?.ctx?.attentionManager;
    if (am?.on) disposers.push(am.on('change:primary', dock.syncActive));
    disposers.push(() => dock.dispose());

    disposersRef.current = disposers;
  }, []);

  // Tear down our registry/attention listeners on unmount (DockviewReact disposes itself).
  useEffect(() => () => { disposersRef.current.forEach((fn) => fn()); disposersRef.current = []; }, []);

  // Belt-and-suspenders fence: reject any drop whose data came from a different dockview instance
  // (a foreign tab). Same-instance reorders/splits carry our own viewId and pass through.
  const onWillDrop = useCallback((event) => {
    const data = event.getData?.();
    if (data && apiRef.current && data.viewId !== apiRef.current.id) event.preventDefault();
  }, []);

  return (
    <div style={styles.wrap}>
      <DockviewReact
        className="dockview-theme-dark glyph-dock"
        components={components}
        tabComponents={tabComponents}
        watermarkComponent={Watermark}
        prefixHeaderActionsComponent={PrefixActions}
        defaultRenderer="always"
        disableFloatingGroups
        singleTabMode="default"
        onWillDrop={onWillDrop}
        onReady={onReady}
      />
    </div>
  );
}
