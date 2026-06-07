// panel — the 2D EditorPanel mirrors the focused grid: same buffer, colored from the
// SAME tree-sitter parse (reused captures via getHighlights), rendered by CodeMirror with
// NO second parse and NO language loaded. Drives: load a repo, open a file, focus it,
// then read the panel's DOM and compare to the grid buffer.

// Reads the EditorPanel's CodeMirror DOM + the focused grid's content for comparison.
// strip() removes whitespace so CM's line virtualization / spacing can't cause false
// mismatches; we check the panel's visible head appears in the grid buffer (linked views).
const READ = `(()=>{const c=window.__glyphClient;const cm=document.querySelector(".cm-content");if(!cm)return{err:"panel not linked (no .cm-content)"};const spans=[...cm.querySelectorAll("span[style*=color]")];const colors=new Set(spans.map(s=>s.getAttribute("style")));const e=c.ctx.registry.get("cli/main.go");const gc=e&&e.grid.getContent?e.grid.getContent():"";const strip=s=>(s||"").replace(/\\s+/g,"");const head=strip(cm.textContent).slice(0,30);return{coloredSpans:spans.length,themeKeyword:colors.has("color: rgb(198, 147, 219);"),gridHasHead:head.length>20&&strip(gc).includes(head)};})()`;

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');
  assert.ok(/loaded/i.test((await app.cmd('repo.load tikimcfee/glyph3d-js')).text || ''), 'repo loaded');
  await app.waitFor(2000);

  const open = await app.cmd('file.open cli/main.go');
  assert.ok(!open.error, `file.open → ${open.text || open.error}`);
  await app.waitFor(2500); // lazy grammar load + parse + colorize

  // A real grid click sets primary via picking; drive it explicitly here.
  const focus = await app.cmd('attention.set primary cli/main.go');
  assert.ok(!focus.error, `attention.set → ${focus.text || focus.error}`);
  await app.waitFor(1500); // React re-render + CodeMirror mount

  const r = await app.evalPage(READ);
  assert.ok(!r.err, `editor panel → ${r.err}`);
  assert.atLeast(r.coloredSpans, 5, 'editor shows colored spans from the reused highlights');
  assert.ok(r.themeKeyword, 'editor uses the shared theme keyword color (identical to 3D)');
  assert.ok(r.gridHasHead, 'editor content matches the focused grid buffer (linked views)');

  assert.noErrors(app);
};
