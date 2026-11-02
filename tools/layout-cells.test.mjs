// layout-cells.test.mjs — MONOSPACE pen discipline in core/LayoutGenerator: the pen steps whole
// cells (charWidth each) while every glyph's quad keeps its TRUE advance (ax/upem × emWorld).
//
//   bun tools/layout-cells.test.mjs
//
// Why it matters: at a whole-pixel cell (the plane view's 8×15) every column then starts at the
// same pixel phase, and glyphs sit exactly on the grid tabs, cursors and highlights count by. The
// old pen stepped the shaped advance through a stale ×1/1.15 em guess — 2.2% short of the cell, so
// column 80 sat ~1.7 cells left of where the cell grid put it, and ink drew 1.5% narrow.
//
// Locks:
//   - a run of 1-cell glyphs: glyph k's pen x = origin + k·charWidth, exactly
//   - a 2-cell glyph (an emoji) steps two cells; a zero-width mark steps none
//   - a tab steps to the next stop
//   - the advance lane (the quad width) is ax/upem × emWorld — the ink is never stretched to the cell
//   - metrics handed in without emWorld are refused (a hand-built metrics object would mis-size every glyph)

import { generateLayout } from '../packages/glyph3d-core/src/core/LayoutGenerator.js';
import { computeCellMetrics } from '../packages/glyph3d-core/src/core/cellMetrics.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);

const upem = 2048;
// Cousine-like: 'M' advance 1229/2048 em at a 48 px atlas → a 29 px cell (ceil 28.80).
const AX = { narrow: 1229, wide: 2458, mark: 0 };
const shaper = {
    upem,
    lookup(cp) {
        if (cp === 0x1F600) return { g: 600, ax: AX.wide };      // emoji: two cells
        if (cp === 0x0301) return { g: 301, ax: AX.mark };       // combining acute: no cell
        return { g: cp, ax: AX.narrow };
    },
};
const ws = 0.025;
const metrics = { ...computeCellMetrics({ width: 29, height: 54.375, em: 48 }, ws), worldScale: ws };
const cw = metrics.charWidth;
const trueNarrow = AX.narrow / upem * metrics.emWorld;
const origin = { x: 0, y: 0, z: 0 };

const slots = (layout) => Array.from({ length: layout.glyphCount }, (_, i) => {
    const g = layout.buffer.getSlot(i);
    return { x: g.pos[0], advance: g.advance };
});
const F32 = 1e-6;   // slot lanes are float32

// 1. 1-cell glyphs land exactly on the cell grid; quads keep the true advance.
{
    const L = generateLayout('abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3), { shaper, metrics, origin });
    const s = slots(L);
    const drift = s.map((g, k) => Math.abs(g.x - k * cw));
    const worst = Math.max(...drift);
    ok(s.length === 108 && drift.every((d) => d <= F32 * 100), `pen x = k·charWidth for all ${s.length} glyphs (worst drift ${worst})`);
    near(s[5].advance, trueNarrow, F32, 'the quad is the true advance, not the cell');
    ok(s[5].advance < cw, 'the true advance is under the cell (ceil’d cell): ink not stretched');
}

// 2. wide glyphs step two cells; marks step none.
{
    const L = generateLayout('a\u{1F600}b éx', { shaper, metrics, origin });
    const s = slots(L);
    // a=0, 😀=1 (2 cells), b=3, ' '=4, e=5, ◌́=6 (0 cells, sits after e), x=6
    const xs = s.map((g) => +(g.x / cw).toFixed(5));
    ok(JSON.stringify(xs) === JSON.stringify([0, 1, 3, 4, 5, 6, 6]), `cells: [${xs}]`);
    near(s[1].advance, AX.wide / upem * metrics.emWorld, F32, 'the emoji quad is its true (double) advance');
}

// 3. tabs go to the next stop.
{
    const L = generateLayout('ab\tc', { shaper, metrics, origin, tabWidth: 4 });
    const s = slots(L);
    near(s[3].x / cw, 4, F32, 'a tab after 2 cells steps to column 4');
}

// 4. hand-built metrics without emWorld are refused.
{
    let threw = false;
    try { generateLayout('x', { shaper, metrics: { charWidth: cw, charHeight: metrics.charHeight, lineSpacing: metrics.lineSpacing }, origin }); }
    catch (e) { threw = /emWorld/.test(e.message); }
    ok(threw, 'metrics without emWorld throw, naming it');
}

console.log(`${fails ? 'FAIL' : 'ok'} layout-cells: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
