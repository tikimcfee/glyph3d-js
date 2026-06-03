// glyph3d hero demo — the product demonstrating itself.
//
// This file IS the pitch: the ~12 lines of <Demo> are the canonical
// "plug it in like this" usage that glyph3d.dev shows beside the canvas.
// Everything readable comes from the real published bindings — no fork,
// no special-case rendering. What you see here is what a buyer gets.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useGlyphEngine, GlyphCanvas, CodeGrid, ViewerCamera } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const SEED = `// glyph3d
// GPU-instanced 3D text for Three.js.
//
//   drag   -> orbit / pan
//   wheel  -> zoom
//   type   -> fill the space
//
// thousands of glyphs. one draw call. 60fps.
`;

// ── The whole demo. This block is also the install doc on glyph3d.dev. ──
function Demo() {
  const { atlas, error } = useGlyphEngine({ fontUrl }); // boots atlas + shaper + slug
  const [text, setText] = useState(SEED);

  // type-to-fill: text is a reactive prop, so keystrokes just grow the grid.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Backspace') { setText((t) => t.slice(0, -1)); e.preventDefault(); }
      else if (e.key === 'Enter') setText((t) => t + '\n');
      else if (e.key.length === 1) setText((t) => t + e.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 0, 95], fov: 70, near: 0.1, far: 10000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <ViewerCamera />                                       {/* drag = orbit/pan · wheel = zoom */}
      {/* sage (#a8a072) to match glyph3d.dev, not the library's default green */}
      <CodeGrid filename="hello.js" text={text} worldScale={0.025}
        textColor={{ r: 0.659, g: 0.627, b: 0.447 }} />
    </GlyphCanvas>
  );
}

// WebGPU is required (the renderer is WebGPU/TSL). Fail gracefully, never blank.
function Root() {
  if (typeof navigator !== 'undefined' && !navigator.gpu) {
    return (
      <div className="nogpu">
        this browser doesn't support WebGPU yet —&nbsp;
        <a href="https://github.com/tikimcfee/glyph3d-js">see glyph3d on GitHub</a>
      </div>
    );
  }
  return <Demo />;
}

createRoot(document.getElementById('root')).render(<Root />);
