// glyph3d PLAY — one file, the grid's primitives composed.
//
// A developer-facing reel: take a single CodeGrid and play with the verbs it
// already exposes — load it, move individual glyphs (the instance-position
// buffer is addressable), highlight ranges, frame/scroll the camera, and page
// the layout. Arc:
//   load → move (lattice organize) → highlight → frame & scroll → page → loop
//
// Timeline is a pure function of t∈[0,1): autoplays live AND exposes
// window.demo.seek(t) for frame-perfect capture. Hot path is allocation-free
// (component-wise math, scratch reused, buffer writes only while something
// is actually moving) so there are no GC hitches.

import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three/webgpu';
import { useThree, useFrame } from '@react-three/fiber';
import { useGlyphEngine, GlyphCanvas, CodeGrid } from 'glyph3d-r3f';
import fontUrl from '@glyph3d/core/fonts/Cousine-Regular.ttf?url';

const SAGE = { r: 0.659, g: 0.627, b: 0.447 };
const WARM = { r: 0.42, g: 0.30, b: 0.10 };   // additive highlight (lines)
const COOL = { r: 0.10, g: 0.26, b: 0.30 };   // additive highlight (alt lines)
const DURATION = 22;
const WS = 0.055;            // worldScale
const FOV = 45;
const TANV = Math.tan((FOV * Math.PI / 180) / 2);
const ASPECT = 16 / 10;
const TANH = TANV * ASPECT;

// The file is its own subject — it describes the very primitives on screen.
const SRC = `// codegrid.js — a file, as glyphs.
export class CodeGrid extends Object3D {
  loadFile(name, src) {
    this.glyphs = shape(src)
    this.field.write(this.glyphs)
  }

  highlightRange(l0, c0, l1, c1, rgb) {
    for (const s of this.slots(l0, c0, l1, c1))
      this.field.setHighlight(s, rgb)
  }

  moveGlyph(slot, { x, y, z }) {
    const p = this.field.positions
    p[slot*3] = x; p[slot*3+1] = y
    p.needsUpdate = true
  }

  layout(strategy) {
    strategy.arrange(this.lines)
  }
}`;
const LC = SRC.split('\n').length;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
const tri = (x) => (x < 0.5 ? x * 2 : (1 - x) * 2);     // 0→1→0 ramp

// Phase windows in t.
const LOAD_E = 0.12;
const MOVE_S = 0.12, MOVE_E = 0.30;
const HL_S = 0.30, HL_E = 0.50;
const FR_S = 0.50, FR_E = 0.70;
const PG_S = 0.70, PG_E = 0.88;
const DS_S = 0.88;
const LATTICE = 2.2;         // grid step glyphs snap to in the "move" beat

function phaseLabel(t) {
  if (t < LOAD_E) return 'load · a file becomes glyphs';
  if (t < MOVE_E) return 'move · every glyph is addressable';
  if (t < HL_E)   return 'highlight · ranges & tokens, additive';
  if (t < FR_E)   return 'frame · the camera windows the field';
  if (t < PG_E)   return 'page · recompose the layout, live';
  return 'compose · a few primitives, combined';
}

// deterministic pseudo-random in [-1,1] from an integer seed
const rand = (n) => { const r = Math.sin(n * 12.9898 + 4.1) * 43758.5453; return (r - Math.floor(r)) * 2 - 1; };

