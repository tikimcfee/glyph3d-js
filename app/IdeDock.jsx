import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { DockviewReact } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import './ide-dock.css';
import FileTree from './FileTree.jsx';
import RepoPanel from './RepoPanel.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import TerminalsPanel from './TerminalsPanel.jsx';
import AgentsPanel from './AgentsPanel.jsx';
import CarrelsPanel from './CarrelsPanel.jsx';
import MonitorPanel from './MonitorPanel.jsx';
import LayoutPanel from './LayoutPanel.jsx';
import EditorPanel from './EditorPanel.jsx';
import LspResultsPanel from './LspResultsPanel.jsx';

// IdeDock — the panel layer. A dockview surface that hosts the IDE's DOM panels
// (file tree, terminals; inspector/search later) with tabs, splits, float and
// layout persistence for free. Panels render our own React components, so going
// custom stays open.
//
// Canvas coexistence: this dock lives as a flex SIBLING of the WebGPU canvas
// (see main.jsx) — NOT an overlay, NOT hosting the canvas as a panel — so the
// GPU context is never unmounted by a docking op and no canvas clicks are stolen.
//
// Layout persistence: the dockview layout is part of the saved session. onReady
// builds the default catalog layout immediately (instant panels — and the only
// layout in client-only mode, where no restore runs), then registers the
// serialization bridge on ctx.dockLayout for the session loader's `panels` phase
// to PULL (toJSON/fromJSON/buildDefaults + the known component names). A saved
// layout is authoritative: the phase replaces the defaults wholesale via
// fromJSON, so a deliberately-closed tab stays closed; a newly-introduced
// catalog panel reaches an existing session via the panels menu, not
// force-injection. Panels read the command `client` from a REF — not from
// serialized panel params — because dockview's toJSON turns a live object into
// `undefined`; the ref keeps both default and restored panels wired.

// The panel catalog — the SINGLE source for both the default layout and the
// reopen path (the ButtonBar's panels menu / panel.* verbs). component === id.
// Array order matters: each position anchor must be added before the panel that
// references it.
const PANELS = [
  { id: 'files', title: 'Files' },
  { id: 'repo', title: 'Sources', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'agents', title: 'Agents', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'carrels', title: 'Carrels', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'lspResults', title: 'LSP', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'layout', title: 'Layout', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'settings', title: 'Settings', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'monitor', title: 'Monitor', position: { referencePanel: 'files', direction: 'within' } },
  { id: 'editor', title: 'Editor', position: { referencePanel: 'files', direction: 'below' } },
  // The combined Terminals workspace (sub-tab strip + 2D view) lives in the
  // bottom group tabbed with the Editor — the "focused thing in 2D" area — so
  // the terminal keeps a usable size. It replaces the old sidebar roster AND
  // the standalone Terminal tab.
  { id: 'terminals', title: 'Terminals', position: { referencePanel: 'editor', direction: 'within' } },
];
const panelDef = (id) => PANELS.find((p) => p.id === id);

// Add a panel if absent (placed by its catalog position when the anchor exists,
// else into the active group), or just focus it if already open. null = unknown id.
function openPanel(api, id) {
  const existing = api.getPanel(id);
  if (existing) { existing.api.setActive(); return existing; }
  const def = panelDef(id);
  if (!def) return null;
  const opts = { id, component: id, title: def.title };
  if (def.position && api.getPanel(def.position.referencePanel)) opts.position = def.position;
  return api.addPanel(opts);
}

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
    repo: () => <RepoPanel client={clientRef.current} />,
    settings: () => <SettingsPanel client={clientRef.current} />,
    monitor: () => <MonitorPanel client={clientRef.current} />,
    terminals: () => <TerminalsPanel client={clientRef.current} />,
    agents: () => <AgentsPanel client={clientRef.current} />,
    carrels: () => <CarrelsPanel client={clientRef.current} />,
    lspResults: () => <LspResultsPanel client={clientRef.current} />,
    layout: () => <LayoutPanel client={clientRef.current} />,
    editor: () => <EditorPanel client={clientRef.current} />,
  }), []);

  const onReady = useCallback((event) => {
    const api = event.api;
    apiRef.current = api;

    // Build the default catalog layout — every panel at its catalog position.
    const buildDefaults = () => {
      for (const def of PANELS) {
        if (api.getPanel(def.id)) continue;
        const opts = { id: def.id, component: def.id, title: def.title };
        if (def.position && api.getPanel(def.position.referencePanel)) opts.position = def.position;
        api.addPanel(opts);
      }
    };
    buildDefaults();

    // The dock's session seam, PULLED by the session loader (its `panels` phase
    // awaits ctx.dockLayout, prunes orphans against `components`, and applies the
    // saved layout — or rebuilds defaults when the apply fails). Pull-based
    // rendezvous by design: a store rebuilt by a vite hot swap finds the live dock
    // here, where a push-once handshake at construction would pair a live object
    // with a dead partner.
    if (client?.ctx) {
      client.ctx.dockLayout = {
        components: Object.keys(components),
        toJSON: () => api.toJSON(),
        fromJSON: (layout) => api.fromJSON(layout),
        buildDefaults,
      };
    }

    // Expose a dock controller on the command ctx so panel.* verbs (and the
    // ButtonBar's panels menu) can reopen a closed tab. The DOM layer owns the
    // dockview api; the bus stays provider-agnostic.
    if (client?.ctx) {
      client.ctx.dock = {
        open: (id) => (openPanel(api, id) ? { open: true } : null),
        close: (id) => {
          if (!panelDef(id)) return null;
          api.getPanel(id)?.api.close();
          return { open: false };
        },
        toggle: (id) => {
          if (!panelDef(id)) return null;
          const p = api.getPanel(id);
          if (p) { p.api.close(); return { open: false }; }
          openPanel(api, id);
          return { open: true };
        },
        list: () => PANELS.map((p) => ({ id: p.id, title: p.title, open: !!api.getPanel(p.id) })),
      };
    }

    // Auto-raise the matching 2D view when focus changes type: a code grid raises the Editor
    // tab, a terminal raises the Terminals tab. They're tabbed together (one "focused thing in
    // 2D" area), and dockview unmounts inactive tabs — so this also remounts the right panel,
    // making "click a thing → see it in 2D" work without manual tab-switching.
    const am = client?.ctx?.attentionManager;
    const reg = client?.ctx?.registry;
    if (am?.on) {
      const raiseFocusView = () => {
        const slot = am.get('primary') || am.get('key');
        const entry = slot?.id ? reg?.get?.(slot.id) : null;
        const want = entry?.type === 'terminal' ? 'terminals'
                   : entry?.type === 'grid' ? 'editor' : null;
        if (want) api.getPanel(want)?.api.setActive();
      };
      am.on('change:primary', raiseFocusView);
      am.on('change:key', raiseFocusView);
    }

    // Persist on any layout change (add/remove/move/resize). The store debounces
    // and no-ops until restore has finished, so this never clobbers saved state.
    api.onDidLayoutChange(() => clientRef.current?.session?.scheduleSave());
  }, [client, components]);

  // A dead dock must never satisfy the loader's pull — clear the seam on unmount.
  useEffect(() => () => { if (client?.ctx?.dockLayout) client.ctx.dockLayout = null; }, [client]);

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
