// camera.test.mjs — headless unit test for the camera-fly math (easeOutCubic + tweenPose),
// the pure heart of the flyTo animation. No THREE camera, no renderer.
//   bun tools/camera.test.mjs

import { easeOutCubic, tweenPose, shortYaw } from '../packages/glyph3d-core/src/services/spatial/spatialMath.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, m, eps = 1e-9) => ok(Math.abs(a - b) <= eps, `${m} (got ${a} want ${b})`);

// easeOutCubic: endpoints, clamp, monotonic, and actually ease-OUT (fast start).
near(easeOutCubic(0), 0, 'easeOut(0) = 0');
near(easeOutCubic(1), 1, 'easeOut(1) = 1');
near(easeOutCubic(-5), 0, 'easeOut clamps below 0');
near(easeOutCubic(5), 1, 'easeOut clamps above 1');
ok(easeOutCubic(0.5) > 0.5, 'ease-OUT: past halfway by t=0.5 (fast start)');
{
  let prev = -1, mono = true;
  for (let t = 0; t <= 1.0001; t += 0.05) { const v = easeOutCubic(t); if (v < prev - 1e-9) mono = false; prev = v; }
  ok(mono, 'easeOut is monotonic non-decreasing');
}

// tweenPose: t=0 → from, t=1 → to (lands exactly), and stays within the box between.
{
  const from = { position: { x: 0, y: 0, z: 100 }, pitch: 0, yaw: 0 };
  const to = { position: { x: 10, y: -20, z: 40 }, pitch: 0.5, yaw: -1 };
  const a = tweenPose(from, to, 0);
  near(a.position.x, 0, 't=0 → from.x'); near(a.position.z, 100, 't=0 → from.z'); near(a.pitch, 0, 't=0 → from.pitch');
  const b = tweenPose(from, to, 1);
  near(b.position.x, 10, 't=1 → to.x'); near(b.position.y, -20, 't=1 → to.y');
  near(b.position.z, 40, 't=1 → to.z'); near(b.pitch, 0.5, 't=1 → to.pitch'); near(b.yaw, -1, 't=1 → to.yaw');
  const m = tweenPose(from, to, 0.5);
  ok(m.position.x > 0 && m.position.x < 10, 'midpoint x is between from and to');
  ok(m.position.z < 100 && m.position.z > 40, 'midpoint z is between from and to');
  // ease-out: at t=0.5 it's already past the linear midpoint toward `to`.
  ok(m.position.x > 5, 'ease-out: midpoint is past linear halfway toward target');
}

// tweenPose turns the SHORT way: across ±π (a ring desk behind you, the hub) yaw never sweeps the
// long way round through the room. Every sample stays within the short arc, and t=1 lands on `to`.
{
  const cases = [
    [3.0, -3.0], [-3.0, 3.0], [Math.PI - 0.01, -Math.PI + 0.01], [0.2, 6.2], [10, -10], [1, -1],
  ];
  for (const [a, b] of cases) {
    const from = { position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: a };
    const to = { position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: b };
    const arc = Math.abs(shortYaw(a, b));
    ok(arc <= Math.PI + 1e-12, `shortYaw(${a}, ${b}) is within π (got ${arc})`);
    const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
    near(wrap(a + shortYaw(a, b)), wrap(b), `shortYaw(${a}, ${b}) arrives at b`, 1e-12);
    let worst = 0;
    for (let t = 0; t <= 1.0001; t += 0.02) worst = Math.max(worst, Math.abs(wrap(tweenPose(from, to, t).yaw - a)));
    ok(worst <= arc + 1e-9, `yaw ${a} → ${b} sweeps the short arc (${arc.toFixed(3)} rad), not ${worst.toFixed(3)}`);
    near(tweenPose(from, to, 1).yaw, b, `yaw ${a} → ${b}: t=1 lands on to.yaw exactly`, 0);
  }
}

console.log(`\ncamera: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
