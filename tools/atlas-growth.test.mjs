#!/usr/bin/env bun
/**
 * atlas-growth.test.mjs — the glyph atlas's growth: incremental, off the main thread,
 * persisted.
 *
 *   bun tools/atlas-growth.test.mjs
 *
 * Headless (bun: real HarfBuzz + the app's font chain via headlessFontChain, the REAL encode
 * worker, three's DataTextures without a GPU). What it locks:
 *
 *   [1] incremental upload   a glyph appended within capacity queues only its own texels as
 *                            rects on the atlas's TextureUploads (a span is at most three: a row's
 *                            tail, whole rows, a row's head) on the SAME texture objects; the
 *                            bytes per new glyph are measured against the whole-texture upload
 *                            each growth used to cost. A texture not yet uploaded queues nothing.
 *                            (texture-uploads.test.mjs counts what reaches the GPU per event.)
 *   [2] async contract       ensure* never blocks; an in-flight slot reads an all-zero (blank)
 *                            map texel; one glyphs-ready event per landed batch, carrying slots +
 *                            codepoints; a failed encode leaves its slots blank, logged, not pending.
 *   [3] the worker           SlugEncodeWorker's texels are bit-identical to encodeGlyphBatch run
 *                            on the main thread's own faces (the worker IS the encode, moved).
 *   [4] persistence          grown glyphs → persist (debounced: one save for a burst) → a NEW
 *                            chain that allocates slots in a different order hydrates them at
 *                            the slots IT gives them, byte-identical, and asks for none of them
 *                            again; end to end through bootGlyphEngine (miss → encode → save;
 *                            boot 2 warm; a corrupt growth blob → boot still succeeds, cold).
 *   [5] emoji atlas          landed pixels go to the right cells; only their cells are queued
 *                            (one rect); a growth adds rows (cells never move) and rebirths the
 *                            texture once ('replaced'), its old rows queued as a GPU copy.
 */

import * as THREE from 'three';
import { ROOT, bootHeadlessFontChain } from './headlessFontChain.mjs';

const { chain, fonts: FONTS } = await bootHeadlessFontChain();
const S = await import(`${ROOT}/packages/glyph3d-core/src/shaping/index.js`);
const { default: SlugEncodeClient } = await import(`${ROOT}/packages/glyph3d-core/src/workers/SlugEncodeClient.js`);
const { default: EmojiAtlas } = await import(`${ROOT}/packages/glyph3d-core/src/EmojiAtlas.js`);
const { default: TextureUploads } = await import(`${ROOT}/packages/glyph3d-core/src/core/TextureUploads.js`);
const { blobStore } = await import(`${ROOT}/packages/glyph3d-core/src/services/state/index.js`);
const { CURVE_U32_PER_CURVE } = await import(`${ROOT}/packages/glyph3d-core/src/shaping/slug-constants.js`);
const { LiveSlugAtlas, MonospaceShapeCache, encodeGlyphBatch } = S;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); } };
const eqU32 = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const range = (a, b) => { const o = []; for (let c = a; c <= b; c++) o.push(c); return o; };
const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };

const NERD = range(0xf000, 0xf02f);                 // Nerd Font icons (Meslo PUA) — outside the core
const SYLL = range(0x1401, 0x1420);                 // Canadian syllabics (DejaVu) — outside the core

// Mark a texture's first upload as landed (what three's renderer does after uploading).
const uploaded = (t) => { t.onUpdate(t); return t; };
/** The rects queued on an uploads queue for texture `t` (its pending ops). */
const rectsOf = (uploads, t) => uploads._ops.filter((op) => op.kind === 'rect' && op.tex === t);
/** Run a queue through a renderer that only takes the ops (the GPU side is texture-uploads.test's). */
const flushed = (uploads) => uploads.flush({ copyTextureToTexture() {}, getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {} });

