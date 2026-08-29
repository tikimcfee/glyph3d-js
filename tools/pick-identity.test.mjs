// pick-identity.test.mjs — a pick ID is an exact identity, end to end.
//
//   bun tools/pick-identity.test.mjs
//
// GPU picking resolves every hover and click by rendering per-glyph IDs into RGBA8 and
// reading the pixel back. The ID must survive four carriers unchanged:
//
//   1. the JS allocator            startId + i
//   2. the shader uniform          baseId  (was uniform(0) -> f32)
//   3. the shader's byte packing   r/g/b/a = id >> {16,8,0,24} & 0xFF
//   4. the CPU decode              a*2^24 + (r<<16 | g<<8 | b)
//
// Carrier 2 was an f32: exact only to 2^24, so base 16,777,217 arrived as 16,777,216 and
// two glyphs answered to one ID. Nothing errors when that happens — the app simply acts
// on the wrong target — which is why the old guard warning at 0x7FFFFFFF was doubly
// wrong: 128x too permissive against the real limit, and a warning for a silent
// mis-resolution.
//
// It was unreachable while the arena capped at 16.7MB of source. It stopped being
// unreachable when ARENA_MAX_BYTES became 44,739,242 — which itself aliases in f32,
// landing on 44,739,240.
//
// WHAT THIS FILE COVERS AND WHAT IT DOES NOT. The pack/unpack round trip and the
// allocator are exact here on the CPU. The SHADER's carrier is asserted at the source
// level only (a 'uint' uniform, no int() narrowing) because nothing in this tree renders
// a pick pass headlessly. A GPU gate that renders an ID past 2^24 and asserts the
// readback resolves to the glyph it aimed at is still owed; this file is not a
// substitute for it, and says so rather than implying coverage it lacks.

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// The shader's packing (PickingSystem _getGlyphPickMaterial fragmentFn), in JS.
const packRGBA = (id) => [(id >>> 16) & 0xFF, (id >>> 8) & 0xFF, id & 0xFF, (id >>> 24) & 0xFF];
// The CPU decode (pickAsync), verbatim in shape.
const unpackRGBA = (p) => p[3] * 0x1000000 + ((p[0] << 16) | (p[1] << 8) | p[2]);

// IDs that matter: the 2^24 boundary, past it, the arena ceiling, the u32 top.
const IDS = [
    1, 255, 256, 65535, 65536,
    0xFFFFFF, 0x1000000, 0x1000001,          // the f32 wall, and one past it
    20_000_000, 44_739_242,                   // ARENA_MAX_BYTES — aliases in f32
    0x7FFFFFFF, 0x80000000, 0xFFFFFFFE, 0xFFFFFFFF,
];

console.log('the byte packing round-trips every id in the u32 space');
{
    for (const id of IDS) {
        const back = unpackRGBA(packRGBA(id));
        ok(back === id, `id ${id} survives pack/unpack (got ${back})`);
    }
    // The alpha channel carries bits 24-31; without it the space is 2^24 and the top
    // half of every id above silently folds.
    ok(packRGBA(0x1000000)[3] === 1, 'bit 24 lands in ALPHA, not dropped');
    ok(packRGBA(0xFF000000)[3] === 0xFF, 'the whole top byte survives');
}

console.log('an f32 carrier is genuinely lossy here — the bug was real');
{
    // Not decoration: this is the counterfactual the fix rests on. If f32 could carry
    // these, the migration was unnecessary and this whole file is noise.
    const f = new Float32Array(1);
    const aliased = IDS.filter((id) => { f[0] = id; return f[0] !== id; });
    ok(aliased.length > 0, 'some ids in the working range DO alias through f32');
    f[0] = 0x1000001;
    ok(f[0] === 0x1000000, '2^24 + 1 collapses onto 2^24 in f32 (the original defect)');
    f[0] = 44_739_242;
    ok(f[0] === 44_739_240, 'ARENA_MAX_BYTES itself aliases in f32 (44,739,242 -> 44,739,240)');
    // ...and u32 carries all of them.
    const u = new Uint32Array(1);
    ok(IDS.every((id) => { u[0] = id; return u[0] === id; }), 'every id survives a u32 carrier');
}

