// glyph3d SPACE — the closing monument.
//
// A big 3D field of source files in a cool, varied palette, the camera
// drifting in a slow orbital sway. The promise made literal: lots of data,
// rendered — "millions, in space." Files are static (positioned once); only
// the camera moves, so it's cheap, and the drift is a pure function of t so it
// loops seamlessly. The sway stays in the front hemisphere so the files read
// as text (and their colors/shapes carry the rest).

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const TAU = Math.PI * 2;
const DURATION = 32;           // slow, monumental

// a cool, varied palette — "all these colors"
const PALETTE = [
  { r: 0.659, g: 0.627, b: 0.447 }, // sage
  { r: 0.82,  g: 0.56,  b: 0.38  }, // amber
  { r: 0.44,  g: 0.62,  b: 0.68  }, // teal
  { r: 0.64,  g: 0.56,  b: 0.78  }, // violet
  { r: 0.52,  g: 0.68,  b: 0.50  }, // green
  { r: 0.80,  g: 0.66,  b: 0.42  }, // gold
];

// Bake in an ACTUAL project directory at build time and let the substrate
// render it — real files, real sizes, the product's own use case ("point it at
// a repo"), not hand-written samples. import.meta.glob pulls the core library
// source as raw text; each file is truncated to its first lines so the field
// stays a readable mass, and colored by its directory so modules cluster.
const RAW = import.meta.glob('../../packages/glyph3d-core/src/**/*.js', {
  query: '?raw', import: 'default', eager: true,
});
const MAX_FILES = 54, MAX_LINES = 14;
const dirColor = {}; let dirN = 0;
const colorFor = (dir) => (dir in dirColor ? dirColor[dir] : (dirColor[dir] = PALETTE[dirN++ % PALETTE.length]));
const FILES = Object.entries(RAW)
  .map(([path, src]) => { const parts = path.split('/'); return { name: parts.pop(), dir: parts.pop(), src: String(src) }; })
  .filter((f) => f.src.trim().length > 0)
  .sort((a, b) => (a.dir + '/' + a.name).localeCompare(b.dir + '/' + b.name))   // cluster by directory
  .slice(0, MAX_FILES)
  .map((f) => ({ name: f.name, color: colorFor(f.dir), text: f.src.split('\n').slice(0, MAX_LINES).join('\n') }));

// arrange into a deep 3D grid — the layout (depth sells the scale on the orbit)
const COLS = 6, ROWS = 3;
const PER_PLANE = COLS * ROWS;
const PLANES = Math.max(1, Math.ceil(FILES.length / PER_PLANE));
const COLX = 84, ROWY = 66, PLANEZ = 125;
const CELLS = FILES.map((f, i) => {
  const plane = Math.floor(i / PER_PLANE), within = i % PER_PLANE;
  const row = Math.floor(within / COLS), col = within % COLS;
  return {
    key: 'f' + i, name: f.name, text: f.text, color: f.color,
    pos: [
      (col - (COLS - 1) / 2) * COLX,
      ((ROWS - 1) / 2 - row) * ROWY,
      (plane - (PLANES - 1) / 2) * PLANEZ,
    ],
  };
});

const WS = 0.03;
const RAD = 470, CAM_Y = 48, SWAY = 0.52;

function Director() {
  const { camera } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);

  const apply = (t) => {
    const az = Math.sin(t * TAU) * SWAY;                 // pendulum across the front
    camera.position.set(
      Math.sin(az) * RAD,
      CAM_Y + Math.sin(t * TAU + 1.3) * 22,              // gentle vertical drift
      Math.cos(az) * RAD,
    );
    camera.lookAt(0, 0, 0);
  };

  React.useEffect(() => {
    window.demo = {
      duration: DURATION, ready: true,
      seek: (t) => { auto.current = false; tRef.current = ((t % 1) + 1) % 1; apply(tRef.current); },
      play: () => { auto.current = true; },
    };
    return () => { delete window.demo; };
  }, []);

  useFrame((_, dt) => {
    if (auto.current) tRef.current = (tRef.current + dt / DURATION) % 1;
    apply(tRef.current);
  });

  return null;
}

function App() {
  const { atlas, error } = useGlyphEngine({ fontUrl });
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, CAM_Y, RAD], fov: 50, near: 1, far: 5000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director />
      {CELLS.map((c) => (
        <CodeGrid key={c.key} filename={c.name} text={c.text} position={c.pos}
          worldScale={WS} textColor={c.color} showBackground={false} />
      ))}
    </GlyphCanvas>
  );
}

function Root() {
  if (typeof navigator !== 'undefined' && !navigator.gpu) {
    return (
      <div className="nogpu">
        this browser doesn't support WebGPU yet —&nbsp;
        <a href="https://github.com/tikimcfee/glyph3d-js">see glyph3d on GitHub</a>
      </div>
    );
  }
  return <App />;
}

createRoot(document.getElementById('root')).render(<Root />);
