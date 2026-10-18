// arrangers.test.mjs — the structural arrangers (structure.grid / structure.strata) on the
// CPU slot path: one fold, one displacement table, every reader agreeing.
//   bun tools/arrangers.test.mjs
//
// Drives a real CodeGrid (headless, mock atlas) with a hand-built SemanticModel and asserts:
//   StructureLayout (the lens) —
//     - each block moves RIGIDLY (one delta per block), the packed blocks don't overlap,
//       and every other glyph is hidden (height 0);
//     - the content bounds and the cull box are the arranged extent, and hold every
//       visible glyph's ink;
//     - the caret (positionAt) lands on the moved glyphs;
//     - a re-fold re-applies the same arrangement (it never compounds);
//     - reset returns the grid to its own layout (newspaper here) with every glyph shown.
//   StrataLayout (the depth reading) —
//     - each glyph floats to its DEEPEST scope's plane (depth × zStep), x/y stay at flow;
//     - the caret agrees; the extent reaches the deepest plane;
//     - a live dial re-applies against the fold, not on top of the last arrangement;
//     - each box centers on its glyphs (cell-center anchor — no half-row offset);
//     - reset returns every glyph to flow.

import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import { StructureLayout } from '../packages/glyph3d-core/src/collections/StructureLayout.js';
import { StrataLayout, setStrataParam, STRATA_DEFAULTS } from '../packages/glyph3d-core/src/collections/StrataLayout.js';
import { LAYOUT_PRESETS } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_POS_Z, LANE_HEIGHT } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

const atlas = { getCharSize: () => ({ width: 28, height: 55 }), _slugData: null, _shaper: null };
const scene = new THREE.Scene();

const lines = [
    '// header',
    'function alpha() {',
    '    return 1;',
    '}',
    'class Box {',
    '    method1() {',
    '        const f = () => {',
    '            return 2;',
    '        };',
    '    }',
    '    method2() { return 3; }',
    '}',
    'const tail = 4;',
];
const text = lines.join('\n');

// SemanticModel nodes: start/end {line, col}, end col exclusive.
const at = (line, needle) => ({ line, col: lines[line].indexOf(needle) });
const after = (line, needle) => ({ line, col: lines[line].lastIndexOf(needle) + needle.length });
const node = (kind, name, start, end, children = []) => ({ kind, name, start, end, children });
const f      = node('function', 'f', at(6, '()'), after(8, '}'));
const method1 = node('method', 'method1', at(5, 'method1'), after(9, '}'), [f]);
const method2 = node('method', 'method2', at(10, 'method2'), after(10, '}'));
const box    = node('class', 'Box', at(4, 'class'), after(11, '}'), [method1, method2]);
const alpha  = node('function', 'alpha', at(1, 'function'), after(3, '}'));
const roots = [alpha, box];
const model = { roots, flat: [alpha, box, method1, f, method2] };

async function makeGrid(layout) {
    const grid = new CodeGrid(scene, atlas, { showFilename: false });
    await grid.loadText(text);
    if (layout) await grid.setLayout(layout);
    grid.getSemantics = () => model;
    grid.ensureSemantics = async () => model;
    grid.refreshSemanticsSync = () => model;
    return grid;
}

const slotPos = (grid, s) => {
    const f32 = grid._renderer.slotBuffer.f32, b = s * SLOT_FLOATS;
    return { x: f32[b + LANE_POS_X], y: f32[b + LANE_POS_Y], z: f32[b + LANE_POS_Z], h: f32[b + LANE_HEIGHT] };
};
const count = (grid) => grid._renderer.getGlyphCount();
const snapshot = (grid) => Array.from({ length: count(grid) }, (_, s) => slotPos(grid, s));
// Slot range a node moves: [first glyph, one past its last glyph].
const range = (grid, n) => [grid.getSlotForChar(n.start.line, n.start.col), grid.getSlotForChar(n.end.line, n.end.col - 1) + 1];

// Every char's caret position vs its glyph's buffer position.
function caretAgrees(grid, label) {
    const d = grid._layout;
    let bad = 0, first = '';
    for (let L = 0; L < lines.length; L++) {
        for (let c = 0; c < d.lineSlotCount(L); c++) {
            const p = d.positionAt(L, c), g = slotPos(grid, d.slotForChar(L, c));
            if (g.h === 0) continue;   // hidden glyphs aren't caret targets
            if (!near(p.x, g.x) || !near(p.y, g.y) || !near(p.z, g.z)) {
                if (!bad) first = `L${L}:${c} caret (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) vs glyph (${g.x.toFixed(2)}, ${g.y.toFixed(2)}, ${g.z.toFixed(2)})`;
                bad++;
            }
        }
    }
    ok(bad === 0, `${label}: caret lands on every visible glyph (${bad} off${first ? '; first ' + first : ''})`);
}

