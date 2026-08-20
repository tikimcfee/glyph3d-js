// camera-proximity.test.mjs — headless behavior lock for SCALE-FREE FLIGHT
// (docs/plans/scale-free-flight.md):
//   • _lookDistance()  — the angle-gated distance FIELD: the 9-ray cone probe, per-ray
//     nearest hit, weighted log-space soft-min, behind-the-eye cull, void fallback.
//   • _flightSpeedScale(dist) — the pure law: dist / DEFAULT_LOOK_DIST (constant
//     on-screen text velocity — the terminal invariant).
//   • _flightTargetDist(raw)  — the punch-through remap (release), applied pre-slew.
//   • _panDistance(dist)      — pan's held DISTANCE, bounded only by the global look band.
//   • _applyKeyboardMotion()  — live WASD + the asymmetric log-space slew of the distance,
//     and the marquee lock: scale the whole scene by c → the per-frame step scales by
//     exactly c (on-screen motion identical in every scale regime).
//   bun tools/camera-proximity.test.mjs
//
// Drives the REAL controller methods via the prototype (Object.create skips the ctor,
// which wants a canvas + event targets) with a mocked ctx. The camera looks down -Z
// (identity quaternion), so "behind" is +Z. The law methods take an explicit distance,
// so the curve is unit-tested directly; the field is tested through boxes.

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m, eps = 1e-6) => ok(Math.abs(a - b) <= eps, `${m} (got ${a} want ${b})`);

// A framed surface: just the getBounds() the field scan reads. (cx,cy,cz) center,
// (hx,hy,hz) half-extents — an axis-aligned box. Faces in the ahead tests are WIDE
// (hx=hy=50) so all 9 probe rays land on the same near face — a plane at fixed z
// projects to the same forward distance on every ray, making the soft-min exact.
const surf = (cx, cy, cz, hx = 50, hy = 50, hz = 10) => {
  const box = new THREE.Box3(
    new THREE.Vector3(cx - hx, cy - hy, cz - hz),
    new THREE.Vector3(cx + hx, cy + hy, cz + hz),
  );
  return { getBounds: () => box };
};

// Controller with only the fields the methods read — no ctor, no canvas. Slews default
// to 0 here (deterministic snap); the slew tests set them explicitly.
const make = (surfaces, { settings = {}, dock = null, camPos = [0, 0, 0] } = {}) => {
  const cc = Object.create(ViewerCameraController.prototype);
  cc.THREE = THREE;
  cc.settings = {
    dynamicSpeed: true, dynamicReleaseDist: 0,
    dynamicBrakeSlew: 0, dynamicThrottleSlew: 0, ...settings,
  };
  cc.ctx = {
    camera: { position: new THREE.Vector3(...camPos), quaternion: new THREE.Quaternion() },
    getSurfaces: () => surfaces,
    dockTiles: dock,
  };
  return cc;
};
const curve = (settings = {}) => make([], { settings });   // surfaces unused when passing dist

const DEFAULT = 200;   // DEFAULT_LOOK_DIST (module-private) — reference distance AND the void scale
const MIN = 2, MAX = 2000;   // the global look band

// ════════ _lookDistance: the angle-gated field ════════

// ── 1. a wide face dead ahead reads exactly its near-face distance (all rays agree,
//       and a soft-min of identical votes is exact) ──
eq(make([surf(0, 0, -100)])._lookDistance(), 90, 'ahead: a face all rays land on reads its near-face distance exactly');

// ── 2. a box fully BEHIND the eye is ignored (no braking for what you've flown past) ──
eq(make([surf(0, 0, 100)])._lookDistance(), DEFAULT, 'behind: a box wholly behind the eye is culled → default');

// ── 3. ahead + behind together: the behind box must not undercut the ahead distance ──
eq(make([surf(0, 0, -100), surf(0, 0, 40, 5, 5, 5)])._lookDistance(), 90, 'mixed: behind box ignored, ahead face drives it');

