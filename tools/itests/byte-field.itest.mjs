// byte-field — the Layer 2 render bridge: a bytePipeline-mode GlyphField fed by
// GlyphFieldPipeline (bytes in, three dispatches, field reads the slot buffer in the
// vertex shader). Asserts the app path renders it with zero errors; the screenshot
// (artifacts dir) is the pixel check — glyphs at the right place, nothing splayed.

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');

  const r = await app.evalPage(`(async () => {
    const c = window.__glyphClient;
    const F = (p) => '/@fs' + ${JSON.stringify(process.cwd())} + p;
    const [gfMod, fpMod] = await Promise.all([
      import(F('/packages/glyph3d-core/src/GlyphField.js')),
      import(F('/packages/glyph3d-core/src/compute/GlyphFieldPipeline.js')),
    ]);
    const renderer = c.ctx.renderer;
    const atlas = c.ctx.atlas;
    const scene = c.ctx.scene;

    // Real app metrics — same worldScale + cell metrics CodeGrid uses.
    const worldScale = 0.025;
    const cmMod = await import(F('/packages/glyph3d-core/src/core/cellMetrics.js'));
    const metrics = cmMod.computeCellMetrics(atlas.getCharSize(), worldScale);
    const cgMod = await import(F('/packages/glyph3d-core/src/collections/CodeGrid.js'));

    const TEXT = 'Hello, byte pipeline.\\nsecond line — wrapped segments, page lanes.\\n\\nthird';
    const LAYOUT = { wrapWidth: 24 };

    // LEFT: the byte-pipeline field.
    const field = new gfMod.default(scene, atlas, {
      maxInstances: 1 << 16, worldScale, bytePipeline: true,
      defaultColor: { r: 0.9, g: 0.9, b: 0.95 },
    });
    field.instanceMesh.position.set(-1.5, 0, 0);
    scene.add(field.instanceMesh);
    const pipe = new fpMod.default(renderer, field, atlas, { maxBytes: 1 << 16, worldScale });
    const res = await pipe.setText(TEXT, {
      wrapWidth: LAYOUT.wrapWidth, lineHeight: metrics.lineSpacing,
      zStep: metrics.charHeight * 0.15, origin: { x: 0, y: 0, z: 0 },
    });

    // RIGHT: a CodeGrid with the same text + wrap — the parity reference.
    const grid = new cgMod.default(scene, atlas, { name: 'parity-ref', showBackground: false, showFilename: false, worldScale, gridScale: 1.0 });
    grid.position.set(-1.5, -1.2, 0);
    scene.add(grid);
    await grid.loadText(TEXT);
    grid.setLayout(LAYOUT);

    // Frame both (text at worldScale 0.025 is ~1.5 world units wide).
    const cam = c.ctx.camera;
    cam.position.set(-0.9, -0.7, 4.5);
    cam.lookAt(-0.9, -0.7, 0);
    const v = await pipe.verify();
    return { misses: res.misses, verify: v, extent: pipe.getExtent(), count: field.instanceMesh.geometry.instanceCount,
      metrics: { lineSpacing: metrics.lineSpacing, charHeight: metrics.charHeight } };
  })()`);

  assert.ok(!r.error, r.error || 'eval');
  assert.equal(r.verify?.ok, true, `GPU slots == mirror (worst ${r.verify?.worst}, badRows ${r.verify?.badRows})`);
  assert.ok(r.count > 50, `instanceCount = byteLength (${r.count})`);
  assert.ok(r.extent?.max?.x > 0, `extent stated (${JSON.stringify(r.extent)})`);

  await app.waitFor(1200);   // a few frames — the field renders
  await app.shot('/tmp/byte-field.png');
  assert.noErrors(app);
};
