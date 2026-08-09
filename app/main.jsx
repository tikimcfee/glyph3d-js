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

// Boot stamp — "what code am I running?", answered by the page itself and kept by the
// relay's log store (so `log.search boot` answers page-less from the CLI). Dev fetches the
// LIVE stamp from the vite middleware (the tree moves under a long-lived dev server — a
// server-start value would lie); the production bundle has no middleware and falls back to
// the define-baked stamp (build time is the version there).
fetch('/__glyph-boot.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  .then((live) => {
    const s = live || (typeof __GLYPH_BOOT_BUILD__ !== 'undefined' ? __GLYPH_BOOT_BUILD__ : null);
    if (s) console.info(`[boot] glyph3d ${s.hash}${s.dirty ? '+dirty' : ''} (${s.branch}) — ${s.at}${live ? ' · live tree' : ' · baked'}`);
  });

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

// Draggable splitter between the dock sidebar and the canvas. The sidebar width is
// app state (not pinned), so panels are resizable; the r3f canvas auto-resizes to its
// container as the width changes.
function DockResizer({ width, setWidth }) {
  const onDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => setWidth(Math.max(180, Math.min(900, startW + (ev.clientX - startX))));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return (
    <div
      onMouseDown={onDown}
      title="Drag to resize panels"
      style={{ flex: '0 0 6px', cursor: 'col-resize', background: '#11141b', borderLeft: '1px solid #1b1f29', borderRight: '1px solid #1b1f29' }}
    />
  );
}

