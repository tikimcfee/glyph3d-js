// camera-proximity.test.mjs — headless behavior lock for the proximity auto-slow:
//   • _lookDistance()  — the distance scan, incl. the behind-the-eye cull.
//   • _flightSpeedScale(dist) — the WASD speed VALLEY: cruise far, ramp down approaching,
//     floor plateau at reading distance, snap back to cruise once too close (release).
//   • _panDistance(dist)      — pan's held DISTANCE, clamped to the [near,far] band.
//   bun tools/camera-proximity.test.mjs
//
// Drives the REAL controller methods via the prototype (Object.create skips the ctor,
// which wants a canvas + event targets) with a mocked ctx. The camera looks down -Z
// (identity quaternion), so "behind" is +Z. The curve methods take an explicit distance,
// so the speed/pan shapes are unit-tested directly; the scan is tested through boxes.

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m, eps = 1e-6) => ok(Math.abs(a - b) <= eps, `${m} (got ${a} want ${b})`);

// A framed surface: just the getBounds() the look-distance scan reads. (cx,cy,cz) center,
// (hx,hy,hz) half-extents — an axis-aligned box.
const surf = (cx, cy, cz, hx = 10, hy = 10, hz = 10) => {
  const box = new THREE.Box3(
    new THREE.Vector3(cx - hx, cy - hy, cz - hz),
    new THREE.Vector3(cx + hx, cy + hy, cz + hz),
  );
  return { getBounds: () => box };
};

// Controller with only the fields the methods read — no ctor, no canvas. release defaults
// to 0 here (clean ramp) — the product default is 10; the release tests set it explicitly.
const make = (surfaces, { settings = {}, dock = null, camPos = [0, 0, 0] } = {}) => {
  const cc = Object.create(ViewerCameraController.prototype);
  cc.THREE = THREE;
  cc.settings = {
    dynamicSpeed: true, dynamicSpeedMin: 0.15, dynamicSpeedMax: 8,
    dynamicNearDist: 30, dynamicFarDist: 1600, dynamicReleaseDist: 0, ...settings,
  };
  cc.ctx = {
    camera: { position: new THREE.Vector3(...camPos), quaternion: new THREE.Quaternion() },
    getSurfaces: () => surfaces,
    dockTiles: dock,
  };
  return cc;
};
const curve = (settings = {}) => make([], { settings });   // surfaces unused when passing dist

const DEFAULT = 200;   // DEFAULT_LOOK_DIST (module-private) — the no-content / off scale

// ════════ _lookDistance: the scan + behind-the-eye cull ════════

// ── 1. a box dead ahead sets the look distance to the near face (you slow toward it) ──
eq(make([surf(0, 0, -100)])._lookDistance(), 90, 'ahead: look distance = forward hit on the near face');

// ── 2. a box fully BEHIND the eye is ignored (no braking for what you've flown past) ──
eq(make([surf(0, 0, 100)])._lookDistance(), DEFAULT, 'behind: a box wholly behind the eye is culled → default');

// ── 3. ahead + behind together: the behind box must not undercut the ahead distance ──
eq(make([surf(0, 0, -100), surf(0, 0, 40, 5, 5, 5)])._lookDistance(), 90, 'mixed: behind box ignored, ahead drives it');

// ── 4. a box straddling the eye plane (you're nosing into it) still counts ──
ok(make([surf(0, 0, -5, 10, 10, 20)])._lookDistance() < DEFAULT, 'straddle: a box you sit inside still brakes you');

// ── 5. dock tiles are skipped (camera-locked chrome isn't world content) ──
{
  const tile = surf(0, 0, -100);
  eq(make([tile], { dock: new Set([tile]) })._lookDistance(), DEFAULT, 'dock: a camera-locked tile never brakes you');
}

// ════════ _flightSpeedScale: the WASD speed valley ════════

// ── 6. ends of the band: far → ceiling, near → floor ──
{
  const c = curve();
  eq(c._flightSpeedScale(5000), 8, 'far beyond farDist → ceiling (cruise)');
  eq(c._flightSpeedScale(1600), 8, 'at farDist → ceiling');
  eq(c._flightSpeedScale(30), 0.15, 'at nearDist → floor');
  eq(c._flightSpeedScale(10), 0.15, 'below nearDist (release off) → floor plateau, all the way in');
}

