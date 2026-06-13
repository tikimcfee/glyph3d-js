// dock-refresh-check.mjs — deterministic check of CameraDock.refreshTile: the dock
// reacting to a docked tile changing size (the live grip-resize / terminal.resize
// interplay). CameraDock is pure three math, so this needs no browser/relay.
// Verifies: cell metrics are constant so naturalH/centerOffset scale by the col/row
// ratio; a BAR tile re-packs (_relayout), a FOCUSED tile free-grows in place
// (_animateTile at its current scale, centered); and the grid.onResize tap is wired
// on lock and dropped on release.
//
//   bun tools/dock-refresh-check.mjs
//
// Graduated from a one-off probe per the debug-into-tools practice. Sibling of
// dock-persist-check.mjs.

import { CameraDock } from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; else pass++; };

// Fake grid: the bits CameraDock touches, plus an onResize tap we can fire.
function fakeGrid(cols, rows) {
  let resizeCb = null;
  return {
    cols, rows,
    position: { x: 0, y: 0, z: 0 },
    scale: { x: 0.1, y: 0.1, z: 0.1 },
    quaternion: { clone: () => ({}) },
    parent: null,
    onResize(cb) { resizeCb = cb; return () => { resizeCb = null; }; },
    _fireResize(c, r) { this.cols = c; this.rows = r; resizeCb?.(c, r); },
    _resizeCb: () => resizeCb,
  };
}

// ---- ratio scaling + bar-vs-focus branch ----------------------------------
const dock = new CameraDock({ attentionManager: { docks: new Map() } });
dock.attach = () => {}; // no real scene graph

const g = fakeGrid(80, 24);
const e = {
  id: 't1', grid: g, homeParent: null,
  home: { pos: { x: 0, y: 0, z: 0 }, scale: 0.1, quat: {} },
  naturalH: 100, centerOffset: { x: 50, y: -50, z: 0 },
  dims: { cols: 80, rows: 24 }, unsubscribeResize: null,
  homeBounds: null, slot: 0,
  quatTarget: { setFromUnitVectors() {}, identity() {}, copy() {} },
};
dock.entries.set('t1', e);

let animCalls = [], relayoutCalls = 0;
dock._animateTile = (...a) => animCalls.push(a);
dock._relayout = () => { relayoutCalls++; };

// BAR tile: ratio-scaled (2× cols, 2× rows), re-packs via _relayout.
dock.refreshTile('t1', 160, 48);
ok(Math.abs(e.naturalH - 200) < 1e-6, `bar naturalH 100→200 (got ${e.naturalH})`);
ok(Math.abs(e.centerOffset.x - 100) < 1e-6, `bar centerOffset.x 50→100 (got ${e.centerOffset.x})`);
ok(Math.abs(e.centerOffset.y + 100) < 1e-6, `bar centerOffset.y -50→-100 (got ${e.centerOffset.y})`);
ok(e.dims.cols === 160 && e.dims.rows === 48, `bar dims updated`);
ok(relayoutCalls === 1, `bar resize triggers _relayout (got ${relayoutCalls})`);
ok(animCalls.length === 0, `bar resize does not _animateTile directly`);

// FOCUSED tile: free-grow — re-centered at current scale, no _relayout.
dock.focusedId = 't1';
animCalls = []; relayoutCalls = 0;
dock.refreshTile('t1', 80, 24); // back to 80×24 (0.5×)
ok(Math.abs(e.naturalH - 100) < 1e-6, `focus naturalH 200→100 (got ${e.naturalH})`);
ok(relayoutCalls === 0, `focus resize does not _relayout (got ${relayoutCalls})`);
ok(animCalls.length === 1, `focus resize re-centers via _animateTile (got ${animCalls.length})`);
ok(animCalls[0]?.[1] === 0, `focus tile centered at x=0 (got ${animCalls[0]?.[1]})`);
ok(Math.abs((animCalls[0]?.[4] ?? 0) - 0.1) < 1e-6, `focus keeps current scale 0.1 (got ${animCalls[0]?.[4]})`);

// ---- onResize tap lifecycle (lock subscribes, release drops) --------------
const dock2 = new CameraDock({ attentionManager: { docks: new Map() } });
dock2.attach = () => {};
dock2._relayout = () => {};
const g2 = fakeGrid(80, 24);
g2.getBounds = () => ({ isEmpty: () => false, max: { y: 10 }, min: { y: 0 }, getCenter: (v) => { v.x = 5; v.y = -5; v.z = 0; return v; }, clone() { return this; } });
g2.getWorldPosition = (v) => { v.x = 0; v.y = 0; v.z = 0; return v; };
dock2.lock('t2', g2);
ok(typeof g2._resizeCb() === 'function', `lock subscribes to grid.onResize`);
let refreshed = 0; const orig = dock2.refreshTile.bind(dock2);
dock2.refreshTile = (...a) => { refreshed++; return orig(...a); };
g2._fireResize(100, 30);
ok(refreshed === 1, `grid resize fires dock.refreshTile (got ${refreshed})`);
dock2.release('t2');
ok(g2._resizeCb() === null, `release unsubscribes the resize tap`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