// ── 4. a box straddling the eye plane (you're nosing into it) still counts ──
ok(make([surf(0, 0, -5, 10, 10, 20)])._lookDistance() < DEFAULT, 'straddle: a box you sit inside still brakes you');

// ── 5. dock tiles are skipped (instruments you read WITH, not content you read) ──
{
  const tile = surf(0, 0, -100);
  eq(make([tile], { dock: new Set([tile]) })._lookDistance(), DEFAULT, 'dock: a camera-locked tile never brakes you');
}

// ── 6. ANGLE GATES: near content wholly outside the cone does not vote, however near —
//       what you FACE governs (the turn-your-head-while-close invariant) ──
{
  const far  = surf(0, 0, -500, 200, 200, 10);   // dead ahead, wide → all rays, 490
  const shoulder = surf(60, 0, -20, 10, 10, 10); // ~70° off-axis, 40 units away — outside the cone
  eq(make([far])._lookDistance(), 490, 'gate: the faced wall alone reads 490');
  eq(make([far, shoulder])._lookDistance(), 490, 'gate: off-shoulder near content casts no vote — no leash');
}

// ── 7. DISTANCE ANSWERS within the cone: an off-axis near edge caught by peripheral
//       rays pulls the answer near-ward (soft-min), but weighted — it doesn't own it ──
{
  const far  = surf(0, 0, -500, 200, 200, 10);   // all rays → 490
  const edge = surf(20, 0, -100, 10, 10, 10);    // right-side rays → 90
  const d = make([far, edge])._lookDistance();
  ok(d > 90 && d < DEFAULT, `soft-min: near edge in the cone pulls the field near-ward, weighted (got ${d})`);
}

// ── 8. SCALE-FREE: scale the whole scene (content + eye) by c and the field scales by
//       exactly c — the log-space aggregation has no absolute unit in it ──
{
  const at1 = make([surf(0, 0, -500, 200, 200, 10), surf(20, 0, -100, 10, 10, 10)],
    { camPos: [0, 0, 0] })._lookDistance();
  const c = 0.1;
  const at01 = make([surf(0, 0, -50, 20, 20, 1), surf(2, 0, -10, 1, 1, 1)],
    { camPos: [0, 0, 0] })._lookDistance();
  eq(at01, at1 * c, 'scale-free: scene ×0.1 → field ×0.1 exactly', 1e-9);
}

// ── 9. void: no surfaces → default; all rays missing but content off-axis → nearest
//       non-behind AABB (the anti-runaway fallback, not part of the law) ──
{
  eq(make([])._lookDistance(), DEFAULT, 'void: no content → default');
  const shoulder = surf(60, 0, -20, 10, 10, 10);   // outside the cone, 40ish away
  const d = make([shoulder])._lookDistance();
  ok(Number.isFinite(d) && d < DEFAULT, 'void fallback: rays all miss → nearest non-behind AABB, not a runaway');
}

// ════════ _flightSpeedScale: the pure law ════════

// ── 10. scale = dist / DEFAULT: 1× at the reference, proportional everywhere else ──
{
  const c = curve();
  eq(c._flightSpeedScale(DEFAULT), 1, 'law: at the reference distance → exactly 1× (the speed slider keeps its meaning)');
  eq(c._flightSpeedScale(100), 0.5, 'law: half the reference → half speed');
  eq(c._flightSpeedScale(MAX), 10, 'law: at the far clamp → 10×');
  eq(c._flightSpeedScale(MIN), 0.01, 'law: at the near clamp → 0.01× — no floor band, the law runs pure');
}

// ── 11. dynamicSpeed OFF: flat full speed, flat pan default ──
{
  const c = curve({ dynamicSpeed: false });
  eq(c._flightSpeedScale(2), 1, 'off: flight scale is a flat 1× (full speed)');
  eq(c._panDistance(2), DEFAULT, 'off: pan distance is the flat default');
}

