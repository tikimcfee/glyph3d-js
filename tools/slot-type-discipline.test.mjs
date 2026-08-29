// slot-type-discipline.test.mjs — the shader side of the u32 slot buffer.
//
//   bun tools/slot-type-discipline.test.mjs
//
// The slot buffer is a Uint32Array: COUNT lanes are stored natively, FLOAT lanes are
// bitcast. Every consumer must agree, and the three shader-side consumers are the ones
// no other test can see:
//
//   - GlyphField's byteSlots storage node
//   - PickingSystem's byteSlots storage node
//   - the vertex path's index arithmetic and per-lane reads (glyphVertex.js)
//
// Declaring those nodes 'float' over a u32 buffer reinterprets every count lane as
// denormal garbage; indexing in i32 halves the arena's reach. Both bugs shipped. Both
// were caught by a human reading the diff, and a review later proved the point by
// reverting all three at once: 48 test files stayed green. Nothing in this tree
// executes a TSL node graph, and the far-LOD path these feed (vRowCol -> far UV) has no
// GPU gate either — so the guard that exists is this one, over the source.
//
// A static check is a weak instrument and this file should be deleted the day a GPU
// gate renders a far-LOD glyph and asserts its texel. Until then an unguarded seam is
// strictly worse than a shallow guard on it.

import { readFileSync } from 'node:fs';
import { SLOT_STRIDE, FLOAT_LANES, COUNT_LANES } from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('the byteSlots storage nodes are uint');
{
    for (const p of ['packages/glyph3d-core/src/GlyphField.js',
                     'packages/glyph3d-core/src/picking/PickingSystem.js']) {
        const src = read(p);
        const decl = src.match(/registerByteSlotsNode\(\s*storage\(\s*(\w+)\s*,\s*'(\w+)'/);
        ok(decl !== null, `${p}: the byteSlots node is declared through registerByteSlotsNode(storage(...))`);
        ok(decl?.[2] === 'uint',
           `${p}: byteSlots is storage(..., 'uint') — 'float' reinterprets every count lane (got '${decl?.[2]}')`);
        // The placeholder backing it must match, or three infers the wrong element type.
        const ph = new RegExp(`${decl?.[1]}\\s*=\\s*new StorageInstancedBufferAttribute\\(new (\\w+)\\(`);
        const phm = src.match(ph);
        ok(phm?.[1] === 'Uint32Array',
           `${p}: the placeholder attribute is a Uint32Array (got ${phm?.[1]})`);
    }
}

console.log('the vertex path indexes in u32 and reads per lane kind');
{
    const src = read('packages/glyph3d-core/src/core/glyphVertex.js');

    // i32 indexing halves the arena's addressable reach — the exact prerequisite that
    // had to land before the ceiling could rise at all.
    ok(/const base = instanceIndex\.mul\(uint\(SLOT_STRIDE\)\)/.test(src),
       "the slot base index is instanceIndex.mul(uint(SLOT_STRIDE)) — int() halves the reach");
    ok(!/int\(instanceIndex\)/.test(src),
       'instanceIndex is not narrowed to int (it is natively unsigned)');

    // Float lanes reinterpret; count lanes convert. Swapping them is silent.
    const fl = src.match(/const fl = \(l\) => (.*);/)?.[1] ?? '';
    ok(/^bitcast\(byteSlots\.element\(.*\), 'float'\)$/.test(fl),
       `float lanes are read with bitcast(..., 'float'), not .toFloat() (got: ${fl})`);
    const rowcol = src.match(/iRowCol\s*=\s*vec2\(([^;]*)\);/)?.[1] ?? '';
    ok(/S_ROW/.test(rowcol) && /S_COL/.test(rowcol), 'iRowCol reads the S_ROW / S_COL lanes');
    ok((rowcol.match(/\.toFloat\(\)/g) || []).length === 2,
       'both count lanes CONVERT (.toFloat()) rather than reinterpret — bitcast here yields denormals');
    ok(!/bitcast/.test(rowcol), 'no bitcast on a count lane');

    // Every lane the vertex path names must be classified, and read the matching way.
    for (const [name, lane] of Object.entries({ S_X: null, S_ADVANCE: null, S_HEIGHT: null, S_GLYPH_ID: null })) {
        ok(new RegExp(`fl\\(${name}`).test(src), `${name} is read through the float-lane helper`);
        void lane;
    }
    ok(FLOAT_LANES.size + COUNT_LANES.size === SLOT_STRIDE,
       `the lane kinds still cover the stride (${FLOAT_LANES.size} + ${COUNT_LANES.size} vs ${SLOT_STRIDE})`);
}

console.log(fail === 0 ? `\n✓ slot-type-discipline: ${pass} passed, 0 failed`
                       : `\n✗ slot-type-discipline: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
