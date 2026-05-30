import React, { useCallback, useRef } from 'react';
import { DockviewReact } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import './ide-dock.css';
import FileTree from './FileTree.jsx';
import TerminalsPanel from './TerminalsPanel.jsx';

// IdeDock — the panel layer. A dockview surface that hosts the IDE's DOM panels
// (the file tree today; terminals-list / search / inspector later) with tabs,
// splits, drag-rearrange, float and layout persistence for free. Panels render
// our own React components, so going custom stays open.
//
// Canvas coexistence: this dock lives as a flex SIBLING of the WebGPU canvas
// (see main.jsx) — NOT as an overlay and NOT hosting the canvas as a panel — so
// the GPU context is never unmounted by a docking op and no canvas clicks are
// stolen. All-sides / float-over-canvas docking is a deliberate later evolution.
//
// `client` is the wired command client (CommandProvider → main.jsx). IdeDock is
// only mounted once client is ready, so panels get it via addPanel params (no
// context-across-portal dance, no null flash).

const components = {
  // Each panel component receives { params, api, containerApi }. We thread the
  // command client through params — the same client the panels always took.
  files: (props) => <FileTree client={props.params.client} />,
  terminals: (props) => <TerminalsPanel client={props.params.client} />,
};

export default function IdeDock({ client }) {
  const apiRef = useRef(null);

  const onReady = useCallback((event) => {
    apiRef.current = event.api;
    // Idempotent: don't double-add if dockview ever re-fires onReady.
    if (!event.api.getPanel('files')) {
      event.api.addPanel({
        id: 'files',
        component: 'files',
        title: 'Files',
        params: { client },
      });
    }
    // Terminals as a tab in the same group as Files — drag it out to split.
    if (!event.api.getPanel('terminals')) {
      event.api.addPanel({
        id: 'terminals',
        component: 'terminals',
        title: 'Terminals',
        params: { client },
        position: { referencePanel: 'files', direction: 'within' },
      });
    }
  }, [client]);

  // dockview fills its parent — give it an explicitly-sized box so it doesn't
  // collapse to 0 height/width inside the flex sidebar.
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
