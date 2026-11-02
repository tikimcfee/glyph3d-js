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
 *   bun tools/desk-reload-check.mjs --live [--port 8080] [--desk <name>] [--out-dir <dir>]
 *
 * Needs Vite and a PRIVATE relay (--no-gomuxai, its own --tmux-socket) on a SCRATCH root that
 * holds --dir: the page runs with its session ON (it saves and restores — into that root's file).
 * With --live, drives an already-connected display over the relay bus without session.clear.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchGpuBrowser } from './itest/driver.mjs';
import { dialRelay } from './lib/relay.mjs';
import { decodePng, cropImage, writePng } from './lib/pixel-metrics.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);

async function assertNotHeldByOtherDesk(req, id, targetDesk) {
    const chk = (await req('carrel.check')).data?.members ?? [];
    const hit = chk.find((m) => m.id === id && m.desk && m.desk !== targetDesk);
    if (hit) {
        throw new Error(`refusing to carrel.add '${id}' to '${targetDesk}': already held by desk '${hit.desk}'`);
    }
    const list = (await req('carrel.list')).data?.carrels ?? [];
    for (const c of list) {
        if (c.name === targetDesk) continue;
        if ((c.members ?? []).some((m) => m.id === id)) {
            throw new Error(`refusing to carrel.add '${id}' to '${targetDesk}': already held by desk '${c.name}'`);
        }
    }
}

function makeScratchCode(name, rev = 1) {
    const lines = [
        `// ${name}.js — scratch module (rev ${rev})`,
        `export const MODULE_NAME = '${name}';`,
        `export const MODULE_REV = ${rev};`,
        '',
    ];
    for (let i = 1; i <= 36; i++) {
        lines.push(`export function ${name}Step${String(i).padStart(2, '0')}(x = ${i}) { return x * ${rev} + ${i * 3}; }`);
    }
    return lines.join('\n') + '\n';
}

