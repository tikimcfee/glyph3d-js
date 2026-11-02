#!/usr/bin/env bun
// plane-live-check.mjs — the plane's FELT properties, measured on the live display (the relay's one
// DISPLAY — tools/agent-display.mjs headless, or a person's browser). The headless gates lock the
// math; this measures what a reader gets, end to end, through the same verbs.
//
//   bun tools/plane-live-check.mjs --desk <plane desk> [--back <another plane desk>]
//                                  [--port 8080] [--reload] [--gate] [--out-dir <dir>]
//
// Measures (and with --gate, asserts):
//   enter     carrel.enter → the plane view landed (plane.state not tweening), ms; attention is on the
//             focused member BEFORE the camera lands (the first key goes where you looked)
//   readable  the landed frame's text: row pitch, advance (tools/lib/pixel-metrics) at the plane cell
//   switch    with --back: carrel.enter <back> then carrel.back while entered → landed, ms (≤ 200)
//   leave     carrel.leave → back in the open world with camera.info EXACTLY as before entering
//   reload    with --reload: enter, reload the page → re-entered and landed again, ms (the Entered
//             fact converging after the restore)
//
// It MOVES THE CAMERA on the live display — run it on the agents' display, or warn the person first.

import { dialRelay } from './lib/relay.mjs';
import { decodePng, cropImage, measureRowPitch, measureGlyphScale, writePng } from './lib/pixel-metrics.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const desk = opt('desk');
const back = opt('back');
const port = Number(opt('port', '8080'));
const gate = flag('gate');
const outDir = opt('out-dir');
if (!desk) { console.error('usage: bun tools/plane-live-check.mjs --desk <plane desk> [--back <desk>] [--reload] [--gate]'); process.exit(2); }

let relay = await dialRelay(port);
const req = async (line, ms = 8000) => relay.request(line, ms);
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
const report = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${name.padEnd(9)} ${detail}`);
};

/** Poll plane.state until `pred(state)` — returns ms waited, or null on timeout. */
async function until(pred, { timeoutMs = 10000, everyMs = 16 } = {}) {
    const t0 = now();
    while (now() - t0 < timeoutMs) {
        let s = null;
        try { s = (await req('plane.state', 2000)).data; } catch { /* the display may be reloading */ }
        if (pred(s)) return now() - t0;
        await sleep(everyMs);
    }
    return null;
}
const landed = (target) => (s) => s && !s.tweening && (!target || s.target === `carrel:${target}`);

/** Screenshot the display and measure its center: row pitch + advance at the plane cell. */
async function readability(tag) {
    const r = await req('screenshot', 15000);
    const img = decodePng(Buffer.from(r.data.image, 'base64'));
    if (outDir) writePng(`${outDir}/plane-live-${tag}.png`, img);
    const w = img.width, h = img.height;
    const crop = cropImage(img, { x: Math.round(w * 0.15), y: Math.round(h * 0.2), w: Math.round(w * 0.7), h: Math.round(h * 0.6) });
    const pitch = measureRowPitch(crop);
    const scale = measureGlyphScale(crop, {});
    // The autocorrelation pitch: robust to blank lines inside the crop (a median of row gaps isn't).
    return { pitch: pitch?.autocorrPitchPx ?? pitch?.pitchPx ?? null, advance: scale?.measuredAdvancePx ?? null };
}

const cellPx = Number((await req('settings.get plane.cellPx')).data?.value ?? 8);
const rowPx = cellPx * 15 / 8;

// ── enter ──
const pre = (await req('camera.info')).data;
if ((await req('plane.state')).data) { await req('carrel.leave'); await until((s) => !s); }
const t0 = now();
const e = await req(`carrel.enter ${desk}`);
if (!/^OK/.test(e.text ?? '')) { console.error(`carrel.enter ${desk}: ${e.text}`); process.exit(1); }
const att = (await req('attention.info')).data;
const focus = e.data?.focus ?? null;
const midTween = (await req('plane.state')).data?.tweening;
const enterMs = await until(landed(desk));
report('enter', enterMs != null, enterMs != null ? `${Math.round(now() - t0)} ms to land (plane.enterMs ease)` : 'never landed');
report('attention', !focus || att?.primary?.id === focus, `primary '${att?.primary?.id ?? 'none'}' ${midTween ? 'while the camera was still easing' : '(tween already over)'} — focus '${focus ?? 'none'}'`);

// ── readable ──
const rd = await readability('enter');
const pitchOk = rd.pitch != null && Math.abs(rd.pitch - rowPx) <= 0.15;
const advOk = rd.advance != null && Math.abs(rd.advance - cellPx) / cellPx <= 0.01;
report('readable', pitchOk && advOk, `row pitch ${rd.pitch?.toFixed(3)} px (want ${rowPx}), advance ${rd.advance?.toFixed(3)} px (want ${cellPx})`);

// ── switch ──
if (back) {
    await req(`carrel.enter ${back}`);
    const toBack = await until(landed(back), { everyMs: 8 });
    const t1 = now();
    await req('carrel.back');
    const sw = await until(landed(desk), { everyMs: 8 });
    const swMs = sw == null ? null : now() - t1;
    report('switch', swMs != null && swMs <= 200, swMs == null ? 'carrel.back never landed' : `carrel.back landed in ${Math.round(swMs)} ms (≤ 200; to '${back}' took ${Math.round(toBack ?? -1)} ms)`);
}

// ── leave ──
await req('carrel.leave');
const left = await until((s) => !s);
const post = (await req('camera.info')).data;
const same = JSON.stringify(post) === JSON.stringify(pre);
report('leave', left != null && same, same ? 'camera.info bit-exact with before entering' : `camera.info moved: before ${JSON.stringify(pre)} after ${JSON.stringify(post)}`);

// ── reload ──
if (flag('reload')) {
    await req(`carrel.enter ${desk}`);
    await until(landed(desk));
    await sleep(1500);   // let the autosave catch the Entered fact
    await req('reload');
    const t2 = now();
    await sleep(500);
    relay.close();
    relay = await dialRelay(port);
    const rl = await until(landed(desk), { timeoutMs: 120000, everyMs: 100 });
    report('reload', rl != null, rl != null ? `re-entered and landed ${Math.round(now() - t2)} ms after the reload` : 'never re-entered within 120 s');
    if (rl != null) {
        const rr = await readability('reload');
        report('reloaded', rr.pitch != null && Math.abs(rr.pitch - rowPx) <= 0.15, `after the reload: row pitch ${rr.pitch?.toFixed(3)} px, advance ${rr.advance?.toFixed(3)} px`);
        await req('carrel.leave');
        await until((s) => !s);
    }
}

relay.close();
console.log(`${failed ? 'FAIL' : 'ok'} plane-live-check: ${results.length - failed}/${results.length}`);
process.exit(gate && failed ? 1 : 0);
