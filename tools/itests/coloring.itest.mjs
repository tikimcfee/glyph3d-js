// coloring — tree-sitter syntax coloring actually writes distinct theme colors into the
// base instanceColor buffer. Data-level (not pixels), so it's robust to the restrained
// palette. Drives the command bus: load a repo, open a JSON file, inspect the buffer.

// Distinct instanceColor RGBs (2dp) on the package.json grid, read straight from the
// renderer attribute. Returns { distinct, colors } or { err }.
const INSPECT = `(()=>{const c=window.__glyphClient;const gs=c.ctx.getGrids?c.ctx.getGrids():[];const g=gs.find(x=>((x.getFilename&&x.getFilename())||x.filename||"").includes("package.json"))||gs[gs.length-1];if(!g)return{err:"no grid"};const r=g.getRenderer&&g.getRenderer();const attr=r&&r.instanceMesh&&r.instanceMesh.geometry.attributes.instanceColor;if(!attr)return{err:"no instanceColor"};const a=attr.array;const n=Math.min(a.length/3,(r.getGlyphCount&&r.getGlyphCount())||a.length/3);const m=new Map();for(let i=0;i<n;i++){const k=a[i*3].toFixed(2)+","+a[i*3+1].toFixed(2)+","+a[i*3+2].toFixed(2);m.set(k,1);}return{distinct:m.size,colors:[...m.keys()]};})()`;

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

  assert.noErrors(app);
};
