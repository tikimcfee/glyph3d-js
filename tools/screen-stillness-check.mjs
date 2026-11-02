// screen-stillness-check.mjs — a STREAMING agent screen read in a plane stays still where it didn't change,
// and its stems are crisp: measured on the live display (the relay's one DISPLAY), end to end.
//
//   bun tools/screen-stillness-check.mjs --desk <plane desk> --screen <terminal id, e.g. gx-<agent>>
//        [--port 8080] [--pairs 4] [--interval-ms 800] [--allow-idle] [--gate] [--out-dir <dir>]
//
// What it does: enters the desk (if it isn't the plane being read), focuses the screen's pin (the plane
// aims at it), works out where the pin's cell rows land on screen (the pin's board rect through
// plane.state's origin/aim/scale; the row phase from the text: blank rows carry no ink), then takes
// `--pairs` pairs of captures `--interval-ms` apart, each bracketed by terminal.read.
//
// Measures (and with --gate, asserts):
//   still     every row whose TEXT didn't change across a pair (all four reads equal; the cursor's row
//             left out — its block is drawn) is PIXEL-IDENTICAL in both captures (tolerance 0)
//   streaming the screen changed text during the run (rows that changed) — a still screen proves less;
//             --gate fails an idle run unless --allow-idle
//   crisp     vertical stems step in ~1 px (pixel-metrics' edge ramp: median vertical-stem ramp ≤ 1.25 px
//             at the plane cell) on the visible pin
//   teeth     the same capture shifted half a pixel FAILS crisp, and one re-laid by a pixel FAILS still —
//             the checks can fail (run every time, on the real capture)
//
// It MOVES THE CAMERA on the live display (enters the desk, focuses the pin) — run it on the agents'
// display, or warn the person first.

import { dialRelay } from './lib/relay.mjs';
import { decodePng, writePng, cropImage, measureEdgeCrispness } from './lib/pixel-metrics.mjs';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const desk = opt('desk', null), screen = opt('screen', null);
if (!desk || !screen) { console.error('usage: bun tools/screen-stillness-check.mjs --desk <plane desk> --screen <terminal id> [--port 8080] [--pairs 4] [--interval-ms 800] [--allow-idle] [--gate] [--out-dir <dir>]'); process.exit(2); }
const port = Number(opt('port', 8080)), pairs = Math.max(1, Number(opt('pairs', 4))), intervalMs = Number(opt('interval-ms', 800));
const gate = flag('gate'), allowIdle = flag('allow-idle'), outDir = opt('out-dir', null);
if (outDir) mkdirSync(outDir, { recursive: true });
const STEM_MAX = 1.25;   // px: a crisp vertical stem's median ramp at a whole-pixel cell

const relay = await dialRelay(port);
const req = async (line, ms = 10000) => relay.request(line, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(pred, timeoutMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const s = (await req('plane.state')).data;
        if (pred(s)) return s;
        await sleep(50);
    }
    return null;
}
const shot = async () => decodePng(Buffer.from((await req('screenshot', 15000)).data.image, 'base64'));
const read = async () => (await req(`terminal.read ${screen}`)).data;

// ── into the plane, onto the pin ──────────────────────────────────────────────────────────────────
let st = (await req('plane.state')).data;
if (st?.target !== `carrel:${desk}`) {
    const e = await req(`carrel.enter ${desk}`);
    if (!/^OK/.test(e.text ?? '')) { console.error(`carrel.enter ${desk}: ${e.text}`); process.exit(1); }
}
const f = await req(`pane.focus ${screen}`);
if (!/^OK/.test(f.text ?? '')) { console.error(`pane.focus ${screen}: ${f.text}`); process.exit(1); }
st = await settle((s) => s && !s.tweening && s.target === `carrel:${desk}`);
if (!st) { console.error('the plane never landed'); process.exit(1); }
await sleep(300);
const pin = (await req('pane.list')).data?.pins?.find((p) => p.id === screen);
if (!pin) { console.error(`no pin '${screen}' on ${desk}`); process.exit(1); }
const k = st.pxPerUnit, W = st.viewport.width, H = st.viewport.height;
// A board point (device px from the board's top-left) → the screen: plane coords from the origin, then the aim.
const toScreen = (bx, by) => ({ x: W / 2 + (st.origin.x + bx / k - st.aim.x) * k, y: H / 2 - (st.origin.y - by / k - st.aim.y) * k });
const tl = toScreen(pin.rect.x, pin.rect.y);
const pinBox = { x: Math.round(tl.x), y: Math.round(tl.y), w: pin.rect.w, h: pin.rect.h };
const cellPx = Number((await req('settings.get plane.cellPx')).data?.value ?? 8);
const rowPx = cellPx * 15 / 8;

