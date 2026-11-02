/**
 * pick-flat-root-check.mjs — do the pick channels' flat lists (PickingSystem.flatLists,
 * collections/FlatRenderRoot.js) pick exactly what three's walk of the scene picks, on the GPU — and
 * what does a pick's render cost each way?
 *
 * At each scene it sweeps a grid of pointer positions over the canvas, plus the projected center of
 * registered meshes on screen (up to 40 per channel), and picks every channel
 * (grid, handle, group, glyph) twice per position — flat lists on, then off — and requires every
 * hit to be the same: the same token and slot, or both empty. Teeth: with every mesh the sweep hit
 * dropped from the lists, hits must differ. It counts what was hit (glyphs, panels — batched ones apart —,
 * handles, volumes, frame glyphs) so an empty sweep can't pass, the lists' rebuilds over the sweep
 * (0 wanted at rest: the pick camera's per-pass layers and the panel cut move nothing), and the
 * pick's render CPU (PickingSystem's lastRenderMs, every channel's pass) as interleaved medians.
 *
 *   bun tools/pick-flat-root-check.mjs --url http://localhost:5173/ --relay 8099 [--dir /abs/dir]
 *                                      [--cols 16 --rows 10] [--setting k=v]… [--hub]
 *
 * --dir: a private relay (--no-gomuxai, its own --tmux-socket) serving a scratch root holding it — a
 * test pattern frame and a terminal (spawned on the relay's socket), fit-all, close up, the library
 * layout, a plane view. --hub: a private relay with gomuxai on (seed
 * --setting gomux.autoScreens=false — never screens on a second relay) — the hub as it loads.
 * Exits 1 on any differing hit, a vacuous sweep, teeth that don't bite, a rebuild at rest, page errors.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const HUB = process.argv.includes('--hub');
const COLS = Number(arg('--cols', 16)), ROWS = Number(arg('--rows', 10));
const SETTINGS = Object.fromEntries(process.argv.flatMap((a, i) => (a === '--setting' ? [process.argv[i + 1]] : [])).map((kv) => {
    const [k, ...v] = kv.split('='); const raw = v.join('=');
    return [k, raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw];
}));
if (!DIR && !HUB) { console.error('usage: --dir /abs/dir (a --no-gomuxai relay) or --hub (gomuxai on, screens off)'); process.exit(2); }

/** Page-side: the sweep. */
async function sweep({ cols, rows }) {
    const c = window.__glyphClient.ctx, ps = c.pickingSystem, cam = c.camera, scene = c.scene;
    const CH = ['grid', 'handle', 'group', 'glyph'];
    const size = c.renderer.getSize(cam.position.clone().set(0, 0, 0));
    const W = size.x, H = size.y;
    const same = (a, b) => (a === null && b === null) || (a && b && a.token === b.token && a.slotIndex === b.slotIndex);
    const entryOf = (ch, hit) => ps._channel(ch).entries.find((e) => e.token === hit.token && hit.slotIndex < e.endId - e.startId);
    const rebuilds = () => [...ps.flatRoots.values()].reduce((n, r) => n + r.stats.rebuilds, 0);
    const counts = { positions: 0, differ: 0, hits: { grid: 0, gridBatched: 0, handle: 0, group: 0, glyph: 0, frameGlyph: 0 } };
    const ms = { flat: [], full: [] };
    const examples = [];
    const hitMeshes = new Set();   // what the full sweep hit: the teeth drop exactly these
    // The positions: a grid over the canvas, plus the projected center of up to 40 registered meshes
    // per channel that are on screen (so handles, volumes, frame glyphs are hit on purpose).
    const pts = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) pts.push([(i + 0.5) * W / cols, (j + 0.5) * H / rows]);
    const v = cam.position.clone();
    for (const ch of CH) {
        let n = 0;
        for (const e of ps._channel(ch).entries) {
            if (n >= 40) break;
            if (!e.mesh?.geometry) continue;
            if (!e.mesh.geometry.boundingSphere) e.mesh.geometry.computeBoundingSphere();
            v.copy(e.mesh.geometry.boundingSphere.center).applyMatrix4(e.mesh.matrixWorld).project(cam);
            if (!(Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z > -1 && v.z < 1)) continue;
            pts.push([(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]);
            n++;
        }
    }
    ps.flatLists = true;
    await ps.pick(CH, cam, scene, W / 2, H / 2);   // build the lists once
    const r0 = rebuilds();
    {
        for (const [x, y] of pts) {
            ps.flatLists = true;
            const f = await ps.pick(CH, cam, scene, x, y); ms.flat.push(ps._lastRenderMs);
            ps.flatLists = false;
            const g = await ps.pick(CH, cam, scene, x, y); ms.full.push(ps._lastRenderMs);
            ps.flatLists = true;
            counts.positions++;
            for (const ch of CH) {
                if (!same(f[ch], g[ch])) { counts.differ++; if (examples.length < 5) examples.push({ x, y, ch, flat: f[ch] && `${f[ch].slotIndex}`, full: g[ch] && `${g[ch].slotIndex}` }); }
                if (!g[ch]) continue;
                counts.hits[ch]++;
                const e = entryOf(ch, g[ch]);
                if (e) hitMeshes.add(e.mesh);
                if (ch === 'grid' && e && !e.mesh.layers.isEnabled(0)) counts.hits.gridBatched++;
                if (ch === 'glyph' && (e?.mesh?.userData?.glyphField?.isFrame || e?.token?.isFrame)) counts.hits.frameGlyph++;
            }
        }
    }
    const rest = rebuilds() - r0;
    // Teeth: every mesh the full sweep hit dropped from the lists (the key doesn't move, so the cut
    // lists stand for the sweep) — every position that hit something must now pick otherwise.
    const saved = [...ps.flatRoots].map(([, r]) => [r, r.root.children]);
    for (const [r, list] of saved) r.root.children = list.filter((o) => !hitMeshes.has(o));
    let teeth = 0;
    for (const [x, y] of pts) {
        const f = await ps.pick(CH, cam, scene, x, y);
        ps.flatLists = false;
        const g = await ps.pick(CH, cam, scene, x, y);
        ps.flatLists = true;
        for (const ch of CH) if (!same(f[ch], g[ch])) teeth++;
    }
    for (const [r, list] of saved) r.root.children = list;
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const lists = Object.fromEntries([...ps.flatRoots].map(([ch, r]) => [ch, r.root.children.length]));
    return { ...counts, examples, rest, teeth, lists, ms: { flat: med(ms.flat), full: med(ms.full) }, refused: [...ps.flatRoots].filter(([, r]) => r.refused).map(([n, r]) => `${n}: ${r.refused.reason}: ${r.refused.object}`) };
}

