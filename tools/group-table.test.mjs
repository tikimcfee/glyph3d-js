// group-table.test.mjs — an InstancedField's group table is sized by what it USES (most fields only
// ever use group 0), and grows in place on demand; the placeholder textures every glyph material
// reads before its real ones exist are shared, not one per field.
//
//   bun tools/group-table.test.mjs
//
// Locks:
//   - a field that only uses group 0 allocates ONE row (GROUP_STRIDE×1 texels), not 64
//   - createGroup past the table doubles it: every existing row is kept bit-exact, the new rows sit
//     at their defaults, a new texture of the new height replaces the old (disposed), and the
//     material's groupTexture / maxGroups uniforms — what the vertex stage clamps and culls by —
//     point at it. The pick pass reads the same. Teeth: a growth that leaves the material's
//     uniforms stale culls the new group (aGroupId >= maxGroups → dead) — the check must FAIL
//   - an explicit maxGroups (the GlyphBatch arena, ContentTreeLabels) is allocated up front
//   - the ceiling (groupCap) still fails loud, once, and hands out the dead group 0
//   - farTint's cache can't alias across a growth (the texture identity is in its key)
//   - EVERY consumer of a grown table sees it: the material, the pick pass, the GlyphBatch arena
//     (it copies each label's row 0 every frame — the row written after a growth reaches the arena;
//     a 70-label batch draws a label past row 64), far-LOD's tint (a glyph in a group past the
//     starting capacity counts once the table holds it)
//   - every glyph material shares ONE 1×1 RGBA and ONE 1×1 uint placeholder; disposing a field
//     never disposes them, their texel data survives every dispose (a context restore re-uploads
//     from it), and fields made after a full teardown (an HMR re-mount) get the same ones

import './headless-canvas.mjs';
import * as THREE from 'three';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import { GROUP_STRIDE, glyphPlaceholderRGBA, glyphPlaceholderUint } from '../packages/glyph3d-core/src/core/glyphMaterial.js';
import { PickingSystem } from '../packages/glyph3d-core/src/picking/PickingSystem.js';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import GlyphBatch, { enrollGlyphField } from '../packages/glyph3d-core/src/collections/GlyphBatch.js';
import { SLOT_FLOATS, LANE_GROUP_ID } from '../packages/glyph3d-core/src/core/InstancedSlotBuffer.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const atlas = { getCharSize: () => ({ width: 28, height: 55, em: 48 }), _slugData: null, _shaper: null };
const ROW = GROUP_STRIDE * 4;
const field = (opts) => new InstancedField(new THREE.Scene(), atlas, opts);
/** The vertex stage's cull for a slot's group (glyphMaterial: aGroupId >= maxGroups → dead). */
const drawsGroup = (f, g) => g < f.material.uniforms.maxGroups.value && f.material.uniforms.groupTexture.value.image.height > g;

// ── 1. A group-0 field: one row.
{
    const f = field();
    ok(f.maxGroups === 1 && f._groupData.length === ROW, `a group-0 field allocates one row (${f.maxGroups} rows, ${f._groupData.length} floats)`);
    ok(f.groupTexture.image.width === GROUP_STRIDE && f.groupTexture.image.height === 1, `its texture is ${GROUP_STRIDE}×1`);
    ok(f.material.uniforms.maxGroups.value === 1 && f.material.uniforms.groupTexture.value === f.groupTexture, 'the material reads that table');
}

