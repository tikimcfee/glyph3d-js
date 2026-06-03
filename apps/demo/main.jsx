// glyph3d cinematic demo — a scripted, deterministic showcase.
//
// The timeline is a pure function of t∈[0,1): seek(t) sets every animated thing
// so the same t always renders the same frame. It autoplays live (watch on
// refresh) AND exposes window.demo.seek for frame-perfect capture
// (tools/capture.mjs). Everything periodic in t ⇒ t=1 ≡ t=0 ⇒ seamless loop.
//
// ROUND 2 — the living headline: "it's all just rendering text and manipulating
// buffer locations." A constellation of code files in a slow, comfortable
// sway-orbit, each line of text rippling on a sine wave driven straight into the
// glyph instance-position buffer. (Round 3: lift a function out + connection lines.)

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const SAGE = { r: 0.659, g: 0.627, b: 0.447 };
const DURATION = 14;         // seconds per live loop (slow & comfortable)
const TAU = Math.PI * 2;
const WAVES = 2;             // temporal wave cycles per loop (integer ⇒ seamless)

const FILES = [
  { name: 'atlas.js', target: [0, 13, 4], text:
`export class GlyphAtlas {
  pack(grapheme) {
    const uv = this.shelf(grapheme)
    this.map.set(grapheme, uv)
    return uv
  }
}` },
  { name: 'field.js', target: [-60, 0, -8], text:
`field.render(text, { x, y, z }, {
  color, groupId, worldScale,
})
// thousands of glyphs,
// one instanced draw call.` },
  { name: 'camera.js', target: [58, 3, -14], text:
`camera.focusOnGrids()
camera.position.lerp(target, 0.05)
// pan / orbit / zoom` },
  { name: 'layout.js', target: [-34, -32, -4], text:
`new GridLayoutManager()
  .addAuto(grid)
// spatial 3D placement` },
  { name: 'shape.js', target: [38, -30, -16], text:
`const buf = buildSlugBuffers(
  shapeText(src, font)
) // HarfBuzz -> GPU` },
];

// Files live on a hemisphere (a "semi-dome"), spread around in azimuth and up
// in elevation, each facing radially outward. The whole dome slowly revolves,
// so the per-glyph z-float reads as real depth as each file comes around.
const R_DOME = 80;
const DOME = [
  { az: 0.00, el: 0.20 },
  { az: 1.26, el: 0.62 },
  { az: 2.51, el: 0.32 },
  { az: 3.77, el: 0.70 },
  { az: 5.03, el: 0.45 },
];

// Sine-wave the glyph instance-position buffer (local space) from a one-time
// snapshot of the laid-out positions. This is the thesis move: animation = a
// few lines writing buffer locations + needsUpdate. y ripples by glyph x (a
// traveling wave across each line); z adds gentle depth.
function waveGrid(grid, i, t, store) {
  const mesh = grid.getRenderer?.()?.instanceMesh;
  const attr = mesh?.geometry?.attributes?.instancePosition;
  const count = mesh?.geometry?.instanceCount | 0;
  if (!attr || !count) return;
  let st = store.current[i];
  if (!st || st.count !== count) { st = { base: attr.array.slice(0, count * 3), count }; store.current[i] = st; }
  const { base } = st, arr = attr.array, phase = i * 1.3, w = t * TAU * WAVES;
  for (let k = 0; k < count; k++) {
    const bx = base[k * 3], by = base[k * 3 + 1];
    // smooth XY travelling wave (per column)
    arr[k * 3 + 1] = by + 2.2 * Math.sin(bx * 0.10 + w + phase);
    // QUANTIZED z, per individual glyph (x AND y) → glyphs snap between discrete
    // depth planes: a voxelized, step-function pop. Math.round = the steps.
    const sz = Math.sin(bx * 0.55 + by * 0.70 + w + phase);
    arr[k * 3 + 2] = base[k * 3 + 2] + Math.round(sz) * 3.5;
  }
  attr.needsUpdate = true;
}

function Director({ gridRefs }) {
  const { camera } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);
  const waves = useRef([]);

  const apply = (t) => {
    const theta = t * TAU;                       // one slow full revolution per loop
    FILES.forEach((f, i) => {
      const g = gridRefs.current[i];
      if (!g) return;
      const az = DOME[i].az + theta, el = DOME[i].el;
      const ce = Math.cos(el) * R_DOME;
      g.position.set(
        ce * Math.sin(az),
        Math.sin(el) * R_DOME + Math.sin(theta + i) * 1.2,   // dome height + gentle float
        ce * Math.cos(az),
      );
      g.rotation.set(0, az, 0);                  // face radially outward
      waveGrid(g, i, t, waves);                  // XY wave + voxel-z float
    });
    // Camera fixed in front, aimed up into the dome; gentle bob. The dome revolves.
    camera.position.set(0, 24 + Math.sin(theta) * 2, 158);
    camera.lookAt(0, 24, 0);
  };

  useFrame((_, dt) => {
    if (auto.current) tRef.current = (tRef.current + dt / DURATION) % 1;
    apply(tRef.current);
  });

  React.useEffect(() => {
    window.demo = {
      duration: DURATION, ready: true,
      seek: (t) => { auto.current = false; tRef.current = ((t % 1) + 1) % 1; apply(tRef.current); },
      play: () => { auto.current = true; },
    };
    return () => { delete window.demo; };
  }, []);

  return null;
}

function App() {
  const { atlas, error } = useGlyphEngine({ fontUrl });
  const gridRefs = useRef([]);
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 24, 158], fov: 70, near: 0.1, far: 6000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director gridRefs={gridRefs} />
      {FILES.map((f, i) => (
        <CodeGrid
          key={f.name}
          ref={(el) => { gridRefs.current[i] = el; }}
          filename={f.name}
          text={f.text}
          worldScale={0.028}
          textColor={SAGE}
        />
      ))}
    </GlyphCanvas>
  );
}

function Root() {
  if (typeof navigator !== 'undefined' && !navigator.gpu) return null;
  return <App />;
}

createRoot(document.getElementById('root')).render(<Root />);
