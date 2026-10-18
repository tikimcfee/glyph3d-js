/**
 * panel-batch-check.mjs — does the batched frame look like the frame where every panel draws
 * itself, and how many draws did batching save?
 *
 * PanelBatch draws enrolled panels as instances and takes each panel off the view camera's
 * layer 0. This renders the live scene three ways at each pose and reads the pixels back in
 * the same turn:
 *   BATCHED — the app's frame (the batch refreshed from scene.onBeforeRender)
 *   SHIFTED — the batch's hook bypassed, its meshes hidden, every batched panel back on layer 0
 *             drawing itself at the bucket's order (its render order − 0.5)
 *   OWN     — the same at the panels' own render order: the frame before batching
 *   BARE    — batched panels hidden entirely (the teeth: what "no panels" looks like)
 * BATCHED vs SHIFTED is the instancing's correctness: the same draws in the same order, so it
 * must match to a sliver of what removing the panels changes. BATCHED vs OWN is the look change
 * batching makes on purpose — a bucket draws half a step before its band, so panels no longer
 * interleave by depth with the non-panels sharing their render order (directory boxes whose
 * depth lands them in a panel band, the glyph fields at 0) — reported for a human to judge.
 *
 *   bun tools/panel-batch-check.mjs --url http://127.0.0.1:5174/ --relay 8099 --dir /abs/dir
 *                                   [--cmd 'layout.scheme library']… [--width W --height H] [--shots DIR]
 *
 * Needs Vite and a PRIVATE relay serving a scratch root that can reach --dir (frame-profile's
 * setup). Exits 1 when a pose batches nothing (vacuous), draws no fewer calls batched, or when
 * BATCHED differs from SHIFTED on more than 1% of the pixels BARE does.
 */

import { writeFileSync } from 'node:fs';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
const SHOTS = arg('--shots');
const CMDS = process.argv.flatMap((a, i) => (a === '--cmd' ? [process.argv[i + 1]] : []));
if (!DIR) { console.error('usage: --dir /abs/dir (inside the relay root or its --reach)'); process.exit(2); }