function App() {
  // Atlas is built once at boot, so font/atlas-size settings are read here (a
  // change persists and takes hold on the next reload — the Settings panel says so).
  const { atlas, stage, error } = useGlyphEngine({
    fontUrl, fonts: FONT_CHAIN,
    fontSize: getSetting('atlas.fontSize'),
    atlasSize: getSetting('atlas.size'),
    // Base path for the prebaked slug-core asset, so a sub-path deploy (/ide/) fetches
    // /ide/slug-core/<key>.bin and not /slug-core/<key>.bin.
    coreAssetBase: import.meta.env.BASE_URL,
  });
  const cameraRef = useRef(null);
  // The wired command client. CommandProvider (inside the Canvas) hands it up via
  // onReady so the DOM sidebar — which can't read the in-canvas context — can use
  // it. One source of truth, prop-drilled to the chrome.
  const [client, setClient] = useState(null);
  // Dock-overlay width + hidden state persist as chrome prefs (StateController /
  // localStorage), NOT in the relay-backed session snapshot — they're UI chrome and
  // should survive a reload even in client-only mode.
  const [dockW, setDockW] = useState(() => stateController.get('chrome.dockWidth', 320));
  const [dockHidden, setDockHidden] = useState(() => stateController.get('chrome.dockHidden', false));
  // 'overlay' = dock floats over a constant-size canvas (slides to hide); 'inline' =
  // dock is a flex sibling that splits the row (canvas reflows to the rest).
  const [dockMode, setDockMode] = useState(() => stateController.get('chrome.dockMode', 'overlay'));
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

  // Persist the dock chrome prefs. Width is debounced (a resize drag fires many
  // updates) so it writes once when the drag settles; the hidden toggle is rare and
  // written immediately. Reads happen at mount (the useState initializers above).
  useEffect(() => {
    const t = setTimeout(() => stateController.set('chrome.dockWidth', dockW), 400);
    return () => clearTimeout(t);
  }, [dockW]);
  useEffect(() => { stateController.set('chrome.dockHidden', dockHidden); }, [dockHidden]);
  useEffect(() => { stateController.set('chrome.dockMode', dockMode); }, [dockMode]);

  // Idle resting message for the StatusBar (loading activity overrides it there).
  const hint = error ? `boot failed: ${error.message}`
    : !client ? `engine: ${stage}`
    : 'drag pan · shift-drag look · scroll dolly · WASD move';

  // Dock placement is a chrome toggle (persisted). 'overlay': the dock floats over a
  // constant-size canvas and slides to hide — resizing/hiding never resizes the WebGPU
  // canvas. 'inline': the dock is a flex sibling that splits the row, so the canvas
  // reflows to the remaining space (the classic sidebar, at the cost of a canvas resize
  // on each dock resize). Crucially, the canvas + dock keep the SAME tree position in
  // both modes — only these style objects change — so the GlyphCanvas is never
  // remounted (no GPU-context churn) on a toggle.
  const inlineDock = dockMode === 'inline';
  const rowStyle = inlineDock
    ? { display: 'flex', flex: '1 1 auto', minHeight: 0 }
    : { position: 'relative', flex: '1 1 auto', minHeight: 0 };
  const canvasWrapStyle = inlineDock
    ? { position: 'relative', flex: '1 1 auto', minWidth: 0, order: 2 }
    : { position: 'absolute', inset: 0 };
  const dockWrapStyle = inlineDock
    ? { flex: `0 0 ${dockHidden ? 0 : dockW}px`, minWidth: 0, display: 'flex', order: 1, overflow: 'hidden' }
    : {
        position: 'absolute', top: 0, left: 0, bottom: 0, width: `${dockW}px`,
        display: 'flex', zIndex: 10,
        transform: dockHidden ? 'translateX(-100%)' : 'translateX(0)',
        transition: 'transform 0.18s ease',
      };

  // Layout: a top ButtonBar, then the canvas + dock laid out per dockMode (see above).
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <ButtonBar
        client={client}
        onOpenPalette={() => setPaletteOpen(true)}
        dockHidden={dockHidden}
        onToggleDock={() => setDockHidden((h) => !h)}
        dockMode={dockMode}
        onToggleDockMode={() => setDockMode((m) => (m === 'overlay' ? 'inline' : 'overlay'))}
      />
      <div style={rowStyle}>
        {/* WebGPU canvas. Overlay mode: full-bleed/constant. Inline mode: the flex-1
            column that reflows to the space the dock leaves. Same element in both, so
            toggling never remounts it. */}
        <div style={canvasWrapStyle}>
          {atlas && !error && (
            <GlyphCanvas
              atlas={atlas}
              // near 0.1 → 1.0: depth precision scales linearly with near — at a 15k-unit
              // library vantage, near 0.1 makes one depth step ~134 world units (the whole
              // sheet pitch z-fights; rear text bleeds through front panels). near 1 is
              // 10× that; see docs/plans/z-order-transparency-reorg.md. Live: camera.nearPlane.
              camera={{ position: [0, 0, 300], fov: 70, near: 1.0, far: 20000 }}
              // Backdrop is the renderer's clear color, NOT scene.background —
              // a null scene.background means the GPU pick pass never has to
              // touch scene state to keep its ID buffer clean (a set background
              // would bleed into the pick target as a stray low id).
              onCreated={({ gl }) => { gl.setClearColor(new THREE.Color(0x050608), 1); }}
              // Device loss (VRAM exhaustion, driver reset): three's default handler
              // freezes the render loop and leaves a live-but-frozen page whose GPU
              // readbacks storm (the 2026-08-04 mapAsync flood) and whose layout
              // engine fails every flush — the "munged layout" state. three can't
              // re-request a device mid-page, and the session substrate restores in
              // ~2s, so queue a reload: the only real recovery. Loop-guarded — the
              // load that OOM'd the device replays on restore, so a second loss
              // within a minute must NOT reload again (a reload loop never settles).
              onRenderer={(renderer) => {
                renderer.onDeviceLost = (info) => {
                  renderer._isDeviceLost = true;  // the default handler's one useful act
                  console.error(`[glyph3d] WebGPU device lost — ${info?.message || 'unknown reason'}`);
                  const last = Number(sessionStorage.getItem('g3d.deviceLostReload') || 0);
                  if (Date.now() - last < 60_000) {
                    console.error('[glyph3d] device lost again within a minute of a reload — staying put (loop guard); reload manually with a lighter scene');
                    return;
                  }
                  sessionStorage.setItem('g3d.deviceLostReload', String(Date.now()));
                  console.error('[glyph3d] reloading in 300ms to re-create the GPU device (session restores from the substrate)…');
                  setTimeout(() => window.location.reload(), 300);
                };
              }}
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
        {/* dock — overlay (absolute, slides to hide) or inline (flex sibling that
            collapses to hide) per dockMode; see dockWrapStyle above. The DockResizer
            sets dockW in both modes; in inline the canvas reflows, in overlay it doesn't. */}
        <div style={dockWrapStyle}>
          <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
            {client
              ? <IdeDock client={client} />
              : <div style={{ width: '100%', height: '100%', padding: 12, color: '#7c8596', background: 'rgba(8,10,14,0.92)', font: '12px ui-monospace, monospace' }}>starting…</div>}
          </div>
          <DockResizer width={dockW} setWidth={setDockW} />
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
