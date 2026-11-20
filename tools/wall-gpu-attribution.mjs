/**
 * wall-gpu-attribution.mjs — where the wall's GPU frame goes, by toggling one layer at a time at a
 * fixed camera state and timing the main render pass with EXT_disjoint_timer_query_webgl2.
 *
 *   bun tools/wall-gpu-attribution.mjs [--url http://localhost:5180/] [--relay 8099] [--reuse-relay]
 *                                      [--terminals 14] [--width 3024 --height 1964] [--frames 120]
 *                                      [--fill 'cmd']   (what each terminal runs to fill its screen;
 *                                                        default `ls -la /usr/bin | head -60`. For cell
 *                                                        fills and styles: --fill 'sh tools/term-test-pattern.sh')
 *
 * Needs the wall's Vite and a built glyph3d-cli. Starts its own PRIVATE relay on --relay
 * (tools/lib/wall-relay.mjs: termd namespace `glyph-wall-gpu`, no gomuxai; stopped with its termd daemon at the
 * end) and refuses a port something already listens on, unless --reuse-relay names a relay you
 * started. Spawns --terminals of its own and fills only those with text (a reused relay's other
 * terminals are drawn, never typed into); kills them at the end. Launches a real-GPU browser
 * (headed on macOS — a window opens) and refuses a software GL renderer.
 *
 * States: OVERVIEW (fit all) and FRAMED (one text-filled terminal fills the view). Variants per
 * state: all layers · glyph fields hidden · panels hidden · scrollback depth-history off. The
 * camera state is logged beside every row (zoom, framed id) so a mis-set-up row is visible.
 * GPU time is per main render pass, one pass per frame here (the wall has no second pass).
 */
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay, spawnOwnTerminals } from './lib/wall-relay.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));   // a PRIVATE relay — never the one a person's display is on
const TERMINALS = Number(arg('--terminals', 14));
const W = Number(arg('--width', 3024)), H = Number(arg('--height', 1964));
const FRAMES = Number(arg('--frames', 120));
const FILL = arg('--fill', 'ls -la /usr/bin | head -60');
const OUT = arg('--json');
const rows = [];

