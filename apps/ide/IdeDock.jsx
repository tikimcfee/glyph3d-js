import React, { useCallback, useMemo, useRef } from 'react';
import { DockviewReact } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import './ide-dock.css';
import FileTree from './FileTree.jsx';
import TerminalsPanel from './TerminalsPanel.jsx';
import FieldVisitorsPanel from './FieldVisitorsPanel.jsx';

// IdeDock — the panel layer. A dockview surface that hosts the IDE's DOM panels
// (file tree, terminals; inspector/search later) with tabs, splits, float and
// layout persistence for free. Panels render our own React components, so going
// custom stays open.
//
// Canvas coexistence: this dock lives as a flex SIBLING of the WebGPU canvas
// (see main.jsx) — NOT an overlay, NOT hosting the canvas as a panel — so the
// GPU context is never unmounted by a docking op and no canvas clicks are stolen.
//
// Layout persistence: the dockview layout is part of the saved session. We hand
// SessionStore a thin bridge (toJSON/fromJSON + the known component names) and
// save on every layout change. Panels read the command `client` from a REF — not
// from serialized panel params — because dockview's toJSON turns a live object
// into `undefined`; the ref keeps both default and restored panels wired.

export default function IdeDock({ client }) {
  const apiRef = useRef(null);
  // Live client, read by the component factory below. Survives fromJSON restore
  // (where serialized params.client would be undefined).
  const clientRef = useRef(client);
  clientRef.current = client;

  // Stable component map (dockview keys panels by these). Each reads the live
  // client from the ref, so a restored panel is wired exactly like a fresh one.
  const components = useMemo(() => ({
    files: () => <FileTree client={clientRef.current} />,
    terminals: () => <TerminalsPanel client={clientRef.current} />,
    fieldVisitors: () => <FieldVisitorsPanel client={clientRef.current} />,
  }), []);

  const onReady = useCallback((event) => {
    const api = event.api;
    apiRef.current = api;

    // Give SessionStore a handle to serialize/restore this layout. If a saved
    // layout already loaded, this triggers the restore (fromJSON) immediately.
    client?.session?.setDockBridge({
      toJSON: () => api.toJSON(),
      fromJSON: (layout) => api.fromJSON(layout),
      components: Object.keys(components),
    });

    // Default panels — always built so the dock is never empty. A saved layout
    // (if any) replaces these via SessionStore's fromJSON.
    if (!api.getPanel('files')) {
      api.addPanel({ id: 'files', component: 'files', title: 'Files' });
    }
    if (!api.getPanel('terminals')) {
      api.addPanel({
        id: 'terminals',
        component: 'terminals',
        title: 'Terminals',
        position: { referencePanel: 'files', direction: 'within' },
      });
    }
    if (!api.getPanel('fieldVisitors')) {
      api.addPanel({
        id: 'fieldVisitors',
        component: 'fieldVisitors',
        title: 'Crew',
        position: { referencePanel: 'terminals', direction: 'within' },
      });
    }

    // Persist on any layout change (add/remove/move/resize). The store debounces
    // and no-ops until restore has finished, so this never clobbers saved state.
    api.onDidLayoutChange(() => clientRef.current?.session?.scheduleSave());
  }, [client, components]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <DockviewReact
        className="dockview-theme-dark glyph-dock"
        components={components}
        onReady={onReady}
      />
    </div>
  );
}
