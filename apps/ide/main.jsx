import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, ViewerCamera } from 'glyph3d-r3f';
import CommandProvider from '../../app/client/CommandProvider.jsx';
import ButtonBar from './ButtonBar.jsx';
import IdeDock from './IdeDock.jsx';
import { CanvasPicker, ObjectDragger, ResizeDragger, SelectionIndicator } from './CanvasInteraction.jsx';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const setStatus = (t) => { const el = document.getElementById('status'); if (el) el.textContent = t; };
const relayPort = Number(new URLSearchParams(location.search).get('relay')) || 8080;

function App() {
  const { atlas, stage, error } = useGlyphEngine({ fontUrl });
  const cameraRef = useRef(null);
  // The wired command client. CommandProvider (inside the Canvas) hands it up via
  // onReady so the DOM sidebar — which can't read the in-canvas context — can use
  // it. One source of truth, prop-drilled to the chrome.
  const [client, setClient] = useState(null);

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
        <div style={{ flex: '0 0 300px', minWidth: 0 }}>
          {client
            ? <IdeDock client={client} />
            : <div style={{ width: '100%', padding: 12, color: '#7c8596', background: 'rgba(8,10,14,0.92)', font: '12px ui-monospace, monospace' }}>starting…</div>}
        </div>
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
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