// ── 7. the ramp is the lerp — and with default near/far it reproduces the old dist/200 ──
{
  const c = curve();
  eq(c._flightSpeedScale(90), 0.45, 'mid-ramp 90 → lerp = 0.45 (== old 90/200)');
  eq(c._flightSpeedScale(800), 4.0, 'mid-ramp 800 → lerp = 4.0 (== old 800/200)');
}

// ── 8. DECOUPLING: floor speed is independent of the floor distance ──
{
  const c = curve({ dynamicSpeedMin: 0.5, dynamicNearDist: 50 });
  eq(c._flightSpeedScale(50), 0.5, 'decoupled: floor speed honored at a custom nearDist (0.5 ≠ 50/200)');
  eq(c._flightSpeedScale(5), 0.5, 'decoupled: below nearDist holds the custom floor');
}

// ── 9. RELEASE (snap-back): get closer than releaseDist and you punch back to cruise ──
{
  const c = curve({ dynamicReleaseDist: 10 });
  eq(c._flightSpeedScale(5), 8, 'release on: inside releaseDist → snap to ceiling (passed through it)');
  eq(c._flightSpeedScale(10), 0.15, 'release boundary: AT releaseDist → still floor (snap is strictly inside)');
  eq(c._flightSpeedScale(20), 0.15, 'release on: between release and near → floor plateau preserved');
}

// ── 10. dynamicSpeed OFF: flat full speed, no valley ──
{
  const c = curve({ dynamicSpeed: false });
  eq(c._flightSpeedScale(2), 1, 'off: flight scale is a flat 1× (full speed)');
  eq(c._panDistance(2), DEFAULT, 'off: pan distance is the flat default');
}

// ════════ _panDistance: pan's held distance band ════════

// ── 11. pan clamps the look distance to [near, far] (real distance, not a multiplier) ──
{
  const c = curve();
  eq(c._panDistance(2), 30, 'pan: clamps up to nearDist (no nose-against-panel crawl)');
  eq(c._panDistance(5000), 1600, 'pan: clamps down to farDist (no void runaway)');
  eq(c._panDistance(300), 300, 'pan: passes a distance already inside the band through untouched');
}

// ════════ live WASD through _applyKeyboardMotion ════════

// ── 12. LIVE deceleration: a sustained flight re-samples each frame, so the per-frame
//        step SHRINKS as you near content (no stop/restart needed) ──
{
  const cc = make([surf(0, 0, -100)]);          // near face z=-90
  cc.cameraSpeed = 100;
  cc.input = { keys: new Set(['KeyW']) };        // W = forward (−Z)

  const z0 = cc.ctx.camera.position.z;           // 0 — far: dist 90, mid-ramp
  cc._applyKeyboardMotion(1 / 60);
  const stepFar = z0 - cc.ctx.camera.position.z;

  cc.ctx.camera.position.set(0, 0, -80);         // dist 10 → floor
  const z1 = cc.ctx.camera.position.z;
  cc._applyKeyboardMotion(1 / 60);
  const stepNear = z1 - cc.ctx.camera.position.z;

  ok(stepFar > 0, 'live WASD: the flight actually advances each frame');
  ok(stepNear < stepFar, 'live WASD: per-frame step shrinks as you near content (live deceleration)');
  ok(stepNear > 0, 'live WASD: the floor keeps the near step moving (not frozen to ~0)');
}

// ── 13. LIVE snap-back: punch inside releaseDist and the step jumps back up to cruise ──
{
  const cc = make([surf(0, 0, -100)], { settings: { dynamicReleaseDist: 10 } });
  cc.cameraSpeed = 100;
  cc.input = { keys: new Set(['KeyW']) };

  cc.ctx.camera.position.set(0, 0, -50);         // dist 40 → deep in the slow ramp
  const zA = cc.ctx.camera.position.z;
  cc._applyKeyboardMotion(1 / 60);
  const stepSlow = zA - cc.ctx.camera.position.z;

  cc.ctx.camera.position.set(0, 0, -85);         // dist 5 (< release) → snapped to cruise
  const zB = cc.ctx.camera.position.z;
  cc._applyKeyboardMotion(1 / 60);
  const stepSnap = zB - cc.ctx.camera.position.z;

  ok(stepSnap > stepSlow, 'release: punching inside releaseDist jumps the step back up to cruise');
}

console.log(`\ncamera-proximity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
