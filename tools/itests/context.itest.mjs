// context — the interaction-context projection: focus/edit/key nodes derive from
// attention + cursor state, context.info exposes them on the bus, and the
// breadcrumb HUD renders them 1:1 (the DOM shows the live line:col). Locks the
// node SHAPE — gesture resolution and binding tables will predicate on it.

const FILE = 'package.json';

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');

  const info = async () => app.evalPage(
    `(async () => (await window.__glyphClient.router.execute('context.info')).data)()`);

  await app.cmd('repo.load tikimcfee/glyph3d-js');
  await app.waitFor(1500);
  await app.cmd(`file.open ${FILE}`);
  await app.waitFor(800);

  // file.open sets attention.primary → a focus node, and no edit node yet.
  let r = await info();
  assert.ok(r.nodes.some((n) => n.kind === 'focus' && n.id === FILE), `focus node after file.open (${JSON.stringify(r.nodes)})`);
  assert.ok(!r.nodes.some((n) => n.kind === 'edit'), 'no edit node before edit.goto');

  // edit.goto adds the edit node with the exact cursor.
  await app.cmd(`edit.goto ${FILE} 2 3`);
  await app.waitFor(400);
  r = await info();
  const edit = r.nodes.find((n) => n.kind === 'edit');
  assert.ok(edit && edit.cursor.line === 2 && edit.cursor.col === 3, `edit node at 2:3 (got ${JSON.stringify(edit)})`);

  // The breadcrumb DOM mirrors the same nodes — live cursor, no polling.
  const dom = await app.evalPage(`document.querySelector('[data-g3d-context]')?.textContent ?? ''`);
  assert.ok(dom.includes('2:3'), `breadcrumb shows the cursor (got "${dom}")`);

  // Cursor movement propagates through the change emit (no poll): move via the
  // grid API and the verb reflects it.
  await app.evalPage(`window.__glyphClient.ctx.registry.get(${JSON.stringify(FILE)}).grid.setCursor(1, 1)`);
  await app.waitFor(200);
  const dom2 = await app.evalPage(`document.querySelector('[data-g3d-context]')?.textContent ?? ''`);
  assert.ok(dom2.includes('1:1'), `breadcrumb tracked the cursor move (got "${dom2}")`);

  // edit.stop retracts the edit node; focus remains.
  await app.cmd('edit.stop');
  await app.waitFor(300);
  r = await info();
  assert.ok(!r.nodes.some((n) => n.kind === 'edit'), 'edit node gone after edit.stop');
  assert.ok(r.nodes.some((n) => n.kind === 'focus'), 'focus node persists');

  assert.noErrors(app);
};