const browser = await launchGpuBrowser({});
let failed = 0;
try {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('app did not boot');
    for (const v of CMDS) { console.log(`[cmd] ${v} → ${((await app.cmd(v)).text ?? '').slice(0, 70)}`); await app.waitFor(1500); }
    console.log(`[load] ${((await app.cmd(`file.openDir ${DIR}`)).text ?? '').slice(0, 90)}`);
    await app.waitFor(6000);

    await app.cmd('camera.fitall');
    await app.waitFor(3500);
    const fit = await app.evalPage(() => {
        const c = window.__glyphClient.ctx, cam = c.camera;
        let n = 0; const ctr = cam.position.clone().set(0, 0, 0);
        for (const g of c.registry.toArray('grid')) { const b = g?.getBounds?.(); if (b && !b.isEmpty()) { ctr.add(b.getCenter(cam.position.clone())); n++; } }
        ctr.multiplyScalar(1 / Math.max(n, 1));
        return { pos: cam.position.toArray(), dist: cam.position.distanceTo(ctr), dir: cam.getWorldDirection(cam.position.clone()).toArray() };
    });
    const poses = [1, 0.5, 0.2, 0.05].map((f) => [`fit-all × ${f} distance`,
        fit.pos.map((p, i) => p + fit.dir[i] * fit.dist * (1 - f))]);
    for (const [name, pos] of poses) {
        await app.cmd(`camera.move ${pos.map((v) => v.toFixed(2)).join(' ')}`);
        await app.waitFor(2500);
        const r = await app.evalPage((wantShots) => {
            const c = window.__glyphClient.ctx, rnd = c.renderer, gl = rnd.getContext();
            const scene = c.scene, cam = c.camera;
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const grab = () => {
                rnd.info.autoReset = false; rnd.info.reset();
                rnd.render(scene, cam);
                const calls = rnd.info.render.calls; rnd.info.autoReset = true;
                const px = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                return { px, calls };
            };
            const batched = grab();
            const stats = { ...c.panelBatch.stats };
            const buckets = scene.children.filter((o) => o.name === 'panel-batch');
            const panels = [];
            scene.traverse((o) => { if (o.isMesh && o.material?.uniforms?.uFill && o.name !== 'panel-batch' && !o.layers.isEnabled(0)) panels.push(o); });
            const hook = scene.onBeforeRender;
            scene.onBeforeRender = () => {};
            const shown = buckets.map((b) => b.visible);
            for (const b of buckets) b.visible = false;
            for (const p of panels) p.layers.enable(0);
            const own = grab();
            for (const p of panels) p.renderOrder -= 0.5;
            const shifted = grab();
            for (const p of panels) p.renderOrder += 0.5;
            for (const p of panels) p.layers.disable(0);
            const bare = grab();
            buckets.forEach((b, i) => { b.visible = shown[i]; });
            scene.onBeforeRender = hook;

            // render CPU (renderer.render, JS side) — batched includes the batch's own refresh;
            // interleaved so drift lands on both, medians of 15
            const ms = { batched: [], own: [] };
            const toOwn = () => { scene.onBeforeRender = () => {}; for (const b of buckets) b.visible = false; for (const p of panels) p.layers.enable(0); };
            const toBatched = () => { for (const p of panels) p.layers.disable(0); scene.onBeforeRender = hook; };
            for (let k = 0; k < 15; k++) {
                let t = performance.now(); rnd.render(scene, cam); ms.batched.push(performance.now() - t);
                toOwn();
                t = performance.now(); rnd.render(scene, cam); ms.own.push(performance.now() - t);
                toBatched();
                rnd.render(scene, cam);   // re-shows the buckets (the refresh sets visible)
            }
            gl.finish();
            const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
            const timing = { batched: med(ms.batched), own: med(ms.own) };

            // pixels that differ by more than 8/255 in any channel
            const diff = (a, b) => {
                let n = 0, sum = 0;
                for (let i = 0; i < a.length; i += 4) {
                    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
                    sum += d;
                    if (d > 8) n++;
                }
                return { changed: n, mean: sum / (a.length / 4) };
            };
            // --shots: the three frames as PNG data URLs (GL rows are bottom-up)
            const png = (px) => {
                const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
                const cx = cv.getContext('2d'), img = cx.createImageData(w, h);
                for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
                cx.putImageData(img, 0, 0);
                return cv.toDataURL('image/png');
            };
            const shots = wantShots ? { batched: png(batched.px), shifted: png(shifted.px), own: png(own.px), bare: png(bare.px) } : null;
            return { shots, stats, timing, panels: panels.length, calls: { batched: batched.calls, own: own.calls, bare: bare.calls },
                vsShifted: diff(batched.px, shifted.px), vsOwn: diff(batched.px, own.px), bareVsOwn: diff(bare.px, own.px), total: w * h };
        }, !!SHOTS);
        if (SHOTS) {
            const tag = name.replace(/[^0-9.]+/g, '_').replace(/^_|_$/g, '');
            for (const [k, url] of Object.entries(r.shots)) writeFileSync(`${SHOTS}/${tag}-${k}.png`, Buffer.from(url.split(',')[1], 'base64'));
        }
        const share = r.bareVsOwn.changed ? r.vsShifted.changed / r.bareVsOwn.changed : 0;
        const vacuous = r.stats.drawn === 0 || r.bareVsOwn.changed === 0;
        const bad = vacuous || r.calls.batched >= r.calls.own || share > 0.01;
        const pct = (n) => `${(100 * n / r.total).toFixed(3)}%`;
        if (bad) failed++;
        console.log(`${bad ? '✗' : '✓'} ${name}: ${r.stats.drawn} panels batched in ${r.stats.buckets} buckets (${r.stats.hidden} hidden)`
            + ` · draws ${r.calls.own} → ${r.calls.batched} · render CPU ${r.timing.own.toFixed(2)} → ${r.timing.batched.toFixed(2)} ms`
            + `\n    instancing: batched vs shifted ${r.vsShifted.changed} px (${pct(r.vsShifted.changed)}) = ${(100 * share).toFixed(2)}% of no-panels' ${r.bareVsOwn.changed} px`
            + `\n    look change: batched vs before ${r.vsOwn.changed} px (${pct(r.vsOwn.changed)}), mean Δ ${r.vsOwn.mean.toFixed(3)}/255`
            + (vacuous ? ' · VACUOUS (nothing batched or panels invisible)' : ''));
    }
    if (app.errors.length) { console.log('page errors:', JSON.stringify(app.errors.slice(0, 3))); failed++; }
} finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
