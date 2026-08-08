// arena-compaction-check.mjs — the free-list gate: a storm of restages (the window
// crossing / edit tombstone pattern) that would burn the f32-ordinal wall budget on
// dead bytes must instead run on RECLAIMED space. Pre-compaction this storm dies at
// ~16.7MB of cumulative staging with "past the f32-ordinal wall"; post-compaction it
// completes with the high-water mark pinned at ~2× the churned window.
//
// Phases (all against the app's LIVE arena, driven directly):
//   A. adopt-storm: 150 × 120KB restages through the two-phase adopt path (stage →
//      flush → adoptField → dispose-old) — 18MB total staged, past the wall.
//      Asserts zero refusals and a bounded watermark, with verifyItem teeth every
//      25 cycles (GPU slots vs the CPU mirror, exact, over RECYCLED ranges).
//   B. size churn: alternating 25K/110K/40K restages mixing stage-then-dispose and
//      dispose-then-stage — the best-fit split/coalesce paths.
//   C. tail recede: 30 × 20KB staged then all disposed — the watermark must return
//      EXACTLY to its pre-phase value.
//   D. truth: verifyItem on every live item, resolveSlot coherence (a live slot
//      resolves to its view, a dead slot to null), 0 GPU errors, and the headline:
//      total bytes staged ≫ 2^24 while the final watermark < 2MB.
//
// Client-only (fake in-page file provider — no relay, like glyph-pipeline-check).
//   bun tools/arena-compaction-check.mjs [--url http://localhost:5173/]
import { chromium } from 'playwright';