// ── [1] incremental upload ─────────────────────────────────────────────────────────────────
console.log('\n[1] incremental upload — bytes per new glyph');
const encoder = new SlugEncodeClient({ fonts: chain.fontSources() });
const shapeCache = new MonospaceShapeCache(chain);
const uploads = new TextureUploads();
const live = new LiveSlugAtlas({ atlas: {}, shaper: chain, encoder, uploads });
await quiet(() => live.encodeCore(range(0x21, 0x7e).map((cp) => shapeCache.lookup(cp).g)))();
const { curveTexture: curve0, glyphMapTexture: map0 } = live.slugData;
const wholeBytes = curve0.image.data.byteLength + map0.image.data.byteLength;
{
    const before = live.uploadStats.slug.rectBytes;
    live.ensureCodepoints([0xf001], shapeCache);
    await quiet(() => live.whenIdle())();
    ok(live.uploadStats.slug.rectBytes === before && uploads.pending === 0, 'before the first upload nothing is queued (the first upload sends the live array)');
}
uploaded(curve0); uploaded(map0);
{
    const s0 = live.uploadStats.slug;
    const slot = shapeCache.lookup(0xf002).g;
    live.ensureCodepoints([0xf002], shapeCache);
    await quiet(() => live.whenIdle())();
    const s1 = live.uploadStats.slug;
    const curves = live._textures.buffer.slotTexels(slot).length / CURVE_U32_PER_CURVE;
    const bytes = s1.rectBytes - s0.rectBytes;
    ok(live.slugData.curveTexture === curve0 && live.slugData.glyphMapTexture === map0, 'same texture objects after the growth (no field rebinds)');
    ok(s1.reborn === s0.reborn, 'no texture reborn');
    ok(bytes === (curves * 2 + 1) * 16, `one new glyph uploads its own texels: ${curves} curves → ${bytes} B (${curves * 2} curve texels + 1 map texel)`);
    ok(bytes * 100 < wholeBytes, `vs the whole-texture re-upload a growth used to cost: ${bytes} B vs ${wholeBytes} B (${(wholeBytes / bytes).toFixed(0)}×)`);
    const cr = rectsOf(uploads, curve0), mr = rectsOf(uploads, map0);
    ok(cr.length >= 1 && cr.length <= 3 && mr.length === 1, `queued as ${cr.length}+${mr.length} rect(s) (≤ 3 per span)`);
    ok(curve0.updateRanges.length === 0 && curve0.version === 1, 'three\'s own path is untouched: no update ranges, no re-flag of the texture');
    flushed(uploads);
    ok(uploads.pending === 0, 'the renderer seam\'s flush takes them');
}
{
    // A burst crossing curve-row boundaries: one span, at most three rects, however many rows.
    const s0 = live.uploadStats.slug;
    live.ensureCodepoints(NERD, shapeCache);
    await quiet(() => live.whenIdle())();
    const s1 = live.uploadStats.slug;
    const cr = rectsOf(uploads, curve0);
    const rows = cr.reduce((n, op) => n + op.h, 0);
    ok(rows >= 2 && cr.length <= 3, `a ${NERD.length}-glyph burst: ${cr.length} rect(s) over ${rows} texture rows (was one call per row)`);
    ok(s1.rectBytes - s0.rectBytes < 64 * 1024, `burst uploads ${s1.rectBytes - s0.rectBytes} B (was ${wholeBytes} B per growth)`);
    flushed(uploads);
}

