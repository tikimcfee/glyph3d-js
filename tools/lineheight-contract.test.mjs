// lineheight-contract.test.mjs — one item-level contract, and the SEAM between two layers.
//
//   bun tools/lineheight-contract.test.mjs
//
// lineHeight is the ITEM's row pitch, never the glyph's own height. The oracle used to
// substitute the glyph's M_HEIGHT when an item omitted it, which staggered baselines
// within a row: a taller CJK glyph at -row*1.61 beside its neighbours at -row*1.4. The
// GPU kernel never had that branch, so the oracle and the Mojo port agreed with each
// other and disagreed with the renderer, in a case no gate could see.
//
// Deleting the substitution left undefined flowing through as NaN — a QUIETER failure
// than the bug it replaced, because a bit-exact comparison reports two matching NaNs as
// equal and passes. (mojo-rising's engine has nine files that compare by bits; that is
// exactly what would have happened there.) So the illegal state is refused where it
// ENTERS.
//
// THE SEAM IS THE POINT OF THIS FILE. Two contracts now differ on purpose:
//
//   GlyphPipelineArena.stage()  lineHeight defaults to 1 — it NORMALISES INTO the
//                               oracle's legal input space
//   the oracle                  refuses an unset lineHeight outright
//
// That split is only safe while the default is APPLIED rather than assumed: stage() must
// WRITE the value into the item it stages, so what flows downstream is fully specified.
// Testing each contract separately cannot catch a drift between them — which is precisely
// how the lineHeight branch survived. So the last section takes a STAGED item and feeds it
// to the oracle, pinning the relationship rather than the two endpoints.

import { runPipeline, assertLineHeight, SLOT_MEASURE_STRIDE, mBase, eBase, M_Y } from '../packages/glyph3d-core/src/compute/glyphPipelineReference.js';
import { runScanPipeline } from '../packages/glyph3d-core/src/compute/glyphPipelineScan.js';
import { buildGlyphTrie } from '../packages/glyph3d-core/src/compute/GlyphTrie.js';
import GlyphPipelineArena from '../packages/glyph3d-core/src/compute/GlyphPipelineArena.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const CELL_W = 1.2, CELL_H = 1.4;
const SRC = new Map();
for (let cp = 0x09; cp <= 0x7E; cp++) SRC.set(cp, { glyphId: cp, advance: CELL_W, height: CELL_H });
for (let cp = 0x4E00; cp <= 0x4E7F; cp++) SRC.set(cp, { glyphId: cp, advance: CELL_W * 2, height: CELL_H * 1.15 });
const trie = buildGlyphTrie(SRC.keys(), (cp) => SRC.get(cp) || null,
    { missingAdvance: CELL_W, missingHeight: CELL_H });
const bytes = new TextEncoder().encode('ab丁cd\nef丁gh');
const item = (lineHeight) => ({ byteStart: 0, byteCount: bytes.length, origin: { x: 0, y: 0, z: 0 }, lineHeight });

console.log('the validator refuses every underspecified form');
{
    ok(assertLineHeight(1.4, 0) === 1.4, 'a finite number passes through unchanged');
    ok(assertLineHeight(0, 0) === 0, 'zero is legal — a degenerate pitch is a CHOICE, not an omission');
    for (const [bad, what] of [[undefined, 'undefined'], [null, 'null'], [NaN, 'NaN'],
                               [Infinity, 'Infinity'], [-Infinity, '-Infinity'], ['1.4', 'a string']]) {
        const msg = threw(() => assertLineHeight(bad, 3));
        ok(msg !== null, `${what} is refused`);
        ok((msg || '').includes('item 3'), `the refusal names WHICH item (${what})`);
    }
    // NaN is the fixture format's encoding of "unset", so it is named rather than lumped in.
    ok(/encoding of "unset"/.test(threw(() => assertLineHeight(NaN, 0)) || ''),
       'NaN is identified as the format\'s unset encoding, not just "not finite"');
}