const browser = await launchGpuBrowser({});
let failed = 0;
const report = (name, r) => {
    const h = r.hits;
    const vacuous = h.grid + h.glyph + h.group + h.handle === 0;
    const bad = r.differ !== 0 || r.teeth === 0 || r.rest !== 0 || vacuous || r.refused.length;
    if (bad) failed++;
    console.log(`${bad ? '✗' : '✓'} ${name}: ${r.positions} positions (a ${COLS}×${ROWS} grid + registered meshes' centers) × 4 channels · ${r.differ} hits differ flat vs full · teeth (hit meshes dropped) ${r.teeth} differ`
        + ` · hits: glyph ${h.glyph} (frame ${h.frameGlyph}) · panel ${h.grid} (batched ${h.gridBatched}) · handle ${h.handle} · volume ${h.group}`
        + `\n    lists ${JSON.stringify(r.lists)} · ${r.rest} rebuilds over the sweep · pick render CPU ${r.ms.full.toFixed(2)} → ${r.ms.flat.toFixed(2)} ms`
        + (r.refused.length ? ` · REFUSED ${r.refused.join('; ')}` : '') + (vacuous ? ' · VACUOUS' : '')
        + (r.examples.length ? `\n    e.g. ${JSON.stringify(r.examples)}` : ''));
};
const run = async (app, name) => report(name, await app.evalPage(sweep, { cols: COLS, rows: ROWS }));
try {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: 1600, height: 1000 }, settings: SETTINGS });
    if (!app.booted) throw new Error('app did not boot');
    if (HUB) {
        await app.waitFor(15000);   // the hub's tree, books and desks
        await run(app, 'hub, as loaded');
        await app.cmd('camera.fitall');
        await app.waitFor(3000);
        await run(app, 'hub, fit-all');
    } else {
        console.log(`[load] ${((await app.cmd(`file.openDir ${DIR}`)).text ?? '').slice(0, 90)}`);
        await app.waitFor(6000);
        console.log(`[cmd] ${((await app.cmd('frame.pattern 96x54 pickpattern')).text ?? '').slice(0, 80)}`);
        console.log(`[cmd] ${((await app.cmd('terminal.spawn 80 24')).text ?? '').slice(0, 80)}`);   // its resize grips are the handles
        await app.waitFor(4000);
        await app.cmd('camera.fitall');
        await app.waitFor(3500);
        await run(app, 'fit-all');
        const id = await app.evalPage(() => window.__glyphClient.ctx.registry.toArray('grid').find((g) => g?.id)?.id ?? null);
        await app.cmd(`camera.focus ${id}`);
        await app.waitFor(3000);
        await run(app, `close on grid ${id}`);
        const fid = await app.evalPage(() => window.__glyphClient.ctx.registry.findByType('frame')[0]?.id ?? null);
        if (fid != null) {
            for (const v of [`dock.release ${fid}`, `camera.focus ${fid}`]) console.log(`[cmd] ${v} → ${((await app.cmd(v)).text ?? '').slice(0, 80)}`);
            await app.waitFor(3000);
            await run(app, `close on frame ${fid}`);
        }
        console.log(`[cmd] ${((await app.cmd('layout.scheme library')).text ?? '').slice(0, 70)}`);
        await app.waitFor(4000);
        await app.cmd('camera.fitall');
        await app.waitFor(3500);
        await run(app, 'library, fit-all');
        console.log(`[cmd] ${((await app.cmd(`plane.enter ${id}`)).text ?? '').split('\n')[0].slice(0, 80)}`);
        await app.waitFor(2500);
        await run(app, `library, plane view on ${id}`);
        await app.cmd('plane.leave');
        await app.waitFor(1500);
    }
    const v = await app.cmd('scene.render');
    const stale = !/OK: every list matches a fresh walk/.test(v.text ?? '');
    if (stale) failed++;
    console.log(`${stale ? '✗' : '✓'} scene.render:\n${(v.text ?? '').split('\n').filter((l) => /pick |OK|FAIL/.test(l)).join('\n')}`);
    if (app.errors.length) { console.log('page errors:', JSON.stringify(app.errors.slice(0, 3))); failed++; }
} finally {
    await browser.close();
}
console.log(failed ? `FAIL pick-flat-root-check: ${failed} failing` : 'ok pick-flat-root-check');
process.exit(failed ? 1 : 0);
