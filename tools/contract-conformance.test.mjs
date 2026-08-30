// contract-conformance.test.mjs — what THIS layer owes the shared contract.
//
//   bun tools/contract-conformance.test.mjs
//
// glyphContract.js declares names and kinds — no strides, no indices, nothing about how
// any layer stores anything. The renderer runs one slot buffer at SLOT_STRIDE 12 and an
// item table at ITEM_STRIDE 15; the native backend runs two buffers and a 16-lane item
// table. Both are conformant, because container is a per-layer realization and KIND is
// the declared fact.
//
// What each layer owes is ONE assertion: that its own mapping respects the contract. This
// file is the renderer's half. Without it the contract is a file nobody reads — which is
// how ITEM_STRIDE sat at 16 against a live 15 for months with nothing failing.
//
// Both checks are TWO-DIRECTIONAL on purpose. "Every contract field exists here" catches a
// semantic parameter this layer cannot express. "Every lane here is accounted for" catches
// a lane added without deciding what it is. A one-way check misses whichever direction it
// isn't looking, and the direction it isn't looking is where drift accumulates.

import { ITEM_PARAMS, KIND, EXACT_FIELDS, MEASURE_FIELDS, KNOWN_DEVIATIONS }
    from '../packages/glyph3d-core/src/compute/glyphContract.js';
import * as Ref from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };

/** Lanes of THIS layer's item table that realize no contract parameter, with the reason.
 *  Not an escape hatch: the tooth below fails if one of these ever DOES appear in
 *  ITEM_PARAMS, so an entry cannot outlive its justification. */
const REALIZATION_ONLY = Object.freeze({
    BYTE_COUNT: 'the item\'s byte extent, not its layout — ownership is explicit in this '
        + 'table so a byte resolves to an item without a side structure. The backend keeps '
        + 'the same fact beside its params rather than in them.',
});

console.log('the item table realizes every semantic parameter');
{
    const mine = Object.keys(Ref).filter((k) => k.startsWith('I_')).map((k) => k.slice(2));
    ok(mine.length > 0, 'the item table exports I_* lanes (the extraction still works)');

    // DIRECTION 1 — a parameter the contract declares and this layer cannot express is a
    // behaviour the backend can have and the renderer cannot reproduce. That gap is
    // invisible to conformance, which only compares outputs on inputs both sides accept.
    const missing = ITEM_PARAMS.filter((p) => !mine.includes(p));
    ok(missing.length === 0,
       `every contract item parameter is realized by a lane here (missing: [${missing}])`);

    // DIRECTION 2 — a lane here that realizes nothing must SAY so. PAGE_LINE_HEIGHT lived
    // in the backend's table for months realizing nothing, and was found by measurement
    // rather than by a check.
    const extra = mine.filter((f) => !ITEM_PARAMS.includes(f));
    const undeclared = extra.filter((f) => !(f in REALIZATION_ONLY));
    ok(undeclared.length === 0,
       `every extra lane declares itself realization-only (undeclared: [${undeclared}])`);

    // ...and a declaration may not outlive its reason.
    const stale = Object.keys(REALIZATION_ONLY).filter((f) => ITEM_PARAMS.includes(f));
    ok(stale.length === 0,
       `no realization-only declaration names a lane the contract now considers semantic `
       + `(stale: [${stale}])`);
}

console.log('every lane respects its declared KIND');
{
    const nameOf = {};
    for (const k of Object.keys(Ref)) if (k.startsWith('S_')) nameOf[Ref[k]] = k.slice(2);

    const violations = [];
    for (const lane of Ref.FLOAT_LANES) {
        const n = nameOf[lane];
        if (EXACT_FIELDS.includes(n)) violations.push(n);
    }
    for (const lane of Ref.COUNT_LANES) {
        const n = nameOf[lane];
        if (MEASURE_FIELDS.includes(n)) violations.push(n);
    }

    // An EXACT field on a float carrier is the defect this whole line of work removed —
    // and "exact in practice" is the argument the ordered-key wall died of. The contract
    // permits declared, justified debts; it does not permit silent ones.
    const undeclared = violations.filter((n) => !(n in KNOWN_DEVIATIONS));
    ok(undeclared.length === 0,
       `no lane violates its KIND without a declared deviation (undeclared: [${undeclared}])`);

    // A deviation list that outlives its deviation is a permanent hole with a comment on
    // it. Every declared debt must still BE a debt.
    const settled = Object.keys(KNOWN_DEVIATIONS).filter((n) => !violations.includes(n));
    ok(settled.length === 0,
       `every KNOWN_DEVIATION is still an actual violation — a settled debt must be `
       + `removed, not left as a standing exemption (settled: [${settled}])`);

    // The one live debt, named, so its disappearance is visible in a diff.
    ok(violations.includes('GLYPH_ID'),
       'GLYPH_ID is still the declared deviation (it rides the trie\'s f32 blocks; the fix '
       + 'is u32 glyph ids in the trie format, a layer below both of us)');

    // The partition the binary lane guard depends on.
    ok(EXACT_FIELDS.every((f) => !MEASURE_FIELDS.includes(f)),
       'EXACT_FIELDS and MEASURE_FIELDS are disjoint');
    const kinds = Object.keys(KIND);
    const uncovered = kinds.filter((f) => !EXACT_FIELDS.includes(f) && !MEASURE_FIELDS.includes(f));
    ok(uncovered.length === 0,
       `every KIND field has a side of the exact/measure partition (uncovered: [${uncovered}])`);
}

console.log(fail === 0 ? `\n✓ contract-conformance: ${pass} passed, 0 failed`
                       : `\n✗ contract-conformance: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
