// slug-atlas-dispose.test.mjs — headless behavior lock for LiveSlugAtlas texture lifetime
// (VRAM hygiene on the growth path).
//
//   bun tools/slug-atlas-dispose.test.mjs
//
// The Slug textures live at a CAPACITY: a growth that fits writes into the textures every
// field already holds — no new object, no rebinding, nothing to dispose. Only when an array
// doubles is its texture REBORN: every registered field gets the new pair, and the retired
// texture is disposed exactly once (its GPUTexture only dies on dispose(); each growth used to
// leak a pair until page unload) — at once when it never reached the GPU, after the renderer
// seam's flush has copied its rows into the new one when it did. The texture whose array didn't
// grow is kept, never disposed.

import LiveSlugAtlas from '../packages/glyph3d-core/src/shaping/LiveSlugAtlas.js';
import TextureUploads from '../packages/glyph3d-core/src/core/TextureUploads.js';
import { encodeGlyphBatch } from '../packages/glyph3d-core/src/shaping/slugData.js';
import { TEXTURE_WIDTH, MAP_INITIAL_ROWS, CURVE_INITIAL_ROWS } from '../packages/glyph3d-core/src/shaping/slug-constants.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const FAT = 777;   // a glyph with more curves than the initial curve capacity holds
const fatCurves = (CURVE_INITIAL_ROWS * TEXTURE_WIDTH) / 2 + 10;
const outline = {
    glyphAdvance: () => 1024, fontExtents: () => ({ ascender: 1638, descender: -410 }), glyphName: (g) => `g${g}`,
    glyphOutline: (g) => {
        const n = g === FAT ? fatCurves : 3;
        const segs = [{ type: 'M', values: [0, 0] }];
        for (let k = 0; k < n; k++) segs.push({ type: 'Q', values: [k % 900, 10, (k * 7) % 900, 800] });
        return segs;
    },
};
const shaper = {
    isBitmapSlot: () => false,
    slotSource: (id) => ({ fontIdx: 0, gid: id }),
    describeSlot: (id) => ({ font: 'F', gid: id, name: `g${id}` }),
};
const encoder = { encode: async (items) => ({ batch: encodeGlyphBatch(items, () => outline), ms: 0 }) };

const glyphAtlas = {};
const uploads = new TextureUploads();
const atlas = new LiveSlugAtlas({ atlas: glyphAtlas, shaper, encoder, uploads });
const field = { sd: null, swaps: 0, setSlugData(sd) { this.sd = sd; this.swaps++; }, setEmojiTexture() {} };
atlas.registerField(field);

const spy = (t) => { if ('disposedN' in t) { t.disposedN = 0; return t; } t.disposedN = 0; const d = t.dispose.bind(t); t.dispose = () => { t.disposedN++; d(); }; return t; };
const boot = { curve: spy(atlas.slugData.curveTexture), map: spy(atlas.slugData.glyphMapTexture) };

// ── growth within capacity: same objects, no rebinding, nothing disposed ──
{
    atlas.ensureGlyphsEncoded([5, 6, 7]);
    await atlas.whenIdle();
    ok(atlas.slugData.curveTexture === boot.curve && atlas.slugData.glyphMapTexture === boot.map, 'textures kept across a growth that fits');
    ok(field.swaps === 0, 'no field rebound');
    ok(boot.curve.disposedN === 0 && boot.map.disposedN === 0, 'nothing disposed');
}

// ── a slot past the map's capacity: the MAP is reborn, the curve texture kept ──
{
    const far = MAP_INITIAL_ROWS * TEXTURE_WIDTH + 3;
    atlas.ensureGlyphsEncoded([far]);
    ok(atlas.slugData.glyphMapTexture !== boot.map, 'map reborn as soon as the far slot is reserved (no out-of-texture read in flight)');
    ok(field.swaps === 1 && field.sd.glyphMapTexture === atlas.slugData.glyphMapTexture, 'field rebound to the new pair once');
    ok(glyphAtlas._slugData === atlas.slugData, 'atlas points at the new pair');
    ok(boot.map.disposedN === 1, `retired map disposed once (${boot.map.disposedN})`);
    ok(atlas.slugData.curveTexture === boot.curve && boot.curve.disposedN === 0, 'curve texture kept, not disposed');
    await atlas.whenIdle();
    ok(field.swaps === 1, 'its landing (within capacity) rebinds nothing more');
}

// ── a glyph past the curve capacity: the CURVE texture is reborn ──
{
    const liveMap = spy(atlas.slugData.glyphMapTexture);
    atlas.ensureGlyphsEncoded([FAT]);
    await atlas.whenIdle();
    ok(atlas.slugData.curveTexture !== boot.curve, 'curve reborn when the fat glyph overruns it');
    ok(boot.curve.disposedN === 1, 'retired curve texture disposed once');
    ok(atlas.slugData.glyphMapTexture === liveMap && liveMap.disposedN === 0, 'live map kept, not disposed');
    ok(field.swaps === 2 && field.sd.curveTexture === atlas.slugData.curveTexture, 'field tracks the newest pair');
}

// ── a texture on the GPU: the retired one lives until its rows are copied, then is disposed once ──
{
    const onGpu = spy(atlas.slugData.glyphMapTexture);
    onGpu.onUpdate(onGpu);   // three's first upload of it landed
    const far = 4 * MAP_INITIAL_ROWS * TEXTURE_WIDTH + 3;
    atlas.ensureGlyphsEncoded([far]);
    ok(atlas.slugData.glyphMapTexture !== onGpu && onGpu.disposedN === 0, 'a reborn map whose old one is on the GPU keeps the old one until the copy');
    const copies = [];
    uploads.flush({
        copyTextureToTexture: (src, dst) => copies.push([src, dst]),
        getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {},
    });
    ok(copies.length === 1 && copies[0][0] === onGpu && copies[0][1] === atlas.slugData.glyphMapTexture, 'the flush copies its rows into the new map');
    ok(onGpu.disposedN === 1, `then disposes it once (${onGpu.disposedN})`);
    await atlas.whenIdle();
}

// ── nothing new: nothing swapped, nothing disposed ──
{
    const live = { curve: spy(atlas.slugData.curveTexture), map: atlas.slugData.glyphMapTexture };
    const r = atlas.ensureGlyphsEncoded([5, FAT]);
    await atlas.whenIdle();
    ok(r.queued === 0, 'already-encoded glyphs queue nothing');
    ok(live.curve.disposedN === 0 && field.swaps === 3, 'no-growth disposes and swaps nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
