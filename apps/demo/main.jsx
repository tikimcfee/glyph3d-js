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
const NAME = { r: 0.90, g: 0.85, b: 0.60 };  // bright — the dominant nameplate, the hero
const DIM  = { r: 0.42, g: 0.40, b: 0.30 };  // dim — the ring of files is a subtle hint
const SUB  = { r: 0.62, g: 0.59, b: 0.42 };  // the subtitle — present, subordinate to the title
const TAU = Math.PI * 2;
// Independent animation rates (rad/s on a continuous clock) so orbit and the
// waves tune separately. Live autoplay runs a continuous clock — no loop
// boundary, so no seam; seek(t) maps t∈[0,1] across CAPTURE_SECS for capture.
const ORBIT_W = 0.0675;      // slow dome revolution — halved (calmer, more "title")
const WAVE_XY_W = 0.45;      // XY ripple — halved in step
const WAVE_Z_W = 0.225;      // z voxel float — halved in step
const CAM_Z = 140;           // frames the dominant title + its ring of files in the 16:7 band
const CAPTURE_SECS = 92;     // seek window ≈ one full revolution
const RING_CY = 16;          // vertical center of the title and the ring around it
const TITLE_X = -16;         // x offset that centers "glyph3d" at the dominant scale
const SUB_X = -14;           // x offset that centers the subtitle "millions, in space"
const SUB_GAP = 11;          // the subtitle rides this far below the (now larger) title

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
  { name: 'renderer.js', text:
`import * as THREE from 'three/webgpu'

export class GlyphField {
  constructor(scene, atlas) {
    this.scene = scene
    this.atlas = atlas
    this.mesh  = this._build()
  }
  render(text, pos, opts) {
    const glyphs = this.shape(text)
    this.write(glyphs, pos, opts)
    this.mesh.count = glyphs.length
  }
}` },
  { name: 'worker.js', text:
`self.onmessage = (e) => {
  const { text, font } = e.data
  const shaped = shapeText(text, font)
  const buf = buildSlugBuffers(shaped)
  postMessage(buf, [buf.buffer])
}

function buildSlugBuffers(shaped) {
  const out = new Float32Array(shaped.length * 10)
  for (const g of shaped) pack(out, g)
  return out
}` },
  { name: 'picking.js', text:
`pick(x, y) {
  this.swapToPickMaterial()
  renderer.render(scene, camera)
  const id = decode24(readPixel(x, y))
  this.swapBack()
  return this.resolve(id)
}` },
];

// Files orbit as a SUBTLE RING around the dominant title — a quiet "what's
// this?" halo, not a competing band. Even azimuths (DOME[i].az) place them
// around an ellipse sized to the wide banner; the ring slowly revolves.
const RING_RX = 72;          // horizontal ring radius (wide banner)
const RING_RY = 28;          // vertical ring radius (short banner)
const RING_ZD = 9;           // gentle depth float on the ring
const DOME = [
  { az: 0.00, el: 0.18 },
  { az: 0.79, el: 0.55 },
  { az: 1.57, el: 0.30 },
  { az: 2.36, el: 0.66 },
  { az: 3.14, el: 0.22 },
  { az: 3.93, el: 0.50 },
  { az: 4.71, el: 0.38 },
  { az: 5.50, el: 0.62 },
];

// Sine-wave the glyph instance-position buffer (local space) from a one-time
// snapshot of the laid-out positions. This is the thesis move: animation = a
// few lines writing buffer locations + needsUpdate. y ripples by glyph x (a
// traveling wave across each line); z adds gentle depth.
function waveGrid(grid, i, time, store, xyW, zW) {
  const mesh = grid.getRenderer?.()?.instanceMesh;
  const attr = mesh?.geometry?.attributes?.instancePosition;
  const count = mesh?.geometry?.instanceCount | 0;
  if (!attr || !count) return;
  let st = store.current[i];
  if (!st || st.count !== count) { st = { base: attr.array.slice(0, count * 3), count }; store.current[i] = st; }
  const { base } = st, arr = attr.array, phase = i * 1.3;
  const wXY = time * xyW, wZ = time * zW;           // independent temporal speeds
  for (let k = 0; k < count; k++) {
    const bx = base[k * 3], by = base[k * 3 + 1];
    // smooth XY travelling wave (per column) — gentle, the ring is subtle
    arr[k * 3 + 1] = by + 0.30 * Math.sin(bx * 0.10 + wXY + phase);
    // QUANTIZED z, per individual glyph (x AND y) → glyphs snap between discrete
    // depth planes: a voxelized, step-function pop. Math.round = the steps.
    const sz = Math.sin(bx * 0.55 + by * 0.70 + wZ + phase);
    // twice the steps, same total depth → finer, more "motion"-like stepping
    arr[k * 3 + 2] = base[k * 3 + 2] + (Math.round(sz * 2) / 2) * 0.22;
  }
  attr.needsUpdate = true;
}

