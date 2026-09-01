// slot-type-discipline.test.mjs — the shader side of the SPLIT slot record.
//
//   bun tools/slot-type-discipline.test.mjs
//
// The slot record is TWO arrays now: an f32 array of measures beside a u32 array of
// exact lanes. Every consumer must agree, and the three shader-side consumers are the
// ones no other test can see:
//
//   - GlyphField's byteSlotM / byteSlotX storage nodes
//   - PickingSystem's byteSlotM / byteSlotX storage nodes
//   - the vertex path's index arithmetic and per-lane reads (glyphVertex.js)
//
// WHAT CHANGED, and it is why this file got stronger rather than shorter. It used to
// guard a DISCIPLINE: one uint buffer, count lanes native, measure lanes bitcast, and
// every reader remembering which was which. Declaring the node 'float' over that buffer
// reinterpreted every count lane as denormal garbage; indexing in i32 halved the arena's
// reach. Both bugs shipped, both were caught by a human reading a diff, and a review
// later reverted all three at once and watched 48 test files stay green.
//
// Split, most of that discipline is structural — a measure read as a count is a read of
// a different array. So the teeth here move up a level: assert that each node's declared
// type matches the buffer it points at, that the index arithmetic is unsigned, and above
// all that NO BITCAST survives in the slot path. That last one is the whole migration
// stated as a property: there is nothing left to reinterpret.
//
// Nothing in this tree executes a TSL node graph, so this remains a static check over
// source — a weak instrument, and still strictly better than an unguarded seam.

import { readFileSync } from 'node:fs';
import { VERTEX_READ } from '../packages/glyph3d-core/src/compute/glyphContract.js';
import { SLOT_MEASURE_STRIDE, SLOT_EXACT_STRIDE, RENDER_MEASURE_COUNT, RENDER_EXACT_COUNT,
    M_X, M_Y, M_Z, M_ADVANCE, M_HEIGHT, M_BASE_X, M_LINE_ADV,
    E_GLYPH_ID, E_ROW, E_COL, E_FLAGS, E_ORD } from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';

/** lane index -> the contract's field name, per array. DERIVED from the lane exports so
 *  the mapping cannot drift from the tables it describes. */
const M_NAME = { [M_X]: 'X', [M_Y]: 'Y', [M_Z]: 'Z', [M_ADVANCE]: 'ADVANCE',
    [M_HEIGHT]: 'HEIGHT', [M_BASE_X]: 'BASE_X', [M_LINE_ADV]: 'LINE_ADV' };
