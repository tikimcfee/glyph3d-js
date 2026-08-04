// dock-refresh-check.mjs — deterministic check of how CameraDock reacts to a docked tile
// changing size/zoom (the live grip-resize / terminal.resize / window.scale interplay).
// CameraDock is pure three math, so this needs no browser/relay.
//
// The model under test is IDEMPOTENT by construction: a tile's content extent is derived LIVE
// from grid.getLocalBounds() (never a cached `*= ratio` delta, which desynced from cols/rows and
// double-applied), and the frame fit is a pure function of (frustum, root frame rect, extent) —
// with zoom DIVIDED OUT and no stored per-tile size. So:
//   - a BAR tile box-fits its FIXED slot — resize reshapes the content inside, footprint unchanged;
//   - the FRAME occupant contain-fits the root view-frame — content-independent, zoom-independent;
//   - both survive a focus toggle with NO snap and NO double (the two regressions this guards).
//
//   bun tools/dock-refresh-check.mjs
//
// Graduated from a one-off probe per the debug-into-tools practice. Sibling of dock-persist-check.mjs.

import './headless-canvas.mjs';
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

// frameScale mirrors CameraDock._placePane (single leaf): contain-fit into the margin-inset frame rect,
// pulled in by frameDistFrac. The occupant's RENDERED scale must equal this — no stored size, no zoom.
const cl = (v) => Math.min(Math.max(v, 0), 0.49);
const innerW = (d) => d._viewW * d.frameW * (1 - cl(d.frameMarginLeft) - cl(d.frameMarginRight));
const innerH = (d) => d._viewH * d.frameH * (1 - cl(d.frameMarginTop) - cl(d.frameMarginBottom));
const frameScale = (d, g) => Math.min(innerW(d) / g.cols, innerH(d) / (g.rows * LH)) * d.frameDistFrac;

// ---- FRAME occupant: contain-fits the root view-frame; pure fn of (frustum, frame, extent) ----
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.spotlight('t'); d.settle();
  ok(Math.abs(g.scale.x - frameScale(d, g)) < 1e-6, `framed window contain-fits the frame (${g.scale.x.toFixed(3)} vs ${frameScale(d, g).toFixed(3)})`);
  // sits WHOLLY inside the frame rect on both axes (pillarbox / letterbox, never spill past the edges).
  const fd = d.frameDistFrac;
  ok(g.scale.x * g.cols <= innerW(d) * fd + 1e-6
     && g.scale.x * g.rows * LH <= innerH(d) * fd + 1e-6, `window sits wholly inside the frame (no spill)`);
  g.resizeTo(80, 48); d.settle();                // resize while framed — re-contains live, still exact
  ok(Math.abs(g.scale.x - frameScale(d, g)) < 1e-6, `resize re-contains into the frame (${g.scale.x.toFixed(3)})`);
  // content-independence: a FRESH 48-row tile frames to the SAME fit the resized one reaches (no stored state).
  const d2 = rig(); const g2 = makeGrid(80, 48);
  d2.lock('t', g2); d2.spotlight('t'); d2.settle();
  ok(Math.abs(g2.scale.x - g.scale.x) < 1e-6, `frame fit is content-independent (${g2.scale.x.toFixed(3)})`);
}

// ---- per-side margins: asymmetric insets SHRINK and RE-CENTER the frame rect ------------
{
  const d = rig();  // viewW=160, viewH=100, frameW=frameH=1, frameX=frameY=0 → outer 160×100 at origin
  d.frameMarginLeft = 0.30; d.frameMarginRight = 0.05; d.frameMarginTop = 0.10; d.frameMarginBottom = 0.20;
  const r = d._frameRect();
  ok(Math.abs(r.w - 160 * 0.65) < 1e-6, `width = outer·(1-L-R) = 104 (${r.w.toFixed(2)})`);
  ok(Math.abs(r.h - 100 * 0.70) < 1e-6, `height = outer·(1-T-B) = 70 (${r.h.toFixed(2)})`);
  ok(Math.abs(r.cx - 160 * (0.30 - 0.05) / 2) < 1e-6, `bigger LEFT margin shifts center right (cx=${r.cx.toFixed(2)})`);
  ok(Math.abs(r.cy - 100 * (0.20 - 0.10) / 2) < 1e-6, `bigger BOTTOM margin shifts center up (cy=${r.cy.toFixed(2)})`);
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

// ---- the FRAME owns the size: zoom is divided out, it never bloats past the frame ------
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.spotlight('t'); d.settle();
  const framed = g.scale.x;
  g.setZoom(1.5); d.reflowTile('t'); d.settle(); // dial readability zoom while framed
  ok(Math.abs(g.scale.x - framed) < 1e-6, `zoom does NOT change the framed size (${g.scale.x.toFixed(3)} vs ${framed.toFixed(3)})`);
  ok(Math.abs(g.scale.x - frameScale(d, g)) < 1e-6, `framed size stays the pure contain-fit`);
  ok(Math.abs(g.scaleModel.zoomScalar - 1.5) < 1e-9, `zoom is still recorded (re-applies when released home, not in the frame)`);
}

