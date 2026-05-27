import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, ViewerCamera } from 'glyph3d-r3f';
import CommandProvider from '../../app/client/CommandProvider.jsx';
import FileTree from './FileTree.jsx';
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
      : client ? 'ready · drag = orbit/pan · wheel = zoom · click a file'
      : `engine: ${stage}`
    );
  }, [stage, error, client]);

  return (
    <>
      {atlas && !error && (
        <GlyphCanvas
          atlas={atlas}
          camera={{ position: [0, 0, 300], fov: 70, near: 0.1, far: 20000 }}
          onCreated={({ scene }) => { scene.background = new THREE.Color(0x050608); }}
          style={{ position: 'absolute', inset: 0 }}
        >
          <ViewerCamera ref={cameraRef} />
          {/* No children to load up front — the IDE starts empty; files arrive via
              file.open (sidebar click or CLI). The page is served by Vite (:5173);
              the command relay is the Go server on :8080 (?relay=PORT overrides). */}
          <CommandProvider
            atlas={atlas}
            port={relayPort}
            cameraControllerRef={cameraRef}
            onReady={setClient}
          />
        </GlyphCanvas>
      )}
      <FileTree client={client} />
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
