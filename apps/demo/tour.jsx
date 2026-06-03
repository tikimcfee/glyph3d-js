// glyph3d cinematic TOUR — a single continuous arc through the substrate's
// capabilities, built phase by phase. It drives the REAL core systems (layout
// managers, ConnectionRenderer, CodeGrid load/unload) so it doubles as a
// repeatable exercise/test of those features — where a primitive is missing or
// awkward, this demo is where it shows.
//
// Arc:  load → graph → refactor → morph → unload
//   Phase 1 (this round): LOAD — a repo flies in and arranges into a wall;
//                         UNLOAD — it dissolves back out. Middle phases hold
//                         at the assembled state for now (slot in next).
//
// Timeline is a pure function of t∈[0,1): autoplays live, exposes
// window.demo.seek(t) for frame-perfect capture (tools/capture.mjs).

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const SAGE = { r: 0.659, g: 0.627, b: 0.447 };
const TAU = Math.PI * 2;

// A small curated "repo" (real glyph3d-flavored files). Default-to-ours; later
// this can be swapped for a user-loaded repo via the fs API.
const REPO = [
  { name: 'atlas.js',    text: `class GlyphAtlas {\n  pack(g) {\n    return this.shelf(g)\n  }\n}` },
  { name: 'field.js',    text: `field.render(text, pos, {\n  color, groupId,\n})` },
  { name: 'camera.js',   text: `camera.focusOnGrids()\ncamera.lerp(target)` },
  { name: 'layout.js',   text: `new GridLayoutManager()\n  .addAuto(grid)` },
  { name: 'shape.js',    text: `buildSlugBuffers(\n  shapeText(src, font)\n)` },
  { name: 'worker.js',   text: `onmessage = (e) => {\n  post(build(e.data))\n}` },
  { name: 'picking.js',  text: `pick(x, y) {\n  return resolve(\n    read(x, y))\n}` },
  { name: 'grid.js',     text: `class CodeGrid {\n  loadFile(name, src)\n}` },
  { name: 'tour.js',     text: `seq.load(steps)\nseq.next()` },
  { name: 'connect.js',  text: `lines.set(id,\n  from, to, color)` },
  { name: 'main.js',     text: `boot()\nmount(scene)` },
  { name: 'index.js',    text: `export * from\n  './core'` },
];

// 4×3 wall, centered on origin. (Phase 4 will morph these into spiral/treemap/etc.)
const COLS = 4, COLX = 42, ROWY = 34;
const TARGET = REPO.map((_, i) => {
  const c = i % COLS, r = Math.floor(i / COLS);
  return [(c - (COLS - 1) / 2) * COLX, (1 - r) * ROWY, 0];
});
// Scattered far start for the fly-in (deterministic per index).
const START = TARGET.map((t, i) => [t[0] * 3.0, t[1] * 3.0 + 40, -520 - (i % 5) * 60]);

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Assembly envelope across the loop: per-grid staggered ramp-in (LOAD), hold,
// then ramp-out (UNLOAD). 0 = scattered/away, 1 = seated in the wall.
function seat(t, i) {
  const inA = 0.02 + i * 0.012, inB = inA + 0.16;     // staggered load
  const outA = 0.84 + i * 0.008, outB = outA + 0.12;  // staggered unload
  if (t < inA) return 0;
  if (t < inB) return smooth((t - inA) / (inB - inA));
  if (t < outA) return 1;
  if (t < outB) return 1 - smooth((t - outA) / (outB - outA));
  return 0;
}

function phaseLabel(t) {
  if (t < 0.22) return 'load · a repo flies in';
  if (t < 0.42) return 'graph · (next)';
  if (t < 0.62) return 'refactor · (next)';
  if (t < 0.82) return 'morph · (next)';
  return 'unload · dissolve out';
}

const DURATION = 16;

function Director({ gridRefs }) {
  const { camera } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);

  const apply = (t) => {
    REPO.forEach((f, i) => {
      const g = gridRefs.current[i];
      if (!g) return;
      const a = seat(t, i);
      const p = lerp3(START[i], TARGET[i], a);
      g.position.set(p[0], p[1], p[2]);
      g.rotation.set(0, 0, 0);
    });
    // Slow push-in over the loaded stretch; framed on the wall.
    const z = lerp(250, 205, smooth(clamp((t - 0.05) / 0.2, 0, 1)));
    camera.position.set(Math.sin(t * TAU) * 8, 4, z);
    camera.lookAt(0, 2, 0);
    const el = document.getElementById('phase');
    if (el) el.textContent = phaseLabel(t);
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
      camera={{ position: [0, 4, 250], fov: 70, near: 0.1, far: 8000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director gridRefs={gridRefs} />
      {REPO.map((f, i) => (
        <CodeGrid
          key={f.name}
          ref={(el) => { gridRefs.current[i] = el; }}
          filename={f.name}
          text={f.text}
          worldScale={0.03}
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