// ── 2. Growth keeps every row, re-points the material and the pick pass.
{
    const f = field();
    f.setGroupAlpha(0, 0.37);
    f.setGroupClip(0, 5, -5, true);
    const row0 = Array.from(f._groupData.slice(0, ROW));
    const oldTex = f.groupTexture;
    let disposed = false;
    oldTex.addEventListener('dispose', () => { disposed = true; });
    const g1 = f.createGroup();
    ok(g1 === 1 && f.maxGroups === 2, `the first createGroup grows the table to 2 rows (got group ${g1}, ${f.maxGroups} rows)`);
    ok(Array.from(f._groupData.slice(0, ROW)).every((v, i) => Object.is(v, row0[i])), 'row 0 is kept bit-exact');
    const r1 = f._groupData.slice(ROW, 2 * ROW);
    ok(r1[4 + 3] === 1 && r1[8] === 1 && r1[11] === 1 && r1[12] === 1, 'the new row sits at its defaults (identity quat, white, opaque, unit scale)');
    ok(disposed && f.groupTexture !== oldTex && f.groupTexture.image.height === 2, 'a new texture of the new height replaces the old (disposed)');
    ok(f.material.uniforms.groupTexture.value === f.groupTexture && f.material.uniforms.maxGroups.value === 2, 'the material points at it');
    ok(drawsGroup(f, g1), 'the new group draws (the vertex stage sees maxGroups 2)');
    // Further growth: 2 → 4 → 8, rows written along the way all kept.
    f.setGroupAlpha(g1, 0.5);
    const ids = [g1];
    for (let i = 0; i < 6; i++) { const g = f.createGroup(); f.setGroupAlpha(g, 0.1 * (i + 1)); ids.push(g); }
    ok(f.maxGroups === 8 && ids.at(-1) === 7, `7 groups → 8 rows (got ${f.maxGroups}, last id ${ids.at(-1)})`);
    ok(f._groupData[0 * ROW + 11] === Math.fround(0.37) && f._groupData[1 * ROW + 11] === 0.5 && Math.abs(f._groupData[7 * ROW + 11] - 0.6) < 1e-6, 'every row written before a growth survives it');
    // The pick pass reads the live table.
    const ps = new PickingSystem({ setRenderTarget() {}, clear() {}, render() {} });
    ps._target = new THREE.WebGLRenderTarget(4, 1);
    ps.register('glyph', f.instanceMesh, f, { count: 1 });
    const ch = ps._channel('glyph');
    f.createGroup();   // 8 → 16 after registration
    ps._renderChannelPass(ch, new THREE.PerspectiveCamera(), new THREE.Scene(), 0);
    const pu = ch.entries[0].material.uniforms;
    ok(pu.groupTexture.value === f.groupTexture && pu.maxGroups.value === 16, `the pick pass reads the grown table (${pu.maxGroups.value} rows)`);
}

// ── 3. Teeth: a growth that leaves the material stale culls the new group.
{
    class StaleGrowth extends InstancedField {
        _growGroups(rows) {
            const keep = { tex: this.material.uniforms.groupTexture.value, rows: this.material.uniforms.maxGroups.value };
            super._growGroups(rows);
            this.material.uniforms.groupTexture.value = keep.tex;
            this.material.uniforms.maxGroups.value = keep.rows;
        }
    }
    const f = new StaleGrowth(new THREE.Scene(), atlas);
    const g = f.createGroup();
    ok(!drawsGroup(f, g), 'teeth: with stale uniforms the new group would be culled as dead');
}

// ── 4. Explicit sizes, the ceiling.
{
    ok(field({ maxGroups: 64 }).groupTexture.image.height === 64, 'an explicit maxGroups is allocated up front');
    const f = field({ groupCap: 4 });
    const errs = [];
    const err = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    const got = [1, 2, 3, 4, 5].map(() => f.createGroup());
    console.error = err;
    ok(got.join() === '1,2,3,0,0' && f.maxGroups === 4, `past the cap: the dead group 0 (got ${got}, ${f.maxGroups} rows)`);
    ok(errs.length === 1 && /EXHAUSTED/.test(errs[0]), 'and one loud error');
    // Released rows are reused before growing.
    const r = field();
    const a = r.createGroup();
    r.releaseGroup(a);
    ok(r.createGroup() === a && r.maxGroups === 2, 'a released row is reused, no growth');
}

