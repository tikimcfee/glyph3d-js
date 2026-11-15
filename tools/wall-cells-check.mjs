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
 *     shows the emoji's own colours, not that cell's fill;
 *   - bold is the bold FACE: a run of bold l inks measurably more of its cells than a plain run
 *     (stems thicker), in the same colour (boldIsBright is off);
 *   - a base letter and its combining mark share the cell: a run of x + U+0301 shows the x (as
 *     much ink over the x's own rows as a plain x run) AND the mark over it; and e + U+0301 draws
 *     as the precomposed é does;
 *   - the outer columns stay inside the panel: █ in the first and the LAST column (rows below the
 *     cases), read at the panel's left and right edges — the █'s ink reaches its cell's outer edge,
 *     the padding between that edge and the panel's border holds the panel's colour and no ink, and
 *     the border beside the █ rows reads as it does beside blank rows (no ink drawn over it).
 *     The cell rects come from the grid's metrics (a slot's position is its cell's LEFT edge), the
 *     panel's from its getLocalBounds().
 * Then the terminal is resized, which makes termd REPAINT the screen from its own emulator's cells
 * rather than the program's bytes: every attribute read before (underline styles and colour,
 * strike, dim, inverse) reads the same after, and the combining-mark cells are still clusters.
 * Then the font family: `wall.config fontFamily` moves every terminal to another family live —
 * cols × rows stay, the cell (and so the terminal's size on the canvas) changes, █ cells still
 * join, bold is still the bolder face and a cluster still shows its base — and back.
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
import { FONT_FAMILY_IDS } from '../packages/glyph3d-core/src/fonts/families.js';

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

const COLS = 60, ROWS = 22, RUN = 8, LINE = 12;
/** The outer-column case: █ in the first and the last column of these rows; the two below stay blank. */
const EDGE_ROWS = [18, 19], BLANK_ROWS = [20, 21];
/** The camera centres on the middle of this many rows: the pixel phases the cases' thresholds hold at. */
const CENTRE_ROWS = 20;
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
    `STEMR ${'l'.repeat(RUN)}`,
    `STEMB ${sgr('1', 'l'.repeat(RUN))}`,
    `BASEX ${'x'.repeat(RUN)}`,
    `MARKX ${'x\u0301'.repeat(RUN)}`,
    `PRECO ${'\u00e9'.repeat(RUN)}`,
    `DECOM ${'e\u0301'.repeat(RUN)}`,
];
// The outer columns' █, placed by CUP (no wrap: the last column's █ leaves the cursor pending, the
// next CUP clears it), then back to the last line's own row for CELLS-DONE.
LINES.push(`${EDGE_ROWS.map((r) => `\\033[${r + 1};1H█\\033[${r + 1};${COLS}H█`).join('')}\\033[${LINES.length + 1};1HCELLS-DONE`);
if (EDGE_ROWS[0] < LINES.length || BLANK_ROWS[BLANK_ROWS.length - 1] >= ROWS) throw new Error('the outer-column rows must lie below the cases, on the screen');
const C0 = 6;   // the column the cells start at

const relay = await privateRelay({ port: RELAY, ns: 'glyph-cells-check' });
let browser = null;
try {
    browser = await launchGpuBrowser({});
    const app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 0, viewport: { width: 1400, height: 1100 } });
    const page = app.page;
    const W = (fn, a) => app.evalPage(fn, a);
    /**
     * Wait until a page predicate holds, checked once a frame (a throw counts as not yet); returns
     * its value, or null if `ms` ran out first — a deadline only bounds a failure.
     */
    const until = async (fn, a, ms = 20000) => {
        const h = await page.waitForFunction(([src, arg]) => {
            try { return (0, eval)(`(${src})`)(arg) || false; } catch { return false; }
        }, [String(fn), a], { polling: 'raf', timeout: ms }).catch(() => null);
        return h ? h.jsonValue() : null;
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

    /** Drawn: the screen applied, every glyph it asked the atlas for landed, and frames since (TerminalWall.nextFrame). */
    const drawn = () => W(async () => {
        const w = window.__wall;
        for (let n = 0; n < 3; n++) await w.nextFrame();
        await w.ctx.atlas._live?.whenIdle();
        for (let n = 0; n < 3; n++) await w.nextFrame();
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
     * brightest pixel (by channel sum), and per pixel ROW the darkest and brightest sum along it,
     * the row's total (`sum`, every pixel's channel sum) and its width in pixels (`w`).
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
                    let lo = 766, hi = -1, total = 0;
                    for (let x = x0; x < x1; x++) {
                        const k = (y * img.width + x) * 4, c = [d[k], d[k + 1], d[k + 2]], s = c[0] + c[1] + c[2];
                        if (s < dark[0] + dark[1] + dark[2]) dark = c;
                        if (s > bright[0] + bright[1] + bright[2]) bright = c;
                        if (s < lo) lo = s;
                        if (s > hi) hi = s;
                        total += s;
                        for (let j = 0; j < 3; j++) ch[j].push(c[j]);
                        n++;
                    }
                    rows.push({ lo, hi, sum: total, w: x1 - x0 });
                }
                const med = ch.map((a) => (a.sort((p, q) => p - q), a.length ? a[a.length >> 1] : -1));
                return { n, med, dark, bright, rows };
            });
        }, [png.toString('base64'), clip, list]);
    };

    const ink = [Math.round(RESET_FG.r * 255), Math.round(RESET_FG.g * 255), Math.round(RESET_FG.b * 255)];
    const near = (a, b, tol) => Math.max(...a.map((v, j) => Math.abs(v - b[j]))) <= tol;

    /**
     * The camera: this line height, centred on the cases (or on column `atCol`), the grid's origin
     * off the pixel grid.
     */
    const look = async (linePx, atCol = COLS / 2) => {
        await W(([i, linePx, atCol, rows]) => {
            const w = window.__wall, g = w.terminal(i), v = w.viewport, st = g.cellStride;
            v.camera.zoom = linePx / st.y;
            v.camera.updateProjectionMatrix();
            v.moveTo(g.position.x + atCol * st.x + 0.37 / v.camera.zoom, g.position.y - (rows / 2) * st.y + 0.29 / v.camera.zoom);
        }, [id, linePx, atCol, CENTRE_ROWS]);
        await until(() => !window.__wall.viewport.moving);
        await drawn();
    };

    /**
     * A run's INK per pixel row: how many pixels' worth of full ink the row holds (its lift over
     * the panel, over the lift a full-ink pixel has), from a rect read over the run's whole cells.
     * @returns {number[]} top row first
     */
    const inkRows = (r, panel, full) => r.rows.map((row) => (row.sum - row.w * panel) / (full - panel));
    const total = (a) => a.reduce((s, v) => s + v, 0);

    /**
     * The faces and clusters, read at the camera's pose: the bold face inks more than the regular
     * (in the same colour), a cluster shows its base letter and its mark, and e + U+0301 is é.
     */
    const facesAndClusters = async (at) => {
        const whole = (label) => ({ label, n: RUN });
        const g = await rects(['STEMR', 'STEMB', 'BASEX', 'MARKX', 'PRECO', 'DECOM'].map(whole));
        ok(g.rects.every(Boolean), `${at}: the face and cluster cases are on screen`);
        const px = await read(g.rects);
        // Each run's ink is counted against ITS OWN brightest pixel (its full ink): a run drawn
        // brighter is not thereby drawn thicker.
        const panel = sum(g.panel);
        const [stemR, stemB, baseX, markX, preco, decom] = px.map((r) => inkRows(r, panel, Math.max(sum(r.bright), panel + 90)));

        // Bold is the bold face: more ink in the same cells, in the same colour.
        const r = total(stemR), b = total(stemB);
        ok(r > 0 && b >= 1.2 * r,
            `${at}: bold is the bold face — a run of ${RUN} bold l inks ${b.toFixed(0)} px of full ink, the plain run ${r.toFixed(0)} (stems thicker: ≥ 1.2 × wanted; the same glyph brightened reads 1.0 ×)`);
        ok(near(px[1].bright, ink, 6) && near(px[0].bright, ink, 6),
            `${at}: and bold keeps the text's colour (boldIsBright is off) — its brightest pixel is ${rgb(px[1].bright)}, the plain run's ${rgb(px[0].bright)}, the ink ${rgb(ink)}`);

        // A cluster: the base letter's own rows hold the base letter's ink, and the mark sits above.
        const rowsOfX = baseX.map((v, y) => (v > 0.5 ? y : -1)).filter((y) => y >= 0);
        const top = rowsOfX[0];
        const baseInk = total(rowsOfX.map((y) => baseX[y])), underMark = total(rowsOfX.map((y) => markX[y]));
        ok(rowsOfX.length > 0 && underMark >= 0.9 * baseInk,
            `${at}: x + U+0301 shows its base letter — over the x's own ${rowsOfX.length} pixel rows the cluster run holds ${underMark.toFixed(0)} px of ink, the plain x run ${baseInk.toFixed(0)} (a missing base reads near 0)`);
        const above = total(markX.slice(0, top)), plainAbove = total(baseX.slice(0, top));
        ok(above >= 0.08 * baseInk && above >= plainAbove + 0.05 * baseInk,
            `${at}: and its mark over it — ${above.toFixed(0)} px of ink above the x-height, where the plain run has ${plainAbove.toFixed(0)}`);
        const below = total(markX.slice(rowsOfX[rowsOfX.length - 1] + 1)), plainBelow = total(baseX.slice(rowsOfX[rowsOfX.length - 1] + 1));
        ok(Math.abs(below - plainBelow) <= 0.03 * baseInk + 2, `${at}: nothing under the letter (${below.toFixed(0)} px; the plain run ${plainBelow.toFixed(0)})`);

        // NFC: e + U+0301 draws as the precomposed é — as much ink, over the same rows (the two
        // runs sit on different pixel phases, so they are compared by extent, not pixel by pixel).
        const extent = (rows) => { const y = rows.map((v, k) => (v > 0.5 ? k : -1)).filter((k) => k >= 0); return [y[0] ?? -1, y[y.length - 1] ?? -1]; };
        const [pTop, pFoot] = extent(preco), [dTop, dFoot] = extent(decom);
        const eTop = extent(baseX)[0];
        ok(total(preco) > 0 && Math.abs(total(decom) - total(preco)) <= 0.03 * total(preco) && Math.abs(dTop - pTop) <= 1 && Math.abs(dFoot - pFoot) <= 1 && pTop < eTop - 1,
            `${at}: e + U+0301 draws as the precomposed é — ${total(decom).toFixed(0)} px of ink over pixel rows ${dTop}–${dFoot}, the é run ${total(preco).toFixed(0)} px over ${pTop}–${pFoot} (its accent reaches above the x-height, row ${eTop})`);
    };

    /**
     * The outer columns, at this line height: per side, the camera centred on that edge; the rects
     * (page CSS px) of the █ cells' outer strip, the padding (the cells' outer edge to the panel's
     * border), and the border beside the █ rows and beside the blank rows. The cells' span is the
     * metrics' (a slot's position is its cell's LEFT edge: column c spans [c, c + 1) × stride); the
     * panel's is getLocalBounds(); the border's width is the panel material's, for its flags. Read
     * unfocused: the focused border is wider, and at the small size it covers most of the padding.
     */
    const edges = async (linePx) => {
        const focused = await W(() => { const w = window.__wall, f = w.focusedId; w.focus(null); return f; });
        for (const side of ['left', 'right']) {
            await look(linePx, side === 'left' ? 0 : COLS);
            const geo = await W(([i, side, cols, edgeRows, blankRows]) => {
                const w = window.__wall, g = w.terminal(i), m = g._metrics, v = w.viewport, cr = v.canvas.getBoundingClientRect();
                const sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing, p = g.position, s = g.scale, zoom = v.camera.zoom;
                const lb = g.getLocalBounds(), mat = g._background.material, flags = g._panel.getBorderFlags();
                // panelMaterial: the band is w = uBorderWidth × (2.6 captured | 1.6 focused / input | 1)
                // screen px from the edge, smoothed over ±0.5 px — judged at a pixel's centre, so a
                // whole pixel more than w from the edge is the fill alone.
                const scale = (flags & 16) ? 2.6 : (flags & (4 | 8)) ? 1.6 : 1;
                const borderPx = mat.uniforms.uBorderWidth.value * scale;
                const X = (lx) => cr.left + v.toScreenBox({ minX: p.x + lx * s.x, maxX: p.x + lx * s.x, minY: 0, maxY: 0 }).left;
                const Y = (ly) => cr.top + v.toScreenBox({ minX: 0, maxX: 0, minY: p.y + ly * s.y, maxY: p.y + ly * s.y }).top;
                // Row r spans y ∈ [sy/2 − (r + 1)·sy, sy/2 − r·sy] (a slot's y is its row's centre).
                const rowsY = (rs, a, b) => ({ t: Y(sy / 2 - (rs[0] + a) * sy), b: Y(sy / 2 - (rs[rs.length - 1] + b) * sy) });
                const cellEdge = X(side === 'left' ? 0 : cols * sx), panelEdge = X(side === 'left' ? lb.min.x : lb.max.x);
                const strip = Math.min(2, 0.25 * sx * s.x * zoom);   // px of the cell's outer strip
                const dir = side === 'left' ? -1 : 1;                 // outward
                const span = (a, b) => ({ l: Math.min(a, b), r: Math.max(a, b) });
                const ink = rowsY(edgeRows, 0.2, 0.8), blank = rowsY(blankRows, 0.2, 0.8);
                const pad = span(cellEdge, panelEdge - dir * borderPx);
                // The border and a pixel past the panel (a 1.5 px band need not hold a whole pixel).
                const border = span(panelEdge - dir * borderPx, panelEdge + dir);
                const h = typeof g._bgColor === 'string' ? parseInt(g._bgColor.replace('#', ''), 16) : g._bgColor;
                return {
                    panel: [(h >> 16) & 255, (h >> 8) & 255, h & 255], cellPx: sx * s.x * zoom, padPx: dir * (panelEdge - cellEdge), borderPx,
                    // the padding as the panel draws it: inverted (r < l) when the cells cross the border
                    padSigned: dir * (panelEdge - dir * borderPx - cellEdge),
                    cellStrip: { ...span(cellEdge - dir * strip, cellEdge), ...ink },
                    pad: { ...pad, ...ink },
                    borderInk: { ...border, ...ink },
                    borderBlank: { ...border, ...blank },
                };
            }, [id, side, COLS, EDGE_ROWS, BLANK_ROWS]);
            const at = `lines ${linePx} px, ${side} edge (cell ${geo.cellPx.toFixed(2)} px; the panel's edge ${geo.padPx.toFixed(2)} px past the cells', its border ${geo.borderPx.toFixed(1)} px)`;
            const [strip, pad, bInk, bBlank] = await read([geo.cellStrip, geo.padSigned > 0 ? geo.pad : null, geo.borderInk, geo.borderBlank]);
            ok(strip.n > 0 && sum(strip.dark) >= sum(ink) - 12,
                `${at}: the █'s ink reaches its cell's ${side} edge — the darkest of the ${strip.n} px in the cell's outer strip is ${rgb(strip.dark)}, the ink ${rgb(ink)}`);
            ok(geo.padSigned > 0 && !!pad && pad.n > 0 && near(pad.dark, geo.panel, 3) && near(pad.bright, geo.panel, 3),
                `${at}: the padding between the █ cells and the panel's border is the panel's own colour, no ink — ${pad?.n ? `${pad.n} px from ${rgb(pad.dark)} to ${rgb(pad.bright)}` : geo.padSigned > 0 ? `not one whole pixel in its ${geo.padSigned.toFixed(2)} px` : `none: the cells run ${(-geo.padSigned).toFixed(2)} px past the border's inner edge`}, the panel ${rgb(geo.panel)}`);
            ok(bInk.n > 0 && bBlank.n > 0 && near(bInk.med, bBlank.med, 6) && near(bInk.bright, bBlank.bright, 6),
                `${at}: the border beside the █ rows reads as beside blank rows (no ink over it) — ${rgb(bInk.med)} / brightest ${rgb(bInk.bright)}, beside blank rows ${rgb(bBlank.med)} / ${rgb(bBlank.bright)}`);
        }
        await W((f) => { window.__wall.focus(f); }, focused);
    };

    for (const linePx of [17.37, 41.83]) {
        await look(linePx);
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

        await facesAndClusters(at);
        await edges(linePx);
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
        // Checked once a frame (the screen applies in the frame); 600 frames only bound a failure.
        for (let n = 0; n < 600 && !(emu._term.rows === rows && bytes > 0 && g.readText().some((l) => l.trim() === 'CELLS-DONE')); n++) await window.__wall.nextFrame();
        off();
        return { text: r.text, rows: emu._term.rows, bytes };
    }, [id, COLS, ROWS + 3]);
    ok(repaints.rows === ROWS + 3 && repaints.bytes > 0, `a resize to ${ROWS + 3} rows brought a repaint from termd (${repaints.bytes} B; ${repaints.text})`);
    const now = await attrs();
    ok(!!now && JSON.stringify(now) === JSON.stringify(was), `and every attribute reads the same after it: ${JSON.stringify(now)}`);
    const clusters = await W(([i, C0]) => {
        const g = window.__wall.terminal(i), s = g._emulator.readScreen(g.cols, g.rows), lines = g.readText();
        return ['MARKX', 'DECOM'].map((label) => { const row = lines.findIndex((x) => x.startsWith(label)); return row < 0 ? null : [...lines[row].slice(C0, C0 + 2)].map((ch) => ch.codePointAt(0).toString(16)).join('+') + (s.cp[row * g.cols + C0] > 0x10FFFF ? ' (a cluster)' : ' (one codepoint)'); });
    }, [id, C0]);
    ok(clusters[0] === '78+301 (a cluster)' && /^(65\+301 \(a cluster\)|e9\+e9 \(one codepoint\))$/.test(clusters[1]),
        `and the combining marks are still in their letters' cells after the repaint (x + U+0301: ${clusters[0]}; e + U+0301: ${clusters[1]})`);

    // The font family, live: every terminal moves to another family of the chain — cols × rows
    // stay, the cell changes — and what a cell draws still holds in it; then back.
    {
        const state = () => W((i) => {
            const w = window.__wall, g = w.terminal(i), r = w.terminalRect(i);
            return { family: g.fontFamily, config: w.config.fontFamily, cols: g.cols, rows: g.rows, w: r.maxX - r.minX, h: r.maxY - r.minY, cell: [g._metrics.charWidth, g._metrics.charHeight], text: g.readText().length };
        }, id);
        const born = await state();
        ok(born.family === WALL_CONFIG.fontFamily && born.config === WALL_CONFIG.fontFamily, `a terminal is born in the wall's font family (${born.family})`);
        const other = FONT_FAMILY_IDS.find((f) => f !== born.family);
        const said = await W(async (f) => (await window.__wall.router.execute(['wall.config', 'fontFamily', f])).text, other);
        await look(41.83);
        const moved = await state();
        ok(moved.family === other && moved.cols === born.cols && moved.rows === born.rows && (moved.cell[0] !== born.cell[0] || moved.cell[1] !== born.cell[1]) && (moved.w !== born.w || moved.h !== born.h),
            `wall.config fontFamily ${other} (${said}) moves the terminal to it live: still ${moved.cols} × ${moved.rows}, its cell ${born.cell.map((v) => v.toFixed(4)).join(' × ')} → ${moved.cell.map((v) => v.toFixed(4)).join(' × ')} and its size ${born.w.toFixed(1)} × ${born.h.toFixed(1)} → ${moved.w.toFixed(1)} × ${moved.h.toFixed(1)}`);
        const at = `in ${other}, lines 41.83 px`;
        const g = await rects([{ label: 'SOLID', n: RUN, inX: 0.5, y0: 0.25, y1: 1.75 }, { label: 'RULE ', n: LINE, inX: 1 }]);
        const px = await read(g.rects);
        ok(px[0].n > 0 && sum(px[0].dark) >= sum(ink) - 12, `${at}: █ cells still join across and down on the family's cell — the darkest of ${px[0].n} px inside the block is ${rgb(px[0].dark)}`);
        const best = px[1].rows.reduce((a, b) => (b.hi > a.hi ? b : a), { lo: 0, hi: -1 });
        ok(best.hi - sum(g.panel) >= 90 && best.lo - sum(g.panel) >= 0.85 * (best.hi - sum(g.panel)), `${at}: a ─ run is still one line (sprites are drawn to the family's cell)`);
        await facesAndClusters(at);
        if (SHOTS) { const f = path.join(SHOTS, `cells-${other}.png`); await page.screenshot({ path: f }); info(`screenshot ${f}`); }
        await W(async () => { await window.__wall.router.execute(['wall.config', 'fontFamily', 'default']); });
        await look(41.83);
        const back = await state();
        ok(back.family === born.family && back.cell[0] === born.cell[0] && back.cell[1] === born.cell[1] && back.w === born.w && back.h === born.h,
            `wall.config fontFamily default hands it back: ${back.family}, the cell and the size it had`);
        await facesAndClusters(`back in ${back.family}, lines 41.83 px`);
        const refused = await W(async () => { try { return (await window.__wall.router.execute(['wall.config', 'fontFamily', 'helvetica'])).text; } catch (e) { return `threw: ${e.message}`; } });
        ok(/fontFamily is /.test(refused) && (await state()).family === born.family, `an unknown family is refused, naming the ones there are (${refused})`);
    }

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
