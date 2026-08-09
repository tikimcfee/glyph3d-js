// slug-atlas-emoji.test.mjs — behavior lock for the bitmap-slot partition:
//
//   bun tools/slug-atlas-emoji.test.mjs
//
// Bitmap (emoji) slots have no outline — their CURVE-atlas entry is empty by
// construction, so a newly-sighted emoji must NOT pay curve-atlas growth (the
// recurring '+1 [.blank]' re-encode + texture pair swap per emoji). It refreshes
// the shared emoji texture on each field, AND — since the invisible-emoji fix —
// gets its glyph-MAP entry (mode 1 + cell) via a map-only append: without one the
// texel is all-zero (mode 0, curveCount 0) and the slug branch discards the glyph.
// The curve texture object is NEVER replaced for an emoji sighting. Outline slots
// still grow both textures, and a mixed batch partitions cleanly.
// Same fake-internals pattern as slug-atlas-dispose.test.mjs.

import LiveSlugAtlas from '../packages/glyph3d-core/src/shaping/LiveSlugAtlas.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${msg}`); } };

const mkPair = () => ({ curveTexture: { dispose() {} }, glyphMapTexture: { dispose() {} }, stats: {} });

// Chain-flavored fake shaper: slots > 500 are bitmap (emoji-atlas) slots.
const shaper = {
    isBitmapSlot: (id) => id > 500,
    describeSlot: (id) => id > 500
        ? { font: '<emoji-atlas>', gid: 0, name: `cell ${id - 500}` }
        : { font: 'DejaVu Sans', gid: id, name: id === 42 ? '.blank' : `glyph${id}` },
};

const atlas = new LiveSlugAtlas({ atlas: {}, shaper, initialGlyphIds: [] });
atlas._slugData = mkPair();
const bornCurve = atlas._slugData.curveTexture;

let appendCalls = [];
let bitmapCalls = [];
atlas._encoder = {
    size: 1,
    appendGlyphs(ids) {
        appendCalls.push([...ids]);
        this.size += ids.length;
        return { ...mkPair(), added: ids.length, addedIds: [...ids], grew: ids.length > 0 };
    },
    appendBitmapSlots(ids) {
        bitmapCalls.push([...ids]);
        return { ...mkPair(), added: ids.length, addedIds: [...ids], grew: ids.length > 0 };
    },
};

const emojiRefreshes = [];
const slugSwaps = [];
atlas.registerField({
    setSlugData() { slugSwaps.push(1); },
    setEmojiTexture() { emojiRefreshes.push(1); },
});

// ── a bitmap slot: emoji refresh + MAP-ONLY append, curve atlas untouched ──
{
    appendCalls = []; bitmapCalls = []; emojiRefreshes.length = 0; slugSwaps.length = 0;
    const r = atlas.ensureGlyphsEncoded([501]);
    ok(r.grew === true, 'bitmap sighting grows (the glyph MAP, not the curve atlas)');
    ok(r.added === 0, 'bitmap sighting adds no OUTLINE glyphs');
    ok(appendCalls.flat().filter((id) => id > 500).length === 0, 'bitmap slot never reaches the outline encoder');
    ok(bitmapCalls.flat().join() === '501', 'bitmap slot reaches appendBitmapSlots');
    ok(emojiRefreshes.length === 1, 'emoji texture refreshed on the field');
    ok(slugSwaps.length === 1, 'the map swap hot-swaps fields');
    ok(atlas._slugData.curveTexture === bornCurve, 'curve texture object NEVER replaced for an emoji sighting');
}

// ── an outline slot still grows (and does not double-refresh emoji) ───────────
{
    appendCalls = []; bitmapCalls = []; emojiRefreshes.length = 0; slugSwaps.length = 0;
    const r = atlas.ensureGlyphsEncoded([42]);
    ok(r.grew === true && r.added === 1, 'outline slot grows');
    ok(appendCalls.flat().join() === '42', 'the outline slot went to the encoder');
    ok(bitmapCalls.length === 0, 'no bitmap append for an outline-only batch');
    ok(slugSwaps.length === 1, 'outline growth hot-swaps');
}

// ── a mixed batch partitions: outline encoded, emoji map-appended + refreshed ──
{
    appendCalls = []; bitmapCalls = []; emojiRefreshes.length = 0; slugSwaps.length = 0;
    const r = atlas.ensureGlyphsEncoded([42, 501, 43, 502]);
    ok(appendCalls.flat().join(',') === '42,43', 'only outline slots reach the outline encoder');
    ok(bitmapCalls.flat().join(',') === '501,502', 'only bitmap slots reach the map append');
    ok(emojiRefreshes.length === 1, 'the emoji half refreshed once');
    ok(slugSwaps.length === 1, 'ONE hot-swap for a mixed growth');
    ok(r.added === 2, 'growth counts outline slots only');
}

// ── provenance flows to the log path without throwing (no provenance = fine) ──
{
    const r = atlas.ensureCodepoints([0x1F600], { lookup: () => ({ g: 501 }) });
    ok(r.grew === true, 'ensureCodepoints routes a bitmap-resolved codepoint to the map-append path');
}

console.log(`\nslug-atlas-emoji: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