// Visible ink (x..x+advance, y±h/2) inside a box.
function inkInside(grid, box, label) {
    const f32 = grid._renderer.slotBuffer.f32, eps = 1e-3;
    let out = 0;
    for (let s = 0; s < count(grid); s++) {
        const b = s * SLOT_FLOATS, h = f32[b + LANE_HEIGHT];
        if (h === 0) continue;
        const x = f32[b + LANE_POS_X], y = f32[b + LANE_POS_Y], z = f32[b + LANE_POS_Z];
        if (x < box.min.x - eps || y - h / 2 < box.min.y - eps || y + h / 2 > box.max.y + eps
            || z < box.min.z - eps || z > box.max.z + eps) out++;
    }
    ok(out === 0, `${label}: every visible glyph inside the bounds (${out} outside)`);
}

// ── StructureLayout ──────────────────────────────────────────────────────────
console.log('StructureLayout');
{
    // Newspaper with a short page, so this small file really spans columns — the arranger
    // must force a single column while arranged and hand the columns back on reset.
    const newspaper = { ...LAYOUT_PRESETS.newspaper, pageHeight: 4 };
    const grid = await makeGrid(newspaper);
    const paged = snapshot(grid);
    const single = snapshot(await makeGrid({ ...newspaper, pageHeight: 0, pagesWide: 1 }));
    ok(paged.some((p, s) => !near(p.x, single[s].x)), 'fixture: the newspaper fold really pages (columns differ from one column)');

    const sl = new StructureLayout(grid);
    const res = await sl.grid();
    ok(res.ok && res.count === 3, `grid(): arranges the 3 callable units (got ${JSON.stringify(res)})`);

    // Rigid moves: one delta per block, measured against the single-column fold it forces.
    const blocks = [alpha, method1, method2].map((n) => range(grid, n));
    const inBlock = new Uint8Array(count(grid));
    const boxes = [];
    for (const [a, b] of blocks) {
        const d0 = { x: slotPos(grid, a).x - single[a].x, y: slotPos(grid, a).y - single[a].y };
        let rigid = true;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let s = a; s < b; s++) {
            inBlock[s] = 1;
            const p = slotPos(grid, s);
            if (!near(p.x - single[s].x, d0.x) || !near(p.y - single[s].y, d0.y) || !near(p.z, single[s].z)) rigid = false;
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        ok(rigid, `block ${a}..${b} moves rigidly`);
        boxes.push({ minX, minY, maxX, maxY });
    }
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.minX <= B.maxX && B.minX <= A.maxX && A.minY <= B.maxY && B.minY <= A.maxY) overlaps++;
    }
    ok(overlaps === 0, `packed blocks don't overlap (${overlaps} pairs)`);

    let shownOutside = 0, hiddenInside = 0;
    for (let s = 0; s < count(grid); s++) {
        const h = slotPos(grid, s).h;
        if (!inBlock[s] && h !== 0) shownOutside++;
        if (inBlock[s] && h === 0) hiddenInside++;
    }
    ok(shownOutside === 0 && hiddenInside === 0, `only block glyphs show (${shownOutside} stray shown, ${hiddenInside} block glyphs hidden)`);

    const cb = grid._getContentBounds();
    ok(cb === grid._arrangedExtent || (near(cb.min.x, grid._arrangedExtent.min.x) && near(cb.max.y, grid._arrangedExtent.max.y)),
        'content bounds are the arranged extent');
    // three's cull box = the arranged extent + the shader's right-side overdraw (one widest
    // quad — InstancedField.setLayoutExtent).
    const cull = grid._renderer.geometry.boundingBox;
    const r = grid._renderer, overdraw = r._maxQuad;
    ok(overdraw > 0 && near(cull.min.x, cb.min.x) && near(cull.max.x, cb.max.x + overdraw) && near(cull.min.y, cb.min.y) && near(cull.max.y, cb.max.y),
        `cull box is the arranged extent + overdraw (max.x ${cull.max.x.toFixed(2)} vs ${(cb.max.x + overdraw).toFixed(2)})`);
    inkInside(grid, cb, 'structure');
    caretAgrees(grid, 'structure');

    const arranged = snapshot(grid);
    await grid._relayoutInPlace();
    const again = snapshot(grid);
    ok(arranged.every((p, s) => near(p.x, again[s].x) && near(p.y, again[s].y) && near(p.z, again[s].z) && p.h === again[s].h),
        're-fold re-applies the same arrangement');

    await sl.reset();
    const back = snapshot(grid);
    ok(back.every((p, s) => near(p.x, paged[s].x) && near(p.y, paged[s].y) && near(p.z, paged[s].z) && p.h > 0),
        'reset returns to the grid\'s own layout (newspaper), every glyph shown');
    ok(grid._arrangedExtent === null, 'reset drops the arranged extent');
    grid.dispose?.();
}

