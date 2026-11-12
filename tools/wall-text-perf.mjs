/**
 * wall-text-perf.mjs — the wall's terminal TEXT path, timed stage by stage:
 *
 *   bytes in (OUTPUT frame → TerminalGrid.writeBytes) → xterm-headless parse → cells
 *   (TerminalEmulator.readScreen, pulled once a frame by the scene's TerminalScreenQueue) → TerminalGrid.applyScreen
 *   (atlas ensure · diff of the live rows · changed-span writes · row poses) → GL uploads inside renderer.render → drawn (GPU fence).
 *
 *   bun tools/wall-text-perf.mjs [--url http://localhost:5180/] [--relay 8099] [--reuse-relay]
 *                                [--width 3024 --height 1964] [--json OUT]
 *                                [--mode idle,flood,cold,profile]   (default: all four)
 *                                [--source direct,shell]       (flood sources; default both)
 *                                [--payload seq,source]        (flood payloads; default both)
 *                                [--scale 1,4,14]              (terminals flooded at once)
 *                                [--seq 300000] [--source-bytes 2000000] [--top 25]
 *
 * Needs the wall's Vite (:5180) and a built ./glyph3d-cli. Starts its own PRIVATE relay on --relay
 * (tools/lib/wall-relay.mjs: termd namespace `glyph-wall-text-perf`, no gomuxai; stopped with its termd
 * at the end) and refuses a port something already listens on, unless --reuse-relay names a relay
 * you started. Spawns max(--scale) terminals of its own and writes only to those (a reused relay's
 * other terminals are drawn, never typed into); kills them at the end. Launches a real-GPU browser
 * (headed on macOS) and refuses a software GL renderer.
 *
 * Four passes, each on its own fresh page so one can't warm or skew the next:
 *
 *   IDLE     3 s at the overview and 3 s framed with nothing typing: what the text path and the
 *            renderer do per frame at rest (applyScreens, GL upload bytes, main-thread ms, GPU ms).
 *   FLOOD    the same payload into 1, 4, 14 terminals at once, camera at the overview. Two sources:
 *            · direct — the payload's bytes handed straight to grid.writeBytes in 16 KB chunks, all
 *              queued at once: no shell, no termd, no relay. This is the display's own digest
 *              ceiling (bytes/s), and the cleanest per-stage split.
 *            · shell  — the real pipeline: the command typed into the shell (`seq 1 N`, `cat FILE`),
 *              termd passing the program's bytes on, the adapter's 16 ms coalescer, the relay, the
 *              socket. termd sends the program's own bytes (raw mode), every one, so the bytes the
 *              display parsed and the bytes the program wrote are both reported and should match.
 *            Per scenario: throughput, main-thread ms per stage (total · per OUTPUT frame · per
 *            display frame p50/p95/max · per applyScreen), GL upload bytes, frame gaps, long tasks
 *            (>50 ms), GPU ms, and the per-terminal split.
 *   COLD     one framed terminal, bursts of text on both sides of what the atlas holds at boot
 *            (box-drawing and core emoji: baked · CJK: no font · new emoji, Nerd Font icons, syllabics,
 *            then single new codepoints: really cold), each against warm repeats and warm ASCII, and
 *            each reporting the glyphs the atlas gained: latency from writeBytes to
 *            the GPU finishing the first frame that draws it, split into parse · wait for rAF ·
 *            readScreen · atlas (shape lookups · outline extraction · texture rebuild · bitmap
 *            slots · per-field hot-swap) · cell writes · render CPU (texture/buffer uploads,
 *            program links) · GPU finish. The fence is polled on a timer chain, and the browser
 *            refreshes a sync's status about once a frame, so "GPU finish" is quantized to roughly a
 *            frame; the timer-query GPU time of that same render pass is reported beside it.
 *   PROFILE  a CDP sampling CPU profile (200 µs) with NO probes installed, over: direct flood ×1,
 *            direct flood ×14, shell flood ×14, and the cold bursts. Self time by bucket, the top
 *            self functions with file:line and their dominant caller, and inclusive time for our
 *            own functions.
 *
 * The probes are wrappers around whole stages (once per terminal per frame), never per cell, and
 * they come off again when the pass ends. Stage times nest: applyScreen ⊃ ensureAtlas ⊃ … — the
 * report subtracts children so the columns add up.
 */

import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay, spawnOwnTerminals } from './lib/wall-relay.mjs';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const list = (k, d) => arg(k, d).split(',').map((s) => s.trim()).filter(Boolean);
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const W = Number(arg('--width', 3024)), H = Number(arg('--height', 1964));
const OUT = arg('--json');
const MODES = list('--mode', 'idle,flood,cold,profile');
const SOURCES = list('--source', 'direct,shell');
const PAYLOADS = list('--payload', 'seq,source');
const SCALE = list('--scale', '1,4,14').map(Number);
const SEQ = Number(arg('--seq', 300000));
const SOURCE_BYTES = Number(arg('--source-bytes', 2000000));
const TOP = Number(arg('--top', 25));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── stage codes (shared with the page) ──────────────────────────────────────────────────────────
const S = {
    write: 0, parse: 1, read: 2, apply: 3, ensure: 4, diff: 5, pose: 6, spans: 7, render: 8,
    upBuf: 9, upTex: 10, ensureCp: 11, ensureGlyphs: 12, appendGlyphs: 13, appendBitmap: 14,
    emojiRefresh: 15, raf: 16, gpu: 17, longtask: 18, stamp: 19, glProgram: 20, buildTextures: 21,
    addGlyphs: 22, setSlug: 23, shape: 24,
};

// ── payloads ────────────────────────────────────────────────────────────────────────────────────
const seqText = () => { const a = new Array(SEQ); for (let i = 0; i < SEQ; i++) a[i] = String(i + 1); return a.join('\n') + '\n'; };
const sourceText = () => {
    const dir = path.join(ROOT, 'packages/glyph3d-core/src/collections');
    const one = readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    let s = one; while (s.length < SOURCE_BYTES) s += one;
    return s.slice(0, s.lastIndexOf('\n', SOURCE_BYTES) + 1);
};
const SOURCE_FILE = path.join(os.tmpdir(), 'wall-text-perf-source.txt');
const payloads = {};
if (PAYLOADS.includes('seq')) payloads.seq = { text: seqText(), cmd: `seq 1 ${SEQ}` };
if (PAYLOADS.includes('source')) {
    const text = sourceText();
    writeFileSync(SOURCE_FILE, text);
    payloads.source = { text, cmd: `cat ${SOURCE_FILE}` };
}
const crlf = (t) => t.replace(/\n/g, '\r\n');   // what a PTY (onlcr) would hand a terminal

