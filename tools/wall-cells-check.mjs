/**
 * wall-cells-check.mjs — what a terminal draws itself, read from the wall's pixels in a real-GPU
 * browser against a PRIVATE relay.
 *
 *   bun tools/wall-cells-check.mjs [--url http://localhost:5180/] [--relay 8099] [--shots DIR]
 *
 * Needs the wall's Vite and a built ./glyph3d-cli. Starts its own relay on --relay
 * (tools/lib/wall-relay.mjs: termd namespace `glyph-cells-check`, no gomuxai; refuses a port
 * something already listens on) and ONE terminal of its own, which prints the cases below and then
 * sleeps (no prompt, no typing). The camera is put at FRACTIONAL sizes on purpose (lines 17.37 px
 * and 41.83 px tall, the terminal's origin off the pixel grid): cell edges then fall between
 * pixels, which is where a seam shows.
 *
 * Each case is read where the grid's own metrics and pose put its cells:
 *   - █ joined across and down: over the inside of a 2 × 8 block of full blocks, the DARKEST
 *     pixel is still the ink (a seam between two cells is a dark line through it);
 *   - a ─ run is continuous: along the rule's own pixel row, the dimmest pixel is as bright as the
 *     brightest (a rule drawn as font glyphs breaks at every cell edge);
 *   - an underline and a strikethrough run under blank cells exist and are continuous;
 *   - a curly underline draws in the colour SGR 58 named, not the text's;
 *   - inverse swaps: an inverse blank cell fills with the text colour, and a ▄ under inverse
 *     draws its ink in the background's colour over a fill of the foreground's;
 *   - dim is darker than plain, and still there;
 *   - a wide emoji on a cell background is whole: its right half (which lies over the next cell)
 *     shows the emoji's own colours, not that cell's fill.
 * Then the terminal is resized, which makes termd REPAINT the screen from its own emulator's cells
 * rather than the program's bytes: every attribute read before (underline styles and colour,
 * strike, dim, inverse) reads the same after.
 * Last, the knobs: the settings panel (chord + ,) lists the four text knobs in its Text section;
 * dim opacity set to 1 in its field makes dim text read as plain in the pixels, and handing the
 * knob back (`wall.config dimAlpha default`) makes it dim again.
 * Exit 1 on any FAIL. --shots DIR saves the page at each size (for a person; never read).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay } from './lib/wall-relay.mjs';
import { RESET_FG } from '../packages/glyph3d-core/src/collections/terminalPalette.js';
import { searchSettings } from '../wall/wallSettings.js';
import { WALL_CONFIG, LINE_STYLE_KNOBS } from '../wall/wallConfig.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
const info = (msg) => console.log(`info  ${msg}`);
const rgb = (c) => `rgb(${c.join(',')})`;
const sum = (c) => c[0] + c[1] + c[2];

const COLS = 60, ROWS = 14, RUN = 8, LINE = 12;
const FILL = [40, 90, 160], INV_FG = [200, 100, 50], INV_BG = [10, 20, 30], CURLY = [255, 80, 0];
const sgr = (codes, text) => `\\033[${codes}m${text}\\033[0m`;
/** The cases, one labelled line each (the label finds its row; the cells start two past it). */
const LINES = [
    `SOLID ${'█'.repeat(RUN)}`,
    `SOLI2 ${'█'.repeat(RUN)}`,
    `RULE  ${'─'.repeat(LINE)}`,
    `UNDER ${sgr('4', ' '.repeat(LINE))}`,
    `STRIK ${sgr('9', ' '.repeat(LINE))}`,
    `CURLY ${sgr(`4:3;58:2::${CURLY.join(':')}`, ' '.repeat(LINE))}`,
    `INVSP ${sgr('7', ' '.repeat(RUN))}`,
    `INVHB ${sgr(`7;38;2;${INV_FG.join(';')};48;2;${INV_BG.join(';')}`, '▄'.repeat(RUN))}`,
    `PLAIN ${'█'.repeat(RUN)}`,
    `DIMMD ${sgr('2', '█'.repeat(RUN))}`,
    `EMOJI ${sgr(`48;2;${FILL.join(';')}`, '😀      ')}`,
    'CELLS-DONE',
];
const C0 = 6;   // the column the cells start at

