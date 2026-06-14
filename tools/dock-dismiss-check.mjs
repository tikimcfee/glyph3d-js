// dock-dismiss-check.mjs — closing a docked window cascades to the dock cleanly.
// A docked grid's parent is the CameraDock node, so the grid's own dispose() (scene.remove(this))
// can't lift it out — it left an orphan the dock kept animating, and the dock kept a DockEntry to
// a dead grid (haywire). dismiss() is the clean-removal counterpart to release(): drop the entry,
// clear focus, lift the orphan, re-pack. pruneDismissed() runs it for any tile whose window is no
// longer live, driven by the registry's removal event — so ANY close path cascades. Real dock +
// real three (no relay/browser).
//
//   bun tools/dock-dismiss-check.mjs

import * as THREE from 'three';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import { AttentionManager } from '../packages/glyph3d-core/src/services/interaction/AttentionManager.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// A minimal window: a real Object3D (so attach/remove/getWorldPosition work) + the few extras
// CameraDock.lock reads (getBounds, cols/rows, onResize).
function mockWindow() {
  const g = new THREE.Object3D();
  g.getBounds = () => new THREE.Box3(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 0));
  g.cols = 80; g.rows = 24;
  g.onResize = () => () => {}; // subscribe → returns an unsubscribe fn
  return g;
}

const scene = new THREE.Scene();
const dock = new CameraDock({ attentionManager: { docks: new Map() } });
scene.add(dock);

const g1 = mockWindow(), g2 = mockWindow();
scene.add(g1); scene.add(g2);
dock.lock('t1', g1);
dock.lock('t2', g2);
ok(dock.has('t1') && dock.has('t2'), 'precondition: two windows docked');
ok(g1.parent === dock, 'precondition: a docked grid is reparented into the bar');

dock.spotlight('t1');
ok(dock.focusedId === 't1', 'precondition: t1 is the focused (spotlit) tile');

// ---- close the FOCUSED docked window → dismiss cascades ----
ok(dock.dismiss('t1') === true, 'dismiss(focused): returns true');
ok(!dock.has('t1'), 'dismiss: entry dropped');
ok(dock.focusedId === null, 'dismiss(focused): focus cleared');
ok(g1.parent !== dock, 'dismiss: orphan lifted out of the bar (no dead child left animating)');
ok(!dock.attentionManager.docks.has('t1'), 'dismiss: AttentionManager.docks entry dropped');
ok(!dock.tiles.has(g1), 'dismiss: removed from the camera-speed tiles set');
ok(dock.has('t2'), 'dismiss: the sibling tile is untouched');

// ---- pruneDismissed: t2's window is no longer live (closed any which way) ----
dock.pruneDismissed((id) => id !== 't2'); // t2 reports not-live → dismissed; nothing else docked
ok(!dock.has('t2'), 'pruneDismissed: dismissed the tile whose window vanished');
ok(g2.parent !== dock, 'pruneDismissed: that orphan lifted too');

// ---- pruneDismissed keeps live tiles ----
const g3 = mockWindow(); scene.add(g3); dock.lock('t3', g3);
dock.pruneDismissed((id) => true); // everything live → nothing dismissed
ok(dock.has('t3'), 'pruneDismissed: a still-live tile is kept');

// ---- attention releases a focused window when it's removed (the "can't interact" half) ----
{
  const am = new AttentionManager();
  am.set('primary', 'term-x');
  am.set('key', 'term-x');
  am.set('hover', 'other');
  ok(am.get('primary')?.id === 'term-x' && am.get('key')?.id === 'term-x', 'precondition: term-x is the focus + keystroke target');
  // term-x is closed (unregistered) — everything else still live
  am.pruneGone((id) => id !== 'term-x');
  ok(am.get('primary') === null, 'pruneGone: focus released from the closed window');
  ok(am.get('key') === null, 'pruneGone: keystroke target released (input no longer routes to a corpse)');
  ok(am.get('hover')?.id === 'other', 'pruneGone: a slot pointing at a live entity is kept');
}

console.log(failures === 0 ? '\nPASS — close cascades to dock + attention (dismiss + prune)' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