// ════════ _flightTargetDist: the punch-through escape (default OFF) ════════

// ── 12. release 0 (default) → identity; release on remaps only strictly inside it ──
{
  const c = curve();
  eq(c._flightTargetDist(5), 5, 'release off (default): raw passes through — no absolute-unit escape');
  const r = curve({ dynamicReleaseDist: 10 });
  eq(r._flightTargetDist(5), DEFAULT, 'release on: inside releaseDist → reference distance (void speed)');
  eq(r._flightTargetDist(10), 10, 'release boundary: AT releaseDist → untouched (strictly inside)');
  eq(r._flightTargetDist(15), 15, 'release on: outside releaseDist → untouched');
}

// ════════ _panDistance: pan's held distance ════════

// ── 13. pan bounds by the GLOBAL look band only — a nose-close drag moves at page-
//        scroll speed (the invariant), no absolute engagement band ──
{
  const c = curve();
  eq(c._panDistance(0.5), MIN, 'pan: floors at the global MIN (anti-zero, not an engagement band)');
  eq(c._panDistance(5000), MAX, 'pan: caps at the global MAX (no void runaway)');
  eq(c._panDistance(8), 8, 'pan: a near-page distance passes through — the drag IS the scroll');
  eq(c._panDistance(300), 300, 'pan: mid-band distance untouched');
}

// ════════ live WASD through _applyKeyboardMotion ════════

// A flier set to hold W, with one wide box dead-ahead at z=-100.
const flyer = (settings, camZ, surfaces = [surf(0, 0, -100)]) => {
  const cc = make(surfaces, { settings, camPos: [0, 0, camZ] });
  cc.cameraSpeed = 100;
  cc.input = { keys: new Set(['KeyW']) };
  return cc;
};

// ── 14. LIVE deceleration: v ∝ d, so the per-frame step SHRINKS as you near content ──
{
  const cc = flyer({}, 0);                        // near face z=-90 → d 90
  const z0 = cc.ctx.camera.position.z;
  cc._applyKeyboardMotion(1 / 60);
  const stepFar = z0 - cc.ctx.camera.position.z;

  cc._slewedLookDist = null;                      // fresh takeoff at the new pose
  cc.ctx.camera.position.set(0, 0, -80);          // d 10
  const z1 = cc.ctx.camera.position.z;
  cc._applyKeyboardMotion(1 / 60);
  const stepNear = z1 - cc.ctx.camera.position.z;

  ok(stepFar > 0, 'live WASD: the flight actually advances each frame');
  eq(stepNear / stepFar, 10 / 90, 'live WASD: steps are in exact proportion to distance (v = k·d)', 1e-9);
}

// ── 15. THE MARQUEE LOCK: scale the whole scene by c and the per-frame step scales by
//        exactly c — flying a 0.1× fitted volume is kinesthetically identical to flying
//        the natural-scale world (body scale is unobservable) ──
{
  const a = flyer({}, 0, [surf(0, 0, -100, 50, 50, 10)]);
  a._applyKeyboardMotion(1 / 60);
  const step1 = -a.ctx.camera.position.z;

  const b = flyer({}, 0, [surf(0, 0, -10, 5, 5, 1)]);   // the same scene at 0.1×
  b._applyKeyboardMotion(1 / 60);
  const step01 = -b.ctx.camera.position.z;

  eq(step01, step1 * 0.1, 'scale-free flight: scene ×0.1 → per-frame step ×0.1 exactly', 1e-9);
}

// ── 16. punch-through (opt-in): inside releaseDist the step jumps to reference speed ──
{
  const slow = flyer({ dynamicReleaseDist: 10 }, -50);   // d 40 → 0.2×
  slow._applyKeyboardMotion(1 / 60);
  const stepSlow = -50 - slow.ctx.camera.position.z;

  const snap = flyer({ dynamicReleaseDist: 10 }, -85);   // d 5 (< release) → reference → 1×
  snap._applyKeyboardMotion(1 / 60);
  const stepSnap = -85 - snap.ctx.camera.position.z;

  ok(stepSnap > stepSlow, 'release: punching inside releaseDist jumps the step to reference speed');
}

