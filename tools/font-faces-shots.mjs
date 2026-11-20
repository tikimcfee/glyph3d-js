/**
 * font-faces-shots.mjs — the wall's terminals in each font family, photographed for a person to
 * compare: the test pattern (tools/term-test-pattern.sh) and a text sample (tools/font-sample.sh:
 * the four faces, code, prose, look-alikes, accents) in every family, and two sheets with every
 * family side by side.
 *
 *   bun tools/font-faces-shots.mjs --url http://localhost:5180/ --relay 8099 --out DIR [--families a,b]
 *
 * Needs the wall's Vite and a built glyph3d-cli. Starts its own relay on --relay
 * (tools/lib/wall-relay.mjs: its own termd namespace, no gomuxai; refuses a port something already
 * listens on) and two 80 × 24 terminals — one runs the pattern, one the sample, both then sleep —
 * and moves them from family to family with `wall.config fontFamily` (the knob a person turns:
 * live, cols × rows unchanged). Families default to every one the font chain has
 * (fonts/families.js). Into DIR, per family:
 *
 *   <family>-pattern-fit.png       the pattern's terminal as the wall frames it
 *   <family>-pattern-close.png     61.7 px lines over the styles and the combining marks
 *   <family>-sample-fit.png        the sample's terminal as the wall frames it
 *   <family>-sample-reading.png    16.3 px lines (a reading size; fractional on purpose)
 *   <family>-sample-close.png      61.7 px lines over the four faces
 *   <family>-sample-close-code.png 61.7 px lines over the code
 * and, across the families:
 *   sheet-reading.png              every family's sample at 16.3 px lines, side by side
 *   sheet-faces-close.png          every family's four faces at 44.3 px lines, stacked
 *
 * An instrument: it judges nothing (tools/wall-cells-check.mjs reads the pixels).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay } from './lib/wall-relay.mjs';
import { FONT_FAMILIES, FONT_FAMILY_IDS } from '../packages/glyph3d-core/src/fonts/families.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const OUT = arg('--out', null);
const FAMILIES = arg('--families', FONT_FAMILY_IDS.join(',')).split(',').filter(Boolean);
if (!OUT) { console.error('usage: bun tools/font-faces-shots.mjs --url <wall vite> --relay <free port> --out <dir> [--families a,b]'); process.exit(2); }
const unknown = FAMILIES.filter((f) => !FONT_FAMILIES[f]);
if (unknown.length) { console.error(`unknown famil${unknown.length > 1 ? 'ies' : 'y'} ${unknown.join(', ')} (the chain has: ${FONT_FAMILY_IDS.join(', ')})`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLS = 80, ROWS = 24;
const VIEW = { width: 1600, height: 1000 };

/**
 * Per terminal, the shots: a name, the line height on screen (CSS px; null = the wall's own framing)
 * and the cell to centre on — or `left`: the terminal's first column that many px from the page's
 * left edge (so every family's line starts at the same place, whatever its cell's width).
 */
const SHOTS = {
    pattern: [
        { name: 'pattern-fit', linePx: null },
        { name: 'pattern-close', linePx: 61.7, col: 24, row: 19 },
    ],
    sample: [
        { name: 'sample-fit', linePx: null },
        { name: 'sample-reading', linePx: 16.3, col: COLS / 2, row: ROWS / 2 - 0.5, sheet: 'reading' },
        { name: 'sample-close', linePx: 61.7, col: 24, row: 1.6 },
        { name: 'sample-close-code', linePx: 61.7, col: 24, row: 8 },
        { name: 'sample-faces', linePx: 44.3, left: 14, row: 1.5, sheet: 'faces', keep: false },
    ],
};

