// pane-compose-check.mjs — the PaneTree ↔ CameraDock composition: the frame's occupancy is a
// binary-BSP tree, a single leaf == the old single-occupant pin, a split tiles two windows into
// the frame side-by-side. Verifies the tree → world-rect → placement chain headlessly (CameraDock
// is pure three math; no browser/relay).
//
//   bun tools/pane-compose-check.mjs
//
// Sibling of dock-refresh-check / panetree-check. Per the debug-into-tools practice.

import * as THREE from 'three';
import { CameraDock } from '../packages/glyph3d-core/src/services/interaction/CameraDock.js';
import { ScaleModel } from '../packages/glyph3d-core/src/collections/ScaleModel.js';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (c) pass++; else fail++; };
const near = (a, b, m, eps = 1e-6) => ok(Math.abs(a - b) <= eps, `${m} (got ${a.toFixed(3)} want ${b.toFixed(3)})`);

const LH = 1;
function makeGrid(cols, rows) {
    const sm = new ScaleModel(1);
    const g = new THREE.Object3D();
    g.cols = cols; g.rows = rows; g.scaleModel = sm; g._cb = null;
    g.onResize = (cb) => { g._cb = cb; return () => { g._cb = null; }; };
    g.setZoom = (f) => { sm.setZoom(f); sm.resolve(g); };
    g.getLocalBounds = () => new THREE.Box3(
        new THREE.Vector3(0, -rows * LH, -1), new THREE.Vector3(cols, 0, 1)); // top-left anchored
    g.getBounds = () => { g.updateWorldMatrix(true, false); return g.getLocalBounds().clone().applyMatrix4(g.matrixWorld); };
    sm.resolve(g);
    return g;
}
function rig() {
    const d = new CameraDock({ attentionManager: { docks: new Map() }, layout: 'linear' });
    new THREE.Scene().add(d);
    d._viewH = 100; d._viewW = 160;
    d.settle = () => { for (let i = 0; i < 8; i++) d.animator.update(10); d._viewH = 100; d._viewW = 160; };
    return d;
}
const apparentH = (g) => g.scale.x * g.rows * LH; // world panel height

// A terminal-like window: cols×rows of `cell`-sized cells, with fitToContainer mirroring
// TerminalGrid.fitToContainer (the resize-to-container receiver) and a resize that re-derives bounds.
function makeTermGrid(cols, rows, cell = 2) {
    const sm = new ScaleModel(1);
    const g = new THREE.Object3D();
    g.cols = cols; g.rows = rows; g.scaleModel = sm; g._cb = null; g._resizes = [];
    g.onResize = (cb) => { g._cb = cb; return () => { g._cb = null; }; };
    g.setZoom = (f) => { sm.setZoom(f); sm.resolve(g); };
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -g.rows * cell, -1), new THREE.Vector3(g.cols * cell, 0, 1));
    g.getBounds = () => { g.updateWorldMatrix(true, false); return g.getLocalBounds().clone().applyMatrix4(g.matrixWorld); };
    g.resize = (c, r) => { g.cols = Math.round(c); g.rows = Math.round(r); g._resizes.push([g.cols, g.rows]); g._cb?.(g.cols, g.rows); };
    g.fitToContainer = (worldW, worldH, worldScale) => {         // mirror of TerminalGrid.fitToContainer
        const lb = g.getLocalBounds(); const s = worldScale || 1;
        const cellW = ((lb.max.x - lb.min.x) / Math.max(g.cols, 1)) * s;
        const cellH = ((lb.max.y - lb.min.y) / Math.max(g.rows, 1)) * s;
        const c = Math.max(1, Math.floor(worldW / cellW + 1e-6)), r = Math.max(1, Math.floor(worldH / cellH + 1e-6));
        const changed = c !== g.cols || r !== g.rows;
        if (changed) g.resize(c, r);
        return { cols: c, rows: r, changed };
    };
    sm.resolve(g);
    return g;
}

// ---- single leaf == the old single-occupant frame (fills the whole frame, centered) ----
{
    const d = rig();
    const a = makeGrid(80, 24);
    d.lock('a', a); d.settle();
    ok(d.paneTree === null, 'lock alone frames nothing (a is a bar tile)');
    d.spotlight('a'); d.settle();
    ok(d.isFramed('a') && d.paneTree.count() === 1 && d.focusedPane === 'a', 'spotlight → one-leaf tree, a is the active pane');
    const fullH = apparentH(a);
    // centered on the frame: a top-left-anchored 80×24 grid's CENTER lands at the frame center (0,0)·fd.
    // (position = center*fd - extCenter*eff; here center=(0,0), so position = -extCenter*eff.)
    ok(Math.abs(a.position.x - (-40 * a.scale.x)) < 1e-4, 'single pane: centered in X on the frame');
    ok(fullH > 0, `single pane fills the frame (apparentH ${fullH.toFixed(3)})`);
}

