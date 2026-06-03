// glyph3d LIVE — connect the binary and your CLI comes alive.
//
// The composability beat: mock panes (a terminal, a file, an agent) glide
// around the field — windows are just positioned grids. But it's also meant to
// read as CAUSE→EFFECT: the terminal drives, the file responds, the agent
// reaches in and tidies. Content is canned (the real terminal/agent want the
// binary's relay, still cooking), but every move is the real thing:
//   ls → open (file pages in front) → side by side → serve → agent tidies
// where "tidy" is literal: write() is mis-indented, and the agent snaps it
// aligned (real instance-buffer edit) while a line connects agent → file.
//
// Deterministic seek(t); allocation-free hot path.

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';
import { ConnectionRenderer } from '@glyph3d/core/annotations';

const SAGE    = { r: 0.659, g: 0.627, b: 0.447 };
const TERM_C  = { r: 0.46, g: 0.66, b: 0.52 };  // green-ish terminal
const AGENT_C = { r: 0.82, g: 0.56, b: 0.38 };  // amber agent
const HL      = { r: 0.34, g: 0.25, b: 0.06 };  // the agent's edit highlight
const DURATION = 26;
const FOV = 34;
const WS = 0.055;
const CAM_Z = 150;           // frames the (now taller) workspace — full panes, clear of the edges
const TAU = Math.PI * 2;

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
const termStep = (t) => (t < 0.06 ? 0 : t < 0.24 ? 1 : t < 0.56 ? 2 : t < 0.70 ? 3 : 4);

// field.js — write() (lines 4–7) is what the agent tidies.
const FILE_TEXT =
`field.render(text, pos, {
  color, groupId, worldScale,
})

function write(glyphs, pos) {
  for (const g of glyphs)
    buffer.push(g, pos)
}
// one instanced draw call.`;
const WRITE_LINES = [4, 5, 6, 7];
const RAGGED = { 4: 0.00, 5: 0.17, 6: -0.10, 7: 0.13 };  // mis-indent as a fraction of width

const AGENT_TEXT = [
`● agent · tidy field.js
→ read field.js
→ align write()`,
`● agent · tidy field.js
→ read field.js
→ align write()
✓ committed`,
];
const agentStep = (t) => (t < 0.90 ? 0 : 1);

// ── position tracks: keyframes {t,x,y,z,s}; x/y are the pane CENTER ──────
// Final layout uses the taller frame: file LEFT, terminal RIGHT-TOP, agent
// slides up into RIGHT-BOTTOM — a 2D workspace, not a cramped row.
const TERM_K = [
  { t: 0.00, x: 0,  y: 0,  z: 0,   s: 0 },
  { t: 0.05, x: 0,  y: 0,  z: 0,   s: 1 },
  { t: 0.24, x: 0,  y: 0,  z: 0,   s: 1 },
  { t: 0.32, x: 3,  y: 0,  z: -14, s: 1 },   // recede as the file pages in front
  { t: 0.46, x: 28, y: 0,  z: 0,   s: 1 },   // glide right — side by side
  { t: 0.70, x: 28, y: 0,  z: 0,   s: 1 },
  { t: 0.78, x: 30, y: 14, z: 0,   s: 1 },   // up to right-TOP (agent comes in below)
  { t: 0.94, x: 30, y: 14, z: 0,   s: 1 },
  { t: 1.00, x: 30, y: 14, z: 0,   s: 0 },
];
const FILE_K = [
  { t: 0.00, x: 0,   y: 0, z: 18, s: 0 },
  { t: 0.24, x: 0,   y: 0, z: 18, s: 0 },
  { t: 0.32, x: 0,   y: 0, z: 18, s: 1 },    // pages in FRONT of the terminal
  { t: 0.46, x: -28, y: 0, z: 0,  s: 1 },    // settle left — side by side
  { t: 0.78, x: -30, y: 0, z: 0,  s: 1 },
  { t: 0.94, x: -30, y: 0, z: 0,  s: 1 },
  { t: 1.00, x: -30, y: 0, z: 0,  s: 0 },
];
const AGENT_K = [
  { t: 0.00, x: 30, y: -52, z: 0, s: 0 },
  { t: 0.70, x: 30, y: -52, z: 0, s: 0 },
  { t: 0.78, x: 30, y: -15, z: 0, s: 1 },    // slides UP into right-bottom
  { t: 0.94, x: 30, y: -15, z: 0, s: 1 },
  { t: 1.00, x: 30, y: -15, z: 0, s: 0 },
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
  if (t < 0.24) return 'ls · list the working dir';
  if (t < 0.46) return 'open · field.js pages in';
  if (t < 0.70) return 'compose · windows side by side';
  if (t < 0.78) return 'serve · localhost, connected';
  if (t < 0.90) return 'tidy · the agent aligns write()';
  return 'commit · written back to the file';
}

const EMPTY = {};

