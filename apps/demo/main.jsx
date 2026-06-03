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
const NAME = { r: 0.88, g: 0.84, b: 0.60 };  // brighter — the central nameplate pops
const TAU = Math.PI * 2;
// Independent animation rates (rad/s on a continuous clock) so orbit and the
// waves tune separately. Live autoplay runs a continuous clock — no loop
// boundary, so no seam; seek(t) maps t∈[0,1] across CAPTURE_SECS for capture.
const ORBIT_W = 0.135;       // slow dome revolution (~0.30× the prior speed)
const WAVE_XY_W = 0.90;      // XY ripple — kept lively
const WAVE_Z_W = 0.45;       // z voxel float (~0.5× the prior speed)
const CAM_Z = 138;           // frame the header band (top) + the title (lower-center)
const CAPTURE_SECS = 46;     // seek window ≈ one full revolution
const DOME_LIFT = 16;        // float the orbiting files up — a header animation band
const TITLE_Y = 2;           // the glyph3d title sits lower-center, under the header

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

// Files live on a hemisphere (a "semi-dome"), spread around in azimuth and up
// in elevation, each facing radially outward. The whole dome slowly revolves,
// so the per-glyph z-float reads as real depth as each file comes around.
const R_DOME = 64;           // dome scaled to ~0.75 total volume
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
    // smooth XY travelling wave (per column) — amp scaled with the 0.75 volume
    arr[k * 3 + 1] = by + 1.65 * Math.sin(bx * 0.10 + wXY + phase);
    // QUANTIZED z, per individual glyph (x AND y) → glyphs snap between discrete
    // depth planes: a voxelized, step-function pop. Math.round = the steps.
    const sz = Math.sin(bx * 0.55 + by * 0.70 + wZ + phase);
    // twice the steps, same total depth → finer, more "motion"-like stepping
    arr[k * 3 + 2] = base[k * 3 + 2] + (Math.round(sz * 2) / 2) * 1.30;
  }
  attr.needsUpdate = true;
}

function Director({ gridRefs, nameRef }) {
  const { camera } = useThree();
  const timeRef = useRef(0);                      // continuous seconds — no loop seam
  const auto = useRef(true);
  const waves = useRef([]);

  const apply = (time) => {
    const theta = time * ORBIT_W;                 // slow revolution
    FILES.forEach((f, i) => {
      const g = gridRefs.current[i];
      if (!g) return;
      const az = DOME[i].az + theta, el = DOME[i].el;
      const ce = Math.cos(el) * R_DOME;
      g.position.set(
        ce * Math.sin(az),
        Math.sin(el) * R_DOME + DOME_LIFT + Math.sin(theta + i) * 1.2,   // dome height, lifted
        ce * Math.cos(az),
      );
      g.rotation.set(0, az, 0);                   // face radially outward
      waveGrid(g, i, time, waves, WAVE_XY_W, WAVE_Z_W);
    });
    // Central floating nameplate — the dome of files orbits around this.
    const nm = nameRef.current;
    if (nm) {
      nm.position.set(-15, TITLE_Y + Math.sin(time * 0.5) * 1.6, 0);   // lower-center float
      nm.rotation.set(0, Math.sin(time * 0.3) * 0.12, 0);              // subtle sway
    }
    // Camera frames the header band (up) and the title (lower-center).
    camera.position.set(0, 18, CAM_Z);
    camera.lookAt(0, 16, 0);
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
  if (error || !atlas) return null;
  return (
    <GlyphCanvas
      atlas={atlas}
      camera={{ position: [0, 18, 138], fov: 70, near: 0.1, far: 6000 }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x0e0c08); }}
    >
      <Director gridRefs={gridRefs} nameRef={nameRef} />
      {/* central floating nameplate — bigger, brighter, no background */}
      <CodeGrid ref={nameRef} filename="" text="glyph3d" worldScale={0.10}
        textColor={NAME} showBackground={false} />
      {FILES.map((f, i) => (
        <CodeGrid
          key={f.name}
          ref={(el) => { gridRefs.current[i] = el; }}
          filename={f.name}
          text={f.text}
          worldScale={0.034}
          textColor={SAGE}
          showBackground={false}
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