// ---- split H → two panes tile the frame side by side, each half-scale, ordered left→right ----
{
    const d = rig();
    const a = makeGrid(80, 24), b = makeGrid(80, 24);
    d.lock('a', a); d.lock('b', b);
    d.spotlight('a'); d.settle();
    const soloH = apparentH(a);
    d.splitPane('x', 'b'); d.settle();
    ok(d.paneTree.count() === 2 && d.isFramed('a') && d.isFramed('b'), 'split: a and b are both panes');
    ok(d.focusedPane === 'b', 'split: focus follows the new pane (b)');
    ok(a.position.x < b.position.x, 'split H: a sits LEFT of b');
    near(apparentH(a), apparentH(b), 'split: equal windows → equal pane size');
    ok(apparentH(a) < soloH, `split: each half-width pane is smaller than the solo (${apparentH(a).toFixed(2)} < ${soloH.toFixed(2)})`);
    // width-bound contain-fit: half the frame width → half the scale.
    near(apparentH(a), soloH * 0.5, 'split: half-frame → exactly half-scale (width-bound)');
}

// ---- bar EXCLUDES framed windows: a loose tile stays in the bar while a,b are panes ----
{
    const d = rig();
    const a = makeGrid(80, 24), b = makeGrid(80, 24), c = makeGrid(80, 24);
    d.lock('a', a); d.lock('b', b); d.lock('c', c);
    d.spotlight('a'); d.splitPane('x', 'b'); d.settle();
    const barIds = d.list().filter((t) => !t.focused).map((t) => t.id);
    ok(JSON.stringify(barIds) === JSON.stringify(['c']), `bar holds only the loose tile [${barIds}]`);
    ok(d.list().filter((t) => t.focused).length === 2, 'list: two framed panes (a, b)');
}

// ---- unframe: sibling collapses up to fill the frame, then empties ----
{
    const d = rig();
    const a = makeGrid(80, 24), b = makeGrid(80, 24);
    d.lock('a', a); d.lock('b', b);
    d.spotlight('a'); d.settle();
    const soloH = apparentH(a);
    d.splitPane('x', 'b'); d.settle();
    d.unframePane('b'); d.settle();
    ok(!d.isFramed('b') && d.paneTree.count() === 1 && d.isFramed('a'), 'unframe b: a is sole pane again');
    near(apparentH(a), soloH, 'unframe: a re-fills the whole frame (scale restored)');
    ok(d.list().some((t) => t.id === 'b' && !t.focused), 'unframe: b is back in the bar');
    d.unframePane('a'); d.settle();
    ok(d.paneTree === null && d.focusedPane === null, 'unframe last pane → frame empty');
}

// ---- spotlight is a TOGGLE and collapses a multi-pane layout to the sole occupant ----
{
    const d = rig();
    const a = makeGrid(80, 24), b = makeGrid(80, 24);
    d.lock('a', a); d.lock('b', b);
    d.spotlight('a'); d.splitPane('x', 'b'); d.settle();
    ok(d.spotlight('a') === 'spotlit', 'spotlight a over a split → re-frames a as SOLE occupant');
    ok(d.paneTree.count() === 1 && d.isFramed('a') && !d.isFramed('b'), 'spotlight: b returned to the bar');
    ok(d.spotlight('a') === 'returned' && d.paneTree === null, 'spotlight a again → toggles the frame off');
}

// ---- release a framed pane sends it home AND collapses the tree ----
{
    const d = rig();
    const a = makeGrid(80, 24), b = makeGrid(80, 24);
    d.lock('a', a); d.lock('b', b);
    d.spotlight('a'); d.splitPane('x', 'b'); d.settle();
    d.release('b'); d.settle();
    ok(!d.has('b') && d.paneTree.count() === 1 && d.isFramed('a'), 'release b: gone from dock, a collapses to sole pane');
}

// ---- RESIZE-TO-CONTAINER: a terminal reshapes cols/rows to FILL its pane (not scale-to-fit) ----
// frame rect (viewW=160, viewH=100, margins 0.06) → w=140.8, h=88. cell=2, base scale=1 → 1 cell = 2 world.
{
    const d = rig();
    const a = makeTermGrid(80, 24, 2);
    d.lock('a', a);                              // homeCols/Rows = 80×24 captured
    d.spotlight('a'); d.settle();
    ok(a.cols === 70 && a.rows === 44, `framed terminal RESHAPES to fill the whole frame (70×44, got ${a.cols}×${a.rows})`);
    // fills the sub-rect: world height == frame height · fd (44 rows × 2 × 0.7 == 88 × 0.7).
    near(a.scale.x * a.rows * 2, 88 * d.frameDistFrac, 'fill: world height == frame height (resized, not shrunk)');

    const b = makeTermGrid(80, 24, 2);
    d.lock('b', b);
    d.splitPane('x', 'b'); d.settle();
    ok(a.cols === 35 && b.cols === 35, `split H: each half-width pane reshapes to 35 cols (got ${a.cols}, ${b.cols})`);
    ok(a.rows === 44 && b.rows === 44, 'split: full-height panes keep 44 rows');

    // semi-idempotent: re-fitting a settled pane is a no-op (no PTY thrash).
    const nBefore = a._resizes.length;
    d.reflowTile('a'); d.reflowTile('a');
    ok(a._resizes.length === nBefore, 'semi-idempotent: re-fit at the same container is a no-op');

    // un-frame restores the pre-frame cols×rows (the "un-pin restores home size" half).
    d.unframePane('b'); d.settle();
    ok(b.cols === 80 && b.rows === 24, `unframe restores b to its home 80×24 (got ${b.cols}×${b.rows})`);
    ok(a.cols === 70 && a.rows === 44, 'unframe: a re-fills the whole frame (70×44)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