// ── [2] async contract ─────────────────────────────────────────────────────────────────────
console.log('\n[2] async contract');
{
    const events = [];
    const off = live.onGlyphsReady((e) => events.push(e));
    const cps = SYLL.filter((cp) => shapeCache.lookup(cp).g > 0).slice(0, 8);   // the ones DejaVu covers
    const slots = [...new Set(cps.map((cp) => shapeCache.lookup(cp).g))];   // two codepoints may share a glyph
    const v0 = live.version;
    const r = live.ensureCodepoints(cps, shapeCache);
    const map = live.slugData.glyphMapTexture.image.data;
    ok(r.queued === slots.length && live.pending === slots.length, `ensure returns at once: ${r.queued} queued, ${live.pending} pending`);
    ok(slots.every((s) => map[s * 4] === 0 && map[s * 4 + 1] === 0 && map[s * 4 + 2] === 0), 'in flight: each slot reads an all-zero map texel (draws blank)');
    ok(events.length === 0, 'no ready event before the worker answers');
    await quiet(() => live.whenIdle())();
    ok(slots.every((s) => live.slugData.glyphMapTexture.image.data[s * 4 + 1] > 0), 'landed: every slot has curves');
    ok(events.length === 1, 'ONE glyphs-ready event for the batch');
    ok(events[0] && eqU32(Uint32Array.from(events[0].slots).sort(), Uint32Array.from(slots).sort()), 'its slots are the batch');
    ok(events[0] && events[0].codepoints.length === slots.length && events[0].codepoints.every((cp) => cps.includes(cp) && slots.includes(shapeCache.lookup(cp).g)), 'its codepoints are the ones that asked (one per slot)');
    ok(events[0]?.version === v0 + 1 && live.version === v0 + 1, 'version bumped once');
    ok(live.ensureCodepoints(cps, shapeCache).queued === 0, 'asking again queues nothing');
    off();
}
{
    // A failing encoder: logged loudly, slots leave the pending set, stay blank.
    const errors = [];
    const err0 = console.error; console.error = (m) => errors.push(String(m));
    const bad = new LiveSlugAtlas({ atlas: {}, shaper: chain, uploads: new TextureUploads(), encoder: { encode: async () => { throw new Error('boom'); } } });
    const slot = shapeCache.lookup(0xf010).g;
    bad.ensureCodepoints([0xf010], shapeCache);
    await bad.whenIdle();
    console.error = err0;
    ok(bad.pending === 0, 'a failed encode leaves nothing pending (whenIdle resolves)');
    ok(bad.slugData.glyphMapTexture.image.data[slot * 4 + 1] === 0, '…and its slot stays blank');
    ok(errors.some((m) => m.includes('boom') && m.includes('U+F010')), 'the failure is logged with its cause and the glyphs it was for');
}

// ── [3] the worker is the encode, moved ────────────────────────────────────────────────────
console.log('\n[3] worker = main-thread encode, bit for bit');
{
    const cps = [...NERD.slice(0, 16), ...SYLL, 0x41, 0x2500];
    const items = [];
    for (const cp of cps) {
        const slot = shapeCache.lookup(cp).g;
        const src = chain.slotSource(slot);
        if (src) items.push(slot, src.fontIdx, src.gid);
    }
    const local = encodeGlyphBatch(items, (f) => chain._fonts[f].shaper);
    const { batch } = await encoder.encode(Uint32Array.from(items));
    ok(eqU32(batch.slots, local.slots) && eqU32(batch.counts, local.counts), `same glyphs, same curve counts (${local.slots.length} glyphs over ${new Set(items.filter((_, i) => i % 3 === 1)).size} fonts)`);
    ok(eqU32(batch.texels, local.texels), `texels bit-identical (${local.texels.length} u32)`);
}