const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
        '--use-angle=vulkan', '--use-gl=angle'],
});
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const destroyedErrs = [];
    page.on('console', (m) => { if (m.text().includes('used in submit while destroyed')) destroyedErrs.push(m.text()); });
    page.on('pageerror', (e) => destroyedErrs.push(`pageerror: ${String(e).slice(0, 160)}`));
    const ui = process.argv.indexOf('--url');
    await page.goto(ui >= 0 ? process.argv[ui + 1] : 'http://localhost:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.__glyphClient && !!window.__glyphClient.ctx.renderer', null, { timeout: 20000 });
    await page.waitForTimeout(4000);

    const report = await page.evaluate(async () => {
        const c = window.__glyphClient;
        const device = c.ctx.renderer.backend.device;
        const gpuErrs = [];
        device.addEventListener('uncapturederror', (e) => gpuErrs.push(String(e.error?.message || e.error).slice(0, 200)));
        // Two real grids seed the arena + the mega field (the app's own objects).
        const mkSeed = (n) => Array.from({ length: n }, (_, i) => `const seed_${i} = ${i} * 2; // seed line ${i}`).join('\n');
        const files = { '/fake/seedA.js': mkSeed(300), '/fake/seedB.js': mkSeed(500) };
        c.ctx.fileProvider = { getFile: async (p) => { if (!(p in files)) throw new Error('no ' + p); return files[p]; } };
        for (const p of Object.keys(files)) await c.router.execute(['file.open', p]);
        await new Promise((r) => setTimeout(r, 800));

        const arena = c.ctx.renderer.glyphPipelineArena;
        if (!arena) return { fatal: 'no pipeline arena on the renderer' };
        const mega = arena.megaField;
        if (!mega) return { fatal: 'no mega field after file.open' };
        const enc = new TextEncoder();
        const R = { phases: {}, gpuErrs, stagedBytes: 0, verifies: [] };
        // Content varies per cycle: recycled bytes differ from their predecessors, so a
        // ghosting/recycling bug shows up as a verify mismatch, not a coincidence.
        const chunk = (k, size) => {
            const line = `let v_${k} = compute_${k}(alpha, beta, gamma); // churn line for cycle ${k} — `;
            const body = line.repeat(Math.ceil(size / line.length)).slice(0, size - 1) + '\n';
            return enc.encode(body);
        };
        const wm = () => arena._byteTotal;

        // ── Phase A: the adopt-storm — window-crossing pattern, past the wall ──────
        const view = mega.createView({ color: { r: 0.8, g: 0.9, b: 0.8 } });
        const A = { cycles: 150, win: 120_000, maxWm: 0, refusals: 0, firstRefusal: null };
        let prev = null;
        for (let k = 0; k < A.cycles; k++) {
            const bytes = chunk(k, A.win);
            let h;
            try {
                h = arena.stage({ bytes, origin: { x: 0, y: 0, z: 0 }, page: null,
                    wrapWidth: 0, lineHeight: 1.4, zStep: 0, field: null });
            } catch (e) {
                A.refusals++;
                if (!A.firstRefusal) A.firstRefusal = `cycle ${k}: ${e?.message || e}`;
                break;
            }
            R.stagedBytes += bytes.length;
            await arena.requestFlush();
            h.adoptField(view);
            if (k % 25 === 24) R.verifies.push({ k, ...(await h.verify()) });
            prev?.dispose();
            prev = h;
            A.maxWm = Math.max(A.maxWm, wm());
        }
        A.finalWm = wm();
        A.viewCoherent = view.slotBase === prev?.byteStart && view.byteCount === prev?.byteLength;
        R.phases.A = A;

        // ── Phase B: size churn — split/coalesce under both tombstone orders ──────
        const B = { cycles: 42, sizes: [25_000, 110_000, 40_000], maxWm: 0, refusals: 0, firstRefusal: null };
        let bPrev = null;
        for (let k = 0; k < B.cycles; k++) {
            const bytes = chunk(1000 + k, B.sizes[k % B.sizes.length]);
            let h;
            try {
                if (k % 2 === 1 && bPrev) { bPrev.dispose(); bPrev = null; }   // close-then-open
                h = arena.stage({ bytes, origin: { x: 0, y: 0, z: 0 },
                    // Every third item is PAGED — and the cycle count makes the storm's
                    // SURVIVOR paged, so the fold-scalar guard (a gap must not hand the
                    // stride kernel a dead widest row) gets teeth in phase D's
                    // verifyItem, not just analysis.
                    page: k % 3 === 2 ? { pageRows: 50, pagesWide: 2, pageGapX: 3 } : null,
                    wrapWidth: 0, lineHeight: 1.4, zStep: 0, field: null });
            } catch (e) {
                B.refusals++;
                if (!B.firstRefusal) B.firstRefusal = `cycle ${k}: ${e?.message || e}`;
                break;
            }
            R.stagedBytes += bytes.length;
            await arena.requestFlush();
            if (bPrev) bPrev.dispose();   // restage order: new laid, then old retires
            bPrev = h;
            B.maxWm = Math.max(B.maxWm, wm());
        }
        B.finalWm = wm();
        R.phases.B = B;

        // ── Phase C: tail recede — exact watermark return ─────────────────────────
        const C = { before: wm() };
        const handles = [];
        for (let k = 0; k < 30; k++) {
            const bytes = chunk(2000 + k, 20_000);
            handles.push(arena.stage({ bytes, origin: { x: 0, y: 0, z: 0 }, page: null,
                wrapWidth: 0, lineHeight: 1.4, zStep: 0, field: null }));
            R.stagedBytes += bytes.length;
        }
        await arena.requestFlush();
        C.peak = wm();
        for (let i = handles.length - 1; i >= 0; i--) handles[i].dispose();
        C.after = wm();
        R.phases.C = C;

        // ── Phase D: truth ────────────────────────────────────────────────────────
        await arena.requestFlush();
        const D = { items: [] };
        for (let i = 0; i < arena._items.length; i++) {
            if (arena._items[i].dead) continue;
            const v = await arena.verifyItem(i);
            D.items.push({ i, ok: v.ok, reason: v.reason, worst: v.worst });
        }
        // Pick coherence: a live slot resolves to its view; a reclaimed slot to null.
        const liveSlot = view.slotBase + 10;
        const hit = mega.resolveSlot(liveSlot);
        D.pickLive = hit ? { same: hit.view === view, local: hit.localSlot } : null;
        const deadHit = mega.resolveSlot(C.before + 5);   // phase C's reclaimed tail
        D.pickDeadIsNull = deadHit === null;
        D.finalWm = wm();
        D.maxBytes = arena.maxBytes;
        D.liveItems = arena._liveCount;
        D.freeRanges = arena._free.length;
        R.phases.D = D;
        return R;
    });

    if (report.fatal) { console.error('FATAL: ' + report.fatal); process.exit(1); }
    const { A, B, C, D } = report.phases;
    console.log(`staged total: ${(report.stagedBytes / 1048576).toFixed(1)}MB across the storm (wall: 16.0MiB)`);

    ok(A.refusals === 0 && !A.firstRefusal, `A: 150 × 120KB adopt-restages, zero wall refusals${A.firstRefusal ? ` (${A.firstRefusal})` : ''}`);
    ok(A.maxWm < 1024 * 1024, `A: watermark bounded (${(A.maxWm / 1024).toFixed(0)}KB peak — pre-compaction this storm dies at ~16.7MB)`);
    ok(A.viewCoherent, 'A: view tracks the last adopted item (slotBase == byteStart)');
    ok(report.stagedBytes > 2 ** 24, `A+B+C: cumulative staging past the f32 wall (${(report.stagedBytes / 1048576).toFixed(1)}MB > 16MiB)`);

    ok(B.refusals === 0 && !B.firstRefusal, `B: 42 size-churn restages (25K/110K/40K, both tombstone orders), zero refusals${B.firstRefusal ? ` (${B.firstRefusal})` : ''}`);
    ok(B.maxWm < 2 * 1024 * 1024, `B: watermark bounded under size churn (${(B.maxWm / 1024).toFixed(0)}KB peak)`);

    ok(C.after === C.before, `C: tail recede exact — watermark ${C.before}B → peak ${C.peak}B → ${C.after}B`);

    ok(report.verifies.length > 0 && report.verifies.every((v) => v.ok),
        `mid-storm verifyItem green on recycled ranges (${report.verifies.map((v) => `${v.k}:${v.ok ? 'ok' : 'FAIL'}`).join(' ')})`);
    ok(D.items.length > 0 && D.items.every((d) => d.ok),
        `D: verifyItem green on all ${D.items.length} live items post-storm${D.items.some((d) => !d.ok) ? ` (${JSON.stringify(D.items.filter((d) => !d.ok)[0])})` : ''}`);
    ok(D.pickLive?.same && D.pickLive.local === 10, `D: resolveSlot maps a live recycled slot to its view (${JSON.stringify(D.pickLive)})`);
    ok(D.pickDeadIsNull, 'D: a reclaimed range resolves to null (no ghost view)');
    ok(D.finalWm < 1024 * 1024, `D: final watermark ${(D.finalWm / 1024).toFixed(0)}KB with ${D.liveItems} live items, ${D.freeRanges} free ranges, capacity ${(D.maxBytes / 1048576).toFixed(1)}MB`);
    ok(report.gpuErrs.length === 0, `0 GPU uncaptured errors across the storm (${report.gpuErrs.length}${report.gpuErrs[0] ? `: ${report.gpuErrs[0]}` : ''})`);
    ok(destroyedErrs.length === 0, `no destroyed-buffer/console errors (${destroyedErrs.length}${destroyedErrs[0] ? `: ${destroyedErrs[0]}` : ''})`);
} finally {
    await browser.close();
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
