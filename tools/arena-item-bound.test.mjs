// arena-item-bound.test.mjs — the PER-ITEM ordinal bound.
//
//   bun tools/arena-item-bound.test.mjs
//
// The count lanes (S_ORD/S_ROW/S_COL) are f32 and ITEM-RELATIVE — the fold resets
// them at every item start — so their exactness is bounded by the largest single
// ITEM, never by the arena total. Past 2^24 a lane stops representing consecutive
// integers and two glyphs fold onto one ordinal, while addressing (all u32) stays
// perfectly exact: nothing errors, the layout is just quietly wrong.
//
// The arena's global cap only PROXIES that rule. Until the assert under test, the
// real bound held by routing alone — READABLE_MAX_CHARS in the load path — which
// synthetic producers (terminal grids, generated content, direct stage() callers)
// never pass through. These lock the assert, both directions: it must fire above
// the wall AND stay silent below it, or it is decoration.
//
// No GPU: the check is arithmetic on the staging path, reached through a prototype
// shell so no device, trie or atlas is needed.

import GlyphPipelineArena from '../packages/glyph3d-core/src/compute/GlyphPipelineArena.js';
import { KERNEL_MAX_BYTES } from '../packages/glyph3d-core/src/compute/glyphPipelineKernels.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
// IMPORTED, never restated. A hand-copied stride and a hand-copied formula here
// would be the same duplicate-constant bug this file exists to guard against.
const WALL = KERNEL_MAX_BYTES;

/** An arena shell with only the state stage()'s guard reads before it allocates. */
function shell() {
    const a = Object.create(GlyphPipelineArena.prototype);
    a.maxItems = 1 << 20;
    a._liveCount = 0;
    return a;
}

/**
 * Run stage()'s guard on a claim and return ONLY a wall refusal, else null.
 *
 * stage() carries on past the guard into allocation, which throws for unrelated
 * reasons in a bare shell — so "any error" is not "refused". Matching the wall
 * message is what separates the guard firing from the shell falling over, and
 * getting that wrong is how a test reports a pass it never earned.
 */
function claim({ bytes, leaders = 0 }) {
    // A real Uint8Array of 2^24 would cost 16MB per case and prove nothing extra —
    // the guard reads .length, so a length-only stand-in exercises the same path.
    const fake = { length: bytes };
    try { shell().stage({ bytes: fake, leaders }); return null; }
    catch (e) { return /one item claims/.test(e.message) ? e.message : null; }
}

console.log('bytes fallback (synthetic sources: no bake record)');
{
    ok(claim({ bytes: WALL - 2 }) === null, 'an item just under the wall passes the guard');

    const over = claim({ bytes: WALL + 2 });
    ok(over !== null && /one item claims/.test(over), 'an item just over the wall is refused');
    ok(/conservative: no leader count supplied/.test(over || ''),
       'the refusal says the byte bound is conservative');
    console.log(`    ${String(over).split('—')[0].trim()}…`);
}

console.log('leader count (callers with a bake record)');
{
    // The point of passing leaders: a multi-byte corpus is safe on its real glyph
    // count while its BYTE count would trip the conservative fallback. 4 bytes per
    // glyph (CJK/emoji) is the worst case UTF-8 offers.
    const bytes = WALL + 1024;
    ok(claim({ bytes }) !== null, 'a 16MB+ item is refused on bytes alone');
    ok(claim({ bytes, leaders: Math.floor(bytes / 4) }) === null,
       'the same item is ACCEPTED on its real leader count — the fallback was pessimistic');

    // …but leaders is a bound, not a bypass: a genuinely huge glyph count still fails.
    const over = claim({ bytes: WALL * 8, leaders: WALL + 1 });
    ok(over !== null && /one item claims/.test(over), 'a real leader count past the wall is still refused');
    ok(/glyphs/.test(over || '') && !/conservative/.test(over || ''),
       'the refusal names glyphs, not a conservative byte guess');
}

console.log('the boundary itself');
{
    ok(claim({ bytes: WALL }) === null, 'exactly at the ceiling is allowed');
    ok(claim({ bytes: WALL + 1 }) !== null, 'one past the ceiling is refused');
    ok(claim({ bytes: 1 }) === null, 'an ordinary small item is untouched');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} arena-item-bound: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
