// byte-field — the Layer 2 render bridge: a MEGA-FIELD VIEW fed by the SHARED
// pipeline arena (bytes staged as an item, one coalesced flush, the one shared
// field reads the arena's slot buffer in the vertex shader; the view's slot range
// + posed group texel are its render presence). Asserts the app path renders it
// with zero errors; the screenshot (artifacts dir) is the pixel check — glyphs at
// the right place, nothing splayed.

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');

  const r = await app.evalPage(`(async () => {
    const c = window.__glyphClient;
    const F = (p) => '/@fs' + ${JSON.stringify(process.cwd())} + p;
    const mfMod = await import(F('/packages/glyph3d-core/src/MegaGlyphField.js'));
    const atlas = c.ctx.atlas;
    const scene = c.ctx.scene;
    // The arena off the RENDERER, not the module singleton: this itest imports core
    // modules via /@fs, a different module instance than the app's — the registry
    // singleton would read null here.
    const arena = c.ctx.renderer.glyphPipelineArena;
    if (!arena) return { error: 'no pipeline arena on the renderer (GlyphCanvas boot)' };

    // Real app metrics — same worldScale + cell metrics CodeGrid uses.
    const worldScale = 0.025;
    const cmMod = await import(F('/packages/glyph3d-core/src/core/cellMetrics.js'));
    const metrics = cmMod.computeCellMetrics(atlas.getCharSize(), worldScale);
    const cgMod = await import(F('/packages/glyph3d-core/src/collections/CodeGrid.js'));

    const TEXT = 'Hello, byte pipeline.\\nsecond line — wrapped segments, page lanes.\\n\\nthird';
    const LAYOUT = { wrapWidth: 24 };

    // LEFT: a raw mega-field view, one item in the shared arena. No pose node —
    // identity pose; the ITEM ORIGIN (a layout param) places the text, so the
    // verify below covers origin-carrying layout too.
    const mega = mfMod.ensureMegaField(arena, { scene, atlas, worldScale });
    const view = mega.createView({ color: { r: 0.9, g: 0.9, b: 0.95 } });
    const handle = arena.stage({
      bytes: new TextEncoder().encode(TEXT),
      origin: { x: -1.5, y: 0, z: 0 },
      page: null,
      wrapWidth: LAYOUT.wrapWidth,
      lineHeight: metrics.lineSpacing,
      zStep: metrics.charHeight * 0.15,
      field: view,
    });
    await arena.requestFlush();

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
    const v = await arena.verifyItem(handle.itemIndex);
    return { verify: v, extent: handle.mirror?.bounds,
      count: mega.field.instanceMesh.geometry.instanceCount,
      viewRange: { base: view.slotBase, count: view.byteCount },
      byteStart: handle.byteStart,
      metrics: { lineSpacing: metrics.lineSpacing, charHeight: metrics.charHeight } };
  })()`);

  assert.ok(!r.error, r.error || 'eval');
  assert.equal(r.verify?.ok, true, `GPU slots == mirror (worst ${r.verify?.worst}, badRows ${r.verify?.badRows})`);
  assert.ok(r.viewRange?.count > 50, `view range covers the bytes (${JSON.stringify(r.viewRange)})`);
  assert.equal(r.viewRange?.base, r.byteStart, 'view slotBase == item byteStart');
  assert.ok(r.count >= r.byteStart + r.viewRange.count, `mega instanceCount spans the item (${r.count})`);
  assert.ok(r.extent && r.extent.max.x > r.extent.min.x, `extent stated (${JSON.stringify(r.extent)})`);

  await app.waitFor(1200);   // a few frames — the field renders
  await app.shot('/tmp/byte-field.png');
  assert.noErrors(app);
};
