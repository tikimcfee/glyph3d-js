/**
 * term-test-shots.mjs — screenshots of tools/term-test-pattern.sh on the wall, for a person to
 * judge the look of what a terminal draws itself (blocks, box drawing, styles, cell fills).
 *
 *   bun tools/term-test-shots.mjs --url http://localhost:5180/ --relay 8099 --out DIR
 *
 * Needs the wall's Vite and a built glyph3d-cli. Starts its own relay on --relay
 * (tools/lib/wall-relay.mjs: its own termd namespace, no gomuxai; refuses a port something already
 * listens on), spawns ONE 80 × 24 terminal that runs the pattern and then sleeps (no prompt under
 * it), and saves, into DIR:
 *
 *   fit.png             the terminal framed as the wall frames it (wall.frame)
 *   one-to-one.png      reading size: lines 16.3 px tall (a fractional size on purpose — cell edges
 *                       fall between pixels, where seams show)
 *   close-art.png       61.7 px lines over the block art, blocks and shades
 *   close-box.png       61.7 px lines over the box drawing and the table
 *   close-styles.png    61.7 px lines over the styles
 *   close-emoji.png     61.7 px lines over the powerline row and the emoji on a fill
 *   close-marks.png     61.7 px lines over the letters with combining marks, in every face
 *   far.png             6.3 px lines: under the greek tier's size
 *
 * An instrument: it judges nothing (tools/wall-cells-check.mjs reads the pixels).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay } from './lib/wall-relay.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const OUT = arg('--out', null);
if (!OUT) { console.error('usage: bun tools/term-test-shots.mjs --url <wall vite> --relay <free port> --out <dir>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const PATTERN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'term-test-pattern.sh');
const COLS = 80, ROWS = 24;

/** The shots: a name, the line height on screen (CSS px; null = the wall's own framing) and the cells to centre on. */
const SHOTS = [
    { name: 'fit', linePx: null },
    { name: 'one-to-one', linePx: 16.3, col: COLS / 2, row: ROWS / 2 - 0.5 },
    { name: 'close-art', linePx: 61.7, col: 23, row: 2.6 },
    { name: 'close-box', linePx: 61.7, col: 23, row: 7.6 },
    { name: 'close-styles', linePx: 61.7, col: 23, row: 18 },
    { name: 'close-emoji', linePx: 61.7, col: 56, row: 15 },
    { name: 'close-marks', linePx: 61.7, col: 23, row: 21 },
    { name: 'far', linePx: 6.3, col: COLS / 2, row: ROWS / 2 - 0.5 },
];

const relay = await privateRelay({ port: RELAY, ns: 'glyph-cells-shots' });
let browser = null;
let code = 0;
try {
    browser = await launchGpuBrowser({});
    const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 3000, viewport: { width: 1600, height: 1000 } });
    const page = app.page;
    const W = (fn, a) => app.evalPage(fn, a);
    const until = async (fn, a, ms = 20000) => {
        const t = Date.now();
        let v;
        while (!(v = await W(fn, a).catch(() => null)) && Date.now() - t < ms) await page.waitForTimeout(100);
        return v;
    };
    if (!app.booted || !await until(() => window.__wall?.snapshot().connected)) throw new Error(`the wall didn't boot and connect to the relay on :${RELAY}`);

    const spawn = await W(async (argv) => {
        const r = await window.__wall.router.execute(argv);
        return { text: r.text, id: r.data?.id ?? null };
    }, ['terminal.spawn', String(COLS), String(ROWS), '--', 'sh', '-c', `sh '${PATTERN}'; exec sleep 3600`]);
    const id = await until(() => window.__wall.order[0] ?? null);
    if (!id) throw new Error(`the pattern's terminal never landed (${spawn.text})`);
    const shown = await until((i) => window.__wall.terminal(i).readText().some((l) => l.startsWith('The quick brown fox')), id);
    if (!shown) throw new Error(`the pattern never reached ${id}'s screen: ${JSON.stringify(await W((i) => window.__wall.terminal(i).readText().slice(0, 4), id))}`);
    await page.mouse.move(2, 2);   // off every bar: a hovered bar shows its buttons

    /** The screen is drawn: every glyph it asked the atlas for has landed, and frames have run since. */
    const drawn = () => W(async () => {
        const frames = (n) => new Promise((r) => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
        await frames(3);
        await window.__wall.ctx.atlas._live?.whenIdle();
        await frames(3);
    });
    await drawn();

    for (const s of SHOTS) {
        if (s.linePx == null) {
            await W((i) => window.__wall.frame(i), id);
        } else {
            await W(([i, linePx, col, row]) => {
                const w = window.__wall, g = w.terminal(i), v = w.viewport, m = g._metrics, st = g.cellStride;
                v.moveTo(g.position.x + (col + 0.5) * st.x - m.charWidth * g.scale.x / 2, g.position.y - row * st.y);
                v.camera.zoom = linePx / st.y;
                v.camera.updateProjectionMatrix();
            }, [id, s.linePx, s.col, s.row]);
        }
        await until(() => !window.__wall.viewport.moving);
        await drawn();
        const at = await W((i) => { const w = window.__wall; return { zoom: w.viewport.zoom, linePx: w.terminal(i).cellStride.y * w.viewport.zoom }; }, id);
        const file = path.join(OUT, `${s.name}.png`);
        await page.screenshot({ path: file });
        console.log(`shot  ${file}  (lines ${at.linePx.toFixed(2)} px, zoom ${at.zoom.toFixed(3)})`);
    }
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
