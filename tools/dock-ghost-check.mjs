// dock-ghost-check.mjs — spotlighting a docked tile leaves a placeholder in its held-open slot.
//
// The "nice-dock" affordance: when a tile is raised into the focus area, its bar slot stays
// RESERVED (the neighbors don't resettle) and a ghost outline stands in for it, so the lift-out
// reads as "this lives here; it returns here". On return/dismiss the slot is still open and the
// grid drops straight back into it.
//
// Headline assertion: a focused tile's NEIGHBORS keep their positions (slot reserved, no re-pack).
// Real dock + real three (no relay/browser).
//
//   bun tools/dock-ghost-check.mjs

import * as THREE from 'three';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

function mockWindow() {
  const g = new THREE.Object3D();
  g.getBounds = () => new THREE.Box3(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 0));
  g.cols = 80; g.rows = 24;
  g.onResize = () => () => {};
  return g;
}
const camera = { fov: 70, aspect: 1.6, quaternion: new THREE.Quaternion(), position: new THREE.Vector3() };
const settle = (dock) => { for (let i = 0; i < 4; i++) dock.update(0.2, camera); };
const posOf = (g) => ({ x: g.position.x, y: g.position.y, z: g.position.z });

const scene = new THREE.Scene();
const dock = new CameraDock({ attentionManager: { docks: new Map() } });
scene.add(dock);
dock.update(0.016, camera); // prime _viewH from the camera BEFORE locking, so lock-time layout is final

const g1 = mockWindow(), g2 = mockWindow(), g3 = mockWindow();
scene.add(g1, g2, g3);
dock.lock('t1', g1); dock.lock('t2', g2); dock.lock('t3', g3);
settle(dock);
ok(dock._ghost === null || !dock._ghost.box.visible, 'precondition: nothing focused → no placeholder');

// Record the neighbors' resting positions BEFORE focusing.
const before2 = posOf(g2), before3 = posOf(g3);

// ---- spotlight t1 → ghost appears, neighbors hold ----
ok(dock.spotlight('t1') === 'spotlit', 'spotlight: returns spotlit');
ok(dock.focusedId === 't1', 'spotlight: t1 is focused');
ok(dock._ghost && dock._ghost.box.visible, 'spotlight: placeholder is shown');
settle(dock);

const after2 = posOf(g2), after3 = posOf(g3);
ok(near(after2.x, before2.x) && near(after2.y, before2.y) && near(after2.z, before2.z),
   'RESERVED SLOT: neighbor t2 did not shift when t1 lifted out');
ok(near(after3.x, before3.x) && near(after3.y, before3.y) && near(after3.z, before3.z),
   'RESERVED SLOT: neighbor t3 did not shift either');

// The placeholder outline got sized to a real slot box (positive w/h) and parked at a finite spot.
const gbox = dock._ghost.box;
ok(gbox.scale.x > 0 && gbox.scale.y > 0, 'ghost: outline scaled to a slot box');
ok(Number.isFinite(gbox.position.x) && Number.isFinite(gbox.position.y) && Number.isFinite(gbox.position.z),
   'ghost: outline parked at a finite slot position');

// t1 is pulled toward the eye (focus sits nearer than the bar in dock-local +z).
ok(g1.position.z > g2.position.z + 0.5, 'spotlight: focused tile is raised toward the eye');

// The outline breathes: opacity moves over time and stays within [0, ghostOpacity].
dock.update(0.5, camera);
const o1 = dock._ghost.boxMat.opacity;
dock.update(0.6, camera);
const o2 = dock._ghost.boxMat.opacity;
ok(!near(o1, o2, 1e-4), 'ghost: outline opacity breathes over time');
ok(o1 >= 0 && o1 <= dock.ghostOpacity + 1e-6 && o2 >= 0 && o2 <= dock.ghostOpacity + 1e-6,
   'ghost: breathe stays within [0, ghostOpacity]');

// ---- return: spotlight t1 again → placeholder hides, tile drops back into its slot ----
ok(dock.spotlight('t1') === 'returned', 'spotlight(again): returns returned');
ok(dock.focusedId === null, 'return: nothing focused');
settle(dock);
ok(!dock._ghost.box.visible, 'return: placeholder hidden');
ok(near(g1.position.z, g2.position.z, 0.5), 'return: t1 dropped back to bar depth (its reserved slot)');

// ---- dismiss while focused → placeholder hides, tile gone ----
dock.spotlight('t1');
settle(dock);
ok(dock._ghost.box.visible, 'precondition: focused again, placeholder up');
ok(dock.dismiss('t1') === true, 'dismiss(focused): returns true');
ok(!dock.has('t1'), 'dismiss: entry dropped');
ok(!dock._ghost.box.visible, 'dismiss(focused): placeholder hidden');

console.log(failures === 0 ? '\nPASS — focus placeholder: reserved slot + breathing outline, clean across spotlight/return/dismiss'
                           : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