const relay = await privateRelay({ port: RELAY, ns: 'glyph-cells-check' });
let browser = null;
try {
    browser = await launchGpuBrowser({});
    const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 3000, viewport: { width: 1400, height: 900 } });
    const page = app.page;
    const W = (fn, a) => app.evalPage(fn, a);
    const until = async (fn, a, ms = 20000) => {
        const t = Date.now();
        let v;
        while (!(v = await W(fn, a).catch(() => null)) && Date.now() - t < ms) await page.waitForTimeout(100);
        return v;
    };
    ok(app.booted && !!await until(() => window.__wall?.snapshot().connected), `boots and registers as the relay's display on :${RELAY}`);

    const script = `printf '${LINES.join('\\n')}'; exec sleep 3600`;
    const spawn = await W(async (argv) => { const r = await window.__wall.router.execute(argv); return r.text; },
        ['terminal.spawn', String(COLS), String(ROWS), '--', 'sh', '-c', script]);
    const id = await until(() => window.__wall.order[0] ?? null);
    const shown = id && await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'CELLS-DONE'), id);
    ok(!!shown, `the cases are on the terminal's screen${shown ? '' : ` (spawn: ${spawn}; screen: ${JSON.stringify(id ? await W((i) => window.__wall.terminal(i).readText().slice(0, 4), id) : null)})`}`);
    if (!shown) throw new Error('nothing to read');
    await page.mouse.move(2, 2);   // off every bar: a hovered bar shows its buttons

    /** Drawn: the screen applied, every glyph it asked the atlas for landed, and frames since. */
    const drawn = () => W(async () => {
        const frames = (n) => new Promise((r) => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
        await frames(3);
        await window.__wall.ctx.atlas._live?.whenIdle();
        await frames(3);
    });

    /**
     * Screen rects (page CSS px) of the cases at the camera's pose: per label, the cells
     * [C0 + c0, C0 + c0 + n) of its row, inset by `inX` cells at each end, from `y0` to `y1` row
     * heights below the row's top; and the terminal's panel colour.
     */
    const rects = (specs) => W(([i, specs, C0]) => {
        const w = window.__wall, g = w.terminal(i), m = g._metrics, v = w.viewport, cr = v.canvas.getBoundingClientRect();
        const sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing, p = g.position, s = g.scale;
        const lines = g.readText();
        const hex = (c) => { const h = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c; return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; };
        return {
            panel: hex(g._bgColor),
            cellPx: { w: sx * s.x * v.zoom, h: sy * s.y * v.zoom },
            rects: specs.map(({ label, c0 = 0, n, inX = 0, y0 = 0, y1 = 1 }) => {
                const row = lines.findIndex((x) => x.startsWith(label));
                if (row < 0) return null;
                const top = -row * sy + m.charHeight / 2;   // a row's centre sits on -row × pitch
                const b = v.toScreenBox({
                    minX: p.x + (C0 + c0 + inX) * sx * s.x,
                    maxX: p.x + (C0 + c0 + n - inX) * sx * s.x,
                    minY: p.y + (top - y1 * sy) * s.y,
                    maxY: p.y + (top - y0 * sy) * s.y,
                });
                return { l: cr.left + b.left, r: cr.left + b.right, t: cr.top + b.top, b: cr.top + b.bottom };
            }),
        };
    }, [id, specs, C0]);

    /**
     * Read rects off one screenshot: per rect its pixel count, per-channel median, the darkest and
     * brightest pixel (by channel sum), and per pixel ROW the darkest and brightest sum along it.
     */
    const read = async (list) => {
        const all = list.filter(Boolean);
        const clip = { x: Math.floor(Math.min(...all.map((r) => r.l))) - 1, y: Math.floor(Math.min(...all.map((r) => r.t))) - 1 };
        clip.width = Math.ceil(Math.max(...all.map((r) => r.r))) + 1 - clip.x;
        clip.height = Math.ceil(Math.max(...all.map((r) => r.b))) + 1 - clip.y;
        const png = await page.screenshot({ clip, scale: 'css' });
        return W(async ([b64, o, rs]) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const cv = new OffscreenCanvas(img.width, img.height), cx = cv.getContext('2d');
            cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, img.width, img.height).data;
            return rs.map((r) => {
                if (!r) return null;
                // Whole pixels inside the rect only.
                const x0 = Math.max(0, Math.ceil(r.l - o.x)), x1 = Math.min(img.width, Math.floor(r.r - o.x));
                const y0 = Math.max(0, Math.ceil(r.t - o.y)), y1 = Math.min(img.height, Math.floor(r.b - o.y));
                let dark = [255, 255, 255], bright = [0, 0, 0], n = 0;
                const ch = [[], [], []], rows = [];
                for (let y = y0; y < y1; y++) {
                    let lo = 766, hi = -1;
                    for (let x = x0; x < x1; x++) {
                        const k = (y * img.width + x) * 4, c = [d[k], d[k + 1], d[k + 2]], s = c[0] + c[1] + c[2];
                        if (s < dark[0] + dark[1] + dark[2]) dark = c;
                        if (s > bright[0] + bright[1] + bright[2]) bright = c;
                        if (s < lo) lo = s;
                        if (s > hi) hi = s;
                        for (let j = 0; j < 3; j++) ch[j].push(c[j]);
                        n++;
                    }
                    rows.push({ lo, hi });
                }
                const med = ch.map((a) => (a.sort((p, q) => p - q), a.length ? a[a.length >> 1] : -1));
                return { n, med, dark, bright, rows };
            });
        }, [png.toString('base64'), clip, list]);
    };

    const ink = [Math.round(RESET_FG.r * 255), Math.round(RESET_FG.g * 255), Math.round(RESET_FG.b * 255)];
    const near = (a, b, tol) => Math.max(...a.map((v, j) => Math.abs(v - b[j]))) <= tol;

    for (const linePx of [17.37, 41.83]) {
        // The camera: this line height, centred on the cases, the grid's origin off the pixel grid.
        await W(([i, linePx, cols, rows]) => {
            const w = window.__wall, g = w.terminal(i), v = w.viewport, st = g.cellStride;
            v.camera.zoom = linePx / st.y;
            v.camera.updateProjectionMatrix();
            v.moveTo(g.position.x + (cols / 2) * st.x + 0.37 / v.camera.zoom, g.position.y - (rows / 2) * st.y + 0.29 / v.camera.zoom);
        }, [id, linePx, COLS, ROWS]);
        await until(() => !window.__wall.viewport.moving);
        await drawn();
        if (SHOTS) { const f = path.join(SHOTS, `cells-${linePx}.png`); await page.screenshot({ path: f }); info(`screenshot ${f}`); }

        const g = await rects([
            { label: 'SOLID', n: RUN, inX: 0.5, y0: 0.25, y1: 1.75 },      // 0: the 2 × 8 block (two rows), its outer edge left out
            { label: 'RULE ', n: LINE, inX: 1 },                           // 1: the rule's row, the end cells left out
            { label: 'UNDER', n: LINE, inX: 1 },                           // 2
            { label: 'STRIK', n: LINE, inX: 1 },                           // 3
            { label: 'INVSP', n: RUN, inX: 1, y0: 0.25, y1: 0.75 },        // 4: inverse blanks
            { label: 'INVHB', n: RUN, inX: 1, y0: 0.1, y1: 0.4 },          // 5: above the ▄: the cell's fill
            { label: 'INVHB', n: RUN, inX: 1, y0: 0.6, y1: 0.9 },          // 6: the ▄ itself: its ink
            { label: 'PLAIN', n: RUN, inX: 1, y0: 0.25, y1: 0.75 },        // 7
            { label: 'DIMMD', n: RUN, inX: 1, y0: 0.25, y1: 0.75 },        // 8
            { label: 'EMOJI', c0: 1, n: 1, inX: 0.1, y0: 0.15, y1: 0.85 }, // 9: the cell after the emoji's own: its right half
            { label: 'EMOJI', c0: 4, n: 2, inX: 0.2, y0: 0.25, y1: 0.75 }, // 10: the fill, clear of the emoji
            { label: 'CURLY', n: LINE, inX: 1, y0: 0.5, y1: 1 },           // 11: the curly underline's half of the row
        ]);
        ok(g.rects.every(Boolean), 'every case\'s row is on screen');
        const px = await read(g.rects);
        const at = `lines ${linePx} px (cells ${g.cellPx.w.toFixed(2)} × ${g.cellPx.h.toFixed(2)} px)`;

        // █ joined across and down: the darkest pixel inside the block is the ink.
        const solid = px[0];
        ok(solid.n > 0 && sum(solid.dark) >= sum(ink) - 12,
            `${at}: █ cells joined across and down show no seam — the darkest of ${solid.n} px inside the 2 × ${RUN} block is ${rgb(solid.dark)}, the ink ${rgb(ink)}`);

        // A run that is one line: on its brightest pixel row, the dimmest pixel is (nearly) as bright.
        const lineRun = (r, what) => {
            const panel = sum(g.panel);
            const best = r.rows.reduce((a, b) => (b.hi > a.hi ? b : a), { lo: 0, hi: -1 });
            const lift = best.hi - panel, floor = best.lo - panel;
            ok(r.n > 0 && lift >= 90 && floor >= 0.85 * lift,
                `${at}: ${what} — on its brightest pixel row the brightest pixel is ${lift} over the panel and the dimmest ${floor} (a break reads near 0; ≥ 85 % wanted, ≥ 90 to be a line at all)`);
        };
        lineRun(px[1], 'a ─ run is continuous');
        lineRun(px[2], 'an underline runs unbroken under blank cells');
        lineRun(px[3], 'a strikethrough runs unbroken across blank cells');

        // A curly underline in its own colour: the row's most saturated pixel is that colour's hue
        // (red well over green over blue), where the text's grey would have all three alike.
        const curly = px[11].rows.length ? px[11].bright : [0, 0, 0];
        ok(px[11].n > 0 && curly[0] >= 150 && curly[0] - curly[1] >= 60 && curly[1] - curly[2] >= 20,
            `${at}: a curly underline draws in the colour SGR 58 named — its brightest pixel is ${rgb(curly)} for ${rgb(CURLY)} (the text is ${rgb(ink)})`);

        // Inverse swaps what is drawn.
        ok(px[4].n > 0 && near(px[4].med, ink, 2), `${at}: an inverse blank cell fills with the text colour — ${rgb(px[4].med)} for ${rgb(ink)}`);
        ok(px[5].n > 0 && near(px[5].med, INV_FG, 2), `${at}: inverse ▄: above the half block the cell fills with the foreground — ${rgb(px[5].med)} for ${rgb(INV_FG)}`);
        ok(px[6].n > 0 && near(px[6].med, INV_BG, 2), `${at}: inverse ▄: the half block's ink is the background's colour — ${rgb(px[6].med)} for ${rgb(INV_BG)}`);

        // Dim is darker than plain, and still drawn.
        const plain = sum(px[7].med), dim = sum(px[8].med), panel = sum(g.panel);
        ok(px[7].n > 0 && px[8].n > 0 && near(px[7].med, ink, 2) && dim - panel <= 0.8 * (plain - panel) && dim - panel >= 0.2 * (plain - panel),
            `${at}: dim is darker than plain and still there — plain ${rgb(px[7].med)}, dim ${rgb(px[8].med)}, the panel ${rgb(g.panel)}`);

        // A wide emoji on a fill is whole: its right half is not the next cell's fill.
        const right = px[9], fill = px[10];
        const emojiLift = right ? Math.max(...right.bright.map((v, j) => Math.abs(v - FILL[j]))) : 0;
        const notFill = right && !near(right.med, FILL, 24);
        ok(fill.n > 0 && near(fill.med, FILL, 2) && right.n > 0 && emojiLift >= 80 && notFill,
            `${at}: a wide emoji on a cell background is whole — over the next cell (its right half) the median is ${rgb(right.med)} and the pixel farthest from the fill ${rgb(right.bright)}; the fill beside it reads ${rgb(fill.med)} for ${rgb(FILL)}`);
    }

    // A repaint keeps the styles: a resize makes termd repaint from its own emulator's cells (the
    // program, asleep, redraws nothing). Read each case's first cell's attributes — and the curly
    // underline's colour — off the grid's emulator, before and after.
    const attrs = () => W(([i, C0, labels]) => {
        const g = window.__wall.terminal(i), s = g._emulator.readScreen(g.cols, g.rows), lines = g.readText();
        if (!s.at || !s.ul) return null;   // an emulator that reads no attributes
        return labels.map((label) => { const row = lines.findIndex((x) => x.startsWith(label)); return row < 0 ? null : [s.at[row * g.cols + C0], s.ul[row * g.cols + C0]]; });
    }, [id, C0, ['UNDER', 'STRIK', 'CURLY', 'INVSP', 'DIMMD']]);
    const was = await attrs();
    ok(!!was && was.every((a) => a && a[0] !== 0) && was[2][1] === (CURLY[0] | (CURLY[1] << 8) | (CURLY[2] << 16)),
        `each styled case reads its attributes off the emulator (underline, strike, curly + colour, inverse, dim): ${JSON.stringify(was)}`);
    const repaints = await W(async ([i, cols, rows]) => {
        const g = window.__wall.terminal(i), emu = g._emulator;
        let bytes = 0;
        const off = g.onBytes((b) => { bytes += b.length; });
        const r = await window.__wall.router.execute(['terminal.resize', i, String(cols), String(rows)]);
        for (let n = 0; n < 200 && !(emu._term.rows === rows && bytes > 0 && g.readText().some((l) => l.trim() === 'CELLS-DONE')); n++) await new Promise((res) => setTimeout(res, 50));
        off();
        return { text: r.text, rows: emu._term.rows, bytes };
    }, [id, COLS, ROWS + 3]);
    ok(repaints.rows === ROWS + 3 && repaints.bytes > 0, `a resize to ${ROWS + 3} rows brought a repaint from termd (${repaints.bytes} B; ${repaints.text})`);
    const now = await attrs();
    ok(!!now && JSON.stringify(now) === JSON.stringify(was), `and every attribute reads the same after it: ${JSON.stringify(now)}`);

    // The knobs, through the settings panel: listed under Text, edited in the field, in the pixels.
    {
        const CHORD = (await W(() => window.__wall.keys.chordKeys)).join('+');
        const dimRects = async () => {
            await drawn();
            const g = await rects([
                { label: 'PLAIN', n: RUN, inX: 1, y0: 0.25, y1: 0.75 },
                { label: 'DIMMD', n: RUN, inX: 1, y0: 0.25, y1: 0.75 },
            ]);
            const px = await read(g.rects);
            return { plain: px[0].med, dim: px[1].med, n: Math.min(px[0].n, px[1].n) };
        };
        await W(() => window.__wall.focus(null));
        await page.keyboard.press(`${CHORD}+Comma`);
        const opened = await until(() => document.activeElement?.hasAttribute('data-settings-search'), null, 4000);
        const listed = await W((keys) => keys.map((k) => {
            const el = document.querySelector(`[data-settings] [data-setting="${k}"]`);
            return el ? { key: k, section: el.closest('[data-section]')?.dataset.section, number: !!el.querySelector('[data-control="number"]'), field: el.querySelector(`[data-field="${k}"]`)?.value } : null;
        }), LINE_STYLE_KNOBS);
        ok(!!opened && listed.every((l, k) => l && l.section === 'text' && l.number && Number(l.field) === WALL_CONFIG[LINE_STYLE_KNOBS[k]]),
            `${CHORD}+, opens the settings panel, which lists ${LINE_STYLE_KNOBS.join(', ')} under Text as number fields holding their defaults (${JSON.stringify(listed.map((l) => l && [l.section, l.field]))})`);
        await page.keyboard.type('dim text opacity');
        const order = searchSettings('dim text opacity').flatMap((x) => x.items.map((it) => it.key));
        for (let k = 0; k < order.indexOf('dimAlpha'); k++) await page.keyboard.press('ArrowDown');
        const chose = await until(() => document.querySelector('[data-settings] [data-setting][data-active]')?.dataset.setting === 'dimAlpha', null, 4000);
        await page.keyboard.press('Enter');
        const inField = await until(() => document.activeElement?.dataset.field === 'dimAlpha', null, 4000);
        await page.keyboard.type('1'); await page.keyboard.press('Enter');
        const set1 = await until(() => window.__wall.config.dimAlpha === 1, null, 4000);
        const reset = await W(() => !!document.querySelector('[data-settings] [data-setting="dimAlpha"] [data-action="reset"]'));
        ok(order.includes('dimAlpha') && !!chose && !!inField && !!set1 && reset,
            `searching "dim text opacity" finds the knob; Enter puts the keys in its field, 1 + Enter sets it through wall.config, and its ↺ shows`);
        await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
        ok(!!await until(() => !document.querySelector('[data-settings]'), null, 4000), 'Escape closes the panel');
        const full = await dimRects();
        ok(full.n > 0 && near(full.dim, full.plain, 2) && near(full.plain, ink, 2), `with dim opacity 1 the dim cells draw as plain — ${rgb(full.dim)} beside ${rgb(full.plain)}`);
        const said = await W(async () => (await window.__wall.router.execute(['wall.config', 'dimAlpha', 'default'])).text);
        const back = await dimRects();
        ok((await W(() => window.__wall.config.dimAlpha)) === WALL_CONFIG.dimAlpha && sum(back.dim) < sum(back.plain) - 60,
            `wall.config dimAlpha default hands it back (${said}) and dim is dim again — ${rgb(back.dim)} beside ${rgb(back.plain)}`);
    }

    const errs = app.errors.filter((e) => !/favicon/.test(e.text));
    ok(errs.length === 0, `no page errors${errs.length ? `: ${errs.slice(0, 4).map((e) => e.text).join(' | ')}` : ''}`);
} catch (e) {
    failures++;
    console.log(`FAIL  ${e.stack || e}`);
} finally {
    await browser?.close().catch(() => {});
    await relay.stop();
}
console.log(failures ? `\nwall-cells-check: ${failures} FAILED` : '\nwall-cells-check: all passed');
process.exit(failures ? 1 : 0);
