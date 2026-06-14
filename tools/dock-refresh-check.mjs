// dock-refresh-check.mjs — deterministic check of how CameraDock reacts to a docked tile
// changing size/zoom (the live grip-resize / terminal.resize / window.scale interplay).
// CameraDock is pure three math, so this needs no browser/relay.
//
// The model under test is IDEMPOTENT by construction: a tile's content extent is derived LIVE
// from grid.getLocalBounds() (never a cached `*= ratio` delta, which desynced from cols/rows and
// double-applied), and the focus slot is a pure function of that extent + zoom + focusFrac (no
// stored per-tile focus size). So:
//   - a BAR tile box-fits its FIXED slot — resize reshapes the content inside, footprint unchanged;
//   - a FOCUSED tile fits focusFrac — resize reshapes content, zoom changes apparent size;
//   - both survive a focus toggle with NO snap and NO double (the two regressions this guards).
//
//   bun tools/dock-refresh-check.mjs
//
// Graduated from a one-off probe per the debug-into-tools practice. Sibling of dock-persist-check.mjs.

import * as THREE from 'three';
import { CameraDock } from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import { ScaleModel } from '../packages/glyph3d-core/src/collections/ScaleModel.js';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; else pass++; };

const LH = 1; // unit cell height — local panel height == rows

// A real-enough grid: THREE.Object3D + ScaleModel + getLocalBounds (the dock's live extent source),
// getBounds (world, for lock's home framing), and an onResize tap. Top-left anchored: local center
// at (cols/2, -rows/2), so the origin→center offset is non-trivial like the real grids.
function makeGrid(cols, rows, placement = 1) {
  const sm = new ScaleModel(placement);
  const g = new THREE.Object3D();
  g.cols = cols; g.rows = rows; g.scaleModel = sm; g._cb = null;
  g.onResize = (cb) => { g._cb = cb; return () => { g._cb = null; }; };
  g.setZoom = (f) => { sm.setZoom(f); sm.resolve(g); };
  Object.defineProperty(g, 'zoom', { get: () => sm.zoomScalar });
  g.getLocalBounds = () => {
    const w = g.cols, h = g.rows * LH, cx = g.cols / 2, cy = -g.rows / 2;
    return new THREE.Box3(new THREE.Vector3(cx - w / 2, cy - h / 2, -1), new THREE.Vector3(cx + w / 2, cy + h / 2, 1));
  };
  g.getBounds = () => { g.updateWorldMatrix(true, false); return g.getLocalBounds().clone().applyMatrix4(g.matrixWorld); };
  g.resizeTo = (c, r) => { g.cols = c; g.rows = r; g._cb?.(c, r); };
  g._resizeCb = () => g._cb;
  sm.resolve(g);
  return g;
}

// A docked dock with one tile, viewport pinned, animator settled on demand.
function rig() {
  const d = new CameraDock({ attentionManager: { docks: new Map() }, layout: 'linear' });
  new THREE.Scene().add(d);
  d._viewH = 100; d._viewW = 160;
  d.settle = () => { for (let i = 0; i < 6; i++) d.animator.update(10); d._viewH = 100; d._viewW = 160; };
  return d;
}
const apparentH = (g) => g.scale.x * (g.rows * LH); // world panel height

// ---- BAR tile: box-fit, idempotent, resize reshapes inside a FIXED footprint ----------
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.settle();
  const barA = apparentH(g);
  d.reflowTile('t'); d.settle();                 // reflow with no change → identical (idempotent)
  ok(Math.abs(apparentH(g) - barA) < 1e-9, `bar reflow is idempotent (${barA.toFixed(3)})`);
  g.resizeTo(160, 48); d.settle();               // resize 2× — footprint (box-fit) holds
  ok(Math.abs(apparentH(g) - barA) < 1e-6, `bar resize keeps box-fit footprint (${apparentH(g).toFixed(3)} vs ${barA.toFixed(3)})`);
  g.resizeTo(160, 48); d.settle();               // same resize again → still identical
  ok(Math.abs(apparentH(g) - barA) < 1e-6, `bar re-resize to same dims is a no-op`);
}

// ---- FOCUSED tile: fits focusFrac; resize reshapes content, apparent size HOLDS -------
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.spotlight('t'); d.settle();
  const focusA = apparentH(g);
  g.resizeTo(80, 48); d.settle();                // resize while focused — stable box, not free-grow
  ok(Math.abs(apparentH(g) - focusA) < 1e-6, `focus resize holds focusFrac (${apparentH(g).toFixed(3)} vs ${focusA.toFixed(3)})`);
  // and it tracks the live extent: a fresh tile at 48 rows spotlights to the SAME focus height.
  const d2 = rig(); const g2 = makeGrid(80, 48);
  d2.lock('t', g2); d2.spotlight('t'); d2.settle();
  ok(Math.abs(apparentH(g2) - focusA) < 1e-6, `focus height is content-independent (${apparentH(g2).toFixed(3)})`);
}

// ---- THE DOUBLE regression: free-grow-shaped detour must NOT double on refocus ---------
// resize↑ focused → defocus → resize↓ in bar → refocus. The old cached focus delta went stale
// (updated only while focused) and the refocus came back 2× too big.
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.spotlight('t'); d.settle();
  const fresh = apparentH(g);
  g.resizeTo(80, 48); d.settle();                // grow while focused
  d.spotlight('t'); d.settle();                  // defocus
  g.resizeTo(80, 24); d.settle();                // shrink back, in the bar
  d.spotlight('t'); d.settle();                  // refocus
  const after = apparentH(g);
  ok(Math.abs(after / fresh - 1) < 1e-6, `NO DOUBLE after resize/defocus/resize/refocus (${after.toFixed(3)} vs ${fresh.toFixed(3)})`);
}

// ---- zoom persists across a focus toggle (the no-snap regression) ----------------------
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.spotlight('t'); d.settle();
  g.setZoom(1.5); d.reflowTile('t'); d.settle(); // scale up while focused
  const zoomed = apparentH(g);
  d.spotlight('t'); d.settle();                  // defocus
  d.spotlight('t'); d.settle();                  // refocus
  ok(Math.abs(apparentH(g) / zoomed - 1) < 1e-6, `zoom survives focus toggle, no snap (${apparentH(g).toFixed(3)} vs ${zoomed.toFixed(3)})`);
}

// ---- onResize tap lifecycle (lock subscribes → reflowTile; release drops) --------------
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g);
  ok(typeof g._resizeCb() === 'function', `lock subscribes to grid.onResize`);
  let reflowed = 0; const orig = d.reflowTile.bind(d);
  d.reflowTile = (...a) => { reflowed++; return orig(...a); };
  g.resizeTo(100, 30);
  ok(reflowed === 1, `grid resize fires dock.reflowTile (got ${reflowed})`);
  d.release('t');
  ok(g._resizeCb() === null, `release unsubscribes the resize tap`);
}

// ---- slot uniqueness across spotlight/relayout (the collision fix) --------------------
// Regression: the spotlit tile used to keep a STALE slot while the bar renumbered 0..n-1, so two
// tiles could report the same slot and a shadowed tile ate its sibling's hover/wheel. _relayout
// now numbers ALL entries by Map order in one place, so slots stay unique through any spotlight.
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
      _extentFallback: { h: 100, cx: 50, cy: -50, cz: 0 }, // grid has no getLocalBounds → fallback
      slot: i,
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
