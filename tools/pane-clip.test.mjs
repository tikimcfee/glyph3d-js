// pane-clip.test.mjs — a tiled plane desk clips FOREIGN content (it keeps its own size: a terminal,
// a frame) to its tile in x and y, scrolls it in whole cells, and marks the edges content runs past
// (docs/planes/DESIGN.md §3.11 "Clip"; slice 6 step 2).
//
//   bun tools/pane-clip.test.mjs
//
// Locks, on a real FramedGlyphField over a real InstancedField (the group table the shaders read):
//   - the group clip lanes: col 4 = (top, bottom, yOn, xOn), col 6 = (left, right); stride 7; the
//     render and pick shaders both splice the ONE rule (GROUP_CLIP_GLSL), whose JS twin judges here
//   - every glyph the rule keeps lands inside its tile in WORLD space (through the member's real
//     pose) — nothing draws outside a tile; teeth: with the x lane off, glyphs land outside
//   - the tile shows exactly floor(tile px / cell px) whole columns and rows
//   - stepping pane.scroll reaches every column and row, clamped at both ends
//   - an edge mark shows on exactly the sides with content past them
//   - the background panel is CPU-cut to the tile (PanelBatch cutRect), the cursor hides past it
//   - leaving the tiles hands the window back unclipped

import './headless-canvas.mjs';
import * as THREE from 'three';
import FramedGlyphField from '../packages/glyph3d-core/src/collections/FramedGlyphField.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import { GridBlockCursor } from '../packages/glyph3d-core/src/collections/grid/GridBlockCursor.js';
import { cutRect } from '../packages/glyph3d-core/src/collections/PanelBatch.js';
import { GROUP_STRIDE, GROUP_CLIP_GLSL, groupClipped } from '../packages/glyph3d-core/src/core/glyphMaterial.js';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import fs from 'node:fs';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const CW = 0.725, LS = 1.359375;
const atlas = { getCharSize: () => ({ width: 28, height: 55, em: 48 }), _slugData: null, _shaper: null };

/** A terminal-shaped window: its own glyph group, a background panel, a cursor; cols × rows cells. */
class Term extends FramedGlyphField {
    constructor(name, cols, rows) {
        super();
        this.name = name;
        this.cols = cols; this.rows = rows;
        this.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS, letterSpacing: 0 };
        this._renderer = new InstancedField(new THREE.Scene(), atlas, { maxGroups: 4 });
        this._groupId = this._renderer.createGroup();
        this.add(this._renderer.instanceMesh);
        this._background = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
        this._background.scale.set(cols * CW, rows * LS, 1);
        this._background.position.set(cols * CW / 2, -rows * LS / 2 + LS / 2, -0.01);
        this.add(this._background);
        this._cursorBlock = new GridBlockCursor({ parent: this, metrics: this.metrics });
        this._cursor = { x: 0, y: 0 };
        this._initScale(1);
    }
    _updateCursorMesh() { this._cursorBlock.update(this._cursor.x, this._cursor.y, this.cols, this.rows, this.metrics); }
    pixelOrigin() { return { x: 0, y: LS / 2 }; }   // row 0's top edge (pens sit at cell vertical centers)
    getLocalBounds() { return new THREE.Box3(new THREE.Vector3(0, -this.rows * LS + LS / 2, -0.5), new THREE.Vector3(this.cols * CW, LS / 2, 0.5)); }
    /** A glyph's pen (left edge, cell vertical center) in this window's own space. */
    pen(col, row) { return { x: col * CW, y: -row * LS }; }
}

/** The group row's clip, read back from the group table exactly as the shaders read it. */
function clipOf(t) {
    const G = t._renderer._groupData, b = t._groupId * GROUP_STRIDE * 4;
    return { top: G[b + 16], bottom: G[b + 17], yOn: G[b + 18] > 0.5, xOn: G[b + 19] > 0.5, left: G[b + 24], right: G[b + 25] };
}