// ════════ the asymmetric log-space slew ════════

// ── S1. first moving frame SNAPS to target (null latch) — crisp takeoff ──
{
  const cc = flyer({ dynamicBrakeSlew: 0.1, dynamicThrottleSlew: 0.4 }, 0);   // d 90
  cc._applyKeyboardMotion(1 / 60);
  eq(cc._slewedLookDist, 90, 'slew: first frame snaps the distance to target (crisp takeoff)');
}

// ── S2. a DROP in target rides the BRAKE constant, by the exact log-space formula ──
{
  const cc = flyer({ dynamicBrakeSlew: 0.1, dynamicThrottleSlew: 0.4 }, 0);   // target 90
  cc._slewedLookDist = 200;                       // pretend we were cruising at reference
  cc._applyKeyboardMotion(1 / 60);
  const alpha = 1 - Math.exp(-(1 / 60) / 0.1);
  eq(cc._slewedLookDist, Math.exp(Math.log(200) + (Math.log(90) - Math.log(200)) * alpha),
    'slew: brake = exp(ln cur + (ln target − ln cur)·(1−e^(−dt/τ_brake)))');
}

// ── S3. a RISE in target rides the THROTTLE constant — lazier than the brake ──
{
  const mk = () => {
    const cc = flyer({ dynamicBrakeSlew: 0.1, dynamicThrottleSlew: 0.4 }, 0);
    cc._slewedLookDist = 30;                      // below target 90 → rising
    cc._applyKeyboardMotion(1 / 60);
    return cc._slewedLookDist;
  };
  const rose = mk();
  const alpha = 1 - Math.exp(-(1 / 60) / 0.4);
  eq(rose, Math.exp(Math.log(30) + (Math.log(90) - Math.log(30)) * alpha),
    'slew: throttle uses its own (longer) constant');
  // and asymmetry is real: the same-size log-gap closes further under the brake
  const cc2 = flyer({ dynamicBrakeSlew: 0.1, dynamicThrottleSlew: 0.4 }, 0);
  cc2._slewedLookDist = 270;                      // above target 90 → braking, same |log gap| as 30→90
  cc2._applyKeyboardMotion(1 / 60);
  const brakeClosed = Math.abs(Math.log(cc2._slewedLookDist) - Math.log(90));
  const throttleClosed = Math.abs(Math.log(rose) - Math.log(90));
  ok(brakeClosed < throttleClosed, 'slew: decelerate fast, accelerate gently (brake closes the gap faster)');
}

// ── S4. slews at 0 snap instantly; a giant frame asymptotes without overshoot ──
{
  const cc = flyer({}, 0);                        // both slews 0
  cc._slewedLookDist = 500;
  cc._applyKeyboardMotion(1 / 60);
  eq(cc._slewedLookDist, 90, 'slew: τ=0 snaps to target instantly');

  const cd = flyer({ dynamicBrakeSlew: 0.1, dynamicThrottleSlew: 0.4 }, 0);
  cd._slewedLookDist = 500;
  cd._applyKeyboardMotion(1.0);                   // a giant 1s frame
  ok(cd._slewedLookDist >= 90 - 1e-9 && cd._slewedLookDist < 91, 'slew: a 1s frame closes the gap without overshoot');
}

// ── S5. releasing the keys UNLATCHES (null) so the next takeoff snaps fresh ──
{
  const cc = flyer({ dynamicBrakeSlew: 0.1, dynamicThrottleSlew: 0.4 }, 0);
  cc._slewedLookDist = 500;
  cc.input = { keys: new Set() };                 // not moving
  cc._applyKeyboardMotion(1 / 60);
  ok(cc._slewedLookDist === null, 'slew: releasing keys unlatches → next flight snaps');
}

console.log(`\ncamera-proximity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
