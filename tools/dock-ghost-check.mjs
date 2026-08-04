// dock-ghost-check.mjs — framing a docked tile leaves a placeholder in its held-open bar slot.
//
// The "nice-dock" affordance: when a window lifts into the view-frame (spotlight/pin, or a
// splitPane), its bar slot stays RESERVED (the neighbors don't resettle) and a ghost outline in
// the window's identity hue stands in for it, so the lift-out reads as "this lives here; it
// returns here". On return/release/dismiss the slot is still open and the grid drops straight
// back into it.
//
// Headline assertion: a framed tile's NEIGHBORS keep their positions (slot reserved, no re-pack) —
// including under MULTI-PANE frames, where each framed window holds its own slot with its own
// ghost. Real dock + real three (no relay/browser).
//
//   bun tools/dock-ghost-check.mjs

import './headless-canvas.mjs';
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
const same = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z);

const scene = new THREE.Scene();
const dock = new CameraDock({ attentionManager: { docks: new Map() } });
scene.add(dock);
dock.update(0.016, camera); // prime _viewH from the camera BEFORE locking, so lock-time layout is final

const g1 = mockWindow(), g2 = mockWindow(), g3 = mockWindow();
scene.add(g1, g2, g3);
dock.lock('t1', g1); dock.lock('t2', g2); dock.lock('t3', g3);
settle(dock);
ok(dock._ghosts.size === 0, 'precondition: nothing framed → no placeholders');

// Record the neighbors' resting positions BEFORE framing anything.
const before2 = posOf(g2), before3 = posOf(g3);

// ---- spotlight t1 → ghost appears, neighbors hold ----
ok(dock.spotlight('t1') === 'spotlit', 'spotlight: returns spotlit');
ok(dock.isFramed('t1'), 'spotlight: t1 is framed');
ok(dock._ghosts.has('t1'), 'spotlight: placeholder stands in t1\'s slot');
settle(dock);

ok(same(posOf(g2), before2), 'RESERVED SLOT: neighbor t2 did not shift when t1 lifted out');
ok(same(posOf(g3), before3), 'RESERVED SLOT: neighbor t3 did not shift either');

// Slots stay UNIQUE + dense over ALL entries — a framed window keeps its bar label.
const slots = dock.list().map((e) => e.slot).sort((a, b) => a - b);
ok(slots.join(',') === '0,1,2', 'slots: dense 0..n-1 over ALL entries, framed included');

// The placeholder outline got sized to a real slot box, parked finite, wearing t1's identity hue.
const ghost1 = dock._ghosts.get('t1');
ok(ghost1.box.scale.x > 0 && ghost1.box.scale.y > 0, 'ghost: outline scaled to a slot box');
ok(Number.isFinite(ghost1.box.position.x) && Number.isFinite(ghost1.box.position.y) && Number.isFinite(ghost1.box.position.z),
   'ghost: outline parked at a finite slot position');
ok(ghost1.mat.color.getHex() === dock.entries.get('t1').identityColor,
   'ghost: outline wears the window\'s identity hue');

// t1 is pulled toward the eye (the frame sits nearer than the bar in dock-local +z).
ok(g1.position.z > g2.position.z + 0.5, 'spotlight: framed tile is pulled toward the eye');

// The outline breathes: opacity moves over time and stays within [0, ghostOpacity].
dock.update(0.5, camera);
const o1 = ghost1.mat.opacity;
dock.update(0.6, camera);
const o2 = ghost1.mat.opacity;
ok(!near(o1, o2, 1e-4), 'ghost: outline opacity breathes over time');
ok(o1 >= 0 && o1 <= dock.ghostOpacity + 1e-6 && o2 >= 0 && o2 <= dock.ghostOpacity + 1e-6,
   'ghost: breathe stays within [0, ghostOpacity]');

// ghostPulseHz is live-tunable; 0 = steady (the breathe freezes, the outline stays).
ok(dock.setParam('ghostPulseHz', 0) === true, 'setParam: ghostPulseHz accepted');
dock.update(0.3, camera);
const s1 = ghost1.mat.opacity;
dock.update(0.4, camera);
ok(near(s1, ghost1.mat.opacity, 1e-6), 'ghost: pulse 0 → steady opacity');
dock.setParam('ghostPulseHz', 0.5);

// ---- multi-pane: split t2 into the frame → second ghost, last neighbor still holds ----
ok(dock.splitPane('x', 't2') === true, 'splitPane: t2 tiles into the frame');
settle(dock);
ok(dock._ghosts.size === 2 && dock._ghosts.has('t2'), 'splitPane: each framed window holds its own slot ghost');
ok(same(posOf(g3), before3), 'RESERVED SLOT: t3 still did not shift under a multi-pane frame');
ok(dock._ghosts.get('t2').mat.color.getHex() === dock.entries.get('t2').identityColor,
   'splitPane: second ghost wears t2\'s hue');

// ---- unframe t2 → its ghost sweeps, it drops back into its own reserved slot ----
ok(dock.unframePane('t2') === true, 'unframePane: t2 returns to the bar');
settle(dock);
ok(dock._ghosts.size === 1 && !dock._ghosts.has('t2'), 'unframe: t2\'s placeholder swept');
ok(same(posOf(g2), before2), 'return: t2 dropped back into its own reserved slot');

// ---- return: spotlight t1 again → placeholder sweeps, tile drops back into its slot ----
ok(dock.spotlight('t1') === 'returned', 'spotlight(again): returns returned');
ok(dock.paneTree === null, 'return: nothing framed');
settle(dock);
ok(dock._ghosts.size === 0, 'return: no placeholders left');
ok(near(g1.position.z, g2.position.z, 0.5), 'return: t1 dropped back to bar depth (its reserved slot)');

// ---- dismiss while framed → placeholder sweeps, tile gone ----
dock.spotlight('t1');
settle(dock);
ok(dock._ghosts.has('t1'), 'precondition: framed again, placeholder up');
ok(dock.dismiss('t1') === true, 'dismiss(framed): returns true');
ok(!dock.has('t1'), 'dismiss: entry dropped');
ok(dock._ghosts.size === 0, 'dismiss(framed): placeholder swept');

console.log(failures === 0 ? '\nPASS — slot placeholder: reserved slot + breathing identity-hue outline, clean across spotlight/split/unframe/return/dismiss'
                           : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
