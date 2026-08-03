// place-in-view-check.mjs — placeInView is PLACEABLE-gated, not terminal-gated.
//
// `ViewerCameraController.placeInView` sets a framed surface down on the view axis without moving
// the camera (terminal.create uses it so a new terminal lands where you are looking). Its docstring
// always said "grid / terminal", but its gate required `setWorldPosition` — a method only
// TerminalGrid and FrameGrid ever had, and which by then was a pure alias for `position.set`. So a
// CodeGrid was refused for a reason that had nothing to do with placing it. The alias is deleted;
// the gate is now the real capability: MEASURABLE (getBounds) + MOVABLE (position).
//
// The second invariant here is parent-space. The placement math is world-space, but `.position` is
// parent-LOCAL. Terminals are scene-parented so the two coincide and the old code got away with it;
// a tree-resident code grid is not, and a world value written into a local slot lands the grid at
// its parent's offset. Same law window.drop's loose path already obeys.
//
//   bun tools/place-in-view-check.mjs

import * as THREE from 'three';

globalThis.window ??= { addEventListener() {} };
const { ViewerCameraController } =
  await import('../packages/glyph3d-core/src/services/camera/ViewerCameraController.js');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m} (got ${a.toFixed(3)}, want ~${b.toFixed(3)})`);

/** A framed surface with bounds derived from its own transform — no GPU, no subclass. */
function makeSurface(w = 20, h = 12) {
  const o = new THREE.Object3D();
  o.getBounds = (target = new THREE.Box3()) => {
    o.updateWorldMatrix(true, false);
    return target.set(new THREE.Vector3(0, -h, 0), new THREE.Vector3(w, 0, 0)).applyMatrix4(o.matrixWorld);
  };
  return o;
}

function makeController(camera) {
  const vcc = Object.create(ViewerCameraController.prototype);
  vcc.THREE = THREE;
  vcc.ctx = { camera };
  return vcc;
}

function makeCamera() {
  const cam = new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);
  cam.position.set(0, 0, 0);
  cam.quaternion.identity();          // looking down -Z
  cam.updateMatrixWorld();
  return cam;
}

// ---- 1. a surface with NO setWorldPosition places (the un-blocking) ----
{
  const cam = makeCamera();
  const scene = new THREE.Scene();
  const g = makeSurface();
  scene.add(g);
  ok(typeof g.setWorldPosition !== 'function', 'the surface has no setWorldPosition (nothing does now)');

  const placed = makeController(cam).placeInView(g);
  ok(placed === true, 'placeInView accepts a plain measurable+movable surface');

  const b = g.getBounds(new THREE.Box3());
  const c = b.getCenter(new THREE.Vector3());
  near(c.x, 0, 1e-6, 'content center lands on the view axis (x)');
  near(c.y, 0, 1e-6, 'content center lands on the view axis (y)');
  ok(c.z < 0, 'content sits AHEAD of the camera, down its forward ray');
}

// ---- 2. the gate refuses what it cannot measure or cannot move ----
{
  const cam = makeCamera();
  const vcc = makeController(cam);
  const noBounds = new THREE.Object3D();
  ok(vcc.placeInView(noBounds) === false, 'refuses a surface with no getBounds (not measurable)');
  ok(vcc.placeInView({ getBounds: () => new THREE.Box3() }) === false, 'refuses a bag with no position (not movable)');
  ok(vcc.placeInView(null) === false, 'refuses nothing at all');

  const empty = new THREE.Object3D();
  empty.getBounds = () => new THREE.Box3();   // empty box — nothing to fit
  ok(vcc.placeInView(empty) === false, 'refuses an empty bounds (no footprint to fit)');
}

// ---- 3. a PARENTED surface lands in world space, not at its parent's offset ----
// The regression the old code could not have: terminals are scene-parented, so world == local and
// the bug was invisible. A tree-resident grid makes it visible.
{
  const cam = makeCamera();
  const scene = new THREE.Scene();
  const dir = new THREE.Object3D();
  dir.position.set(500, -300, 900);          // a ContentTree dir node, far from the origin
  scene.add(dir);
  const g = makeSurface();
  dir.add(g);
  scene.updateMatrixWorld(true);

  ok(makeController(cam).placeInView(g) === true, 'a parented surface places');

  scene.updateMatrixWorld(true);
  const c = g.getBounds(new THREE.Box3()).getCenter(new THREE.Vector3());
  near(c.x, 0, 1e-6, 'parented: content center still lands on the view axis (x)');
  near(c.y, 0, 1e-6, 'parented: content center still lands on the view axis (y)');
  ok(c.z < 0, 'parented: content still sits ahead of the camera');
  ok(g.parent === dir, 'placing does not reparent — residence is untouched');
}

// ---- 4. fill drives distance: a bigger fill sits the surface CLOSER ----
{
  const scene = new THREE.Scene();
  const zAt = (fill) => {
    const cam = makeCamera();
    const g = makeSurface();
    scene.add(g);
    makeController(cam).placeInView(g, { fill });
    scene.updateMatrixWorld(true);
    return g.getBounds(new THREE.Box3()).getCenter(new THREE.Vector3()).z;
  };
  ok(zAt(0.9) > zAt(0.3), 'a larger fill fraction places the surface nearer the eye');
}

console.log(failures === 0
  ? '\nPASS — placeInView gates on measurable+movable, and respects parent space'
  : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures ? 1 : 0);
