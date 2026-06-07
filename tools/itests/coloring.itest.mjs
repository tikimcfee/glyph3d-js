// coloring — tree-sitter syntax coloring actually writes distinct theme colors into the
// base instanceColor buffer. Data-level (not pixels), so it's robust to the restrained
// palette. Drives the command bus: load a repo, open a JSON file, inspect the buffer.

// Distinct instanceColor RGBs (2dp) on the package.json grid, read straight from the
// renderer attribute. Returns { distinct, colors } or { err }.
const GRID = `const c=window.__glyphClient;const gs=c.ctx.getGrids?c.ctx.getGrids():[];const g=gs.find(x=>((x.getFilename&&x.getFilename())||x.filename||"").includes("package.json"))||gs[gs.length-1];`;

// Distinct instanceColor RGBs (the 3D render target).
const INSPECT = `(()=>{${GRID}if(!g)return{err:"no grid"};const r=g.getRenderer&&g.getRenderer();const attr=r&&r.instanceMesh&&r.instanceMesh.geometry.attributes.instanceColor;if(!attr)return{err:"no instanceColor"};const a=attr.array;const n=Math.min(a.length/3,(r.getGlyphCount&&r.getGlyphCount())||a.length/3);const m=new Map();for(let i=0;i<n;i++){const k=a[i*3].toFixed(2)+","+a[i*3+1].toFixed(2)+","+a[i*3+2].toFixed(2);m.set(k,1);}return{distinct:m.size,colors:[...m.keys()]};})()`;

// The render-neutral highlight product a 2D companion view will consume (one parse, reused).
const HILITE = `(()=>{${GRID}if(!g||!g.getHighlights)return{err:"no getHighlights"};const h=g.getHighlights();if(!h)return{err:"no highlights"};const caps=h.captures||[];const c0=caps[0];return{count:caps.length,lang:h.lang,hasOffsets:!!c0&&Number.isInteger(c0.startIndex)&&Number.isInteger(c0.endIndex)};})()`;

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');

  const load = await app.cmd('repo.load tikimcfee/glyph3d-js');
  assert.ok(!load.error && /loaded/i.test(load.text || ''), `repo.load → ${load.text || load.error}`);
  await app.waitFor(2000);

  const open = await app.cmd('file.open package.json');
  assert.ok(!open.error, `file.open → ${open.text || open.error}`);
  await app.waitFor(3500); // lazy grammar load + parse + colorize

  const res = await app.evalPage(INSPECT);
  assert.ok(!res.err, `inspect instanceColor → ${res.err}`);
  assert.atLeast(res.distinct, 3, `expected >=3 distinct syntax colors, got ${res.distinct} (${(res.colors || []).join(' ')})`);
  // exact theme matches: string (green) + property keys (pale-blue) — see syntaxTheme.js
  assert.ok(res.colors.includes('0.60,0.78,0.56'), 'string color (green) present');
  assert.ok(res.colors.includes('0.74,0.82,0.90'), 'property color (pale-blue) present');

  // Reuse contract: the same parse is queryable as render-neutral highlights with the
  // absolute offsets a 2D editor (CodeMirror) needs — no second parse for the 2D view.
  const h = await app.evalPage(HILITE);
  assert.ok(!h.err, `getHighlights → ${h.err}`);
  assert.atLeast(h.count, 1, 'highlights exposed on the grid');
  assert.equal(h.lang, 'json', 'highlights tagged with language');
  assert.ok(h.hasOffsets, 'captures carry absolute startIndex/endIndex for 2D decorations');

  assert.noErrors(app);
};