// ── StrataLayout ─────────────────────────────────────────────────────────────
console.log('StrataLayout');
{
    const grid = await makeGrid();
    const flow = snapshot(grid);
    const st = new StrataLayout(grid);
    const res = await st.start();
    ok(res.ok && res.count === 5 && res.maxDepth === 2, `start(): 5 nodes, depth 2 (got ${JSON.stringify(res)})`);

    const unit = grid.metrics.lineSpacing;
    const zAt = (line, needle, factor = STRATA_DEFAULTS.zStepFactor) => {
        const s = grid.getSlotForChar(line, lines[line].indexOf(needle));
        return { s, z: slotPos(grid, s).z, want: (d) => d * unit * factor };
    };
    const cases = [
        [7, 'return 2', 2, 'f body (depth 2)'],
        [6, 'const f', 1, 'method1 body (depth 1)'],
        [10, 'method2', 1, 'method2 (depth 1)'],
        [2, 'return 1', 0, 'alpha body (depth 0)'],
        [0, '// header', 0, 'outside every node'],
    ];
    for (const [L, needle, depth, label] of cases) {
        const { z, want } = zAt(L, needle);
        ok(near(z, want(depth)), `${label}: z ${z.toFixed(2)} = ${want(depth).toFixed(2)}`);
    }
    const xyFlow = snapshot(grid).every((p, s) => near(p.x, flow[s].x) && near(p.y, flow[s].y));
    ok(xyFlow, 'x/y stay at flow');
    caretAgrees(grid, 'strata');
    const cb = grid._getContentBounds();
    ok(cb.max.z >= 2 * unit * STRATA_DEFAULTS.zStepFactor - 1e-3, `extent reaches the deepest plane (max.z ${cb.max.z.toFixed(2)})`);
    inkInside(grid, cb, 'strata');

    // A live dial re-applies against the fold — twice in a row, same answer.
    setStrataParam('zStepFactor', 3);
    setStrataParam('zStepFactor', 3);
    {
        const { z, want } = zAt(7, 'return 2', 3);
        ok(near(z, want(2)), `live dial: f body z ${z.toFixed(2)} = ${want(2).toFixed(2)} (no compounding)`);
    }
    caretAgrees(grid, 'strata after a live dial');
    setStrataParam('zStepFactor', STRATA_DEFAULTS.zStepFactor);

    // Boxes: one rectangle per node; method2's (one line) centers on its glyphs' row.
    const pos = st._boxGeo.getAttribute('position');
    ok(st._boxGeo.drawRange.count === 5 * 8, `5 boxes drawn (${st._boxGeo.drawRange.count / 8})`);
    const rowY = slotPos(grid, grid.getSlotForChar(10, 4)).y;
    let y0 = Infinity, y1 = -Infinity;
    // method2 is the 5th node in pre-order (alpha, Box, method1, f, method2) → verts 32..39.
    for (let v = 32; v < 40; v++) { y0 = Math.min(y0, pos.getY(v)); y1 = Math.max(y1, pos.getY(v)); }
    ok(near((y0 + y1) / 2, rowY), `method2's box centers on its row (box mid ${((y0 + y1) / 2).toFixed(2)}, row ${rowY.toFixed(2)})`);

    await st.reset();
    const back = snapshot(grid);
    ok(back.every((p, s) => near(p.x, flow[s].x) && near(p.y, flow[s].y) && near(p.z, flow[s].z)), 'reset returns every glyph to flow');
    ok(!st._boxMesh, 'reset drops the boxes');
    grid.dispose?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