// ── [4] persistence ────────────────────────────────────────────────────────────────────────
console.log('\n[4] persistence');
{
    const saves = [];
    const grower = new LiveSlugAtlas({
        atlas: {}, shaper: chain, encoder, uploads: new TextureUploads(),
        persist: { save: async (g) => { saves.push(g); return 1; } }, persistDebounceMs: 30,
    });
    grower.ensureCodepoints(NERD.slice(0, 10), shapeCache);
    await quiet(() => grower.whenIdle())();
    grower.ensureCodepoints(SYLL.slice(0, 6), shapeCache);
    await quiet(() => grower.whenIdle())();
    ok(saves.length === 0, 'nothing saved inside the debounce window');
    await new Promise((r) => setTimeout(r, 80));
    ok(saves.length === 1, 'ONE save for the burst of growths');
    const g = saves[0];
    ok(g && g.gid.length === 16, `it holds every grown glyph (${g?.gid.length})`);

    // Through the real envelope + store.
    const key = S.slugGrowthKey({ fonts: FONTS });
    const fc = { fontCount: chain.fontCount };
    await S.saveSlugGrowth(key, g, fc);
    const loaded = await quiet(S.loadSlugGrowth)(key, fc);
    ok(loaded && eqU32(loaded.texels, g.texels), 'growth survives the envelope byte-for-byte');

    // A NEW chain that meets other glyphs first: its slots for the grown glyphs differ.
    const { chain: chain2 } = await quiet(bootHeadlessFontChain)();
    const cache2 = new MonospaceShapeCache(chain2);
    for (const cp of [...SYLL].reverse()) cache2.lookup(cp);   // a different allocation order
    const enc2 = { encode: async () => { throw new Error('a hydrated glyph must not be re-encoded'); } };
    const fresh = new LiveSlugAtlas({ atlas: {}, shaper: chain2, encoder: enc2, uploads: new TextureUploads() });
    const added = fresh.hydrateGrowth(loaded);
    ok(added === 16, `hydrated ${added} glyphs`);
    const cps = [...NERD.slice(0, 10), ...SYLL.slice(0, 6)];
    const moved = cps.filter((cp) => cache2.lookup(cp).g !== shapeCache.lookup(cp).g).length;
    ok(moved > 0, `the new chain gave ${moved}/${cps.length} of them different slots`);
    ok(cps.every((cp) => eqU32(fresh._textures.buffer.slotTexels(cache2.lookup(cp).g), grower._textures.buffer.slotTexels(shapeCache.lookup(cp).g))),
        'every grown glyph sits at ITS slot in the new chain, curves byte-identical');
    ok(fresh.ensureCodepoints(cps, cache2).queued === 0, 'warm: asking for them again queues nothing');
    ok(fresh.grownCount === 16, 'hydrated growth counts as growth (re-saved with what is learned next)');
}
{
    // End to end through bootGlyphEngine (no GPU, no emoji rasterizer in bun).
    const { bootGlyphEngine, disposeGlyphEngine } = await import(`${ROOT}/packages/glyph3d-core/src/glyphEngine.js`);
    await blobStore.clearNamespace('slug-core');
    const fonts = FONTS;
    const boot = quiet(() => bootGlyphEngine({ fonts, encodeRanges: [[0x20, 0x7e]], primeRanges: [[0x20, 0x7e]] }));

    const a1 = await boot();
    ok(a1._live.size > 90, `boot 1 (cache miss): core encoded in the worker (${a1._live.size} glyphs)`);
    a1._live.ensureCodepoints(NERD, a1._shapeCache);
    await quiet(() => a1._live.whenIdle())();
    await quiet(() => a1._live.persistNow())();
    const key = S.slugGrowthKey({ fonts });
    ok(await blobStore.has(key), 'boot 1 persisted its growth');
    disposeGlyphEngine(a1);

    const a2 = await boot();
    const q2 = a2._live.ensureCodepoints(NERD, a2._shapeCache);
    ok(q2.queued === 0, `boot 2: the ${NERD.length} icons learned in boot 1 are warm (0 queued)`);
    ok(NERD.every((cp) => a2.slugData === undefined || a2._live.slugData.glyphMapTexture.image.data[a2._shapeCache.lookup(cp).g * 4 + 1] > 0),
        'boot 2: their map entries hold curves before the first frame');
    disposeGlyphEngine(a2);

    await blobStore.put(key, new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]));   // corrupt the growth
    const warn0 = console.warn; console.warn = () => {};
    const a3 = await boot();
    console.warn = warn0;
    ok(a3._live.size > 90, 'boot 3 with a corrupt growth blob still boots (the core hydrates)');
    ok(a3._live.ensureCodepoints(NERD, a3._shapeCache).queued === NERD.length, 'boot 3: the icons are simply cold again');
    ok(!(await blobStore.has(key)), 'the corrupt growth was discarded');
    await quiet(() => a3._live.whenIdle())();
    disposeGlyphEngine(a3);
}

