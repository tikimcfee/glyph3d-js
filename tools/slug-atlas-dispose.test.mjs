// slug-atlas-dispose.test.mjs — headless behavior lock for the LiveSlugAtlas
// texture-pair disposal on hot-swap (VRAM hygiene on the bulk-load growth path).
//
//   bun tools/slug-atlas-dispose.test.mjs
//
// Every atlas growth mints a NEW curve/glyph-map texture pair and hot-swaps it into
// every live field. The orphaned pair's GPUTextures only die on texture.dispose() —
// before the fix, each growth leaked a pair until page unload. The lock: after the
// swap lands, the previous pair is disposed exactly once, the live pair never is,
// and a no-growth ensure disposes nothing.

import LiveSlugAtlas from '../packages/glyph3d-core/src/shaping/LiveSlugAtlas.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

// A stand-in texture: THREE.DataTexture without the import cost, with a dispose tally.
const mkTex = () => {
    const t = { disposed: 0 };
    t.dispose = () => { t.disposed++; };
    return t;
};
const mkPair = () => ({ curveTexture: mkTex(), glyphMapTexture: mkTex(), stats: {} });

// Boot with an empty encode (real SlugEncoder, no glyphs — cheap), then replace the
// internals with controllable fakes: the disposal logic lives in ensureGlyphsEncoded
// and only touches _slugData / _encoder / _fields.
const glyphAtlas = {};
const atlas = new LiveSlugAtlas({ atlas: glyphAtlas, shaper: {}, initialGlyphIds: [] });

const boot = mkPair();
atlas._slugData = boot;
glyphAtlas._slugData = boot;

let current = null;
atlas._encoder = {
    size: 0,
    appendGlyphs() {
        this.size++;
        current = mkPair();
        return { ...current, added: 1, addedIds: [999], grew: true };
    },
};

const field = { sd: null, setSlugData(sd) { this.sd = sd; }, setEmojiTexture() {} };
atlas.registerField(field);

// ── growth #1: boot pair disposed after the swap, new pair live ──
{
    const r = atlas.ensureGlyphsEncoded([999]);
    ok(r.grew === true && r.added === 1, 'growth reported');
    ok(field.sd !== boot && field.sd.curveTexture === current.curveTexture, 'field swapped to the new pair');
    ok(glyphAtlas._slugData.curveTexture === current.curveTexture, 'atlas points at the new pair');
    ok(boot.curveTexture.disposed === 1 && boot.glyphMapTexture.disposed === 1,
        `boot pair disposed once (curve=${boot.curveTexture.disposed}, map=${boot.glyphMapTexture.disposed})`);
    ok(current.curveTexture.disposed === 0 && current.glyphMapTexture.disposed === 0, 'live pair NOT disposed');
}

// ── growth #2: the previous live pair is disposed, the newest stays live ──
{
    const prevLive = current;
    atlas.ensureGlyphsEncoded([999]);
    ok(prevLive.curveTexture.disposed === 1 && prevLive.glyphMapTexture.disposed === 1,
        'previous live pair disposed on the next growth');
    ok(current.curveTexture.disposed === 0, 'newest pair still live');
    ok(field.sd.curveTexture === current.curveTexture, 'field tracking the newest pair');
}

// ── no growth: nothing disposed, nothing swapped ──
{
    const liveNow = current;
    atlas._encoder.appendGlyphs = () => ({ ...current, added: 0, addedIds: [], grew: false });
    const r = atlas.ensureGlyphsEncoded([999]);
    ok(r.grew === false, 'no-growth reported');
    ok(liveNow.curveTexture.disposed === 0, 'no-growth disposes nothing');
    ok(field.sd.curveTexture === liveNow.curveTexture, 'no-growth swaps nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
