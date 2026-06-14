// dock-refresh-check.mjs — deterministic check of CameraDock.refreshTile: the dock
// reacting to a docked tile changing size (the live grip-resize / terminal.resize
// interplay). CameraDock is pure three math, so this needs no browser/relay.
// Verifies: cell metrics are constant so naturalH/centerOffset scale by the col/row
// ratio; a BAR tile re-packs (_relayout), a FOCUSED tile free-grows by RECORDING the
// grown size as intent (focusHeightFrac ∝ rows) and re-placing from it via _placeFocus —
// never reading the rendered grid.scale.x back as truth; that intent survives a focus
// toggle (the no-snap regression); and the grid.onResize tap is wired on lock / dropped
// on release.
//
//   bun tools/dock-refresh-check.mjs
//
// Graduated from a one-off probe per the debug-into-tools practice. Sibling of
// dock-persist-check.mjs.

import * as THREE from 'three';
import { CameraDock } from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import { ScaleModel } from '../packages/glyph3d-core/src/collections/ScaleModel.js';

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
  naturalH: 100, focusHeightFrac: null, centerOffset: { x: 50, y: -50, z: 0 },
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

// FOCUSED tile: free-grow is RECORDED as intent (focusHeightFrac ∝ rows), then re-placed
// from that intent via _placeFocus — never from the live grid.scale.x. No _relayout.
dock.focusedId = 't1';
e.focusHeightFrac = null;        // fresh tile: follows the global focusFrac until grown
animCalls = []; relayoutCalls = 0;
dock.refreshTile('t1', 80, 24);  // 160×48 → 80×24 (rows ×0.5)
ok(Math.abs(e.naturalH - 100) < 1e-6, `focus naturalH 200→100 (got ${e.naturalH})`);
ok(relayoutCalls === 0, `focus resize does not _relayout (got ${relayoutCalls})`);
ok(animCalls.length === 1, `focus resize re-places via _animateTile (got ${animCalls.length})`);
ok(animCalls[0]?.[1] === 0, `focus tile centered at x=0 (got ${animCalls[0]?.[1]})`);
ok(Math.abs((e.focusHeightFrac ?? 0) - dock.focusFrac * 0.5) < 1e-9,
   `focus resize records free-grow into focusHeightFrac ∝ rows (got ${e.focusHeightFrac})`);
// eff is DERIVED from the tracked intent — (viewH·focusHeightFrac/naturalH)·focusDistFrac·user —
// not the rendered scale; that purity over intent is what kills the focus-toggle snap.
const wantEff = (dock._viewH * e.focusHeightFrac / e.naturalH) * dock.focusDistFrac;
ok(Math.abs((animCalls[0]?.[4] ?? 0) - wantEff) < 1e-9,
   `focus eff derived from intent, not grid.scale.x (got ${animCalls[0]?.[4]}, want ${wantEff})`);

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

