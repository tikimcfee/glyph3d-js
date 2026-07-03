// dock-border-check.mjs — each docked window wears a distinct identity hue on its in-shader panel
// border (the "which rectangle is which" color link), cleared on release.
//
// The dock assigns each locked window a golden-angle palette color (entry.identityColor), paints it
// onto the window via grid.setBorder({color,strength}), and sets the DOCKED flag bit. release()
// clears the bit. This checks the wiring end to end against a mock window that records its setBorder
// calls — the shader pixels themselves are verified live in the dev loop.
//
//   bun tools/dock-border-check.mjs

import * as THREE from 'three';
import CameraDock from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import { BORDER_FLAGS } from '../packages/glyph3d-core/src/collections/panelMaterial.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// A window that records its border identity (color/width/intensity) + its flag bit-set.
function mockWindow() {
  const g = new THREE.Object3D();
  g.getBounds = () => new THREE.Box3(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 0));
  g.cols = 80; g.rows = 24;
  g.onResize = () => () => {};
  g.border = null;
  g.flags = 0;
  g.setBorder = (style) => { g.border = { ...(g.border || {}), ...style }; };
  g.setBorderFlag = (mask, on) => { g.flags = on ? (g.flags | mask) : (g.flags & ~mask); };
  return g;
}
const camera = { fov: 70, aspect: 1.6, quaternion: new THREE.Quaternion(), position: new THREE.Vector3() };

const dock = new CameraDock({ attentionManager: { docks: new Map() } });
new THREE.Scene().add(dock);
dock.update(0.016, camera);

const g1 = mockWindow(), g2 = mockWindow(), g3 = mockWindow();
dock.lock('t1', g1); dock.lock('t2', g2); dock.lock('t3', g3);

// ---- each docked window got its DOCKED bit set + identity painted, at the dock's width/intensity ----
ok(g1.border && (g1.flags & BORDER_FLAGS.DOCKED) !== 0, 'lock: t1 DOCKED bit set + identity painted');
ok((g2.flags & BORDER_FLAGS.DOCKED) !== 0 && (g3.flags & BORDER_FLAGS.DOCKED) !== 0, 'lock: t2 + t3 DOCKED too');
ok(g1.border.width === dock.borderWidth, 'lock: border width = dock.borderWidth');
ok(g1.border.intensity === dock.borderStrength, 'lock: border intensity = dock.borderStrength');

// ---- the three hues are DISTINCT (golden-angle spread) and match each entry's identityColor ----
const c1 = g1.border.color, c2 = g2.border.color, c3 = g3.border.color;
ok(c1 !== c2 && c2 !== c3 && c1 !== c3, 'lock: three windows got three distinct hues');
ok(c1 === dock.entries.get('t1').identityColor, 'lock: painted hue = the entry identity color');

// ---- release clears the DOCKED bit (window leaves the bar → drops its dock identity) ----
dock.release('t1');
ok((g1.flags & BORDER_FLAGS.DOCKED) === 0, 'release: DOCKED bit cleared');

// ---- a NEW lock after a release keeps cycling (no immediate hue collision with survivors) ----
const g4 = mockWindow();
dock.lock('t4', g4);
ok(g4.border.color !== g2.border.color && g4.border.color !== g3.border.color,
   'relock: new window hue differs from the still-docked survivors');

console.log(failures === 0 ? '\nPASS — per-window identity border (golden-angle), cleared on release'
                           : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
