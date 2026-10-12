/**
 * frame-profile.mjs — where a steady-state frame goes, on the WebGL2 renderer.
 *
 * Three passes, so instrumentation never skews the timings it reports:
 *   1. TIMING  — frame gaps (p50/p95/worst), main-thread rAF work per frame split into
 *                three's renderer.render vs everything else (r3f loop, our useFrame
 *                callbacks), and GPU time per frame (EXT_disjoint_timer_query_webgl2).
 *   2. CENSUS  — draw calls per frame by program, GL calls per frame by name, bytes
 *                uploaded per frame (buffer + texture), renderer.info, scene census
 *                (meshes, visible, instanced fields, live instances).
 *   3. PROFILE — a CDP sampling CPU profile, self time bucketed (three.js / our core /
 *                app / react / other) with the top functions.
 *
 *   bun tools/frame-profile.mjs [--dir ABS] [--relay 8099] [--url URL] [--ms 3000]
 *                               [--uncapped] [--width W --height H] [--top N] [--json OUT]
 *                               [--callers FN[,FN…]]   (who calls FN: self time by caller chain)
 *                               [--cmd 'verb args']…   (after the load + fit, before measuring)
 *                               [--eval 'js']          (page setup after --cmd, e.g. an A/B toggle)
 *                               [--hitch MS]           (frames longer than MS: what ran in them; default 25)
 *
 * Needs Vite (:5173) and a PRIVATE relay serving a root you don't mind (session=off keeps
 * the page from autosaving, but the relay's root is where a save would land):
 *   glyph3d-cli serve --listen 127.0.0.1 --port 8099 /some/scratch/root
 * --dir must sit inside that relay's root (file.openDir is relay-rooted).
 *
 * --uncapped disables vsync so the frame floor is visible below 16.6ms.
 * Refuses to report from a SOFTWARE GL renderer (SwiftShader / llvmpipe) unless
 * GLYPH_ALLOW_SOFTWARE=1.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { writeFileSync } from 'node:fs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const URL = arg('--url', 'http://localhost:5173/');
const RELAY = Number(arg('--relay', 8099));
const DIR = arg('--dir');
const MS = Number(arg('--ms', 3000));
const TOP = Number(arg('--top', 18));
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
const OUT = arg('--json');
const CALLERS = (arg('--callers') ?? '').split(',').filter(Boolean);
const CMDS = process.argv.flatMap((a, i) => (a === '--cmd' ? [process.argv[i + 1]] : []));
const EVAL = arg('--eval');
const HITCH = Number(arg('--hitch', 25));

const browser = await launchGpuBrowser({
    extraArgs: has('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [],
});
const result = {};
try {
    const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 6000, session: 'off', viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('app did not boot');

    const gpu = await app.evalPage(() => {
        const r = window.__glyphClient.ctx.renderer;
        const gl = r.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return {
            renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
            dpr: window.devicePixelRatio, pixelRatio: r.getPixelRatio(),
            canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
            multiDraw: !!gl.getExtension('WEBGL_multi_draw'),
            glMethods: Object.getOwnPropertyNames(WebGL2RenderingContext.prototype),
        };
    });
    console.log(`[gpu] ${gpu.renderer} · webgl2=${gpu.webgl2} · canvas ${gpu.canvas.join('×')} · timer=${gpu.timer} · multi_draw=${gpu.multiDraw}`);
    if (/swiftshader|llvmpipe|software/i.test(gpu.renderer) && process.env.GLYPH_ALLOW_SOFTWARE !== '1') {
        throw new Error(`refusing to report numbers from a software GL renderer (${gpu.renderer}); GLYPH_ALLOW_SOFTWARE=1 overrides`);
    }
    const GL_METHODS = new Set(gpu.glMethods);
    delete gpu.glMethods;
    result.gpu = gpu;

    if (DIR) {
        const r = await app.cmd(`file.openDir ${DIR}`);
        console.log(`[load] ${(r.text ?? r.error ?? '').slice(0, 100)}`);
        await app.waitFor(4000);
        await app.cmd('camera.fitall');
        await app.waitFor(4000);
    }

    for (const v of CMDS) {
        const r = await app.cmd(v);
        console.log(`[cmd] ${v} → ${(r.text ?? r.error ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
        await app.waitFor(2500);
    }
    if (EVAL) console.log(`[eval] ${JSON.stringify(await app.evalPage(EVAL))}`);
    if (CMDS.length || EVAL) await app.waitFor(1000);

    // ── 1. TIMING ───────────────────────────────────────────────────────────
    result.timing = await app.evalPage(async (ms) => {
        const r = window.__glyphClient.ctx.renderer;
        const gl = r.getContext();
        const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');

        // Main-thread rAF work: time every rAF callback; group by the frame timestamp.
        const origRaf = window.requestAnimationFrame.bind(window);
        const frameWork = new Map();
        window.requestAnimationFrame = (cb) => origRaf((ts) => {
            const t0 = performance.now();
            try { cb(ts); } finally { frameWork.set(ts, (frameWork.get(ts) ?? 0) + performance.now() - t0); }
        });

        // three's render (CPU submit) + GPU time around it, per PASS — the main camera's
        // render and any other (the minimap's) cost very differently, so never pool them.
        const mainCam = window.__glyphClient.ctx.camera;
        const passOf = (cam) => (cam === mainCam ? 'main' : (cam.name || cam.type));
        const renders = new Map();
        const gpuMs = new Map();
        const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
        const pending = [];
        const origRender = r.render.bind(r);
        r.render = (scene, cam) => {
            const pass = passOf(cam);
            let q = null;
            if (tq && pending.length < 8) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
            const t0 = performance.now();
            const out = origRender(scene, cam);
            push(renders, pass, performance.now() - t0);
            if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push({ q, pass }); }
            for (let i = pending.length - 1; i >= 0; i--) {
                const p = pending[i];
                if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
                    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) push(gpuMs, p.pass, gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
                    gl.deleteQuery(p.q); pending.splice(i, 1);
                }
            }
            return out;
        };

        // Frame gaps.
        const gaps = [];
        let last = performance.now(), on = true;
        const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; if (on) origRaf(tick); };
        origRaf(tick);
        await new Promise((res) => setTimeout(res, ms));
        on = false;
        window.requestAnimationFrame = origRaf;
        r.render = origRender;

        const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, (s.length * p) | 0)].toFixed(2) : null; };
        const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null;
        const work = [...frameWork.values()];
        return {
            frames: gaps.length,
            gapMs: { p50: pct(gaps, 0.5), p95: pct(gaps, 0.95), worst: pct(gaps, 1) },
            mainThreadPerFrameMs: { p50: pct(work, 0.5), p95: pct(work, 0.95), mean: mean(work) },
            passes: Object.fromEntries([...renders].map(([pass, cpu]) => {
                const g = gpuMs.get(pass) ?? [];
                return [pass, {
                    perFrame: +(cpu.length / Math.max(1, work.length)).toFixed(2),
                    renderCpuMs: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95), mean: mean(cpu) },
                    gpuMs: g.length ? { p50: pct(g, 0.5), p95: pct(g, 0.95), samples: g.length } : (tq ? 'no timer samples' : 'no timer ext'),
                }];
            })),
        };
    }, MS);

    // ── 2. CENSUS ───────────────────────────────────────────────────────────
    result.census = await app.evalPage(async (ms) => {
        const c = window.__glyphClient;
        const r = c.ctx.renderer;
        const gl = r.getContext();
        const scene = c.ctx.scene;

        const counts = {};
        const bytes = { buffer: 0, texture: 0 };
        const drawsByProgram = new Map();
        let curProgram = null;
        const wrapped = [];
        const proto = Object.getPrototypeOf(gl);
        const progName = new Map();
        const label = (p) => p.name || p.type || `program#${p.id}`;
        for (const p of r.info.programs ?? []) progName.set(p.program, label(p));
        const bytesOf = (v) => (v && typeof v === 'object' && 'byteLength' in v) ? v.byteLength : 0;
        for (const name of Object.getOwnPropertyNames(proto)) {
            const d = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof d.value !== 'function' || name === 'constructor') continue;
            const orig = d.value;
            gl[name] = function (...a) {
                counts[name] = (counts[name] ?? 0) + 1;
                if (name === 'useProgram') curProgram = a[0];
                else if (name.startsWith('draw')) {
                    const k = progName.get(curProgram) ?? 'program?';
                    drawsByProgram.set(k, (drawsByProgram.get(k) ?? 0) + 1);
                } else if (name === 'bufferData' || name === 'bufferSubData') {
                    bytes.buffer += typeof a[1] === 'number' ? a[1] : bytesOf(a[2]) || bytesOf(a[1]);
                } else if (name.startsWith('texImage') || name.startsWith('texSubImage')) {
                    for (const x of a) if (bytesOf(x)) { bytes.texture += bytesOf(x); break; }
                }
                return orig.apply(this, a);
            };
            wrapped.push(name);
        }
        let frames = 0, on = true;
        const tick = () => { frames++; if (on) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        // Program names: three registers programs lazily — re-read after a frame.
        await new Promise((res) => setTimeout(res, 100));
        for (const p of r.info.programs ?? []) progName.set(p.program, label(p));
        for (const k of Object.keys(counts)) delete counts[k];
        drawsByProgram.clear(); bytes.buffer = 0; bytes.texture = 0; frames = 0;
        await new Promise((res) => setTimeout(res, ms));
        on = false;
        for (const n of wrapped) delete gl[n];

        const per = (v) => +(v / Math.max(1, frames)).toFixed(1);
        let meshes = 0, visible = 0, fields = 0, instances = 0, objects = 0;
        const fieldSizes = [];
        scene.traverse((o) => {
            objects++;
            if (!o.isMesh && !o.isLine && !o.isPoints) return;
            meshes++;
            let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
            if (vis) visible++;
            if (o.userData?.glyphField) {
                fields++;
                const n = o.geometry?.instanceCount ?? 0;
                instances += n; fieldSizes.push(n);
            }
        });
        fieldSizes.sort((a, b) => a - b);
        return {
            frames,
            info: { calls: r.info.render.calls, triangles: r.info.render.triangles,
                geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: (r.info.programs ?? []).length },
            drawsPerFrameByProgram: Object.fromEntries([...drawsByProgram].map(([k, v]) => [k, per(v)]).sort((a, b) => b[1] - a[1])),
            glCallsPerFrame: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, per(v)]).sort((a, b) => b[1] - a[1]).slice(0, 25)),
            uploadBytesPerFrame: { buffer: per(bytes.buffer), texture: per(bytes.texture) },
            scene: { objects, meshes, visibleMeshes: visible, glyphFields: fields, liveInstances: instances,
                fieldInstances: fieldSizes.length ? { min: fieldSizes[0], p50: fieldSizes[fieldSizes.length >> 1], max: fieldSizes[fieldSizes.length - 1] } : null },
        };
    }, Math.min(MS, 2000));

    // ── 3. PROFILE ──────────────────────────────────────────────────────────
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    // Frame stamps on the page clock, so samples can be binned into the frames they ran in
    // (uncapped, the main thread never idles — a hitch isn't visible as a sample gap).
    await app.evalPage(() => {
        const st = (window.__fpStamps = []);
        const tick = (ts) => { st.push(performance.now()); if (window.__fpStamps === st) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    await cdp.send('Profiler.start');
    const pageT0 = await app.evalPage(() => performance.now());   // ≈ profile.startTime (±½ RTT)
    await app.waitFor(MS);
    const { profile } = await cdp.send('Profiler.stop');
    const stamps = await app.evalPage(() => { const s = window.__fpStamps; window.__fpStamps = null; return s; });
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const dt = profile.timeDeltas;
    for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i]);
        self.set(n.id, (self.get(n.id) ?? 0) + (dt[i] ?? 0) / 1000);
    }
    // Vite pre-bundles deps into anonymous chunk-*.js files; esbuild marks each package's
    // section with a `// ../node_modules/<pkg>/…` comment, so map line → package.
    const depMarks = new Map();
    for (const n of profile.nodes) {
        const u = n.callFrame.url;
        if (!/\.vite\/deps\//.test(u) || depMarks.has(u)) continue;
        const marks = [];
        try {
            const lines = (await (await fetch(u)).text()).split('\n');
            lines.forEach((ln, i) => {
                const m = /^\/\/ (?:\.\.\/)*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(ln);
                if (m) marks.push([i, m[1]]);
            });
        } catch { /* unmapped → deps:? */ }
        depMarks.set(u, marks);
    }
    const depPkg = (u, line) => {
        let pkg = /deps\/([\w@.-]+)\.js/.exec(u)?.[1] ?? '?';
        for (const [i, name] of depMarks.get(u) ?? []) { if (i <= line) pkg = name; else break; }
        return pkg;
    };
    const bucketOf = (cf) => {
        const url = cf.url;
        if (!url) return GL_METHODS.has(cf.functionName) ? 'webgl (driver submit)' : 'native/other';
        if (/\.vite\/deps\//.test(url)) {
            const pkg = depPkg(url, cf.lineNumber);
            if (pkg === 'three') return 'three.js';
            if (/^(react|react-dom|scheduler|@react-three|its-fine|zustand|suspend-react)/.test(pkg)) return 'react/r3f';
            return `deps:${pkg}`;
        }
        if (/glyph3d-core\/src/.test(url)) return 'core';
        if (/\/app\//.test(url) || /glyph3d-r3f/.test(url)) return 'app';
        return 'other';
    };
    const buckets = {}, fns = new Map();
    let total = 0;
    for (const [id, ms] of self) {
        const n = byId.get(id), cf = n.callFrame;
        if (cf.functionName === '(idle)' || cf.functionName === '(program)') continue;
        total += ms;
        const b = cf.functionName === '(garbage collector)' ? 'gc' : bucketOf(cf);
        buckets[b] = (buckets[b] ?? 0) + ms;
        const where = /\.vite\/deps\//.test(cf.url) ? `[${depPkg(cf.url, cf.lineNumber)}]` : cf.url.split('/').slice(-1)[0].split('?')[0];
        const key = `${cf.functionName || '(anon)'} ${where}:${cf.lineNumber + 1}`;
        fns.set(key, (fns.get(key) ?? 0) + ms);
    }
    // Caller attribution: for each named function, its self time grouped by the first three
    // frames above it (the call path into the hot leaf).
    const parentOf = new Map();
    for (const n of profile.nodes) for (const ch of n.children ?? []) parentOf.set(ch, n.id);
    const frameName = (n) => {
        const cf = n.callFrame;
        const where = /\.vite\/deps\//.test(cf.url) ? `[${depPkg(cf.url, cf.lineNumber)}]` : cf.url.split('/').slice(-1)[0].split('?')[0];
        return `${cf.functionName || '(anon)'} ${where}:${cf.lineNumber + 1}`;
    };
    const callers = {};
    for (const fn of CALLERS) {
        const paths = new Map();
        for (const [id, ms] of self) {
            const n = byId.get(id);
            if (n.callFrame.functionName !== fn) continue;
            const chain = [];
            // Collapse recursion (a frame equal to the one below it) so the chain reaches the entry.
            let below = frameName(n);
            for (let p = parentOf.get(id); p != null && chain.length < 3; p = parentOf.get(p)) {
                const f = frameName(byId.get(p));
                if (f !== below) chain.push(f);
                below = f;
            }
            const k = chain.join(' ← ');
            paths.set(k, (paths.get(k) ?? 0) + ms);
        }
        callers[fn] = [...paths].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v.toFixed(1)}ms  ← ${k}`);
    }
    // Hitches: frames longer than HITCH ms, and the self time (with its call path) inside them.
    const hitchWins = [];
    for (let i = 1; i < stamps.length; i++) if (stamps[i] - stamps[i - 1] > HITCH) hitchWins.push([stamps[i - 1], stamps[i]]);
    const inHitch = new Map();
    let tSample = pageT0;
    for (let i = 0, w = 0; i < profile.samples.length; i++) {
        tSample += (dt[i] ?? 0) / 1000;
        while (w < hitchWins.length && hitchWins[w][1] < tSample) w++;
        if (w >= hitchWins.length) break;
        if (tSample < hitchWins[w][0]) continue;
        const n = byId.get(profile.samples[i]);
        if (n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)') continue;
        const chain = [frameName(n)];
        let below = chain[0];
        for (let p = parentOf.get(n.id); p != null && chain.length < 5; p = parentOf.get(p)) {
            const f = frameName(byId.get(p));
            if (f !== below && !/^\(root\)/.test(f)) chain.push(f);
            below = f;
        }
        const k = chain.join(' ← ');
        inHitch.set(k, (inHitch.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
    }
    const hitchMs = hitchWins.map(([a, b]) => b - a);
    const pctOf = (ms) => `${(100 * ms / Math.max(total, 1e-9)).toFixed(1)}%`;
    result.profile = {
        busyMsInWindow: +total.toFixed(1), windowMs: MS,
        buckets: Object.fromEntries(Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${v.toFixed(1)}ms ${pctOf(v)}`])),
        ...(CALLERS.length ? { callers } : {}),
        hitches: {
            overMs: HITCH, count: hitchWins.length, frames: stamps.length,
            worstMs: hitchMs.length ? +Math.max(...hitchMs).toFixed(1) : 0,
            totalMs: +hitchMs.reduce((a, b) => a + b, 0).toFixed(1),
            top: [...inHitch].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${v.toFixed(1)}ms  ${k}`),
        },
        topSelf: [...fns].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${v.toFixed(1)}ms ${pctOf(v)}  ${k}`),
    };

    result.errors = app.errors.slice(0, 5);
    console.log(JSON.stringify(result, null, 2));
    if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
} finally {
    await browser.close();
}