// ── 0. The lanes and the one rule.
{
    ok(GROUP_STRIDE === 7, 'the group row is 7 vec4s (col 6 = clip x)');
    ok(/groupClipped\(/.test(GROUP_CLIP_GLSL), 'the GLSL rule is a function');
    const vs = fs.readFileSync(new URL('../packages/glyph3d-core/src/core/glyphMaterial.js', import.meta.url), 'utf8');
    const pick = fs.readFileSync(new URL('../packages/glyph3d-core/src/picking/PickingSystem.js', import.meta.url), 'utf8');
    ok(/\$\{GROUP_CLIP_GLSL\}/.test(pick) && /groupClipped\(gClip, gClipX, aPos, quadW, aExtent\.y\)/.test(pick), 'the pick shader splices the same rule (what is cut there cannot be picked)');
    ok(/\$\{GROUP_CLIP_GLSL\}/.test(vs) && /groupClipped\(gClip, gClipX, aPos, quadW, aExtent\.y\)/.test(vs), 'the render shader splices and calls it');
}

// ── 1. A tiled desk: a 239×56 terminal (foreign) and a 60×20 one in the 'even' layout.
const UNIT = { column: CW, cellPx: 8, rowRatio: LS / CW };   // 8 × 15 device px cells
const scene = new THREE.Scene();
const desk = new Carrel({ name: 'p', mode: 'plane', planeArrange: 'tiles', tileCols: 200, tileRows: 40, animDur: 0, paneGapPx: 8 });
scene.add(desk);
desk.setPlaneUnit(UNIT);
const big = new Term('big', 239, 56), small = new Term('small', 60, 20);
scene.add(big); scene.add(small);
desk.lock('big', big, { immediate: true });
desk.lock('small', small, { immediate: true });
desk.layoutPanes('even');
const settle = () => { for (let i = 0; i < 4; i++) desk.animator.update?.(1); scene.updateMatrixWorld(true); };
settle();

const k = desk.planeK;
const paneOf = (id) => desk.paneRects().find((p) => p.stack.includes(id));
/** The tile in world space (the desk is unrotated at the origin here). */
function tileWorld(id) {
    const r = paneOf(id).rect, tl = desk._boardTopLeft();
    return { x0: tl.x + r.x / k, x1: tl.x + (r.x + r.w) / k, y0: tl.y - r.y / k, y1: tl.y - (r.y + r.h) / k, r };
}
/** Every cell the rule keeps, and whether each lands inside the tile in world space. */
function judge(t, id, clip = clipOf(t)) {
    const w = tileWorld(id), eps = 1e-4;
    const kept = [];
    let outside = 0;
    for (let row = 0; row < t.rows; row++) for (let col = 0; col < t.cols; col++) {
        const p = t.pen(col, row);
        if (groupClipped(clip, p, CW, LS)) continue;
        kept.push([col, row]);
        const a = t.localToWorld(new THREE.Vector3(p.x, p.y - LS / 2, 0)), b = t.localToWorld(new THREE.Vector3(p.x + CW, p.y + LS / 2, 0));
        if (a.x < w.x0 - eps || b.x > w.x1 + eps || b.y > w.y0 + eps || a.y < w.y1 - eps) outside++;
    }
    const cols = new Set(kept.map(([c]) => c)), rows = new Set(kept.map(([, r]) => r));
    return { kept, outside, cols: [...cols].sort((a, b) => a - b), rows: [...rows].sort((a, b) => a - b), w };
}
{
    const j = judge(big, 'big');
    const wantCols = Math.floor(j.w.r.w / UNIT.cellPx), wantRows = Math.floor(j.w.r.h / (UNIT.cellPx * UNIT.rowRatio));
    ok(j.kept.length > 0 && j.outside === 0, `nothing the tile keeps draws outside it (${j.kept.length} cells kept, ${j.outside} outside)`);
    ok(j.cols.length === wantCols && j.cols[0] === 0 && j.cols.at(-1) === wantCols - 1, `the tile shows exactly its ${wantCols} whole columns (got ${j.cols.length}: ${j.cols[0]}…${j.cols.at(-1)})`);
    ok(j.rows.length === Math.min(wantRows, big.rows) && j.rows[0] === 0, `and its ${Math.min(wantRows, big.rows)} whole rows (got ${j.rows.length})`);
    // Teeth: the x lane off — glyphs land outside the tile.
    const t = judge(big, 'big', { ...clipOf(big), xOn: false });
    ok(t.outside > 0, `teeth: without the x clip ${t.outside} cells draw outside the tile`);
    // The small terminal fits: no clip effect, no marks.
    const s = judge(small, 'small');
    ok(s.kept.length === small.cols * small.rows && s.outside === 0, 'a member that fits keeps every cell, inside its tile');
}

// ── 2. Edge marks: on exactly the sides with content past them.
const marks = () => [...desk._edgeMarks.keys()].filter((key) => key.startsWith(paneOf('big').id)).map((key) => key.split(':').pop()).sort().join(',');
{
    const p = paneOf('big').id;
    ok(marks() === 'bottom,right', `at the origin: right and bottom marked (got ${marks()})`);
    ok(![...desk._edgeMarks.keys()].some((key) => key.startsWith(paneOf('small').id)), 'a member that fits has no marks');
    const m = desk._edgeMarks.get(`${p}:right`), w = tileWorld('big');
    ok(Math.abs(m.position.x + m.scale.x / 2 - w.x1) < 1e-9 && Math.abs(m.scale.x * k - desk.edgeMarkPx) < 1e-9, `the right mark hugs the tile edge, ${desk.edgeMarkPx} device px wide`);
}

// ── 3. Scroll: every column and row reachable, clamped both ends.
{
    const seenC = new Set(), seenR = new Set();
    let guard = 0, s;
    for (const c of judge(big, 'big').cols) seenC.add(c);
    do {
        s = desk.paneScroll('big', 7, 0); settle();
        for (const c of judge(big, 'big').cols) seenC.add(c);
    } while (s.cols < s.overflow.cols && ++guard < 200);
    ok(s.cols === s.overflow.cols && s.overflow.cols === 239 - Math.floor(tileWorld('big').r.w / UNIT.cellPx), `scroll clamps at the overflow (${s.cols}/${s.overflow.cols})`);
    const j = judge(big, 'big');
    ok(j.outside === 0, 'scrolled: still nothing outside the tile');
    for (const c of j.cols) seenC.add(c);
    ok(seenC.size === 239, `every column was reachable by scroll (${seenC.size}/239)`);
    ok(marks() === 'bottom,left', `scrolled to the end: left and bottom marked (got ${marks()})`);
    desk.paneScroll('big', 3, 0); settle();
    ok(desk.paneScroll('big', 0, 0).cols === s.overflow.cols, 'scrolling past the end stays clamped');
    for (const r of judge(big, 'big').rows) seenR.add(r);
    do { s = desk.paneScroll('big', 0, 5); settle(); for (const r of judge(big, 'big').rows) seenR.add(r); } while (s.rows < s.overflow.rows && ++guard < 400);
    for (const r of judge(big, 'big').rows) seenR.add(r);
    ok(seenR.size === 56, `every row was reachable by scroll (${seenR.size}/56)`);
    ok(marks() === 'left,top', `scrolled to both ends: left and top marked (got ${marks()})`);
    desk.paneScroll('big', -1000, -1000); settle();
    ok(desk.paneScroll('big', 0, 0).cols === 0 && marks() === 'bottom,right', 'scrolling back clamps at 0, the marks swap back');
}

// ── 4. Panels and cursor.
{
    const r = cutRect(big._background);
    const bg = big._background, c = big.clipRect;
    ok(r && Math.abs((bg.position.x + r.x1 * bg.scale.x) - c.right) < 1e-9 && Math.abs((bg.position.x + r.x0 * bg.scale.x) - Math.max(c.left, bg.position.x - bg.scale.x / 2)) < 1e-9, `the background panel is cut to the tile's right edge (${JSON.stringify(r)})`);
    ok(cutRect(small._background) === null || small._background.userData.panelClip == null || cutRect(small._background).x1 === 0.5, 'a member that fits is not cut short');
    big._cursor = { x: 200, y: 0 }; big._updateCursorMesh();
    ok(big._cursorBlock.mesh.visible === false, 'a cursor past the cut hides');
    big._cursor = { x: 3, y: 2 }; big._updateCursorMesh();
    ok(big._cursorBlock.mesh.visible === true, 'a cursor inside the tile shows');
}

// ── 5. Leaving the tiles hands the window back whole.
{
    desk.setPlaneArrange('pins');
    ok(big.clipRect === null && !clipOf(big).xOn && !clipOf(big).yOn, 'pins: the clip is gone');
    ok(big._background.userData.panelClip == null, 'and the panel cut');
}

console.log(`${fails ? 'FAIL' : 'ok'} pane-clip: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
