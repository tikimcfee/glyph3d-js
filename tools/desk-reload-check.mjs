/**
 * desk-reload-check.mjs — files seated at a PLANE desk stay drawn in their seats through what a
 * session does to them: a full tree relayout while they're seated, a save + page reload (the restore
 * re-opens them as tabs, re-seats them and re-enters the desk), a leave + re-enter.
 *
 * The regression it locks: every tree relayout runs Book.release (and the fit) on every book, which
 * re-seated each sheet's content at the origin — including content a desk had taken. A restore's
 * tab phase relayouts after the desks stand, so after a reload every seated file sat at its desk's
 * origin, outside the plane's depth slab: blank, unpickable (carrel.check: "NOT in its seat").
 *
 * Each step requires carrel.check OK (held live, under the desk, in its seat) and ink in every
 * on-screen pin box. TEETH: a second page with Book.release put back to re-seat held content must
 * fail at the relayout step.
 *
 *   bun tools/desk-reload-check.mjs --relay 8099 --dir /abs/dir [--url URL]
 *
 * Needs Vite and a PRIVATE relay (--no-gomuxai, its own --tmux-socket) on a SCRATCH root that
 * holds --dir: the page runs with its session ON (it saves and restores — into that root's file).
 */

import { launchGpuBrowser } from './itest/driver.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
if (!DIR) { console.error('usage: --dir /abs/dir (inside the private relay\'s scratch root)'); process.exit(2); }
const DESK = 'reloadcheck';

/** Page-side: ink in each member's on-screen pin box. */
function inkPerPin(desk) {
    const c = window.__glyphClient.ctx, r = c.renderer, gl = r.getContext(), cam = c.camera;
    r.render(c.scene, cam);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const carrel = c.carrels.get(desk);
    if (!carrel) return null;
    return [...carrel.entries.values()].map((e) => {
        const b = e.grid.getBounds();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) {
            const v = cam.position.clone().set(x, y, (b.min.z + b.max.z) / 2).project(cam);
            x0 = Math.min(x0, (v.x + 1) / 2 * w); x1 = Math.max(x1, (v.x + 1) / 2 * w);
            y0 = Math.min(y0, (v.y + 1) / 2 * h); y1 = Math.max(y1, (v.y + 1) / 2 * h);
        }
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
        let ink = 0, area = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; area++; if (Math.max(px[i], px[i + 1], px[i + 2]) > 60) ink++; }
        return { id: e.id.split('/').pop(), area, ink };
    });
}

