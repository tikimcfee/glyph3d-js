// layout-generator-fold.test.mjs — the slots LayoutGenerator writes and the LayoutDescription
// CodeGrid answers caret / pick / extent queries with are ONE fold, under every preset.
//   bun tools/layout-generator-fold.test.mjs
//
// Drives a real CodeGrid (headless, mock atlas) through the grid.layout presets and asserts:
//   - the description's extent is finite (a NaN page fold blacked the screen on newspaper:
//     the fold read metrics.lineSpacing off a grid whose metrics said lineHeight);
//   - every slot sits where positionAt says its (line, col) is — x and z exact, y on the
//     cell's vertical center (the slot anchor) half a cell above the fold's row edge. The
//     widest row sits past the first page break, so a column stride taken from the RUNNING
//     widest row (not the final one) lands slots off the fold;
//   - a wrapped line widens the fold by its widest segment, not its length.

import * as THREE from 'three';
import CodeGrid from '../packages/glyph3d-core/src/collections/CodeGrid.js';
import { LAYOUT_PRESETS } from '../packages/glyph3d-core/src/workers/builders/index.js';
import { SLOT_FLOATS, LANE_POS_X, LANE_POS_Y, LANE_POS_Z, LANE_ADVANCE } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-3;

const atlas = { getCharSize: () => ({ width: 28, height: 55 }), _slugData: null, _shaper: null };
const scene = new THREE.Scene();

// Tab-free (tabs own no slot — see the caret note in the CF report), rows of varied width
// so the widest row sits deep in the file, past the first page break.
const lines = [];
for (let i = 0; i < 700; i++) lines.push(`row ${i} ` + 'x'.repeat(i % 37) + (i === 520 ? 'W'.repeat(90) : ''));
const text = lines.join('\n');

const finite = (b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);

for (const [name, preset] of Object.entries(LAYOUT_PRESETS)) {
    const grid = new CodeGrid(scene, atlas, { showFilename: false });
    await grid.loadText(text);
    await grid.setLayout(preset);
    const d = grid._layout;
    const ch = grid.metrics.charHeight;

    ok(finite(d.extent()), `${name}: description extent is finite (${JSON.stringify(d.extent().min)})`);
    ok(finite(grid._getContentBounds()), `${name}: content bounds finite`);

    // Every slot vs positionAt.
    const f32 = grid._renderer.slotBuffer.f32;
    let bad = 0, checked = 0, first = '';
    for (let L = 0; L < lines.length; L++) {
        for (let c = 0; c < d.lineSlotCount(L); c++) {
            const s = d.slotForChar(L, c);
            const p = d.positionAt(L, c);
            const b = s * SLOT_FLOATS;
            checked++;
            if (!near(f32[b + LANE_POS_X], p.x) || !near(f32[b + LANE_POS_Y], p.y - ch * 0.5) || !near(f32[b + LANE_POS_Z], p.z)) {
                if (!bad) first = `L${L}:${c} slot (${f32[b + LANE_POS_X]}, ${f32[b + LANE_POS_Y]}, ${f32[b + LANE_POS_Z]}) vs fold (${p.x}, ${p.y - ch * 0.5}, ${p.z})`;
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

console.log(`\n${fail ? '✗' : '✓'} layout-generator-fold: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
