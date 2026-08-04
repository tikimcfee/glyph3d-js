// pane-compose-check.mjs — the PaneTree ↔ CameraDock composition: the frame's occupancy is a
// binary-BSP tree, a single leaf == the old single-occupant pin, a split tiles two windows into
// the frame side-by-side. Verifies the tree → world-rect → placement chain headlessly (CameraDock
// is pure three math; no browser/relay).
//
//   bun tools/pane-compose-check.mjs
//
// Sibling of dock-refresh-check / panetree-check. Per the debug-into-tools practice.

import './headless-canvas.mjs';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