// Cold bursts: 20 rows of codepoints, behind a clear + home so every repeat really rewrites the screen.
const rowsOf = (cps, perRow) => { const rows = []; for (let r = 0; r < 20; r++) { let s = ''; for (let c = 0; c < perRow; c++) s += String.fromCodePoint(cps[(r * perRow + c) % cps.length]); rows.push(s); } return '\x1b[2J\x1b[H' + rows.join('\r\n'); };
const range = (a, b) => { const o = []; for (let c = a; c <= b; c++) o.push(c); return o; };
// What is COLD depends on the baked slug core (core/coreRanges.js: Latin, Greek, Cyrillic, arrows,
// box-drawing, braille, powerline, emoji U+1F400–1F64F are encoded at boot) and on the wall's font
// chain (Cousine · MesloLGS NF · DejaVu Sans — no CJK font). So the classes are picked on both
// sides of those lines, and every row reports how many glyphs the atlas actually gained.
const BURSTS = {
    ascii: { cps: range(0x21, 0x7e), perRow: 78, note: 'in the baked core' },
    box: { cps: range(0x2500, 0x259f), perRow: 78, note: 'box-drawing + block elements — in the baked core' },
    cjk: { cps: range(0x4e00, 0x4e00 + 779), perRow: 39, note: 'wide; no font in the chain has them' },
    'emoji-core': { cps: [...range(0x1f600, 0x1f64f), ...range(0x1f400, 0x1f43f)], perRow: 39, note: 'color emoji inside the baked range' },
    'emoji-new': { cps: [...range(0x1f680, 0x1f6c5), ...range(0x1f330, 0x1f37f), ...range(0x1f900, 0x1f9ff)], perRow: 39, note: 'color emoji outside the baked range (bitmap slots, canvas-drawn)' },
    nerd: { cps: [...range(0xf000, 0xf2e0), ...range(0xe700, 0xe7c5)], perRow: 78, note: 'Nerd Font icons (MesloLGS NF private use) — outlines outside the baked core' },
    syllabics: { cps: range(0x1400, 0x167f), perRow: 78, note: 'Canadian syllabics (DejaVu Sans) — outlines outside the baked core' },
};
const COLD_ORDER = ['box', 'cjk', 'emoji-core', 'emoji-new', 'nerd', 'syllabics'];
const SINGLES = range(0x0531, 0x0538);   // Armenian capitals (DejaVu Sans), outside the core: one new outline each