function Director({ gridRef }) {
  const { camera } = useThree();
  const tRef = useRef(0);
  const auto = useRef(true);
  const snap = useRef(null);
  const lastHL = useRef(-2);

  // Snapshot the laid-out buffer once + precompute formations and framing.
  const ensure = (grid) => {
    if (snap.current) return snap.current;
    const mesh = grid.getRenderer?.()?.instanceMesh;
    const attr = mesh?.geometry?.attributes?.instancePosition;
    const count = mesh?.geometry?.instanceCount | 0;
    if (!attr || !count) return null;
    const base = attr.array.slice(0, count * 3);
    const rnd = new Float32Array(count * 3);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < count; k++) {
      const x = base[k * 3], y = base[k * 3 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      rnd[k * 3] = rand(k); rnd[k * 3 + 1] = rand(k + 0.37); rnd[k * 3 + 2] = rand(k + 0.71);
    }
    const w = maxX - minX, h = maxY - minY;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, midY = cy;
    const GAP = w * 0.10;
    // page formation: fold the lower half of the file up into a second column.
    const paged = new Float32Array(count * 2);
    for (let k = 0; k < count; k++) {
      if (base[k * 3 + 1] < midY) { paged[k * 2] = w + GAP; paged[k * 2 + 1] = h / 2; }
    }
    const scat = Math.max(w, h) * 0.55, depth = Math.max(w, h) * 1.4;
    const fit = (ww, hh) => Math.max(hh / (2 * TANV), ww / (2 * TANH)) * 1.18;
    const homeZ = fit(w, h);
    const pageW = 2 * w + GAP, pageH = h / 2;
    const pageZ = fit(pageW, pageH);
    const pageCx = cx + (w + GAP) / 2, pageCy = midY + h / 4;
    snap.current = { base, rnd, paged, count, w, h, cx, cy, scat, depth, homeZ, pageZ, pageCx, pageCy };
    return snap.current;
  };

  const apply = (t) => {
    const grid = gridRef.current;
    if (!grid) return;
    const s = ensure(grid);
    if (!s) return;
    const { base, rnd, paged, count } = s;

    // envelopes ------------------------------------------------------------
    const cloud = t < LOAD_E
      ? 1 - smooth(t / LOAD_E)                               // fly in from a cloud
      : (t >= DS_S ? smooth((t - DS_S) / (1 - DS_S)) : 0);   // dissolve back out
    const org = (t >= MOVE_S && t < MOVE_E) ? tri((t - MOVE_S) / (MOVE_E - MOVE_S)) : 0; // snap to lattice & back
    let page = 0;                                            // fold to two columns
    if (t >= PG_S && t < DS_S) page = smooth(clamp((t - PG_S) / 0.06, 0, 1));
    else if (t >= DS_S) page = 1 - smooth((t - DS_S) / (1 - DS_S)); // unfold as it dissolves

    // glyph positions — only write while something is actually moving ------
    const active = cloud > 0.001 || org > 0.001 || page > 0.001;
    if (active) {
      const mesh = grid.getRenderer?.()?.instanceMesh;
      const attr = mesh?.geometry?.attributes?.instancePosition;
      if (attr) {
        const arr = attr.array;
        for (let k = 0; k < count; k++) {
          const bx = base[k * 3], by = base[k * 3 + 1], bz = base[k * 3 + 2];
          // page: fold lower half into the second column
          const px = bx + paged[k * 2] * page, py = by + paged[k * 2 + 1] * page;
          // move: snap toward a lattice and back (proves per-glyph addressability)
          const lx = px + (Math.round(px / LATTICE) * LATTICE - px) * org;
          const ly = py + (Math.round(py / LATTICE) * LATTICE - py) * org;
          // load/dissolve: scatter cloud, pushed back in depth
          arr[k * 3]     = lx + rnd[k * 3]     * s.scat * cloud;
          arr[k * 3 + 1] = ly + rnd[k * 3 + 1] * s.scat * cloud;
          arr[k * 3 + 2] = bz + (rnd[k * 3 + 2] * s.scat - s.depth) * cloud;
        }
        attr.needsUpdate = true;
      }
    }

    // highlights — incremental line sweep during the highlight beat --------
    const hlT = (t >= HL_S && t < HL_E)
      ? clamp(Math.floor(((t - HL_S) / (HL_E - HL_S)) * (LC + 1)), 0, LC)
      : -1;
    if (hlT !== lastHL.current) {
      if (hlT < 0 || hlT < lastHL.current) {            // leaving, or seeked back → rebuild
        grid.clearAllHighlights?.();
        for (let ln = 0; ln < hlT; ln++) {
          const cols = grid.getLineSlotCount?.(ln) | 0;
          if (cols > 0) grid.highlightRange?.(ln, 0, ln, cols - 1, ln % 2 ? COOL : WARM);
        }
      } else {                                          // growing → add only new lines
        for (let ln = lastHL.current < 0 ? 0 : lastHL.current; ln < hlT; ln++) {
          const cols = grid.getLineSlotCount?.(ln) | 0;
          if (cols > 0) grid.highlightRange?.(ln, 0, ln, cols - 1, ln % 2 ? COOL : WARM);
        }
      }
      lastHL.current = hlT;
    }

    // camera — auto-framed home, with a dolly/scroll beat and a page reframe
    const fr = (t >= FR_S && t < FR_E) ? (t - FR_S) / (FR_E - FR_S) : 0;
    const bump = tri(fr);                               // 0→1→0 over the frame beat
    let camX = lerp(s.cx, s.pageCx, page);
    let camY = lerp(s.cy, s.pageCy, page) - s.h * 0.24 * smooth(bump);   // pan down then back
    let camZ = lerp(s.homeZ, s.pageZ, page) * lerp(1, 0.60, smooth(bump)); // dolly in then back
    camera.position.set(camX, camY, camZ);
    camera.lookAt(camX, camY, 0);

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
  const gridRef = useRef(null);
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 0, 120], fov: FOV, near: 0.1, far: 8000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director gridRef={gridRef} />
      <CodeGrid ref={gridRef} filename="codegrid.js" text={SRC}
        worldScale={WS} textColor={SAGE} showBackground={false} />
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
