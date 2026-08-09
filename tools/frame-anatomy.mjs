/**
 * frame-anatomy.mjs — attribute a steady-state frame: FPS percentiles, per-render-
 * call triangle/draw-call deltas (wraps gl.render), scene/mesh census, and the
 * mega-field instance census. The harness that found the transparent+DoubleSide
 * double-pass (62M→31M tris) and the minimap's ~3000-draw proxy pool.
 *
 *   bun tools/frame-anatomy.mjs                    (against :5173 + scratch relay :8099)
 *   ANATOMY_URL=http://localhost:5174/ bun ...     (another vite)
 *   ANATOMY_DIR=/abs/path bun ...                  (load this dir first; default: current field)
 *   ANATOMY_CLEAN=1 bun ...                        (clean-run protocol: clear + save + fresh page)
 *
 * MEASUREMENT LAW: the scratch relay accumulates every run's autosaved field —
 * without ANATOMY_CLEAN=1 you are measuring whatever every previous run left
 * behind, not your change.
 */

import { launchBrowser, openApp } from './itest/driver.mjs';

const URL = process.env.ANATOMY_URL || 'http://localhost:5173/';
const DIR = process.env.ANATOMY_DIR || null;
const CLEAN = process.env.ANATOMY_CLEAN === '1';

const browser = await launchBrowser({});
try {
    let app;
    if (CLEAN) {
        app = await openApp(browser, { url: URL, relayPort: 8099, wait: 5000 });
        await app.cmd('scene.clear_grids');
        await app.cmd('session.save');
        await app.page.close();
    }
    app = await openApp(browser, { url: URL, relayPort: 8099, wait: 6000 });
    if (!app.booted) { console.log('✗ app did not boot'); process.exit(1); }
    if (DIR) {
        console.log((await app.cmd(`file.openDir ${DIR}`)).text?.slice(0, 80));
        await app.cmd('camera.fitall');
        await app.waitFor(5000);
    }

    const report = await app.evalPage(`(async () => {
        const c = window.__glyphClient;
        const gl = c.ctx.renderer ?? c.ctx.sceneContext?.renderer ?? c.ctx.gl;
        const scene = c.ctx.scene ?? c.ctx.sceneContext?.scene;

        // Per-render-call attribution over ~1s (wrap render, read info deltas).
        const calls = [];
        const orig = gl.render.bind(gl);
        gl.render = (s, cam) => {
            const t0 = gl.info.render.triangles, c0 = gl.info.render.drawCalls;
            const r = orig(s, cam);
            calls.push({ tris: gl.info.render.triangles - t0, calls: gl.info.render.drawCalls - c0 });
            return r;
        };
        // FPS percentiles over 3s (concurrent with the wrap).
        const gaps = [];
        let last = performance.now(), on = true;
        const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; if (on) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        await new Promise(r => setTimeout(r, 3000));
        on = false;
        gl.render = orig;
        gaps.sort((a, b) => a - b);

        // Group identical per-frame pass shapes (main pass, minimap pass, ...).
        const shape = new Map();
        for (const x of calls) {
            const k = \`\${x.calls}c\`;
            const e = shape.get(k) ?? { n: 0, tris: 0, calls: x.calls };
            e.n++; e.tris = x.tris; shape.set(k, e);
        }

        // Censuses.
        let objects = 0, meshes = 0;
        const fam = {};
        scene.traverse(o => {
            objects++;
            if (!o.isMesh) return;
            meshes++;
            const k = (o.name || '(unnamed)').replace(/[0-9]+/g, 'N').slice(0, 32);
            fam[k] = (fam[k] ?? 0) + 1;
        });
        let mega = null;
        try {
            // The renderer-parked reference — the ONE arena reachable across
            // module instances (an /@fs import gets a different singleton).
            const a = gl?.glyphPipelineArena ?? null;
            const m = a?.megaField;
            let liveBytes = 0;
            for (const v of m?.views ?? []) if (!v.dead) liveBytes += v.byteCount;
            mega = {
                instanceCount: m?.field?.instanceMesh?.geometry?.instanceCount ?? null,
                liveBytes, views: m?.views?.length ?? 0,
                poseGroups: m?._poseGroups?.length ?? 0,
                panelInstances: m?.panels?.mesh?.geometry?.instanceCount ?? null,
                panelFree: m?.panels?._freeSlots?.length ?? 0,
            };
        } catch { /* arena module unreachable (different serve root) */ }

        return {
            frame: {
                p50: +gaps[gaps.length >> 1].toFixed(1),
                p95: +gaps[(gaps.length * 0.95) | 0].toFixed(1),
                worst: +gaps[gaps.length - 1].toFixed(1),
            },
            passes: [...shape.values()].map(e => ({ perFrame: e.calls, tris: e.tris, frames: e.n })),
            objects, meshes,
            topMeshFamilies: Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 8),
            mega,
        };
    })()`);
    console.log(JSON.stringify(report, null, 2));
    console.log('errors:', app.errors.length ? JSON.stringify(app.errors.slice(0, 5)) : 0);
} finally { await browser.close(); }