function Director({ termRef, fileRef, agentRef }) {
  const { camera, scene } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);
  const sT = useRef(-1), sA = useRef(-1), sHL = useRef(false);
  const lastRag = useRef(-1);
  const crRef = useRef(null);
  const _p = { x: 0, y: 0, z: 0, s: 1 };
  const _f = { x: 0, y: 0, z: 0 }, _to = { x: 0, y: 0, z: 0 }, _c = { r: 0, g: 0, b: 0 };
  const dimT = useRef({ hw: 0, hh: 0 }), dimF = useRef({ hw: 0, hh: 0 }), dimA = useRef({ hw: 0, hh: 0 });
  const fileSnap = useRef(null);   // { base, attr, ranges:[{s,c,off}] }

  const measure = (grid, dim) => {
    const b = grid?.getContentBounds?.();
    if (b && b.width) { dim.hw = b.width / 2; dim.hh = b.height / 2; }
  };

  const place = (grid, keys, t, dim) => {
    if (!grid) return;
    if (!dim.hw) measure(grid, dim);
    track(keys, t, _p);
    const sc = Math.max(0.0001, _p.s);
    grid.position.set(_p.x - dim.hw * sc, _p.y + dim.hh * sc, _p.z);  // center on keyframe
    grid.scale.setScalar(sc);
    grid.visible = _p.s > 0.01;
  };

  // snapshot the file's laid-out buffer + resolve write() line slot ranges
  const ensureFile = (f) => {
    if (fileSnap.current) return fileSnap.current;
    const mesh = f?.getRenderer?.()?.instanceMesh;
    const attr = mesh?.geometry?.attributes?.instancePosition;
    const count = mesh?.geometry?.instanceCount | 0;
    if (!attr || !count) return null;
    const b = f.getContentBounds?.();
    const w = (b && b.width) || 40;
    const base = attr.array.slice(0, count * 3);
    const ranges = [];
    for (const ln of WRITE_LINES) {
      const s0 = f.getSlotForChar?.(ln, 0);
      const cnt = f.getLineSlotCount?.(ln) | 0;
      if (s0 != null && s0 >= 0 && cnt > 0) ranges.push({ s: s0, c: cnt, off: RAGGED[ln] * w });
    }
    fileSnap.current = { base, attr, ranges };
    return fileSnap.current;
  };

  const apply = (t) => {
    // content — reload only on discrete step changes
    const ts = termStep(t);
    if (ts !== sT.current) { termRef.current?.loadFile?.('term', TERM_TEXT[ts]); measure(termRef.current, dimT.current); sT.current = ts; }
    const as = agentStep(t);
    if (as !== sA.current) { agentRef.current?.loadFile?.('agent', AGENT_TEXT[as]); measure(agentRef.current, dimA.current); sA.current = as; }

    place(termRef.current, TERM_K, t, dimT.current);
    place(fileRef.current, FILE_K, t, dimF.current);
    place(agentRef.current, AGENT_K, t, dimA.current);

    // TIDY — write() starts mis-indented, the agent snaps it aligned.
    const fs = ensureFile(fileRef.current);
    if (fs && fs.ranges.length) {
      const ragged = 1 - smooth(clamp((t - 0.82) / 0.08, 0, 1));   // 1 (messy) → 0 (aligned)
      if (ragged !== lastRag.current) {
        const arr = fs.attr.array, base = fs.base;
        for (const r of fs.ranges) {
          const dx = r.off * ragged;
          for (let k = r.s; k < r.s + r.c; k++) arr[k * 3] = base[k * 3] + dx;
        }
        fs.attr.needsUpdate = true;
        lastRag.current = ragged;
      }
    }
    // highlight the tidied block as the agent works it
    const wantHL = t >= 0.82 && t < 0.99;
    if (wantHL !== sHL.current) {
      const f = fileRef.current;
      if (f) { f.clearAllHighlights?.(); if (wantHL) f.highlightRange?.(4, 0, 7, 40, HL); }
      sHL.current = wantHL;
    }

    // CONNECTION — the agent reaches into the file (CLI acting on the field)
    const cr = crRef.current;
    if (cr) {
      const a = agentRef.current, f = fileRef.current;
      const rv = smooth(clamp((t - 0.79) / 0.05, 0, 1)) * (1 - smooth(clamp((t - 0.93) / 0.04, 0, 1)));
      if (rv <= 0.001 || !a || !f) cr.setVisible(false);
      else {
        cr.setVisible(true);
        const da = dimA.current, df = dimF.current;
        _f.x = a.position.x; _f.y = a.position.y - da.hh; _f.z = a.position.z + 1;       // agent left-center
        _to.x = f.position.x + 2 * df.hw; _to.y = f.position.y - df.hh * 1.45; _to.z = f.position.z + 1; // file write() edge
        _c.r = 0.85 * rv; _c.g = 0.58 * rv; _c.b = 0.32 * rv;
        cr.set('a2f', _f, _to, _c, EMPTY);
      }
    }

    camera.position.set(Math.sin(t * TAU) * 2.5, 1, CAM_Z);
    camera.lookAt(0, 1, 0);

    const pe = document.getElementById('phase');
    if (pe) pe.textContent = phaseLabel(t);
  };

  React.useEffect(() => {
    const cr = new ConnectionRenderer(scene, { maxConnections: 8, arrowLengthRatio: 0.04 });
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