// ── the page probe ──────────────────────────────────────────────────────────────────────────────
// Installed once per page as window.__wtp. `light` installs only the scenario drivers (no wrappers)
// so a CPU profile sees the code as it ships.
function installProbe({ S, light, own }) {
    const w = window.__wall, c = window.__glyphClient;
    const r = c.ctx.renderer, gl = r.getContext();
    const E = [];   // flat events: t, dur, stage, terminal index, n
    const undo = [];
    const ids = [...own];   // the terminals this tool spawned — the only ones it writes to
    const grids = ids.map((id) => w.terminal(id));
    const idx = new Map(ids.map((id, i) => [id, i]));
    const emuIdx = new WeakMap(); grids.forEach((g, i) => emuIdx.set(g._emulator, i));
    const now = () => performance.now();
    const st = { E, ids, missing: [], armed: false, applied: false, fence: null, logs: [] };
    // The atlas reports its own growth ([LiveSlugAtlas] / [EmojiAtlas] / [SlugEncoder]); keep the lines.
    for (const level of ['log', 'debug']) {
        const orig = console[level];
        console[level] = function (...a) {
            if (typeof a[0] === 'string' && /^\[(LiveSlugAtlas|EmojiAtlas|SlugEncoder)\]/.test(a[0])) st.logs.push(a[0].slice(0, 260));
            return orig.apply(this, a);
        };
        undo.push(() => { console[level] = orig; });
    }
    const wrap = (obj, name, stage, termOf, nOf, after) => {
        const orig = obj?.[name];
        if (typeof orig !== 'function') { st.missing.push(name); return; }
        const own = Object.prototype.hasOwnProperty.call(obj, name);
        obj[name] = function (...a) {
            const t = now();
            try { return orig.apply(this, a); } finally {
                E.push(t, now() - t, stage, termOf ? (termOf(this) ?? -1) : -1, nOf ? nOf(a) : 0);
                if (after) after();
            }
        };
        undo.push(() => { if (own) obj[name] = orig; else delete obj[name]; });
    };

    if (!light) {
        const G = Object.getPrototypeOf(grids[0]);
        const ofGrid = (t) => idx.get(t.terminalId);
        wrap(G, 'writeBytes', S.write, ofGrid, (a) => a[0]?.byteLength ?? a[0]?.length ?? 0);
        wrap(G, 'applyScreen', S.apply, ofGrid, null, () => { if (st.armed) st.applied = true; });
        wrap(G, '_ensureAtlasCodepoints', S.ensure, ofGrid);
        wrap(G, '_diffLive', S.diff, ofGrid);
        wrap(G, '_poseRows', S.pose, ofGrid);
        wrap(G, '_writeSpans', S.spans, ofGrid);
        wrap(Object.getPrototypeOf(grids[0]._emulator), 'readScreen', S.read, (t) => emuIdx.get(t));
        grids.forEach((g, i) => wrap(g._emulator._term._core._writeBuffer, '_action', S.parse, () => i, (a) => a[0]?.length ?? 0));
        const live = c.ctx.atlas._live;
        wrap(live, 'ensureCodepoints', S.ensureCp, null, (a) => a[0]?.length ?? 0);
        wrap(live, 'ensureGlyphsEncoded', S.ensureGlyphs, null, (a) => a[0]?.length ?? 0);
        wrap(live, '_refreshEmojiTextures', S.emojiRefresh, null, (a) => a[0]?.length ?? 0);
        wrap(live._encoder, 'appendGlyphs', S.appendGlyphs);
        wrap(live._encoder, 'appendBitmapSlots', S.appendBitmap);
        wrap(live._encoder, '_buildTextures', S.buildTextures);
        wrap(live._encoder._buffer, 'addGlyphs', S.addGlyphs);
        wrap(Object.getPrototypeOf(grids[0]._renderer), 'setSlugData', S.setSlug);
        wrap(c.ctx.atlas._shapeCache?._shaper, 'shape', S.shape, null, (a) => a[0]?.length ?? 0);

        // GL: uploads (CPU time inside the call + bytes handed over) and program builds.
        const bytesOf = (v) => (v && typeof v === 'object' && 'byteLength' in v) ? v.byteLength : 0;
        const glWrap = (name, stage, nOf) => {
            const orig = gl[name];
            if (typeof orig !== 'function') { st.missing.push(`gl.${name}`); return; }
            gl[name] = function (...a) { const t = now(); try { return orig.apply(this, a); } finally { E.push(t, now() - t, stage, -1, nOf(a)); } };
            undo.push(() => { delete gl[name]; });
        };
        glWrap('bufferData', S.upBuf, (a) => (typeof a[1] === 'number' ? a[1] : bytesOf(a[1])));
        glWrap('bufferSubData', S.upBuf, (a) => (a.length >= 5 && a[4] ? a[4] * (a[2].BYTES_PER_ELEMENT ?? 1) : bytesOf(a[2])));
        for (const n of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) {
            glWrap(n, S.upTex, (a) => { for (const x of a) if (bytesOf(x)) return bytesOf(x); return 0; });
        }
        for (const n of ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter']) glWrap(n, S.glProgram, () => 0);

        // renderer.render: CPU time, GPU time (timer query), and — when a cold burst is armed and
        // its applyScreen has landed — a fence on the first frame that draws it.
        const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const pending = [];
        const origRender = r.render;
        r.render = function (scene, cam) {
            let q = null;
            if (tq && pending.length < 8) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
            const t = now();
            const out = origRender.call(this, scene, cam);
            const t1 = now();
            E.push(t, t1 - t, S.render, -1, 0);
            if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push({ q, t }); }
            for (let i = pending.length - 1; i >= 0; i--) {
                const p = pending[i];
                if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
                    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) E.push(p.t, gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6, S.gpu, -1, 0);
                    gl.deleteQuery(p.q); pending.splice(i, 1);
                }
            }
            if (st.armed && st.applied) {
                st.armed = false;
                const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                gl.flush();
                st.fence = { sync, t0: t, t1 };
            }
            return out;
        };
        undo.push(() => { r.render = origRender; });

        // rAF: every callback's main-thread time, and one stamp per frame (the frame's own clock).
        const origRaf = window.requestAnimationFrame;
        let lastTs = -1;
        window.requestAnimationFrame = (cb) => origRaf.call(window, (ts) => {
            if (ts !== lastTs) { lastTs = ts; E.push(ts, 0, S.stamp, -1, 0); }
            const t = now();
            try { cb(ts); } finally { E.push(t, now() - t, S.raf, -1, 0); }
        });
        undo.push(() => { window.requestAnimationFrame = origRaf; });

        const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) E.push(e.startTime, e.duration, S.longtask, -1, 0); });
        po.observe({ type: 'longtask' });
        undo.push(() => po.disconnect());
    }

    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const frames = (n) => new Promise((res) => { const tick = () => (--n <= 0 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); });
    const busy = (targets) => targets.some((i) => { const g = grids[i]; return g._screenQueued || g._emulator._term._core._writeBuffer._writeBuffer.length > 0; });
    const idle = async (targets, timeoutMs = 180000) => {
        const dl = now() + timeoutMs;
        while (busy(targets)) { if (now() > dl) throw new Error('[wtp] terminals never went idle'); await sleep(4); }
    };
    const enc = new TextEncoder();
    const all = grids.map((_, i) => i);

    Object.assign(st, {
        drain: () => E.splice(0),
        uninstall: () => { for (const u of undo.reverse()) u(); undo.length = 0; },
        info: () => ({
            ids, missing: st.missing,
            terminals: grids.map((g) => ({ id: g.terminalId, cols: g.cols, rows: g.rows, instances: g._totalCount, instanceBufferBytes: g._renderer._interleavedBuffer?.array?.byteLength ?? null })),
            atlas: { glyphs: c.ctx.atlas._live.size, version: c.ctx.atlas._live.version, fields: c.ctx.atlas._live._fields.size },
        }),
        // Clear every shell through termd (resyncs a grid that was fed directly) and pose the camera.
        async reset(pose, i = 0) {
            for (const g of grids) g.sendInput('clear\r');
            await sleep(900);
            await idle(all);
            if (pose === 'overview') { w.focus(null); w.fitAll(); } else { w.focus(ids[i], { frame: true }); }
            await sleep(1300);
            E.length = 0;
            return { zoom: +w.viewport.zoom.toFixed(3), focus: w.focusedId };
        },
        // Direct flood: the payload straight into writeBytes, 16 KB chunks, everything queued at once.
        async floodDirect(n, text, chunkBytes = 16384) {
            const targets = all.slice(0, n);
            const bytes = enc.encode(text);
            const chunks = [];
            for (let o = 0; o < bytes.length; o += chunkBytes) chunks.push(bytes.subarray(o, o + chunkBytes));
            await idle(targets); await frames(3);
            const t0 = now();
            for (const ch of chunks) for (const i of targets) grids[i].writeBytes(ch);
            await idle(targets);
            const tIdle = now();
            await frames(3);
            return { t0, tIdle, t1: now(), bytesPerTerminal: bytes.length, chunks: chunks.length };
        },
        // shell flood: type the command into each shell; done when each prints its sentinel.
        async floodShell(n, cmd, base) {
            const targets = all.slice(0, n);
            await idle(targets); await frames(3);
            const t0 = now();
            for (const i of targets) grids[i].sendInput(`clear; ${cmd}; echo __WTP_$((${base}+${i}))__\r`);
            const dl = now() + 240000;
            const done = () => targets.every((i) => grids[i].readText().some((l) => l.includes(`__WTP_${base + i}__`)));
            while (!done()) { if (now() > dl) throw new Error('[wtp] shell flood never finished'); await sleep(50); }
            const tSeen = now();
            await sleep(250); await idle(targets); await frames(3);
            return { t0, tSeen, t1: now() };
        },
        // Cold burst: one write, then the first frame drawn after its applyScreen, fenced.
        async burst(i, text) {
            await idle([i]); await frames(2);
            const live = c.ctx.atlas._live;
            const before = { glyphs: live.size, version: live.version };
            st.fence = null; st.applied = false; st.armed = true; st.logs.length = 0;
            const t0 = now();
            grids[i].writeBytes(enc.encode(text));
            const dl = t0 + 8000;
            // Wait on a timer chain, never a MessageChannel spin: a tight spin stalls frame production
            // for ~100 ms every few seconds all by itself (measured — wall-perf/gap-watch.mjs). The cost
            // is resolution: the sync's status shows up about a frame later this way.
            while (!st.fence && now() < dl) await sleep(1);
            let tDrawn = null, fence = null;
            if (st.fence) {
                fence = { t0: st.fence.t0, t1: st.fence.t1 };
                while (gl.clientWaitSync(st.fence.sync, 0, 0) === gl.TIMEOUT_EXPIRED && now() < dl) await sleep(1);
                tDrawn = now();
                gl.deleteSync(st.fence.sync);
            }
            st.armed = false; st.fence = null;
            await frames(30);   // the frames after it: a growth can hitch more than its own frame
            return { t0, fence, tDrawn, t1: now(), before, after: { glyphs: live.size, version: live.version }, logs: st.logs.splice(0) };
        },
        // The same bursts with no probes (profile pass): just write and wait for quiet.
        async burstLight(i, text) {
            grids[i].writeBytes(enc.encode(text));
            await sleep(50); await idle([i]); await frames(20);
        },
    });
    window.__wtp = st;
    return st.info();
}

