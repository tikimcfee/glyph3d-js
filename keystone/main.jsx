import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, CodeGrid, ViewerCamera } from 'glyph3d-r3f';
import CommandCenter, { useAppCommands } from './CommandCenter.jsx';
// The consumer owns the font choice — the engine doesn't bake a path. Resolved
// via the core's "./fonts/*" export, not a reach into src/.
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const SAMPLE = `// glyph3d-r3f bindings — keystone harness
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

const canvas = "<GlyphCanvas> owns the WebGPU renderer";
const grid   = "<CodeGrid> is this file, as a 3D body";
const camera = "<ViewerCamera> drives pan / orbit / zoom";

// Drag to orbit/pan, wheel to zoom. If this reads crisply and moves,
// the bindings hold and the keystone is now a real package.
for (let i = 0; i < 8; i++) {
  console.log(\`box ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼  line \${i}\`);
}
`;

const setStatus = (t) => { const el = document.getElementById('status'); if (el) el.textContent = t; };

function App() {
  const { atlas, stage, error } = useGlyphEngine({ fontUrl });
  const gridRef = useRef(null);

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
      console.log(`[keystone] CodeGrid mounted via glyph3d-r3f — glyphs=${n}`);
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
      <ViewerCamera />
      {/* The page is served by Vite (:5173); the command relay is the Go
          server (glyph3d-cli serve) on :8080. Override with ?relay=PORT. */}
      <CommandCenter atlas={atlas} port={Number(new URLSearchParams(location.search).get('relay')) || 8080}>
        <TrackedCodeGrid ref={onGrid} filename="keystone.js" text={SAMPLE} worldScale={0.025} />
      </CommandCenter>
    </GlyphCanvas>
  );
}

// A CodeGrid that registers itself in the command-context registry on mount, so
// registry/grid commands (grid.list, registry.list) see it. The vanilla IDE did
// this through ctx.addGrid in its load path; here it's a thin r3f wrapper.
const TrackedCodeGrid = React.forwardRef(function TrackedCodeGrid(props, ref) {
  const client = useAppCommands();
  const setGrid = (grid) => {
    if (grid && client) client.ctx.addGrid(grid, { id: props.filename });
    if (typeof ref === 'function') ref(grid);
    else if (ref) ref.current = grid;
  };
  return <CodeGrid ref={setGrid} {...props} />;
});

createRoot(document.getElementById('root')).render(<App />);