// ---- the frame tracks the DRAWING-FRAME size: a wider canvas refits the occupant live -----
// CameraDock.update() recomputes viewW/H from the camera each frame and re-_relayout()s on a size
// change, so a browser/canvas resize rescales the pinned window to the new frame (here: widen viewW).
{
  const d = rig(); const g = makeGrid(80, 24);
  d.lock('t', g); d.spotlight('t'); d.settle();
  const before = g.scale.x;
  d._viewW = 320; d._relayout();                 // canvas widened — refit (what update() drives on resize)
  for (let i = 0; i < 6; i++) d.animator.update(10);
  ok(g.scale.x > before + 1e-6, `a wider drawing frame refits the pinned window (${before.toFixed(3)} → ${g.scale.x.toFixed(3)})`);
  ok(Math.abs(g.scale.x - frameScale(d, g)) < 1e-6, `refit lands the exact contain-fit at the new size`);
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

// ---- ORDER PRESERVATION: tiles re-adopting OUT of saved order still pack in saved order ----
// The restore scramble: terminals re-adopt async (arrival order ≠ saved order), each firing
// dock.lock as it lands. Without a hint the bar packed by ARRIVAL, so a reload reordered the row
// and re-saved the scramble. lock({order}) pins each tile's saved slot regardless of WHEN it lands.
{
  const d = rig();
  // Saved order is A,B,C; they "re-adopt" scrambled as C,A,B — each locked with its SAVED index as
  // the order hint, exactly as SessionStore._applyDock3d threads it through dock.lock.
  d.lock('C', makeGrid(80, 24), { order: 2 });
  d.lock('A', makeGrid(80, 24), { order: 0 });
  d.lock('B', makeGrid(80, 24), { order: 1 });
  d.settle();
  const ids = d.list().map((t) => t.id);
  ok(JSON.stringify(ids) === JSON.stringify(['A', 'B', 'C']), `out-of-order arrival packs in SAVED order [${ids}]`);
  const slots = d.list().map((t) => t.slot);
  ok(JSON.stringify(slots) === JSON.stringify([0, 1, 2]), `slots dense 0..n-1 in saved order [${slots}]`);
  ok(d.list().every((t, i) => t.slot === i), `list() is slot-ordered (this is what persistence serializes)`);
}

// ---- interactive locks (no hint) append in lock order; release+new keeps order ------------
{
  const d = rig();
  d.lock('x', makeGrid(80, 24)); d.lock('y', makeGrid(80, 24)); d.lock('z', makeGrid(80, 24));
  d.settle();
  ok(JSON.stringify(d.list().map((t) => t.id)) === JSON.stringify(['x', 'y', 'z']), `interactive locks append in lock order`);
  d.release('y'); d.lock('w', makeGrid(80, 24)); d.settle();
  const ids2 = d.list().map((t) => t.id);
  ok(JSON.stringify(ids2) === JSON.stringify(['x', 'z', 'w']), `release+new keeps order, new tile appends [${ids2}]`);
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
  d.setLayout(mode); // triggers _relayout, nothing framed
  ok(allUnique(d) && slotsOf(d).length === 4, `${mode}: 4 bar tiles → unique dense slots [${slotsOf(d)}]`);

  d.spotlight('s1'); // frame s1 → it LEAVES the bar (framed windows aren't bar tiles)
  const barSlots = [...d.entries.values()].filter((e) => !d.isFramed(e.id)).map((e) => e.slot);
  ok(d.isFramed('s1'), `${mode}: s1 is framed`);
  ok(new Set(barSlots).size === 3, `${mode}: 3 bar tiles, unique dense slots [${barSlots}] (framed s1 excluded)`);

  d.spotlight('s1'); // toggle off → s1 returns to the bar, slots re-densify
  ok(!d.isFramed('s1') && allUnique(d), `${mode}: un-framed → s1 back in the bar, slots clean [${slotsOf(d)}]`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
