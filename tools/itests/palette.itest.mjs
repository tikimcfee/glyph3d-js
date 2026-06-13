// palette — the command bar's noun layer: ⌘K summons it, a query ranks files,
// open sheets, schemes, and verbs together, every row subtitles the EXACT verb
// line it will run (data-cmd), and Enter executes that line through the same
// router the CLI drives. Drives the real DOM: keybinding → controlled input →
// keyboard, then verifies the side effect in the registry.

const INPUT = `document.querySelector('input[placeholder^="search"]')`;

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');
  assert.ok(/loaded/i.test((await app.cmd('repo.load tikimcfee/glyph3d-js')).text || ''), 'repo loaded');
  await app.waitFor(1500);

  // Summon with the real keybinding (window-level capture listener in main.jsx).
  await app.evalPage(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
  await app.waitFor(500); // open + verb index (sync) + noun roster (async fetch)

  // Type a query through React's controlled input (native setter + input event).
  const typed = await app.evalPage(`(()=>{
    const inp = ${INPUT};
    if (!inp) return { err: 'palette input not found (did ⌘K open the bar?)' };
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'app/main.jsx');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`);
  assert.ok(!typed.err, `typed query → ${typed.err || 'ok'}`);
  await app.waitFor(500);

  const rows = await app.evalPage(
    `[...document.querySelectorAll('[data-palette-row]')].map((b) => ({ kind: b.dataset.kind, cmd: b.dataset.cmd }))`
  );
  assert.atLeast(rows.length, 1, 'query produced ranked rows');
  assert.equal(rows[0].kind, 'file', 'top match is the file noun');
  assert.equal(rows[0].cmd, 'sheet.focus app/main.jsx', 'row subtitle is the exact verb line (the jump)');

  // Enter executes the selected row's command line through the bus. sheet.focus
  // is THE jump: it must open the file AND fly the camera — pin the position
  // first so flightlessness fails loudly (the asymmetry this test exists for).
  const camBefore = await app.evalPage(`(()=>{ const p = window.__glyphClient.ctx.camera.position; return { x: p.x, y: p.y, z: p.z }; })()`);
  await app.evalPage(`${INPUT}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await app.waitFor(3000); // fetch + grid build + tree relayout + camera ease

  const after = await app.evalPage(`(()=>{
    const c = window.__glyphClient;
    const p = c.ctx.camera.position;
    return {
      open: c.ctx.registry.has('app/main.jsx'),
      primary: c.ctx.attentionManager?.get?.('primary')?.id || null,
      cam: { x: p.x, y: p.y, z: p.z },
    };
  })()`);
  assert.ok(after.open, 'Enter ran sheet.focus — the grid landed in the registry');
  assert.equal(after.primary, 'app/main.jsx', 'jumped file took primary attention');
  const moved = Math.hypot(after.cam.x - camBefore.x, after.cam.y - camBefore.y, after.cam.z - camBefore.z);
  assert.atLeast(moved, 1, `camera flew to the jump target (moved ${moved.toFixed(1)})`);

  // The executed verb line entered history verbatim (the re-teach loop).
  const hist = await app.evalPage(`JSON.parse(localStorage.getItem('glyph3d.cmdHistory') || '[]')`);
  assert.ok(hist.includes('sheet.focus app/main.jsx'), 'verb line recorded in history');

  assert.noErrors(app);
};
