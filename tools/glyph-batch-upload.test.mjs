// glyph-batch-upload.test.mjs — the GlyphBatch arena's group table uploads only what changed
// (collections/GlyphBatch.js): at rest nothing, one label fading its one row, a moving camera every
// row (eye-relative poses) — as per-row ranges up to `rangeRows`, past that the whole table.
//
//   bun tools/glyph-batch-upload.test.mjs
//
// The test keeps a model of the GPU's copy of the table and applies each upload exactly as three's
// WebGLTextures does (no ranges → the whole texture; ranges → those spans; then the ranges are
// cleared and onUpdate fires). Locks:
//   - after EVERY refresh + upload, the GPU copy equals the CPU table, bit for bit — whatever moved
//   - a refresh at rest uploads nothing (the texture's version doesn't move); teeth: the
//     always-upload policy (every frame needsUpdate) fails it
//   - one label's alpha change uploads exactly its row; a camera move with ≤ rangeRows labels uploads
//     one range per row, with more the whole table
//   - two refreshes before an upload never narrow a pending whole-table upload to ranges (the GPU
//     copy stays exact)

import * as THREE from 'three';
import SceneTransforms from '../packages/glyph3d-core/src/collections/SceneTransforms.js';
import InstancedField from '../packages/glyph3d-core/src/collections/InstancedField.js';
import GlyphBatch, { enrollGlyphField } from '../packages/glyph3d-core/src/collections/GlyphBatch.js';
import { GROUP_STRIDE } from '../packages/glyph3d-core/src/core/glyphMaterial.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const ROW = GROUP_STRIDE * 4;

/** The GPU's copy of a texture, uploaded the way three's WebGLTextures does. */
function gpu() {
    let copy = null, version = -1, texRef = null, uploads = { full: 0, ranges: 0 };
    return {
        get copy() { return copy; },
        get uploads() { return uploads; },
        /** One render's upload of `tex`, if it is due. */
        render(tex) {
            if (tex !== texRef) { texRef = tex; copy = new Float32Array(tex.image.data.length); version = -1; }
            if (tex.version === version) return;
            version = tex.version;
            const d = tex.image.data;
            if (!tex.updateRanges.length) { copy.set(d); uploads.full++; }
            else for (const r of tex.updateRanges) { copy.set(d.subarray(r.start, r.start + r.count), r.start); uploads.ranges++; }
            tex.clearUpdateRanges();   // what three does after it uploads (the renderer, not the app)
            tex.onUpdate?.(tex);
        },
        reset() { uploads = { full: 0, ranges: 0 }; },
    };
}
const exact = (G, copy) => G.length === copy.length && G.every((v, i) => Object.is(v, copy[i]));

function world(n, { rangeRows } = {}) {
    const scene = new THREE.Scene();
    new SceneTransforms(scene);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1e7);
    camera.position.set(0, 0, 400); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const labels = Array.from({ length: n }, (_, i) => {
        const f = enrollGlyphField(new InstancedField(null, null, { maxInstances: 64 }));
        f.loadText(`label ${i}`);
        f.instanceMesh.position.set(i * 20 - n * 10, (i % 3) * 5, 0);
        scene.add(f.instanceMesh);
        return f;
    });
    scene.updateMatrixWorld();
    const batch = new GlyphBatch(scene, {}, rangeRows != null ? { rangeRows } : undefined);
    const g = gpu();
    const frame = () => { const st = batch.update(camera); g.render(batch.arena.groupTexture); return st; };
    return { scene, camera, labels, batch, g, frame };
}

