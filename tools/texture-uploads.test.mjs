#!/usr/bin/env bun
/**
 * texture-uploads.test.mjs — the glyph atlas's texture bytes: what each growth and each landing
 * sends to the GPU, counted the way three's WebGL backend would send it.
 *
 *   bun tools/texture-uploads.test.mjs
 *
 * Headless. A model renderer stands in for three's WebGL path, byte for byte: a texture whose
 * version moved is uploaded on bind (whole, or — `source.dataReady` false — only allocated, zero
 * filled); `copyTextureToTexture` from a texture it holds is a GPU copy (no bytes cross the bus),
 * from one it doesn't is a texSubImage2D of the region (bytes = w × h × texel). It keeps every
 * texture's GPU image, so each frame also checks what the shader would sample: the GPU image of
 * every live atlas texture equals its CPU array (a copy skipped, a rect dropped, a row missed —
 * each shows up as a mismatch).
 *
 *   [1] emoji growth     the boot grid (24 rows, uploaded whole on its first draw), then 406 new
 *                        emoji: the rows grow 24 → 36 and the old 24 rows are ONE GPU copy — no
 *                        byte of them is re-sent; the 406 cells are 3 rects (a row's tail, the
 *                        whole rows, a row's head) carrying exactly their own pixels.
 *   [2] slug doubling    a burst that overruns the curve array's spare rows: the array doubles,
 *                        the old rows are a GPU copy, the bus carries only the new curves' texels.
 *   [3] the seam         SceneSystems flushes before a top-level render, never inside a nested
 *                        one; a GPU copy puts back the render target it unbinds; a grown texture
 *                        drawn before any flush is reported loudly.
 */

import * as THREE from 'three';

const ROOT = new URL('..', import.meta.url).pathname;
const { default: TextureUploads } = await import(`${ROOT}packages/glyph3d-core/src/core/TextureUploads.js`);
const { default: EmojiAtlas } = await import(`${ROOT}packages/glyph3d-core/src/EmojiAtlas.js`);
const { default: SlugTextures } = await import(`${ROOT}packages/glyph3d-core/src/shaping/SlugTextures.js`);
const { TEXTURE_WIDTH, CURVE_U32_PER_CURVE, CURVE_TEXELS_PER_CURVE, CURVE_INITIAL_ROWS } = await import(`${ROOT}packages/glyph3d-core/src/shaping/slug-constants.js`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); } };
const range = (a, b) => { const o = []; for (let c = a; c <= b; c++) o.push(c); return o; };

/** three's WebGL texture path, as bytes and GPU images. */
class ModelRenderer {
    constructor() {
        /** @type {Map<THREE.DataTexture, {mem: ArrayLike<number>, version: number}>} */
        this.gpu = new Map();
        this.target = null;
        this.reset();
    }
    reset() { this.sent = { wholeBytes: 0, wholes: 0, rectBytes: 0, rects: 0, copies: 0, allocs: 0, targetSets: 0 }; }
    static texel(t) { return 4 * t.image.data.BYTES_PER_ELEMENT; }
    /** setTexture2D: a texture whose version moved uploads (whole) or, data not ready, allocates. */
    bind(t) {
        const g = this.gpu.get(t);
        if (t.version === 0 || g?.version === t.version) return;
        let mem = g?.mem;
        if (!mem) {
            mem = new t.image.data.constructor(t.image.data.length);   // texStorage2D: zeroed
            this.sent.allocs++;
            t.addEventListener('dispose', () => this.gpu.delete(t));
        }
        if (t.source.dataReady) {
            if (t.updateRanges.length) throw new Error('model: the atlas textures use no updateRanges');
            mem.set(t.image.data);
            this.sent.wholeBytes += t.image.width * t.image.height * ModelRenderer.texel(t);
            this.sent.wholes++;
        }
        this.gpu.set(t, { mem, version: t.version });
        t.onUpdate?.(t);
    }
    copyTextureToTexture(src, dst, box, pos) {
        this.bind(dst);
        const held = this.gpu.get(src);
        const from = held ? held.mem : src.image.data;
        const to = this.gpu.get(dst).mem;
        const sw = src.image.width, dw = dst.image.width;
        const w = box.max.x - box.min.x, h = box.max.y - box.min.y;
        for (let y = 0; y < h; y++) {
            const s = ((box.min.y + y) * sw + box.min.x) * 4, d = ((pos.y + y) * dw + pos.x) * 4;
            to.set(from.subarray(s, s + w * 4), d);
        }
        if (held) this.sent.copies++;
        else { this.sent.rects++; this.sent.rectBytes += w * h * ModelRenderer.texel(dst); }
    }
    getRenderTarget() { return this.target; }
    getActiveCubeFace() { return 0; }
    getActiveMipmapLevel() { return 0; }
    setRenderTarget(t) { this.target = t; this.sent.targetSets++; }
    /** One frame: the seam's flush, then the draws that sample `textures`. */
    frame(uploads, ...textures) {
        uploads.flush(this);
        for (const t of textures) this.bind(t);
    }
    /** What the shader samples equals the CPU array. */
    matches(t) {
        const g = this.gpu.get(t);
        if (!g) return false;
        const a = t.image.data;
        for (let i = 0; i < a.length; i++) if (g.mem[i] !== a[i]) return false;
        return true;
    }
}

