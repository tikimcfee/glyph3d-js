import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, ViewerCamera } from 'glyph3d-r3f';
import CommandProvider from './client/CommandProvider.jsx';
import ButtonBar from './ButtonBar.jsx';
import IdeDock from './IdeDock.jsx';
import { CanvasPicker, ObjectDragger, ResizeDragger, SelectionIndicator } from './client/CanvasInteraction.jsx';
import HudPanel from './client/HudPanel.jsx';
import CommandBar from './client/CommandBar.jsx';
import StatusBar from './StatusBar.jsx';
import { getSetting } from './client/settings.js';
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
// relay is on another port). Absent → the relay (if any) is same-origin as the page
// (the binary serves both). null lets CommandProvider gate auto-connect by host.
const relayParam = new URLSearchParams(location.search).get('relay');
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
  });
  const cameraRef = useRef(null);
  // The wired command client. CommandProvider (inside the Canvas) hands it up via
  // onReady so the DOM sidebar — which can't read the in-canvas context — can use
  // it. One source of truth, prop-drilled to the chrome.
  const [client, setClient] = useState(null);
  const [dockW, setDockW] = useState(320);   // resizable sidebar width (px)
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  // Idle resting message for the StatusBar (loading activity overrides it there).
  const hint = error ? `boot failed: ${error.message}`
    : !client ? `engine: ${stage}`
    : 'shift-drag look · drag pan · scroll up/down · shift-scroll dolly · WASD move';

  // Layout: a top ButtonBar, then a row of [dockview panel sidebar | canvas].
  // The dock and canvas are flex SIBLINGS (not overlay), so the WebGPU canvas
  // is never a dockview panel — its GPU context can't be unmounted by a docking
  // op, and r3f auto-resizes to its container when the sidebar width changes.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <ButtonBar client={client} onOpenPalette={() => setPaletteOpen(true)} />
      <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
        <div style={{ flex: `0 0 ${dockW}px`, minWidth: 0, overflow: 'hidden' }}>
          {client
            ? <IdeDock client={client} />
            : <div style={{ width: '100%', padding: 12, color: '#7c8596', background: 'rgba(8,10,14,0.92)', font: '12px ui-monospace, monospace' }}>starting…</div>}
        </div>
        <DockResizer width={dockW} setWidth={setDockW} />
        <div style={{ flex: '1 1 auto', position: 'relative', minWidth: 0 }}>
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
      </div>
      {/* control HUD — companion overlay on top of the canvas + the panel system */}
      <HudPanel client={client} />
      {/* slim status pill — load/restore narration + relay dot (bottom-left) */}
      <StatusBar client={client} hint={hint} />
      {/* command palette — summoned modal (⌘K) to drive bus verbs; stays open per command */}
      <CommandBar client={client} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
