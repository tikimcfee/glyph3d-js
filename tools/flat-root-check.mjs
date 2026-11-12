/**
 * flat-root-check.mjs — does the view's flat render list (collections/FlatRenderRoot.js) draw the
 * same frame as three's walk of the scene, byte for byte, on the GPU — and what does it save?
 *
 * At each sample it renders the live scene twice in the same turn and reads the pixels back:
 *   FLAT — the app's frame: renderer.render(scene, camera), which the app routes through the flat
 *          root (its list rebuilt only when its key moved)
 *   FULL — the same call with the flat root off (render.flatRoot): three's walk of the whole tree
 * and requires 0 bytes to differ and the same number of draw calls. Teeth: a list with every other entry dropped must differ (the
 * comparison sees the list). Samples: fit-all at several distances, a moving camera (a fly to a grid,
 * sampled mid-flight — at least 3 distinct poses), then the library layout. It also reads the list's
 * rebuilds over a second at rest (0 wanted), `scene.render` (the list against a fresh walk), and
 * the render's JS cost both ways (interleaved medians).
 *
 *   bun tools/flat-root-check.mjs --url http://localhost:5173/ --relay 8099 --dir /abs/dir
 *                                 [--width W --height H]
 *
 * Needs Vite and a PRIVATE relay serving a scratch root that holds --dir (frame-profile's setup).
 * Exits 1 when any sample differs, a sample draws nothing (vacuous), the teeth don't bite, the list
 * rebuilt at rest, or the page logged errors.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
if (!DIR) { console.error('usage: --dir /abs/dir (inside the private relay\'s root)'); process.exit(2); }

/** Page-side: render FLAT and FULL (and the teeth), compare, time. */
function sample() {
    const c = window.__glyphClient.ctx, rnd = c.renderer, gl = rnd.getContext();
    const scene = c.scene, cam = c.camera, flat = c.sceneSystems.flatRoot;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = (target) => {
        rnd.info.autoReset = false; rnd.info.reset();
        rnd.render(target, cam);
        const calls = rnd.info.render.calls; rnd.info.autoReset = true;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { px, calls };
    };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    // The app routes every render of the scene through the flat root (the renderer is the seam):
    // FULL is the same call with the flat root off.
    const fullWalk = () => { flat.enabled = false; try { return grab(scene); } finally { flat.enabled = true; } };
    const served = flat.target(cam) === flat.root;
    const f = grab(scene);
    const full = fullWalk();
    // Teeth: every other list entry dropped.
    const list = flat.root.children;
    flat.root.children = list.filter((_, i) => i % 2 === 0);
    const hook = flat.root.onBeforeRender;
    flat.root.onBeforeRender = (r, _s, cm, t) => scene.onBeforeRender(r, scene, cm, t);   // keep the halved list this render
    const half = grab(flat.root);
    flat.root.onBeforeRender = hook;
    flat.root.children = list;
    // Lit pixels (anything not the clear colour) — a blank frame would compare vacuously.
    let lit = 0;
    for (let i = 0; i < full.px.length; i += 4) if (full.px[i] > 12 || full.px[i + 1] > 12 || full.px[i + 2] > 14) lit++;
    // The render's JS cost both ways, interleaved, medians of 15.
    const ms = { flat: [], full: [] };
    for (let k = 0; k < 15; k++) {
        let t = performance.now(); rnd.render(scene, cam); ms.flat.push(performance.now() - t);
        flat.enabled = false;
        t = performance.now(); rnd.render(scene, cam); ms.full.push(performance.now() - t);
        flat.enabled = true;
    }
    gl.finish();
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    return {
        served, refused: flat.refused, lit, total: w * h,
        differ: diff(f.px, full.px), teeth: diff(half.px, full.px),
        calls: { flat: f.calls, full: full.calls }, list: list.length, stats: { ...flat.stats },
        ms: { flat: med(ms.flat), full: med(ms.full) },
    };
}

