// storm-probe — drive an N-file synthetic storm with full forensics:
// console errors, device.uncapturederror, actual device limits, arena/mega sizes,
// staged progress heartbeat, and crash detection. Client-only fake provider.
//   bun tools/storm-probe.mjs [N]     (client-only; no relay)
import { launchGpuBrowser, assertRealGpu } from './itest/driver.mjs';

const N = Number(process.argv[2] || 1000);
// Headed wherever headless would be software (macOS) — a storm measured on
// SwiftShader tells you about SwiftShader's limits, not this machine's.
const browser = await launchGpuBrowser({});
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const logs = [];
    page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' || m.type() === 'warning' || /realloc|MegaGlyph|device|lost|GPU|Error/i.test(t)) {
            logs.push(`[${m.type()}] ${t.slice(0, 300)}`);
        }
    });
    page.on('crash', () => console.log('!! PAGE CRASHED (renderer process died)'));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
    // Ephemeral page: no restore under the storm, no autosave over the human's session.
    await page.goto('http://localhost:5173/?session=off', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!window.__glyphClient && !!window.__glyphClient.ctx.renderer', null, { timeout: 20000 });
    await page.waitForTimeout(3000);
    // The guard needs only evalPage; these tools drive a raw page, not openApp.
    const gpu = await assertRealGpu({ evalPage: (fn) => page.evaluate(fn) }, { tool: 'storm-probe' });
    console.log(`[gpu] ${gpu.vendor}/${gpu.architecture}`);

    const limits = await page.evaluate(() => {
        const d = window.__glyphClient.ctx.renderer.backend.device;
        window.__gpuErrs = [];
        d.addEventListener('uncapturederror', (e) => window.__gpuErrs.push(String(e.error?.message || e.error).slice(0, 300)));
        return {
            maxTextureDimension2D: d.limits.maxTextureDimension2D,
            maxBufferSize: d.limits.maxBufferSize,
            maxStorageBufferBindingSize: d.limits.maxStorageBufferBindingSize,
        };
    });
    console.log('device limits:', JSON.stringify(limits));

    // Kick the storm WITHOUT awaiting it, so we can heartbeat while it runs.
    await page.evaluate(`(() => {
        const c = window.__glyphClient;
        const mk = (seed) => Array.from({ length: 220 }, (_, i) =>
            'export function fn_' + seed + '_' + i + '(alpha, beta) { const gamma = alpha * ' + i + ' + beta; return { gamma, tag: "file-' + seed + '-line-' + i + '" }; }').join('\\n');
        const entries = [], contents = new Map();
        for (let f = 0; f < ${N}; f++) {
            const p = 'srcgen/dir' + (f % 12) + '/file_' + f + '.js';
            const body = mk(f);
            entries.push({ path: p, size: body.length, type: 'file' });
            contents.set('fake/' + p, { content: body });
        }
        window.__totalBytes = [...contents.values()].reduce((s, v) => s + v.content.length, 0);
        c.ctx.fileProvider = {
            listTree: async () => ({ entries, truncated: false }),
            filterCodeFiles: ({ tree }) => tree.filter((e) => e.path.endsWith('.js')),
            getMultipleFiles: async (_a, _b, want) => {
                const m = new Map();
                for (const p of want) if (contents.has(p)) m.set(p, contents.get(p));
                return m;
            },
            getFile: async (p) => { const e = contents.get(p); if (!e) throw new Error('no ' + p); return e.content; },
        };
        window.__stormDone = false;
        c.router.execute(['file.openDir', 'fake']).then(
            (r) => { window.__stormDone = true; window.__stormResult = JSON.stringify(r).slice(0, 200); },
            (e) => { window.__stormDone = true; window.__stormResult = 'ERR ' + String(e).slice(0, 200); });
    })()`);

    const t0 = Date.now();
    let lastBeat = null;
    for (let tick = 0; tick < 120; tick++) {
        await page.waitForTimeout(1000).catch(() => {});
        let beat;
        try {
            beat = await Promise.race([
                page.evaluate(() => {
                    const c = window.__glyphClient;
                    const arena = c.ctx.renderer.glyphPipelineArena;
                    const mega = arena?.megaField;
                    return {
                        done: window.__stormDone, result: window.__stormResult || null,
                        totalBytes: window.__totalBytes,
                        arena: arena ? { maxBytes: arena.maxBytes, live: arena._byteTotal, items: arena._items.length } : null,
                        mega: mega ? {
                            cap: mega.field.instanceMesh.geometry._maxInstanceCount,
                            count: mega.field.instanceMesh.geometry.instanceCount,
                            views: mega.views.length,
                            hlRows: mega.field._highlightTexture?.image?.height || 0,
                        } : null,
                        gpuErrs: window.__gpuErrs.length, gpuSample: window.__gpuErrs[0] || null,
                        heap: (performance.memory?.usedJSHeapSize / 1048576) | 0,
                    };
                }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('EVAL-HUNG')), 8000)),
            ]);
        } catch (e) {
            console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s: PAGE UNRESPONSIVE/DEAD (${String(e).slice(0, 80)})`);
            break;
        }
        lastBeat = beat;
        console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s: arena ${beat.arena?.live}/${beat.arena?.maxBytes}B items=${beat.arena?.items} · mega cap=${beat.mega?.cap} count=${beat.mega?.count} views=${beat.mega?.views} hlRows=${beat.mega?.hlRows} · gpuErrs=${beat.gpuErrs}${beat.gpuSample ? ` [${beat.gpuSample.slice(0, 120)}]` : ''} · heap=${beat.heap}MB${beat.done ? ` · DONE ${beat.result}` : ''}`);
        if (beat.done) break;
    }
    console.log('--- notable console lines:');
    for (const l of logs.slice(0, 40)) console.log('  ' + l);
    if (lastBeat?.done) console.log('STORM COMPLETED');
} finally {
    await browser.close();
}