const E_NAME = { [E_GLYPH_ID]: 'GLYPH_ID', [E_ROW]: 'ROW', [E_COL]: 'COL',
    [E_FLAGS]: 'FLAGS', [E_ORD]: 'ORD' };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('each storage node is declared as the array it points at');
{
    // The declaration is what the shader reads the memory AS. WGSL binds the same bytes
    // under either type with no validation error, so a mismatch here is silent — which
    // is exactly how a stale 'float' over the old mixed buffer went unnoticed.
    const WANT = [
        { kind: 'm', type: 'float', array: 'Float32Array', field: '_byteSlotM' },
        { kind: 'x', type: 'uint', array: 'Uint32Array', field: '_byteSlotX' },
    ];
    for (const p of ['packages/glyph3d-core/src/GlyphField.js',
                     'packages/glyph3d-core/src/picking/PickingSystem.js']) {
        const src = read(p);
        // Bounded per-occurrence: an unbounded [\s\S]*? between the storage() call and
        // the carrier tag will happily span from one declaration's storage() to the NEXT
        // one's tag, pairing a placeholder with the wrong type. Slice a window instead.
        const decls = [];
        for (const m of src.matchAll(/registerByteSlotsNode\(/g)) {
            const win = src.slice(m.index, m.index + 400);
            const st = win.match(/storage\(\s*(\w+)\s*,\s*'(\w+)'/);
            const kd = win.match(/,\s*'([mx])'\s*\)/);
            if (st && kd) decls.push([null, st[1], st[2], kd[1]]);
        }
        ok(decls.length === 2,
           `${p}: exactly two byte-slot nodes are registered, one per carrier (found ${decls.length})`);
        for (const w of WANT) {
            const d = decls.find((m) => m[3] === w.kind);
            ok(d !== undefined, `${p}: a node is registered under carrier '${w.kind}'`);
            ok(d?.[2] === w.type,
               `${p}: the '${w.kind}' node is storage(..., '${w.type}') (got '${d?.[2]}')`);
            // The placeholder backing it must match, or three infers the wrong element type.
            const phm = d && src.match(new RegExp(`${d[1]}\\s*=\\s*new StorageInstancedBufferAttribute\\(new (\\w+)\\(`));
            ok(phm?.[1] === w.array,
               `${p}: the '${w.kind}' placeholder is a ${w.array} (got ${phm?.[1]})`);
            ok(new RegExp(`${w.field}\\b`).test(src),
               `${p}: the '${w.kind}' node resolves from ${w.field}`);
        }
    }
}

console.log('the vertex path indexes unsigned and reinterprets NOTHING');
{
    const src = read('packages/glyph3d-core/src/core/glyphVertex.js');

    // i32 indexing halves the arena's addressable reach — the prerequisite that had to
    // land before the ceiling could rise at all.
    ok(/const bm = instanceIndex\.mul\(uint\(SLOT_MEASURE_STRIDE\)\)/.test(src),
       'the measure base is instanceIndex.mul(uint(SLOT_MEASURE_STRIDE)) — int() halves the reach');
    ok(/const bx = instanceIndex\.mul\(uint\(SLOT_EXACT_STRIDE\)\)/.test(src),
       'the exact base is instanceIndex.mul(uint(SLOT_EXACT_STRIDE))');
    ok(!/int\(instanceIndex\)/.test(src),
       'instanceIndex is not narrowed to int (it is natively unsigned)');

    // THE MIGRATION, AS A PROPERTY. Every bitcast in this path existed to move a value
    // between a kind and a container that disagreed. None can be correct now: a measure
    // read from the f32 array IS a float, and an exact lane read from the u32 array must
    // CONVERT (.toFloat()), never reinterpret. One bitcast anywhere here is a regression
    // to the thing this whole change deleted.
    ok(!/bitcast/.test(src),
       'glyphVertex contains NO bitcast — nothing in the slot path reinterprets a carrier');

    // Measures are read raw from the measure node; exact lanes convert from the exact node.
    for (const n of ['M_X', 'M_Y', 'M_Z', 'M_ADVANCE', 'M_HEIGHT']) {
        ok(new RegExp(`byteSlotM\\.element\\(bm\\.add\\(int\\(${n}\\)\\)\\)`).test(src),
           `${n} is read from byteSlotM directly (no cast)`);
    }
    for (const n of ['E_GLYPH_ID', 'E_ROW', 'E_COL']) {
        ok(new RegExp(`byteSlotX\\.element\\(bx\\.add\\(int\\(${n}\\)\\)\\)\\.toFloat\\(\\)`).test(src),
           `${n} CONVERTS from byteSlotX (.toFloat()) rather than reinterpreting`);
    }

    // Y and Z were addressed POSITIONALLY as `S_X + 1` / `S_X + 2`, with a comment
    // admitting a search for S_Y or S_Z would not find them. Named lanes only.
    ok(!/\+\s*1\)\)|\+\s*2\)\)/.test(src.match(/iPos\s*=\s*vec4\(([^;]*)\);/)?.[1] ?? ''),
       'iPos addresses Y and Z by NAME, not as offsets from X');
}