function Director({ gridRefs, nameRef, subRef }) {
  const { camera } = useThree();
  const timeRef = useRef(0);                      // continuous seconds — no loop seam
  const auto = useRef(true);
  const waves = useRef([]);

  const apply = (time) => {
    const theta = time * ORBIT_W;                 // slow revolution
    FILES.forEach((f, i) => {
      const g = gridRefs.current[i];
      if (!g) return;
      const ang = DOME[i].az + theta;                       // even angle around the ring
      const jit = 0.86 + Math.sin(DOME[i].el * 4) * 0.14;   // subtle per-file radius variance
      g.position.set(
        Math.cos(ang) * RING_RX * jit,                      // around the title, ellipse
        RING_CY + Math.sin(ang) * RING_RY * jit,
        Math.sin(ang + i) * RING_ZD,                        // gentle depth float
      );
      g.rotation.set(0, -Math.sin(ang) * 0.15, 0);          // barely-there tilt, stays readable
      waveGrid(g, i, time, waves, WAVE_XY_W, WAVE_Z_W);
    });
    // The nameplate is the hero — big, bright, centered in the ring it orbits.
    const titleFloat = Math.sin(time * 0.25) * 0.8;
    const titleSway = Math.sin(time * 0.15) * 0.10;
    const nm = nameRef.current;
    if (nm) {
      nm.position.set(TITLE_X, RING_CY + 2 + titleFloat, 0);
      nm.rotation.set(0, titleSway, 0);                     // subtle sway
    }
    // The subtitle rides just under the title, floating with it as one lockup.
    const sub = subRef.current;
    if (sub) {
      sub.position.set(SUB_X, RING_CY + 2 + titleFloat - SUB_GAP, 0);
      sub.rotation.set(0, titleSway, 0);
    }
    // Camera centers the lockup: dominant title, ring of files around it.
    camera.position.set(0, RING_CY, CAM_Z);
    camera.lookAt(0, RING_CY, 0);
  };

  useFrame((_, dt) => {
    if (auto.current) timeRef.current += dt;
    apply(timeRef.current);
  });

  React.useEffect(() => {
    window.demo = {
      duration: CAPTURE_SECS, ready: true,
      seek: (t) => { auto.current = false; timeRef.current = (((t % 1) + 1) % 1) * CAPTURE_SECS; apply(timeRef.current); },
      play: () => { auto.current = true; },
    };
    return () => { delete window.demo; };
  }, []);

  return null;
}

function App() {
  const { atlas, error } = useGlyphEngine({ fontUrl });
  const gridRefs = useRef([]);
  const nameRef = useRef(null);
  const subRef = useRef(null);
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 16, 140], fov: 30, near: 0.1, far: 6000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director gridRefs={gridRefs} nameRef={nameRef} subRef={subRef} />
      {/* the hero — dominant, bright; the ring of files orbits around it */}
      <CodeGrid ref={nameRef} filename="" text="glyph3d" worldScale={0.110}
        textColor={NAME} showBackground={false} />
      {/* the subtitle — just under the title */}
      <CodeGrid ref={subRef} filename="" text="millions, in space" worldScale={0.038}
        textColor={SUB} showBackground={false} />
      {FILES.map((f, i) => (
        <CodeGrid
          key={f.name}
          ref={(el) => { gridRefs.current[i] = el; }}
          filename={f.name}
          text={f.text}
          worldScale={0.0095}
          textColor={DIM}
          showBackground={false}
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
