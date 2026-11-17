/**
 * wall-e2e.mjs — the wall, end to end, in a real-GPU browser against a PRIVATE relay.
 *
 *   bun tools/wall-e2e.mjs [--url http://localhost:5180/] [--relay 8099] [--reuse-relay] [--shots DIR]
 *
 * --shots DIR saves screenshots of the coloured words, the status window (as it reads normally,
 * restarting and unreachable), the bar buttons, a close being held, a lasso in progress, the
 * selection, a tiled group, a freeform group, the sidebar docked left, the sidebar and status
 * window docked on one edge, and the right-click menu on a terminal, on the canvas and on a group
 * header (and its close being held) (for a person to judge the look; the checks never read them).
 *
 * Needs the wall's Vite (`cd wall && bunx vite`) and a built ./glyph3d-cli. Starts its own relay on
 * --relay (tools/lib/wall-relay.mjs: `serve --relay-only` in the termd namespace `glyph-wall-e2e`, no
 * gomuxai), so it can neither adopt nor kill a person's terminals, and refuses a port something
 * already listens on — the relay takes one display, and a person's may be on it — unless
 * --reuse-relay names one you started (then it says so, and skips the relay-restart steps). Spawns
 * its own terminals and types only into those; on exit (SIGINT included) it kills the relay it
 * started and that namespace's termd daemon.
 * On macOS the browser launches headed (headless is a software renderer there) — a window opens.
 *
 * Covers: spawn, typing, coloured text in the page's pixels (white, bright 97 or 38;2, is near
 * white; bold text keeps its colour; magenta is magenta; the default grey shows over the panel — each read where the grid's own
 * metrics and pose put its cells), the specified colours themselves (CLAUDE.md "Colour": solid runs
 * of the default grey, a true colour, a 256-palette colour, pure white and a cell background, the
 * terminal's panel and the focused title bar's strip, each within ±2 a channel), Shift+Enter into a Kitty-keyboard program (CSI 13;2u: termd encodes the
 * browser's key events in the program's modes) and a paste bracketed as it asked, the mouse for a program that
 * reports it (1000 + 1006: a click on a known cell is exactly its SGR press and release; a drag is no motion
 * under 1000 and once per cell crossed under 1002; an unfocused terminal's click and a Shift+click reach
 * nothing; the wheel over an alt-screen program is wheel reports at the pointer's cell), text selection (a drag
 * across a printed line selects exactly it, its cells in the selection colour in the page's pixels ±2 and
 * the panel's beside them; copyOnSelect fills the selection clipboard; a double-click's word, a triple-click's
 * line; the copy chord puts it on the clipboard; the menu offers copy and paste, and its paste runs in the
 * shell; Ctrl+C with nothing selected is SIGINT; a reporting program gets the plain drag and ⇧-drag
 * selects, the program reading nothing of it), the platform's chord (⌘ on macOS, Ctrl+Alt elsewhere) cycling (reversible),
 * border resize, title-bar drag vs body press, ⌥-drag on the body, top-edge resize, names (shell
 * title → name, palette rename, clear, a long name whole in its bar or handed to its map label, never
 * cut), a second display refused with the reason on its chip, a page reload (names, spots and shell
 * titles come back; a remembered terminal the relay no longer has is pruned), a kill forgetting its
 * name at once, a relay restart (the re-adopted terminal takes typing again with no reload; the next
 * spawn mints a fresh id), a plain wheel over the focused terminal → scrollback while the camera
 * holds, pinch (Ctrl+wheel) there → a canvas zoom, Ctrl + mouse notches → an eased zoom that lands
 * exactly and holds the point under the pointer, a plain wheel elsewhere → a pan on both axes by
 * exactly the deltas, the content moving as a scrolled page's (zoom unchanged), map labels (no
 * overlaps, bar names hidden, trace lines when crowded, click frames exactly like frame(), drag moves
 * the terminal), the shared scene systems serving frames, the core
 * terminal verbs run against the wall (terminal.move, terminal.focus), and termd's status: the chip,
 * the status window (the chord opens it, it lists the wall's terminals from termd's own document, it
 * docks and closes by verb) and a brain restart held long enough to read — the amber restarting notice,
 * then the red unreachable one, both clearing when the brain answers, the shells alive and typing;
 * then hiding and closing (the hovered bar's buttons show; hide hides, and the hidden terminal stays
 * hidden across a reload until the palette finds it — marked hidden — and shows it back at its spot;
 * a short press on close keeps the terminal, a held one kills it, and so does the held close chord),
 * lasso groups (⇧-drag selects what it touches, ⇧-click toggles, the selection's button groups it,
 * the tiling lands where wallLayout computes, a header drag moves every member, freeform members move
 * alone, a killed member leaves its group), the sidebar (lists groups and members, folds, docks,
 * persists across a reload, toggles on its chord) and the two panels together (docked on one edge
 * side by side, the topbar clear of both; the status window's row reveals a hidden terminal; its
 * knobs are wall.config's); then the drafting grid and the settings panel — a title-bar drag lands the
 * body's top-left on a grid crossing, a right / bottom border drag lands that edge on or inside a line
 * in whole cells, a drag with Ctrl held and a drag with snap off (its chord) move by exactly the
 * pointer's travel, the grid's lines in the page's pixels (each where the shader's rule puts it, in
 * its colour ±2, the background between ±2; the minor level gone below gridMinPx; none with the grid
 * off), the background knob reaching the canvas ±2, and the settings panel (its chord puts the keys
 * in its search; a search shows exactly the matching knobs, marked; Enter flips a switch; a field
 * edit sets the knob through wall.config); and the right-click menu (ours on a terminal, opened there
 * with its default prevented; a second right-click closes it and leaves the browser's menu alone, as
 * Shift+right-click does; hide from it; a short click on its close keeps the terminal, a held one
 * kills it; a mouse-reporting program gets the right-click only on the focused terminal (merely
 * hovered, ours) and Shift reaches ours; Esc, a wheel and the menu key; a custom size typed by keys
 * (Esc cancels, 0 refused under the row, Tab, Enter resizes); "new terminal here" lands at the
 * point; a group header's menu sets the layout and ungroups). Exit 1 on any FAIL.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay } from './lib/wall-relay.mjs';
import { dialRelay } from './lib/relay.mjs';
import { brainPid, termdPid } from './lib/termd.mjs';
import { tileLayout, BAR_ROOM } from '../wall/wallLayout.js';
import { snapStep, snapTo } from '../wall/wallSnap.js';
import { searchSettings, KNOBS } from '../wall/wallSettings.js';
import { RESET_FG, ansi256toRGB } from '../packages/glyph3d-core/src/collections/terminalPalette.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
const info = (msg) => console.log(`info  ${msg}`);

const relay = await privateRelay({ port: RELAY, ns: 'glyph-wall-e2e', reuse: process.argv.includes('--reuse-relay') });
let browser = null;
let app = null;
const spawned = [];
/** The page's own loads after its first: the steps' reloads, and every navigation seen (see below). */
let reloads = 0, navigations = 0, crashed = false;
try {
    browser = await launchGpuBrowser({});
    app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 0, viewport: { width: 1400, height: 900 } });
    const page = app.page;
    // The page loads once, and again only where a step reloads it (reload): a navigation of its own
    // (a dev server's hot reload of a saved file, a crash) would hand every later step a fresh wall.
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
    page.on('crash', () => { crashed = true; });
    const reload = async () => { reloads++; await page.reload({ waitUntil: 'load' }); };
    const W = (fn, a) => app.evalPage(fn, a);
    // No step waits a guessed delay: each waits for the state or the event its check reads — a
    // predicate checked once a frame (until), the next drawn frame (frame), the camera at rest
    // (still). A deadline only bounds a failure: it is never the wait.
    /**
     * Wait until a page predicate holds, checked once a frame (a throw counts as not yet); returns
     * its value, or null if `ms` ran out first.
     */
    const until = async (fn, a, ms = 15000) => {
        const h = await page.waitForFunction(([src, arg]) => {
            try { return (0, eval)(`(${src})`)(arg) || false; } catch { return false; }
        }, [String(fn), a], { polling: 'raf', timeout: ms }).catch(() => null);
        return h ? h.jsonValue() : null;
    };
    /** The next frame drawn (TerminalWall.nextFrame): its layout, labels, chrome and pixels are in. */
    const frame = () => W(() => window.__wall.nextFrame());
    /** The camera at rest (no framing ease, no wheel glide), then a frame drawn there. */
    const still = async () => { await until(() => !window.__wall.viewport.moving, null, 10000); await frame(); };
    // Screen geometry of a terminal (CSS px, page coords) + its pose and size.
    const geo = (id) => W((i) => {
        const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect(), g = w.terminal(i);
        const r = w.terminalRect(i), win = w.windowRect(i);
        const sx = (x) => cr.left + cr.width / 2 + (x - v.camera.position.x) * v.zoom;
        const sy = (y) => cr.top + cr.height / 2 - (y - v.camera.position.y) * v.zoom;
        return { left: sx(r.minX), right: sx(r.maxX), top: sy(r.maxY), barTop: sy(win.maxY), bottom: sy(r.minY),
                 pos: { x: g.position.x, y: g.position.y }, cols: g.cols, rows: g.rows, focus: w.focusedId };
    }, id);
    const cam = () => W(() => { const v = window.__wall.viewport; return { zoom: v.zoom, x: v.camera.position.x, y: v.camera.position.y, easing: !!v.target }; });
    const labels = () => W(() => window.__wall.names.mapLabels.shown().map((s) => ({ id: s.id, text: s.text, leader: s.leader, r: { l: s.rect.left, t: s.rect.top, r: s.rect.right, b: s.rect.bottom } })));
    const anyOverlap = (ls) => { for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) { const a = ls[i].r, b = ls[j].r; if (a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t) return true; } return false; };
    const drag = async (x0, y0, x1, y1, mods = []) => {
        for (const m of mods) await page.keyboard.down(m);
        await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up();
        for (const m of mods) await page.keyboard.up(m);
    };
    const screenHas = (id, text) => W(([i, t]) => window.__wall.terminal(i).readText().some((l) => l.trim() === t), [id, text]);
    /** A bar's name as drawn: its text, whether it shows, whether the whole name fits. */
    const barName = (id) => W((i) => { const b = window.__wall.names._bars.get(i); return { text: b.label.text, visible: b.label.visible, fits: b.nameFits, name: window.__wall.nameOf(i) }; }, id);
    /** With --shots, save the page as `<name>.png` (for a person to judge; the checks never read it). */
    const shot = async (name) => { if (SHOTS) { await frame(); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); info(`screenshot ${path.join(SHOTS, `${name}.png`)}`); } };

    ok(app.booted && !!await until(() => window.__wall?.snapshot().connected), `boots and registers as the relay's display on :${RELAY}`);
    ok(!page.url().includes('token='), 'the page scrubbed #token= out of the address bar on boot');
    ok((await W(() => document.querySelector('[data-relay]')?.dataset.relay)) === 'up', 'the relay chip reads up');
    const preexisting = await W(() => window.__wall.order.length);
    if (relay.started) ok(preexisting === 0, `the private relay adopted no live sessions (saw ${preexisting})`);
    else info(`reused relay: ${preexisting} terminal(s) already on the wall — left alone, never typed into`);
    const CHORD = (await W(() => window.__wall.keys.chordKeys)).join('+');
    info(`the platform chord is ${CHORD}`);

    // ── spawn + type ───────────────────────────────────────────────────────
    for (let i = 0; i < 3; i++) { const r = await W(() => window.__wall.spawn()); if (r.ok) spawned.push(r.id); }
    ok(spawned.length === 3, `spawned 3 terminals (${spawned.join(', ')})`);
    const [A, B, C] = spawned;
    await W((i) => window.__wall.focus(i), A);
    // The shell's answer, not the echoed command line: `wall-e2e-42` is only on screen once Enter ran it.
    await page.keyboard.type('echo wall-e2e-$((6*7))');
    await page.keyboard.press('Enter');
    const lastLines = async (i) => JSON.stringify((await W((id) => window.__wall.terminal(id).readText().filter((l) => l.trim()), i)).slice(-4));
    const typedOk = !!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'wall-e2e-42'), A, 8000);
    ok(typedOk, `typing reaches the focused shell and Enter runs it${typedOk ? '' : ` (screen: ${await lastLines(A)})`}`);
    // A shell that asked for no keyboard mode reads Shift+Enter as Enter (\r), as xterm sends it.
    await page.keyboard.type('echo shift-$((1+1))');
    await page.keyboard.press('Shift+Enter');
    const shiftOk = !!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'shift-2'), A, 8000);
    ok(shiftOk, `Shift+Enter runs the line in a plain shell${shiftOk ? '' : ` (screen: ${await lastLines(A)})`}`);

    // ── coloured text reaches the pixels ────────────────────────────────────
    // Pure white is the colour lane's top value (0xFFFFFF: bright white, SGR 97; an explicit
    // 38;2;255;255;255, as Claude Code's ● bullet). A shader that decodes
    // the lane with int(x + 0.5) rounds it to 0x1000000 — black ink on the dark panel. Magenta
    // (red 255, blue ≥ 128) rounds to blue the same way. Each word gets its own line; its cells'
    // screen rect comes from the grid's own metrics and pose, and the page's pixels there are read.
    //
    // Then the colours themselves (CLAUDE.md "Colour"): what a program or a setting specifies is what
    // the canvas holds. A run of █ is solid ink and a run of background-coloured spaces a solid fill,
    // so the median pixel inside each run must be the specified sRGB colour to within ±2 a channel —
    // the default grey, a mid-tone true colour, a 256-palette colour, pure white, an explicit cell
    // background — and so must the terminal's own panel and its title bar's strip.
    {
        const words = [
            { word: 'BRIGHTWHITE', sgr: '97', want: 'white' },
            { word: 'BOLDGREY', sgr: '1', want: 'ink' },   // bold is the bold face: the default grey, not white
            { word: 'RGBWHITE', sgr: '38;2;255;255;255', want: 'white' },
            { word: 'RGBMAGENTA', sgr: '38;2;255;0;255', want: 'magenta' },
            { word: 'PLAINGREY', sgr: null, want: 'ink' },
        ];
        const bytes = (c) => [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
        const RUN = 8;   // cells per solid run; the outer two are left out of the read
        const runs = [
            { label: 'INKGREY', sgr: null, cell: '█', want: bytes(RESET_FG), what: 'the default text grey' },
            { label: 'INKRGB', sgr: '38;2;128;64;200', cell: '█', want: [128, 64, 200], what: 'true colour 38;2;128;64;200' },
            { label: 'INKPAL', sgr: '38;5;67', cell: '█', want: bytes(ansi256toRGB(67)), what: '256-palette colour 67' },
            { label: 'INKWHITE', sgr: '38;2;255;255;255', cell: '█', want: [255, 255, 255], what: 'pure white' },
            { label: 'CELLBG', sgr: '48;2;40;90;160', cell: ' ', want: [40, 90, 160], what: 'cell background 48;2;40;90;160' },
        ];
        const fmt = [
            ...words.map(({ word, sgr }) => (sgr ? `\\033[${sgr}m${word}\\033[0m` : word)),
            ...runs.map(({ label, sgr, cell }) => `${label} ${sgr ? `\\033[${sgr}m` : ''}${cell.repeat(RUN)}\\033[0m`),
        ].join('\\n');
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, `clear; printf '${fmt}\\n'\r`]);
        const marks = [...words.map((w) => w.word), ...runs.map((r) => r.label)];
        const shown = await until(([i, ws]) => { const l = window.__wall.terminal(i).readText().map((x) => x.trim().split(' ')[0]); return ws.every((w) => l.includes(w)); }, [A, marks], 8000);
        ok(!!shown, `the coloured words and runs are on ${A}'s screen${shown ? '' : ` (screen: ${await lastLines(A)})`}`);
        if (shown) {
            await W((i) => window.__wall.focus(i, { frame: true }), A);
            await page.mouse.move(2, 2);   // off every bar: a hovered bar shows its buttons
            await until(() => !window.__wall.viewport.moving, null, 8000);
            // Drawn: the frame after the text applies its screen and asks the atlas for new glyphs; once
            // their outlines land, two more frames upload and draw them.
            await W(async () => {
                const w = window.__wall;
                await w.nextFrame(); await w.nextFrame();
                await w.ctx.atlas._live?.whenIdle();
                await w.nextFrame(); await w.nextFrame();
            });
            // Each word's cells and, as the panel's own colour, ten blank cells two to the right of
            // it; each run's inner cells, the middle half of their height; a stretch of the title
            // bar's strip right of its name; and what the panel and the strip are specified as.
            const cells = await W(([i, ws, rs, RUN]) => {
                const w = window.__wall, g = w.terminal(i), m = g._metrics, v = w.viewport, cr = v.canvas.getBoundingClientRect();
                const sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing, p = g.position, s = g.scale;
                const lines = g.readText();
                const screen = (b) => ({ l: cr.left + b.left, r: cr.left + b.right, t: cr.top + b.top, b: cr.top + b.bottom });
                const box = (row, c0, n, inset = 0) => screen(v.toScreenBox({
                    minX: p.x + c0 * sx * s.x, maxX: p.x + ((c0 + n - 1) * sx + m.charWidth) * s.x,
                    minY: p.y + (-row * sy - m.charHeight / 2 * (1 - inset)) * s.y, maxY: p.y + (-row * sy + m.charHeight / 2 * (1 - inset)) * s.y,
                }));
                const hexBytes = (c) => { const h = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c; return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; };
                const bar = w.names._bars.get(i);
                const win = screen(v.toScreenBox(w.windowRect(i))), body = screen(v.toScreenBox(w.terminalRect(i)));
                const bw = win.r - win.l, bh = body.t - win.t;
                return {
                    words: ws.map((word) => {
                        const row = lines.findIndex((x) => x.trim() === word), col = lines[row].indexOf(word);
                        return { ink: box(row, col, word.length), panel: box(row, col + word.length + 2, 10) };
                    }),
                    runs: rs.map((label) => box(lines.findIndex((x) => x.startsWith(`${label} `)), label.length + 2, RUN - 2, 0.5)),
                    panel: { rect: box(lines.findIndex((x) => x.trim() === ws[0]), ws[0].length + 2, 10, 0.5), want: hexBytes(g._bgColor) },
                    bar: {
                        rect: { l: win.l + bw * 0.6, r: win.l + bw * 0.8, t: win.t + bh * 0.25, b: win.t + bh * 0.75 },
                        want: hexBytes(bar.style.fill.focused), name: bar.label.text, px: bh,
                    },
                };
            }, [A, words.map((w) => w.word), runs.map((r) => r.label), RUN]);
            const all = [...cells.words.flatMap((c) => [c.ink, c.panel]), ...cells.runs, cells.panel.rect, cells.bar.rect];
            const clip = { x: Math.floor(Math.min(...all.map((r) => r.l))), y: Math.floor(Math.min(...all.map((r) => r.t))) };
            clip.width = Math.ceil(Math.max(...all.map((r) => r.r))) - clip.x;
            clip.height = Math.ceil(Math.max(...all.map((r) => r.b))) - clip.y;
            const png = await page.screenshot({ clip, scale: 'css' });
            // Per rect: its brightest pixel (by channel sum), its median pixel (per channel) and how
            // many pixels it read.
            const px = await W(async ([b64, o, rects]) => {
                const img = new Image();
                img.src = `data:image/png;base64,${b64}`;
                await img.decode();
                const cv = new OffscreenCanvas(img.width, img.height), cx = cv.getContext('2d');
                cx.drawImage(img, 0, 0);
                const d = cx.getImageData(0, 0, img.width, img.height).data;
                return rects.map((r) => {
                    const x0 = Math.max(0, Math.round(r.l - o.x)), x1 = Math.min(img.width, Math.round(r.r - o.x));
                    const y0 = Math.max(0, Math.round(r.t - o.y)), y1 = Math.min(img.height, Math.round(r.b - o.y));
                    let best = [0, 0, 0], n = 0;
                    const ch = [[], [], []];
                    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                        const k = (y * img.width + x) * 4, c = [d[k], d[k + 1], d[k + 2]];
                        if (c[0] + c[1] + c[2] > best[0] + best[1] + best[2]) best = c;
                        for (let j = 0; j < 3; j++) ch[j].push(c[j]);
                        n++;
                    }
                    const med = ch.map((a) => (a.sort((p, q) => p - q), a.length ? a[a.length >> 1] : -1));
                    return { best, med, n };
                });
            }, [png.toString('base64'), clip, all]);
            const rgb = (c) => `rgb(${c.join(',')})`;
            words.forEach(({ word, want }, k) => {
                const ink = px[2 * k], panel = px[2 * k + 1];
                const [r, gr, b] = ink.best, bg = panel.best;
                const lift = (r + gr + b) - (bg[0] + bg[1] + bg[2]);
                const pass = want === 'white' ? Math.min(r, gr, b) >= 200
                    : want === 'magenta' ? r >= 200 && b >= 200 && gr <= 0.4 * Math.min(r, b)
                        : lift >= 240;
                const says = want === 'white' ? 'is near white' : want === 'magenta' ? 'reads magenta' : 'shows over the panel';
                ok(pass && ink.n > 0, `${word}'s ink ${says}: brightest ${rgb(ink.best)} over ${ink.n} px, the panel beside it ${rgb(bg)}`);
            });
            /** The specified colour is on the canvas: the rect's median pixel within ±2 a channel. */
            const TRUE_WITHIN = 2;
            const isTrue = (read, want, what) => {
                const off = Math.max(...want.map((v, j) => Math.abs(read.med[j] - v)));
                ok(read.n > 0 && off <= TRUE_WITHIN, `${what} draws as specified: ${rgb(want)} reads ${rgb(read.med)} (off by ${off}, ±${TRUE_WITHIN} allowed; median of ${read.n} px)`);
            };
            const first = 2 * words.length;
            runs.forEach(({ want, what }, k) => isTrue(px[first + k], want, what));
            isTrue(px[first + runs.length], cells.panel.want, `the terminal panel's background`);
            isTrue(px[first + runs.length + 1], cells.bar.want, `the focused title bar's strip (${cells.bar.px.toFixed(0)} px tall, name "${cells.bar.name}")`);
            await shot('coloured-text');
        }
    }

    // ── key events and paste: termd encodes them in the program's own modes ──
    // A program that pushes Kitty keyboard flags (CSI > 1 u) and bracketed paste, then echoes in hex
    // the bytes it reads: the 7 of Shift+Enter, then the 14 of a bracketed "hi". A real Shift+Enter
    // from the browser's keyboard; a real paste event.
    {
        const screen = (i) => W((id) => window.__wall.terminal(id).readText().join(''), i);
        const hexOf = (str) => [...Buffer.from(str)].map((b) => `[${b.toString(16).padStart(2, '0')}]`).join('');
        const prog = (setup, n) => `clear; sh -c 'stty raw -echo; printf "${setup}KEYS-%s" READY; n=0; while [ $n -lt ${n} ]; do `
            + 'b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d " \\n"); printf "[%s]" "$b"; n=$((n+1)); done; '
            + `printf "\\033[<u\\033[?2004l"; stty sane; echo; echo KEYS-$((2+3))'\r`;
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, prog('\\033[>1u\\033[?2004h', 7 + 14)]);
        ok(!!await until((i) => window.__wall.terminal(i).readText().join('').includes('KEYS-READY'), A, 10000), 'a Kitty-keyboard program is up in the focused terminal');
        await page.keyboard.press('Shift+Enter');
        const kitty = hexOf('\x1b[13;2u');
        ok(!!await until(([i, h]) => window.__wall.terminal(i).readText().join('').includes(h), [A, kitty], 8000),
            `Shift+Enter reaches a Kitty-keyboard program as CSI 13;2u (${(await screen(A)).slice(-60)})`);
        await W(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'hi'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
        ok(!!await until(([i, h]) => window.__wall.terminal(i).readText().join('').includes(h), [A, kitty + hexOf('\x1b[200~hi\x1b[201~')], 8000),
            'a paste reaches it bracketed, as it asked');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'KEYS-5'), A, 8000), 'the program read exactly those bytes and ended');
    }

    // ── the mouse: the focused terminal's program hears it, as termd encodes it in its modes ──
    // A program that turns mouse reporting on, then echoes in hex every byte it reads until a `q`.
    // Clicks land on a known cell, found from the grid's own geometry (a slot at its cell's left edge
    // and vertical centre). Nothing reaching the program is shown by a marker key typed after: the
    // program reads the marker next, with nothing between.
    {
        const hexOf = (str) => [...Buffer.from(str)].map((b) => `[${b.toString(16).padStart(2, '0')}]`).join('');
        const screen = (i) => W((id) => window.__wall.terminal(id).readText().join(''), i);
        const mouseProg = (setup, unset) => `clear; sh -c 'stty raw -echo; printf "${setup}MOUSE-%s" READY; while :; do `
            + 'b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d " \\n"); printf "[%s]" "$b"; [ "$b" = 71 ] && break; done; '
            + `printf "${unset}"; stty sane; echo; echo MOUSE-$((4+5))'\r`;
        /** The page point at the middle of cell (c, r) of terminal `id`, from its pose and metrics. */
        const cellXY = (id, c, r) => W(([i, c, r]) => {
            const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect(), g = w.terminal(i), m = g._metrics;
            const sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing;
            const wx = g.position.x + g.scale.x * (c + 0.5) * sx, wy = g.position.y + g.scale.y * (sy / 2 - (r + 0.5) * sy);
            return { x: cr.left + cr.width / 2 + (wx - v.camera.position.x) * v.zoom, y: cr.top + cr.height / 2 - (wy - v.camera.position.y) * v.zoom };
        }, [id, c, r]);
        /** Wait for the program to have read `want` after `from` (hex), then return what it read since. */
        const readSince = async (from, want, ms = 8000) => {
            const got = await until(([i, f, h]) => { const t = window.__wall.terminal(i).readText().join(''); const at = t.indexOf(f); return at >= 0 && t.slice(at + f.length).includes(h) ? t.slice(at + f.length) : null; }, [A, from, want], ms);
            return got;
        };
        const sgr = (b, c, r, end = 'M') => hexOf(`\x1b[<${b};${c + 1};${r + 1}${end}`);
        await W((i) => window.__wall.focus(i, { frame: true }), A);
        await until(() => !window.__wall.viewport.moving, null, 8000);

        // 1000 + 1006: a click on cell (5, 3) is exactly ESC[<0;6;4M then ESC[<0;6;4m.
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, mouseProg('\\033[?1000h\\033[?1006h', '\\033[?1000l\\033[?1006l')]);
        const up1 = await until((i) => window.__wall.terminal(i).readText().join('').includes('MOUSE-READY') && window.__wall.terminal(i).mouseTracking === 'normal', A, 10000);
        ok(!!up1, 'a program with mouse reporting on (1000 + 1006) is up in the focused terminal, and the wall reads its tracking');
        let p = await cellXY(A, 5, 3);
        await page.mouse.click(p.x, p.y);
        const click = sgr(0, 5, 3) + sgr(0, 5, 3, 'm');
        ok(!!await readSince('MOUSE-READY', click), `a click on cell (5, 3) reaches it as exactly ESC[<0;6;4M ESC[<0;6;4m (${(await screen(A)).slice(-80)})`);

        // A drag under normal tracking (1000): the press and the release, no motion between.
        const mark1 = hexOf('z');
        p = await cellXY(A, 2, 1);
        const q = await cellXY(A, 9, 1);
        await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 8 }); await page.mouse.up();
        await page.keyboard.press('z');
        const dragNormal = await readSince(click, mark1);
        ok(dragNormal === sgr(0, 2, 1) + sgr(0, 9, 1, 'm') + mark1, `a drag under 1000 is a press and a release only, no motion (${dragNormal})`);

        // An unfocused terminal's click focuses it and reaches nothing; Shift+click is the wall's.
        await W((i) => window.__wall.focus(i), B);
        p = await cellXY(A, 4, 4);
        await page.mouse.click(p.x, p.y);
        const refocused = await until(([i]) => window.__wall.focusedId === i, [A], 4000);
        const mark2 = hexOf('y');
        await page.keyboard.press('y');
        const afterUnfocused = await readSince(dragNormal, mark2);
        ok(!!refocused && afterUnfocused === mark2, `with ${B} focused, a click on ${A}'s body focuses ${A} and its program reads nothing of it (then: ${afterUnfocused})`);
        await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
        const mark3 = hexOf('x');
        await page.keyboard.press('x');
        const afterShift = await readSince(dragNormal + mark2, mark3);
        ok(afterShift === mark3, `Shift+click on the focused program's body is the wall's: the program reads nothing of it (then: ${afterShift})`);
        await W(() => window.__wall.run(['wall.select', 'none']));
        await page.keyboard.press('q');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'MOUSE-9') && window.__wall.terminal(i).mouseTracking === 'none', A, 8000), 'the program ended on q and turned reporting off');

        // 1002 + 1006 on the alternate screen: a drag reports its motion (once per cell crossed), and
        // the wheel reaches the program as wheel reports at the pointer's cell.
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, mouseProg('\\033[?1049h\\033[?1002h\\033[?1006h', '\\033[?1002l\\033[?1006l\\033[?1049l')]);
        const up2 = await until((i) => window.__wall.terminal(i).readText().join('').includes('MOUSE-READY') && window.__wall.terminal(i).mouseTracking === 'button', A, 10000);
        ok(!!up2, 'a program with button-event tracking (1002 + 1006) is up on the alternate screen');
        p = await cellXY(A, 2, 1);
        const q2 = await cellXY(A, 5, 1);
        await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q2.x, q2.y, { steps: 12 }); await page.mouse.up();
        const mark4 = hexOf('w');
        await page.keyboard.press('w');
        const dragButton = await readSince('MOUSE-READY', mark4);
        const motions = [3, 4, 5].map((c) => sgr(32, c, 1)).join('');
        ok(dragButton === sgr(0, 2, 1) + motions + sgr(0, 5, 1, 'm') + mark4, `a drag under 1002 reports each cell it crosses once, with the button held (${dragButton})`);
        p = await cellXY(A, 7, 2);
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel(0, -120);
        const wheeled = await readSince(dragButton, sgr(64, 7, 2));
        ok(!!wheeled && wheeled.startsWith(sgr(64, 7, 2)), `the wheel over the alt-screen program reaches it as wheel-up reports at the pointer's cell, ESC[<64;8;3M (${wheeled?.slice(0, 80)})`);
        await page.keyboard.press('q');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'MOUSE-9'), A, 8000), 'it ended on q, off the alternate screen');
    }

    // ── text selection: drag, double and triple click, copy, Ctrl+C, a reporting program ──
    // A printed line selected by a drag across it (the text equals it; the selection colour in the
    // page's pixels at its cells, the panel's beside them), a double-click's word, a triple-click's
    // line, the copy chord putting it on the clipboard (Playwright grants clipboard-read/write), the
    // menu's paste typing it back, Ctrl+C with nothing selected still the program's (SIGINT), and a
    // program reporting the mouse getting the plain drag while ⇧-drag selects.
    {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL_).origin });
        const hexOf = (str) => [...Buffer.from(str)].map((b) => `[${b.toString(16).padStart(2, '0')}]`).join('');
        /** The page point at fraction (fx, fy) of cell (c, r) of terminal `id`. */
        const cellAtXY = (id, c, r, fx = 0.5, fy = 0.5) => W(([i, c, r, fx, fy]) => {
            const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect(), g = w.terminal(i), m = g._metrics;
            const sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing;
            const wx = g.position.x + g.scale.x * (c + fx) * sx, wy = g.position.y + g.scale.y * (sy / 2 - (r + fy) * sy);
            return { x: cr.left + cr.width / 2 + (wx - v.camera.position.x) * v.zoom, y: cr.top + cr.height / 2 - (wy - v.camera.position.y) * v.zoom };
        }, [id, c, r, fx, fy]);
        const selText = (id) => W((i) => window.__wall.terminal(i).selectionText(), id);
        const IS_MAC_CHORD = CHORD === 'Meta';
        const COPY = IS_MAC_CHORD ? 'Meta+KeyC' : 'Control+Shift+KeyC';
        await W((i) => window.__wall.focus(i, { frame: true }), A);
        await until(() => !window.__wall.viewport.moving, null, 8000);

        const LINE = 'PICK alpha beta-gamma (delta) epsilon';
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, `clear; printf '%s\\n' '${LINE}'\r`]);
        const row = await until(([i, l]) => { const r = window.__wall.terminal(i).readText().findIndex((x) => x.trim() === l); return r >= 0 ? r + 1 : 0; }, [A, LINE], 8000) - 1;
        ok(row >= 0, `the line to select is on ${A}'s screen (row ${row})`);
        // A drag from the first cell's left part to the last cell's right part: the boundaries 0 and its length.
        let p = await cellAtXY(A, 0, row, 0.15), q = await cellAtXY(A, LINE.length - 1, row, 0.85);
        await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 10 }); await page.mouse.up();
        const dragged = await until(([i, l]) => window.__wall.terminal(i).selectionText() === l, [A, LINE], 4000);
        ok(!!dragged, `a drag across a printed line selects exactly it ("${await selText(A)}")`);
        ok((await W((i) => window.__wall.selectionClipboard, A)) === LINE, 'copyOnSelect (true) put it on the wall\'s selection clipboard');
        // The pixels: the selected cells fill in the selection colour; the cells past it keep the panel's.
        await frame();   // the frame that draws the selection's cells
        const rects = await W(([i, row, n]) => {
            const w = window.__wall, g = w.terminal(i), m = g._metrics, v = w.viewport, cr = v.canvas.getBoundingClientRect();
            const sx = m.charWidth + m.letterSpacing, sy = m.lineSpacing, p = g.position, s = g.scale;
            const box = (c0, k) => { const b = v.toScreenBox({ minX: p.x + c0 * sx * s.x, maxX: p.x + (c0 + k) * sx * s.x, minY: p.y + (-row * sy - sy / 4) * s.y, maxY: p.y + (-row * sy + sy / 4) * s.y }); return { l: cr.left + b.left + 1, r: cr.left + b.right - 1, t: cr.top + b.top, b: cr.top + b.bottom }; };
            const hex = (c) => { const h = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c; return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; };
            return { sel: box(0, n), after: box(n + 2, 8), want: hex(w.config.selectionColor), panel: hex(g._bgColor) };
        }, [A, row, LINE.length]);
        const all = [rects.sel, rects.after];
        const clip = { x: Math.floor(Math.min(...all.map((r) => r.l))), y: Math.floor(Math.min(...all.map((r) => r.t))) };
        clip.width = Math.ceil(Math.max(...all.map((r) => r.r))) - clip.x;
        clip.height = Math.ceil(Math.max(...all.map((r) => r.b))) - clip.y;
        const png = await page.screenshot({ clip, scale: 'css' });
        const med = await W(async ([b64, o, rs]) => {
            const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
            const cv = new OffscreenCanvas(img.width, img.height), cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, img.width, img.height).data;
            return rs.map((r) => {
                const ch = [[], [], []];
                for (let y = Math.max(0, Math.round(r.t - o.y)); y < Math.min(img.height, Math.round(r.b - o.y)); y++)
                    for (let x = Math.max(0, Math.round(r.l - o.x)); x < Math.min(img.width, Math.round(r.r - o.x)); x++) { const k = (y * img.width + x) * 4; for (let j = 0; j < 3; j++) ch[j].push(d[k + j]); }
                return { med: ch.map((a) => (a.sort((u, v) => u - v), a.length ? a[a.length >> 1] : -1)), n: ch[0].length };
            });
        }, [png.toString('base64'), clip, all]);
        const off = (a, b) => Math.max(...a.map((v, j) => Math.abs(v - b[j])));
        ok(med[0].n > 0 && off(med[0].med, rects.want) <= 2, `the selected cells fill in the selection colour: rgb(${rects.want}) reads rgb(${med[0].med}) (median of ${med[0].n} px, ±2)`);
        ok(med[1].n > 0 && off(med[1].med, rects.panel) <= 2, `the cells past the selection keep the panel's colour: rgb(${rects.panel}) reads rgb(${med[1].med})`);
        await shot('text-selection');

        // A double-click: the word under it (Ghostty's boundaries: '-' is a word character, '(' isn't).
        const at = LINE.indexOf('beta-gamma');
        p = await cellAtXY(A, at + 3, row);
        await page.mouse.dblclick(p.x, p.y);
        ok(!!await until(([i]) => window.__wall.terminal(i).selectionText() === 'beta-gamma', [A], 4000), `a double-click selects the word under it ("${await selText(A)}")`);
        p = await cellAtXY(A, LINE.indexOf('delta') + 1, row);
        await page.mouse.click(p.x, p.y, { clickCount: 3 });
        ok(!!await until(([i, l]) => window.__wall.terminal(i).selectionText() === l, [A, LINE], 4000), `a triple-click selects the line ("${await selText(A)}")`);
        ok((await geo(A)).focus === A && !(await W(() => window.__wall.viewport.moving)), 'a double-click on the body frames nothing (the camera holds)');

        // The copy chord: the system clipboard gets it.
        await W(() => navigator.clipboard.writeText('stale'));
        await page.keyboard.press(COPY);
        const copied = await until((l) => navigator.clipboard.readText().then((t) => (t === l ? t : null)), LINE, 4000);
        ok(copied === LINE, `the copy chord (${COPY}) puts the selection on the clipboard (${JSON.stringify(await W(() => navigator.clipboard.readText()))})`);
        ok((await selText(A)) === LINE, 'copying keeps the selection');

        // The menu: Copy shows with a selection; Paste types the clipboard into the shell.
        const mp = await cellAtXY(A, 2, row);
        await page.mouse.click(mp.x, mp.y, { button: 'right' });
        ok(!!await until(() => document.querySelector('[data-wall-menu] [data-menu-item="copy"]') && document.querySelector('[data-wall-menu] [data-menu-item="paste"]'), null, 4000), 'the right-click menu offers copy and paste with text selected');
        await W(() => navigator.clipboard.writeText('echo PASTED-$((6*7))'));
        await page.click('[data-wall-menu] [data-menu-item="paste"]');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.includes('echo PASTED-$((6*7))')), A, 8000), 'the menu\'s paste puts the clipboard at the shell\'s prompt');
        await page.keyboard.press('Enter');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'PASTED-42'), A, 8000), 'the menu\'s paste reaches the shell through the paste path (the line ran)');
        ok(!(await W((i) => window.__wall.terminal(i).hasSelection, A)), 'the selection went when its text scrolled off or changed (or typing dropped it)');

        // A line longer than the terminal is wide: its rows soft-wrapped, a line selection joins them.
        const cols = await W((i) => window.__wall.terminal(i).cols, A);
        const LONG = Array.from({ length: Math.ceil((cols + 30) / 9) }, (_, k) => `wrap${String(k).padStart(3, '0')}`).join(' ');
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, `clear; printf '%s\\n' '${LONG}'\r`]);
        const longRow = await until(([i, l]) => { const t = window.__wall.terminal(i).readText(); const r = t.findIndex((x) => x.startsWith(l.slice(0, 12))); return r >= 0 && t[r + 1]?.trim() ? r + 1 : 0; }, [A, LONG], 8000) - 1;
        p = await cellAtXY(A, 3, longRow + 1);
        await page.mouse.click(p.x, p.y, { clickCount: 3 });
        ok(!!await until(([i, l]) => window.__wall.terminal(i).selectionText() === l, [A, LONG], 4000), `a triple-click on a soft-wrapped line's second row selects the whole line, joined (${(await selText(A)).length} of ${LONG.length} characters)`);
        // After a repaint (termd redraws the screen: a resize, a reconnect, a redraw), are the rows still one line?
        await W((i) => window.__wall.run(['terminal.refresh', i]), A);
        const joinedAfter = await until(([i, r]) => window.__wall.terminal(i)._emulator.wrapped(r + 1) ? 'joined' : null, [A, longRow], 3000);
        info(`after termd's repaint the long line's rows are ${joinedAfter ? 'still one soft-wrapped line' : 'separate lines: the repaint drops soft wraps (a selection across them gets a newline)'}`);

        // Ctrl+C with nothing selected is the program's: SIGINT.
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, `clear; sh -c 'trap "echo GOT-SIGINT; exit 0" INT; echo TRAP-READY; while :; do sleep 0.1; done'\r`]);
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'TRAP-READY'), A, 8000), 'a program trapping SIGINT is up');
        await page.keyboard.press('Control+KeyC');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.includes('GOT-SIGINT')), A, 8000), `Ctrl+C with nothing selected reaches it as SIGINT (${(await W((i) => window.__wall.terminal(i).readText().filter((l) => l.trim()).slice(-2).join(' / '), A))})`);

        // A program that reports the mouse (1002 + 1006): a plain drag is its; ⇧-drag selects.
        const prog = `clear; sh -c 'stty raw -echo; printf "\\033[?1002h\\033[?1006hSEL-%s" READY; while :; do `
            + 'b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d " \\n"); printf "[%s]" "$b"; [ "$b" = 71 ] && break; done; '
            + `printf "\\033[?1002l\\033[?1006l"; stty sane; echo; echo SEL-$((4+5))'\r`;
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, prog]);
        const readyRow = await until((i) => { const g = window.__wall.terminal(i); const r = g.readText().findIndex((l) => l.startsWith('SEL-READY')); return r >= 0 && g.mouseTracking === 'button' ? r + 1 : 0; }, A, 10000) - 1;
        ok(readyRow >= 0, 'a program with button-event tracking is up on the primary screen');
        p = await cellAtXY(A, 0, readyRow, 0.15); q = await cellAtXY(A, 8, readyRow, 0.85);
        await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 10 }); await page.mouse.up();
        const sgrPress = hexOf(`\x1b[<0;1;${readyRow + 1}M`), sgrRelease = hexOf(`\x1b[<0;9;${readyRow + 1}m`);
        const heard = await until(([i, a, b]) => { const t = window.__wall.terminal(i).readText().join(''); return t.includes(a) && t.includes(b); }, [A, sgrPress, sgrRelease], 8000);
        ok(!!heard && !(await W((i) => window.__wall.terminal(i).hasSelection, A)), 'a plain drag goes to the program (its press and release reached it) and selects nothing');
        const before = await W((i) => window.__wall.terminal(i).readText().join(''), A);
        await page.keyboard.down('Shift');
        await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 10 }); await page.mouse.up();
        await page.keyboard.up('Shift');
        ok(!!await until(([i]) => window.__wall.terminal(i).selectionText() === 'SEL-READY', [A], 4000), `⇧-drag over the program selects anyway ("${await selText(A)}")`);
        await W(() => window.__wall.run(['wall.select', 'none']));
        const mark = hexOf('v');
        await page.keyboard.press('v');
        const after = await until(([i, b, m]) => { const t = window.__wall.terminal(i).readText().join(''); return t.length > b.length && t.includes(m) ? t : null; }, [A, before, mark], 8000);
        ok(!!after && after.endsWith(mark) && after.slice(0, -mark.length).trimEnd().endsWith(before.trimEnd().slice(-20)), `the program read nothing of the ⇧-drag (it read the marker next: …${after?.slice(-40)})`);
        await page.keyboard.press('q');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'SEL-9'), A, 8000), 'the program ended on q');
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [A, 'clear\r']);
    }

    // ── termd's status: the chip, the window, a brain restart ─────────────
    {
        const chip = () => W(() => document.querySelector('[data-termd]')?.dataset.termd ?? null);
        const notice = () => W(() => document.querySelector('[data-termd-notice]')?.dataset.termdNotice ?? null);
        const rows = () => W(() => [...document.querySelectorAll('[data-status-row]')].map((r) => r.dataset.statusRow));
        ok(await until(() => document.querySelector('[data-termd]')?.dataset.termd === 'ok', null, 10000), `the termd chip reads ok (${await chip()})`);
        await W(() => window.__wall.focus(null));
        await page.keyboard.press(`${CHORD}+KeyS`);
        const listed = await until((ids) => {
            const got = [...document.querySelectorAll('[data-status-row]')].map((r) => r.dataset.statusRow);
            return ids.every((i) => got.includes(i)) ? got : null;
        }, spawned, 10000);
        ok(!!listed && !!(await W(() => document.querySelector('[data-status-window]'))), `${CHORD}+S opens the status window, and it lists the wall's terminals from termd's document (${listed?.join(', ')})`);
        const head = await W(() => document.querySelector('[data-status-window]').innerText);
        ok(/g3d-termd \S+ · libghostty-vt/.test(head) && /holder \d+/.test(head) && /brain \d+ · gen \d+/.test(head), 'the window names the daemon, its engine, holder and brain');
        await shot('status-window');

        if (relay.started) {
            const holder = termdPid(relay.termdDir, relay.ns), brain = brainPid(relay.termdDir, relay.ns);
            ok(!!holder && !!brain, `found termd's holder (${holder}) and brain (${brain})`);
            const gen0 = await W(() => window.__wall.termd.doc.daemon.brain.generation);
            // Hold the restart long enough to read: the holder stopped can't start the next brain.
            process.kill(holder, 'SIGSTOP');
            try {
                process.kill(brain, 'SIGKILL');
                const restarting = await until(() => document.querySelector('[data-termd-notice]')?.dataset.termdNotice === 'restarting', null, 4000);
                ok(!!restarting && (await chip()) === 'restarting', `a brain restart that lingers shows the amber notice (chip ${await chip()})`);
                ok((await rows()).length === spawned.length, 'while it restarts the window keeps the last document (its terminals are still there)');
                await shot('status-restarting');
                const unreachable = await until(() => document.querySelector('[data-termd-notice]')?.dataset.termdNotice === 'unreachable', null, 9000);
                ok(!!unreachable, `past the relay's grace it reads unreachable (${await notice()})`);
                await shot('status-unreachable');
            } finally {
                process.kill(holder, 'SIGCONT');
            }
            const back = await until((g) => {
                const t = window.__wall.termd;
                return t.state === 'ok' && t.doc?.daemon.brain.generation > g && !document.querySelector('[data-termd-notice]');
            }, gen0, 15000);
            ok(!!back && (await chip()) === 'ok', `when the brain answers the notice clears and the chip reads ok (generation ${gen0} → ${await W(() => window.__wall.termd.doc?.daemon.brain.generation)})`);
            const r = await W(() => window.__wall.termd.doc.daemon.brain);
            ok(r.restarts.crash === 1 && r.last_start.reason === 'crash', `termd's own document counts the crash (restarts ${JSON.stringify(r.restarts)}, last ${r.last_start.reason})`);
            // Input while termd restarts is dropped, never replayed (DESIGN.md "Riding a restart":
            // at most once), and the brain answering is not yet the shell's adapter back on it (it
            // redials on its own backoff): type once the adapter says it has re-subscribed.
            const resubscribed = await relay.logged(new RegExp(`\\[attach\\] ${A}: back on termd`), 35000);
            ok(resubscribed, `after the restart ${A}'s adapter is back on termd (re-subscribed)`);
            await W((i) => window.__wall.focus(i), A);
            await page.keyboard.type('echo after-brain-restart');
            await page.keyboard.press('Enter');
            const typed = await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'after-brain-restart'), A, 8000);
            ok(!!typed, `the shell rode the brain restart: typing reaches it${typed ? '' : ` (screen: ${await lastLines(A)})\n${relay.log().split('\n').filter((l) => /attach|termd/.test(l)).slice(-12).join('\n')}`}`);
            await W(() => window.__wall.focus(null));
        } else info('reused relay: skipped the brain restart (its termd is not this tool\'s to stop)');

        const docked = await W(() => window.__wall.run(['wall.status', 'right']).then((x) => x.text));
        ok(docked.startsWith('OK') && (await W(() => document.querySelector('[data-status-window]')?.dataset.side)) === 'right', `wall.status right docks it (${docked})`);
        const closed = await W(() => window.__wall.run(['wall.status', 'close']).then((x) => x.text));
        ok(closed.startsWith('OK') && !!(await until(() => !document.querySelector('[data-status-window]'), null, 4000)), `wall.status close closes it (${closed})`);
        await W(() => window.__wall.run(['wall.status', 'float']).then(() => window.__wall.run(['wall.status', 'close'])));
        await W((i) => window.__wall.focus(i), A);   // as the steps below expect
    }

    // ── a second display (first unauthenticated, then with token) is refused, and says why ──
    {
        const second = await browser.newPage({ viewport: { width: 900, height: 600 } });
        const u = new URL(URL_); u.searchParams.set('relay', String(RELAY));
        await second.goto(u.toString(), { waitUntil: 'load', timeout: 30000 });
        const unauthChip = await second.waitForFunction(() => {
            const el = document.querySelector('[data-relay]');
            return window.__wall && el?.textContent?.includes('token needed') ? el.textContent : null;
        }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
        ok(!!unauthChip && !(await second.evaluate(() => window.__wall?.snapshot().connected)), `a browser tab with no token cannot connect ("${unauthChip}")`);
        await second.evaluate((t) => window.__wall.run(['wall.token', t]), relay.token());
        const chip = await second.waitForFunction(() => {
            const el = document.querySelector('[data-relay]');
            return el?.dataset.relay === 'refused' ? el.textContent : null;
        }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
        ok(!!chip && chip.includes('another display holds this relay'), `once authenticated, a second display is refused and its chip says why ("${chip}")`);
        await second.close();
        ok(await W(() => window.__wall.snapshot().connected), 'the first display keeps the relay');
    }

    // ── cycling, on the platform's chord ───────────────────────────────────
    await page.keyboard.press(`${CHORD}+BracketRight`);
    const after = await until((a) => { const f = window.__wall.focusedId; return f && f !== a ? f : null; }, A, 4000);
    await page.keyboard.press(`${CHORD}+BracketLeft`);
    ok(!!after && !!(await until((a) => window.__wall.focusedId === a, A, 4000)), `${CHORD}+] moves focus (${A} → ${after}) and ${CHORD}+[ returns`);

    // ── overview, then pointer roles ───────────────────────────────────────
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await still();
    let g = await geo(C);
    await drag((g.left + g.right) / 2, (g.top + g.bottom) / 2, (g.left + g.right) / 2 + 80, (g.top + g.bottom) / 2 + 40);
    let g2 = await geo(C);
    ok(g2.pos.x === g.pos.x && g2.pos.y === g.pos.y && g2.focus === C, 'a body drag never moves the terminal; the press focuses it');

    g = await geo(C);
    await drag((g.left + g.right) / 2, (g.top + g.bottom) / 2, (g.left + g.right) / 2 + 60, (g.top + g.bottom) / 2 + 30, ['Alt']);
    g2 = await geo(C);
    ok(g2.pos.x > g.pos.x && g2.pos.y < g.pos.y, '⌥-drag on the body moves the terminal');

    g = await geo(C);
    await page.mouse.move((g.left + g.right) / 2, (g.top + g.barTop) / 2);
    ok((await W(() => window.__wall.viewport.canvas.style.cursor)) === 'move', 'the cursor over a title bar is "move"');
    await drag((g.left + g.right) / 2, (g.top + g.barTop) / 2, (g.left + g.right) / 2 - 50, (g.top + g.barTop) / 2 - 25);
    g2 = await geo(C);
    ok(g2.pos.x < g.pos.x && g2.pos.y > g.pos.y, 'a title-bar drag moves the terminal');

    g = await geo(C);
    await drag(g.right, (g.top + g.bottom) / 2, g.right + 60, (g.top + g.bottom) / 2);
    // The grid takes its new size from termd's resized stream (the stream is its one writer).
    await until(([i, c]) => window.__wall.terminal(i).cols > c, [C, g.cols], 8000);
    g2 = await geo(C);
    ok(g2.cols > g.cols, `right-border drag adds columns (${g.cols} → ${g2.cols})`);

    g = await geo(C);
    await drag((g.left + g.right) / 2, g.barTop, (g.left + g.right) / 2, g.barTop - 50);
    await until(([i, r]) => window.__wall.terminal(i).rows > r, [C, g.rows], 8000);
    g2 = await geo(C);
    ok(g2.rows > g.rows, `top-edge (bar top) drag adds rows (${g.rows} → ${g2.rows})`);

    // ── names ──────────────────────────────────────────────────────────────
    await W((i) => window.__wall.terminal(i).sendInput('cd /tmp\r'), B);
    const titled = await until((i) => { const n = window.__wall.nameOf(i); return n === '/tmp' ? n : null; }, B, 8000) ?? await W((i) => window.__wall.nameOf(i), B);
    ok(titled === '/tmp', `a terminal is named by its shell title ("${titled}")`);
    await W((i) => window.__wall.focus(i), B);
    // Typed up to the action label's quote: a shell prompt (a path with "worktrees" in it) can
    // fuzzy-match a bare 'rename' and rank a terminal above the action.
    await page.keyboard.press(`${CHORD}+KeyK`); await page.keyboard.type('rename "'); await page.keyboard.press('Enter');
    // A name no path holds: the other terminals' titles are their cwd, and a checkout under a
    // directory named like the search ("…-scratch/…") would match it too.
    await page.keyboard.type('e2e quokka'); await page.keyboard.press('Enter');
    ok(!!await until((i) => window.__wall.nameOf(i) === 'e2e quokka', B, 4000), 'the palette renames the focused terminal');
    await W(() => window.__wall.focus(null));
    await page.keyboard.press(`${CHORD}+KeyK`); await page.keyboard.type('quokka'); await page.keyboard.press('Enter');
    ok(!!await until((i) => window.__wall.focusedId === i, B, 4000), 'the palette finds it by name');
    await W((i) => window.__wall.rename(i, ''), B);
    ok((await W((i) => window.__wall.nameOf(i), B)) === '/tmp', 'an empty name falls back to the shell title');

    // A name too long for its bar: whole, shrunk to fit — or, past the bar's text floor, on its map label.
    const LONG = 'a terminal name long enough that no title bar at the overview could hold it at a readable size';
    await W(([i, n]) => window.__wall.rename(i, n), [C, LONG]);
    await W((i) => window.__wall.focus(i, { frame: true }), C); await still();
    let bn = await barName(C);
    ok(bn.text === LONG && bn.visible && bn.fits, `framed, the long name sits whole in its bar (fits=${bn.fits}, ${bn.text.length} chars)`);
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await still();
    bn = await barName(C);
    const onMap = (await labels()).find((l) => l.id === C);
    ok(bn.text === LONG && ((bn.visible && bn.fits) || (!bn.visible && onMap?.text === LONG)),
        `at the overview it's still whole: ${bn.visible ? 'in the bar' : `on its map label ("${onMap?.text?.slice(0, 24)}…" shown: ${!!onMap})`}, never cut`);
    // Wide enough for its bar (no narrow-terminal handoff), but the whole name would shrink past the
    // bar's text floor: the map label carries it.
    await W((i) => {
        const v = window.__wall.viewport, r = window.__wall.terminalRect(i);
        v.target = null; v.camera.zoom = 260 / (r.maxX - r.minX);
        v.camera.position.x = (r.minX + r.maxX) / 2; v.camera.position.y = (r.minY + r.maxY) / 2;
        v.camera.updateProjectionMatrix();
    }, C);
    await frame();   // the frame that lays the names out at this zoom
    bn = await barName(C);
    const floored = (await labels()).find((l) => l.id === C);
    ok(!bn.fits && !bn.visible && bn.text === LONG && floored?.text === LONG,
        `on a 260 px terminal the whole name is past the bar's floor: its map label carries it (fits=${bn.fits}, label ${floored ? 'shown' : 'missing'})`);
    await W((i) => window.__wall.rename(i, 'keep me'), C);

    // ── the core terminal verbs, run against the wall (what the CLI reaches) ──
    const mv = await W((i) => window.__wall.router.execute(`terminal.move ${i} 7 -3 0`).then((r) => r.text), C);
    const at = await W((i) => { const p = window.__wall.terminal(i).position; return { x: p.x, y: p.y }; }, C);
    const kept = await W(() => JSON.parse(localStorage.getItem(window.__wall.store.keys.positions) || '{}'));
    ok(mv.startsWith('OK') && at.x === 7 && at.y === -3 && kept[C]?.x === 7 && kept[C]?.y === -3,
        `terminal.move places a terminal and the wall remembers the spot (${mv})`);
    const fv = await W((i) => window.__wall.router.execute(`terminal.focus ${i}`).then((r) => r.text), C);
    ok(fv.startsWith('OK') && (await W(() => window.__wall.focusedId)) === C, `terminal.focus makes it the wall's keyboard target (${fv})`);
    const served = await W(async () => {
        const fr = window.__glyphClient.ctx.sceneSystems.flatRoot;
        let n = 0;
        const prev = fr.root.onAfterRender;
        fr.root.onAfterRender = (...a) => { n++; prev(...a); };
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
        fr.root.onAfterRender = prev;
        return { frames: n, refused: fr.refused, drawables: fr.stats.drawables };
    });
    ok(served.frames > 0 && !served.refused && served.drawables > 0,
        `the shared scene systems serve the view: the flat root rendered ${served.frames} of 3 frames, ${served.drawables} drawables, refused=${JSON.stringify(served.refused)}`);

    // ── a kill forgets its terminal's name and spot at once ────────────────
    {
        const r = await W(() => window.__wall.spawn());
        const D = r.id;
        await W((i) => window.__wall.rename(i, 'doomed'), D);
        await W((i) => window.__wall.kill(i), D);
        const gone = await until((i) => !window.__wall.terminal(i), D, 8000);
        const mem = await W((i) => { const s = window.__wall.store; return { name: s.name(i), pos: s.position(i) }; }, D);
        ok(r.ok && gone && mem.name === null && mem.pos === null, `a wall kill closes ${D} and forgets its name and spot`);
    }

    // ── a page reload: names, spots and shell titles come back; the dead are pruned ──
    {
        await W(() => window.__wall.store.setName('term-9999', 'a session long gone'));
        const before = await W((ids) => ids.map((i) => { const p = window.__wall.terminal(i).position; return { x: p.x, y: p.y }; }), spawned);
        await reload();
        const back = await until((ids) => window.__wall?.snapshot().connected && ids.every((i) => window.__wall.terminal(i)), spawned, 20000);
        ok(!!back, `after a reload the wall re-adopts all ${spawned.length} terminals`);
        // The shell's title rides the adoption repaint; the given name, the store.
        await until(([b, c]) => window.__wall.nameOf(b) === '/tmp' && window.__wall.nameOf(c) === 'keep me', [B, C], 8000);
        const names = await W((ids) => ids.map((i) => window.__wall.nameOf(i)), spawned);
        const now = await W((ids) => ids.map((i) => { const p = window.__wall.terminal(i).position; return { x: p.x, y: p.y }; }), spawned);
        ok(names[1] === '/tmp', `the shell's title comes back with its grid (${B}: "${names[1]}") — termd puts it in every repaint`);
        ok(names[2] === 'keep me', `a given name survives the reload (${C}: "${names[2]}")`);
        ok(now.every((p, k) => p.x === before[k].x && p.y === before[k].y), 'every terminal is back at its spot');
        ok((await W(() => window.__wall.store.name('term-9999'))) === null, 'a remembered terminal the relay no longer has is forgotten on connect');
    }

    // ── a relay restart: mints a fresh random token, reconciles in place, re-adopts with no reload ──
    if (relay.started) {
        await W((i) => window.__wall.focus(i), A);
        // Controller ids restart with the relay (the new adapter may well be ctrl-0 again), so the
        // re-adoption shows as the grid's input route being rebuilt, not as a new owner string.
        const owner0 = await W((i) => { window.__inputBefore = window.__wall.terminal(i).onInput; return window.__glyphClient.ctx.registry.get(i).meta.owner; }, A);
        const tokBefore = relay.token();
        await relay.restart();
        const tokAfter = relay.token();
        ok(!!tokAfter && tokAfter !== tokBefore, 'a restarted relay mints a fresh per-start random token');
        // Take the new relay's first controller id before the adapters reconnect, so the old owner's
        // id now names a controller that isn't the terminal's adapter: input still addressed to the
        // old owner lands nowhere, as it does when a restarted relay hands the ids out in a new order.
        const squatter = await dialRelay(RELAY);
        info(`restarted the private relay on :${RELAY}; a bystander controller holds ${squatter.hello.replace('OK: connected as ', '')}`);
        await W((t) => window.__wall.run(['wall.token', t]), tokAfter);
        const readopted = await until((i) => window.__wall.snapshot().connected && typeof window.__wall.terminal(i)?.onInput === 'function' && window.__wall.terminal(i).onInput !== window.__inputBefore, A, 25000);
        const owner1 = await W((i) => window.__glyphClient.ctx.registry.get(i)?.meta.owner, A);
        ok(!!readopted, `the wall reconnects and ${A} is re-adopted by a new adapter — its input route rebuilt (owner ${owner0} → ${owner1})`);
        await W((i) => window.__wall.focus(i), A);
        await page.keyboard.type('echo after-restart-typed');
        await page.keyboard.press('Enter');
        ok(!!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'after-restart-typed'), A, 8000), 'typing reaches the re-adopted shell without a reload');
        squatter.close();
        const r = await W(() => window.__wall.spawn());
        if (r.ok) spawned.push(r.id);
        ok(r.ok && !spawned.slice(0, -1).includes(r.id), `a spawn after the restart mints a fresh id (${r.id}), never a live session's`);
    } else info('reused relay: skipped the relay-restart steps');

    // ── wheel + pinch over the focused terminal ────────────────────────────
    await W((i) => window.__wall.terminal(i).sendInput('clear; seq 1 300\r'), A);
    await W((i) => window.__wall.focus(i, { frame: true }), A); await still();
    g = await geo(A);
    const top0 = await W((i) => window.__wall.terminal(i).readText().find((l) => l.trim()), A);
    const c0 = await cam();
    await page.mouse.move((g.left + g.right) / 2, (g.top + g.bottom) / 2);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
    // termd answers a scroll with the view's rows: the screen's first line moves.
    const top1 = await until(([i, t]) => { const l = window.__wall.terminal(i).readText().find((x) => x.trim()); return l !== t ? l : null; }, [A, top0], 8000)
        ?? await W((i) => window.__wall.terminal(i).readText().find((l) => l.trim()), A);
    const c1 = await cam();
    ok(top1 !== top0 && c1.zoom === c0.zoom && c1.x === c0.x, `wheel over the focused terminal scrolls its history ("${top0?.trim().slice(0, 12)}" → "${top1?.trim().slice(0, 12)}"), camera still`);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 120);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -40); await page.keyboard.up('Control');
    ok(!!await until((z) => window.__wall.viewport.zoom !== z, c1.zoom, 4000), 'pinch (Ctrl+wheel) over the focused terminal zooms the canvas');
    await still();

    // ── wheel zoom: the zoom modifier + mouse notches glide about the pointer, land exactly, hold the point under it ──
    // Control is a zoom key on every platform (chord.js zoomsWheel, the zoomKeys knob: ctrl alt meta).
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await still();
    const cr = await W(() => { const r = window.__wall.viewport.canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.4 }; });
    await page.mouse.move(cr.x, cr.y);
    // The deltas the page receives, which are what the wall zooms (and pans) by: a synthetic wheel of
    // 100 px reaches a headed macOS Chrome as 200 (measured), so the notches are counted from them.
    const z0 = await W((p) => {
        const v = window.__wall.viewport;
        window.__wheelSeen = [];
        window.addEventListener('wheel', (e) => window.__wheelSeen.push([e.deltaX, e.deltaY, e.deltaMode]), { capture: true });
        return { zoom: v.zoom, at: v.toWorld(p.x, p.y), step: v.wheelZoom.stepFactor, perNotch: v.wheelZoom.pixelsPerNotch };
    }, cr);
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    const mid = await W(() => window.__wall.viewport.moving);
    await until(() => !window.__wall.viewport.moving, null, 8000);   // the glide landed
    const z1 = await W((p) => { const v = window.__wall.viewport; return { zoom: v.zoom, at: v.toWorld(p.x, p.y), moving: v.moving }; }, cr);
    const seen = await W(() => window.__wheelSeen.splice(0));
    const notches = -seen.reduce((n, [, dy, mode]) => n + (mode === 0 ? dy : NaN), 0) / z0.perNotch;
    const zWant = z0.zoom * z0.step ** notches;
    ok(seen.length === 3 && notches > 0 && mid && !z1.moving && Math.abs(z1.zoom / zWant - 1) < 1e-6,
        `three Ctrl+wheel notches glide (moving mid-way) and land exactly at ${z0.step}^${notches} for the deltas the page got (${seen.map(([, dy]) => dy).join(' ')} px; zoom ${z0.zoom.toFixed(4)} → ${z1.zoom.toFixed(4)}, want ${zWant.toFixed(4)})`);
    ok(Math.hypot(z1.at.x - z0.at.x, z1.at.y - z0.at.y) * z1.zoom < 0.5, 'the world point under the pointer stays under it through the glide');

    // ── wheel pan: a plain wheel (nothing focused) pans by exactly its deltas, zoom unchanged ──
    // + deltaY is a scroll down: the view moves down the world (camera y falls) and the content rises,
    // as a page's does; + deltaX moves the view right (camera x grows).
    const p0 = await cam();
    await page.mouse.wheel(60, 100);
    await until(() => window.__wheelSeen.length > 0 && !window.__wall.viewport.moving, null, 4000);
    const p1 = await cam();
    const panSeen = await W(() => window.__wheelSeen.splice(0));
    const pdx = panSeen.reduce((n, [dx, , mode]) => n + (mode === 0 ? dx : NaN), 0);
    const pdy = panSeen.reduce((n, [, dy, mode]) => n + (mode === 0 ? dy : NaN), 0);
    ok(panSeen.length > 0 && pdx > 0 && pdy > 0 && p1.zoom === p0.zoom
        && Math.abs((p1.x - p0.x) * p0.zoom - pdx) < 1e-6 && Math.abs((p0.y - p1.y) * p0.zoom - pdy) < 1e-6,
        `a plain wheel pans by its deltas (${pdx}, ${pdy} px → camera ${((p1.x - p0.x) * p0.zoom).toFixed(2)}, ${((p0.y - p1.y) * p0.zoom).toFixed(2)} px right / down), the content moving up-left, zoom unchanged (${p0.zoom.toFixed(4)} → ${p1.zoom.toFixed(4)})`);

    // ── map labels ─────────────────────────────────────────────────────────
    for (let i = 0; i < 5; i++) { const r = await W(() => window.__wall.spawn()); if (r.ok) spawned.push(r.id); }
    await W((ids) => { const n = ['build', 'api server', 'tests (watch)', 'agent: root', 'agent: camera', 'logs', 'db shell', 'scratch', 'extra']; ids.forEach((id, k) => window.__wall.rename(id, n[k])); }, spawned);
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await still();
    const zoomOut = async (f) => { await W((k) => { const v = window.__wall.viewport; v.target = null; v.camera.zoom *= k; v.camera.updateProjectionMatrix(); }, f); await frame(); };
    await zoomOut(0.3);
    let ls = await labels();
    const total = await W(() => window.__wall.order.length);
    ok(ls.length === total && !anyOverlap(ls), `zoomed out: ${ls.length} map labels for ${total} terminals, none overlapping`);
    ok(await W(() => [...window.__wall.order].every((id) => !window.__wall.names._bars.get(id).label.visible)), 'bar names hide while map labels carry them');
    await zoomOut(0.35);
    ls = await labels();
    ok(!anyOverlap(ls) && ls.some((l) => l.leader), `crowded: ${ls.length} shown, no overlaps, trace lines on ${ls.filter((l) => l.leader).map((l) => l.text).join(', ') || 'none'}`);

    // Label drag moves its terminal; label click frames it exactly as frame() would.
    await zoomOut(1 / 0.35);
    ls = await labels();
    const lab = ls.find((l) => l.text === 'logs') ?? ls[0];
    const before = await W((i) => { const p = window.__wall.terminal(i).position; return { x: p.x, y: p.y }; }, lab.id);
    await drag((lab.r.l + lab.r.r) / 2, (lab.r.t + lab.r.b) / 2, (lab.r.l + lab.r.r) / 2 + 40, (lab.r.t + lab.r.b) / 2 + 20);
    const moved = await W((i) => { const p = window.__wall.terminal(i).position; return { x: p.x, y: p.y }; }, lab.id);
    ok(moved.x > before.x && moved.y < before.y, `dragging the "${lab.text}" label moves its terminal`);
    ls = await labels();
    const lab2 = ls.find((l) => l.id === lab.id);
    await page.mouse.click((lab2.r.l + lab2.r.r) / 2, (lab2.r.t + lab2.r.b) / 2);
    await until((i) => window.__wall.focusedId === i, lab.id, 4000);
    await still();
    const landed = await cam();
    const want = await W((i) => window.__wall.frameTarget(i), lab.id);
    ok(Math.abs(landed.zoom / want.zoom - 1) < 1e-3 && Math.hypot(landed.x - want.x, landed.y - want.y) < 1e-3,
        `a label click focuses + frames exactly at frame()'s target (zoom ${landed.zoom.toFixed(3)} vs ${want.zoom.toFixed(3)})`);
    bn = await barName(lab.id);
    ok(!(await labels()).some((l) => l.id === lab.id) && bn.visible && bn.fits && bn.text === bn.name,
        `framed, its name is back in the bar ("${bn.text}", visible=${bn.visible})`);

    // ── hide + close: the hovered bar's buttons ────────────────────────────
    /** A shown element's centre (page CSS px), or null. */
    const box = (sel) => W((s) => {
        const el = document.querySelector(s);
        if (!el || getComputedStyle(el).display === 'none' || getComputedStyle(el.parentElement).display === 'none') return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    const pos = (id) => W((i) => { const p = window.__wall.terminal(i)?.position; return p ? { x: p.x, y: p.y } : null; }, id);
    const hoverBar = async (id) => { const b = await geo(id); await page.mouse.move((b.left + b.right) / 2 - 40, (b.top + b.barTop) / 2);
        await until((i) => { const el = document.querySelector('[data-bar-buttons]'); return el?.dataset.id === i && getComputedStyle(el).display !== 'none'; }, id, 4000); };
    const HOLD = await W(() => window.__wall.config.closeHoldMs);
    /** Spawn `n` terminals of our own and park them in a row clear of every other terminal, framed. */
    const park = async (n) => {
        const ids = [];
        for (let i = 0; i < n; i++) { const r = await W(() => window.__wall.spawn()); if (r.ok) { ids.push(r.id); spawned.push(r.id); } }
        await W(async (own) => {
            const w = window.__wall;
            let x = Math.max(...w.order.filter((i) => !own.includes(i)).map((i) => w.terminalRect(i).maxX)) + 60;
            for (const [k, id] of own.entries()) {
                await w.router.execute(`terminal.move ${id} ${x} ${-k * 25} 0`);
                x = w.terminalRect(id).maxX + 40;
            }
            w.focus(null);
            const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            for (const id of own) { const r = w.windowRect(id); u.minX = Math.min(u.minX, r.minX); u.minY = Math.min(u.minY, r.minY); u.maxX = Math.max(u.maxX, r.maxX); u.maxY = Math.max(u.maxY, r.maxY); }
            w.viewport.easeTo(w.viewport.fitTarget(u, own.length > 1 ? 0.7 : 0.6));
        }, ids);
        await still();
        return ids;
    };
    {
        const [H] = await park(1);
        await W((i) => window.__wall.rename(i, 'hide me'), H);
        await hoverBar(H);
        const cluster = await W(() => { const el = document.querySelector('[data-bar-buttons]'); return { shown: getComputedStyle(el).display !== 'none', id: el.dataset.id }; });
        ok(cluster.shown && cluster.id === H, `hovering ${H}'s title bar shows its buttons (${JSON.stringify(cluster)})`);
        await shot('hover-buttons');
        const spot = await pos(H);
        const hb = await box('[data-bar-buttons] [data-action="hide"]');
        await page.mouse.click(hb.x, hb.y);
        await until((i) => window.__wall.store.hidden(i), H, 4000);
        const hid = await W((i) => { const w = window.__wall; return { hidden: w.store.hidden(i), visible: w.terminal(i).visible, shown: w.shownOrder().includes(i) }; }, H);
        ok(hid.hidden && !hid.visible && !hid.shown, `a click on hide takes ${H} off the canvas (${JSON.stringify(hid)})`);

        await reload();
        const back = await until((ids) => window.__wall?.snapshot().connected && ids.every((i) => window.__wall.terminal(i)), spawned, 20000);
        await frame();
        const stillHidden = await W((i) => ({ hidden: window.__wall.store.hidden(i), visible: window.__wall.terminal(i).visible }), H);
        ok(!!back && stillHidden.hidden && !stillHidden.visible, `after a reload ${H} is re-adopted (it kept running) and still hidden`);

        await page.keyboard.press(`${CHORD}+KeyK`);
        await until(() => document.activeElement?.tagName === 'INPUT', null, 4000);
        await page.keyboard.type(await W((i) => window.__wall.nameOf(i), H));
        const row = await until((i) => { const el = document.querySelector(`[data-item="terminal:${i}"]`); return el ? { hidden: el.hasAttribute('data-hidden'), text: el.textContent } : null; }, H);
        ok(!!row?.hidden, `the palette finds the hidden terminal, marked hidden ("${row?.text}")`);
        await page.click(`[data-item="terminal:${H}"]`);
        await until((i) => !window.__wall.store.hidden(i) && window.__wall.focusedId === i, H, 4000);
        await still();
        const shownBack = await W((i) => ({ hidden: window.__wall.store.hidden(i), visible: window.__wall.terminal(i).visible, focus: window.__wall.focusedId }), H);
        const spot2 = await pos(H);
        ok(!shownBack.hidden && shownBack.visible && shownBack.focus === H && spot2.x === spot.x && spot2.y === spot.y,
            `choosing it shows it back at its own spot, focused (${JSON.stringify(shownBack)})`);

        await page.keyboard.press(`${CHORD}+Minus`);
        const chordHid = !!await until((i) => window.__wall.store.hidden(i), H, 4000);
        const sv = await W((i) => window.__wall.run(['wall.show', i]).then((r) => r.text), H);
        ok(chordHid && sv.startsWith('OK') && !(await W((i) => window.__wall.store.hidden(i), H)), `${CHORD}+- hides the focused terminal; wall.show brings it back (${sv})`);
    }
    {
        const [K] = await park(1);
        await hoverBar(K);
        const cb = await box('[data-bar-buttons] [data-action="close"]');
        const ringOn = (on) => until((want) => (document.querySelector('[data-bar-buttons] [data-action="close"]')?.dataset.holding === '1') === want, on, 3000);
        // A short press: let go once the ring has started. Its cancel clears the hold's timer
        // (holdPress: holding = a timer pending), so once the ring is off nothing can kill it.
        await page.mouse.move(cb.x, cb.y); await page.mouse.down();
        const began = await ringOn(true);
        await page.mouse.up();
        const letGo = await ringOn(false);
        ok(!!began && !!letGo && !!(await W((i) => window.__wall.terminal(i), K)), `a short press on close starts the ring, lets go, and keeps ${K}`);
        // Held: the ring fills (the shot when it's half way) and closing it kills the terminal while the button is still down.
        await page.mouse.move(cb.x, cb.y); await page.mouse.down();
        const filling = await ringOn(true);
        if (SHOTS) {
            await until(() => { const c = document.querySelector('[data-bar-buttons] [data-action="close"] svg circle'); return c && parseFloat(getComputedStyle(c).strokeDashoffset) < 2 * Math.PI * 8.5 / 2; }, null, HOLD + 3000);
            await shot('close-hold');
        }
        const gone = await until((i) => !window.__wall.terminal(i), K, HOLD + 8000);
        await page.mouse.up();
        ok(!!filling && !!gone && (await W((i) => window.__wall.store.position(i), K)) === null, `a press held ${HOLD} ms fills the ring and kills ${K}, forgotten`);

        const K2 = (await W(() => window.__wall.spawn())).id;
        spawned.push(K2);
        await W((i) => window.__wall.focus(i), K2);
        /** Hold the close chord until `held` resolves, then let go. */
        const holdChord = async (held) => {
            for (const k of CHORD.split('+')) await page.keyboard.down(k);
            await page.keyboard.down('KeyX');
            const v = await held();
            await page.keyboard.up('KeyX');
            for (const k of CHORD.split('+').reverse()) await page.keyboard.up(k);
            return v;
        };
        const holding = (on) => until(([i, want]) => (window.__wall.barButtons.holdTarget === i) === want, [K2, on], 3000);
        // Let go once the hold has started; once it's released no timer is left to kill it.
        const chordBegan = await holdChord(() => holding(true));
        const kept = !!chordBegan && !!(await holding(false)) && !!(await W((i) => window.__wall.terminal(i), K2));
        const gone2 = await holdChord(() => until((i) => !window.__wall.terminal(i), K2, HOLD + 8000));
        ok(kept && !!gone2, `${CHORD}+X held closes the focused terminal; let go early, it stays`);
    }

    // ── the right-click menu: ours first, the browser's on a second right-click or with Shift ──
    {
        const [M, M2] = await park(2);
        // Every contextmenu's defaultPrevented as it leaves the page (bubble, after the wall's capture
        // listener) — then prevented here, so a headed run opens no native menu over the page.
        await W(() => { window.__ctxPrevented = []; window.addEventListener('contextmenu', (e) => { window.__ctxPrevented.push(e.defaultPrevented); e.preventDefault(); }); });
        const prevented = () => W(() => window.__ctxPrevented.at(-1));
        const menuOn = (want) => until((w) => { const m = window.__wall.menu; const el = document.querySelector('[data-wall-menu]'); return w === null ? !m && !el : !!m && !!el && el.dataset.target === w && getComputedStyle(el).visibility === 'visible'; }, want, 5000);
        const mid = (b) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
        const body = mid(await geo(M));
        const rows = () => W(() => [...document.querySelectorAll('[data-wall-menu] [data-menu-item]')].map((el) => el.dataset.menuItem));

        await page.mouse.click(body.x, body.y, { button: 'right' });
        const opened = await menuOn(`terminal:${M}`);
        ok(!!opened && (await prevented()) === true, `a right-click on ${M} opens our menu there, its default prevented (rows: ${(await rows()).join(' ')})`);
        const hint = await W(() => document.querySelector('[data-wall-menu] [data-menu-hint]')?.textContent);
        ok(!!hint, `its footer says a second right-click gives the browser's menu ("${hint}")`);
        await shot('menu-terminal');
        await page.mouse.click(body.x, body.y, { button: 'right' });
        const closed = await menuOn(null);
        ok(!!closed && (await prevented()) === false, 'a second right-click while it is open closes ours and leaves defaultPrevented false (the browser menu comes)');

        await page.keyboard.down('Shift'); await page.mouse.click(body.x, body.y, { button: 'right' }); await page.keyboard.up('Shift');
        ok((await prevented()) === false && !(await W(() => window.__wall.menu)), 'Shift+right-click on a terminal is the browser\'s: not prevented, ours stays shut');

        await page.mouse.click(body.x, body.y, { button: 'right' });
        await menuOn(`terminal:${M}`);
        await page.click('[data-wall-menu] [data-menu-item="hide"]');
        const hidden = await until((i) => window.__wall.store.hidden(i) && !window.__wall.menu, M, 5000);
        ok(!!hidden, `choosing hide hides ${M} and closes the menu`);
        await W((i) => window.__wall.run(['wall.show', i]), M);

        await page.mouse.click(body.x, body.y, { button: 'right' });
        await menuOn(`terminal:${M}`);
        const cl = await box('[data-wall-menu] [data-menu-item="close"]');
        await page.mouse.move(cl.x, cl.y); await page.mouse.down();
        const started = await until(() => document.querySelector('[data-wall-menu] [data-menu-item="close"]')?.dataset.holding === '1', null, 3000);
        await page.mouse.up();
        // Let go: the ring runs back and no timer is left that could still kill it (holdPress: holding = a timer pending).
        const let_go = await until(() => document.querySelector('[data-wall-menu] [data-menu-item="close"]')?.dataset.holding === undefined, null, 3000);
        ok(!!started && !!let_go && !!(await W((i) => window.__wall.terminal(i), M)) && !!(await W(() => window.__wall.menu)),
            `a short click on the menu's close starts the ring, lets go, and keeps ${M} (the menu stays open)`);
        await page.mouse.move(cl.x, cl.y); await page.mouse.down();
        await until(() => document.querySelector('[data-wall-menu] [data-menu-item="close"]')?.dataset.holding === '1', null, 3000);
        await shot('menu-close-hold');
        const killed = await until((i) => !window.__wall.terminal(i), M, HOLD + 8000);
        await page.mouse.up();
        ok(!!killed && (await W((i) => window.__wall.store.position(i), M)) === null && !(await W(() => window.__wall.menu)),
            `holding the menu's close for ${HOLD} ms kills ${M}, forgets it and closes the menu`);

        // A terminal whose program turned mouse reporting on: only the FOCUSED one hands its right-click to
        // the program (Shift reaches ours); merely hovered, its right-click opens ours.
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [M2, "printf '\\033[?1000h'\r"]);
        const reporting = await until((i) => window.__wall.mouseReporting(i), M2, 8000);
        await W(() => window.__wall.focus(null));
        const b2 = mid(await geo(M2));
        await page.mouse.click(b2.x, b2.y, { button: 'right' });
        const hoveredOurs = await menuOn(`terminal:${M2}`);
        ok(!!reporting && !!hoveredOurs && (await prevented()) === true,
            `with mouse reporting on (DECSET 1000) but ${M2} not focused, a right-click on its body opens our menu`);
        await page.keyboard.press('Escape');
        await menuOn(null);
        await W((i) => window.__wall.focus(i), M2);
        await page.mouse.click(b2.x, b2.y, { button: 'right' });
        const progPrevented = await prevented();
        const noMenu = !(await W(() => window.__wall.menu));
        await page.keyboard.down('Shift'); await page.mouse.click(b2.x, b2.y, { button: 'right' }); await page.keyboard.up('Shift');
        const shiftOurs = await menuOn(`terminal:${M2}`);
        ok(progPrevented === true && noMenu && !!shiftOurs && (await prevented()) === true,
            `focused, a right-click on ${M2}'s body goes to its program (no menu, no browser menu); Shift+right-click opens ours`);
        await page.keyboard.press('Escape');
        ok(!!(await menuOn(null)), 'Esc closes the menu');
        // Ctrl+U first: the right-click went to the shell as X10 mouse reports, typed into its line.
        await W(([i, c]) => window.__wall.terminal(i).sendInput(c), [M2, "\x15printf '\\033[?1000l'\r"]);
        await until((i) => !window.__wall.mouseReporting(i), M2, 8000);

        // The menu key on the focused terminal opens it there.
        await W((i) => window.__wall.focus(i), M2);
        await page.keyboard.press('ContextMenu');
        ok(!!(await menuOn(`terminal:${M2}`)), `the ContextMenu key opens the menu on the focused terminal ${M2}`);
        // Keys: ↓ lights frame, ↓ again rename, Enter opens its box, the name typed and Enter renames it.
        await page.keyboard.press('ArrowDown');   // paste (copy shows only with text selected)
        await page.keyboard.press('ArrowDown');   // frame (focus is left out: it's the focused one)
        await page.keyboard.press('ArrowDown');   // rename
        await page.keyboard.press('Enter');
        const box_ = await until(() => document.activeElement?.hasAttribute('data-menu-rename'), null, 3000);
        await page.keyboard.type('menu named');
        await page.keyboard.press('Enter');
        const renamed = await until((i) => window.__wall.nameOf(i) === 'menu named' && !window.__wall.menu, M2, 5000);
        const why = box_ && renamed ? '' : ` (${await W((i) => JSON.stringify({ menu: window.__wall.menu?.target ?? null, name: window.__wall.nameOf(i), focus: document.activeElement?.tagName, groups: window.__wall.groups.ids(), selection: [...window.__wall.selection] }), M2)})`;
        ok(!!box_ && !!renamed, `↓ ↓ ↓ and Enter open the rename box; typing a name and Enter renames ${M2} and closes the menu${why}`);

        // Empty canvas: a new terminal at the point.
        const g2 = await geo(M2);
        const pt = { x: g2.right + 60, y: g2.barTop };
        const want = await W(([x, y]) => { const w = window.__wall; return { ...w.viewport.toWorld(x, y), bar: w.names.barHeight(w.order[0], w.viewport.zoom), n: w.order.length }; }, [pt.x, pt.y]);
        await page.mouse.click(pt.x, pt.y, { button: 'right' });
        ok(!!(await menuOn('canvas')) && (await prevented()) === true, 'a right-click on empty canvas opens the canvas menu');
        await shot('menu-canvas');
        // The point the menu opened at is the event's (the browser hands integer px), within a pixel of the click.
        const menuAt = await W(() => ({ ...window.__wall.menu.world, zoom: window.__wall.viewport.zoom }));
        ok(Math.hypot(menuAt.x - want.x, menuAt.y - want.y) * menuAt.zoom < 1, `the canvas menu holds the world point it was opened at (${menuAt.x.toFixed(2)}, ${menuAt.y.toFixed(2)})`);
        await page.click('[data-wall-menu] [data-menu-item="spawn"]');
        const born = await until((n) => window.__wall.order.length > n && window.__wall.focusedId && !window.__wall.order.slice(0, n).includes(window.__wall.focusedId) && window.__wall.focusedId, want.n, 20000);
        if (born) spawned.push(born);
        const r = born ? await W((i) => window.__wall.terminalRect(i), born) : null;
        // Its window's top-left at that point; with snap on (the default), its body's top-left on the nearest crossing.
        const cfg = await W(() => ({ ...window.__wall.config }));
        const step = cfg.snap ? snapStep(cfg, menuAt.zoom) : 0;
        const wantX = Math.round(menuAt.x * 100) / 100, wantY = Math.round(menuAt.y * 100) / 100 - want.bar;
        const at = step ? { x: snapTo(wantX, step), y: snapTo(wantY, step) } : { x: wantX, y: wantY };
        ok(!!r && Math.abs(r.minX - at.x) < 1e-6 && Math.abs(r.maxY - at.y) < 1e-6,
            `"new terminal here" lands ${born} at the point${step ? `, its body's top-left snapped to the grid (step ${step})` : ''} (${r ? `${r.minX.toFixed(2)}, ${r.maxY.toFixed(2)}` : '—'} vs ${at.x.toFixed(2)}, ${at.y.toFixed(2)})`);
        // Somewhere the canvas itself is under the pointer and nothing on it is.
        const empty = await W(() => {
            const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect();
            for (let y = cr.top + 80; y < cr.bottom - 60; y += 40) for (let x = cr.left + 40; x < cr.right - 40; x += 40) {
                if (document.elementFromPoint(x, y) === v.canvas && !w.hit(v.toWorld(x, y))) return { x, y };
            }
            return null;
        });
        await page.mouse.click(empty.x, empty.y, { button: 'right' });
        await menuOn('canvas');
        await page.mouse.move(empty.x - 12, empty.y - 12);   // off the menu (it opens with its corner under the pointer)
        await page.mouse.wheel(0, 120);
        ok(!!(await menuOn(null)), 'a wheel (a pan) closes the menu');

        // A group's header: its menu, Esc, then layout and ungroup through it.
        const gid = (await W((ids) => window.__wall.run(['wall.group', ...ids]).then((x) => x.data.gid), [M2, born]));
        await W((g) => window.__wall.run(['wall.group.frame', g]), gid);
        await until(() => !window.__wall.viewport.moving, null, 8000);
        const header = async () => W((g) => { const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect(); const s = v.toScreenBox(w.groups.headerRect(g, v.zoom)); return { x: cr.left + (s.left + s.right) / 2, y: cr.top + (s.top + s.bottom) / 2 }; }, gid);
        let hd = await header();
        await page.mouse.click(hd.x, hd.y, { button: 'right' });
        ok(!!(await menuOn(`group:${gid}`)), `a right-click on ${gid}'s header opens the group menu (rows: ${(await rows()).join(' ')})`);
        await shot('menu-group');
        await page.click('[data-wall-menu] [data-menu-item="layout"] [data-menu-option="freeform"]');
        const free = await until((g) => window.__wall.groups.get(g).layout === 'freeform' && !window.__wall.menu, gid, 5000);
        hd = await header();
        await page.mouse.click(hd.x, hd.y, { button: 'right' });
        await menuOn(`group:${gid}`);
        await page.click('[data-wall-menu] [data-menu-item="ungroup"]');
        const gone = await until((g) => !window.__wall.store.group(g) && !window.__wall.menu, gid, 5000);
        ok(!!free && !!gone, `the group menu sets ${gid} freeform and ungroups it`);

        // A custom size, all from the keys: the menu key, ↓ to the size row, → to "custom…", Enter opens
        // cols × rows on its own size (keys in cols); Esc cancels; 0 is refused under the row; Tab
        // moves to rows; Enter resizes through terminal.resize and closes the menu.
        await W((i) => window.__wall.focus(i), M2);
        const toCustom = async () => {
            await page.keyboard.press('ContextMenu');
            await menuOn(`terminal:${M2}`);
            const nav = await W(() => {
                const m = document.querySelector('[data-wall-menu]');
                const rowIds = [...m.querySelectorAll('[data-menu-item]')].map((el) => el.dataset.menuItem);
                const opts = [...m.querySelectorAll('[data-menu-item="size"] [data-menu-option]')];
                return { down: rowIds.indexOf('size') + 1, right: opts.length - 1 - Math.max(0, opts.findIndex((o) => o.hasAttribute('data-on'))) };
            });
            for (let k = 0; k < nav.down; k++) await page.keyboard.press('ArrowDown');
            for (let k = 0; k < nav.right; k++) await page.keyboard.press('ArrowRight');
            await page.keyboard.press('Enter');
            return until(() => document.activeElement?.dataset.menuField === 'cols' && { cols: document.querySelector('[data-menu-field="cols"]').value, rows: document.querySelector('[data-menu-field="rows"]').value }, null, 4000);
        };
        const own = await W((i) => ({ cols: window.__wall.terminal(i).cols, rows: window.__wall.terminal(i).rows }), M2);
        const pre = await toCustom();
        ok(!!pre && pre.cols === String(own.cols) && pre.rows === String(own.rows),
            `"custom…" (reached by keys) opens cols × rows fields on ${M2}'s own size (${pre ? `${pre.cols}×${pre.rows}` : '—'}), the keys in cols`);
        await page.keyboard.press('Escape');
        const cancelled = await until(() => !document.querySelector('[data-menu-field]') && !!window.__wall.menu, null, 3000);
        await page.keyboard.press('Escape');
        await menuOn(null);
        ok(!!cancelled && (await W((i) => window.__wall.terminal(i).cols, M2)) === own.cols, 'Esc in the fields cancels the size (the menu stays, a second Esc closes it)');
        await toCustom();
        await page.keyboard.type('0'); await page.keyboard.press('Enter');
        const refused = await until(() => document.querySelector('[data-wall-menu] [data-menu-refused]')?.textContent, null, 3000);
        await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('97');
        await page.keyboard.press('Tab');
        const inRows = await until(() => document.activeElement?.dataset.menuField === 'rows', null, 3000);
        await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('31');
        await page.keyboard.press('Enter');
        const sized = await until((i) => { const g = window.__wall.terminal(i); return g.cols === 97 && g.rows === 31 && !window.__wall.menu; }, M2, 10000);
        ok(refused === 'cols: at least 1' && !!inRows && !!sized,
            `0 is refused under the row ("${refused}"); Tab moves to rows; 97 × 31 and Enter resize ${M2} through terminal.resize and close the menu`);

        for (const id of [M2, born]) if (id) await W((i) => window.__wall.run(['wall.close', i]), id);
        await until((ids) => ids.every((i) => !window.__wall.terminal(i)), [M2, born].filter(Boolean), 8000);
    }

    // ── lasso → group → tiling → header drag → freeform ───────────────────
    {
        const L = await park(3);
        const boxes = await Promise.all(L.map((id) => geo(id)));
        const m = 24;
        const l = Math.min(...boxes.map((b) => b.left)) - m, r = Math.max(...boxes.map((b) => b.right)) + m;
        const t = Math.min(...boxes.map((b) => b.barTop)) - m, b = Math.max(...boxes.map((x) => x.bottom)) + m;
        await page.keyboard.down('Shift');
        await page.mouse.move(l, t); await page.mouse.down();
        await page.mouse.move(r, t + 10, { steps: 12 }); await page.mouse.move(r - 10, b, { steps: 12 }); await page.mouse.move(l + 15, b - 5, { steps: 12 });
        const lassoUp = await W(() => window.__wall.selectionOverlay.lassoShown);
        await shot('lasso');
        await page.mouse.move(l, t + 20, { steps: 6 }); await page.mouse.up();
        await page.keyboard.up('Shift');
        await until(() => !window.__wall.pointer.lassoing, null, 4000);
        await frame();   // the selection's outlines and its button are placed in the frame's chrome pass
        let sel = await W(() => [...window.__wall.selection].sort());
        ok(lassoUp && JSON.stringify(sel) === JSON.stringify([...L].sort()), `a ⇧-drag lasso (drawn on screen: ${lassoUp}) selects exactly what it touches (${sel.join(', ')})`);
        const marks = await W(() => ({ outlines: document.querySelectorAll('[data-selected]').length, button: getComputedStyle(document.querySelector('[data-selection-bar]')).display !== 'none' }));
        ok(marks.outlines === 3 && marks.button, `the selection shows: ${marks.outlines} outlines and the group button`);
        await shot('selection');

        const mid = boxes[1];
        await page.keyboard.down('Shift'); await page.mouse.click((mid.left + mid.right) / 2, (mid.top + mid.bottom) / 2); await page.keyboard.up('Shift');
        const without = await until((i) => !window.__wall.selection.has(i) && [...window.__wall.selection], L[1], 4000) ?? await W(() => [...window.__wall.selection]);
        await page.keyboard.down('Shift'); await page.mouse.click((mid.left + mid.right) / 2, (mid.top + mid.bottom) / 2); await page.keyboard.up('Shift');
        sel = await until((i) => window.__wall.selection.has(i) && [...window.__wall.selection], L[1], 4000) ?? await W(() => [...window.__wall.selection]);
        ok(!without.includes(L[1]) && without.length === 2 && sel.includes(L[1]) && sel.length === 3, '⇧-click takes a terminal out of the selection and puts it back');

        const gb = await box('[data-selection-bar] [data-action="group"]');
        await page.mouse.click(gb.x, gb.y);
        await until((ids) => window.__wall.snapshot().groups.some((x) => ids.every((id) => x.members.includes(id))), L, 4000);
        const snap = await W(() => window.__wall.snapshot());
        const grp = snap.groups.find((x) => L.every((id) => x.members.includes(id)));
        ok(!!grp && grp.members.length === 3 && snap.selection.length === 0, `the group button gathers the selection into ${grp?.id} ("${grp?.name}", ${grp?.layout} ${grp?.columns})`);
        const gid = grp.id;

        const tiled = await W(([g, ids]) => {
            const w = window.__wall;
            return {
                group: w.groups.get(g),
                sizes: ids.map((id) => { const r = w.terminalRect(id); return { w: r.maxX - r.minX, h: r.maxY - r.minY }; }),
                at: ids.map((id) => { const r = w.terminalRect(id); return { x: r.minX, y: r.maxY }; }),
            };
        }, [gid, grp.members]);
        const want = tileLayout(tiled.sizes, { origin: tiled.group.origin, columns: tiled.group.columns, gap: tiled.group.gap, barRoom: BAR_ROOM }).places;
        const off = Math.max(...want.map((p, k) => Math.hypot(p.x - tiled.at[k].x, p.y - tiled.at[k].y)));
        ok(off < 1e-6, `the tiled members sit exactly where wallLayout.tileLayout puts them (max off ${off.toExponential(1)}, ${tiled.group.columns} columns, gap ${tiled.group.gap})`);
        await W((g) => window.__wall.run(['wall.group.frame', g]), gid); await still();
        await shot('group-tiled');

        const hd = await W((g) => { const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect(); const s = v.toScreenBox(w.groups.headerRect(g, v.zoom)); return { x: cr.left + (s.left + s.right) / 2, y: cr.top + (s.top + s.bottom) / 2, zoom: v.zoom }; }, gid);
        const before = await Promise.all(grp.members.map(pos));
        const o0 = await W((g) => window.__wall.groups.get(g).origin, gid);
        await page.mouse.move(hd.x, hd.y);
        ok((await W(() => window.__wall.viewport.canvas.style.cursor)) === 'move', 'the cursor over a group header is "move"');
        await drag(hd.x, hd.y, hd.x + 70, hd.y + 50);
        await until(() => !window.__wall.pointer.busy, null, 4000);
        const after = await Promise.all(grp.members.map(pos));
        const o1 = await W((g) => window.__wall.groups.get(g).origin, gid);
        const ds = after.map((p, k) => ({ x: p.x - before[k].x, y: p.y - before[k].y }));
        const same = ds.every((d) => Math.abs(d.x - ds[0].x) < 1e-6 && Math.abs(d.y - ds[0].y) < 1e-6);
        ok(same && ds[0].x > 0 && ds[0].y < 0 && Math.abs(o1.x - o0.x - ds[0].x) < 1e-6 && Math.abs(o1.y - o0.y - ds[0].y) < 1e-6,
            `dragging the header moves every member and the tiling together (Δ ${ds[0].x.toFixed(2)}, ${ds[0].y.toFixed(2)})`);
        const kept2 = await W((ids) => ids.map((id) => window.__wall.store.position(id)), grp.members);
        ok(kept2.every((p, k) => p.x === after[k].x && p.y === after[k].y), 'and every member remembers its new spot');

        const fl = await W((g) => window.__wall.run(['wall.group.layout', g, 'freeform']).then((r) => r.text), gid);
        await frame();
        const last = grp.members[2];
        const lg = await geo(last);
        const others0 = await Promise.all(grp.members.slice(0, 2).map(pos));
        const last0 = await pos(last);
        await drag((lg.left + lg.right) / 2, (lg.top + lg.barTop) / 2, (lg.left + lg.right) / 2 + 30, (lg.top + lg.barTop) / 2 + 60);
        await until(() => !window.__wall.pointer.busy, null, 4000);
        const others1 = await Promise.all(grp.members.slice(0, 2).map(pos));
        const last1 = await pos(last);
        ok(fl.startsWith('OK') && others1.every((p, k) => p.x === others0[k].x && p.y === others0[k].y) && last1.y < last0.y,
            `freeform (${fl}): a member's title-bar drag moves it alone, and the frame follows`);
        await shot('group-freeform');

        await W((i) => window.__wall.run(['wall.close', i]), last);
        await until((i) => !window.__wall.terminal(i), last, 8000);
        const pruned = await W((g) => window.__wall.groups.get(g).members, gid);
        ok(pruned.length === 2 && !pruned.includes(last), `a killed member leaves its group (${pruned.join(', ')})`);
        await W((g) => window.__wall.run(['wall.group.layout', g, 'tile']), gid);

        // ── the sidebar ────────────────────────────────────────────────────
        await W(() => window.__wall.focus(null));
        await page.keyboard.press(`${CHORD}+KeyB`);
        ok(!!(await until(() => !!document.querySelector('[data-sidebar]'), null, 4000)), `${CHORD}+B opens the sidebar`);
        await page.click('[data-sidebar] [data-action="left"]');
        await until(() => document.querySelector('[data-sidebar]')?.dataset.side === 'left', null, 4000);
        const lists = await W(([g, ids, loose]) => {
            const sb = document.querySelector('[data-sidebar]');
            const grow = sb.querySelector(`[data-row="group:${g}"]`);
            return {
                side: sb.dataset.side, left: sb.getBoundingClientRect().left,
                group: !!grow, members: ids.map((id) => !!sb.querySelector(`[data-group="${g}"] [data-row="term:${id}"]`)),
                loose: !!sb.querySelector(`[data-row="term:${loose}"]`) && !sb.querySelector(`[data-group] [data-row="term:${loose}"]`),
            };
        }, [gid, pruned, spawned[0]]);
        ok(lists.side === 'left' && lists.left === 0 && lists.group && lists.members.every(Boolean) && lists.loose,
            `the sidebar docks left and lists the group, its members under it, and the ungrouped terminals (${JSON.stringify(lists)})`);
        await page.click(`[data-sidebar] [data-row="group:${gid}"] [data-action="collapse"]`);
        await until((g) => document.querySelector(`[data-row="group:${g}"]`)?.hasAttribute('data-collapsed'), gid, 4000);
        const folded = await W(([g, ids]) => ({ collapsed: document.querySelector(`[data-row="group:${g}"]`).hasAttribute('data-collapsed'), rows: ids.filter((id) => document.querySelector(`[data-sidebar] [data-row="term:${id}"]`)).length }), [gid, pruned]);
        ok(folded.collapsed && folded.rows === 0, `a group folds in the sidebar (its ${pruned.length} member rows go)`);
        await reload();
        await until(([ids, g]) => window.__wall?.snapshot().connected && ids.every((i) => window.__wall.terminal(i)) && document.querySelector(`[data-sidebar] [data-row="group:${g}"]`), [pruned, gid], 20000);
        const kept3 = await W((g) => { const sb = document.querySelector('[data-sidebar]'); return { side: sb?.dataset.side, collapsed: !!sb?.querySelector(`[data-row="group:${g}"][data-collapsed]`) }; }, gid);
        ok(kept3.side === 'left' && kept3.collapsed, `after a reload the sidebar is still open, docked left, the group still folded (${JSON.stringify(kept3)})`);
        await page.click(`[data-sidebar] [data-row="group:${gid}"] [data-action="collapse"]`);
        const rowSel = `[data-sidebar] [data-row="term:${pruned[0]}"]`;
        await until((s) => !!document.querySelector(s), rowSel, 4000);
        await page.hover(rowSel); await page.click(`${rowSel} [data-action="hide"]`);
        await until(([s, i]) => window.__wall.store.hidden(i) && document.querySelector(s)?.hasAttribute('data-hidden'), [rowSel, pruned[0]], 4000);
        const rowHidden = await W(([s, i]) => ({ marked: document.querySelector(s).hasAttribute('data-hidden'), hidden: window.__wall.store.hidden(i) }), [rowSel, pruned[0]]);
        await page.hover(rowSel); await page.click(`${rowSel} [data-action="show"]`);
        await until((i) => !window.__wall.store.hidden(i), pruned[0], 4000);
        const ringed = await W((s) => !!document.querySelector(`${s} [data-action="close"] svg circle`), rowSel);
        ok(rowHidden.marked && rowHidden.hidden && !(await W((i) => window.__wall.store.hidden(i), pruned[0])) && ringed,
            `a sidebar row hides its terminal (and marks it), shows it back, and carries the hold-to-close ring (${JSON.stringify(rowHidden)}, ring ${ringed})`);
        await W(() => window.__wall.fitAll()); await still();
        await shot('sidebar-left');
        await page.keyboard.press(`${CHORD}+KeyB`);
        ok(!!(await until(() => !document.querySelector('[data-sidebar]'), null, 4000)), `${CHORD}+B closes it`);

        // ── the sidebar and the status window together ─────────────────────
        await W(() => window.__wall.focus(null));
        await page.keyboard.press(`${CHORD}+KeyB`);
        await page.keyboard.press(`${CHORD}+KeyS`);
        await W(() => window.__wall.run(['wall.sidebar', 'right']).then(() => window.__wall.run(['wall.status', 'right'])));
        await until(() => document.querySelector('[data-sidebar]')?.dataset.side === 'right' && document.querySelector('[data-status-window]')?.dataset.side === 'right', null, 4000);
        await frame();
        const rects = await W(() => {
            const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { l: b.left, r: b.right } : null; };
            return { sidebar: r('[data-sidebar]'), status: r('[data-status-window]'), topbar: r('[data-termd]')?.r, vw: document.documentElement.clientWidth };
        });
        const { sidebar: sbr, status: str } = rects;
        ok(!!sbr && !!str && Math.abs(sbr.r - rects.vw) < 1 && Math.abs(str.r - sbr.l) < 1 && rects.topbar <= str.l,
            `docked on one edge, the sidebar keeps the edge, the status window sits beside it, and the topbar clears both (${JSON.stringify(rects)})`);
        await shot('panels-docked-right');
        const knobs = await W(() => window.__wall.run(['wall.config']).then((x) => x.data));
        const set = await W(() => window.__wall.run(['wall.config', 'errorsShown', '1']).then((x) => x.text));
        const bad = await W(() => window.__wall.run(['wall.config', 'errorsShown', '1.5']).then((x) => x.text));
        ok('restartNoticeMs' in knobs && 'closeHoldMs' in knobs && set.startsWith('OK') && bad.startsWith('ERR') && (await W(() => window.__wall.config.errorsShown)) === 1,
            `the status window's knobs are wall.config's (${set}; a fraction refused: ${bad})`);
        await W(() => window.__wall.run(['wall.config', 'errorsShown', '3']));
        const target = pruned[0];
        await W((i) => window.__wall.run(['wall.hide', i]), target);
        await until((i) => window.__wall.store.hidden(i), target, 4000);
        await page.click(`[data-status-row="${target}"]`);
        await until((i) => !window.__wall.store.hidden(i) && window.__wall.focusedId === i, target, 4000);
        await still();
        const revealed = await W((i) => ({ hidden: window.__wall.store.hidden(i), shown: window.__wall.terminal(i).visible, focused: window.__wall.focusedId === i }), target);
        ok(!revealed.hidden && revealed.shown && revealed.focused, `a status row's click reveals its hidden terminal: shown and focused (${JSON.stringify(revealed)})`);
        await W(() => window.__wall.run(['wall.sidebar', 'close']).then(() => window.__wall.run(['wall.status', 'close'])));
    }

    // ── the drafting grid, snapping, the settings panel ────────────────────
    {
        const [S] = await park(1);
        const knob = (k) => W((key) => window.__wall.config[key], k);
        const run = (cmd) => W((c) => window.__wall.run(c).then((r) => r.text), cmd);
        const rectOf = (i) => W((id) => window.__wall.terminalRect(id), i);
        const onGrid = (v, step) => Math.abs(v - snapTo(v, step)) < 1e-6;
        // Off the grid to start with, framed so its bar is easy to grab.
        await W((i) => { const w = window.__wall, g = w.terminal(i); g.position.x += 1.3; g.position.y -= 0.7; w.rememberPosition(i); w.frame(i); }, S);
        await until(() => !window.__wall.viewport.moving, null, 8000);
        await page.mouse.move(2, 2);
        const cfg = await W(() => ({ ...window.__wall.config, zoom: window.__wall.viewport.zoom }));
        const step = snapStep(cfg, cfg.zoom);
        const stride = await W((i) => window.__wall.terminal(i).cellStride, S);
        info(`snap step ${step} world units at zoom ${cfg.zoom.toFixed(2)}; a cell is ${stride.x.toFixed(3)} × ${stride.y.toFixed(3)}`);
        const barAt = async () => { const b = await geo(S); return { x: (b.left + b.right) / 2 - 60, y: (b.top + b.barTop) / 2 }; };

        let a = await barAt();
        await drag(a.x, a.y, a.x + 37, a.y + 23);
        let r = await rectOf(S);
        ok(cfg.snap && onGrid(r.minX, step) && onGrid(r.maxY, step), `a title-bar drag lands the body's top-left on a grid crossing (${r.minX.toFixed(3)}, ${r.maxY.toFixed(3)}; step ${step})`);

        // The right border: the edge on its line or inside it by less than a cell; the left edge stays.
        let g = await geo(S);
        await drag(g.right, (g.top + g.bottom) / 2, g.right + 53, (g.top + g.bottom) / 2);
        await until(([i, c]) => window.__wall.terminal(i).cols !== c, [S, g.cols], 8000);
        const rr = await rectOf(S);
        const lineR = Math.ceil(rr.maxX / step - 1e-9) * step;
        ok(rr.minX === r.minX && lineR - rr.maxX < stride.x - 1e-9 && (await geo(S)).cols > g.cols,
            `a right-border drag lands the edge on or inside a grid line in whole cells (${g.cols} → ${(await geo(S)).cols} cols; ${(lineR - rr.maxX).toFixed(3)} inside the line at ${lineR}, a cell is ${stride.x.toFixed(3)})`);
        g = await geo(S);
        await drag((g.left + g.right) / 2 + 40, g.bottom, (g.left + g.right) / 2 + 40, g.bottom + 47);
        await until(([i, n]) => window.__wall.terminal(i).rows !== n, [S, g.rows], 8000);
        const rb = await rectOf(S);
        const lineB = Math.floor(rb.minY / step + 1e-9) * step;
        ok(rb.maxY === rr.maxY && rb.minY - lineB < stride.y - 1e-9 && (await geo(S)).rows > g.rows,
            `a bottom-border drag lands the edge on or inside a grid line (${g.rows} → ${(await geo(S)).rows} rows; ${(rb.minY - lineB).toFixed(3)} inside the line at ${lineB})`);

        // Ctrl held while dragging: free — the terminal moves by exactly the pointer's travel.
        const freeDrag = async (mods) => {
            const p0 = await pos(S), z = await W(() => window.__wall.viewport.zoom);
            a = await barAt();
            await page.mouse.move(a.x, a.y); await page.mouse.down();
            for (const m of mods) await page.keyboard.down(m);
            await page.mouse.move(a.x + 29, a.y + 17, { steps: 8 });
            await page.mouse.up();
            for (const m of mods) await page.keyboard.up(m);
            const p1 = await pos(S);
            return { dx: p1.x - p0.x - 29 / z, dy: p1.y - p0.y + 17 / z, r: await rectOf(S) };
        };
        let f = await freeDrag(['Control']);
        ok(Math.abs(f.dx) < 1e-6 && Math.abs(f.dy) < 1e-6 && !(onGrid(f.r.minX, step) && onGrid(f.r.maxY, step)),
            `a drag with Ctrl held doesn't snap: it moves by exactly the pointer's travel (off by ${f.dx.toExponential(1)}, ${f.dy.toExponential(1)})`);
        await page.keyboard.press(`${CHORD}+Quote`);
        const snapOff = await until(() => window.__wall.config.snap === false, null, 4000);
        f = await freeDrag([]);
        ok(!!snapOff && Math.abs(f.dx) < 1e-6 && Math.abs(f.dy) < 1e-6, `${CHORD}+' turns snapping off, and a drag then moves by exactly the pointer's travel`);
        const snapOn = await run(['wall.snap', 'on']);
        a = await barAt();
        await drag(a.x, a.y, a.x + 11, a.y - 31);
        r = await rectOf(S);
        ok(snapOn === 'OK: snap on' && onGrid(r.minX, step) && onGrid(r.maxY, step), `wall.snap on: the next drag snaps again (${snapOn})`);

        // The grid in the pixels: one row of the canvas, far from every terminal, against the rule.
        const BG = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
        const row = async (camX, camY, zoom) => {
            await W(([x, y, z]) => { const v = window.__wall.viewport; v.moveTo(x, y); v.camera.zoom = z; v.camera.updateProjectionMatrix(); }, [camX, camY, zoom]);
            await W(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
            const vp = page.viewportSize();
            const png = await page.screenshot({ clip: { x: 0, y: Math.floor(vp.height / 2), width: vp.width, height: 1 } });
            return W(async (b64) => {
                const img = new Image();
                img.src = `data:image/png;base64,${b64}`;
                await img.decode();
                const cv = new OffscreenCanvas(img.width, img.height), cx = cv.getContext('2d');
                cx.drawImage(img, 0, 0);
                const d = cx.getImageData(0, 0, img.width, 1).data, out = [];
                for (let i = 0; i < img.width; i++) out.push([d[4 * i], d[4 * i + 1], d[4 * i + 2]]);
                return { px: out, dpr: devicePixelRatio, w: innerWidth };
            }, png.toString('base64'));
        };
        /** Each pixel of the row: which line the shader's rule puts there (major / minor / none), checked against its colour. */
        const readGrid = async (zoom, c) => {
            const camX = -5000.37, camY = -5002;          // the row's world y sits between lines
            const { px, dpr, w } = await row(camX, camY, zoom);
            const zd = zoom * dpr, h = Math.max(1, Math.round(c.gridLinePx * dpr)) / 2 / zd;
            const M = c.gridMinor * c.gridMajorEvery;
            const on = (x, sp) => Math.floor((x - h) / sp) !== Math.floor((x + h) / sp);
            const lv = { minor: c.gridMinor * zoom >= c.gridMinPx && c.gridMajorEvery > 1, major: M * zoom >= c.gridMinPx };
            const tally = { major: 0, minor: 0, none: 0, wrong: [] };
            px.forEach((p, i) => {
                const x = camX + (i + 0.5 - (w * dpr) / 2) / zd;
                const kind = !c.gridShow ? 'none' : lv.major && on(x, M) ? 'major' : lv.minor && on(x, c.gridMinor) ? 'minor' : 'none';
                const want = BG(kind === 'major' ? c.gridMajorColor : kind === 'minor' ? c.gridMinorColor : c.background);
                tally[kind]++;
                if (Math.max(...want.map((v, k) => Math.abs(v - p[k]))) > 2 && tally.wrong.length < 4) tally.wrong.push({ i, kind, want, got: p });
            });
            return tally;
        };
        const base = await W(() => ({ ...window.__wall.config }));
        let t = await readGrid(4, base);
        ok(t.major > 0 && t.minor > 0 && !t.wrong.length, `at zoom 4 the grid's lines are in the pixels where the rule puts them, each colour ±2 (${t.major} major px, ${t.minor} minor, ${t.none} background; wrong: ${JSON.stringify(t.wrong)})`);
        t = await readGrid(1, base);
        ok(t.major > 0 && t.minor === 0 && !t.wrong.length, `at zoom 1 (minor lines ${base.gridMinor} px apart, under gridMinPx ${base.gridMinPx}) only the major lines draw (${t.major} major px; wrong: ${JSON.stringify(t.wrong)})`);
        const off = await run(['wall.grid', 'off']);
        t = await readGrid(4, { ...base, gridShow: false });
        ok(off === 'OK: grid hidden' && t.none === t.major + t.minor + t.none && !t.wrong.length, `wall.grid off: no line in the pixels, only the background (wrong: ${JSON.stringify(t.wrong)})`);
        const bg = await run(['wall.config', 'background', '#203040']);
        t = await readGrid(4, { ...base, gridShow: false, background: '#203040' });
        ok(bg.startsWith('OK') && !t.wrong.length, `the background knob reaches the canvas: #203040 reads as specified ±2 (${bg}; wrong: ${JSON.stringify(t.wrong)})`);
        await run(['wall.config', 'background', 'default']);
        await run(['wall.grid', 'on']);
        const sr = await rectOf(S);
        for (const z of [1, 4, 12]) {
            await W(([x, y, zz]) => { const v = window.__wall.viewport; v.moveTo(x, y); v.camera.zoom = zz; v.camera.updateProjectionMatrix(); }, [sr.minX + 30, sr.maxY - 20, z]);
            await W(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
            await shot(`grid-zoom-${z}`);
        }

        // The settings panel: its chord puts the keys in the search; a search shows exactly what matches.
        await W(() => window.__wall.focus(null));
        await page.keyboard.press(`${CHORD}+Comma`);
        const opened = await until(() => document.activeElement?.hasAttribute('data-settings-search'), null, 4000);
        ok(!!opened, `${CHORD}+, opens the settings panel with the keys in its search box`);
        await page.keyboard.type('major');
        const want = searchSettings('major').flatMap((x) => x.items.map((it) => it.key));
        const shown = await until((w) => {
            const got = [...document.querySelectorAll('[data-settings] [data-setting]')].map((el) => el.dataset.setting);
            return JSON.stringify(got) === JSON.stringify(w) ? { got, sections: [...document.querySelectorAll('[data-settings] [data-section]')].map((el) => el.dataset.section), marks: document.querySelectorAll('[data-settings] [data-hit]').length } : null;
        }, want, 4000);
        ok(!!shown && shown.sections.join() === 'canvas' && shown.marks >= want.length && want.length < Object.keys(KNOBS).length,
            `searching "major" shows exactly the matching knobs (${shown?.got.join(', ')}), in their one section, the word marked (${shown?.marks} marks)`);
        await shot('settings-search');
        /** Search, then ↓ to `key` (where the search lists it), checking the panel's choice follows. */
        const choose = async (q, key) => {
            await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(q);
            const order = searchSettings(q).flatMap((x) => x.items.map((it) => it.key));
            for (let k = 0; k < order.indexOf(key); k++) await page.keyboard.press('ArrowDown');
            return until((want) => document.querySelector('[data-settings] [data-setting][data-active]')?.dataset.setting === want, key, 4000);
        };
        const chose = await choose('snap to grid', 'snap');
        await page.keyboard.press('Enter');
        const flipped = await until(() => window.__wall.config.snap === false, null, 4000);
        const said = await run(['wall.config', 'snap']);
        ok(!!chose && !!flipped && said === 'OK: snap false', `↓ chooses "Snap to grid" and Enter flips it; wall.config says so (${said})`);
        await choose('grid spacing', 'gridMinor');
        await page.keyboard.press('Enter');
        const inField = await until(() => document.activeElement?.dataset.field === 'gridMinor', null, 4000);
        await page.keyboard.type('5'); await page.keyboard.press('Enter');
        const set5 = await until(() => window.__wall.config.gridMinor === 5, null, 4000);
        const said5 = await run(['wall.config', 'gridMinor']);
        const back = await W(() => document.activeElement?.hasAttribute('data-settings-search'));
        ok(!!inField && !!set5 && said5 === 'OK: gridMinor 5' && back, `Enter on "Grid spacing" puts the keys in its field; 5 + Enter sets it through wall.config (${said5}) and the keys come back to the search`);
        // The right-click menu's knobs are there too: a switch and a line of sizes, edited as one value.
        await choose('right-click', 'menuSizes');
        const listed = await W(() => !!document.querySelector('[data-settings] [data-setting="menuHint"] [data-control="bool"]') && !!document.querySelector('[data-settings] [data-setting="menuSizes"] [data-control="text"]'));
        await page.keyboard.press('Enter');
        const inSizes = await until(() => document.activeElement?.dataset.field === 'menuSizes', null, 4000);
        await page.keyboard.type('100x30   200x60'); await page.keyboard.press('Enter');
        const setSizes = await until(() => window.__wall.config.menuSizes === '100x30 200x60', null, 4000);
        const saidSizes = await run(['wall.config', 'menuSizes']);
        await page.keyboard.press('Enter');
        await until(() => document.activeElement?.dataset.field === 'menuSizes', null, 4000);
        await page.keyboard.type('big'); await page.keyboard.press('Enter');
        const refusal = await until(() => document.querySelector('[data-settings] [data-setting="menuSizes"] [data-refused]')?.textContent, null, 4000);
        ok(listed && !!inSizes && !!setSizes && saidSizes === 'OK: menuSizes 100x30 200x60' && /not 'big'/.test(refusal || '') && (await W(() => window.__wall.config.menuSizes)) === '100x30 200x60',
            `searching "right-click" lists the menu's knobs (a switch, a text line); a typed size list sets menuSizes through wall.config (${saidSizes}) and a bad one is refused under it ("${refusal}")`);
        await run(['wall.config', 'menuSizes', 'default']);
        await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
        const closed = await until(() => !document.querySelector('[data-settings]'), null, 4000);
        ok(!!closed, 'Escape clears the search, then closes the panel');
        await run(['wall.config', 'gridMinor', 'default']);
        await run(['wall.snap', 'on']);
    }

    if (app.errors.length) { failures++; console.log('FAIL  page errors:', app.errors.slice(0, 3)); }
    ok(!crashed && navigations === reloads, `the page loaded only where a step reloaded it (${reloads} reload(s), ${navigations} navigation(s)${crashed ? ', and it crashed' : ''})`);
} catch (e) {
    if (navigations !== reloads || crashed) console.log(`info  the page navigated ${navigations} time(s) for ${reloads} reload(s)${crashed ? ' and crashed' : ''} — a hot reload of a saved file, or a crash, under the run`);
    failures++;
    console.log(`FAIL  ${e.stack || e}`);
} finally {
    if (app) {
        for (const id of spawned) await app.evalPage((i) => window.__wall.kill(i), id).catch(() => {});
        // The relay's stop takes termd (and so every terminal) with it; this only lets the kills land first.
        await app.page.waitForFunction((ids) => ids.every((i) => !window.__wall?.terminal(i)), spawned, { timeout: 5000 }).catch(() => {});
    }
    await browser?.close().catch(() => {});
    await relay.stop();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
