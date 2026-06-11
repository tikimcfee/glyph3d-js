// click-caret — a glyph-channel pick becomes a caret: dblclick a glyph to start
// editing AT that glyph, single-click repositions while editing, typing lands at
// the clicked position, a glyph click on a FOCUSED (non-editing) grid enters
// edit at that glyph (the dblclick-then-click shortcut), and it all still works
// in a framed (clipped) layout — the layout-independence claim (instance order
// == slot order; layout only moves quads). Also asserts the hover caret-preview
// tint writes the highlight texture.
//
// Coordinates: LayoutDescription.positionAt(line,col) is the glyph's LEFT edge at
// vertical CENTER (calibrated empirically), so glyph center = +advance*0.5, +0.

const FILE = 'package.json';

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');
  const page = app.page;

  const load = await app.cmd('repo.load tikimcfee/glyph3d-js');
  assert.ok(!load.error && /loaded/i.test(load.text || ''), `repo.load → ${load.text || load.error}`);
  await app.waitFor(2000);
  const open = await app.cmd(`file.open ${FILE}`);
  assert.ok(!open.error, `file.open → ${open.text || open.error}`);
  await app.cmd(`camera.focus ${FILE}`);
  await app.waitFor(3000); // flight + layout settle

  // Pick a target from the CONTENT (no assumptions about what's on which line):
  // the longest line's middle column, away from the edges.
  const target = await app.evalPage(`(() => {
    const g = window.__glyphClient.ctx.registry.get(${JSON.stringify(FILE)})?.grid;
    if (!g || !Array.isArray(g.lines)) return { err: 'no grid/lines' };
    let line = 0;
    for (let i = 0; i < g.lines.length; i++) if (g.lines[i].length > g.lines[line].length) line = i;
    const col = Math.max(1, Math.floor(g.lines[line].length / 2));
    return { line, col, text: g.lines[line] };
  })()`);
  assert.ok(!target.err, `target derivation → ${target.err}`);

  // Project glyph (line,col) center → screen px.
  const projectExpr = (line, col) => `(() => {
    const c = window.__glyphClient;
    const g = c.ctx.registry.get(${JSON.stringify(FILE)}).grid;
    const p = g._layout?.positionAt(${line}, ${col});
    if (!p) return { err: 'no layout pos' };
    const V = Object.getPrototypeOf(g.position).constructor;
    const w = new V(p.x + g.metrics.charWidth * 0.5, p.y, p.z ?? 0);
    g.localToWorld(w);
    w.project(c.ctx.camera);
    const r = c.ctx.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (w.x + 1) / 2 * r.width, y: r.top + (1 - w.y) / 2 * r.height };
  })()`;
  const cursor = async () => (await app.cmd('edit.info')).text.match(/at (\d+):(\d+)/)?.slice(1).map(Number) ?? null;

  // Park the pointer on the glyph and wait until the GRID hover actually reports
  // our file (camera flight / projection settle), then re-project for stability.
  // Self-calibrating: no fixed waits on flight timing.
  const hoverAt = async (line, col) => {
    for (let i = 0; i < 12; i++) {
      const pt = await app.evalPage(projectExpr(line, col));
      if (!pt.err) {
        await page.mouse.move(pt.x, pt.y);
        await app.waitFor(250);
        const hov = await app.evalPage(`window.__glyphClient.ctx.attentionManager.get('hover')?.id ?? null`);
        if (hov === FILE) {
          const pt2 = await app.evalPage(projectExpr(line, col));
          if (!pt2.err && Math.hypot(pt2.x - pt.x, pt2.y - pt.y) < 1) return pt2;
        }
      }
      await app.waitFor(500);
    }
    return null;
  };

  // 1) Dblclick a glyph → edit mode with the caret AT that glyph.
  const pt1 = await hoverAt(target.line, target.col);
  assert.ok(pt1, 'pointer settled over the target glyph (grid hover confirmed)');
  await page.mouse.dblclick(pt1.x, pt1.y);
  await app.waitFor(1000); // async glyph pick + edit.goto
  let cur = await cursor();
  assert.ok(cur && cur[0] === target.line && cur[1] === target.col,
    `dblclick → caret at ${cur?.join(':')} (want ${target.line}:${target.col})`);

  // 2) Single click while editing repositions the caret (keepKey path).
  const t2 = { line: target.line, col: Math.max(0, target.col - 3) };
  const pt2 = await hoverAt(t2.line, t2.col);
  assert.ok(pt2, 'pointer settled for the reposition click');
  await page.mouse.click(pt2.x, pt2.y);
  await app.waitFor(1000);
  cur = await cursor();
  assert.ok(cur && cur[0] === t2.line && cur[1] === t2.col,
    `click-while-editing → caret at ${cur?.join(':')} (want ${t2.line}:${t2.col})`);

  // 3) Typing lands at the clicked position.
  await page.keyboard.type('Q');
  await app.waitFor(600);
  const typed = await app.evalPage(`(() => {
    const g = window.__glyphClient.ctx.registry.get(${JSON.stringify(FILE)}).grid;
    return { ch: g.lines[${t2.line}][${t2.col}] };
  })()`);
  assert.equal(typed.ch, 'Q', `typed char landed at ${t2.line}:${t2.col}`);

  // 4) Hover caret-preview: with key held, park the pointer over a glyph and the
  // highlight texture gets the additive tint at that slot.
  const t3 = { line: target.line, col: target.col + 2 };
  const pt3 = await hoverAt(t3.line, t3.col);
  assert.ok(pt3, 'pointer settled for the hover-tint check');
  await app.waitFor(700);
  const tint = await app.evalPage(`(() => {
    const g = window.__glyphClient.ctx.registry.get(${JSON.stringify(FILE)}).grid;
    const slot = g.getSlotForChar(${t3.line}, ${t3.col});
    const d = g.getRenderer()._highlightTexture.image.data;
    return { slot, lit: d[slot * 4] + d[slot * 4 + 1] + d[slot * 4 + 2] > 0 };
  })()`);
  assert.ok(tint.slot >= 0 && tint.lit, `hover tint lit at slot ${tint.slot}`);

  // 5) Focused-but-not-editing + click on a glyph = enter edit AT that glyph —
  // the dblclick-then-click shortcut (the focus policy's claim). Esc exits edit
  // but the grid keeps focus, so the next glyph click drops straight back in.
  await page.keyboard.press('Escape');
  await app.waitFor(400);
  assert.ok(!(await cursor()), 'Escape exited edit mode');
  const t5 = { line: target.line, col: target.col + 4 };
  const pt5 = await hoverAt(t5.line, t5.col);
  assert.ok(pt5, 'pointer settled for the focused-click shortcut');
  await page.mouse.click(pt5.x, pt5.y);
  await app.waitFor(1000);
  cur = await cursor();
  assert.ok(cur && cur[0] === t5.line && cur[1] === t5.col,
    `focused-click shortcut → edit at ${cur?.join(':')} (want ${t5.line}:${t5.col})`);

  // 6) Layout independence: frame the grid (shader clip) and click a glyph that's
  // still visible — same slot math, caret exact.
  await app.cmd(`grid.frame ${FILE} 8`);
  await app.waitFor(1200);
  const t4 = { line: 2, col: 4 };
  const lineOk = await app.evalPage(`(() => {
    const g = window.__glyphClient.ctx.registry.get(${JSON.stringify(FILE)}).grid;
    return { ok: (g.lines[${t4.line}] || '').length > ${t4.col} };
  })()`);
  if (lineOk.ok) {
    const pt4 = await hoverAt(t4.line, t4.col);
    assert.ok(pt4, 'pointer settled for the framed-layout click');
    await page.mouse.click(pt4.x, pt4.y);
    await app.waitFor(1000);
    cur = await cursor();
    assert.ok(cur && cur[0] === t4.line && cur[1] === t4.col,
      `framed-layout click → caret at ${cur?.join(':')} (want ${t4.line}:${t4.col})`);
  }

  // Esc leaves edit mode so the run ends keyboard-free.
  await page.keyboard.press('Escape');
  assert.noErrors(app);
};
