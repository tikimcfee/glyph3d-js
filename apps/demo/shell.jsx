// glyph3d LIVE — connect the binary and your CLI comes alive.
//
// The composability beat: mock panes (a terminal, a file, an agent) glide
// around the field to show that windows are just positioned grids — load,
// page in front, lay side by side, bring an agent alongside. Content is
// canned (deterministic; the real terminal/agent want the binary's relay,
// and we're still building those out), but every move is the real thing:
// a CodeGrid is an Object3D, so composition === setting positions.
//
//   ls → open a file (pages in front) → side by side → serve → agent joins
//
// Deterministic seek(t); allocation-free hot path (scratch reused, content
// reloaded only on discrete step changes, never per frame).

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const SAGE   = { r: 0.659, g: 0.627, b: 0.447 };
const TERM_C = { r: 0.46, g: 0.66, b: 0.52 };   // green-ish terminal
const AGENT_C = { r: 0.82, g: 0.56, b: 0.38 };  // amber agent
const HL     = { r: 0.30, g: 0.22, b: 0.05 };   // the agent's edit highlight
const DURATION = 24;
const FOV = 34;
const WS = 0.05;
const CAM_Z = 124;           // frames the workspace of panes

// ── canned content ─────────────────────────────────────────────────────
const TERM_TEXT = [
`~/glyph3d $ ls`,
`~/glyph3d $ ls
atlas.js   field.js   shape.js
worker.js  camera.js  main.js`,
`~/glyph3d $ ls
atlas.js   field.js   shape.js
worker.js  camera.js  main.js
~/glyph3d $ open field.js`,
`~/glyph3d $ ls
atlas.js   field.js   shape.js
worker.js  camera.js  main.js
~/glyph3d $ open field.js
~/glyph3d $ glyph3d serve .
serving · http://localhost:8080`,
`~/glyph3d $ ls
atlas.js   field.js   shape.js
worker.js  camera.js  main.js
~/glyph3d $ open field.js
~/glyph3d $ glyph3d serve .
serving · http://localhost:8080
~/glyph3d $ agent tidy field.js`,
];
const termStep = (t) => (t < 0.08 ? 0 : t < 0.30 ? 1 : t < 0.58 ? 2 : t < 0.74 ? 3 : 4);

const FILE_TEXT =
`field.render(text, pos, {
  color, groupId, worldScale,
})

function write(glyphs, pos) {
  for (const g of glyphs)
    buffer.push(g, pos)
}
// one instanced draw call.`;

const AGENT_TEXT = [
`● agent · tidy field.js
→ read field.js
→ align write()`,
`● agent · tidy field.js
→ read field.js
→ align write()
✓ committed`,
];
const agentStep = (t) => (t < 0.88 ? 0 : 1);

// ── position tracks: keyframes {t,x,y,z,s} smoothly interpolated ─────────
// x/y are the pane CENTER (place() offsets by measured half-extents).
const TERM_K = [
  { t: 0.00, x: 0,  y: 0, z: 0,   s: 0 },
  { t: 0.05, x: 0,  y: 0, z: 0,   s: 1 },
  { t: 0.32, x: 0,  y: 0, z: 0,   s: 1 },
  { t: 0.42, x: 4,  y: 0, z: -14, s: 1 },   // recede as the file pages in front
  { t: 0.56, x: 26, y: 0, z: 0,   s: 1 },   // glide right — side by side
  { t: 0.80, x: 26, y: 0, z: 0,   s: 1 },
  { t: 0.88, x: 0,  y: 0, z: 0,   s: 1 },   // recenter — make room for the agent
  { t: 0.94, x: 0,  y: 0, z: 0,   s: 1 },
  { t: 1.00, x: 0,  y: 0, z: 0,   s: 0 },
];
const FILE_K = [
  { t: 0.00, x: 0,   y: 0, z: 18, s: 0 },
  { t: 0.32, x: 0,   y: 0, z: 18, s: 0 },
  { t: 0.42, x: 0,   y: 0, z: 18, s: 1 },   // pages in FRONT of the terminal
  { t: 0.56, x: -26, y: 0, z: 0,  s: 1 },   // settle left — side by side
  { t: 0.80, x: -26, y: 0, z: 0,  s: 1 },
  { t: 0.88, x: -46, y: 0, z: 0,  s: 1 },   // shift further left — 3-up
  { t: 0.94, x: -46, y: 0, z: 0,  s: 1 },
  { t: 1.00, x: -46, y: 0, z: 0,  s: 0 },
];
const AGENT_K = [
  { t: 0.00, x: 80, y: 0, z: 0, s: 0 },
  { t: 0.78, x: 80, y: 0, z: 0, s: 0 },
  { t: 0.88, x: 46, y: 0, z: 0, s: 1 },     // slides in from the right
  { t: 0.94, x: 46, y: 0, z: 0, s: 1 },
  { t: 1.00, x: 46, y: 0, z: 0, s: 0 },
];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;

