#!/usr/bin/env bun
/**
 * atlas-cold-perf.mjs — what a COLD glyph costs, from the bytes arriving to the glyph on screen.
 *
 *   bun tools/atlas-cold-perf.mjs [--url http://localhost:5180/] [--relay 8099] [--reuse-relay]
 *                                 [--width 1600 --height 1000] [--json OUT] [--shot PNG]
 *
 * wall-text-perf's COLD pass times a burst to the first frame drawn after its applyScreen — with the
 * atlas growing off the main thread that frame draws the new glyphs BLANK, so it measures the
 * main thread, not the glyph. This tool times the glyph: one framed terminal of its own (a private
 * relay, tools/lib/wall-relay.mjs), and per burst
 *
 *   visible   writeBytes → the first frame rendered after the atlas has landed every glyph the
 *             burst asked for (outlines encoded, emoji rasterized) — the glyph on screen
 *   apply     main-thread ms inside TerminalGrid.applyScreen (where growth used to run)
 *   gap       the worst frame-to-frame interval from the write to 300 ms past visible
 *   long      long tasks (>50 ms) in that window
 *   upload    texture bytes the GL calls asked for (texSubImage2D/texImage2D w × h × texel size —
 *             three hands the whole array with skip/row-length set, so its byteLength lies), the
 *             calls that moved them, and GPU-side copies (copyTexSubImage2D: no bytes cross the bus)
 *   gl        main-thread ms inside those calls — in the window, and in its worst frame
 *   render    the worst renderer.render CPU ms in the window, and the worst GPU ms of one render
 *             (EXT_disjoint_timer_query_webgl2) — where a big upload lands
 *
 * It reads the atlas through whichever growth API the page has (whenIdle when growth is async,
 * else the synchronous return), so the same tool measures before and after the change. One
 * browser, one terminal; it stops its relay and tmux server at the end. --shot writes a mixed screen
 * of cold glyphs (new emoji, Nerd icons, syllabics, Armenian) after it lands and screenshots it.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay, spawnOwnTerminals } from './lib/wall-relay.mjs';
import { writeFileSync } from 'node:fs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const W = Number(arg('--width', 1600)), H = Number(arg('--height', 1000));
const OUT = arg('--json');
const SHOT = arg('--shot');

const range = (a, b) => { const o = []; for (let c = a; c <= b; c++) o.push(c); return o; };
const rowsOf = (cps, perRow) => { const rows = []; for (let r = 0; r < 20; r++) { let s = ''; for (let c = 0; c < perRow; c++) s += String.fromCodePoint(cps[(r * perRow + c) % cps.length]); rows.push(s); } return '\x1b[2J\x1b[H' + rows.join('\r\n'); };
// The classes wall-text-perf's COLD pass found cold on the wall's chain (Cousine · MesloLGS NF · DejaVu).
const BURSTS = [
    ['emoji-new', [...range(0x1f680, 0x1f6c5), ...range(0x1f330, 0x1f37f), ...range(0x1f900, 0x1f9ff)], 39],
    ['nerd', [...range(0xf000, 0xf2e0), ...range(0xe700, 0xe7c5)], 78],
    ['syllabics', range(0x1400, 0x167f), 78],
    ...range(0x0531, 0x0538).map((cp) => [`single U+${cp.toString(16).toUpperCase()}`, [cp], 1]),
];

function installProbe() {
    const c = window.__glyphClient, w = window.__wall;
    const gl = c.ctx.renderer.getContext();
    const now = () => performance.now();
    const st = { frames: [], tex: [], copies: [], apply: [], long: [], renders: [], gpu: [] };
    const bpp = (type) => (type === gl.UNSIGNED_INT || type === gl.INT || type === gl.FLOAT ? 16 : 4);
    // Each upload call: [when, bytes, ms inside the call].
    const timed = (orig, bytesOf, into) => function (...a) {
        const t = now();
        try { return orig.apply(this, a); } finally { const b = bytesOf(a); if (b !== null) into.push([t, b, now() - t]); }
    };
    gl.texSubImage2D = timed(gl.texSubImage2D, (a) => (a.length >= 9 && typeof a[4] === 'number' ? a[4] * a[5] * bpp(a[7]) : null), st.tex);
    gl.texImage2D = timed(gl.texImage2D, (a) => (a.length >= 9 && typeof a[3] === 'number' && a[8] ? a[3] * a[4] * bpp(a[7]) : null), st.tex);
    gl.copyTexSubImage2D = timed(gl.copyTexSubImage2D, () => 0, st.copies);
    // renderer.render: CPU ms, and GPU ms through a timer query per render.
    const r3 = c.ctx.renderer;
    const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pendingQ = [];
    const origRender = r3.render;
    r3.render = function (...a) {
        let q = null;
        if (tq && pendingQ.length < 16) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
        const t = now();
        try { return origRender.apply(this, a); } finally {
            st.renders.push([t, now() - t]);
            if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pendingQ.push([t, q]); }
            for (let i = pendingQ.length - 1; i >= 0; i--) {
                const [tq0, pq] = pendingQ[i];
                if (!gl.getQueryParameter(pq, gl.QUERY_RESULT_AVAILABLE)) continue;
                if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) st.gpu.push([tq0, gl.getQueryParameter(pq, gl.QUERY_RESULT) / 1e6]);
                gl.deleteQuery(pq); pendingQ.splice(i, 1);
            }
        }
    };
    const G = Object.getPrototypeOf(w.terminal(w.order[0]));
    const origApply = G.applyScreen;
    G.applyScreen = function (...a) { const t = now(); try { return origApply.apply(this, a); } finally { st.apply.push([t, now() - t]); } };
    const tick = (ts) => { st.frames.push(now()); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => { for (const e of l.getEntries()) st.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(now())));
    st.burst = async (text) => {
        const live = c.ctx.atlas._live;
        const grid = w.terminal(w.order[0]);
        for (let i = 0; i < 10; i++) await frame();
        const v0 = live.version, size0 = live.size;
        const t0 = now();
        grid.writeBytes(new TextEncoder().encode(text));
        // Landed: the atlas moved (a growth) and, where growth is async, nothing is left in flight.
        const dl = t0 + 10000;
        while (live.version === v0 && now() < dl) await sleep(1);
        if (live.whenIdle) await live.whenIdle();
        const tLanded = now();
        const tVisible = await frame();   // the render of this frame uploads + draws the landed glyphs
        await sleep(300);
        for (let i = 0; i < 6; i++) await frame();   // the timer queries of the window's renders resolve
        const tEnd = now();
        const inWin = ([t]) => t >= t0 && t <= tEnd;
        // GL ms per frame: each upload call binned into the frame interval it ran in.
        const fr0 = st.frames.filter((t) => t >= t0 - 20 && t <= tEnd);
        const perFrame = new Map();
        for (const [t, , ms] of [...st.tex, ...st.copies].filter(inWin)) {
            let k = 0; while (k < fr0.length && fr0[k] <= t) k++;
            perFrame.set(k, (perFrame.get(k) ?? 0) + ms);
        }
        const fr = st.frames.filter((t) => t >= t0 - 20 && t <= tEnd);
        let gap = 0; for (let i = 1; i < fr.length; i++) gap = Math.max(gap, fr[i] - fr[i - 1]);
        const r = {
            visibleMs: +(tVisible - t0).toFixed(1), landedMs: +(tLanded - t0).toFixed(1),
            applyMs: +st.apply.filter(inWin).reduce((s, [, d]) => s + d, 0).toFixed(1),
            maxApplyMs: +Math.max(0, ...st.apply.filter(inWin).map(([, d]) => d)).toFixed(1),
            worstGapMs: +gap.toFixed(1),
            longTasks: st.long.filter(([t]) => t >= t0 && t <= tEnd).map(([, d]) => +d.toFixed(0)),
            uploadBytes: st.tex.filter(inWin).reduce((s, [, b]) => s + b, 0),
            uploadCalls: st.tex.filter(inWin).length,
            gpuCopies: st.copies.filter(inWin).length,
            glMs: +[...st.tex, ...st.copies].filter(inWin).reduce((s, [, , ms]) => s + ms, 0).toFixed(2),
            glWorstFrameMs: +Math.max(0, ...perFrame.values()).toFixed(2),
            renderMaxMs: +Math.max(0, ...st.renders.filter(inWin).map(([, ms]) => ms)).toFixed(2),
            gpuMaxMs: +Math.max(0, ...st.gpu.filter(inWin).map(([, ms]) => ms)).toFixed(2),
            glyphsAdded: live.size - size0, timedOut: live.version === v0,
        };
        st.frames.length = 0; st.tex.length = 0; st.copies.length = 0; st.apply.length = 0; st.renders.length = 0; st.gpu.length = 0;
        return r;
    };
    window.__acp = st;
    return { glyphs: c.ctx.atlas._live.size, async: !!c.ctx.atlas._live.whenIdle };
}

const relay = await privateRelay({ port: RELAY, socket: 'glyph-atlas-cold', reuse: process.argv.includes('--reuse-relay') });
let browser = null;
const result = { when: new Date().toISOString(), viewport: [W, H], bursts: [] };
try {
    browser = await launchGpuBrowser({});
    const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 4000, viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('wall did not boot');
    const up = await app.evalPage(async () => {
        for (let i = 0; i < 60 && !window.__wall.snapshot().connected; i++) await new Promise((r) => setTimeout(r, 250));
        return window.__wall.snapshot().relay;
    });
    if (up.state !== 'up') throw new Error(`the wall isn't the relay's display on :${RELAY} (${up.state})`);
    const [id] = await spawnOwnTerminals(app.evalPage, 1);
    await app.evalPage(async (tid) => {
        for (let i = 0; i < 40 && !window.__wall.terminal(tid); i++) await new Promise((r) => setTimeout(r, 250));
        window.__wall.focus(tid, { frame: true });
        await new Promise((r) => setTimeout(r, 1500));
    }, id);
    result.gpu = await app.evalPage(() => {
        const gl = window.__glyphClient.ctx.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    if (/swiftshader|llvmpipe|software/i.test(result.gpu)) throw new Error(`software GL renderer (${result.gpu}) — numbers would be fiction`);
    result.info = await app.evalPage(installProbe);
    console.log(`[gpu] ${result.gpu} · atlas ${result.info.glyphs} glyphs at boot · growth ${result.info.async ? 'async' : 'synchronous'}`);
    for (const [label, cps, perRow] of BURSTS) {
        const text = cps.length === 1 ? String.fromCodePoint(cps[0]) : rowsOf(cps, perRow);
        const r = await app.evalPage((t) => window.__acp.burst(t), text);
        result.bursts.push({ label, ...r });
        console.log(`COLD ${label.padEnd(16)} visible ${String(r.visibleMs).padStart(6)} ms (landed ${r.landedMs}) · applyScreen ${r.applyMs} ms (max ${r.maxApplyMs}) · worst gap ${r.worstGapMs} ms · long tasks [${r.longTasks.join(' ')}] · upload ${r.uploadBytes} B in ${r.uploadCalls} call(s) + ${r.gpuCopies} GPU copies · gl ${r.glMs} ms (worst frame ${r.glWorstFrameMs}) · render max ${r.renderMaxMs} ms, gpu max ${r.gpuMaxMs} ms · +${r.glyphsAdded} glyphs${r.timedOut ? ' · TIMED OUT' : ''}`);
    }
    if (SHOT) {
        // A mixed screen — ASCII, box drawing, core + NEW emoji, NEW Nerd icons and syllabics (cold on
        // this page) — written once, shot after the atlas has landed it: the pixels to look at.
        const sample = [
            'ascii   The quick brown fox jumps over the lazy dog 0123456789 {}[]()<>=;',
            'box     ┌──────┬──────┐ │ cell │ cell │ └──────┴──────┘ ░▒▓█',
            'emoji   😀😃😄😁 🐶🐱🐭 (core)   🦀🦁🦄🧀🧁🧊 🌵🌶🍇🍉 (new)',
            `nerd    ${String.fromCodePoint(...range(0xf300, 0xf31f))}`,
            `devicon ${String.fromCodePoint(...range(0xe7c6, 0xe7e0))}`,
            `syll    ${String.fromCodePoint(...range(0x1680 - 64, 0x167f))}`,
            'armen   Աբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆ',
        ];
        const r = await app.evalPage((t) => window.__acp.burst(t), '\x1b[2J\x1b[H' + sample.join('\r\n'));
        await app.waitFor(500);
        await app.shot(SHOT);
        console.log(`[shot] ${SHOT} (mixed sample: visible in ${r.visibleMs} ms, +${r.glyphsAdded} glyphs)`);
    }
    if (app.errors.length) { result.errors = app.errors.slice(0, 5); console.log('page errors:', app.errors.slice(0, 5)); }
    await app.close();
} finally {
    await browser?.close();
    await relay.stop();
}
if (OUT) { writeFileSync(OUT, JSON.stringify(result, null, 2)); console.log(`[json] ${OUT}`); }
