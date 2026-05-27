import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, CodeGrid, ViewerCamera } from 'glyph3d-r3f';
import CommandCenter from './CommandCenter.jsx';
// The consumer owns the font choice — the engine doesn't bake a path. Resolved
// via the core's "./fonts/*" export, not a reach into src/.
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

// Placeholder landing content — a single grid so the app has something to read
// while the real home surface (free-floating glyphs, parsed repositories) gets
// built on top. The whole point is that this is now driven by the command bus:
// ask Claude to take you somewhere, or type at it yourself.
const SAMPLE = `// glyph3d — home
//
// a place to read code and text in space.
//
//   drag   → orbit / pan
//   wheel  → zoom
//   the command bus drives everything else:
//     grid.list · camera.focus 0 · camera.move x y z
//
// this single grid is the seed. parsed repositories and
// free-floating glyphs grow from here.
`;

const setStatus = (t) => { const el = document.getElementById('status'); if (el) el.textContent = t; };

function App() {
  const { atlas, stage, error } = useGlyphEngine({ fontUrl });
  const gridRef = useRef(null);
  const cameraRef = useRef(null);

  useEffect(() => {
    setStatus(error ? `boot failed: ${error.message}` : `engine: ${stage}`);
  }, [stage, error]);

  // Verification: the ref fires at mount, BEFORE the content-load effect runs,
  // so read the glyph count on the next frame (after load) for an honest number.
  const onGrid = (grid) => {
    gridRef.current = grid;
    if (!grid) return;
    requestAnimationFrame(() => {
      const n = gridRef.current?.getGlyphCount?.() ?? '?';
      console.log(`[home] CodeGrid mounted via glyph3d-r3f — glyphs=${n}`);
      setStatus(`glyphs: ${n}   drag = orbit/pan · wheel = zoom`);
    });
  };

  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 0, 200], fov: 70, near: 0.1, far: 10000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x050608); }}
    >
      <ViewerCamera ref={cameraRef} />
      {/* The page is served by Vite (:5173); the command relay is the Go
          server (glyph3d-cli serve) on :8080. Override with ?relay=PORT.
          <CodeGrid> self-registers into the shared registry, so the command
          layer sees it with no wrapper. */}
      <CommandCenter
        atlas={atlas}
        port={Number(new URLSearchParams(location.search).get('relay')) || 8080}
        cameraControllerRef={cameraRef}
      >
        <CodeGrid ref={onGrid} filename="home.js" text={SAMPLE} worldScale={0.025} />
      </CommandCenter>
    </GlyphCanvas>
  );
}

createRoot(document.getElementById('root')).render(<App />);
