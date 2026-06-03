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

// a pool of short snippets — repeated across the field with varied color/shape
const SNIPS = [
`class GlyphAtlas {
  pack(g) {
    return shelf(g)
  }
}`,
`field.render(text, pos, {
  color, groupId,
})`,
`camera.focusOnGrids()
camera.lerp(t, 0.05)`,
`new GridLayoutManager()
  .addAuto(grid)`,
`buildSlugBuffers(
  shapeText(src, font)
)`,
`onmessage = (e) => {
  post(build(e.data))
}`,
`pick(x, y) {
  return resolve(
    read(x, y))
}`,
`class CodeGrid {
  loadFile(name, src)
}`,
`lines.set(id,
  from, to, color)`,
`boot()
mount(scene)`,
`export * from
  './core'`,
`for (const g of glyphs)
  buffer.push(g, pos)`,
];
const NAMES = ['atlas.js', 'field.js', 'camera.js', 'layout.js', 'shape.js', 'worker.js',
  'picking.js', 'grid.js', 'connect.js', 'main.js', 'index.js', 'write.js'];

// 3D grid: cols × rows × planes (the spatial layout, with depth for the orbit)
const COLS = 5, ROWS = 4, PLANES = 3;
const COLX = 52, ROWY = 38, PLANEZ = 66;
const CELLS = [];
{
  let i = 0;
  for (let p = 0; p < PLANES; p++)
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        CELLS.push({
          key: `f${i}`,
          name: NAMES[i % NAMES.length],
          text: SNIPS[i % SNIPS.length],
          color: PALETTE[(c * 2 + r + p * 3) % PALETTE.length],
          pos: [
            (c - (COLS - 1) / 2) * COLX,
            ((ROWS - 1) / 2 - r) * ROWY,
            (p - (PLANES - 1) / 2) * PLANEZ,
          ],
        });
        i++;
      }
}

const WS = 0.04;
const RAD = 290, CAM_Y = 34, SWAY = 0.62;

function Director() {
  const { camera } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);

  const apply = (t) => {
    const az = Math.sin(t * TAU) * SWAY;                 // pendulum across the front
    camera.position.set(
      Math.sin(az) * RAD,
      CAM_Y + Math.sin(t * TAU + 1.3) * 16,              // gentle vertical drift
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
      camera={{ position: [0, CAM_Y, RAD], fov: 48, near: 1, far: 4000 }}
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