const relay = await privateRelay({ port: RELAY, ns: 'glyph-wall-gpu', reuse: process.argv.includes('--reuse-relay') });
let browser = null;
let app = null;
/** The terminals this tool spawned — the only ones it types into. */
const own = [];
try {
    browser = await launchGpuBrowser({});
    app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 4000, viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('wall did not boot');
    const up = await app.evalPage(async () => {
        for (let i = 0; i < 60 && !window.__wall.snapshot().connected; i++) await new Promise((r) => setTimeout(r, 250));
        return window.__wall.snapshot().relay;
    });
    if (up.state !== 'up') throw new Error(`the wall isn't the relay's display on :${RELAY} (${up.state}${up.reason ? `: ${up.reason}` : ''})`);
    own.push(...await spawnOwnTerminals(app.evalPage, TERMINALS));
    console.log(`[wall] spawned ${own.length} terminals of its own: ${own.join(' ')}`);
    const gpu = await app.evalPage(() => {
        const gl = window.__glyphClient.ctx.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                 canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight], timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2') };
    });
    console.log(`[gpu] ${gpu.renderer} · canvas ${gpu.canvas.join('×')} · timer=${gpu.timer}`);
    if (/swiftshader|llvmpipe|software/i.test(gpu.renderer)) throw new Error('software renderer — numbers would be fiction');
    if (!gpu.timer) throw new Error('no EXT_disjoint_timer_query_webgl2 — cannot time the GPU');

    // Fill this tool's terminals with text so glyph cost is real, then settle.
    const n = await app.evalPage(async ([ids, fill]) => {
        const w = window.__wall;
        window.__gpuOwn = ids;
        for (const id of ids) w.terminal(id).sendInput(`clear; ${fill}\r`);
        await new Promise((r) => setTimeout(r, 2500));
        return w.order.length;
    }, [own, FILL]);
    console.log(`[wall] ${n} terminals on the wall (${own.length} of them this tool's), each filled by: ${FILL}`);

    // Install the timer + layer toggles once.
    await app.evalPage(() => {
        const r = window.__glyphClient.ctx.renderer;
        const gl = r.getContext();
        const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const orig = r.render.bind(r);
        const st = window.__gpuAttr = { samples: [], pending: [], on: false };
        r.render = (scene, cam) => {
            let q = null;
            if (st.on && st.pending.length < 8) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
            orig(scene, cam);
            if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); st.pending.push(q); }
            for (let i = st.pending.length - 1; i >= 0; i--) {
                const p = st.pending[i];
                if (gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) {
                    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) st.samples.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
                    gl.deleteQuery(p); st.pending.splice(i, 1);
                }
            }
        };
        const grids = () => [...window.__wall.ctx.terminals.values()];
        window.__layers = {
            glyphs: (on) => grids().forEach((g) => g.getRenderer()?.setVisible(on)),
            panels: (on) => grids().forEach((g) => { if (g._background) g._background.visible = on; }),
            depth: (on) => grids().forEach((g) => g.setDepthHistory(on)),
        };
    });

    const measure = async (label, setup, setupArg) => {
        const state = await app.evalPage(setup, setupArg);
        await app.waitFor(700);   // let the camera ease and the variant settle
        const r = await app.evalPage(async (frames) => {
            const st = window.__gpuAttr;
            st.samples.length = 0; st.on = true;
            await new Promise((res) => { const tick = () => (st.samples.length >= frames ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); });
            st.on = false;
            const s = [...st.samples].sort((a, b) => a - b);
            const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
            const w = window.__wall;
            return { p50: q(0.5), p95: q(0.95), n: s.length, zoom: +w.viewport.zoom.toFixed(2), framed: w.focusedId, draws: window.__glyphClient.ctx.renderer.info.render.calls };
        }, FRAMES);
        rows.push({ label, ...r, state });
        console.log(`${label.padEnd(34)} gpu p50 ${String(r.p50).padStart(6)} ms  p95 ${String(r.p95).padStart(6)} ms  ${String(r.draws).padStart(3)} draws  (n=${r.n}, zoom ${r.zoom}, focus ${r.framed ?? '-'}) ${state ? JSON.stringify(state) : ''}`);
    };
    const restore = () => { window.__layers.glyphs(true); window.__layers.panels(true); window.__layers.depth(true); };

    // Laps: on a FRESH page, ⌘] through every terminal twice. Lap 1 frames each terminal for the
    // first time; lap 2 repeats the same moves. A lap-1-only cost is a one-time warm-up, not a
    // per-frame one. Runs first, before anything else has framed a terminal.
    if (process.argv.includes('--laps')) {
        await app.evalPage(() => { const w = window.__wall; w.focus(null); w.fitAll(); });
        await app.waitFor(1200);
        const nT = await app.evalPage(() => window.__wall.order.length);
        const variants = [
            ['all layers', () => {}],
            ['glyphs hidden', () => window.__layers.glyphs(false)],
            ['panels hidden', () => window.__layers.panels(false)],
            ['depth-history off', () => window.__layers.depth(false)],
            ['all layers again', () => {}],
        ];
        for (const [lap, setup] of variants) {
            await app.evalPage(() => { window.__layers.glyphs(true); window.__layers.panels(true); window.__layers.depth(true); const w = window.__wall; w.focus(null); w.fitAll(); });
            await app.waitFor(1000);
            await app.evalPage(setup);
            const r = await app.evalPage(async (count) => {
                const w = window.__wall; const st = window.__gpuAttr;
                st.samples.length = 0; st.on = true;
                const gaps = []; let last = performance.now(), on = true;
                const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; if (on) requestAnimationFrame(tick); };
                requestAnimationFrame(tick);
                for (let i = 0; i < count; i++) { w.cycleFocus(1); await new Promise((res) => setTimeout(res, 700)); }
                on = false; st.on = false;
                const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
                return { g50: pct(st.samples, 0.5), g95: pct(st.samples, 0.95), gmax: pct(st.samples, 1), f95: pct(gaps, 0.95), fmax: pct(gaps, 1), over: gaps.filter((x) => x > 20).length, n: gaps.length };
            }, nT);
            rows.push({ label: `LAP ${lap}`, terminals: nT, ...r });
            console.log(`LAP ${lap.padEnd(20)} (${nT})  gpu p50 ${r.g50} p95 ${r.g95} max ${r.gmax} ms | frame gap p95 ${r.f95} max ${r.fmax} ms, ${r.over}/${r.n} frames >20ms`);
        }
    }

    if (!process.argv.includes('--motion') && !process.argv.includes('--laps')) for (const [where, place] of [
        ['OVERVIEW', () => { window.__wall.focus(null); window.__wall.fitAll(); }],
        ['FRAMED', () => { const w = window.__wall; const id = window.__gpuOwn[0]; w.focus(id); w.frame(id); }],
    ]) {
        await app.evalPage(place);
        await app.waitFor(1200);
        await measure(`${where} all layers`, restore);
        await measure(`${where} glyphs hidden`, () => { window.__layers.glyphs(false); });
        await app.evalPage(restore);
        await measure(`${where} panels hidden`, () => { window.__layers.panels(false); });
        await app.evalPage(restore);
        await measure(`${where} depth-history off`, () => { window.__layers.depth(false); });
        await app.evalPage(restore);
        await measure(`${where} glyphs+panels hidden`, () => { window.__layers.glyphs(false); window.__layers.panels(false); });
        await app.evalPage(restore);
    }
    // Zoom sweep about the wall's centre, all layers: the in-between zooms a framing animation
    // passes through, where many terminals are on screen AND their glyphs are above greek size.
    if (process.argv.includes('--sweep')) {
        const fit = await app.evalPage(() => { const w = window.__wall; w.focus(null); w.fitAll(); return w.viewport.target; });
        await app.waitFor(1200);
        for (const mult of [1, 1.5, 2, 2.5, 3, 4, 6]) {
            await measure(`SWEEP zoom ×${mult} of fit`, (m) => {
                const w = window.__wall; const c = w.viewport.camera;
                w.viewport.target = null; c.zoom = m.z; c.position.x = m.x; c.position.y = m.y; c.updateProjectionMatrix();
                const px = (1 / c.zoom);   // world units per CSS px
                let onScreen = 0;
                const vw = w.viewport.view.w * px / 2, vh = w.viewport.view.h * px / 2;
                for (const g of w.ctx.terminals.values()) {
                    const b = g.getBounds();
                    if (b.max.x > m.x - vw && b.min.x < m.x + vw && b.max.y > m.y - vh && b.min.y < m.y + vh) onScreen++;
                }
                return { onScreen };
            }, { ...fit, z: fit.zoom * mult });
        }
    }
    // Motion: which KIND of change produces the spikes — camera pan alone, zoom alone, focus
    // changes alone (no camera), or the full cycle (focus + framing ease). Max matters here.
    if (process.argv.includes('--motion')) {
        const fit = await app.evalPage(() => { const w = window.__wall; w.focus(null); w.fitAll(); return w.viewport.target; });
        await app.waitFor(1200);
        const run = async (label, start) => {
            await app.evalPage(start, fit);
            const r = await app.evalPage(async (frames) => {
                const st = window.__gpuAttr;
                st.samples.length = 0; st.on = true;
                const gaps = []; let last = performance.now();
                await new Promise((res) => { const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; (st.samples.length >= frames ? res() : requestAnimationFrame(tick)); }; requestAnimationFrame(tick); });
                st.on = false;
                clearInterval(window.__motion); cancelAnimationFrame(window.__motionRaf); window.__motionStop = true;
                const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
                return { g50: pct(st.samples, 0.5), g95: pct(st.samples, 0.95), gmax: pct(st.samples, 1), f95: pct(gaps, 0.95), fmax: pct(gaps, 1), over: gaps.filter((x) => x > 20).length, n: gaps.length };
            }, 240);
            rows.push({ label, ...r });
            console.log(`${label.padEnd(30)} gpu p50 ${r.g50} p95 ${r.g95} max ${r.gmax} ms | frame gap p95 ${r.f95} max ${r.fmax} ms, ${r.over}/${r.n} frames >20ms`);
            await app.evalPage(() => { window.__motionStop = false; const w = window.__wall; w.focus(null); w.fitAll(); });
            await app.waitFor(1000);
        };
        await run('MOTION none (control)', () => {});
        await run('MOTION pan only', (f) => {
            const w = window.__wall; const c = w.viewport.camera; w.viewport.target = null; c.zoom = f.zoom * 2.5; c.updateProjectionMatrix();
            let t = 0; const step = () => { if (window.__motionStop) return; t += 1 / 60; c.position.x = f.x + Math.sin(t * 1.5) * 60; c.position.y = f.y; window.__motionRaf = requestAnimationFrame(step); }; step();
        });
        await run('MOTION zoom only', (f) => {
            const w = window.__wall; const c = w.viewport.camera; w.viewport.target = null; c.position.x = f.x; c.position.y = f.y;
            let t = 0; const step = () => { if (window.__motionStop) return; t += 1 / 60; c.zoom = f.zoom * (1 + 2.5 * (0.5 + 0.5 * Math.sin(t * 1.5))); c.updateProjectionMatrix(); window.__motionRaf = requestAnimationFrame(step); }; step();
        });
        await run('MOTION focus changes only', () => {
            const w = window.__wall; let i = 0; window.__motion = setInterval(() => { w.focus(w.order[i++ % w.order.length]); }, 300);
        });
        await run('MOTION full cycle (⌘])', () => {
            const w = window.__wall; window.__motion = setInterval(() => w.cycleFocus(1), 700);
        });
    }
    if (app.errors.length) console.log('[page errors]', app.errors.slice(0, 5));
    if (OUT) (await import('node:fs')).writeFileSync(OUT, JSON.stringify({ gpu, terminals: n, argv: process.argv.slice(2), rows, errors: app.errors.slice(0, 5) }, null, 2));
} finally {
    if (app && own.length) {
        for (const id of own) await app.evalPage((i) => window.__wall.kill(i), id).catch(() => {});
        await app.waitFor(1000).catch(() => {});
    }
    await browser?.close();
    await relay.stop();
}
