import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, ViewerCamera, SceneEnvironment, Minimap } from '@glyph3d/r3f';
import CommandProvider from './client/CommandProvider.jsx';
import ButtonBar from './ButtonBar.jsx';
import IdeDock from './IdeDock.jsx';
import { CanvasPicker, ObjectDragger, ResizeDragger, SelectionIndicator } from './client/CanvasInteraction.jsx';
import HudPanel from './client/HudPanel.jsx';
import CommandBar from './client/CommandBar.jsx';
import StatusBar from './StatusBar.jsx';
import ContextBreadcrumb from './ContextBreadcrumb.jsx';
import { getSetting } from './client/settings.js';
import { stateController } from '@glyph3d/core/services/state';
// Font fallback chain, priority order: clean code monospace first, then fonts
// that cover what it lacks (Nerd-Font icons/powerline/rounded box/stars, then
// braille + broad symbols), then "oh well" (a blank cell) for the rare holdout.
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import mesloUrl from '@glyph3d/core/fonts/MesloLGS-NF-Mono.ttf?url';
import dejavuUrl from '@glyph3d/core/fonts/DejaVuSans.ttf?url';

const FONT_CHAIN = [
  { url: fontUrl,   name: 'Cousine' },
  { url: mesloUrl,  name: 'MesloLGS NF Mono' },
  { url: dejavuUrl, name: 'DejaVu Sans' },
];

// ?relay=PORT pins the relay to a specific port (dev: vite serves the page, the Go
// relay is on another port). Absent → fall back to the last port the connection chip
// used (persisted in g3d.* localStorage), so a dev reload re-dials it without retyping;
// absent + none saved → the relay (if any) is same-origin as the page (the binary
// serves both). null lets CommandProvider gate auto-connect by host.
const savedRelayPort = stateController.get('relay.lastPort', null);
const relayParam = new URLSearchParams(location.search).get('relay')
  ?? (savedRelayPort != null ? String(savedRelayPort) : null);
// ?repo=owner/repo[/branch] → render that GitHub repo client-only (no relay needed).
const repoParam = new URLSearchParams(location.search).get('repo');

