// glyph3d cinematic TOUR — a continuous arc driving the real core systems.
//
// Arc:  load → graph (sequential, highlighted, captioned) → layout (organize
//       into a dependency tree, arrows following) → unload.
//
// Timeline is a pure function of t∈[0,1): autoplays live, exposes
// window.demo.seek(t) for frame-perfect capture (tools/capture.mjs).

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import { ConnectionRenderer } from '@glyph3d/core/annotations';

const SAGE = { r: 0.659, g: 0.627, b: 0.447 };
const WARM = { r: 0.45, g: 0.34, b: 0.12 };   // additive highlight on focused files
const TAU = Math.PI * 2;
const DURATION = 20;

// Curated "repo" (indices used by the graph): 0 atlas 1 field 2 camera 3 layout
// 4 shape 5 worker 6 picking 7 grid 8 tour 9 connect 10 main 11 index
const REPO = [
  { name: 'atlas.js',   text: `class GlyphAtlas {\n  pack(g) {\n    return this.shelf(g)\n  }\n}` },
  { name: 'field.js',   text: `field.render(text, pos, {\n  color, groupId,\n})` },
  { name: 'camera.js',  text: `camera.focusOnGrids()\ncamera.lerp(target)` },
  { name: 'layout.js',  text: `new GridLayoutManager()\n  .addAuto(grid)` },
  { name: 'shape.js',   text: `buildSlugBuffers(\n  shapeText(src, font)\n)` },
  { name: 'worker.js',  text: `onmessage = (e) => {\n  post(build(e.data))\n}` },
  { name: 'picking.js', text: `pick(x, y) {\n  return resolve(\n    read(x, y))\n}` },
  { name: 'grid.js',    text: `class CodeGrid {\n  loadFile(name, src)\n}` },
  { name: 'tour.js',    text: `seq.load(steps)\nseq.next()` },
  { name: 'connect.js', text: `lines.set(id,\n  from, to, color)` },
  { name: 'main.js',    text: `boot()\nmount(scene)` },
  { name: 'index.js',   text: `export * from\n  './core'` },
];

// Wall layout (load target): 4×3, centered (files anchor top-left → nudge).
const COLS = 4, COLX = 60, ROWY = 42;
const TARGET = REPO.map((_, i) => {
  const c = i % COLS, r = Math.floor(i / COLS);
  return [(c - (COLS - 1) / 2) * COLX - 22, (1 - r) * ROWY + 6, 0];
});
const START = TARGET.map((t, i) => [t[0] * 3.0, t[1] * 3.0 + 40, -520 - (i % 5) * 60]);

// Organized layout (dependency tree): roots up, leaves down — so the arrows
// read as clean parent→child flow once files move here.
const ROWS = [[10], [11, 1, 2, 8], [7, 5, 3, 9, 6], [0, 4]];
const ORG = (() => {
  const out = [], CX = 64, RY = 46, TOP = 75;
  ROWS.forEach((row, ri) => row.forEach((fi, ci) => {
    out[fi] = [(ci - (row.length - 1) / 2) * CX - 22, TOP - ri * RY, 0];
  }));
  return out;
})();

// Sequential steps: each lights up one source file's outgoing edges, highlights
// it, and shows a descriptor. Edges accumulate as the web builds.
const STEPS = [
  { desc: 'main.js — the entry point',          edges: [[10, 11], [10, 1], [10, 2]], focus: [10] },
  { desc: 'index.js re-exports the core',        edges: [[11, 0], [11, 7]],            focus: [11] },
  { desc: 'grid.js builds on atlas + shape',     edges: [[7, 0], [7, 4]],              focus: [7] },
  { desc: 'field.js renders through a worker',   edges: [[1, 0], [1, 5]],              focus: [1] },
  { desc: 'shaping: worker → shape → atlas',     edges: [[5, 4], [4, 0]],              focus: [5, 4] },
  { desc: 'camera & layout cooperate',           edges: [[2, 3], [3, 7]],              focus: [2, 3] },
  { desc: 'tour.js drives camera & connect',     edges: [[8, 2], [8, 9], [9, 1]],      focus: [8, 9] },
  { desc: 'picking.js resolves on the grid',     edges: [[6, 7]],                      focus: [6] },
];
const GS = 0.42, GE = 0.84;                       // relationships phase (after organize)
const STEP_SLOT = (GE - GS) / STEPS.length;
const FLAT = STEPS.flatMap((s, k) => s.edges.map((e) => ({ from: e[0], to: e[1], t0: GS + k * STEP_SLOT })));
// Hot-path scratch — reused every frame so the animation allocates nothing
// (no lerp3 arrays, no per-edge objects/strings → no GC hitch).
const EIDF = FLAT.map((_, k) => 'F' + k);   // faint full guide line (structure)
const EIDS = FLAT.map((_, k) => 'S' + k);   // bright travelling snake segment (liveness)
const SNAKE_LEN = 0.28, SNAKE_CYCLES = 12;  // segment length (fraction) + traversals/loop
const EMPTY = {};
const _f = { x: 0, y: 0, z: 0 }, _t = { x: 0, y: 0, z: 0 }, _c = { r: 0, g: 0, b: 0 };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// (file position is computed component-wise inline in apply — see below — to
// keep the hot path allocation-free.)

function graphAlpha(t) {
  if (t < GS) return 0;
  if (t < GS + 0.10) return smooth((t - GS) / 0.10);
  if (t < 0.86) return 1;
  if (t < 0.96) return 1 - smooth((t - 0.86) / 0.10);
  return 0;
}