const relay = await privateRelay({ port: RELAY, ns: 'glyph-faces-shots' });
let browser = null;
let code = 0;
try {
    browser = await launchGpuBrowser({});
    const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 3000, viewport: VIEW });
    const page = app.page;
    const W = (fn, a) => app.evalPage(fn, a);
    const until = async (fn, a, ms = 20000) => {
        const t = Date.now();
        let v;
        while (!(v = await W(fn, a).catch(() => null)) && Date.now() - t < ms) await page.waitForTimeout(100);
        return v;
    };
    if (!app.booted || !await until(() => window.__wall?.snapshot().connected)) throw new Error(`the wall didn't boot and connect to the relay on :${RELAY}`);

    const spawn = async (script, marker) => {
        const before = await W(() => window.__wall.order.length);
        const r = await W(async (argv) => (await window.__wall.router.execute(argv)).text,
            ['terminal.spawn', String(COLS), String(ROWS), '--', 'sh', '-c', `sh '${path.join(HERE, script)}'; exec sleep 3600`]);
        const id = await until((n) => window.__wall.order[n] ?? null, before);
        if (!id) throw new Error(`${script}'s terminal never landed (${r})`);
        if (!await until(([i, m]) => window.__wall.terminal(i).readText().some((l) => l.includes(m)), [id, marker])) throw new Error(`${script} never reached ${id}'s screen`);
        return id;
    };
    const ids = { pattern: await spawn('term-test-pattern.sh', 'The quick brown fox'), sample: await spawn('font-sample.sh', 'combining') };
    // Apart, so a family's bigger cell never puts one terminal over the other.
    await W(([a, b]) => { const w = window.__wall, r = w.terminalRect(a); w.placeBody(b, { x: r.maxX + 400, y: r.maxY }); }, [ids.pattern, ids.sample]);
    await page.mouse.move(2, 2);   // off every bar: a hovered bar shows its buttons
    await W(() => window.__wall.focus(null));

    /** The screen is drawn: every glyph it asked the atlas for has landed, and frames have run since. */
    const drawn = () => W(async () => {
        const frames = (n) => new Promise((r) => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
        await frames(3);
        await window.__wall.ctx.atlas._live?.whenIdle();
        await frames(3);
    });

    /** @type {Record<string, Array<{ family: string, file: string, clip: { x: number, y: number, width: number, height: number } }>>} */
    const sheets = { reading: [], faces: [] };
    for (const family of FAMILIES) {
        const said = await W(async (f) => (await window.__wall.router.execute(['wall.config', 'fontFamily', f])).text, family);
        const cell = await W((i) => { const g = window.__wall.terminal(i); return { family: g.fontFamily, w: g._metrics.charWidth, h: g._metrics.charHeight }; }, ids.sample);
        if (cell.family !== family) throw new Error(`wall.config fontFamily ${family} left the terminals in ${cell.family} (${said})`);
        console.log(`family ${family} (${FONT_FAMILIES[family].label}): cell ${cell.w.toFixed(4)} × ${cell.h.toFixed(4)} world units, ${(cell.w / cell.h).toFixed(4)} wide per high`);
        for (const [which, shots] of Object.entries(SHOTS)) {
            const id = ids[which];
            for (const s of shots) {
                if (s.linePx == null) {
                    await W((i) => window.__wall.frame(i), id);
                } else {
                    await W(([i, linePx, col, row, left, width]) => {
                        const w = window.__wall, g = w.terminal(i), v = w.viewport, m = g._metrics, st = g.cellStride;
                        const zoom = linePx / st.y;
                        const x = left == null ? g.position.x + (col + 0.5) * st.x - m.charWidth * g.scale.x / 2 : g.position.x + (width / 2 - left) / zoom;
                        v.moveTo(x, g.position.y - row * st.y);
                        v.camera.zoom = zoom;
                        v.camera.updateProjectionMatrix();
                    }, [id, s.linePx, s.col ?? null, s.row, s.left ?? null, VIEW.width]);
                }
                await until(() => !window.__wall.viewport.moving);
                await drawn();
                const at = await W((i) => {
                    const w = window.__wall, v = w.viewport, r = w.terminalRect(i), cr = v.canvas.getBoundingClientRect(), b = v.toScreenBox(r);
                    return { linePx: w.terminal(i).cellStride.y * v.zoom, box: { l: cr.left + b.left, t: cr.top + b.top, r: cr.left + b.right, b: cr.top + b.bottom } };
                }, id);
                const file = path.join(OUT, `${family}-${s.name}.png`);
                if (s.keep !== false) {
                    await page.screenshot({ path: file });
                    console.log(`shot  ${file}  (lines ${at.linePx.toFixed(2)} px)`);
                }
                if (s.sheet === 'reading') {
                    // The terminal's own rect (its panel), clipped to the page.
                    const x = Math.max(0, Math.floor(at.box.l)), y = Math.max(0, Math.floor(at.box.t));
                    const clip = { x, y, width: Math.min(VIEW.width, Math.ceil(at.box.r)) - x, height: Math.min(VIEW.height, Math.ceil(at.box.b)) - y };
                    const tile = path.join(OUT, `.tile-reading-${family}.png`);
                    await page.screenshot({ path: tile, clip, scale: 'css' });
                    sheets.reading.push({ family, file: tile, clip });
                } else if (s.sheet === 'faces') {
                    // The four faces' lines: four rows around the centre, the page's width.
                    const h = Math.ceil(at.linePx * 4.4), clip = { x: 0, y: Math.round(VIEW.height / 2 - h / 2), width: VIEW.width, height: h };
                    const tile = path.join(OUT, `.tile-faces-${family}.png`);
                    await page.screenshot({ path: tile, clip, scale: 'css' });
                    sheets.faces.push({ family, file: tile, clip });
                }
            }
        }
    }

    /** Compose tiles into one sheet in the page (a 2D canvas): each under a label naming its family. */
    const compose = async (tiles, columns, out) => {
        const data = tiles.map((t) => ({ label: `${FONT_FAMILIES[t.family].label}   (${t.family})`, b64: readFileSync(t.file).toString('base64'), w: t.clip.width, h: t.clip.height }));
        const png = await W(async ([data, columns]) => {
            const LABEL = 30, GAP = 18, PAD = 18;
            const tw = Math.max(...data.map((d) => d.w)), th = Math.max(...data.map((d) => d.h));
            const rows = Math.ceil(data.length / columns);
            const cv = new OffscreenCanvas(PAD * 2 + columns * tw + (columns - 1) * GAP, PAD * 2 + rows * (th + LABEL) + (rows - 1) * GAP);
            const cx = cv.getContext('2d');
            cx.fillStyle = '#07080b';
            cx.fillRect(0, 0, cv.width, cv.height);
            cx.font = '600 15px system-ui, sans-serif';
            cx.textBaseline = 'middle';
            for (let k = 0; k < data.length; k++) {
                const img = new Image();
                img.src = `data:image/png;base64,${data[k].b64}`;
                await img.decode();
                const x = PAD + (k % columns) * (tw + GAP), y = PAD + Math.floor(k / columns) * (th + LABEL + GAP);
                cx.fillStyle = '#8ef0b8';
                cx.fillText(data[k].label, x + 2, y + LABEL / 2);
                cx.drawImage(img, x, y + LABEL);
            }
            const blob = await cv.convertToBlob({ type: 'image/png' });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(s);
        }, [data, columns]);
        writeFileSync(out, Buffer.from(png, 'base64'));
        for (const t of tiles) rmSync(t.file, { force: true });   // the tiles were the sheet's parts
        console.log(`sheet ${out}  (${tiles.length} families)`);
    };
    if (sheets.reading.length) await compose(sheets.reading, Math.min(2, sheets.reading.length), path.join(OUT, 'sheet-reading.png'));
    if (sheets.faces.length) await compose(sheets.faces, 1, path.join(OUT, 'sheet-faces-close.png'));

    await W(async () => { await window.__wall.router.execute(['wall.config', 'fontFamily', 'default']); });
    const errs = app.errors.filter((e) => !/favicon/.test(e.text));
    if (errs.length) { console.log(`info  ${errs.length} page error(s): ${errs.slice(0, 5).map((e) => e.text).join(' | ')}`); }
} catch (e) {
    console.error(`FAIL  ${e.stack || e}`);
    code = 1;
} finally {
    await browser?.close().catch(() => {});
    await relay.stop();
}
process.exit(code);
