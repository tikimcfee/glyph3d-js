// glyph-fill-pass.test.mjs — the background pass of a glyph field, headless: a field's cells'
// fills draw from the SAME mesh, geometry, buffers and textures as its ink, by a second material
// that three draws first; a field with no fill has no such pass at all, and one whose fills are
// gone hides it without touching the scene's visibility. (What the pass looks like — a wide glyph
// whole over its neighbour's fill — is wall-cells-check's, in pixels.)
//
//   bun tools/glyph-fill-pass.test.mjs

await import('./headless-canvas.mjs');
const THREE = await import('three');
const { default: InstancedField } = await import('../packages/glyph3d-core/src/collections/InstancedField.js');
const M = await import('../packages/glyph3d-core/src/core/glyphMaterial.js');
const { showGeneration, default: SceneTransforms } = await import('../packages/glyph3d-core/src/collections/SceneTransforms.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${a}, want ${b}`);

const atlas = { getCharSize: () => ({ width: 8, height: 16 }), _shaper: null, _slugData: null };

/** The render items three would make for a mesh: one per geometry group whose material is visible (WebGLRenderer.projectObject). */
function renderItems(mesh) {
    const mat = mesh.material;
    if (!Array.isArray(mat)) return mat.visible ? [mat] : [];
    return mesh.geometry.groups.map((g) => mat[g.materialIndex]).filter((m) => m && m.visible);
}

console.log('a field with no fill');
{
    const scene = new THREE.Scene();
    const f = new InstancedField(scene, atlas, { maxInstances: 64 });
    f.render('plain text', { x: 0, y: 0, z: 0 });
    ok(f.fillMaterial === null && f.instanceMesh.material === f.material, 'has one material, the ink\'s: no fill pass exists');
    eq(f.geometry.groups.length, 0, 'and no geometry groups');
    eq(renderItems(f.instanceMesh).length, 1, 'one draw');
    ok(f.fillsActive === false, 'fillsActive reads false');
    // A tint (a highlight colour with no fill) makes the texture — and the pass, hidden.
    f.setGlyphHighlight(2, { r: 0.2, g: 0.2, b: 0 });
    ok(f.fillMaterial !== null && f.fillMaterial.visible === false, 'a tint alone leaves the fill pass hidden');
    eq(renderItems(f.instanceMesh).length, 1, 'still one draw');
    f.dispose();
}

console.log('the first fill');
{
    const scene = new THREE.Scene();
    new SceneTransforms(scene);
    const f = new InstancedField(scene, atlas, { maxInstances: 64 });
    f.render('filled text', { x: 0, y: 0, z: 0 });
    const geometry = f.geometry, slots = f._interleavedBuffer, groupTex = f.groupTexture;
    const gen = showGeneration();
    f.setGlyphHighlight(3, { r: 1, g: 0, b: 0 }, 0.8);
    ok(Array.isArray(f.instanceMesh.material) && f.instanceMesh.material.length === 2, 'the mesh takes two materials');
    ok(f.instanceMesh.material[0] === f.fillMaterial && f.instanceMesh.material[1] === f.material, 'fill first, ink second');
    ok(f.geometry === geometry && f._interleavedBuffer === slots, 'over the same geometry and slot buffer (nothing copied, nothing more to upload)');
    const groups = f.geometry.groups;
    ok(groups.length === 2 && groups[0].materialIndex === 0 && groups[1].materialIndex === 1 && groups.every((g) => g.start === 0 && g.count === Infinity),
        'as two geometry groups that both span the quad, in that order');
    const items = renderItems(f.instanceMesh);
    ok(items.length === 2 && items[0] === f.fillMaterial && items[1] === f.material, 'three draws the fill, then the ink (same object: same sort key, group order)');
    ok(f.fillsActive === true, 'fillsActive reads true');
    const u = f.fillMaterial.uniforms;
    ok(u.groupTexture.value === groupTex && u.maxGroups.value === f.maxGroups && u.highlightTexture.value === f._highlightTexture && u.hasHighlight.value === 1,
        'the fill material reads the field\'s own group table and highlight texture');
    ok(f.material.uniforms.highlightTexture.value === f._highlightTexture, 'which the ink material reads too (for tints)');
    ok(f.fillMaterial.transparent && f.fillMaterial.premultipliedAlpha && f.fillMaterial.depthTest && f.fillMaterial.depthWrite, 'blended and depth-tested as the ink is');
    ok(f.fillMaterial.vertexShader.includes('invariant gl_Position;') && f.material.vertexShader.includes('invariant gl_Position;'), 'both vertex stages declare gl_Position invariant (a cell\'s fill and ink share a depth)');
    ok(f.fillMaterial.vertexShader.includes('if (fill.a <= 0.0) { gl_Position = OFFSCREEN; return; }'), 'a cell with no fill is collapsed in the vertex stage');
    ok(!f.material.fragmentShader.includes('vFillAmount') && !f.material.fragmentShader.includes('vBgColor'), 'the ink pass draws no fill');

    // Hiding and showing it is the material's flag: no scene visibility moves (the flat render
    // lists and the batches rebuild on those).
    f.fillsActive = false;
    eq(renderItems(f.instanceMesh).length, 1, 'fillsActive = false: the fill draw is gone');
    ok(f.instanceMesh.visible === true && showGeneration() === gen, 'with no visibility change in the scene');
    f.fillsActive = true;
    eq(renderItems(f.instanceMesh).length, 2, 'and back');

    // setGlyphHighlight counts its fills: the pass goes when the last one is cleared.
    f.setGlyphHighlight(5, { r: 0, g: 1, b: 0 }, 0.5);
    f.setGlyphHighlight(3, null);
    ok(f.fillsActive, 'one of two fills cleared: still drawn');
    f.setGlyphHighlight(5, { r: 0, g: 1, b: 0 }, 0.9);
    f.setGlyphHighlight(5, null);
    ok(!f.fillsActive && renderItems(f.instanceMesh).length === 1, 'the last fill cleared: the fill pass is not drawn');
    f.setGlyphHighlight(4, { r: 0.2, g: 0.2, b: 0 });
    ok(!f.fillsActive, 'a tint is not a fill');
    f.setGlyphHighlight(1, { r: 1, g: 0, b: 0 }, 1);
    f.copyGlyphLanes(1, 6, 1);
    f.setGlyphHighlight(1, null);
    ok(f.fillsActive, 'a fill copied to another slot (copyGlyphLanes) is counted');
    f.setGlyphHighlight(6, null);
    ok(!f.fillsActive, 'until it too is cleared');
    f.setGlyphHighlight(3, { r: 1, g: 0, b: 0 }, 0.8);

    // The group table growing rebinds both materials.
    for (let i = 0; i < 5; i++) f.createGroup();
    ok(f.groupTexture !== groupTex, 'the group table grew (a new texture)');
    ok(f.fillMaterial.uniforms.groupTexture.value === f.groupTexture && f.fillMaterial.uniforms.maxGroups.value === f.maxGroups
        && f.material.uniforms.groupTexture.value === f.groupTexture, 'and both materials read the new one');

    // The highlight texture growing rebinds both too.
    const hl = f._highlightTexture;
    f.highlightWords(5000);
    ok(f._highlightTexture !== hl && f.fillMaterial.uniforms.highlightTexture.value === f._highlightTexture && f.material.uniforms.highlightTexture.value === f._highlightTexture,
        'a taller highlight texture reaches both materials');

    let disposed = 0;
    f.fillMaterial.addEventListener('dispose', () => { disposed++; });
    f.dispose();
    eq(disposed, 1, 'dispose frees the fill material');
}

console.log('the line knobs');
{
    const scene = new THREE.Scene();
    const f = new InstancedField(scene, atlas, { maxInstances: 8 });
    const u = f.material.uniforms;
    const m0 = M.getGlyphLineMetrics(), s0 = M.getGlyphLineStyle();
    M.setGlyphLineMetrics({ underlineY: 0.1, strikeY: 0.45, thickness: 0.04 });
    ok(Math.abs(u.uLineA.value.x - 0.1) < 1e-6 && Math.abs(u.uLineA.value.y - 0.04) < 1e-6 && Math.abs(u.uLineA.value.z - 0.45) < 1e-6, 'the font\'s line metrics reach a live material');
    M.setGlyphLineStyle({ lineThickness: 2, dimAlpha: 0.3 });
    ok(Math.abs(u.uLineA.value.y - 0.08) < 1e-6 && Math.abs(u.uDimAlpha.value - 0.3) < 1e-6, 'lineThickness scales them and dimAlpha sets dim, live');
    M.setGlyphLineStyle({ underlineRaise: 0.05 });
    ok(Math.abs(u.uLineA.value.x - 0.15) < 1e-6, 'underlineRaise lifts the underline');
    ok(u.uLineB.value.x >= u.uLineA.value.y / 2 - 1e-9 && u.uLineB.value.y - u.uLineB.value.x > u.uLineA.value.y, 'a double underline\'s two lines stay in the cell, a gap apart');
    ok(u.uLineB.value.z - u.uLineB.value.w >= u.uLineA.value.y / 2 - 1e-9, 'a curly underline\'s trough stays in the cell');
    const g = new InstancedField(scene, atlas, { maxInstances: 8 });
    ok(Math.abs(g.material.uniforms.uDimAlpha.value - 0.3) < 1e-6 && g.material.uniforms.uLineA.value === u.uLineA.value, 'a field made after takes the values in force');
    for (const bad of [{ dimAlpha: 2 }, { lineThickness: -1 }, { nope: 1 }, { dimAlpha: NaN }]) {
        let threw = false;
        try { M.setGlyphLineStyle(bad); } catch { threw = true; }
        ok(threw, `setGlyphLineStyle refuses ${JSON.stringify(bad)}`);
    }
    let threw = false;
    try { M.setGlyphLineMetrics({ underlineY: 0.1, strikeY: 0.4, thickness: 0 }); } catch { threw = true; }
    ok(threw, 'setGlyphLineMetrics refuses a zero thickness');
    M.setGlyphLineMetrics(m0); M.setGlyphLineStyle(s0);
    f.dispose(); g.dispose();
}

console.log(`\nglyph-fill-pass: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