// ── where the rows are: the phase at which blank rows carry no ink ────────────────────────────────
const t0 = await read();
const A0 = await shot();
const vis = { x0: Math.max(0, pinBox.x), x1: Math.min(W, pinBox.x + pinBox.w), y0: Math.max(0, pinBox.y), y1: Math.min(H, pinBox.y + pinBox.h) };
const px = (img, x, y) => { const o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
const bg = (() => { const m = new Map(); for (let y = vis.y0; y < vis.y1; y += 3) for (let x = vis.x0; x < vis.x1; x += 3) { const key = px(A0, x, y).join(','); m.set(key, (m.get(key) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number); })();
const ink = (img, y) => { let n = 0; for (let x = vis.x0; x < vis.x1; x++) { const p = px(img, x, y); if (Math.max(Math.abs(p[0] - bg[0]), Math.abs(p[1] - bg[1]), Math.abs(p[2] - bg[2])) > 24) n++; } return n; };
const inkRow = []; for (let y = 0; y < H; y++) inkRow[y] = y >= vis.y0 && y < vis.y1 ? ink(A0, y) : 0;
let best = null;
for (let dy = 0; dy < rowPx * 2; dy++) {
    let score = 0;
    t0.lines.forEach((line, i) => {
        const y0 = pinBox.y + dy + i * rowPx;
        let n = 0; for (let y = Math.max(vis.y0, y0); y < Math.min(vis.y1, y0 + rowPx); y++) n += inkRow[y];
        score += line.trim() ? Math.min(n, 1) : -n;
    });
    if (!best || score > best.score) best = { dy, score };
}
const band = (i) => ({ y0: pinBox.y + best.dy + i * rowPx, y1: pinBox.y + best.dy + (i + 1) * rowPx });
const visibleRow = (i) => band(i).y0 >= vis.y0 && band(i).y1 <= vis.y1;

// ── pairs of captures ───────────────────────────────────────────────────────────────────────────
const bandDiff = (a, b, i, dyB = 0) => {
    const { y0, y1 } = band(i);
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = vis.x0; x < vis.x1; x++) {
        const o = (y * a.width + x) * 4, ob = ((y + dyB) * b.width + x) * 4;
        if (a.data[o] !== b.data[ob] || a.data[o + 1] !== b.data[ob + 1] || a.data[o + 2] !== b.data[ob + 2]) n++;
    }
    return n;
};
let stableRows = 0, stableInkRows = 0, changedPx = 0, textChanged = 0, worst = null;
let firstA = null, firstStable = [];
for (let p = 0; p < pairs; p++) {
    const r0 = await read(); const A = await shot(); const r1 = await read();
    await sleep(intervalMs);
    const r2 = await read(); const B = await shot(); const r3 = await read();
    if (outDir) { writePng(`${outDir}/stillness-${p}-a.png`, A); writePng(`${outDir}/stillness-${p}-b.png`, B); }
    const cursorRows = new Set([r0, r1, r2, r3].map((r) => r.cursor?.y).filter((y) => Number.isInteger(y)));
    for (let i = 0; i < r0.lines.length; i++) {
        const same = r0.lines[i] === r1.lines[i] && r1.lines[i] === r2.lines[i] && r2.lines[i] === r3.lines[i];
        if (!same) { textChanged++; continue; }
        if (cursorRows.has(i) || !visibleRow(i)) continue;
        const d = bandDiff(A, B, i);
        stableRows++;
        if (r0.lines[i].trim()) stableInkRows++;
        changedPx += d;
        if (d && (!worst || d > worst.px)) worst = { pair: p, row: i, px: d, text: r0.lines[i].slice(0, 60) };
        if (p === 0 && r0.lines[i].trim()) firstStable.push(i);
    }
    if (p === 0) firstA = A;
}

// ── crisp stems on the visible pin ────────────────────────────────────────────────────────────────
const crop = cropImage(firstA, { x: vis.x0, y: vis.y0, w: vis.x1 - vis.x0, h: vis.y1 - vis.y0 });
const crisp = measureEdgeCrispness(crop);
const stem = crisp.verticalStemRampPx;

// ── teeth: the same capture, drifted half a pixel / re-laid by one, must fail ──────────────────────
const halfShift = (img) => {
    const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
    for (let y = 0; y < img.height; y++) for (let x = 1; x < img.width; x++) for (let c = 0; c < 3; c++) {
        const o = (y * img.width + x) * 4 + c;
        out.data[o] = (img.data[o] + img.data[o - 4] + 1) >> 1;
    }
    return out;
};
const teethStem = measureEdgeCrispness(halfShift(crop)).verticalStemRampPx;
const teethRelaid = firstStable.filter((i) => band(i).y1 + 1 <= vis.y1).reduce((n, i) => n + bandDiff(firstA, firstA, i, 1), 0);

// ── report ────────────────────────────────────────────────────────────────────────────────────────
const results = [];
const report = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name.padEnd(9)} ${detail}`); };
console.log(`screen ${screen} on ${desk}: ${t0.cols}×${t0.rows}, pin ${pin.rect.w}×${pin.rect.h} at screen (${pinBox.x}, ${pinBox.y}), rows from +${best.dy} px, ${rowPx} px apart; visible rows ${t0.lines.filter((_, i) => visibleRow(i)).length}`);
report('still', stableInkRows > 0 && changedPx === 0, `${stableRows} unchanged rows (${stableInkRows} with text) over ${pairs} pair(s): ${changedPx} px changed${worst ? ` — worst row ${worst.row} «${worst.text}» ${worst.px} px (pair ${worst.pair})` : ''}`);
report('streaming', textChanged > 0 || allowIdle, `${textChanged} row-changes in text during the run${textChanged ? '' : ' — the screen was idle (a streaming run proves more; --allow-idle to accept)'}`);
report('crisp', stem != null && stem <= STEM_MAX, `vertical stems ${stem?.toFixed(3)} px (≤ ${STEM_MAX}; median ramp ${crisp.rampWidthMedianPx?.toFixed(3)} px)`);
report('teeth', teethStem > STEM_MAX && teethRelaid > 0, `the capture drifted ½ px → stems ${teethStem?.toFixed(3)} px (fails crisp); re-laid by 1 px → ${teethRelaid} px changed (fails still)`);
relay.close();
const failed = results.filter((r) => !r.ok).length;
if (gate) process.exit(failed ? 1 : 0);
