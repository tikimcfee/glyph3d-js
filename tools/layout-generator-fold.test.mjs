// layout-generator-fold.test.mjs — the slots LayoutGenerator writes and the LayoutDescription
// CodeGrid answers caret / pick / extent queries with are ONE fold, under every preset.
//   bun tools/layout-generator-fold.test.mjs
//
// Drives a real CodeGrid (headless, mock atlas) through the grid.layout presets and asserts:
//   - the description's extent is finite (a NaN page fold blacked the screen on newspaper:
//     the fold read metrics.lineSpacing off a grid whose metrics said lineHeight);
//   - every slot sits EXACTLY where positionAt says its (line, col) is — one anchor (pen
//     origin x, cell-center y; row 0's center on the origin — foldGeometry ROW CONVENTION),
//     and the drawn glyphs' bounds sit inside the description's extent. The
//     widest row sits past the first page break, so a column stride taken from the RUNNING
//     widest row (not the final one) lands slots off the fold;
//   - a wrapped line widens the fold by its widest segment, not its length;
//   - tab stops (the glyph3d-rs rule): one slot and one COLUMN per tab, advancing to the next
//     multiple of tabWidth display cells from the LOGICAL line's start (a wrap does not
//     restart the count); syntax colors stay on their glyphs past a tab.

import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import { LAYOUT_PRESETS } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_POS_Z, LANE_ADVANCE } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-3;

const atlas = { getCharSize: () => ({ width: 28, height: 55 }), _slugData: null, _shaper: null };
const scene = new THREE.Scene();

// Rows of varied width (the widest deep in the file, past the first page break), every
// fifth one tab-indented with a mid-line tab — so slots after a tab land on the fold too.
const lines = [];
for (let i = 0; i < 700; i++) {
    const body = `row ${i} ` + 'x'.repeat(i % 37) + (i === 520 ? 'W'.repeat(90) : '');
    lines.push(i % 5 === 0 ? `\t\t${body}\tend` : body);
}
const text = lines.join('\n');

const finite = (b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);

for (const [name, preset] of Object.entries(LAYOUT_PRESETS)) {
    const grid = new CodeGrid(scene, atlas, { showFilename: false });
    await grid.loadText(text);
    await grid.setLayout(preset);
    const d = grid._layout;

    ok(finite(d.extent()), `${name}: description extent is finite (${JSON.stringify(d.extent().min)})`);
    ok(finite(grid._getContentBounds()), `${name}: content bounds finite`);

    // The anchor: row 0's first glyph centers ON the origin (showFilename off → origin y 0).
    const f0 = grid._renderer.slotBuffer.f32;
    ok(near(f0[LANE_POS_Y], 0) && near(f0[LANE_POS_X], 0), `${name}: row 0 anchors on the origin (got ${f0[LANE_POS_X]}, ${f0[LANE_POS_Y]})`);

    // The laid-out ink (the generator's bounds, each cell ± h/2 — what setLayoutExtent is
    // handed, before it adds the shader's right-side overdraw for three's cull box) inside
    // the description's extent.
    const ink = grid._renderer._layoutBounds;
    const e = d.extent(), eps = 1e-3;
    ok(ink.min.x >= e.min.x - eps && ink.max.x <= e.max.x + eps && ink.min.y >= e.min.y - eps
        && ink.max.y <= e.max.y + eps && ink.min.z >= e.min.z - eps && ink.max.z <= e.max.z + eps,
        `${name}: drawn glyphs inside the description's extent (ink y ${ink.min.y.toFixed(2)}…${ink.max.y.toFixed(2)}, extent ${e.min.y.toFixed(2)}…${e.max.y.toFixed(2)})`);

    // Every slot vs positionAt.
    const f32 = grid._renderer.slotBuffer.f32;
    let bad = 0, checked = 0, first = '';
    for (let L = 0; L < lines.length; L++) {
        for (let c = 0; c < d.lineSlotCount(L); c++) {
            const s = d.slotForChar(L, c);
            const p = d.positionAt(L, c);
            const b = s * SLOT_FLOATS;
            checked++;
            if (!near(f32[b + LANE_POS_X], p.x) || !near(f32[b + LANE_POS_Y], p.y) || !near(f32[b + LANE_POS_Z], p.z)) {
                if (!bad) first = `L${L}:${c} slot (${f32[b + LANE_POS_X]}, ${f32[b + LANE_POS_Y]}, ${f32[b + LANE_POS_Z]}) vs fold (${p.x}, ${p.y}, ${p.z})`;
                bad++;
            }
        }
    }
    ok(checked > 10000 && bad === 0, `${name}: ${checked} slots on the fold (${bad} off${first ? '; first ' + first : ''})`);

    grid.dispose?.();
}