async function open(browser) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    await page.goto(`${URL}${URL.includes('?') ? '&' : '?'}relay=${RELAY}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__glyphClient, { timeout: 20000 });
    await page.waitForTimeout(5000);
    const cmd = (v) => page.evaluate(async (a) => { try { return (await window.__glyphClient.router.execute(a)).text ?? ''; } catch (e) { return `ERR: ${e.message}`; } }, v.split(/\s+/));
    return { page, cmd, errors };
}

/** One step's verdict: carrel.check OK and every on-screen pin inked. */
async function step(app, name, failures, quiet = false) {
    const check = await app.cmd(`carrel.check ${DESK}`);
    const pins = await app.page.evaluate(inkPerPin, DESK);
    const okCheck = /\nOK: /.test(check);
    const blank = (pins ?? []).filter((p) => p.area > 0 && p.ink < Math.max(50, p.area * 0.002));
    const onScreen = (pins ?? []).filter((p) => p.area > 0).length;
    const ok = okCheck && pins && !blank.length && onScreen > 0;
    if (!ok) failures.push(name);
    if (!quiet || !ok) {
        console.log(`${ok ? '✓' : '✗'} ${name}: carrel.check ${okCheck ? 'OK' : 'FAIL'} · ${onScreen} pin(s) on screen · ${pins ? pins.map((p) => `${p.id} ${p.ink}`).join(', ') : 'NO DESK'}${blank.length ? ` · BLANK: ${blank.map((p) => p.id).join(', ')}` : ''}`);
        if (!okCheck) console.log(check.split('\n').filter((l) => /✗|pos /.test(l)).slice(0, 4).map((l) => '    ' + l.trim().slice(0, 200)).join('\n'));
    }
    return ok;
}

async function run(browser, { teeth }) {
    const failures = [];
    const app = await open(browser);
    await app.cmd('session.clear');
    await app.cmd(`file.openDir ${DIR}`);
    await app.page.waitForTimeout(6000);
    const files = await app.page.evaluate(() => window.__glyphClient.ctx.registry.findByType('grid').filter((e) => e.grid?.isFileRow).slice(0, 4).map((e) => e.id));
    for (const f of files.slice(0, 4)) await app.cmd(`file.open ${f}`);   // tabs: the restore re-opens these
    await app.page.waitForTimeout(2500);
    if (teeth) {
        // The old Book.release: re-seat every sheet's content at the origin, held or not.
        await app.page.evaluate(() => {
            const book = [...window.__glyphClient.ctx.contentTree._books.values()][0];
            const P = Object.getPrototypeOf(book), base = P.release;
            P.release = function () {
                const r = base.call(this);
                for (const s of this.sheets) for (const c of [s.verso, s.recto]) if (c) { c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); }
                return r;
            };
        });
    }
    await app.cmd(`carrel.create ${DESK}`);
    for (const f of files.slice(0, 4)) await app.cmd(`carrel.add ${f} ${DESK}`);
    await app.page.waitForTimeout(2000);
    await app.cmd(`carrel.enter ${DESK}`);
    await app.page.waitForTimeout(3000);
    await step(app, `${teeth ? '[teeth] ' : ''}seated + entered`, failures, teeth);
    // A full tree relayout while they're seated: the current scheme re-applied (every book released
    // and re-fit — what a restore's tab phase and any insert do).
    const scheme = ((await app.cmd('layout.scheme')).match(/current:\s*(\S+)/) ?? [])[1];
    console.log(`  relayout: ${(await app.cmd(`layout.scheme ${scheme}`)).split('\n').pop().slice(0, 70)}`);
    await app.page.waitForTimeout(2500);
    const relayoutOk = await step(app, `${teeth ? '[teeth] ' : ''}after a full tree relayout (layout.scheme ${scheme})`, failures, teeth);
    if (teeth) { await app.page.close(); return { relayoutOk }; }

    await app.cmd('session.save');
    await app.page.reload({ waitUntil: 'load' });
    await app.page.waitForFunction(() => !!window.__glyphClient, { timeout: 20000 });
    await app.page.waitForTimeout(15000);
    const entered = await app.cmd('plane.state');
    console.log(`  after reload: ${entered.split('\n')[0].slice(0, 70)}`);
    if (!/carrel:reloadcheck/.test(entered)) failures.push('reload re-enters the desk');
    await step(app, 'after a save + reload (restore re-seats, re-enters)', failures);
    await app.cmd('carrel.leave');
    await app.page.waitForTimeout(1500);
    await app.cmd(`carrel.enter ${DESK}`);
    await app.page.waitForTimeout(3000);
    await step(app, 'after leave + re-enter', failures);
    if (app.errors.length) { failures.push('page errors'); console.log('page errors:', JSON.stringify(app.errors.slice(0, 3))); }
    await app.cmd('session.clear');
    await app.page.close();
    return { failures };
}

const browser = await launchGpuBrowser({});
let failed = 0;
try {
    const live = await run(browser, { teeth: false });
    failed += live.failures.length;
    const t = await run(browser, { teeth: true });
    const bites = !t.relayoutOk;
    if (!bites) failed++;
    console.log(`${bites ? '✓' : '✗'} teeth: with the old Book.release (re-seating held content) the relayout step ${bites ? 'fails' : 'still PASSES'}`);
} finally {
    await browser.close();
}
console.log(failed ? `FAIL desk-reload-check: ${failed} failing` : 'ok desk-reload-check');
process.exit(failed ? 1 : 0);
