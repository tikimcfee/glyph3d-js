// layout.test.mjs — headless unit test for the pure box-packing primitives
// (flowBoxes / squareWrap) that every layout scheme builds on. No three, no GPU.
//   bun tools/layout.test.mjs

import { flowBoxes, squareWrap } from '../packages/glyph3d-core/src/collections/layouts/flowBoxes.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`);

// single box: one slot at origin, extent = the box, one row
{
  const f = flowBoxes([{ w: 10, h: 4 }], { margin: 5 });
  eq(f.slots, [{ x: 0, y: 0, row: 0 }], 'single: slot at origin');
  eq([f.width, f.height, f.rows], [10, 4, 1], 'single: extent = box, 1 row');
}

// no wrap: boxes march right; width = sum + margins between, height = tallest
{
  const f = flowBoxes([{ w: 10, h: 4 }, { w: 10, h: 6 }], { margin: 5 });
  eq(f.slots, [{ x: 0, y: 0, row: 0 }, { x: 15, y: 0, row: 0 }], 'no-wrap: second box at x = w+margin');
  eq([f.width, f.height, f.rows], [25, 6, 1], 'no-wrap: width=sum+margin, height=tallest');
}

// wrap: at wrapWidth 25 two 10-wide boxes fit per row (0 and 15); the third wraps.
{
  const f = flowBoxes([{ w: 10, h: 4 }, { w: 10, h: 4 }, { w: 10, h: 4 }], { margin: 5, wrapWidth: 25 });
  eq(f.slots.map((s) => s.x), [0, 15, 0], 'wrap: row1 holds two (x 0,15), third returns to x=0');
  ok(f.rows === 2, 'wrap: three boxes, two-per-row → 2 rows');
  ok(f.slots[2].y < 0, 'wrap: wrapped box descends (y < 0)');
}

// squareWrap: 0–1 boxes → no wrap; many → finite positive, aspect-corrected
{
  ok(squareWrap([], 8) === Infinity, 'squareWrap: empty → Infinity');
  ok(squareWrap([{ w: 10, h: 4 }], 8) === Infinity, 'squareWrap: single → Infinity');
  const many = Array.from({ length: 9 }, () => ({ w: 20, h: 4 }));
  const ww = squareWrap(many, 8);
  ok(Number.isFinite(ww) && ww > 0, 'squareWrap: many → finite positive wrap width');
  // wide items (w≫h) → fewer columns than sqrt(n): 9 boxes would be 3 cols naively, aspect → fewer
  ok(ww < 3 * (20 + 8), 'squareWrap: wide items use fewer columns than a naive sqrt grid');
}

console.log(`\nlayout: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