// A wrapped line widens the fold by its widest SEGMENT.
{
    const grid = new CodeGrid(scene, atlas, { showFilename: false });
    await grid.loadText('short\n' + 'y'.repeat(1000));
    await grid.setLayout({ wrapWidth: 50, pageHeight: 0 });
    const w = grid._layout.maxRowExtent / grid.metrics.charWidth;
    ok(near(w, 50), `wrapped line: widest row = 50 cols (got ${w.toFixed(1)})`);
    grid.dispose?.();
}

// Tab stops.
{
    const cellsAt = async (text, layout) => {
        const grid = new CodeGrid(scene, atlas, { showFilename: false });
        await grid.loadText(text);
        await grid.setLayout({ pageHeight: 0, ...layout });
        const cw = grid.metrics.charWidth, f = grid._renderer.slotBuffer.f32;
        const xs = [];
        for (let s = 0; s < grid._renderer.slotBuffer.count; s++) xs.push(+(f[s * SLOT_FLOATS + LANE_POS_X] / cw).toFixed(3));
        return { xs, d: grid._layout, grid };
    };
    let r = await cellsAt('a\tb', { tabWidth: 4, wrapWidth: 0 });
    ok(r.xs.length === 3 && r.xs[2] === 4, `'a\\tb' w4: tab owns a slot, b at cell 4 (got ${r.xs})`);
    r = await cellsAt('abcd\tX', { tabWidth: 4, wrapWidth: 0 });
    ok(r.xs[5] === 8, `a tab ON a stop spans a whole stop (X at 8, got ${r.xs[5]})`);
    r = await cellsAt('\t\tX', { tabWidth: 4, wrapWidth: 0 });
    ok(r.xs[2] === 8 && r.d.lineSlotCount(0) === 3, `two tabs: X at 8, 3 slots (got ${r.xs[2]}, ${r.d.lineSlotCount(0)})`);
    r = await cellsAt('a\tb', { tabWidth: 1, wrapWidth: 0 });
    ok(r.xs[2] === 2, `tabWidth 1: a tab is one cell (b at 2, got ${r.xs[2]})`);
    // wrap 4: 'abcd' | 'e' '\t' 'X' — 5 cells before the tab, k = 4 − 5 % 4 = 3, so X sits at
    // segment x 1 + 3 = 4 cells; the tab is ONE column (X is the segment's third slot).
    r = await cellsAt('abcde\tX', { tabWidth: 4, wrapWidth: 4 });
    ok(r.xs[6] === 4 && r.d.lineStartRow.length === 1 && r.d.totalRows === 2,
        `the stop counts from the LOGICAL line across a wrap (X at 4 on row 2, got ${r.xs[6]}, rows ${r.d.totalRows})`);
    const p = r.d.positionAt(0, 6);
    ok(near(p.x / r.grid.metrics.charWidth, 4), `positionAt past a tab reads the real advance (got ${(p.x / r.grid.metrics.charWidth).toFixed(3)})`);

    // Syntax colors: palette bytes 'a' '\t' 'b' → indices 1, 2, 3; each lands on its own slot.
    const { paletteLUT } = await import('../packages/glyph3d-core/src/parsing/syntaxPaletteJob.js');
    r = await cellsAt('a\tb', { tabWidth: 4, wrapWidth: 0 });
    const lut = paletteLUT();
    r.grid._renderer.setGlyphPaletteRange(new Uint8Array([1, 2, 3]), lut, ['a\tb'], r.d.lineSlotBase);
    const ref = await cellsAt('xyz', { wrapWidth: 0 });
    ref.grid._renderer.setGlyphPaletteRange(new Uint8Array([1, 2, 3]), lut, ['xyz'], ref.d.lineSlotBase);
    const col = (g, i) => g._renderer.slotBuffer.getSlot(i).color;
    ok([0, 1, 2].every((i) => col(r.grid, i) === col(ref.grid, i)) && col(r.grid, 0) !== col(r.grid, 2),
        `palette colors stay on their glyphs past a tab (${[0, 1, 2].map((i) => col(r.grid, i).toString(16))})`);
}

console.log(`\n${fail ? '✗' : '✓'} layout-generator-fold: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