// ── [5] emoji atlas ────────────────────────────────────────────────────────────────────────
console.log('\n[5] emoji atlas — raster lands in place, only its rows upload, growth adds rows');
{
    const cellPx = 4, cols = 4;
    const colorOf = (cp) => [cp & 255, (cp >> 8) & 255, 77, 255];
    const runs = [];
    const rasterizer = {   // the worker's contract, in-process: a band in atlas layout
        raster: async ({ cps, firstIdx, cols: c, cellPx: px }) => {
            runs.push(cps.length);
            const last = firstIdx + cps.length - 1;
            const row0 = Math.floor(firstIdx / c), rows = Math.floor(last / c) - row0 + 1;
            const col0 = rows === 1 ? firstIdx % c : 0, wCells = rows === 1 ? (last % c) - col0 + 1 : c;
            const band = new Uint8Array(wCells * px * rows * px * 4);
            cps.forEach((cp, i) => {
                const idx = firstIdx + i, x0 = ((idx % c) - col0) * px, y0 = (Math.floor(idx / c) - row0) * px;
                for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) band.set(colorOf(cp), ((y0 + y) * wCells * px + x0 + x) * 4);
            });
            return { row0, rows, col0, wCells, band };
        },
        dispose: () => {},
    };
    const eu = new TextureUploads();
    const ea = new EmojiAtlas({ cellPx, cols, rows: 2, rowGrowth: 1.5, rasterizer, uploads: eu });
    const events = [];
    ea.onChange((e) => events.push(e));
    const pixelAt = (idx) => {
        const x = (idx % cols) * cellPx + 1, y = Math.floor(idx / cols) * cellPx + 1;
        const o = (y * ea.widthPx + x) * 4;
        return [...ea._texture.image.data.subarray(o, o + 4)];
    };
    const tex0 = uploaded(ea.getTexture(THREE));
    const cps0 = [0x1f680, 0x1f681, 0x1f682];
    cps0.forEach((cp) => ea.ensure(cp));
    await ea.whenIdle();
    ok(runs.length === 1 && runs[0] === 3, 'three sightings in one task → one raster run');
    ok(cps0.every((cp, i) => pixelAt(i).join() === colorOf(cp).join()), 'each emoji landed in its own cell');
    const r0 = rectsOf(eu, tex0);
    ok(r0.length === 1 && r0[0].w === 3 * cellPx && r0[0].h === cellPx && ea.stats.rectBytes === 3 * cellPx * cellPx * 4,
        `queued one ${r0[0]?.w}×${r0[0]?.h} rect: only the 3 cells (${ea.stats.rectBytes} B), not the atlas`);
    ok(events.some((e) => e.kind === 'rasterized' && e.codepoints.join() === cps0.join()), 'rasterized event names the codepoints');
    flushed(eu);

    // Fill past the 8 cells: rows grow (2 → 3), cells keep their place, the texture is reborn once.
    const more = range(0x1f683, 0x1f689);
    more.forEach((cp) => ea.ensure(cp));
    await ea.whenIdle();
    ok(ea.rows === 3 && ea.cols === cols, `grew by rows: ${ea.cols}×${ea.rows}`);
    ok(events.filter((e) => e.kind === 'replaced').length === 1 && ea._texture !== tex0, 'texture reborn once (one replaced event)');
    ok(eu._ops[0]?.kind === 'copy' && eu._ops[0].from === tex0 && eu._ops[0].to === ea._texture && ea._texture.source.dataReady === false,
        'its old rows are queued as a GPU copy first; the new texture is allocated, not filled from the CPU');
    ok([...cps0, ...more].every((cp, i) => pixelAt(i).join() === colorOf(cp).join()), 'every cell, old and new, holds its emoji after the growth');
    ea.dispose();
}

encoder.dispose();
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