console.log('the render-read lane set is a prefix of BOTH arrays');
{
    // WHY THIS EXISTS, and it is not for this repo's benefit.
    //
    // A record emission copies a PREFIX of the slot lanes (the contract: emitting one is
    // a TRUNCATION of what the producer keeps, never a repack). That is only sound while
    // every lane the render path reads sorts BEFORE every lane it does not — otherwise
    // the copy becomes a gather and the format silently changes cost and shape. "Which
    // lanes the render path reads" is a fact about glyphVertex.js, i.e. about THIS repo,
    // so the invariant is only as good as a guard on this side.
    //
    // It also makes this layer's containers a structural prefix of the native backend's
    // GlyphRecord — [f32;5] + [u32;3] with a 32-byte assert.
    const src = read('packages/glyph3d-core/src/core/glyphVertex.js');

    const files = ['packages/glyph3d-core/src/GlyphField.js',
                   'packages/glyph3d-core/src/picking/PickingSystem.js'];
    for (const f of files) {
        ok(!/byteSlot[MX]\.element\(/.test(read(f)),
           `${f} reads slot lanes only through buildGlyphVertexTransform, never directly`);
    }

    const M_SYM = { M_X, M_Y, M_Z, M_ADVANCE, M_HEIGHT, M_BASE_X, M_LINE_ADV };
    const E_SYM = { E_GLYPH_ID, E_ROW, E_COL, E_FLAGS, E_ORD };
    const readM = new Set(), readX = new Set();
    for (const m of src.matchAll(/byteSlotM\.element\(bm\.add\(int\((\w+)\)\)\)/g)) {
        if (M_SYM[m[1]] === undefined) { fail++; console.error(`  ✗ unknown measure lane ${m[1]}`); continue; }
        readM.add(M_SYM[m[1]]);
    }
    for (const m of src.matchAll(/byteSlotX\.element\(bx\.add\(int\((\w+)\)\)\)/g)) {
        if (E_SYM[m[1]] === undefined) { fail++; console.error(`  ✗ unknown exact lane ${m[1]}`); continue; }
        readX.add(E_SYM[m[1]]);
    }

    // PROVE THE SEARCH WAS EXHAUSTIVE, not just that it found things.
    //
    // Everything above rests on a REGEX finding every lane read. A read spelled any other
    // way — a helper, a computed index, uint() instead of int() — is invisible to it, and
    // an extraction that silently stops being complete keeps reporting a green SUBSET.
    // So count the access sites independently of the pattern: every `byteSlotM.element(`
    // and `byteSlotX.element(` must be one the extraction matched. A new access in any
    // spelling raises the count and fails here rather than lowering coverage quietly.
    const siteM = (src.match(/byteSlotM\.element\(/g) || []).length;
    const siteX = (src.match(/byteSlotX\.element\(/g) || []).length;
    ok(siteM === readM.size,
       `every byteSlotM.element() site was extracted (${siteM} sites vs ${readM.size} lanes) — `
       + `an unaccounted site means the set below is a SUBSET reported as the whole surface`);
    ok(siteX === readX.size,
       `every byteSlotX.element() site was extracted (${siteX} sites vs ${readX.size} lanes)`);

    const gotM = [...readM].sort((a, b) => a - b);
    const gotX = [...readX].sort((a, b) => a - b);
    ok(gotM.length > 0 && gotX.length > 0, 'lane reads were actually extracted (the regexes still match)');

    // THE INVARIANT a record truncates on — per array, since there are two now.
    ok(gotM.every((l, i) => l === i),
       `measure reads are a contiguous prefix 0..${gotM.length - 1} (got [${gotM}])`);
    ok(gotX.every((l, i) => l === i),
       `exact reads are a contiguous prefix 0..${gotX.length - 1} (got [${gotX}])`);
    ok(gotM.length === RENDER_MEASURE_COUNT,
       `the measure prefix is RENDER_MEASURE_COUNT (${gotM.length} vs ${RENDER_MEASURE_COUNT})`);
    ok(gotX.length === RENDER_EXACT_COUNT,
       `the exact prefix is RENDER_EXACT_COUNT (${gotX.length} vs ${RENDER_EXACT_COUNT})`);

    // THE CONTRACT STATES THIS SET; THIS FILE VERIFIES IT AGAINST THE SOURCE.
    // Two sources of truth for one fact is how ITEM_STRIDE drifted to 16 against a live
    // 15 without anything failing. The contract may STATE it; this side CHECKS it, and a
    // divergence fails here, where the source is.
    {
        const declared = [...VERTEX_READ].sort();
        const extracted = [...gotM.map((l) => M_NAME[l]), ...gotX.map((l) => E_NAME[l])].sort();
        ok(extracted.every((n) => n !== undefined),
           `every read lane maps to a contract field name (got [${extracted}])`);
        ok(JSON.stringify(declared) === JSON.stringify(extracted),
           `the contract's VERTEX_READ matches what glyphVertex actually reads\n`
           + `      contract:  [${declared}]\n      extracted: [${extracted}]`);
    }

    // The fold scratch sorts after the prefix, in each array.
    const unreadM = [M_BASE_X, M_LINE_ADV].sort((a, b) => a - b);
    const unreadX = [E_FLAGS, E_ORD].sort((a, b) => a - b);
    ok(unreadM.every((l) => l >= gotM.length), `measure scratch [${unreadM}] sorts after the prefix`);
    ok(unreadX.every((l) => l >= gotX.length), `exact scratch [${unreadX}] sorts after the prefix`);
    ok(gotM.length + unreadM.length === SLOT_MEASURE_STRIDE,
       `read + scratch covers the measure array (${gotM.length} + ${unreadM.length} vs ${SLOT_MEASURE_STRIDE})`);
    ok(gotX.length + unreadX.length === SLOT_EXACT_STRIDE,
       `read + scratch covers the exact array (${gotX.length} + ${unreadX.length} vs ${SLOT_EXACT_STRIDE})`);
}

console.log(fail === 0 ? `\n✓ slot-type-discipline: ${pass} passed, 0 failed`
                       : `\n✗ slot-type-discipline: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
