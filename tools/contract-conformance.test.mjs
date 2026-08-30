// contract-conformance.test.mjs — what THIS layer owes the shared contract.
//
//   bun tools/contract-conformance.test.mjs
//
// glyphContract.js declares names and kinds — no strides, no indices, nothing about how
// any layer stores anything. The renderer runs one slot buffer at SLOT_STRIDE 12 and its
// item params in TWO arrays split by carrier (9 measures f32 + 6 exact u32); the native
// backend runs four phase arrays and a 15-lane item table in a DIFFERENT lane order.
// Both are conformant, because container is a per-layer realization and KIND is the
// declared fact.
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

console.log('the item arrays realize every semantic parameter');
{
    // ENUMERATED, not scraped. This used to read `Object.keys(Ref).startsWith('I_')` — a
    // pattern check, which reports what it found and can never report that a spelling was
    // missing. The layer states its mapping in two objects now, and this reads THOSE.
    const M = Ref.ITEM_MEASURE_LANE_OF, X = Ref.ITEM_EXACT_LANE_OF;
    const mine = [...Object.keys(M), ...Object.keys(X)];

    // The COUNT-based companion: each map's lanes must be a PERMUTATION of 0..stride-1.
    // A lane added to a container without a name here does not quietly lower coverage —
    // it breaks the permutation and fails.
    const perm = (obj, stride, what) => {
        const lanes = Object.values(obj).slice().sort((a, b) => a - b);
        ok(lanes.length === stride && lanes.every((v, i) => v === i),
           `${what}: the named lanes are a permutation of 0..${stride - 1} `
           + `(got ${lanes.length} lanes [${lanes}])`);
    };
    perm(M, Ref.ITEM_MEASURE_STRIDE, 'measure array');
    perm(X, Ref.ITEM_EXACT_STRIDE, 'exact array');

    // A name may not live in both arrays — that would be the mixed container again,
    // wearing two hats.
    const both = Object.keys(M).filter((k) => k in X);
    ok(both.length === 0, `no parameter is realized in BOTH carriers (both: [${both}])`);

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

    // DIRECTION 3 — new, and only expressible since the split: the CARRIER must match the
    // declared KIND. While the item table was one mixed uint array this could not be
    // asked, because every lane had the same container and kind lived in a side set that
    // this file would have had to trust. The container is the claim now, so the contract
    // can check it directly: a measure in the exact array (or a count in the float array)
    // is a conformance failure, not a convention someone broke.
    // NOTE ON THE PARTITION: compare against EXACT_FIELDS / MEASURE_FIELDS, never against
    // a literal 'exact'. KIND's values are the FINE kinds — measure / count / identity /
    // bitfield — and there is no 'exact' among them; EXACT_FIELDS is the coarse two-bucket
    // partition the contract publishes for exactly this use. The first version of this
    // tooth tested `KIND[f] !== 'exact'`, which flags every count in the exact array, and
    // the bug was INVISIBLE while a dispute list happened to exclude those same five
    // fields. A temporary exclusion masking a permanent defect is its own small lesson:
    // when the exclusion goes, re-read what it was covering rather than just deleting it.
    const miscarried = [
        ...Object.keys(M).filter((f) => KIND[f] && !MEASURE_FIELDS.includes(f)).map((f) => `${f}(measure array, kind ${KIND[f]})`),
        ...Object.keys(X).filter((f) => KIND[f] && !EXACT_FIELDS.includes(f)).map((f) => `${f}(exact array, kind ${KIND[f]})`),
    ];
    ok(miscarried.length === 0,
       `every item parameter rides the carrier its KIND requires (miscarried: [${miscarried}])`);
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

    // TWO SCOPES, and conflating them was a bug in this file rather than in the code.
    //
    // KNOWN_DEVIATIONS is SYSTEM-WIDE: it records debts the contract tolerates anywhere.
    // LAYER_CLAIMED below is what THIS layer still needs. They are not the same list, and
    // the original version of this tooth asserted the global one against local violations
    // — so the moment this layer paid its debt, it failed with `settled: [GLYPH_ID]` even
    // though the entry was still true of the backend's container. The tripwire fired
    // correctly and pointed at the wrong file.
    //
    // Scoped properly, both halves survive:
    const LAYER_CLAIMED = Object.freeze({
        // (empty) — this layer currently claims no deviation. GLYPH_ID was the last one:
        // an identity on a float lane because decode copied it verbatim from an f32 trie
        // block. The trie is u32 now (identities native, measures bitcast) and the id is
        // exact end to end.
    });

    // 1. Nothing violates without the CONTRACT permitting it.
    const unpermitted = violations.filter((n) => !(n in KNOWN_DEVIATIONS));
    ok(unpermitted.length === 0,
       `no lane violates its KIND without a contract-level deviation (unpermitted: [${unpermitted}])`);

    // 2. Nothing violates without THIS LAYER declaring it needs to. A contract-level
    //    entry is permission, not an excuse — another layer's debt does not cover mine.
    const unclaimed = violations.filter((n) => !(n in LAYER_CLAIMED));
    ok(unclaimed.length === 0,
       `every violation here is claimed by this layer (unclaimed: [${unclaimed}])`);

    // 3. A local claim may not outlive its debt. This is the no-stale-exemption rule,
    //    now asserted against the scope it can actually speak for.
    const staleClaim = Object.keys(LAYER_CLAIMED).filter((n) => !violations.includes(n));
    ok(staleClaim.length === 0,
       `every claimed deviation is still an actual violation here (stale: [${staleClaim}])`);

    // 4. THE FIX, pinned so it cannot silently regress. GLYPH_ID was the pipeline's last
    //    float-carried identity; if it returns to a float lane, this names it.
    ok(!violations.includes('GLYPH_ID'),
       'GLYPH_ID is no longer a violation here — it is an exact lane, native u32');
    ok(Ref.COUNT_LANES.has(Ref.S_GLYPH_ID) && !Ref.FLOAT_LANES.has(Ref.S_GLYPH_ID),
       'S_GLYPH_ID is classified as a count lane');

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
