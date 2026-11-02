/**
 * plane-ortho-check.mjs — the orthographic plane endpoint (PlaneCamera, DESIGN §4.6) against the
 * camera it A/Bs with, on real pages and a real GPU, the displayed canvas compared byte for byte.
 *
 *   bun tools/plane-ortho-check.mjs --before http://127.0.0.1:5181/ --after http://127.0.0.1:5182/
 *                                   --relay 8099 --dir /abs/dir [--width W --height H] [--shots DIR]
 *
 * --before / --after: two Vites serving a build without the PlaneCamera and one with it (scratch
 * worktrees: HEAD, and HEAD + the change). Both dial one PRIVATE relay (--no-gomuxai) whose root is
 * --dir, a git repo (the relay's fs/gitLog reads its root), so its first file has revisions to stand
 * as layers; session off, the minimap off (it draws the eye, which the endpoints put elsewhere).
 *
 * The A/B is IN PLACE: entered once, then `plane.enter carrel:<desk>` again is a switch — a cut to
 * that desk's endpoint at the same opening aim — with plane.ortho flipped between (and back, which
 * must reproduce the first frame exactly: the sanity check).
 *
 *   1. BEFORE vs AFTER, plane.ortho off — the open world at fit-all, and a plane desk (four files)
 *      entered: the camera (pose + projection) bit-identical and 0 px of the scene may differ (the
 *      view camera is a PlaneCamera at λ = 1: three's own matrix). Entered, the scene is compared
 *      without the overlay pass: the overlay's map labels latch a position with hysteresis while the
 *      camera eases, so where a tab rests can move a pixel with frame timing alone (the same build
 *      against itself shows it); the frame with the overlay is reported, not gated.
 *   2. AFTER, the same desk entered with plane.ortho ON vs OFF: the flat plane, px that differ —
 *      0 is the bar for the endpoint to be on by default.
 *   3. AFTER, with the first file's revisions shown as layers (layer.show): ortho ON vs OFF — the
 *      perspective endpoint's layers drift by its parallax (under a px per layer near the centre,
 *      more at the edges); the orthographic one's stand 1:1. Reported, not gated.
 *   4. Teeth: ortho on, `plane.fan 4` — the fanned frame must differ from the unfanned one (the
 *      comparison sees the layers).
 *   5. Picking at λ = 0 (and fanned): `pick.at` at each member's projected centre names that member.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { decodePng, writePng } from './lib/pixel-metrics.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BEFORE = arg('--before'), AFTER = arg('--after');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
const SHOTS = arg('--shots');
if (!BEFORE || !AFTER || !DIR) { console.error('usage: --before URL --after URL --relay PORT --dir /abs/dir'); process.exit(2); }

const SETTLE = 4500;   // eases, card captures and far-LOD settle well inside this

/** Pixels (RGBA, decoded) that differ between two canvas PNGs. */
/** Run a verb in the page: its whole reply ({text, data}). */
const run = (app, verb) => app.evalPage(async (v) => {
    const r = await window.__glyphClient.router.execute(v);
    return { text: r?.text ?? null, data: r?.data ?? null };
}, verb);

const differ = (pa, pb) => {
    const a = decodePng(pa), b = decodePng(pb);
    if (a.width !== b.width || a.height !== b.height) return a.width * a.height;
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) n++;
    }
    return n;
};

/** Open a page on `url`; load the dir; return the page, its canvas, the files and a shot helper. */
async function open(browser, url) {
    const app = await openApp(browser, { url, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: W, height: H }, settings: { 'plane.ortho': false, 'view.minimap': false } });
    if (!app.booted) throw new Error(`${url}: the app did not boot`);
    const canvas = app.page.locator('canvas').first();
    await app.cmd(`file.openDir ${DIR}`);
    await app.waitFor(6000);
    const ids = await app.evalPage(() => window.__glyphClient.ctx.registry.findByType('grid').map((e) => e.id).sort().slice(0, 4));
    const shot = async () => canvas.screenshot();
    return { app, canvas, ids, shot };
}

