// arena-realloc-check.mjs — the arena-realloc render gate: reallocating the pipeline
// arena's kernels (growth, or the miss-flow trie rebuild) must not strand render bind
// groups on the destroyed slot buffer. Guards the rebindByteSlots seam
// (core/glyphVertex.js): three's WebGPU bind-group cache is keyed by textures only, so
// without the material re-init a realloc leaves every frame submitting
// "[Buffer "GlyphSlots"] used in submit while destroyed" forever.
//
// Lanes: baseline render, same-size realloc (the trie-rebuild move), growth realloc —
// each watched via device.uncapturederror. Then teeth: verifyItem (GPU slots vs CPU
// mirror, exact) and a pixel non-blank assertion after the realloc.
//
// Client-only (fake in-page file provider — no relay, like glyph-pipeline-check).
//   bun tools/arena-realloc-check.mjs
import { chromium } from 'playwright';
import { webgpuArgs } from './itest/driver.mjs';

const browser = await chromium.launch({
    headless: true,
    args: webgpuArgs(),
});
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const destroyedErrs = [];
    page.on('console', (m) => { if (m.text().includes('used in submit while destroyed')) destroyedErrs.push(m.text()); });
    // --url: a worktree runs its own Vite on its own port (default: the normal dev loop).
    const ui = process.argv.indexOf('--url');
    await page.goto(ui >= 0 ? process.argv[ui + 1] : 'http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.__glyphClient && !!window.__glyphClient.ctx.renderer', null, { timeout: 20000 });
    await page.waitForTimeout(4000);

    await page.evaluate(async () => {
        const c = window.__glyphClient;
        const device = c.ctx.renderer.backend.device;
        window.__gpuErrs = [];
        device.addEventListener('uncapturederror', (e) => {
            window.__gpuErrs.push(String(e.error?.message || e.error).slice(0, 200));
        });
        const mk = (n) => Array.from({ length: n }, (_, i) =>
            `function fn_${i}(a, b) { return a * ${i} + b; }   // synthetic line ${i}`).join('\n');
        const files = { '/fake/a.js': mk(400), '/fake/b.js': mk(700) };
        c.ctx.fileProvider = { getFile: async (p) => { if (!(p in files)) throw new Error('no ' + p); return files[p]; } };
        for (const p of Object.keys(files)) await c.router.execute(['file.open', p]);
    });
    await page.waitForTimeout(1200);
    const shotA = await page.screenshot();

    const lane = (name, body) => page.evaluate(`(async () => {
        const c = window.__glyphClient;
        const arena = c.ctx.renderer.glyphPipelineArena;
        window.__gpuErrs.length = 0;
        ${body}
        await new Promise((r) => setTimeout(r, 1200));
        return { errCount: window.__gpuErrs.length, sample: window.__gpuErrs[0] || null };
    })()`).then((r) => ok(r.errCount === 0, `${name}: 0 GPU errors${r.errCount ? ` (got ${r.errCount}: ${r.sample})` : ''}`));

    await lane('baseline render', '');
    await lane('same-size realloc (trie-rebuild move)', 'arena._realloc(arena.maxBytes, arena.maxItems); arena._flushNow();');
    await lane('growth realloc (×2)', 'arena._realloc(arena.maxBytes * 2, arena.maxItems); arena._flushNow();');

    // Teeth: the GPU slots still match the CPU mirror per item, and pixels survived.
    const verify = await page.evaluate(async () => {
        const arena = window.__glyphClient.ctx.renderer.glyphPipelineArena;
        const out = [];
        for (let i = 0; i < arena._items.length; i++) {
            if (!arena._items[i].dead) out.push(await arena.verifyItem(i));
        }
        return out;
    });
    ok(verify.length > 0 && verify.every((v) => v.ok), `verifyItem green on all ${verify.length} live items post-realloc (${JSON.stringify(verify[0])})`);
    const shotB = await page.screenshot();
    ok(shotB.length > 20000, `post-realloc frame is non-blank (${shotB.length}B png; pre was ${shotA.length}B)`);
    ok(destroyedErrs.length === 0, `no destroyed-buffer console lines across the run (${destroyedErrs.length})`);
} finally {
    await browser.close();
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