// ── 1. Few labels: rest, one fade, a camera move.
{
    const w = world(3);
    let st = w.frame();
    const tex = () => w.batch.arena.groupTexture, G = () => w.batch.arena._groupData;
    ok(exact(G(), w.g.copy), 'first frame: the GPU copy is the table');
    ok(st.uploadRows === w.batch.arena.maxGroups, `first frame uploads the whole table (${st.uploadRows} rows)`);
    const v = tex().version;
    w.g.reset();
    for (let i = 0; i < 5; i++) st = w.frame();
    ok(tex().version === v && st.uploadRows === 0 && w.g.uploads.full + w.g.uploads.ranges === 0, `at rest: no upload in 5 frames (version ${v} → ${tex().version})`);
    ok(exact(G(), w.g.copy), 'at rest: the GPU copy is still the table');

    // One label fades: only its row.
    w.labels[1].setGroupAlpha(0, 0.4);
    w.g.reset();
    st = w.frame();
    const row = w.batch._members.findIndex((m) => m.field === w.labels[1]) + 1;
    ok(st.uploadRows === 1 && w.g.uploads.ranges === 1 && w.g.uploads.full === 0, `one fade uploads one row (rows ${st.uploadRows}, ranges ${w.g.uploads.ranges}, full ${w.g.uploads.full})`);
    ok(Math.abs(w.g.copy[row * ROW + 11] - 0.4) < 1e-6 && exact(G(), w.g.copy), 'and the GPU copy holds the new alpha, everything else unchanged');

    // The camera moves: every row's eye-relative pose changes — one range per row (3 ≤ rangeRows).
    w.camera.position.x += 7; w.camera.updateMatrixWorld();
    w.g.reset();
    st = w.frame();
    ok(st.uploadRows === 3 && w.g.uploads.ranges === 3, `a camera move with 3 labels uploads 3 row ranges (${st.uploadRows}, ${w.g.uploads.ranges})`);
    ok(exact(G(), w.g.copy), 'and the GPU copy is exact');

    // A label leaves the view (culled → its row goes dark): one row.
    w.labels[2].instanceMesh.position.x = 1e6; w.scene.updateMatrixWorld();
    w.g.reset();
    st = w.frame();
    ok(exact(G(), w.g.copy), `a label culled: the GPU copy is exact (${st.uploadRows} row(s))`);
}

// ── 2. Many labels: a camera move uploads the whole table.
{
    const w = world(12);
    w.frame();
    w.camera.position.y += 3; w.camera.updateMatrixWorld();
    w.g.reset();
    const st = w.frame();
    ok(st.uploadRows === w.batch.arena.maxGroups && w.g.uploads.full === 1 && w.g.uploads.ranges === 0, `12 labels moving: one whole-table upload (${JSON.stringify(w.g.uploads)})`);
    ok(exact(w.batch.arena._groupData, w.g.copy), 'exact');
}

// ── 3. Two refreshes before a render: a pending whole upload is never narrowed.
//       (12 labels and a camera move: every row changes → whole; then one fade before the render.)
function twoRefreshes(forget) {
    const w = world(12);
    w.frame();
    w.camera.position.x += 5; w.camera.updateMatrixWorld();
    w.batch.update(w.camera);                // whole-table upload pending (every row moved)
    w.labels[3].setGroupAlpha(0, 0.2);       // then one row changes before any render
    if (forget) w.batch._fullPending = false;   // (teeth: a policy that forgets the pending upload)
    w.batch.update(w.camera);
    w.g.reset();
    w.g.render(w.batch.arena.groupTexture);
    return w;
}
{
    const w = twoRefreshes(false);
    ok(w.g.uploads.full === 1 && w.g.uploads.ranges === 0, `the pending whole upload stays whole (${JSON.stringify(w.g.uploads)})`);
    ok(exact(w.batch.arena._groupData, w.g.copy), 'and the GPU copy is exact');
}

// ── 4. Teeth: the always-upload policy fails the rest check; a range policy that forgets the
//       pending whole upload breaks the GPU copy.
{
    const w = world(3);
    w.frame();
    const tex = w.batch.arena.groupTexture, v = tex.version;
    tex.needsUpdate = true;   // what the old code did every frame
    ok(tex.version !== v, 'teeth: an every-frame needsUpdate moves the version at rest (the rest check catches it)');
    const x = twoRefreshes(true);
    ok(!exact(x.batch.arena._groupData, x.g.copy), `teeth: narrowing the pending whole upload leaves the GPU copy wrong (${JSON.stringify(x.g.uploads)})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} glyph-batch-upload: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