// ── analysis (node side) ────────────────────────────────────────────────────────────────────────
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const dist = (a) => ({ p50: pct(a, 0.5), p95: pct(a, 0.95), max: pct(a, 1) });
const r2 = (v) => (v == null ? null : +v.toFixed(2));

/** Fold a window of probe events into totals, per-frame distributions and per-terminal splits. */
function summarize(E, t0, t1, nTerms, { wholeWindow = false } = {}) {
    const tot = {}, perTerm = Array.from({ length: nTerms }, () => ({}));
    const add = (o, k, dur, n) => { const e = (o[k] ??= { ms: 0, count: 0, n: 0 }); e.ms += dur; e.count++; e.n += n; };
    const name = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
    const stamps = [];
    for (let k = 0; k < E.length; k += 5) if (E[k + 2] === S.stamp && E[k] >= t0 - 50 && E[k] <= t1 + 50) stamps.push(E[k]);
    stamps.sort((a, b) => a - b);
    const frameOf = (t) => { let lo = 0, hi = stamps.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (stamps[m] <= t) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    const perFrame = stamps.map(() => ({}));
    const gpu = [], longTasks = [];
    let firstWrite = Infinity, lastApplyEnd = -Infinity;
    for (let k = 0; k < E.length; k += 5) {
        const t = E[k], dur = E[k + 1], stage = E[k + 2], term = E[k + 3], n = E[k + 4];
        if (t < t0 || t > t1 || stage === S.stamp) continue;
        if (stage === S.gpu) { gpu.push(dur); continue; }
        if (stage === S.longtask) { longTasks.push(dur); continue; }
        const key = name[stage];
        add(tot, key, dur, n);
        if (term >= 0 && term < nTerms) add(perTerm[term], key, dur, n);
        if (stage === S.write) firstWrite = Math.min(firstWrite, t);
        if (stage === S.apply) lastApplyEnd = Math.max(lastApplyEnd, t + dur);
        const f = frameOf(t);
        if (f >= 0) perFrame[f][key] = (perFrame[f][key] ?? 0) + dur;
    }
    const ms = (k) => tot[k]?.ms ?? 0, cnt = (k) => tot[k]?.count ?? 0, num = (k) => tot[k]?.n ?? 0;
    // Frame statistics cover the digest itself (first byte → last applyScreen), not the idle tail.
    const fEnd = !wholeWindow && Number.isFinite(lastApplyEnd) ? lastApplyEnd : t1;
    const gaps = []; for (let i = 1; i < stamps.length; i++) if (stamps[i] >= t0 && stamps[i - 1] <= fEnd) gaps.push(stamps[i] - stamps[i - 1]);
    const col = (fn) => perFrame.filter((_, i) => stamps[i] >= t0 - 17 && stamps[i] <= fEnd).map(fn);
    const g = (f, k) => f[k] ?? 0;
    const outFrames = cnt('write'), applies = cnt('apply');
    const per = (v, d) => (d ? r2(v / d) : null);
    return {
        windowMs: r2(t1 - t0), firstWrite: Number.isFinite(firstWrite) ? firstWrite : null, lastApplyEnd: Number.isFinite(lastApplyEnd) ? lastApplyEnd : null,
        displayFrames: gaps.length, fps: gaps.length ? r2(1000 * gaps.length / gaps.reduce((a, b) => a + b, 0)) : null,
        gapMs: { ...dist(gaps), over20: gaps.filter((x) => x > 20).length, over33: gaps.filter((x) => x > 33.4).length, over50: gaps.filter((x) => x > 50).length },
        bytesIn: num('write'), outputFrames: outFrames, applyScreens: applies,
        stageMs: {
            write: r2(ms('write')), parse: r2(ms('parse')), readScreen: r2(ms('read')),
            apply: {
                total: r2(ms('apply')), ensureAtlas: r2(ms('ensure')), diff: r2(ms('diff')), pose: r2(ms('pose')), spans: r2(ms('spans')),
                cells: r2(ms('apply') - ms('ensure') - ms('diff') - ms('pose') - ms('spans')),
            },
            render: {
                cpu: r2(ms('render')), uploadBuffer: r2(ms('upBuf')), uploadTexture: r2(ms('upTex')), glProgram: r2(ms('glProgram')),
                other: r2(ms('render') - ms('upBuf') - ms('upTex') - ms('glProgram')),
            },
            rafOther: r2(ms('raf') - ms('read') - ms('apply') - ms('render')),
            mainThreadTotal: r2(ms('write') + ms('parse') + ms('raf')),
        },
        uploads: { bufferBytes: num('upBuf'), bufferCalls: cnt('upBuf'), textureBytes: num('upTex'), textureCalls: cnt('upTex'), programCalls: cnt('glProgram') },
        perOutputFrameMs: { parse: per(ms('parse'), outFrames), readScreen: per(ms('read'), outFrames), apply: per(ms('apply'), outFrames), upload: per(ms('upBuf') + ms('upTex'), outFrames) },
        perApplyScreen: { readScreenMs: per(ms('read'), applies), applyMs: per(ms('apply'), applies), spansMs: per(ms('spans'), applies), uploadMs: per(ms('upBuf') + ms('upTex'), applies), uploadBytes: per(num('upBuf') + num('upTex'), applies) },
        parseMsPerMB: per(ms('parse'), num('parse') / 1e6),
        perDisplayFrameMs: {
            parse: dist(col((f) => g(f, 'parse'))), text: dist(col((f) => g(f, 'read') + g(f, 'apply'))),
            upload: dist(col((f) => g(f, 'upBuf') + g(f, 'upTex'))), render: dist(col((f) => g(f, 'render'))),
            busy: dist(col((f) => g(f, 'write') + g(f, 'parse') + g(f, 'raf'))),
        },
        perTerminal: perTerm.map((p, i) => ({ i, bytes: p.write?.n ?? 0, outputFrames: p.write?.count ?? 0, applyScreens: p.apply?.count ?? 0, parseMs: r2(p.parse?.ms ?? 0), readMs: r2(p.read?.ms ?? 0), applyMs: r2(p.apply?.ms ?? 0) })).filter((p) => p.outputFrames || p.applyScreens),
        longTasks: { count: longTasks.length, totalMs: r2(longTasks.reduce((a, b) => a + b, 0)), maxMs: longTasks.length ? r2(Math.max(...longTasks)) : 0 },
        gpuMs: { ...dist(gpu), n: gpu.length },
    };
}

/** One cold burst's latency, split along the path. Events are the burst's own window. */
function coldSplit(E, b) {
    const ev = (stage, from = b.t0) => { const o = []; for (let k = 0; k < E.length; k += 5) if (E[k + 2] === stage && E[k] >= from && E[k] <= b.t1) o.push({ t: E[k], dur: E[k + 1], n: E[k + 4] }); return o; };
    const sum = (a) => a.reduce((x, y) => x + y.dur, 0);
    const parse = ev(S.parse), read = ev(S.read), apply = ev(S.apply);
    const a0 = apply[0];
    if (!a0 || !b.fence) return { error: 'no applyScreen or no fenced frame after the burst' };
    const inApply = (stage) => ev(stage).filter((e) => e.t >= a0.t && e.t <= a0.t + a0.dur);
    const inRender = (stage) => ev(stage).filter((e) => e.t >= b.fence.t0 && e.t <= b.fence.t1);
    const ensure = sum(inApply(S.ensure)), ensureCp = sum(inApply(S.ensureCp)), ensureGlyphs = sum(inApply(S.ensureGlyphs));
    const addGlyphs = sum(inApply(S.addGlyphs)), build = sum(inApply(S.buildTextures)), bitmap = sum(inApply(S.appendBitmap));
    const emoji = sum(inApply(S.emojiRefresh)), setSlug = inApply(S.setSlug), spans = sum(inApply(S.spans));
    const upTex = inRender(S.upTex), upBuf = inRender(S.upBuf), prog = inRender(S.glProgram);
    const r0 = read.find((e) => e.t <= a0.t && e.t >= a0.t - 50) ?? read[0];
    // The frames after the fenced one: render CPU and the worst frame gap in the next 30 frames.
    const stamps = ev(S.stamp, b.fence.t1).map((e) => e.t);
    const gaps = []; for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
    const after = ev(S.render, b.fence.t1).slice(0, 5).map((e) => r2(e.dur));
    const afterProg = ev(S.glProgram, b.fence.t1);
    // Between applyScreen's end and the render that drew it: was the main thread busy, or was the
    // browser simply not producing a frame (raster / GPU-process work shows up as an idle gap)?
    const a1 = a0.t + a0.dur;
    const between = (stage) => sum(ev(stage).filter((e) => e.t >= a1 && e.t < b.fence.t0));
    const lt = ev(S.longtask, b.t0 - 1);
    // The timer-query GPU time of the fenced frame's own render pass (same clock as part B's numbers).
    let gpuPass = null;
    for (let k = 0; k < E.length; k += 5) if (E[k + 2] === S.gpu && Math.abs(E[k] - b.fence.t0) < 0.005) gpuPass = E[k + 1];
    return {
        totalMs: r2(b.tDrawn - b.t0),
        gpuPassMs: r2(gpuPass),
        betweenApplyAndRender: { wallMs: r2(b.fence.t0 - a1), mainThreadBusyMs: r2(between(S.raf) + between(S.parse) + between(S.write)) },
        longTasks: { count: lt.length, maxMs: lt.length ? r2(Math.max(...lt.map((e) => e.dur))) : 0 },
        logs: b.logs,
        split: {
            writeToParseStart: r2((parse[0]?.t ?? a0.t) - b.t0),
            parse: r2(sum(parse.filter((e) => e.t <= a0.t))),
            waitForRaf: r2((r0?.t ?? a0.t) - (parse.length ? parse[0].t + parse[0].dur : b.t0)),
            readScreen: r2(r0?.dur ?? 0),
            applyScreen: r2(a0.dur),
            applyToRenderStart: r2(b.fence.t0 - (a0.t + a0.dur)),
            renderCpu: r2(b.fence.t1 - b.fence.t0),
            gpuFinish: r2(b.tDrawn - b.fence.t1),
        },
        applyScreen: {
            ensureAtlas: r2(ensure),
            shapeLookups: r2(ensureCp - ensureGlyphs), shapeCalls: inApply(S.shape).length,
            outlineExtraction: r2(addGlyphs), buildTextures: r2(build), bitmapSlots: r2(bitmap), emojiRefresh: r2(emoji),
            fieldHotSwap: r2(sum(setSlug)), fieldsSwapped: setSlug.length,
            ensureOther: r2(ensure - (ensureCp - ensureGlyphs) - addGlyphs - build - bitmap - emoji - sum(setSlug)),
            spans: r2(spans), cellsAndRest: r2(a0.dur - ensure - spans),
        },
        render: {
            uploadTextureMs: r2(sum(upTex)), uploadTextureBytes: upTex.reduce((x, y) => x + y.n, 0),
            uploadBufferMs: r2(sum(upBuf)), uploadBufferBytes: upBuf.reduce((x, y) => x + y.n, 0),
            glProgramMs: r2(sum(prog)), glProgramCalls: prog.length,
        },
        framesAfter: { renderCpuMs: after, worstGapMs: gaps.length ? r2(Math.max(...gaps)) : null, glProgramMs: r2(sum(afterProg)), glProgramCalls: afterProg.length },
        atlas: { before: b.before, after: b.after },
    };
}

/** Bucket + rank a CDP CPU profile: self time by bucket, top self functions (file:line, dominant
 *  caller chain), and inclusive time for functions in our own code. */
async function analyzeProfile(profile, glMethods) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parentOf = new Map();
    for (const n of profile.nodes) for (const ch of n.children ?? []) parentOf.set(ch, n.id);
    const dt = profile.timeDeltas;
    const self = new Map();
    for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0) / 1000);
    // Vite pre-bundles deps into chunk files; esbuild marks each package's section with a
    // `// ../node_modules/<pkg>/…` comment, so line → package (frame-profile.mjs's mapping).
    const depMarks = new Map();
    for (const n of profile.nodes) {
        const u = n.callFrame.url;
        if (!/\.vite\/deps\//.test(u) || depMarks.has(u)) continue;
        const marks = [];
        try {
            (await (await fetch(u)).text()).split('\n').forEach((ln, i) => { const m = /^\/\/ (?:\.\.\/)*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(ln); if (m) marks.push([i, m[1]]); });
        } catch { /* unmapped → the chunk's own name */ }
        depMarks.set(u, marks);
    }
    const depPkg = (u, line) => { let pkg = /deps\/([\w@.-]+)\.js/.exec(u)?.[1] ?? '?'; for (const [i, nm] of depMarks.get(u) ?? []) { if (i <= line) pkg = nm; else break; } return pkg; };
    const rel = (u) => {
        let p = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        if (p.startsWith('/@fs')) p = p.slice(4);
        if (p.startsWith(ROOT)) return p.slice(ROOT.length + 1);
        return `wall${p}`;   // Vite's root is wall/
    };
    const bucketOf = (cf) => {
        const u = cf.url;
        if (cf.functionName === '(garbage collector)') return 'gc';
        if (!u) return glMethods.has(cf.functionName) ? 'webgl (driver submit)' : 'native/other';
        if (/\.vite\/deps\//.test(u)) {
            const pkg = depPkg(u, cf.lineNumber);
            if (pkg === 'three') return 'three.js';
            if (/^@xterm/.test(pkg)) return 'xterm';
            if (/^(react|react-dom|scheduler|@react-three|its-fine|zustand|suspend-react)/.test(pkg)) return 'react/r3f';
            return `deps:${pkg}`;
        }
        if (/glyph3d-core\/src/.test(u)) return 'core';
        if (/glyph3d-r3f/.test(u)) return 'r3f binding';
        if (/\/app\//.test(u)) return 'app';
        if (/\/tools\//.test(u) || /^(pptr|debugger):|__playwright|UtilityScript/.test(u)) return 'harness';
        return 'wall';
    };
    const label = (n) => {
        const cf = n.callFrame, fn = cf.functionName || '(anon)';
        if (!cf.url) return fn;
        if (/\.vite\/deps\//.test(cf.url)) return `${fn} [${depPkg(cf.url, cf.lineNumber)}]`;
        return `${fn} ${rel(cf.url)}:${cf.lineNumber + 1}`;
    };
    const skip = (n) => n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)' || n.callFrame.functionName === '(root)';
    const buckets = {}, fns = new Map(), callersOf = new Map(), incl = new Map();
    let total = 0, programMs = 0, idleMs = 0;
    for (const [id, ms] of self) {
        const n = byId.get(id);
        if (n.callFrame.functionName === '(program)') programMs += ms;   // native main-thread work outside JS
        if (n.callFrame.functionName === '(idle)') idleMs += ms;
        if (skip(n)) continue;
        total += ms;
        const b = bucketOf(n.callFrame);
        buckets[b] = (buckets[b] ?? 0) + ms;
        const key = label(n);
        fns.set(key, (fns.get(key) ?? 0) + ms);
        // Dominant caller chain (three distinct frames up).
        const chain = []; let below = key;
        for (let p = parentOf.get(id); p != null && chain.length < 3; p = parentOf.get(p)) {
            const pn = byId.get(p); if (skip(pn)) break;
            const f = label(pn); if (f !== below) chain.push(f); below = f;
        }
        const cm = callersOf.get(key) ?? callersOf.set(key, new Map()).get(key);
        const ck = chain.join(' ← ');
        cm.set(ck, (cm.get(ck) ?? 0) + ms);
        // Inclusive: this node's self time counts once toward every distinct OUR-code frame above it.
        const seen = new Set();
        for (let p = id; p != null; p = parentOf.get(p)) {
            const pn = byId.get(p);
            if (skip(pn)) continue;
            const pb = bucketOf(pn.callFrame);
            if (pb !== 'core' && pb !== 'wall' && pb !== 'app' && pb !== 'r3f binding') continue;
            const f = label(pn);
            if (seen.has(f)) continue;
            seen.add(f);
            incl.set(f, (incl.get(f) ?? 0) + ms);
        }
    }
    const share = (ms) => `${(100 * ms / Math.max(total, 1e-9)).toFixed(1)}%`;
    const fmt = (ms) => `${ms.toFixed(1)}ms ${share(ms)}`;
    return {
        busyMs: r2(total), programMs: r2(programMs), idleMs: r2(idleMs),
        buckets: Object.fromEntries(Object.entries(buckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, fmt(v)])),
        topSelf: [...fns].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => {
            const top = [...callersOf.get(k)].sort((a, b) => b[1] - a[1])[0];
            return `${fmt(v)}  ${k}${top?.[0] ? `   ← ${top[0]}` : ''}`;
        }),
        topInclusiveOurs: [...incl].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${fmt(v)}  ${k}`),
    };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const result = { argv: process.argv.slice(2), when: new Date().toISOString(), viewport: [W, H], seq: SEQ, payloadBytes: Object.fromEntries(Object.entries(payloads).map(([k, v]) => [k, { asWritten: v.text.length, crlf: crlf(v.text).length }])) };
const relay = await privateRelay({ port: RELAY, ns: 'glyph-wall-text-perf', reuse: process.argv.includes('--reuse-relay') });
/** The terminals this tool spawned (on the first page; later pages re-adopt them) — the only ones it writes to. */
const OWN = [];
let browser = null;
/** A fresh wall page holding every terminal in OWN (the first one spawns them). */
const openWall = async () => {
    const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 4000, viewport: { width: W, height: H } });
    if (!app.booted) throw new Error('wall did not boot');
    const up = await app.evalPage(async () => {
        for (let i = 0; i < 60 && !window.__wall.snapshot().connected; i++) await new Promise((r) => setTimeout(r, 250));
        return window.__wall.snapshot().relay;
    });
    if (up.state !== 'up') throw new Error(`the wall isn't the relay's display on :${RELAY} (${up.state}${up.reason ? `: ${up.reason}` : ''})`);
    const need = Math.max(...SCALE, 1);
    if (!OWN.length) {
        OWN.push(...await spawnOwnTerminals(app.evalPage, need));
        console.log(`[wtp] spawned ${OWN.length} terminals of its own: ${OWN.join(' ')}`);
    }
    // A fresh page re-adopts them as their adapters notice it (a ping, then a re-create).
    const present = await app.evalPage(async (ids) => {
        for (let i = 0; i < 80 && !ids.every((id) => window.__wall.terminal(id)); i++) await new Promise((r) => setTimeout(r, 250));
        return ids.filter((id) => window.__wall.terminal(id)).length;
    }, OWN);
    if (present < OWN.length) throw new Error(`only ${present} of this tool's ${OWN.length} terminals came back on the fresh page`);
    const gpu = await app.evalPage(() => {
        const gl = window.__glyphClient.ctx.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
                 timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), glMethods: Object.getOwnPropertyNames(WebGL2RenderingContext.prototype) };
    });
    if (/swiftshader|llvmpipe|software/i.test(gpu.renderer)) throw new Error(`software GL renderer (${gpu.renderer}) — numbers would be fiction`);
    app.glMethods = new Set(gpu.glMethods);
    delete gpu.glMethods;
    result.gpu ??= gpu;
    return app;
};
const closeWall = async (app) => { await app.evalPage(() => window.__wtp?.uninstall()); if (app.errors.length) (result.errors ??= []).push(...app.errors.slice(0, 5)); await app.close(); };
const mb = (b) => (b / 1e6).toFixed(2);