function App() {
  // Atlas is built once at boot, so font/atlas-size settings are read here (a
  // change persists and takes hold on the next reload — the Settings panel says so).
  const { atlas, stage, error } = useGlyphEngine({
    fontUrl, fonts: FONT_CHAIN,
    fontSize: getSetting('atlas.fontSize'),
    atlasSize: getSetting('atlas.size'),
  });
  const cameraRef = useRef(null);
  // The wired command client. CommandProvider (inside the Canvas) hands it up via
  // onReady so the DOM sidebar — which can't read the in-canvas context — can use
  // it. One source of truth, prop-drilled to the chrome.
  const [client, setClient] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showMinimap, setShowMinimap] = useState(() => getSetting('view.minimap'));
  const [, forceSettings] = useReducer((x) => x + 1, 0);   // re-read live settings on a change
  // Settings → number (color strings '#rrggbb' or numbers both → hex int that SceneEnvironment wants).
  const envHex = (key) => new THREE.Color(getSetting(key)).getHex();

  // ⌘K / Ctrl-K summons (and toggles) the command palette — the classic shortcut.
  // Capture phase + a modifier keeps it clear of the camera/edit keystroke paths.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The StatusBar owns status now — retire the pre-mount #status text (index.html's
  // first-paint "booting…") so the two don't double up.
  useEffect(() => {
    const el = document.getElementById('status');
    if (el) el.style.display = 'none';
  }, []);

  // The 3D minimap mounts/unmounts off its persisted setting — the toolbar button, the
  // Settings panel, and the `view.minimap` verb all flip the one key, and StateController
  // fires a `state-changed` event we re-read here. Unmounting cleanly returns the render
  // loop to r3f's auto-render; mounting hands it to <Minimap>'s scissored second pass.
  useEffect(() => {
    const sync = () => { setShowMinimap(getSetting('view.minimap')); forceSettings(); };
    window.addEventListener('state-changed', sync);
    return () => window.removeEventListener('state-changed', sync);
  }, []);

  // Idle resting message for the StatusBar (loading activity overrides it there).
  const hint = error ? `boot failed: ${error.message}`
    : !client ? `engine: ${stage}`
    : 'drag pan · shift-drag look · scroll dolly · WASD move';

  // Layout: a top ButtonBar, then the full-bleed canvas with the dock as a
  // click-through OVERLAY of floating panels on top of it (see IdeDock /
  // ide-dock.css). The canvas is never a dockview panel — its GPU context can't
  // be unmounted by a docking op — and the field stays drivable wherever a panel
  // isn't, because the dock's base grid passes clicks through to the canvas.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <ButtonBar client={client} onOpenPalette={() => setPaletteOpen(true)} />
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          {atlas && !error && (
            <GlyphCanvas
              atlas={atlas}
              camera={{ position: [0, 0, 300], fov: 70, near: 0.1, far: 20000 }}
              // Backdrop is the renderer's clear color, NOT scene.background —
              // a null scene.background means the GPU pick pass never has to
              // touch scene state to keep its ID buffer clean (a set background
              // would bleed into the pick target as a stray low id).
              onCreated={({ gl }) => { gl.setClearColor(new THREE.Color(0x050608), 1); }}
              style={{ position: 'absolute', inset: 0 }}
            >
              <ViewerCamera ref={cameraRef} />
              {/* Orientation landmarks for the fly camera (ground grid + gradient
                  skydome). On the default layer + unregistered, so picking, culling,
                  and the camera's look-distance never see them. */}
              <SceneEnvironment
                skyHorizon={envHex('env.skyHorizon')}
                skyZenith={envHex('env.skyZenith')}
                lineColor={envHex('env.gridColor')}
                xAxisColor={envHex('env.xAxisColor')}
                zAxisColor={envHex('env.zAxisColor')}
                minorCell={getSetting('env.minorCell')}
                majorCell={getSetting('env.majorCell')}
                fadeFar={getSetting('env.fadeFar')}
              />
              {/* 3D overview HUD — schematic boxes (per surface bounds) + the camera as a
                  moving frustum-cone, rendered as a scissored second pass. Mounts off the
                  view.minimap setting (toolbar button / Settings / `view.minimap` verb);
                  unmounting returns the render loop to r3f. */}
              {showMinimap && <Minimap />}
              {/* IDE starts empty; files arrive via file.open (sidebar click or CLI).
                  Page served by Vite (:5173); relay is the Go server :8080. */}
              <CommandProvider
                atlas={atlas}
                relay={relayParam}
                repo={repoParam}
                cameraControllerRef={cameraRef}
                onReady={setClient}
              >
                {/* Imperative-scene interaction (the grids are Object3Ds, not r3f
                    JSX): GPU-pick hover/click, Ctrl-drag move, grip-drag resize,
                    selection outlines. See CanvasInteraction.jsx. */}
                <CanvasPicker />
                <ObjectDragger />
                <ResizeDragger />
                <SelectionIndicator />
              </CommandProvider>
            </GlyphCanvas>
          )}
        </div>
        {/* Dock overlay: the wrapper is click-through (pointerEvents:none); only the
            floating panel windows capture clicks (ide-dock.css), so the field stays
            drivable wherever a panel isn't. */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {client
            ? <IdeDock client={client} />
            : <div style={{ position: 'absolute', top: 12, left: 12, pointerEvents: 'auto', padding: 12, color: '#7c8596', background: 'rgba(8,10,14,0.92)', font: '12px ui-monospace, monospace' }}>starting…</div>}
        </div>
      </div>
      {/* inline status bar — the bottom strip (a real flex row, not a floating pill):
          activity/load narration on the left, relay state on the right */}
      <StatusBar client={client} hint={hint} />
      {/* control HUD — fixed overlay on the canvas (raised to clear the status bar) */}
      <HudPanel client={client} />
      {/* context breadcrumb — the vim-like "what am I locked into" chips
          (focus/edit/key nodes); collapsible + draggable, position persists */}
      <ContextBreadcrumb client={client} />
      {/* command palette — summoned modal (⌘K) to drive bus verbs; stays open per command */}
      <CommandBar client={client} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

// Fast Refresh re-executes this entry module on edit, so a bare createRoot() would run
// twice on the same container and warn ("already passed to createRoot"). Cache the root
// on the container and reuse it across re-runs — one root per #root, HMR-safe.
const container = document.getElementById('root');
const root = (container.__glyphRoot ??= createRoot(container));
root.render(<App />);