function track(keys, t, out) {
  if (t <= keys[0].t) { out.x = keys[0].x; out.y = keys[0].y; out.z = keys[0].z; out.s = keys[0].s; return; }
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const u = smooth((t - a.t) / (b.t - a.t));
      out.x = lerp(a.x, b.x, u); out.y = lerp(a.y, b.y, u);
      out.z = lerp(a.z, b.z, u); out.s = lerp(a.s, b.s, u);
      return;
    }
  }
  const e = keys[keys.length - 1]; out.x = e.x; out.y = e.y; out.z = e.z; out.s = e.s;
}

function phaseLabel(t) {
  if (t < 0.30) return 'ls · a terminal, live';
  if (t < 0.56) return 'open · the file pages in, in front';
  if (t < 0.74) return 'compose · windows, side by side';
  if (t < 0.88) return 'serve · your CLI, connected';
  return 'agent · joins the same field';
}

function Director({ termRef, fileRef, agentRef }) {
  const { camera } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);
  const sT = useRef(-1), sA = useRef(-1), sHL = useRef(false);
  const _t = { x: 0, y: 0, z: 0, s: 1 };
  // measured half-extents so each pane centers on its keyframe (content hangs
  // right+down from the top-left anchor, so we offset by -hw / +hh).
  const dimT = useRef({ hw: 0, hh: 0 }), dimF = useRef({ hw: 0, hh: 0 }), dimA = useRef({ hw: 0, hh: 0 });

  const measure = (grid, dim) => {
    const b = grid?.getContentBounds?.();
    if (b && b.width) { dim.hw = b.width / 2; dim.hh = b.height / 2; }
  };

  const place = (grid, keys, t, dim) => {
    if (!grid) return;
    if (!dim.hw) measure(grid, dim);                 // lazy first measure
    track(keys, t, _t);
    const sc = Math.max(0.0001, _t.s);
    grid.position.set(_t.x - dim.hw * sc, _t.y + dim.hh * sc, _t.z);  // center on keyframe
    grid.scale.setScalar(sc);
    grid.visible = _t.s > 0.01;
  };

  const apply = (t) => {
    // content — reload only on discrete step changes (never per frame); remeasure after
    const ts = termStep(t);
    if (ts !== sT.current) { termRef.current?.loadFile?.('term', TERM_TEXT[ts]); measure(termRef.current, dimT.current); sT.current = ts; }
    const as = agentStep(t);
    if (as !== sA.current) { agentRef.current?.loadFile?.('agent', AGENT_TEXT[as]); measure(agentRef.current, dimA.current); sA.current = as; }

    place(termRef.current, TERM_K, t, dimT.current);
    place(fileRef.current, FILE_K, t, dimF.current);
    place(agentRef.current, AGENT_K, t, dimA.current);

    // the agent "edits" the file — highlight write() once it's working
    const wantHL = t >= 0.90;
    if (wantHL !== sHL.current) {
      const f = fileRef.current;
      if (f) { f.clearAllHighlights?.(); if (wantHL) f.highlightRange?.(4, 0, 7, 40, HL); }
      sHL.current = wantHL;
    }

    camera.position.set(Math.sin(t * Math.PI * 2) * 2.5, 0, CAM_Z);
    camera.lookAt(0, 0, 0);

    const pe = document.getElementById('phase');
    if (pe) pe.textContent = phaseLabel(t);
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
  const termRef = useRef(null), fileRef = useRef(null), agentRef = useRef(null);
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 0, CAM_Z], fov: FOV, near: 0.1, far: 8000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director termRef={termRef} fileRef={fileRef} agentRef={agentRef} />
      <CodeGrid ref={termRef}  filename="term"  text={TERM_TEXT[0]} worldScale={WS} textColor={TERM_C}  showBackground={false} />
      <CodeGrid ref={fileRef}  filename="field.js" text={FILE_TEXT} worldScale={WS} textColor={SAGE}    showBackground={false} />
      <CodeGrid ref={agentRef} filename="agent" text={AGENT_TEXT[0]} worldScale={WS} textColor={AGENT_C} showBackground={false} />
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
