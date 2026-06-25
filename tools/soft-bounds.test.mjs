// soft-bounds.test.mjs — headless behavior lock for the camera soft-bounds leash
// (_applySoftBounds, the (A)+hardcap design):
//   • inside the padded world box → no force (free flight)
//   • outside + idle → an exp spring eases the eye toward the nearest box face (the exact lerp)
//   • outside + DRIVING (drag / wheel / WASD) → the soft spring is suppressed (a deliberate
//     pull-back-for-overview is never fought)
//   • the hard cap clamps the eye every frame, even while driving (the dropped-frame backstop)
//   • settle deadband → snaps exactly to the boundary, then stays put (no idle move-save churn)
//   • MIN_WORLD_EXTENT floor → a tiny world still gets breathing room, not a face-hugging leash
//   • cap < pad is forced cap ≥ pad (the wall never sits inside the free zone)
//   • softBounds off / empty world → passthrough
//   bun tools/soft-bounds.test.mjs
//
// Drives the REAL controller method via the prototype (Object.create skips the ctor, which wants
// a canvas + event targets) with a mocked ctx. worldBounds + Box3/Vector3 math are real (three
// core). The lone test world is a box centered at origin with ±100 half-extents, so size=200 on
// every axis → extent = max(200, MIN_WORLD_EXTENT=500) = 500. Default pad=1 → soft box ±600;
// default cap=4 → hard wall ±2100.

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m, eps = 1e-6) => ok(Math.abs(a - b) <= eps, `${m} (got ${a} want ${b})`);

// A framed surface: just the getBounds() the leash reads. (cx,cy,cz) center, (hx,hy,hz) half-extents.
const surf = (cx, cy, cz, hx = 10, hy = 10, hz = 10) => {
  const box = new THREE.Box3(
    new THREE.Vector3(cx - hx, cy - hy, cz - hz),
    new THREE.Vector3(cx + hx, cy + hy, cz + hz),
  );
  return { getBounds: () => box };
};

// Controller with only what _applySoftBounds reads — no ctor, no canvas. Default input = idle.
const make = (surfaces, { settings = {}, camPos = [0, 0, 0], input = {} } = {}) => {
  const cc = Object.create(ViewerCameraController.prototype);
  cc.THREE = THREE;
  cc.settings = {
    softBounds: true, softBoundsPadding: 1, softBoundsHardCap: 4, softBoundsReturn: 0.35,
    ...settings,
  };
  cc.input = { drag: { active: false }, keys: new Set(), wheel: { dy: 0 }, ...input };
  cc.ctx = {
    camera: { position: new THREE.Vector3(...camPos), quaternion: new THREE.Quaternion() },
    getSurfaces: () => surfaces,
  };
  return cc;
};

const WORLD = () => [surf(0, 0, 0, 100, 100, 100)];   // box ±100 → extent 500, soft ±600, cap ±2100

// ════════ inside the free zone ════════

// ── 1. eye comfortably inside the padded box → nothing moves ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 300] });   // 300 < soft 600
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 300, 'inside the free zone: no leash, position untouched');
}

// ════════ outside + idle → the spring ════════

// ── 2. idle past the near face → eases toward it, by the exact frame-rate-independent lerp ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 1000] });  // 600 < 1000 < cap 2100
  cc._applySoftBounds(1 / 60, false);
  const z = cc.ctx.camera.position.z;
  ok(z < 1000 && z > 600, 'outside + idle: spring eases the eye toward the near face (600 < z < 1000)');
  const alpha = 1 - Math.exp(-(1 / 60) / 0.35);
  eq(z, 1000 + (600 - 1000) * alpha, 'outside + idle: glide = lerp(eye, nearest, 1-exp(-dt/τ))');
  eq(cc.ctx.camera.position.x, 0, 'outside + idle: axes already inside the box are untouched');
}

// ── 3. τ = 0 → instant snap to the boundary (no smoothing) ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 1000], settings: { softBoundsReturn: 0 } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 600, 'return 0: snaps straight to the boundary (no ease)');
}

// ════════ outside + DRIVING → spring suppressed (but cap still bites) ════════

// ── 4. WASD held → the soft spring waits (an intentional move isn't fought) ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 1000], input: { keys: new Set(['KeyW']) } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 1000, 'outside + driving (WASD): soft spring suppressed, not fought');
}

// ── 5. wheel dollied this frame → suppressed too (the drovewheel flag) ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 1000] });
  cc._applySoftBounds(1 / 60, true);   // drovewheel = true
  eq(cc.ctx.camera.position.z, 1000, 'outside + wheel dolly: soft spring suppressed (drovewheel flag)');
}

// ── 6. active drag → suppressed too ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 1000], input: { drag: { active: true } } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 1000, 'outside + active drag: soft spring suppressed');
}

// ════════ the hard cap — always on, even mid-drive ════════

// ── 7. a fling far past the wall is clamped to it even while WASD is held (dropped-frame backstop) ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 5000], input: { keys: new Set(['KeyW']) } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 2100, 'hard cap: clamps the eye to the wall even mid-drive');
}

// ── 8. the cap clamps every axis ──
{
  const cc = make(WORLD(), { camPos: [9000, -9000, 0], input: { keys: new Set(['KeyD']) } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.x, 2100, 'hard cap: +x clamped to the wall');
  eq(cc.ctx.camera.position.y, -2100, 'hard cap: −y clamped to the wall');
}

// ════════ settling ════════

// ── 9. within the deadband → snap exactly onto the face, and stay put next frame (no churn) ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 600.3] });   // 0.3u past the 600 face (< 0.5 deadband)
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 600, 'settle deadband: within 0.5u of the face snaps exactly onto it');
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 600, 'settle deadband: a settled eye stays put (no idle move-save churn)');
}

// ════════ floors & guards ════════

// ── 10. MIN_WORLD_EXTENT: a tiny world still gets room — eye at 400 is FREE, not leashed to a 1u face ──
{
  const cc = make([surf(0, 0, 0, 1, 1, 1)], { camPos: [0, 0, 400] });   // extent floored 500 → soft ±501
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 400, 'tiny world: MIN_WORLD_EXTENT floor keeps the eye free (not pinned to a 1u face)');
}

// ── 11. cap < pad is forced cap ≥ pad: the wall never sits inside the free zone ──
{
  // pad 4 (→ ±2100), cap 1 (would be ±600). capScale = max(1,4)=4, so the wall lands at ±2100,
  // NOT an inverted 600 that would yank you inside the soft zone.
  const cc = make(WORLD(), { camPos: [0, 0, 2500], settings: { softBoundsPadding: 4, softBoundsHardCap: 1 } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 2100, 'cap<pad guard: hard wall forced ≥ the pad (clamps to 2100, not 600)');
}

// ════════ off / empty ════════

// ── 12. softBounds off → free flight, no leash and no cap ──
{
  const cc = make(WORLD(), { camPos: [0, 0, 9999], settings: { softBounds: false } });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 9999, 'softBounds off: free flight, no leash and no hard cap');
}

// ── 13. empty world → nothing to leash against → passthrough ──
{
  const cc = make([], { camPos: [0, 0, 9999] });
  cc._applySoftBounds(1 / 60, false);
  eq(cc.ctx.camera.position.z, 9999, 'empty world: nothing to leash against → passthrough');
}

console.log(`\nsoft-bounds: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