const browser = await launchGpuBrowser({});
let failed = 0;
const report = (name, r) => {
    const vacuous = r.lit === 0 || r.calls.full === 0;
    // The same draws both ways: a list that lists an object three also walks under another entry
    // draws it twice (often pixel-identical, never free).
    const bad = !r.served || r.differ !== 0 || r.teeth === 0 || vacuous || r.calls.flat !== r.calls.full;
    if (bad) failed++;
    console.log(`${bad ? '✗' : '✓'} ${name}: ${r.served ? 'served' : `NOT served${r.refused ? ` (refused: ${r.refused.reason}: ${r.refused.object})` : ''}`}`
        + ` · ${r.differ} bytes differ flat vs full · teeth (half the list) ${r.teeth} bytes`
        + ` · ${r.lit} lit px · draws ${r.calls.full}/${r.calls.flat} · list ${r.list} (${r.stats.carried} whole)`
        + ` · render JS ${r.ms.full.toFixed(2)} → ${r.ms.flat.toFixed(2)} ms` + (vacuous ? ' · VACUOUS' : ''));
};
try {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('app did not boot');
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
    for (const f of [1, 0.4, 0.1, 0.02]) {
        const pos = fit.pos.map((p, i) => p + fit.dir[i] * fit.dist * (1 - f));
        await app.cmd(`camera.move ${pos.map((v) => v.toFixed(2)).join(' ')}`);
        await app.waitFor(2000);
        report(`fit-all × ${f}`, await app.evalPage(sample));
    }

    // At rest: the list's rebuilds over a second of frames.
    const r0 = await app.evalPage(() => window.__glyphClient.ctx.sceneSystems.flatRoot.stats.rebuilds);
    await app.waitFor(1000);
    const r1 = await app.evalPage(() => window.__glyphClient.ctx.sceneSystems.flatRoot.stats.rebuilds);
    const rest = r1 - r0;
    if (rest !== 0) failed++;
    console.log(`${rest === 0 ? '✓' : '✗'} at rest: ${rest} list rebuilds in 1 s`);

    // A moving camera: a fly from far out to one grid, sampled mid-flight (each sample a new pose).
    const id = await app.evalPage(() => { const r = window.__glyphClient.ctx.registry; const g = r.toArray('grid')[0]; return g ? r.getIdByGrid(g) : null; });
    await app.cmd('camera.fitall');
    await app.waitFor(2500);
    await app.cmd(`camera.focus ${id}`);
    const poses = new Set();
    for (let k = 0; k < 5; k++) {
        await app.waitFor(90);
        const pose = await app.evalPage(() => window.__glyphClient.ctx.camera.position.toArray().map((v) => v.toFixed(1)).join(','));
        poses.add(pose);
        report(`moving camera, sample ${k + 1} (at ${pose})`, await app.evalPage(sample));
    }
    if (poses.size < 3) { failed++; console.log(`✗ the fly moved through only ${poses.size} pose(s) — the moving samples are not moving`); }
    await app.waitFor(3000);

    // The library layout (books, panels, labels).
    console.log(`[cmd] ${((await app.cmd('layout.scheme library')).text ?? '').slice(0, 70)}`);
    await app.waitFor(4000);
    await app.cmd('camera.fitall');
    await app.waitFor(3500);
    report('library, fit-all', await app.evalPage(sample));

    const v = await app.cmd('scene.render');
    const stale = !/OK: every list matches a fresh walk/.test(v.text ?? '');
    if (stale) failed++;
    console.log(`${stale ? '✗' : '✓'} scene.render: ${(v.text ?? '').split('\n').filter((l) => /rebuilds|list:|OK|FAIL/.test(l)).map((l) => l.replace(/[║]/g, '').trim()).join(' · ')}`);

    if (app.errors.length) { console.log('page errors:', JSON.stringify(app.errors.slice(0, 3))); failed++; }
} finally {
    await browser.close();
}
console.log(failed ? `FAIL flat-root-check: ${failed} failing` : 'ok flat-root-check');
process.exit(failed ? 1 : 0);
