import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, ViewerCamera } from 'glyph3d-r3f';
import CommandProvider from '../../app/client/CommandProvider.jsx';
import FileTree from './FileTree.jsx';
import { CanvasPicker, SelectionIndicator } from './CanvasInteraction.jsx';
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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setStatus(
      error ? `boot failed: ${error.message}`
      : client ? 'shift-drag = look · drag = pan · scroll = up/down · shift-scroll = dolly · WASD = move'
      : `engine: ${stage}`
    );
  }, [stage, error, client]);

  // Sidebar is a flex SIBLING of the canvas (not an overlay), so collapsing it
  // hands the width back to the 3D view. r3f's <Canvas> auto-resizes to its
  // container, so the camera/viewport follow the flex change for free.
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <FileTree client={client} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div style={{ flex: '1 1 auto', position: 'relative', minWidth: 0 }}>
        {atlas && !error && (
          <GlyphCanvas
            atlas={atlas}
            camera={{ position: [0, 0, 300], fov: 70, near: 0.1, far: 20000 }}
            onCreated={({ scene }) => { scene.background = new THREE.Color(0x050608); }}
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
              <CanvasPicker />
              <SelectionIndicator />
            </CommandProvider>
          </GlyphCanvas>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
