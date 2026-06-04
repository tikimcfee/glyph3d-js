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

const setStatus = (t) => { const el = document.getElementById('status'); if (el) el.textContent = t; };
const relayPort = Number(new URLSearchParams(location.search).get('relay')) || 8080;
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
  const { atlas, stage, error } = useGlyphEngine({ fontUrl, fonts: FONT_CHAIN });
  const cameraRef = useRef(null);
  // The wired command client. CommandProvider (inside the Canvas) hands it up via
  // onReady so the DOM sidebar — which can't read the in-canvas context — can use
  // it. One source of truth, prop-drilled to the chrome.
  const [client, setClient] = useState(null);
  const [dockW, setDockW] = useState(320);   // resizable sidebar width (px)

  useEffect(() => {
    setStatus(
      error ? `boot failed: ${error.message}`
      : client ? 'shift-drag = look · drag = pan · scroll = up/down · shift-scroll = dolly · WASD = move'
      : `engine: ${stage}`
    );
  }, [stage, error, client]);

  // Layout: a top ButtonBar, then a row of [dockview panel sidebar | canvas].
  // The dock and canvas are flex SIBLINGS (not overlay), so the WebGPU canvas
  // is never a dockview panel — its GPU context can't be unmounted by a docking
  // op, and r3f auto-resizes to its container when the sidebar width changes.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <ButtonBar client={client} />
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
                port={relayPort}
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
      {/* in-canvas command input — drive bus verbs without leaving for the terminal */}
      <CommandBar client={client} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