if (flag('--live')) {
    const port = Number(arg('--port', arg('--relay', '8080')));
    const outDir = arg('--out-dir');
    let desk = arg('--desk');
    let relay = await dialRelay(port);
    const req = (line, ms = 30000) => relay.request(line, ms);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (pred, timeoutMs = 60000, everyMs = 50) => {
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
            try {
                const s = (await req('plane.state', 2500)).data;
                if (pred(s)) return true;
            } catch { /* reloading */ }
            await sleep(everyMs);
        }
        return false;
    };
    const landed = (d) => (s) => s && !s.tweening && s.target === `carrel:${d}`;
    const measureStep = async (tag, label, failures) => {
        const chk = await req(`carrel.check ${desk}`);
        const okCheck = /^OK:/m.test(chk.text ?? '') && (chk.data?.members?.length ?? 0) > 0 && chk.data.members.every((m) => m.ok);
        const shot = await req('screenshot', 15000);
        const img = decodePng(Buffer.from(shot.data.image, 'base64'));
        if (outDir) writePng(`${outDir}/desk-reload-${tag}.png`, img);
        const crop = cropImage(img, {
            x: Math.round(img.width * 0.15),
            y: Math.round(img.height * 0.15),
            w: Math.round(img.width * 0.7),
            h: Math.round(img.height * 0.7),
        });
        let ink = 0;
        for (let i = 0; i < crop.data.length; i += 4) {
            if (Math.max(crop.data[i], crop.data[i + 1], crop.data[i + 2]) > 60) ink++;
        }
        const ok = okCheck && ink > 500;
        if (!ok) failures.push(label);
        console.log(`${ok ? '✓' : '✗'} ${label}: carrel.check ${okCheck ? 'OK' : 'FAIL'} · center ink ${ink} px`);
        return ok;
    };

    const failures = [];
    let createdTemp = false;
    let scratchCacheDir = null;
    const openedScratchFiles = [];
    let initialPlane = null;
    let initialCam = null;
    let initialAtt = null;
    let initialCheck = [];
    try {
        initialPlane = (await req('plane.state')).data;
        if (initialPlane) {
            await req('carrel.leave');
            await until((s) => !s, 10000);
            await sleep(400);
        }
        initialCam = (await req('camera.info')).data;
        initialAtt = (await req('attention.info')).data;
        initialCheck = (await req('carrel.check')).data?.members ?? [];

        if (!desk) {
            desk = 'reloadcheck-live';
            createdTemp = true;
            const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
            fs.mkdirSync(cacheBase, { recursive: true });
            scratchCacheDir = fs.mkdtempSync(path.join(cacheBase, 'glyph3d-desk-reload-'));
            // Register empty scratchCacheDir as a reach root on the relay without adding to fieldSources.
            await req(`file.openDir ${scratchCacheDir}`);
            for (const name of ['reload-alpha', 'reload-beta']) {
                const f = path.join(scratchCacheDir, `${name}.js`);
                fs.writeFileSync(f, makeScratchCode(name, 1));
                await req(`file.open ${f}`);
                openedScratchFiles.push(f);
            }
            await req(`carrel.create ${desk}`);
            for (const f of openedScratchFiles) {
                await assertNotHeldByOtherDesk(req, f, desk);
                const addRes = await req(`carrel.add ${f} ${desk}`);
                if (!/^OK:/.test(addRes.text ?? '')) throw new Error(`carrel.add ${f} ${desk} failed: ${addRes.text}`);
            }
            await sleep(600);
        }
        await req(`carrel.enter ${desk}`);
        await until(landed(desk), 15000);
        await measureStep('seated', 'seated + entered', failures);

        const scheme = (await req('layout.scheme')).data?.scheme || 'hierarchical';
        await req(`layout.scheme ${scheme}`);
        await sleep(600);
        await measureStep('relayout', `after a full tree relayout (layout.scheme ${scheme})`, failures);

        await req('session.save');
        await sleep(300);
        const prevAt = (await req('session.status')).data?.restore?.at ?? 0;
        await req('reload');
        await sleep(1000);
        relay.close();
        relay = await dialRelay(port);
        const t0 = performance.now();
        while (performance.now() - t0 < 60000) {
            try {
                const st = await req('session.status', 2500);
                if (/^restore: complete/m.test(st.text ?? '') && st.data?.restore?.at !== prevAt) break;
            } catch { /* reloading */ }
            await sleep(150);
        }
        const reEntered = await until(landed(desk), 60000, 100);
        if (!reEntered) failures.push('reload re-enters the desk');
        await measureStep('reload', 'after a save + reload (restore re-seats, re-enters)', failures);

        await req('carrel.leave');
        await until((s) => !s, 10000);
        await req(`carrel.enter ${desk}`);
        await until(landed(desk), 15000);
        await measureStep('reenter', 'after leave + re-enter', failures);
        await req('carrel.leave');
        await until((s) => !s, 10000);
    } finally {
        try {
            if ((await req('plane.state')).data) {
                await req('carrel.leave');
                await until((s) => !s, 10000);
            }
            if (createdTemp) {
                for (const f of openedScratchFiles) {
                    await req(`grid.close ${f}`);
                }
                await req(`carrel.dissolve ${desk}`);
                const tDissolve = Date.now() + 4000;
                while (Date.now() < tDissolve) {
                    const list = (await req('carrel.list')).data?.carrels ?? [];
                    if (!list.some((c) => c.name === desk)) break;
                    await sleep(60);
                }
            }
            // Re-materialize any pre-existing CodeGrid desk members that restored as FileRow
            const postCheck = (await req('carrel.check')).data?.members ?? [];
            for (const m0 of initialCheck) {
                if (m0.heldKind === 'CodeGrid') {
                    const mNow = postCheck.find((m) => m.desk === m0.desk && m.id === m0.id);
                    if (mNow && mNow.heldKind !== 'CodeGrid') {
                        await req(`attention.set primary ${m0.id}`);
                    }
                }
            }
            await req(`attention.set primary ${initialAtt?.primary?.id ?? 'none'}`);
            await req(`attention.set key ${initialAtt?.key?.id ?? 'none'}`);
            if (initialPlane?.target?.startsWith('carrel:')) {
                await req(`carrel.enter ${initialPlane.target.slice('carrel:'.length)}`);
                await until((s) => s && !s.tweening, 10000);
            } else if (initialCam?.position) {
                const { x, y, z } = initialCam.position;
                await req(`camera.move ${x} ${y} ${z}`);
            }
            await req('session.save');
        } catch { /* best effort */ }
        if (scratchCacheDir) {
            try { fs.rmSync(scratchCacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        relay.close();
    }
    console.log(failures.length ? `FAIL desk-reload-check: ${failures.length} failing` : 'ok desk-reload-check');
    process.exit(failures.length ? 1 : 0);
}

const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
if (!DIR) { console.error('usage: --dir /abs/dir (inside the private relay\'s scratch root), or --live [--port 8080] [--desk <name>]'); process.exit(2); }
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