console.log('the pipelines refuse it, rather than producing NaN lanes');
{
    for (const [lh, what] of [[undefined, 'omitted'], [NaN, 'NaN']]) {
        const o = threw(() => runPipeline(bytes, trie, { items: [item(lh)] }));
        ok(o !== null, `runPipeline raises on ${what} lineHeight`);
        ok(/lineHeight/.test(o || ''), `the oracle's refusal names lineHeight (${what})`);
        const s = threw(() => runScanPipeline(bytes, trie, { items: [item(lh)] }, { chunkSize: 3, groupSize: 4 }));
        ok(s !== null, `runScanPipeline raises on ${what} lineHeight`);
    }
    // The legal case still works, or the guard is just breaking everything.
    ok(threw(() => runPipeline(bytes, trie, { items: [item(CELL_H)] })) === null,
       'a stated lineHeight still runs');
}

console.log('the ITEM owns the pitch — a page-level lineHeight is not consulted');
{
    // `pageParams.lineHeight` used to read `resolved[i].lineHeight ?? it.page?.lineHeight`.
    // The RHS went unreachable when the item-level guard started guaranteeing a finite
    // number (proven by making it throw and running everything without it firing), and it
    // was never a feature: the `??` prefers the ITEM's, so a page pitch could only take
    // effect on an item whose lineHeight was unset — the input that is now illegal.
    //
    // Asserted BEHAVIOURALLY rather than by grepping for the `??`: a source check would
    // pass on any rewrite that reintroduced the precedence in a different shape.
    const ITEM_LH = 2, PAGE_LH = 99;      // wildly different, so a mix-up cannot hide in eps
    const page = { pageRows: 4, pagesWide: 1, lineHeight: PAGE_LH };
    const withPage = runPipeline(bytes, trie,
        { items: [{ byteStart: 0, byteCount: bytes.length, origin: { x: 0, y: 0, z: 0 },
                    lineHeight: ITEM_LH, page }] });
    const noPageLh = runPipeline(bytes, trie,
        { items: [{ byteStart: 0, byteCount: bytes.length, origin: { x: 0, y: 0, z: 0 },
                    lineHeight: ITEM_LH, page: { pageRows: 4, pagesWide: 1 } }] });

    let differs = 0;
    for (let i = 0; i < withPage.slots.m.length / SLOT_MEASURE_STRIDE; i++) {
        const om = mBase(i), oe = eBase(i);
        if (withPage.slots.m[om + M_Y] !== noPageLh.slots.m[om + M_Y]) differs++;
    }
    ok(differs === 0,
       `a page-level lineHeight (${PAGE_LH}) changes nothing next to the item's (${ITEM_LH}) `
       + `— ${differs} Y lane(s) moved`);
}

console.log('THE SEAM: what stage() produces, the oracle accepts');
{
    // stage() defaults lineHeight to 1. That is only safe if the default is APPLIED —
    // written into the staged item — rather than assumed downstream. Take the item stage()
    // actually built and hand it to the contract that refuses underspecified items.
    const arena = Object.create(GlyphPipelineArena.prototype);
    arena.maxItems = 16; arena.maxBytes = 4096; arena._liveCount = 0; arena._items = [];
    arena._free = []; arena._byteTotal = 0; arena._tableDirty = false; arena._stagedSinceFlush = 0;
    arena._trie = trie;
    arena._realloc = () => { throw new Error('unexpected realloc in contract test'); };

    arena.stage({ bytes, origin: { x: 0, y: 0, z: 0 } });          // lineHeight OMITTED
    const staged = arena._items[0];
    ok(staged !== undefined, 'stage() recorded the item');
    ok(staged.lineHeight !== undefined && staged.lineHeight !== null,
       'stage() WROTE a lineHeight into the item — the default is applied, not assumed');
    ok(threw(() => assertLineHeight(staged.lineHeight, 0)) === null,
       `the staged item satisfies the oracle's contract (lineHeight=${staged.lineHeight})`);

    // And end to end: the staged item's own params run through the oracle without raising.
    ok(threw(() => runPipeline(bytes, trie, {
        items: [{ byteStart: 0, byteCount: bytes.length, origin: staged.origin,
                  wrapWidth: staged.wrapWidth, zStep: staged.zStep, lineHeight: staged.lineHeight }],
    })) === null, 'a staged item runs through the oracle end to end');
}

console.log(fail === 0 ? `\n✓ lineheight-contract: ${pass} passed, 0 failed`
                       : `\n✗ lineheight-contract: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
