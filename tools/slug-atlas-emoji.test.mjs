// slug-atlas-emoji.test.mjs — behavior lock for the bitmap-slot partition:
//
//   bun tools/slug-atlas-emoji.test.mjs
//
// Bitmap (emoji) slots have no outline, so a newly-sighted emoji must never reach the
// outline encoder (no '+1 [.blank]' growths). It gets its glyph-MAP entry (mode 1 + cell)
// synchronously — without one the texel is all-zero (mode 0, curveCount 0) and the slug
// branch discards the glyph — and no field is touched: the emoji atlas uploads its own
// pixels when the raster lands, and the atlas relays that landing as a glyphs-ready event.
// Outline slots go to the encoder as ONE batch per task, and a mixed batch partitions
// cleanly. The fake encoder runs the real encodeGlyphBatch in-process.

import LiveSlugAtlas from '../packages/glyph3d-core/src/shaping/LiveSlugAtlas.js';
import TextureUploads from '../packages/glyph3d-core/src/core/TextureUploads.js';
import { encodeGlyphBatch } from '../packages/glyph3d-core/src/shaping/slugData.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${msg}`); } };

const outline = {
    glyphAdvance: () => 1024, fontExtents: () => ({ ascender: 1638, descender: -410 }), glyphName: (g) => `g${g}`,
    glyphOutline: (g) => [{ type: 'M', values: [0, 0] }, { type: 'Q', values: [g, 100, 500, 900] }, { type: 'Z', values: [] }],
};
// Chain-flavored fake shaper: slots > 500 are bitmap (emoji-atlas) slots, cell = slot - 500.
const shaper = {
    isBitmapSlot: (id) => id > 500,
    emojiCellOf: (id) => (id > 500 ? id - 500 : -1),
    slotSource: (id) => (id > 0 && id <= 500 ? { fontIdx: 0, gid: id } : null),
    bitmapSlotOf: (cp) => (cp >= 0x1F600 ? 500 + (cp - 0x1F600) + 1 : -1),
    describeSlot: (id) => id > 500
        ? { font: '<emoji-atlas>', gid: 0, name: `cell ${id - 500}` }
        : { font: 'DejaVu Sans', gid: id, name: id === 42 ? '.blank' : `glyph${id}` },
};

const encodes = [];
const encoder = {
    encode: async (items) => { encodes.push([...items]); return { batch: encodeGlyphBatch(items, () => outline), ms: 0 }; },
};
// A fake emoji atlas: just the listener seam.
let emojiListener = null;
const emojiAtlas = { pending: 0, onChange: (cb) => { emojiListener = cb; return () => {}; }, whenIdle: async () => {} };

const atlas = new LiveSlugAtlas({ atlas: {}, shaper, encoder, emojiAtlas, uploads: new TextureUploads() });
const bornCurve = atlas.slugData.curveTexture;
const map = () => atlas.slugData.glyphMapTexture.image.data;

const emojiRefreshes = [];
const slugSwaps = [];
atlas.registerField({
    setSlugData() { slugSwaps.push(1); },
    setEmojiTexture() { emojiRefreshes.push(1); },
});
const ready = [];
atlas.onGlyphsReady((e) => ready.push(e));

// ── a bitmap slot: MAP entry now, no encoder, no field touched ──
{
    const r = atlas.ensureGlyphsEncoded([501]);
    ok(r.queued === 1 && r.pending === 0, 'bitmap sighting is written at once (nothing in flight)');
    ok(map()[501 * 4 + 2] === 1 && map()[501 * 4 + 3] === 1, 'slot 501 → [_, _, mode 1, cell 1]');
    await atlas.whenIdle();
    ok(encodes.length === 0, 'bitmap slot never reaches the outline encoder');
    ok(emojiRefreshes.length === 0, 'no per-sighting emoji texture refresh on the fields');
    ok(slugSwaps.length === 0, 'no field rebinding');
    ok(atlas.slugData.curveTexture === bornCurve, 'curve texture object NEVER replaced for an emoji sighting');
}

// ── an outline slot goes to the encoder and lands ───────────────────────────
{
    const r = atlas.ensureGlyphsEncoded([42]);
    ok(r.queued === 1 && r.pending === 1, 'outline slot queued, in flight');
    ok(map()[42 * 4 + 1] === 0, 'in flight it reads an all-zero (blank) map texel');
    await atlas.whenIdle();
    ok(encodes.length === 1 && encodes[0].join() === '42,0,42', 'the outline slot went to the encoder as [slot, font, gid]');
    ok(map()[42 * 4 + 1] === 2, 'landed: slot 42 has its curves (M-Q-Z closes with a line → 2)');
    ok(slugSwaps.length === 0, 'growth within capacity rebinds no field');
}

// ── a mixed batch partitions: outline encoded, emoji map-written ──
{
    encodes.length = 0;
    atlas.ensureGlyphsEncoded([43, 502, 44, 503]);
    await atlas.whenIdle();
    ok(encodes.length === 1 && encodes[0].filter((_, i) => i % 3 === 0).join(',') === '43,44', 'only outline slots reach the encoder — one batch');
    ok(map()[502 * 4 + 2] === 1 && map()[503 * 4 + 2] === 1, 'both emoji slots got bitmap map entries');
    ok(emojiRefreshes.length === 0, 'still no per-sighting emoji refresh');
}

// ── one batch per task, already-encoded and in-flight slots skipped ──
{
    encodes.length = 0;
    atlas.ensureGlyphsEncoded([45, 46]);
    atlas.ensureGlyphsEncoded([46, 47, 42]);   // 46 in flight, 42 encoded
    await atlas.whenIdle();
    ok(encodes.length === 1, 'two ensures in one task → one worker batch');
    ok(encodes[0].filter((_, i) => i % 3 === 0).join(',') === '45,46,47', 'dedup: in-flight and encoded slots skipped');
}

// ── the emoji atlas's landed pixels become a glyphs-ready event ──
{
    ready.length = 0;
    emojiListener({ kind: 'rasterized', cells: [1], codepoints: [0x1F600] });
    ok(ready.length === 1 && ready[0].slots.join() === '501' && ready[0].codepoints.join() === String(0x1F600),
        'rasterized cells → glyphs-ready { slots, codepoints }');
    emojiListener({ kind: 'replaced' });
    ok(emojiRefreshes.length === 1, 'a reborn emoji texture rebinds every field once');
}

// ── provenance flows (ensureCodepoints) without throwing ──
{
    const r = atlas.ensureCodepoints([0x1F604], { lookup: () => ({ g: 505 }) });
    ok(r.queued === 1, 'ensureCodepoints routes a bitmap-resolved codepoint to the map path');
}

console.log(`\nslug-atlas-emoji: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