console.log('the shader carriers are u32 at the source level');
{
    const src = read('packages/glyph3d-core/src/picking/PickingSystem.js');
    const uniforms = [...src.matchAll(/const baseId = uniform\(([^)]*)\)/g)].map((m) => m[1]);
    ok(uniforms.length === 2, `both pick materials declare a baseId uniform (found ${uniforms.length})`);
    ok(uniforms.every((u) => /'uint'/.test(u)),
       `every baseId uniform is 'uint' — uniform(0) alone is an f32 carrier (got: ${uniforms.join(' | ')})`);

    // int() would cap the space at 2^31 AND make shiftRight arithmetic rather than
    // logical, corrupting the alpha byte for any id >= 2^31.
    ok(!/int\(baseId\)/.test(src), 'baseId is never narrowed with int()');
    ok(!/int\(instanceIndex\)/.test(src), 'instanceIndex is never narrowed with int() (it is natively unsigned)');
    ok(/const id = baseId\.add\(instanceIndex\)/.test(src),
       'the glyph id is baseId.add(instanceIndex), both u32, uncast');

    // The CPU-side mirror harnesses check against must carry ids exactly too, or it
    // disagrees with the shader it exists to verify.
    for (const [p, what] of [['packages/glyph3d-core/src/GlyphField.js', 'GlyphField'],
                             ['packages/glyph3d-core/src/MegaGlyphField.js', 'MegaGlyphField']]) {
        const t = read(p);
        // [\s\S], not [^\n]: GlyphField's PRIMARY declaration wraps across two lines, and
        // a single-line regex read straight past it. Caught by mutating that site alone
        // and watching this file report 33/33 with the defect reinstated — the resize
        // path was covered, the allocation path was not, and the count tooth below
        // hid it because the other site still matched.
        const decls = [...t.matchAll(/instancePickingId'[\s\S]{0,160}?(Float32Array|Uint32Array)/g)].map((m) => m[1]);
        ok(decls.length > 0, `${what} declares instancePickingId`);
        ok(decls.every((d) => d === 'Uint32Array'),
           `${what}'s instancePickingId is a Uint32Array (got ${decls.join(',')})`);
        // Pin the site count. Without this, a declaration added out of the regex's reach
        // lowers coverage while every tooth stays green — the same shape as the miss above.
        const expectSites = what === 'GlyphField' ? 2 : 1;
        ok(decls.length === expectSites,
           `${what} has ${expectSites} instancePickingId declaration(s), all covered (found ${decls.length})`);
    }
}

console.log('the ID-space guard is exact, and it refuses');
{
    const src = read('packages/glyph3d-core/src/picking/PickingSystem.js');
    // Match the COMPARISON, not the constant: the constant legitimately appears in the
    // comment explaining why it was wrong, and a grep that cannot tell code from prose
    // fails on its own documentation (it did) — or worse, passes on a stale one.
    ok(!/endId\s*>\s*0x7FFFFFFF/.test(src), 'the old 31-bit signed bound no longer gates anything');
    ok(/endId > 0x100000000/.test(src), 'the guard is the true u32 bound (2^32)');
    // A mis-resolved pick has no symptom at the seam — the app acts on the wrong target.
    const guard = src.slice(src.indexOf('endId > 0x100000000'), src.indexOf('endId > 0x100000000') + 600);
    ok(/throw new Error/.test(guard), 'exhausting the ID space REFUSES rather than warning');
    ok(!/console\.warn/.test(guard), 'no warn survives in the guard');
}

console.log(fail === 0 ? `\n✓ pick-identity: ${pass} passed, 0 failed`
                       : `\n✗ pick-identity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