function phaseLabel(t) {
  if (t < 0.15) return 'load · a repo flies in';
  if (t < GS) return 'layout · organize by dependencies';
  if (t < 0.86) return 'trace · live call relationships';
  return 'unload · dissolve out';
}

function Director({ gridRefs }) {
  const { camera, scene } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);
  const crRef = useRef(null);
  const lastStep = useRef(-2);

  const apply = (t) => {
    // Files — component-wise, ZERO allocation (no lerp3 arrays in the hot path).
    // fly in (load) → seat at wall → morph to org (layout) → fly out (unload).
    for (let i = 0; i < REPO.length; i++) {
      const g = gridRefs.current[i];
      if (!g) continue;
      const load = smooth(clamp((t - i * 0.004) / 0.12, 0, 1));   // fly into wall
      const lay  = smooth(clamp((t - 0.15) / 0.25, 0, 1));        // organize into tree (now early)
      const out  = smooth(clamp((t - (0.87 + i * 0.004)) / 0.10, 0, 1));
      const T = TARGET[i], O = ORG[i], S = START[i];
      const sx = T[0] + (O[0] - T[0]) * lay, sy = T[1] + (O[1] - T[1]) * lay, sz = T[2] + (O[2] - T[2]) * lay;
      const ax = S[0] + (sx - S[0]) * load, ay = S[1] + (sy - S[1]) * load, az = S[2] + (sz - S[2]) * load;
      g.position.set(ax + (S[0] - ax) * out, ay + (S[1] - ay) * out, az + (S[2] - az) * out);
    }

    // Highlight focused files — ONLY on step change (rare), small range.
    const stepIdx = (t >= GS && t < GE) ? Math.min(STEPS.length - 1, Math.floor((t - GS) / STEP_SLOT)) : -1;
    if (stepIdx !== lastStep.current) {
      for (let i = 0; i < REPO.length; i++) gridRefs.current[i]?.clearAllHighlights?.();
      if (stepIdx >= 0) for (const fi of STEPS[stepIdx].focus) gridRefs.current[fi]?.highlightRange?.(0, 0, 6, 40, WARM);
      lastStep.current = stepIdx;
    }
    const desc = stepIdx >= 0 ? STEPS[stepIdx].desc : (t >= 0.15 && t < GS ? 'organizing by dependencies' : '');
    const de = document.getElementById('descriptor');
    if (de) { de.textContent = desc; de.style.opacity = desc ? 1 : 0; }

    // Call-graph edges — reuse scratch objects + plain loop: no per-frame alloc.
    const cr = crRef.current;
    if (cr) {
      const g = graphAlpha(t);
      if (g <= 0.001) cr.setVisible(false);
      else {
        cr.setVisible(true);
        for (let k = 0; k < FLAT.length; k++) {
          const ed = FLAT[k];
          const pf = gridRefs.current[ed.from]?.position, pt = gridRefs.current[ed.to]?.position;
          if (!pf || !pt) continue;
          const reveal = smooth(clamp((t - ed.t0) / 0.04, 0, 1));      // sequential appear
          const ax = pf.x + 22, ay = pf.y - 9, az = pf.z + 3;
          const bx = pt.x + 22, by = pt.y - 9, bz = pt.z + 3;
          // faint full guide line — shows the structure
          _f.x = ax; _f.y = ay; _f.z = az; _t.x = bx; _t.y = by; _t.z = bz;
          const db = g * reveal * 0.16;
          _c.r = 0.92 * db; _c.g = 0.66 * db; _c.b = 0.28 * db;
          cr.set(EIDF[k], _f, _t, _c, EMPTY);
          // bright snake segment travelling source → target (liveness)
          const head = ((t * SNAKE_CYCLES) + k * 0.13) % 1;
          const tail = head > SNAKE_LEN ? head - SNAKE_LEN : 0;
          _f.x = ax + (bx - ax) * tail; _f.y = ay + (by - ay) * tail; _f.z = az + (bz - az) * tail + 0.6;
          _t.x = ax + (bx - ax) * head; _t.y = ay + (by - ay) * head; _t.z = az + (bz - az) * head + 0.6;
          const sb = g * reveal;
          _c.r = 1.0 * sb; _c.g = 0.80 * sb; _c.b = 0.34 * sb;
          cr.set(EIDS[k], _f, _t, _c, EMPTY);
        }
      }
    }

    // Camera: push in for load, pull back a touch for the taller tree.
    const z = lerp(150, 115, smooth(clamp(t / 0.10, 0, 1))) + 18 * smooth(clamp((t - 0.15) / 0.25, 0, 1));
    camera.position.set(Math.sin(t * TAU) * 4, 2, z);
    camera.lookAt(0, 6, 0);

    const pe = document.getElementById('phase');
    if (pe) pe.textContent = phaseLabel(t);
  };

  React.useEffect(() => {
    const cr = new ConnectionRenderer(scene, { maxConnections: 64, arrowLengthRatio: 0.03 });
    cr.setVisible(false);
    crRef.current = cr;
    return () => { cr.dispose?.(); crRef.current = null; };
  }, [scene]);

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
  const gridRefs = useRef([]);
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 2, 150], fov: 70, near: 0.1, far: 8000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director gridRefs={gridRefs} />
      {REPO.map((f, i) => (
        <CodeGrid
          key={f.name}
          ref={(el) => { gridRefs.current[i] = el; }}
          filename={f.name}
          text={f.text}
          worldScale={0.05}
          textColor={SAGE}
        />
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
