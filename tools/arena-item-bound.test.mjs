// arena-item-bound.test.mjs — the PER-ITEM ordinal bound.
//
//   bun tools/arena-item-bound.test.mjs
//
// The count lanes (S_ORD/S_ROW/S_COL) are ITEM-RELATIVE — the fold resets them at
// every item start — so any bound on them is bounded by the largest single ITEM,
// never by the arena total. That is the rule this file locks, and it outlived the
// defect that motivated it: the lanes rode f32 slots then, so past 2^24 a lane
// stopped representing consecutive integers and two glyphs folded onto one ordinal
// while addressing stayed perfectly exact — nothing errored, the layout was just
// quietly wrong. They are native u32 now and that failure mode is gone; the bound
// is kept as a deliberate assertion of the item-relative invariant itself (see
// GlyphPipelineArena.stage()).
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
import { ARENA_MAX_BYTES } from '../packages/glyph3d-core/src/compute/glyphPipelineKernels.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
// IMPORTED, never restated. A hand-copied stride and a hand-copied formula here
// would be the same duplicate-constant bug this file exists to guard against.
const WALL = ARENA_MAX_BYTES;   // the arena's bound is what it can BUILD, not what a u32 index can address

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

/** Same shell, but returning ONLY the I_BYTE_COUNT refusal — a different guard. */
function byteClaim(bytes) {
    try { shell().stage({ bytes: { length: bytes }, leaders: 0 }); return null; }
    catch (e) { return /I_BYTE_COUNT/.test(e.message) ? e.message : null; }
}

console.log('bytes fallback (synthetic sources: no bake record)');
{
    // TWO BOUNDS NOW, on two carriers, and the byte one binds FIRST.
    //
    // stage() also refuses an item whose BYTE LENGTH passes 2^24, because I_BYTE_COUNT
    // rides the f32 item table and stops being exact there. That bound (2^24) is far
    // below the ordinal wall (ARENA_MAX_BYTES, 42.7MB), so the byte FALLBACK can no
    // longer reach the ordinal wall at all: anything big enough to trip it is refused
    // earlier, for a different and equally correct reason.
    //
    // So the ordinal wall is now exercised through `leaders` — which is the real bound
    // anyway, and what every caller with a bake record supplies. The fallback is tested
    // for what it still does: bound a synthetic source conservatively, below 2^24.
    ok(claim({ bytes: (2 ** 24) - 2 }) === null, 'a synthetic item under both bounds passes');
    ok(byteClaim((2 ** 24) + 2) !== null, 'past 2^24 the BYTE bound fires (I_BYTE_COUNT, f32 item table)');
    ok(claim({ bytes: (2 ** 24) + 2 }) === null,
       'and it is not the ordinal refusal — different guard, different message');
}

console.log('leader count (callers with a bake record)');
{
    // The point of passing leaders: a multi-byte corpus is safe on its real glyph
    // count while its BYTE count would trip the conservative fallback. 4 bytes per
    // glyph (CJK/emoji) is the worst case UTF-8 offers.
    // Kept under the byte bound so THIS section tests the ordinal guard, not the other.
    const bytes = (2 ** 24) - 1;
    ok(claim({ bytes, leaders: WALL + 1 }) !== null, 'a leader count past the wall is refused');
    ok(claim({ bytes, leaders: Math.floor(bytes / 4) }) === null,
       'a real leader count well under the wall is accepted — the fallback was pessimistic');

    // …but leaders is a bound, not a bypass: a genuinely huge glyph count still fails.
    const over = claim({ bytes: (2 ** 24) - 1, leaders: WALL + 1 });
    ok(over !== null && /one item claims/.test(over), 'a real leader count past the wall is still refused');
    ok(/glyphs/.test(over || '') && !/conservative/.test(over || ''),
       'the refusal names glyphs, not a conservative byte guess');
}

console.log('the boundary itself');
{
    // Exercised on LEADERS, since the byte path can no longer reach this wall.
    ok(claim({ bytes: 1024, leaders: WALL }) === null, 'exactly at the ceiling is allowed');
    ok(claim({ bytes: 1024, leaders: WALL + 1 }) !== null, 'one past the ceiling is refused');
    ok(claim({ bytes: 1 }) === null, 'an ordinary small item is untouched');
    ok(byteClaim(1) === null, 'and the byte bound leaves it alone too');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} arena-item-bound: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
