/**
 * Tiny static server for the bench's output images, so the pixels can be
 * verified by eye (not just Read by the agent). Serves out/ and a generated
 * index that lays every PNG out with its filename.
 *
 *   bun _experiments/glyph-encoding/serve.js   →   http://localhost:8090/
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, 'out');
const PORT = Number(process.env.PORT || 8090);

const page = () => {
  const pngs = readdirSync(ROOT).filter((f) => f.endsWith('.png'));
  pngs.sort((a, b) => (a === 'dashboard.png' ? 0 : 1) - (b === 'dashboard.png' ? 0 : 1) || a.localeCompare(b));
  const cards = pngs.map((f) => `<figure><figcaption>${f}</figcaption><img src="/${f}"></figure>`).join('\n');
  return `<!doctype html><meta charset=utf8><title>glyph-encoding bench</title>
<style>
 body{background:#111;color:#ddd;font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:1000px}
 h1{font-size:18px} figure{margin:0 0 30px}
 figcaption{color:#8ad;margin:0 0 6px;font-family:ui-monospace,monospace}
 img{max-width:100%;background:#fff;border:1px solid #333;image-rendering:pixelated}
 .note{color:#888;margin-bottom:28px}
</style>
<h1>glyph-encoding bench — verify the pixels</h1>
<div class=note>
 dashboard = all checks in one image · *.reference/reconstructed/diff = fidelity (diff must be blank) ·
 *.highlight = picking range → glyphs · *.tokens = highlight-capture composition.<br>
 Regenerate: <code>bun _experiments/glyph-encoding/{run,dashboard,validate_picking,validate_highlights}.js</code>
</div>
${cards}`;
};

Bun.serve({
  port: PORT,
  fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/' || p === '') return new Response(page(), { headers: { 'content-type': 'text/html;charset=utf-8' } });
    const file = join(ROOT, p.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file));
  },
});
console.log(`glyph-encoding bench → http://localhost:${PORT}/`);