/** Make the desk, seat the files, enter it. */
async function desk(p) {
    await p.app.cmd('carrel.create orthocheck');
    for (const id of p.ids) await p.app.cmd(`carrel.add ${id} orthocheck`);
    await p.app.waitFor(2500);
}
async function enter(p) { await p.app.cmd('carrel.enter orthocheck'); await p.app.waitFor(SETTLE); }
/**
 * Re-enter the entered desk with plane.ortho `on`: a switch — a cut to its endpoint, the same aim —
 * then, with `down`, pan the view that many device px down (the layers rise ABOVE their member, so
 * at the opening aim, the member's top at the view's top, they'd be off screen).
 */
async function recut(p, on, down = 0) {
    await p.app.cmd(`settings.set plane.ortho ${on}`);
    await run(p.app, 'plane.enter carrel:orthocheck');
    if (down) {
        const st = (await run(p.app, 'plane.state')).data;
        await run(p.app, `plane.aim ${st.aim.x} ${st.aim.y + down / st.pxPerUnit}`);
    }
    await p.app.waitFor(2500);
}

const browser = await launchGpuBrowser({});
let failed = 0;
const report = (good, line) => { if (!good) failed++; console.log(`${good ? '✓' : '✗'} ${line}`); };
const save = (name, png) => { if (SHOTS) writePng(`${SHOTS}/${name}.png`, decodePng(png)); };
try {
    // ── 1. before vs after, ortho off ──
    const shots = {};
    for (const [name, url] of [['before', BEFORE], ['after', AFTER]]) {
        const p = await open(browser, url);
        await p.app.cmd('camera.fitall');
        await p.app.waitFor(SETTLE);
        shots[`${name}:world`] = await p.shot();
        await desk(p);
        await enter(p);
        shots[`${name}:entered+overlay`] = await p.shot();
        shots[`${name}:camera`] = await p.app.evalPage(() => { const c = window.__glyphClient.ctx.camera; return [...c.position.toArray(), ...c.quaternion.toArray(), ...c.projectionMatrix.elements]; });
        await p.app.evalPage(() => { const rp = window.__glyphClient.ctx.renderPasses; window.__overlayPass = rp.passes.find((x) => x.name === 'overlay'); if (window.__overlayPass) rp.remove('overlay'); });
        await p.app.waitFor(800);
        shots[`${name}:entered`] = await p.shot();
        await p.app.evalPage(() => { const e = window.__overlayPass; if (e) window.__glyphClient.ctx.renderPasses.add(e.name, e.order, e.fn); });
        await p.app.waitFor(500);
        if (name === 'before') {
            if (p.app.errors.length) { failed++; console.log('before page errors:', JSON.stringify(p.app.errors.slice(0, 3))); }
            await p.app.page.close();
            continue;
        }
        // ── 2. after: ortho on vs off, the flat plane ──
        const loaded = p.ids.length;
        if (!loaded) report(false, 'VACUOUS: the after build loaded no files');
        await recut(p, false);
        const persp = await p.shot();
        await recut(p, true);
        const st = (await run(p.app, 'plane.state')).data;
        report(st?.ortho === true && st?.camera?.blend === 0, `entered orthographic (λ ${st?.camera?.blend}, d₀ ${st?.camera?.planeDepth?.toFixed(3)}, ${st?.pxPerUnit?.toFixed(4)} px/unit)`);
        const ortho = await p.shot();
        await recut(p, false);
        const persp2 = await p.shot();
        report(differ(persp, persp2) === 0, `sanity: re-cutting to the perspective endpoint reproduces its frame (${differ(persp, persp2)} px)`);
        const flatDiff = differ(persp, ortho);
        console.log(`${flatDiff ? '•' : '✓'} the flat plane, orthographic vs the 1° perspective: ${flatDiff} px differ`);
        save('flat-perspective', persp); save('flat-ortho', ortho);
        await recut(p, true);

        // ── 5. picking at λ = 0 ──
        const pickAll = async (what) => {
            const pts = await p.app.evalPage((ids) => {
                const ctx = window.__glyphClient.ctx;
                const rect = ctx.renderer.domElement.getBoundingClientRect();
                return ids.map((id) => {
                    const g = ctx.registry.get(id)?.grid;
                    if (!g) return null;
                    g.updateWorldMatrix(true, false);
                    const b = g.getBounds();
                    // The member's projected box, clipped to the canvas (less the dock's left
                    // third and a margin): the centre of what of it is on screen.
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
                        const v = b.min.clone().set(cx, cy, cz).project(ctx.camera);
                        const x = (v.x + 1) / 2 * rect.width, y = (1 - v.y) / 2 * rect.height;
                        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                    }
                    x0 = Math.max(x0 + 20, rect.width * 0.25); y0 = Math.max(y0 + 60, 60); x1 = Math.min(x1 - 20, rect.width - 20); y1 = Math.min(y1 - 20, rect.height * 0.6);
                    if (!(x1 > x0 && y1 > y0)) return null;
                    return { id, x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
                }).filter(Boolean);
            }, p.ids);
            let good = 0;
            for (const q of pts) {
                const r = await run(p.app, `pick.at ${q.x} ${q.y}`);
                const s = await run(p.app, `scene.at ${q.x} ${q.y}`);
                // scene.at's hits are the meshes; their chains name the member they belong to.
                const name = q.id.split('/').pop();
                const sceneHit = (s.data?.hits ?? []).some((h) => h.id === q.id || String(h.chain).includes(name));
                if (r.data?.id === q.id && sceneHit) good++;
                else console.log(`   ${what}: (${q.x}, ${q.y}) expected ${q.id}: pick.at → ${r.data?.id}, scene.at → ${(s.data?.hits ?? []).slice(0, 3).map((h) => h.chain).join(' | ') || 'none'}`);
            }
            report(pts.length > 0 && good === pts.length, `${what}: pick.at and scene.at name the member at its projected centre (${good}/${pts.length})`);
        };
        await pickAll('picking at λ = 0');

        // ── 3. layers: ortho vs perspective ──
        const first = p.ids[0];
        const ls = await p.app.cmd(`layer.show ${first}`);
        await p.app.waitFor(2500);
        console.log(`  ${ls.text?.split('\n')[0]}`);
        await recut(p, true, 200);
        const orthoLayers = await p.shot();
        await recut(p, false, 200);
        const perspLayers = await p.shot();
        const layerDiff = differ(perspLayers, orthoLayers);
        console.log(`• with layers shown, orthographic vs the 1° perspective: ${layerDiff} px differ (the perspective's layers drift; the orthographic's stand 1:1)`);
        save('layers-perspective', perspLayers); save('layers-ortho', orthoLayers);

        // ── 4. teeth: the fan ──
        await recut(p, true, 200);
        const unfanned = await p.shot();
        const fan = await p.app.cmd('plane.fan 4');
        console.log(`  ${fan.text}`);
        await p.app.waitFor(1500);
        const fanned = await p.shot();
        const fanDiff = differ(unfanned, fanned);
        report(fanDiff > 0, `teeth: plane.fan 4 changes the frame (${fanDiff} px) — the comparison sees the layers`);
        save('fanned', fanned);
        await pickAll('picking at λ = 0, fanned');
        await p.app.cmd('plane.fan off');
        await p.app.waitFor(1500);
        const folded = await p.shot();
        report(differ(unfanned, folded) === 0, `plane.fan off folds back to the unfanned frame exactly (${differ(unfanned, folded)} px)`);
        await p.app.cmd('layer.hide ' + first);
        await p.app.cmd('carrel.leave');
        await p.app.cmd('settings.set plane.ortho false');
        if (p.app.errors.length) { failed++; console.log('after page errors:', JSON.stringify(p.app.errors.slice(0, 3))); }
    }
    const camA = shots['before:camera'], camB = shots['after:camera'];
    report(camA.length === camB.length && camA.every((v, i) => v === camB[i]), 'entered: before vs after (plane.ortho off), the camera pose and projection bit-identical');
    for (const k of ['world', 'entered']) {
        const d = differ(shots[`before:${k}`], shots[`after:${k}`]);
        report(d === 0, `${k}: before vs after (plane.ortho off), ${d} px of the displayed canvas differ${k === 'entered' ? ' (the scene, no overlay)' : ''}`);
        save(`${k}-before`, shots[`before:${k}`]); save(`${k}-after`, shots[`after:${k}`]);
    }
    console.log(`  (with the overlay: ${differ(shots['before:entered+overlay'], shots['after:entered+overlay'])} px — its labels' hysteresis, timing)`);
} finally {
    await browser.close();
}
console.log(failed ? `FAIL plane-ortho-check: ${failed} failing` : 'ok plane-ortho-check');
process.exit(failed ? 1 : 0);
