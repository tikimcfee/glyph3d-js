// camera-billboard-check.mjs — headless lock for the REVERSE-BILLBOARD focus.
//
// Focus used to fly straight down +Z and frame a world AABB. A rotated grid (jellyfish files,
// angled cards) then read as a foreshortened SLIVER — its AABB is a fat box but the content plane
// is edge-on. _planeOf + _billboardPose now square the camera to the object's OWN front face
// (local +Z), framing its TRUE width/height. The invariant under test, for ANY orientation:
//   camera forward (rebuilt from the pose's pitch/yaw, YXZ) == -plane.normal, camera in front.
// Plus: axis-aligned focus still matches the old head-on formula (regression), and the sliver
// case frames the true width (not the collapsed AABB).
//
//   bun tools/camera-billboard-check.mjs
//
// Drives the REAL controller methods via the prototype (Object.create skips the ctor, which wants
// a canvas), with a stubbed flyTo capturing the pose. Per the debug-into-tools practice.

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import { zDistanceForFit } from '../packages/glyph3d-core/src/services/spatial/spatialMath.js';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (c) pass++; else fail++; };
const near = (a, b, m, eps = 1e-4) => ok(Math.abs(a - b) <= eps, `${m} (got ${a.toFixed(4)} want ${b.toFixed(4)})`);

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
const vec = (p) => new THREE.Vector3(p.x, p.y, p.z);

let grids = [];
function makeCC() {
  const cc = Object.create(ViewerCameraController.prototype);
  cc.THREE = THREE;
  cc.ctx = { camera, getGrids: () => grids };
  cc.captured = null;
  cc.flyTo = (to) => { cc.captured = to; };
  return cc;
}

// A real Object3D so getWorldQuaternion/Scale/localToWorld are the genuine THREE math. Top-left
// anchored local bounds (x∈[0,w], y∈[-h,0]) like the real grids; oriented with the camera's YXZ.
function makeGrid({ pos = [0, 0, 0], yaw = 0, pitch = 0, scale = 1, w = 80, h = 24, lines = 24 } = {}) {
  const g = new THREE.Object3D();
  g.position.set(pos[0], pos[1], pos[2]);
  g.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  g.scale.setScalar(scale);
  g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -h, -0.05), new THREE.Vector3(w, 0, 0.05));
  g.lines = new Array(lines);
  g.getBounds = () => { g.updateWorldMatrix(true, false); return g.getLocalBounds().clone().applyMatrix4(g.matrixWorld); };
  g.updateMatrixWorld(true);
  return g;
}

// The core invariant: rebuild the camera's forward from the pose (the SAME YXZ _applyRotation uses)
// and assert it's anti-parallel to the plane normal, with the camera on the front side.
function assertSquared(cc, g, label, { centerAim = false } = {}) {
  const plane = cc._planeOf(g);
  const camPos = vec(cc.captured.position);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(cc.captured.pitch, cc.captured.yaw, 0, 'YXZ'));
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  near(fwd.dot(plane.normal), -1, `${label}: camera forward == -normal (squared to the face)`);
  ok(camPos.clone().sub(plane.center).dot(plane.normal) > 0, `${label}: camera sits in FRONT of the face`);
  if (centerAim) near(plane.center.clone().sub(camPos).normalize().dot(plane.normal), -1, `${label}: aims dead at the center`);
}

// ---- A. focusOnObject squares to a yaw-rotated face (45°) -------------------------------
{
  const cc = makeCC(); const g = makeGrid({ yaw: Math.PI / 4, pos: [10, 5, -3], scale: 2 });
  cc.focusOnObject(g);
  assertSquared(cc, g, 'yaw45', { centerAim: true });
  near(cc.captured.yaw, Math.PI / 4, 'yaw45: pose.yaw is the face azimuth');
  near(cc.captured.pitch, 0, 'yaw45: pose.pitch is level');
}

// ---- B. the SLIVER fix: an 80°-yaw grid frames its TRUE width, not the collapsed AABB ----
{
  const cc = makeCC(); const g = makeGrid({ yaw: (80 * Math.PI) / 180, w: 120, h: 30, scale: 1.5 });
  cc.focusOnObject(g);
  assertSquared(cc, g, 'sliver80', { centerAim: true });
  const plane = cc._planeOf(g);
  const along = vec(cc.captured.position).sub(plane.center).length();
  const want = Math.max(zDistanceForFit(camera, plane.width, plane.height, 0.85), 5) + plane.depth / 2;
  near(along, want, 'sliver80: distance fits the TRUE plane width (not the AABB sliver)', 1e-3);
}

// ---- C. focusOnObject squares to a PITCHED face (20° about X) ----------------------------
{
  const cc = makeCC(); const g = makeGrid({ pitch: (20 * Math.PI) / 180, pos: [0, 40, 0] });
  cc.focusOnObject(g);
  assertSquared(cc, g, 'pitch20', { centerAim: true });
}

// ---- D. computeGridFocus: axis-aligned still matches the OLD head-on formula (regression) ----
{
  const cc = makeCC(); const g = makeGrid({ w: 80, h: 24, lines: 24, pos: [5, 10, 3] });
  grids = [g];
  const p = cc.computeGridFocus(0);
  const dist = Math.max(zDistanceForFit(camera, 80, 24, 0.85), 5);
  const halfTan = Math.tan((camera.fov * Math.PI / 180) / 2);
  // world center (top-left anchored local center (40,-12,0) → +pos), top edge, head-anchor.
  const cy = (10 - 12), topY = cy + 12, maxZ = 3 + 0.05;
  near(p.pitch, 0, 'axis-aligned: pitch 0'); near(p.yaw, 0, 'axis-aligned: yaw 0');
  near(p.x, 5 + 40, 'axis-aligned: centerX'); near(p.z, maxZ + dist, 'axis-aligned: z = front face + dist');
  near(p.y, topY - dist * halfTan * (1 - 2 * 0.08), 'axis-aligned: y top-anchored (reads from the head)', 1e-3);
}

// ---- E. computeGridFocus on a ROTATED grid squares to it (top-anchored, so only fwd==-normal) ----
{
  const cc = makeCC(); const g = makeGrid({ yaw: Math.PI / 6, w: 80, h: 120, lines: 120 });
  grids = [g];
  const p = cc.computeGridFocus(0);
  cc.captured = { position: { x: p.x, y: p.y, z: p.z }, pitch: p.pitch, yaw: p.yaw };
  assertSquared(cc, g, 'gridFocus yaw30');
}

// ---- F. focusOnBox is orientation-FREE: head-on down +Z (dock.focus path, regression) ----
{
  const cc = makeCC();
  const box = new THREE.Box3(new THREE.Vector3(-10, -10, -2), new THREE.Vector3(10, 10, 2));
  cc.focusOnBox(box);
  near(cc.captured.pitch, 0, 'focusOnBox: pitch 0'); near(cc.captured.yaw, 0, 'focusOnBox: yaw 0');
  const dist = Math.max(zDistanceForFit(camera, 20, 20, 0.85), 5);
  near(cc.captured.position.z, 2 + dist, 'focusOnBox: z = box front face + dist');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
