// camera-proximity.test.mjs — headless behavior lock for the proximity auto-slow:
// the behind-the-eye cull in _lookDistance() and the min/max band in _movementScale().
//   bun tools/camera-proximity.test.mjs
//
// Drives the REAL controller methods via the prototype (Object.create skips the ctor,
// which wants a canvas + event targets) with a mocked ctx — camera + getSurfaces only.
// The camera looks down -Z (identity quaternion), so "behind" is +Z.

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

// Controller with only the fields _lookDistance/_movementScale read — no ctor, no canvas.
const make = (surfaces, { settings = {}, dock = null, camPos = [0, 0, 0] } = {}) => {
  const cc = Object.create(ViewerCameraController.prototype);
  cc.THREE = THREE;
  cc.settings = { dynamicSpeed: true, dynamicSpeedMin: 0.15, dynamicSpeedMax: 8, ...settings };
  cc.ctx = {
    camera: { position: new THREE.Vector3(...camPos), quaternion: new THREE.Quaternion() },
    getSurfaces: () => surfaces,
    dockTiles: dock,
  };
  return cc;
};

const DEFAULT = 200;   // DEFAULT_LOOK_DIST (module-private) — the no-content / off scale

// ── 1. a box dead ahead sets the look distance to the near face (you slow toward it) ──
{
  const cc = make([surf(0, 0, -100)]);                  // spans z[-110,-90], ray hits -90
  eq(cc._lookDistance(), 90, 'ahead: look distance = forward hit on the near face');
}

// ── 2. a box fully BEHIND the eye is ignored (no braking for what you've flown past) ──
{
  const cc = make([surf(0, 0, 100)]);                   // entirely at +Z → behind
  eq(cc._lookDistance(), DEFAULT, 'behind: a box wholly behind the eye is culled → default');
}

// ── 3. ahead + behind together: the behind box must not undercut the ahead distance ──
{
  const cc = make([surf(0, 0, -100), surf(0, 0, 40, 5, 5, 5)]); // 2nd: z[35,45], behind
  eq(cc._lookDistance(), 90, 'mixed: behind box ignored, ahead box still drives the scale');
}

// ── 4. a box straddling the eye plane (you're nosing into it) still counts ──
{
  const cc = make([surf(0, 0, -5, 10, 10, 20)]);        // z[-25,15] crosses the plane
  ok(cc._lookDistance() < DEFAULT, 'straddle: a box you sit inside still brakes you (not culled)');
}

// ── 5. band FLOOR: nose-against a panel floors at min·DEFAULT, not ~0 ──
{
  const cc = make([surf(0, 0, -3, 1, 1, 1)]);           // z[-4,-2], ray hits -2 → dist 2
  eq(cc._lookDistance(), 2, 'close: raw look distance really is ~2 (the near-0 case)');
  eq(cc._movementScale(), 0.15 * DEFAULT, 'floor: movement scale clamps up to min·DEFAULT (=30)');
}

// ── 6. band CEILING: a far glance caps at max·DEFAULT, no runaway ──
{
  const cc = make([surf(0, 0, -1800)]);                 // z[-1810,-1790], hit -1790
  eq(cc._lookDistance(), 1790, 'far: raw look distance = 1790');
  eq(cc._movementScale(), 8 * DEFAULT, 'ceiling: movement scale clamps down to max·DEFAULT (=1600)');
}

// ── 7. inside the band, movement scale passes the look distance through untouched ──
{
  const cc = make([surf(0, 0, -100)]);                  // 90 ∈ [30, 1600]
  eq(cc._movementScale(), 90, 'in-band: movement scale = look distance when already within [min,max]');
}

// ── 8. dynamicSpeed OFF: both fall back to the flat DEFAULT (no proximity scaling) ──
{
  const cc = make([surf(0, 0, -3, 1, 1, 1)], { settings: { dynamicSpeed: false } });
  eq(cc._lookDistance(), DEFAULT, 'off: _lookDistance is the flat default');
  eq(cc._movementScale(), DEFAULT, 'off: _movementScale is the flat default (no band)');
}

// ── 9. custom band is honored (settings, not hardcoded constants) ──
{
  const cc = make([surf(0, 0, -3, 1, 1, 1)], { settings: { dynamicSpeedMin: 0.5 } });
  eq(cc._movementScale(), 0.5 * DEFAULT, 'custom floor: band reads dynamicSpeedMin from settings');
}

// ── 10. dock tiles are skipped (camera-locked chrome isn't world content) ──
{
  const tile = surf(0, 0, -100);
  const cc = make([tile], { dock: new Set([tile]) });
  eq(cc._lookDistance(), DEFAULT, 'dock: a camera-locked tile never brakes the camera');
}

// ── 11. LIVE WASD: a sustained flight re-samples each frame, so the per-frame step
//        SHRINKS as you near content (the deceleration you can see without stop/restart) ──
{
  const cc = make([surf(0, 0, -100)]);        // box near face at z=-90
  cc.cameraSpeed = 100;
  cc.input = { keys: new Set(['KeyW']) };      // W = forward (−Z)

  const z0 = cc.ctx.camera.position.z;         // 0 — far: look dist 90, in-band
  cc._applyKeyboardMotion(1 / 60);
  const stepFar = z0 - cc.ctx.camera.position.z;

  cc.ctx.camera.position.set(0, 0, -80);       // close: look dist 10 → floored to 30
  const z1 = cc.ctx.camera.position.z;
  cc._applyKeyboardMotion(1 / 60);
  const stepNear = z1 - cc.ctx.camera.position.z;

  ok(stepFar > 0, 'live WASD: the flight actually advances each frame');
  ok(stepNear < stepFar, 'live WASD: per-frame step shrinks as you near content (live deceleration)');
  ok(stepNear > 0, 'live WASD: the floor keeps the near step moving (not frozen to ~0)');
}

console.log(`\ncamera-proximity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
