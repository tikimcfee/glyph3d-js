// slug-atlas-emoji.test.mjs — behavior lock for the bitmap-slot partition:
//
//   bun tools/slug-atlas-emoji.test.mjs
//
// Bitmap (emoji) slots have no outline — their curve-atlas entry is empty by
// construction, so a newly-sighted emoji must NOT pay curve-atlas growth (the
// recurring '+1 [.blank]' re-encode + per-field hot-swap per emoji). It only
// refreshes the shared emoji texture on each field. Outline slots still grow,
// and a mixed batch partitions cleanly. Same fake-internals pattern as
// slug-atlas-dispose.test.mjs.

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

let appendCalls = [];
atlas._encoder = {
    size: 1,
    appendGlyphs(ids) {
        appendCalls.push([...ids]);
        this.size += ids.length;
        return { ...mkPair(), added: ids.length, addedIds: [...ids], grew: ids.length > 0 };
    },
};

const emojiRefreshes = [];
const slugSwaps = [];
atlas.registerField({
    setSlugData() { slugSwaps.push(1); },
    setEmojiTexture() { emojiRefreshes.push(1); },
});

// ── a bitmap slot refreshes emoji textures WITHOUT touching the curve atlas ──
{
    appendCalls = []; emojiRefreshes.length = 0; slugSwaps.length = 0;
    const r = atlas.ensureGlyphsEncoded([501]);
    ok(r.grew === false, 'bitmap slot reports no growth');
    ok(appendCalls.flat().filter((id) => id > 500).length === 0, 'bitmap slot never reaches the encoder');
    ok(emojiRefreshes.length === 1, 'emoji texture refreshed on the field');
    ok(slugSwaps.length === 0, 'NO slug hot-swap for an emoji sighting');
}

// ── an outline slot still grows (and does not double-refresh emoji) ───────────
{
    appendCalls = []; emojiRefreshes.length = 0; slugSwaps.length = 0;
    const r = atlas.ensureGlyphsEncoded([42]);
    ok(r.grew === true && r.added === 1, 'outline slot grows');
    ok(appendCalls.flat().join() === '42', 'the outline slot went to the encoder');
    ok(slugSwaps.length === 1, 'outline growth hot-swaps');
}

// ── a mixed batch partitions: outline encoded, emoji refreshed ──
{
    appendCalls = []; emojiRefreshes.length = 0; slugSwaps.length = 0;
    const r = atlas.ensureGlyphsEncoded([42, 501, 43, 502]);
    ok(appendCalls.flat().join(',') === '42,43', 'only outline slots reach the encoder');
    ok(emojiRefreshes.length === 1, 'the emoji half refreshed once');
    ok(r.added === 2, 'growth counts outline slots only');
}

// ── provenance flows to the log path without throwing (no provenance = fine) ──
{
    const r = atlas.ensureCodepoints([0x1F600], { lookup: () => ({ g: 501 }) });
    ok(r.grew === false, 'ensureCodepoints routes a bitmap-resolved codepoint to the refresh path');
}

console.log(`\nslug-atlas-emoji: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