try {
    browser = await launchGpuBrowser({});
    // ── IDLE ────────────────────────────────────────────────────────────────────────────────────
    if (MODES.includes('idle')) {
        const app = await openWall();
        result.info = await app.evalPage(installProbe, { S, light: false, own: OWN });
        result.idle = [];
        for (const poseName of ['overview', 'framed']) {
            const pose = await app.evalPage((p) => window.__wtp.reset(p), poseName);
            const win = await app.evalPage(async () => { const t0 = performance.now(); await new Promise((res) => setTimeout(res, 3000)); return { t0, t1: performance.now() }; });
            const s = summarize(await app.evalPage(() => window.__wtp.drain()), win.t0, win.t1, result.info.terminals.length, { wholeWindow: true });
            result.idle.push({ pose: poseName, ...pose, ...s });
            const f = s.displayFrames || 1, a = s.stageMs;
            console.log(`IDLE  ${poseName.padEnd(8)} ${s.displayFrames} frames @ ${s.fps} fps · per frame: busy p50 ${s.perDisplayFrameMs.busy.p50} p95 ${s.perDisplayFrameMs.busy.p95} ms, render p50 ${s.perDisplayFrameMs.render.p50} ms · uploads/frame: buffer ${Math.round(s.uploads.bufferBytes / f)} B in ${(s.uploads.bufferCalls / f).toFixed(1)} calls (${(a.render.uploadBuffer / f).toFixed(3)} ms), texture ${Math.round(s.uploads.textureBytes / f)} B in ${(s.uploads.textureCalls / f).toFixed(1)} calls (${(a.render.uploadTexture / f).toFixed(3)} ms) · applyScreens ${s.applyScreens}, OUTPUT frames ${s.outputFrames} (${s.bytesIn} B) · gap p50 ${s.gapMs.p50} p95 ${s.gapMs.p95} max ${s.gapMs.max} · gpu p50 ${s.gpuMs.p50} p95 ${s.gpuMs.p95}`);
        }
        await closeWall(app);
    }

    // ── FLOOD ───────────────────────────────────────────────────────────────────────────────────
    if (MODES.includes('flood')) {
        const app = await openWall();
        const floodInfo = await app.evalPage(installProbe, { S, light: false, own: OWN });
        result.info ??= floodInfo;
        console.log(`[gpu] ${result.gpu.renderer} · canvas ${result.gpu.canvas.join('×')} · ${result.info.terminals.length} terminals, ${result.info.terminals[0].cols}×${result.info.terminals[0].rows}, ${result.info.terminals[0].instances} instances each (${result.info.terminals[0].instanceBufferBytes} B instance buffer) · atlas ${result.info.atlas.glyphs} glyphs, ${result.info.atlas.fields} fields`);
        if (result.info.missing.length) console.log(`[probe] could not wrap: ${result.info.missing.join(', ')}`);
        result.flood = [];
        let base = 1000;
        for (const source of SOURCES) for (const [pname, p] of Object.entries(payloads)) for (const n of SCALE) {
            const pose = await app.evalPage(() => window.__wtp.reset('overview'));
            const run = source === 'direct'
                ? await app.evalPage(({ n, text }) => window.__wtp.floodDirect(n, text), { n, text: '\x1b[2J\x1b[H' + crlf(p.text) })
                : await app.evalPage(({ n, cmd, base }) => window.__wtp.floodShell(n, cmd, base), { n, cmd: p.cmd, base: (base += 100) });
            const E = await app.evalPage(() => window.__wtp.drain());
            const s = summarize(E, run.t0, run.t1, result.info.terminals.length);
            const digestMs = (s.lastApplyEnd ?? run.t1) - (s.firstWrite ?? run.t0);
            const produced = source === 'direct' ? run.bytesPerTerminal : p.text.length;
            const row = {
                source, payload: pname, terminals: n, pose,
                producedBytesPerTerminal: produced, digestMs: r2(digestMs),
                throughput: {
                    receivedBytesPerSec: Math.round(s.bytesIn / (digestMs / 1000)),
                    receivedBytesPerSecPerTerminal: Math.round(s.bytesIn / n / (digestMs / 1000)),
                    producedBytesPerSecPerTerminal: Math.round(produced / (digestMs / 1000)),
                },
                ...s,
            };
            result.flood.push(row);
            const a = s.stageMs;
            console.log(`FLOOD ${source.padEnd(6)} ${pname.padEnd(6)} ×${String(n).padEnd(2)} ${String(Math.round(digestMs)).padStart(6)} ms · in ${mb(s.bytesIn)} MB (${mb(row.throughput.receivedBytesPerSecPerTerminal)} MB/s/term; program wrote ${mb(produced)} MB → ${mb(row.throughput.producedBytesPerSecPerTerminal)} MB/s/term) · ${s.outputFrames} out-frames, ${s.applyScreens} applyScreens, ${s.displayFrames} frames @ ${s.fps} fps`);
            console.log(`      main ms: parse ${a.parse} · readScreen ${a.readScreen} · apply ${a.apply.total} (ensure ${a.apply.ensureAtlas}, cells ${a.apply.cells}, diff ${a.apply.diff}, pose ${a.apply.pose}, spans ${a.apply.spans}) · render ${a.render.cpu} (upload buf ${a.render.uploadBuffer} / tex ${a.render.uploadTexture}) · raf other ${a.rafOther}`);
            console.log(`      per applyScreen: read ${s.perApplyScreen.readScreenMs} + apply ${s.perApplyScreen.applyMs} ms, upload ${s.perApplyScreen.uploadBytes} B · parse ${s.parseMsPerMB} ms/MB · frame busy p50 ${s.perDisplayFrameMs.busy.p50} p95 ${s.perDisplayFrameMs.busy.p95} max ${s.perDisplayFrameMs.busy.max} · gap p50 ${s.gapMs.p50} p95 ${s.gapMs.p95} max ${s.gapMs.max} (>33ms: ${s.gapMs.over33}) · long tasks ${s.longTasks.count} (max ${s.longTasks.maxMs} ms) · gpu p50 ${s.gpuMs.p50} p95 ${s.gpuMs.p95}`);
        }
        await closeWall(app);
    }

    // ── COLD ────────────────────────────────────────────────────────────────────────────────────
    if (MODES.includes('cold')) {
        const app = await openWall();
        const info = await app.evalPage(installProbe, { S, light: false, own: OWN });
        result.info ??= info;
        const pose = await app.evalPage(() => window.__wtp.reset('framed', 0));
        result.cold = { pose, atlasAtStart: info.atlas, classes: Object.fromEntries(Object.entries(BURSTS).map(([k, v]) => [k, { distinct: v.cps.length, note: v.note }])), bursts: [] };
        const one = async (label, kind, text, cells, distinct) => {
            const b = await app.evalPage(({ text }) => window.__wtp.burst(0, text), { text });
            const E = await app.evalPage(() => window.__wtp.drain());
            const split = coldSplit(E, b);
            result.cold.bursts.push({ label, kind, cells, distinct, ...split });
            if (split.error) { console.log(`COLD ${label.padEnd(16)} ${kind.padEnd(5)} ${split.error}`); return; }
            const s = split.split, a = split.applyScreen, rr = split.render;
            console.log(`COLD ${label.padEnd(16)} ${kind.padEnd(5)} total ${String(split.totalMs).padStart(7)} ms = parse ${s.parse} + rAF wait ${s.waitForRaf} + read ${s.readScreen} + apply ${s.applyScreen} + →render ${s.applyToRenderStart} + render ${s.renderCpu} + gpu ${s.gpuFinish} (pass ${split.gpuPassMs}) | atlas +${split.atlas.after.glyphs - split.atlas.before.glyphs} (→${split.atlas.after.glyphs})`);
            if (kind === 'cold') console.log(`      between apply and render: ${split.betweenApplyAndRender.wallMs} ms wall, ${split.betweenApplyAndRender.mainThreadBusyMs} ms main-thread busy · long tasks ${split.longTasks.count} (max ${split.longTasks.maxMs} ms)${split.logs.length ? ` · ${split.logs.map((l) => l.slice(0, 110)).join(' | ')}` : ''}`);
            console.log(`      apply: shape lookups ${a.shapeLookups} (${a.shapeCalls} shapes) · outlines ${a.outlineExtraction} · build textures ${a.buildTextures} · bitmap slots ${a.bitmapSlots} · emoji refresh ${a.emojiRefresh} · hot-swap ${a.fieldHotSwap} (${a.fieldsSwapped} fields) · spans ${a.spans} · cells+rest ${a.cellsAndRest} | render: tex ${rr.uploadTextureMs} ms / ${rr.uploadTextureBytes} B, buf ${rr.uploadBufferMs} ms / ${rr.uploadBufferBytes} B, programs ${rr.glProgramMs} ms (${rr.glProgramCalls} calls) | after: render ${split.framesAfter.renderCpuMs.join(' ')} · worst gap ${split.framesAfter.worstGapMs} · programs ${split.framesAfter.glProgramMs} ms`);
        };
        for (let k = 0; k < 3; k++) await one('ascii', 'warm', rowsOf(BURSTS.ascii.cps, BURSTS.ascii.perRow), 20 * 78, BURSTS.ascii.cps.length);
        for (const cls of COLD_ORDER) {
            const b = BURSTS[cls], text = rowsOf(b.cps, b.perRow);
            await one(cls, 'cold', text, 20 * b.perRow, Math.min(b.cps.length, 20 * b.perRow));
            for (let k = 0; k < 3; k++) await one(cls, 'warm', text, 20 * b.perRow, Math.min(b.cps.length, 20 * b.perRow));
        }
        await one('ascii (after)', 'warm', rowsOf(BURSTS.ascii.cps, BURSTS.ascii.perRow), 20 * 78, BURSTS.ascii.cps.length);
        for (const cp of SINGLES) await one(`single U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, 'cold', String.fromCodePoint(cp), 1, 1);
        result.cold.atlasAtEnd = (await app.evalPage(() => window.__wtp.info())).atlas;
        await closeWall(app);
    }

    // ── PROFILE ─────────────────────────────────────────────────────────────────────────────────
    if (MODES.includes('profile')) {
        const app = await openWall();
        await app.evalPage(installProbe, { S, light: true, own: OWN });
        const cdp = await app.page.context().newCDPSession(app.page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        result.profile = {};
        const profiled = async (label, fn) => {
            await cdp.send('Profiler.start');
            const t0 = Date.now();
            await fn();
            const { profile } = await cdp.send('Profiler.stop');
            const a = await analyzeProfile(profile, app.glMethods);
            result.profile[label] = { wallMs: Date.now() - t0, ...a };
            console.log(`PROFILE ${label}: ${a.busyMs} ms busy in JS (+ ${a.programMs} ms "(program)": native, outside JS) in ${Date.now() - t0} ms`);
            console.log(`   buckets: ${Object.entries(a.buckets).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
            for (const l of a.topSelf.slice(0, 14)) console.log(`   ${l}`);
        };
        const seq = payloads.seq ?? Object.values(payloads)[0];
        const nMax = Math.max(...SCALE);
        await app.evalPage(() => window.__wtp.reset('overview'));
        await profiled('direct flood ×1', () => app.evalPage(({ text }) => window.__wtp.floodDirect(1, text), { text: '\x1b[2J\x1b[H' + crlf(seq.text) }));
        await app.evalPage(() => window.__wtp.reset('overview'));
        await profiled(`direct flood ×${nMax}`, () => app.evalPage(({ n, text }) => window.__wtp.floodDirect(n, text), { n: nMax, text: '\x1b[2J\x1b[H' + crlf(seq.text) }));
        await app.evalPage(() => window.__wtp.reset('overview'));
        await profiled(`shell flood ×${nMax}`, () => app.evalPage(({ n, cmd }) => window.__wtp.floodShell(n, cmd, 9000), { n: nMax, cmd: seq.cmd }));
        await app.evalPage(() => window.__wtp.reset('framed', 0));
        await profiled(`cold bursts (${COLD_ORDER.join(', ')}, 8 singles)`, async () => {
            for (const cls of COLD_ORDER) await app.evalPage(({ text }) => window.__wtp.burstLight(0, text), { text: rowsOf(BURSTS[cls].cps, BURSTS[cls].perRow) });
            for (const cp of SINGLES) await app.evalPage(({ text }) => window.__wtp.burstLight(0, text), { text: String.fromCodePoint(cp) });
        });
        await closeWall(app);
    }

    if (result.errors?.length) console.log('[page errors]', result.errors);
    if (OUT) { writeFileSync(OUT, JSON.stringify(result, null, 2)); console.log(`[json] ${OUT}`); }
} finally {
    // Kill this tool's own terminals (a reused relay keeps everyone else's), then the relay it started.
    if (browser && OWN.length) {
        try {
            for (const p of browser.contexts().flatMap((c) => c.pages())) await p.close();   // the relay takes one display
            const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 1500, viewport: { width: 800, height: 600 } });
            await app.evalPage(async (ids) => { for (let i = 0; i < 40 && !ids.every((id) => window.__wall.terminal(id)); i++) await new Promise((r) => setTimeout(r, 250)); for (const id of ids) await window.__wall.kill(id); }, OWN);
            await app.waitFor(1000);
        } catch (e) { console.log(`[wtp] couldn't kill its terminals (${e.message}) — ${relay.started ? 'the relay stop takes them' : 'kill them by hand: ' + OWN.join(' ')}`); }
    }
    await browser?.close();
    await relay.stop();
}
