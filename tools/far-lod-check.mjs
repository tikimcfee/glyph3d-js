/**
 * far-lod-check.mjs — does a far file READ the same with its glyphs as with its backdrop?
 *
 * GlyphFarLod swaps a field whose rows are under `showGlyphsPx` for one quad of its mean ink
 * colour (alpha = ink cover × gain). This renders the live scene three ways at each pose and
 * reads the pixels back in the same turn:
 *   FULL — showGlyphsPx 0 (every glyph drawn)
 *   LOD  — the default threshold, at each backdrop gain swept (and the configured one)
 *   BARE — far fields hidden, backdrops at gain 0 (the panels alone: the teeth)
 * Compared inside the screen rects of the TRANSITION BAND — far fields whose rows measure
 * between half the threshold and the threshold, where the swap is what you'd see happen —
 * by mean LINEAR light (what the eye averages at a distance; glyph3d-rs fitted its
 * backdrop_gain the same way). Deeper fields are reported, not fitted: there the FULL render
 * is the raster lottery (quads that miss every pixel centre draw nothing — a fit-to-page
 * 2,400-line file renders near-black) and the backdrop is the truer picture. Outside the far
 * rects nothing may change. Reports draw calls FULL vs LOD, and the band's best-fit gain.
 *
 *   bun tools/far-lod-check.mjs --url http://127.0.0.1:5174/ --relay 8099 --dir /abs/dir
 *                               [--cmd 'layout.scheme library']… [--width W --height H]
 *
 * Needs Vite and a PRIVATE relay serving a scratch root that can reach --dir (frame-profile's
 * setup). Exits 1 when a pose has no far field (vacuous), when pixels outside the far rects
 * move, or when the configured gain reads further from FULL than BARE does.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
const CMDS = process.argv.flatMap((a, i) => (a === '--cmd' ? [process.argv[i + 1]] : []));
if (!DIR) { console.error('usage: --dir /abs/dir (inside the relay root or its --reach)'); process.exit(2); }

const browser = await launchGpuBrowser({});
let failed = 0;
try {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('app did not boot');
    console.log(`[load] ${((await app.cmd(`file.openDir ${DIR}`)).text ?? '').slice(0, 90)}`);
    await app.waitFor(4000);
    for (const v of CMDS) { console.log(`[cmd] ${v} → ${((await app.cmd(v)).text ?? '').slice(0, 70)}`); await app.waitFor(3000); }

    // Fit-all, then the camera stepped in along its own view ray: each pose puts a different
    // slice of the scene in the transition band.
    await app.cmd('camera.fitall');
    await app.waitFor(3500);
    const fit = await app.evalPage(() => {
        const c = window.__glyphClient.ctx, cam = c.camera;
        let n = 0; const ctr = cam.position.clone().set(0, 0, 0);
        for (const g of c.registry.toArray('grid')) { const b = g?.getBounds?.(); if (b && !b.isEmpty()) { ctr.add(b.getCenter(cam.position.clone())); n++; } }
        ctr.multiplyScalar(1 / Math.max(n, 1));
        return { pos: cam.position.toArray(), dist: cam.position.distanceTo(ctr), dir: cam.getWorldDirection(cam.position.clone()).toArray() };
    });
    const poses = [1, 0.5, 0.25, 0.12].map((f) => [`fit-all × ${f} distance`,
        fit.pos.map((p, i) => p + fit.dir[i] * fit.dist * (1 - f))]);
    for (const [name, pos] of poses) {
        await app.cmd(`camera.move ${pos.map((v) => v.toFixed(2)).join(' ')}`);
        await app.waitFor(2500);
        const r = await app.evalPage(() => {
            const c = window.__glyphClient.ctx, lod = c.glyphFarLod, rnd = c.renderer, gl = rnd.getContext();
            const scene = c.scene, cam = c.camera;
            const Hc = rnd.domElement.clientHeight;
            const keep = { ...lod.params };
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const grab = () => {
                lod.update(cam, Hc);
                rnd.info.autoReset = false; rnd.info.reset();
                rnd.render(scene, cam);
                const calls = rnd.info.render.calls; rnd.info.autoReset = true;
                const px = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                return { px, calls, stats: { ...lod.stats } };
            };

            // Which fields are far at this pose, and their screen rects: `mask` = every far rect
            // (nothing outside may change), `band` = the transition band's (the fit's region).
            lod.setParam('showGlyphsPx', keep.showGlyphsPx);
            lod.update(cam, Hc);
            const mask = new Uint8Array(w * h), band = new Uint8Array(w * h);
            const fov = cam.getEffectiveFOV?.() ?? 50, ppu = Hc / (2 * Math.tan(fov * Math.PI / 360));
            const eye = cam.getWorldPosition(cam.position.clone());
            let bandFields = 0;
            const V = cam.position.constructor;
            const corners = Array.from({ length: 8 }, () => new V());
            let farRects = 0;
            for (const o of (function* walk(n) { yield n; for (const ch of n.children) yield* walk(ch); })(scene)) {
                const f = o.userData?.glyphField;
                if (!f || !o.frustumCulled || o.layers.isEnabled(0) || !f.geometry.boundingBox) continue;
                const b = f.geometry.boundingBox;
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
                for (let k = 0; k < 8; k++) {
                    const p = corners[k].set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z)
                        .applyMatrix4(o.matrixWorld).project(cam);
                    if (p.z > 1) behind = true;
                    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
                }
                if (behind) continue;
                const X0 = Math.max(0, Math.floor((x0 + 1) / 2 * w)), X1 = Math.min(w - 1, Math.ceil((x1 + 1) / 2 * w));
                const Y0 = Math.max(0, Math.floor((y0 + 1) / 2 * h)), Y1 = Math.min(h - 1, Math.ceil((y1 + 1) / 2 * h));
                if (X1 < X0 || Y1 < Y0) continue;
                farRects++;
                for (let y = Y0; y <= Y1; y++) mask.fill(1, y * w + X0, y * w + X1 + 1);
                // this field's rows on screen, by the far-LOD's own measure (nearest point)
                for (let k = 0; k < 8; k++) corners[k].set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld);
                const lo = corners.reduce((a, p) => a.min(p), corners[0].clone()), hi = corners.reduce((a, p) => a.max(p), corners[0].clone());
                const near = Math.hypot(Math.max(lo.x - eye.x, 0, eye.x - hi.x), Math.max(lo.y - eye.y, 0, eye.y - hi.y), Math.max(lo.z - eye.z, 0, eye.z - hi.z));
                const rowPx = f.rowHeight * o.matrixWorld.getMaxScaleOnAxis() * ppu / Math.max(near, 1e-3);
                if (rowPx >= keep.showGlyphsPx / 2) {
                    bandFields++;
                    for (let y = Y0; y <= Y1; y++) band.fill(1, y * w + X0, y * w + X1 + 1);
                }
            }

            const lin = new Float64Array(256).map((_, k) => Math.pow(k / 255, 2.2));
            const meanLin = (px, m = band) => {
                let s = 0, n = 0;
                for (let i = 0; i < m.length; i++) if (m[i]) { const o = i * 4; s += lin[px[o]] + lin[px[o + 1]] + lin[px[o + 2]]; n++; }
                return n ? s / (3 * n) : 0;
            };
            const absDiff = (a, b) => {
                let s = 0, n = 0, outside = 0;
                for (let i = 0; i < mask.length; i++) {
                    const o = i * 4;
                    const d = Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
                    if (mask[i]) { s += d; n++; } else if (d) outside++;
                }
                return { inside: n ? +(s / (3 * n)).toFixed(3) : 0, outsidePixelsChanged: outside };
            };

            lod.setParam('showGlyphsPx', 0);
            const full = grab();
            lod.setParam('showGlyphsPx', keep.showGlyphsPx);
            lod.setParam('backdropGain', 0);
            const bare = grab();
            const sweep = [];
            for (let g = 0.1; g <= 2.001; g += 0.1) {
                lod.setParam('backdropGain', +g.toFixed(2));
                sweep.push([+g.toFixed(2), meanLin(grab().px)]);
            }
            lod.setParam('backdropGain', keep.backdropGain);
            const at = grab();
            lod.setParam('showGlyphsPx', keep.showGlyphsPx);

            const mFull = meanLin(full.px);
            const best = sweep.reduce((a, b) => (Math.abs(b[1] - mFull) < Math.abs(a[1] - mFull) ? b : a));
            const rel = (m) => +(100 * (m - mFull) / Math.max(mFull, 1e-9)).toFixed(1);
            return {
                canvas: [w, h], far: at.stats, farRects, bandFields,
                farPixels: mask.reduce((a, b) => a + b, 0), bandPixels: band.reduce((a, b) => a + b, 0),
                draws: { full: full.calls, lod: at.calls },
                bandMeanLinear: { full: +mFull.toFixed(5), lod: +meanLin(at.px).toFixed(5), bare: +meanLin(bare.px).toFixed(5) },
                bandVsFullPct: { lod: rel(meanLin(at.px)), bare: rel(meanLin(bare.px)) },
                allFarVsFullPct: { lod: +(100 * (meanLin(at.px, mask) / Math.max(meanLin(full.px, mask), 1e-9) - 1)).toFixed(1),
                    bare: +(100 * (meanLin(bare.px, mask) / Math.max(meanLin(full.px, mask), 1e-9) - 1)).toFixed(1) },
                absDiffPerChannel: { lod: absDiff(full.px, at.px), bare: absDiff(full.px, bare.px) },
                gain: { configured: keep.backdropGain, bestFit: best[0], bestFitPct: rel(best[1]) },
            };
        });
        console.log(`\n== ${name}`);
        console.log(JSON.stringify(r, null, 1));
        const problems = [];
        if (!r.far.backdrops) problems.push('no far field at this pose — vacuous');
        if (r.absDiffPerChannel.lod.outsidePixelsChanged) problems.push(`${r.absDiffPerChannel.lod.outsidePixelsChanged} pixels changed OUTSIDE the far rects`);
        if (r.bandFields && Math.abs(r.bandVsFullPct.lod) >= Math.abs(r.bandVsFullPct.bare)) problems.push('in the transition band the backdrop reads no closer to the glyphs than bare panels do');
        for (const p of problems) console.log(`  ✗ ${p}`);
        if (!problems.length) {
            const band = r.bandFields
                ? `band (${r.bandFields} fields): backdrops ${r.bandVsFullPct.lod}% vs glyphs, bare ${r.bandVsFullPct.bare}%, best gain ${r.gain.bestFit} (${r.gain.bestFitPct}%)`
                : 'no field in the transition band at this pose';
            console.log(`  ✓ ${band}; all far: ${r.allFarVsFullPct.lod}%; draws ${r.draws.full} → ${r.draws.lod}`);
        }
        failed += problems.length ? 1 : 0;
    }
    if (app.errors.length) { console.log('page errors:', app.errors.slice(0, 3)); failed++; }
} finally {
    await browser.close();
}
process.exit(failed ? 1 : 0);