// ---- no-snap round-trip: the resize→scale coupling regression -------------
// The real bug: resize a docked+focused tile, then toggle focus, and it used to JUMP by the
// resize ratio — because free-grow left the grown size implicit in grid.scale.x and the next
// spotlight re-derived focusFrac instead. Drive the REAL _animateTile + animator + ScaleModel
// (the stubbed sections above can't catch it — grid.scale.x never moves under a stub) and assert
// the focused on-screen size is identical before defocus and after refocus.
function realGrid(cols, rows, localH, localHalfW) {
  const sm = new ScaleModel(1);
  const g = new THREE.Object3D();
  g.cols = cols; g.rows = rows; g.scaleModel = sm; g._cb = null;
  g.onResize = (cb) => { g._cb = cb; return () => { g._cb = null; }; };
  g.setZoom = (f) => { sm.setZoom(f); sm.resolve(g); };
  Object.defineProperty(g, 'zoom', { get: () => sm.zoomScalar });
  g.getBounds = () => {
    g.updateWorldMatrix(true, false);
    const s = g.scale.x; const p = g.getWorldPosition(new THREE.Vector3());
    const hw = localHalfW * s, hh = (localH * 0.5) * s;
    return new THREE.Box3(new THREE.Vector3(p.x - hw, p.y - hh, -1), new THREE.Vector3(p.x + hw, p.y + hh, 1));
  };
  g.fireResize = (c, r) => { g.cols = c; g.rows = r; g._cb?.(c, r); };
  sm.resolve(g);
  return g;
}
{
  const d = new CameraDock({ attentionManager: { docks: new Map() }, layout: 'linear' });
  new THREE.Scene().add(d);
  const settle = () => { for (let i = 0; i < 5; i++) d.animator.update(10); };
  const rg = realGrid(80, 24, 24, 40);
  d.lock('rg', rg); settle();
  const re = d.entries.get('rg');
  const onScreenH = () => rg.scale.x * re.naturalH; // world height = local height(naturalH) · worldScale

  d.spotlight('rg'); settle();
  rg.fireResize(80, 12); settle();          // resize SMALLER while focused (free-grow)
  rg.setZoom(1.3); d.reflowTile('rg'); settle();
  const before = onScreenH();
  d.spotlight('rg'); settle();              // defocus → bar
  d.spotlight('rg'); settle();              // refocus
  const after = onScreenH();
  ok(Math.abs(after / before - 1) < 1e-6, `no-snap on focus toggle (before ${before.toFixed(3)}, after ${after.toFixed(3)})`);
  ok(re.focusHeightFrac != null && Math.abs(re.focusHeightFrac - d.focusFrac * 0.5) < 1e-9,
     `free-grow persisted in intent across the toggle (focusHeightFrac ${re.focusHeightFrac})`);
}

// ---- slot uniqueness across spotlight/relayout (the collision fix) --------
// Regression: the spotlit tile used to keep a STALE slot while the bar renumbered
// 0..n-1, so two tiles could report the same slot — and a shadowed tile then ate its
// sibling's hover/wheel (the term-11 scroll bug). _relayout now numbers ALL entries by
// Map order in one place, so slots stay unique through any spotlight state.
function slotDock(n) {
  const d = new CameraDock({ attentionManager: { docks: new Map() } });
  d.attach = () => {};
  d._animateTile = () => {};        // skip THREE math; we only assert slot labels
  d._viewH = 100; d._viewW = 160;
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    d.entries.set(id, {
      id, grid: { scaleModel: null },
      home: { pos: { x: 0, y: 0, z: 0 }, scale: 0.1, quat: {} },
      naturalH: 100, centerOffset: { x: 50, y: -50, z: 0 },
      dims: { cols: 80, rows: 24 }, slot: i,
      quatTarget: { setFromUnitVectors() {}, identity() {} },
    });
    d.attentionManager.docks.set(id, { offset: {} });
  }
  return d;
}
const slotsOf = (d) => [...d.entries.values()].map((e) => e.slot);
const allUnique = (d) => new Set(slotsOf(d)).size === d.entries.size;

for (const mode of ['linear', 'radial']) {
  const d = slotDock(4);
  d.setLayout(mode); // triggers _relayout, no focus
  ok(allUnique(d), `${mode}: 4 tiles, no focus → unique slots [${slotsOf(d)}]`);

  d.focusedId = 's1'; // spotlight one — used to leave it with a stale, colliding slot
  d._relayout();
  ok(allUnique(d), `${mode}: spotlit s1 → still unique slots [${slotsOf(d)}]`);
  const focusSlot = d.entries.get('s1').slot;
  const barSlots = [...d.entries.values()].filter((e) => e.id !== 's1').map((e) => e.slot);
  ok(!barSlots.includes(focusSlot), `${mode}: focused slot ${focusSlot} not shared by any bar tile`);

  d.focusedId = null; // un-spotlight — returns to the bar, slots still clean
  d._relayout();
  ok(allUnique(d), `${mode}: un-spotlit → unique slots preserved [${slotsOf(d)}]`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
