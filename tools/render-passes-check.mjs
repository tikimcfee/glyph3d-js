/**
 * render-passes-check.mjs — the frame the ONE render owner draws (app/client/FramePasses.js) is the
 * frame the passes it replaced drew, byte for byte: BEFORE (a build without the owner) and AFTER (a
 * build with it), the same scripted scenes, the displayed canvas compared.
 *
 *   bun tools/render-passes-check.mjs --before http://127.0.0.1:5181/ --after http://127.0.0.1:5182/
 *                                     --relay 8099 --dir /abs/dir [--width W --height H] [--shots DIR]
 *
 * --before / --after: two Vites serving the two builds (e.g. scratch worktrees: HEAD, and HEAD + the
 * change — so nothing else in flight differs). Both pages dial one PRIVATE relay (--no-gomuxai, a
 * scratch root holding --dir), session off, the minimap ON (view.minimap seeded before load).
 *
 * Scenes: the open world at fit-all; a plane desk (four files) entered — the overlay's strip draws.
 * Each compares the canvas as displayed (the compositor's copy: what the person sees), 0 bytes may
 * differ. TEETH (after build): with the overlay pass removed, and with the minimap pass removed, the
 * entered scene must differ from before — the comparison sees both passes. It also prints the
 * after build's scene.render PASSES block.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { decodePng, writePng } from './lib/pixel-metrics.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BEFORE = arg('--before'), AFTER = arg('--after');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
if (!BEFORE || !AFTER || !DIR) { console.error('usage: --before URL --after URL --relay PORT --dir /abs/dir'); process.exit(2); }

const SETTLE = 4500;   // camera eases, card captures and far-LOD settle well inside this
const SHOTS = arg('--shots');

/** Script one page through the scenes; returns each scene's canvas PNG (and the page). */
async function script(browser, url) {
    const app = await openApp(browser, { url, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: W, height: H }, settings: { 'view.minimap': true } });
    if (!app.booted) throw new Error(`${url}: the app did not boot`);
    const canvas = app.page.locator('canvas').first();
    const shots = {};
    await app.cmd(`file.openDir ${DIR}`);
    await app.waitFor(6000);
    await app.cmd('camera.fitall');
    await app.waitFor(SETTLE);
    shots.world = await canvas.screenshot();
    const ids = await app.evalPage(() => window.__glyphClient.ctx.registry.findByType('grid').map((e) => e.id).sort().slice(0, 4));
    await app.cmd('carrel.create passcheck');
    for (const id of ids) await app.cmd(`carrel.add ${id} passcheck`);
    await app.waitFor(2500);
    await app.cmd('carrel.enter passcheck');
    await app.waitFor(SETTLE);
    shots.entered = await canvas.screenshot();
    return { app, canvas, shots };
}

/** Pixels (RGBA, decoded) that differ between two canvas PNGs. */
const differ = (pa, pb) => {
    const a = decodePng(pa), b = decodePng(pb);
    if (a.width !== b.width || a.height !== b.height) return a.width * a.height;
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) n++;
    }
    return n;
};

const browser = await launchGpuBrowser({});
let failed = 0;
try {
    // One build at a time: the relay serves one display.
    const before = await script(browser, BEFORE);
    const beforeErrors = [...before.app.errors];
    await before.app.page.close();
    const after = await script(browser, AFTER);
    const loaded = await after.app.evalPage(() => window.__glyphClient.ctx.registry.findByType('grid').length);
    if (!loaded) { failed++; console.log('✗ VACUOUS: the after build loaded no files'); }
    for (const k of Object.keys(before.shots)) {
        const d = differ(before.shots[k], after.shots[k]);
        if (d) failed++;
        if (SHOTS) { writePng(`${SHOTS}/${k}-before.png`, decodePng(before.shots[k])); writePng(`${SHOTS}/${k}-after.png`, decodePng(after.shots[k])); }
        console.log(`${d ? '✗' : '✓'} ${k}: ${d} pixels of the displayed canvas differ before vs after`);
    }
    // Teeth: the after build without its overlay pass, then without its minimap pass.
    for (const pass of ['overlay', 'minimap']) {
        const restore = await after.app.evalPage((p) => {
            const rp = window.__glyphClient.ctx.renderPasses;
            const entry = rp.passes.find((x) => x.name === p);
            if (!entry) return null;
            rp.remove(p);
            window.__removedPass = entry;
            return p;
        }, pass);
        await after.app.waitFor(800);
        const shot = await after.canvas.screenshot();
        await after.app.evalPage(() => { const e = window.__removedPass; if (e) window.__glyphClient.ctx.renderPasses.add(e.name, e.order, e.fn); });
        const d = restore ? differ(before.shots.entered, shot) : 0;
        if (!d) failed++;
        console.log(`${d ? '✓' : '✗'} teeth: without the ${pass} pass the entered frame ${d ? `differs (${d} pixels)` : 'is UNCHANGED — the comparison would not see it'}`);
    }
    const sr = await after.app.cmd('scene.render');
    console.log((sr.text ?? '').split('\n').filter((l) => /owner|pass |off-frame/.test(l)).join('\n'));
    for (const [name, errs] of [['before', beforeErrors], ['after', after.app.errors]]) {
        if (errs.length) { failed++; console.log(`${name} page errors:`, JSON.stringify(errs.slice(0, 3))); }
    }
} finally {
    await browser.close();
}
console.log(failed ? `FAIL render-passes-check: ${failed} failing` : 'ok render-passes-check');
process.exit(failed ? 1 : 0);