// ── [1] emoji growth ─────────────────────────────────────────────────────────────────────────
console.log('\n[1] emoji growth — the old rows are a GPU copy, the new cells are 3 rects');
{
    const cellPx = 8, cols = 48;   // the real grid's shape (EMOJI_ATLAS: 48 cols, 16 → ×1.5 rows), small cells
    const colorOf = (cp) => [cp & 255, (cp >> 8) & 255, 77, 255];
    const rasterizer = {   // EmojiRasterWorker's contract, in-process: a band in atlas layout
        raster: async ({ cps, firstIdx, cols: c, cellPx: px }) => {
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
    const uploads = new TextureUploads();
    const gl = new ModelRenderer();
    const ea = new EmojiAtlas({ cellPx, cols, rows: 16, rowGrowth: 1.5, rasterizer, uploads });
    let replaced = 0;
    ea.onChange((e) => { if (e.kind === 'replaced') replaced++; });
    const log0 = console.log; console.log = () => {};
    // Boot: the core's 900 emoji grow the grid to 24 rows before any texture exists.
    range(0x10000, 0x10000 + 899).forEach((cp) => ea.ensure(cp));
    await ea.whenIdle();
    console.log = log0;
    ok(ea.rows === 24, `the core's 900 cells grew the grid to ${cols}×${ea.rows} before a texture existed`);
    const tex0 = ea.getTexture(THREE);
    gl.frame(uploads, tex0);
    const wholeBoot = ea.widthPx * ea.heightPx * 4;
    ok(gl.sent.wholes === 1 && gl.sent.wholeBytes === wholeBoot && gl.matches(tex0), `the first draw uploads the boot grid whole, once (${wholeBoot} B)`);

    // 406 new emoji (the cold burst): ensure grows 24 → 36 rows at once; the cells land later.
    gl.reset();
    const cellBytes = cellPx * cellPx * 4;
    console.log = () => {};
    range(0x20000, 0x20000 + 405).forEach((cp) => ea.ensure(cp));
    console.log = log0;
    const tex1 = ea._texture;
    ok(ea.rows === 36 && tex1 !== tex0 && replaced === 1, `the rows grew 24 → ${ea.rows}: a new texture, one 'replaced'`);
    gl.frame(uploads, tex1);   // a frame before the cells land: the old rows must already be there
    ok(gl.sent.copies === 1 && gl.sent.wholes === 0 && gl.sent.rectBytes === 0, `growth frame: 1 GPU copy, 0 B over the bus (was a whole ${ea.widthPx * ea.heightPx * 4} B re-upload)`);
    ok(gl.matches(tex1), 'the grown texture holds every old cell, and the new rows read empty');
    ok(!gl.gpu.has(tex0) && gl.sent.targetSets === 1, 'the old texture is disposed after its copy; the render target the copy unbound is put back');
    gl.reset();
    await ea.whenIdle();
    gl.frame(uploads, tex1);
    ok(gl.sent.rectBytes === 406 * cellBytes, `landing frame: exactly the 406 cells' pixels cross the bus (${gl.sent.rectBytes} B = 406 × ${cellBytes})`);
    ok(gl.sent.rects === 3, `as ${gl.sent.rects} texSubImage2D calls (a row's tail, the whole rows, a row's head) — was one per pixel row (${(Math.ceil((900 + 406) / cols) - Math.floor(900 / cols)) * cellPx})`);
    ok(gl.sent.copies === 0 && gl.sent.wholes === 0, 'and nothing else');
    ok(gl.matches(tex1), 'every cell, old and new, is what the shader samples');

    // Growth and landing before one frame: the copy runs first, then the cells.
    gl.reset();
    console.log = () => {};
    range(0x30000, 0x30000 + 600).forEach((cp) => ea.ensure(cp));   // 1306 + 601 > 36 × 48: grows to 54 rows
    await ea.whenIdle();
    console.log = log0;
    const tex2 = ea._texture;
    gl.frame(uploads, tex2);
    ok(ea.rows === 54 && gl.sent.copies === 1 && gl.sent.rectBytes === 601 * cellBytes && gl.sent.rects <= 3,
        `grow + land in one frame: 1 copy, then ${gl.sent.rects} rects of exactly the 601 cells (${gl.sent.rectBytes} B)`);
    ok(gl.matches(tex2), 'the shader samples every cell');
    ea.dispose();
}

// ── [2] slug curve doubling ──────────────────────────────────────────────────────────────────
console.log('\n[2] slug curve doubling — the old rows are a GPU copy, the bus carries the new curves');
{
    const uploads = new TextureUploads();
    const gl = new ModelRenderer();
    const slug = new SlugTextures(uploads);
    const buf = slug.buffer;
    let nextSlot = 1;
    const batch = (glyphs, curvesEach) => {
        const slots = new Uint32Array(glyphs), counts = new Uint32Array(glyphs).fill(curvesEach);
        const texels = new Uint32Array(glyphs * curvesEach * CURVE_U32_PER_CURVE);
        for (let i = 0; i < texels.length; i++) texels[i] = (i * 2654435761 + nextSlot) >>> 0;
        for (let i = 0; i < glyphs; i++) slots[i] = nextSlot++;
        return { slots, counts, texels };
    };
    const capTexels = TEXTURE_WIDTH * CURVE_INITIAL_ROWS;
    const curvesEach = 20;
    // Fill to ~90% of the curve capacity, draw (the first upload is whole).
    buf.appendEncoded(batch(Math.floor((capTexels * 0.9) / (curvesEach * CURVE_TEXELS_PER_CURVE)), curvesEach));
    slug.sync();
    gl.frame(uploads, slug.curveTexture, slug.glyphMapTexture);
    const c0 = slug.curveTexture;
    ok(gl.sent.wholes === 2 && gl.matches(c0) && gl.matches(slug.glyphMapTexture), 'the first draw uploads both textures whole');

    // A 935-glyph burst overruns the spare rows: the curve array doubles.
    gl.reset();
    const before = buf.totalCurves;
    buf.appendEncoded(batch(935, curvesEach));
    const { reborn, bytes } = slug.sync();
    const newTexels = (buf.totalCurves - before) * CURVE_TEXELS_PER_CURVE;
    ok(reborn && slug.curveTexture !== c0 && slug.curveTexture.image.height === 2 * CURVE_INITIAL_ROWS, `the curve array doubled (${CURVE_INITIAL_ROWS} → ${slug.curveTexture.image.height} rows): a new texture`);
    gl.frame(uploads, slug.curveTexture, slug.glyphMapTexture);
    const curveBytes = newTexels * 16, mapBytes = 935 * 16;
    ok(gl.sent.copies >= 1 && gl.sent.wholes === 0, `${gl.sent.copies} GPU cop${gl.sent.copies === 1 ? 'y' : 'ies'}, no whole upload (was ${2 * capTexels * 16} B for the curve texture alone)`);
    ok(gl.sent.rectBytes === curveBytes + mapBytes && bytes === curveBytes + mapBytes,
        `the bus carries the new curves' and map entries' texels only: ${gl.sent.rectBytes} B = ${newTexels} curve + 935 map texels × 16`);
    ok(gl.sent.rects <= 6, `in ${gl.sent.rects} texSubImage2D calls (≤ 3 per texture), not one per texture row`);
    ok(gl.matches(slug.curveTexture) && gl.matches(slug.glyphMapTexture), 'what the shader samples is the buffer, old curves and new');
    ok(!gl.gpu.has(c0), 'the replaced curve texture is disposed after its copy');

    // Within capacity again: one glyph is its own texels.
    gl.reset();
    buf.appendEncoded(batch(1, 3));
    slug.sync();
    gl.frame(uploads, slug.curveTexture, slug.glyphMapTexture);
    ok(gl.sent.rectBytes === (3 * CURVE_TEXELS_PER_CURVE + 1) * 16 && gl.sent.copies === 0, `one glyph within capacity: ${gl.sent.rectBytes} B (its 6 curve texels + 1 map texel)`);
    ok(gl.matches(slug.curveTexture) && gl.matches(slug.glyphMapTexture), 'and the shader samples it');
    slug.dispose();
}

// ── [3] the seam ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] the seam — SceneSystems flushes before a top-level render, never a nested one');
{
    await import('./headless-canvas.mjs');
    const { default: SceneSystems } = await import(`${ROOT}packages/glyph3d-core/src/collections/SceneSystems.js`);
    const uploads = new TextureUploads();
    const t = uploads.adopt(new THREE.DataTexture(new Uint8Array(16 * 4 * 4), 16, 4));
    const model = new ModelRenderer();
    model.bind(t);
    const flushedAt = [];
    let nested = 0;
    const renderer = {
        render(s, c) {
            flushedAt.push(uploads.pending);
            if (s === 'outer') { t.image.data[0] = 9; uploads.rect(t, 0, 0, 1, 1); nested++; this.render('inner', c); }
        },
        copyTextureToTexture: (...a) => model.copyTextureToTexture(...a),
        getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {},
    };
    const scene = new THREE.Scene();
    let threw = '';
    try { new SceneSystems(scene, {}, renderer); } catch (e) { threw = e.message; }
    ok(/TextureUploads/.test(threw), 'SceneSystems refuses an atlas without its TextureUploads');
    const systems = new SceneSystems(scene, { _textureUploads: uploads }, renderer);
    uploads.rect(t, 2, 1, 3, 2);
    renderer.render('outer', null);
    ok(flushedAt[0] === 0 && flushedAt[1] === 1 && nested === 1, 'the top-level render runs after the flush; the nested one does not flush (its rect waits)');
    renderer.render('next', null);
    ok(uploads.pending === 0 && model.matches(t), 'the next top-level render flushes it');
    systems.dispose();

    const errors = [];
    const err0 = console.error; console.error = (m) => errors.push(String(m));
    const prev = uploads.adopt(new THREE.DataTexture(new Uint8Array(8 * 2 * 4), 8, 2));
    model.bind(prev);
    const next = uploads.grow(prev, new THREE.DataTexture(new Uint8Array(8 * 4 * 4), 8, 4));
    model.bind(next);   // drawn with no flush first
    console.error = err0;
    ok(errors.some((m) => m.includes('before its GPU copy')), 'a grown texture drawn before any flush is reported loudly');
    let bad = '';
    try { uploads.rect(new THREE.DataTexture(new Uint8Array(4), 1, 1), 0, 0, 1, 1); } catch (e) { bad = e.message; }
    ok(/does not feed/.test(bad), 'a rect on a texture the queue does not feed throws');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