// ── 5. farTint can't alias across a growth.
{
    const f = field();
    f._layoutBounds = { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
    const before = f.farTint();
    const cache = f._farTint;
    f.createGroup();
    f.farTint();
    ok(f._farTint !== cache && f._farTint.groupTex === f.groupTexture, 'a growth invalidates the cached tint (the texture is in its key)');
    void before;
}

// ── 5b. GlyphBatch: a label whose table grew reaches the arena with its LIVE row 0; a big batch
//        draws a label past row 64.
{
    const scene = new THREE.Scene();
    new SceneTransforms(scene);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1e7);
    camera.position.set(0, 0, 400); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const label = (text, x = 0) => {
        const f = enrollGlyphField(new InstancedField(null, null, { maxInstances: 64 }));
        f.loadText(text);
        f.instanceMesh.position.set(x, 0, 0);
        scene.add(f.instanceMesh);
        return f;
    };
    const L = label('grown');
    const old = L._groupData;
    L.createGroup(); L.createGroup();   // the table grows 1 → 2 → 4; the label still draws in group 0
    L.setGroupColor(0, { r: 0.25, g: 0.5, b: 0.75 });
    L.setGroupAlpha(0, 0.6);
    ok(L._groupData !== old && L.maxGroups === 4, 'the label\'s table grew (a new array)');
    scene.updateMatrixWorld();
    const batch = new GlyphBatch(scene, {});
    batch.update(camera);
    const A = batch.arena._groupData, r = (batch._members.findIndex((m) => m.field === L) + 1) * ROW;
    ok(Math.abs(A[r + 8] - 0.25) < 1e-6 && Math.abs(A[r + 9] - 0.5) < 1e-6 && Math.abs(A[r + 11] - 0.6) < 1e-6, `the arena carries the row written after the growth (rgb ${A[r + 8]},${A[r + 9]}, alpha ${A[r + 11]})`);
    ok(old[8] !== 0.25, 'teeth: the pre-growth array never saw that write (a stale reference would draw the old row)');
    const many = Array.from({ length: 70 }, (_, i) => label(`l${i}`, i * 3));
    scene.updateMatrixWorld();
    const st = batch.update(camera);
    const last = many[69], row = batch._members.findIndex((m) => m.field === last) + 1;
    ok(row > 64 && batch.arena.maxGroups > 64 && batch.arena._groupData[row * ROW + 11] > 0, `a 71-label batch draws a label at arena row ${row} (> 64; arena ${batch.arena.maxGroups} rows, drawn ${st.drawn})`);
    ok(batch.arena.material.uniforms.groupTexture.value === batch.arena.groupTexture && batch.arena.material.uniforms.maxGroups.value === batch.arena.maxGroups, "and the arena's own material reads its table");
}

// ── 5c. far-LOD's tint counts a glyph in a group past the starting capacity, once the table holds it.
{
    const f = new InstancedField(null, null, { maxInstances: 64 });
    f.loadText('tint me');
    const n = f.getGlyphCount();
    const g1 = f.createGroup(), g2 = f.createGroup();   // 1 → 2 → 4 rows; g2 = 2 was past the 1-row start
    for (let i = 0; i < n; i++) f.slotBuffer.f32[i * SLOT_FLOATS + LANE_GROUP_ID] = g2;
    f._interleavedBuffer.needsUpdate = true;
    f.setGroupAlpha(0, 0);   // group 0 dark: only g2 can tint
    f._layoutBounds ??= { min: { x: 0, y: 0 }, max: { x: 10, y: 2 } };
    const lit = f.farTint();
    f.setGroupAlpha(g2, 0);
    const dark = f.farTint();
    ok(g1 === 1 && g2 === 2 && lit?.cover > 0 && dark?.cover === 0, `the tint reads group ${g2}'s row, past the 1-row start (cover ${lit?.cover} lit, ${dark?.cover} dark)`);
}

// ── 6. Shared placeholders.
{
    const a = field(), b = field();
    const ua = a.material.uniforms, ub = b.material.uniforms;
    ok(ua.emojiTexture.value === glyphPlaceholderRGBA() && ub.emojiTexture.value === glyphPlaceholderRGBA(), 'every material shares the one RGBA placeholder');
    ok(ua.curveTexture.value === glyphPlaceholderUint() && ub.glyphMapTexture.value === glyphPlaceholderUint(), 'and the one uint placeholder');
    let gone = false;
    glyphPlaceholderRGBA().addEventListener('dispose', () => { gone = true; });
    glyphPlaceholderUint().addEventListener('dispose', () => { gone = true; });
    a.dispose(); b.dispose();
    ok(!gone, 'disposing fields never disposes the shared placeholders');
    ok(glyphPlaceholderRGBA().image.data?.length === 4 && glyphPlaceholderUint().image.data?.length === 4, 'their texel data survives (a context restore re-uploads from it)');
    const c = field();
    ok(c.material.uniforms.emojiTexture.value === glyphPlaceholderRGBA() && c.material.uniforms.curveTexture.value === glyphPlaceholderUint(), 'a field made after a full teardown (a re-mount) gets the same live ones');
    c.dispose();
}

console.log(`${fails ? 'FAIL' : 'ok'} group-table: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
