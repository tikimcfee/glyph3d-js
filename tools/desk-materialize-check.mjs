/**
 * desk-materialize-check.mjs — code grids seated at a PLANE desk draw their glyphs when the desk is
 * entered, including the member attention materializes (a FileRow becoming its CodeGrid actor at
 * carrel.enter's focus — fileLoader.materializeActor → Holding.replace).
 *
 * Opens a directory (its files pour in as FileRows), seats --n of them at a new plane desk, enters
 * it, and for every seated member requires: its glyph mesh is under the desk, and the part of its
 * pin's box that is on screen holds ink (pixels clearly above the backdrop). Then the TEETH: the
 * same with Holding.replace switched off on the page must leave the focused member's pin blank (the
 * regression: the actor re-homed into the content tree, the desk holding a disposed row).
 *
 *   bun tools/desk-materialize-check.mjs --relay 8099 --dir /abs/dir [--n 4] [--url URL]
 *
 * Needs Vite and a PRIVATE relay (--no-gomuxai) serving a scratch root that holds --dir.
 * Exits 1 when a pin is blank or off its desk, or the teeth don't bite.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const N = Number(arg('--n', 4));
if (!DIR) { console.error('usage: --dir /abs/dir (inside the private relay\'s root)'); process.exit(2); }

/** Page-side: every seated member's glyph mesh parentage and the ink inside its on-screen pin box. */
function measure(desk) {
    const c = window.__glyphClient.ctx, r = c.renderer, gl = r.getContext(), cam = c.camera;
    r.render(c.scene, cam);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const carrel = c.carrels.get(desk);
    const focus = c.attentionManager?.get?.('primary')?.id ?? null;
    return [...carrel.entries.values()].map((e) => {
        const g = c.registry.get(e.id)?.grid;
        const mesh = g?._renderer?.instanceMesh ?? null;
        let underDesk = false;
        for (let o = mesh; o; o = o.parent) if (o === carrel) underDesk = true;
        const held = e.grid === g;
        // The pin's box on screen (device px, GL rows bottom-up), clipped to the viewport.
        const b = e.grid.getBounds();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) {
            const v = cam.position.clone().set(x, y, (b.min.z + b.max.z) / 2).project(cam);
            const sx = (v.x + 1) / 2 * w, sy = (v.y + 1) / 2 * h;
            x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
        let ink = 0, area = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4; area++;
            if (Math.max(px[i], px[i + 1], px[i + 2]) > 60) ink++;
        }
        return { id: e.id.split('/').pop(), cls: g?.constructor?.name, focused: e.id === focus, held, underDesk, area, ink };
    });
}

async function run(browser, { teeth }) {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: 1600, height: 1000 } });
    if (!app.booted) throw new Error('app did not boot');
    if (teeth) await app.evalPage(() => { window.__glyphClient.ctx.holding.replace = () => ({ desk: null, docked: false }); });
    await app.cmd(`file.openDir ${DIR}`);
    await app.waitFor(6000);
    const ids = await app.evalPage((n) => window.__glyphClient.ctx.registry.findByType('grid').filter((e) => e.grid?.isFileRow).slice(0, n).map((e) => e.id), N);
    await app.cmd('carrel.create matcheck');
    for (const id of ids) await app.cmd(`carrel.add ${id} matcheck`);
    await app.waitFor(2500);
    const enter = await app.cmd('carrel.enter matcheck');
    await app.waitFor(3000);
    const rows = await app.evalPage(measure, 'matcheck');
    const errors = app.errors;
    await app.page.close();
    return { ids, enter: (enter.text ?? '').split('\n')[0], rows, errors };
}

const browser = await launchGpuBrowser({});
let failed = 0;
try {
    const live = await run(browser, { teeth: false });
    console.log(`[enter] ${live.enter.slice(0, 100)}`);
    const onScreen = live.rows.filter((r) => r.area > 0);
    for (const r of live.rows) {
        const bad = !r.held || !r.underDesk || (r.area > 0 && r.ink < Math.max(50, r.area * 0.002));
        if (bad) failed++;
        console.log(`${bad ? '✗' : '✓'} ${r.id} (${r.cls}${r.focused ? ', focused' : ''}): ${r.held ? 'held' : 'NOT HELD'} · ${r.underDesk ? 'under the desk' : 'OFF THE DESK'} · ${r.ink} ink px of ${r.area} on screen`);
    }
    const focused = live.rows.find((r) => r.focused);
    if (!focused || focused.cls !== 'CodeGrid') { failed++; console.log(`✗ the focused member was not materialized (${focused?.cls ?? 'no focus'}) — the regression's path didn't run`); }
    if (!onScreen.length) { failed++; console.log('✗ VACUOUS: no pin on screen'); }

    const t = await run(browser, { teeth: true });
    const tf = t.rows.find((r) => r.focused);
    const bites = tf && (!tf.held || !tf.underDesk || tf.ink < Math.max(50, tf.area * 0.002));
    if (!bites) failed++;
    console.log(`${bites ? '✓' : '✗'} teeth: with Holding.replace off, the focused pin ${tf ? `is ${tf.held ? 'held' : 'NOT held'}, ${tf.underDesk ? 'under' : 'off'} the desk, ${tf.ink} ink px of ${tf.area}` : 'is missing'}`);
    if (live.errors.length) { failed++; console.log('page errors:', JSON.stringify(live.errors.slice(0, 3))); }
} finally {
    await browser.close();
}
console.log(failed ? `FAIL desk-materialize-check: ${failed} failing` : 'ok desk-materialize-check');
process.exit(failed ? 1 : 0);
