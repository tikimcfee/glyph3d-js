/**
 * wall-e2e.mjs — the wall, end to end, in a real-GPU browser against a PRIVATE relay.
 *
 *   bun tools/wall-e2e.mjs [--url http://localhost:5180/] [--relay 8099] [--reuse-relay] [--shots DIR]
 *
 * --shots DIR saves screenshots of the status window (as it reads normally, restarting and
 * unreachable), the bar buttons, a close being held, a lasso in progress, the selection, a tiled
 * group, a freeform group, the sidebar docked left, and the sidebar and status window docked on one
 * edge (for a person to judge the look; the checks never read them).
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
 * Covers: spawn, typing, Shift+Enter into a Kitty-keyboard program (CSI 13;2u: termd encodes the
 * browser's key events in the program's modes) and a paste bracketed as it asked, the platform's chord (⌘ on macOS, Ctrl+Alt elsewhere) cycling (reversible),
 * border resize, title-bar drag vs body press, ⌥-drag on the body, top-edge resize, names (shell
 * title → name, palette rename, clear, a long name whole in its bar or handed to its map label, never
 * cut), a second display refused with the reason on its chip, a page reload (names, spots and shell
 * titles come back; a remembered terminal the relay no longer has is pruned), a kill forgetting its
 * name at once, a relay restart (the re-adopted terminal takes typing again with no reload; the next
 * spawn mints a fresh id), wheel over the focused terminal → scrollback while the camera holds, pinch
 * → zoom, a plain wheel elsewhere → an eased zoom that lands exactly and holds the point under the
 * pointer, map labels (no overlaps, bar names hidden, trace lines when crowded, click frames exactly
 * like frame(), drag moves the terminal), the shared scene systems serving frames, the core
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
 * knobs are wall.config's). Exit 1 on any FAIL.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay } from './lib/wall-relay.mjs';
import { dialRelay } from './lib/relay.mjs';
import { brainPid, termdPid } from './lib/termd.mjs';
import { tileLayout, BAR_ROOM } from '../wall/wallLayout.js';

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
try {
    browser = await launchGpuBrowser({});
    app = await openApp(browser, { url: URL_, relayPort: RELAY, wait: 3000, viewport: { width: 1400, height: 900 } });
    const page = app.page;
    const W = (fn, a) => app.evalPage(fn, a);
    const settle = (ms = 1300) => page.waitForTimeout(ms);
    /** Poll a page predicate until it holds (or `ms` runs out); returns its last value. */
    const until = async (fn, a, ms = 15000) => {
        const t = Date.now();
        let v;
        while (!(v = await W(fn, a).catch(() => null)) && Date.now() - t < ms) await page.waitForTimeout(200);
        return v;
    };
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
    const shot = async (name) => { if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); info(`screenshot ${path.join(SHOTS, `${name}.png`)}`); } };

    ok(app.booted && await W(() => window.__wall.snapshot().connected), `boots and registers as the relay's display on :${RELAY}`);
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
    await settle(900);
    const lastLines = async (i) => JSON.stringify((await W((id) => window.__wall.terminal(id).readText().filter((l) => l.trim()), i)).slice(-4));
    const typedOk = await screenHas(A, 'wall-e2e-42');
    ok(typedOk, `typing reaches the focused shell and Enter runs it${typedOk ? '' : ` (screen: ${await lastLines(A)})`}`);
    // A shell that asked for no keyboard mode reads Shift+Enter as Enter (\r), as xterm sends it.
    await page.keyboard.type('echo shift-$((1+1))');
    await page.keyboard.press('Shift+Enter');
    const shiftOk = !!await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'shift-2'), A, 8000);
    ok(shiftOk, `Shift+Enter runs the line in a plain shell${shiftOk ? '' : ` (screen: ${await lastLines(A)})`}`);

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
        await settle(600);
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
            await W((i) => window.__wall.focus(i), A);
            await page.keyboard.type('echo after-brain-restart');
            await page.keyboard.press('Enter');
            const typed = await until((i) => window.__wall.terminal(i).readText().some((l) => l.trim() === 'after-brain-restart'), A, 8000);
            ok(!!typed, 'the shell rode the brain restart: typing reaches it');
            await W(() => window.__wall.focus(null));
        } else info('reused relay: skipped the brain restart (its termd is not this tool\'s to stop)');

        const docked = await W(() => window.__wall.run(['wall.status', 'right']).then((x) => x.text));
        ok(docked.startsWith('OK') && (await W(() => document.querySelector('[data-status-window]')?.dataset.side)) === 'right', `wall.status right docks it (${docked})`);
        const closed = await W(() => window.__wall.run(['wall.status', 'close']).then((x) => x.text));
        await settle(200);
        ok(closed.startsWith('OK') && !(await W(() => document.querySelector('[data-status-window]'))), `wall.status close closes it (${closed})`);
        await W(() => window.__wall.run(['wall.status', 'float']).then(() => window.__wall.run(['wall.status', 'close'])));
        await W((i) => window.__wall.focus(i), A);   // as the steps below expect
    }

    // ── a second display is refused, and says why ──────────────────────────
    {
        const second = await browser.newPage({ viewport: { width: 900, height: 600 } });
        const u = new URL(URL_); u.searchParams.set('relay', String(RELAY));
        await second.goto(u.toString(), { waitUntil: 'load', timeout: 30000 });
        const chip = await second.waitForFunction(() => {
            const el = document.querySelector('[data-relay]');
            return el?.dataset.relay === 'refused' ? el.textContent : null;
        }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
        ok(!!chip && chip.includes('another display holds this relay'), `a second display is refused and its chip says why ("${chip}")`);
        await second.close();
        ok(await W(() => window.__wall.snapshot().connected), 'the first display keeps the relay');
    }

    // ── cycling, on the platform's chord ───────────────────────────────────
    await page.keyboard.press(`${CHORD}+BracketRight`); await settle(300);
    const after = await W(() => window.__wall.focusedId);
    await page.keyboard.press(`${CHORD}+BracketLeft`); await settle(300);
    ok(after !== A && (await W(() => window.__wall.focusedId)) === A, `${CHORD}+] moves focus (${A} → ${after}) and ${CHORD}+[ returns`);

    // ── overview, then pointer roles ───────────────────────────────────────
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await settle();
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
    await settle(1200);
    g2 = await geo(C);
    ok(g2.cols > g.cols, `right-border drag adds columns (${g.cols} → ${g2.cols})`);

    g = await geo(C);
    await drag((g.left + g.right) / 2, g.barTop, (g.left + g.right) / 2, g.barTop - 50);
    await settle(1200);
    g2 = await geo(C);
    ok(g2.rows > g.rows, `top-edge (bar top) drag adds rows (${g.rows} → ${g2.rows})`);

    // ── names ──────────────────────────────────────────────────────────────
    await W((i) => window.__wall.terminal(i).sendInput('cd /tmp\r'), B); await settle(1200);
    const titled = await W((i) => window.__wall.nameOf(i), B);
    ok(titled === '/tmp', `a terminal is named by its shell title ("${titled}")`);
    await W((i) => window.__wall.focus(i), B);
    // Typed up to the action label's quote: a shell prompt (a path with "worktrees" in it) can
    // fuzzy-match a bare 'rename' and rank a terminal above the action.
    await page.keyboard.press(`${CHORD}+KeyK`); await page.keyboard.type('rename "'); await page.keyboard.press('Enter');
    // A name no path holds: the other terminals' titles are their cwd, and a checkout under a
    // directory named like the search ("…-scratch/…") would match it too.
    await page.keyboard.type('e2e quokka'); await page.keyboard.press('Enter'); await settle(300);
    ok((await W((i) => window.__wall.nameOf(i), B)) === 'e2e quokka', 'the palette renames the focused terminal');
    await W(() => window.__wall.focus(null));
    await page.keyboard.press(`${CHORD}+KeyK`); await page.keyboard.type('quokka'); await page.keyboard.press('Enter'); await settle(300);
    ok((await W(() => window.__wall.focusedId)) === B, 'the palette finds it by name');
    await W((i) => window.__wall.rename(i, ''), B);
    ok((await W((i) => window.__wall.nameOf(i), B)) === '/tmp', 'an empty name falls back to the shell title');

    // A name too long for its bar: whole, shrunk to fit — or, past the bar's text floor, on its map label.
    const LONG = 'a terminal name long enough that no title bar at the overview could hold it at a readable size';
    await W(([i, n]) => window.__wall.rename(i, n), [C, LONG]);
    await W((i) => window.__wall.focus(i, { frame: true }), C); await settle();
    let bn = await barName(C);
    ok(bn.text === LONG && bn.visible && bn.fits, `framed, the long name sits whole in its bar (fits=${bn.fits}, ${bn.text.length} chars)`);
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await settle();
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
    await settle(500);
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
        await page.reload({ waitUntil: 'load' });
        const back = await until((ids) => window.__wall?.snapshot().connected && ids.every((i) => window.__wall.terminal(i)), spawned, 20000);
        ok(!!back, `after a reload the wall re-adopts all ${spawned.length} terminals`);
        await settle(800);
        const names = await W((ids) => ids.map((i) => window.__wall.nameOf(i)), spawned);
        const now = await W((ids) => ids.map((i) => { const p = window.__wall.terminal(i).position; return { x: p.x, y: p.y }; }), spawned);
        ok(names[1] === '/tmp', `the shell's title comes back with its grid (${B}: "${names[1]}") — termd puts it in every repaint`);
        ok(names[2] === 'keep me', `a given name survives the reload (${C}: "${names[2]}")`);
        ok(now.every((p, k) => p.x === before[k].x && p.y === before[k].y), 'every terminal is back at its spot');
        ok((await W(() => window.__wall.store.name('term-9999'))) === null, 'a remembered terminal the relay no longer has is forgotten on connect');
    }

    // ── a relay restart: the re-adopted terminal takes typing again, no reload ──
    if (relay.started) {
        await W((i) => window.__wall.focus(i), A);
        // Controller ids restart with the relay (the new adapter may well be ctrl-0 again), so the
        // re-adoption shows as the grid's input route being rebuilt, not as a new owner string.
        const owner0 = await W((i) => { window.__inputBefore = window.__wall.terminal(i).onInput; return window.__glyphClient.ctx.registry.get(i).meta.owner; }, A);
        await relay.restart();
        // Take the new relay's first controller id before the adapters reconnect, so the old owner's
        // id now names a controller that isn't the terminal's adapter: input still addressed to the
        // old owner lands nowhere, as it does when a restarted relay hands the ids out in a new order.
        const squatter = await dialRelay(RELAY);
        info(`restarted the private relay on :${RELAY}; a bystander controller holds ${squatter.hello.replace('OK: connected as ', '')}`);
        const readopted = await until((i) => window.__wall.snapshot().connected && typeof window.__wall.terminal(i)?.onInput === 'function' && window.__wall.terminal(i).onInput !== window.__inputBefore, A, 25000);
        const owner1 = await W((i) => window.__glyphClient.ctx.registry.get(i)?.meta.owner, A);
        ok(!!readopted, `the wall reconnects and ${A} is re-adopted by a new adapter — its input route rebuilt (owner ${owner0} → ${owner1})`);
        await W((i) => window.__wall.focus(i), A);
        await page.keyboard.type('echo after-restart-typed');
        await page.keyboard.press('Enter');
        await settle(1200);
        ok(await screenHas(A, 'after-restart-typed'), 'typing reaches the re-adopted shell without a reload');
        squatter.close();
        const r = await W(() => window.__wall.spawn());
        if (r.ok) spawned.push(r.id);
        ok(r.ok && !spawned.slice(0, -1).includes(r.id), `a spawn after the restart mints a fresh id (${r.id}), never a live session's`);
    } else info('reused relay: skipped the relay-restart steps');

    // ── wheel + pinch over the focused terminal ────────────────────────────
    await W((i) => window.__wall.terminal(i).sendInput('clear; seq 1 300\r'), A);
    await W((i) => window.__wall.focus(i, { frame: true }), A); await settle();
    g = await geo(A);
    const top0 = await W((i) => window.__wall.terminal(i).readText().find((l) => l.trim()), A);
    const c0 = await cam();
    await page.mouse.move((g.left + g.right) / 2, (g.top + g.bottom) / 2);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(50); }
    await settle(800);
    const top1 = await W((i) => window.__wall.terminal(i).readText().find((l) => l.trim()), A);
    const c1 = await cam();
    ok(top1 !== top0 && c1.zoom === c0.zoom && c1.x === c0.x, `wheel over the focused terminal scrolls its history ("${top0?.trim().slice(0, 12)}" → "${top1?.trim().slice(0, 12)}"), camera still`);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(50); }
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -40); await page.keyboard.up('Control'); await settle(300);
    ok((await cam()).zoom !== c1.zoom, 'pinch over the focused terminal zooms the canvas');

    // ── wheel zoom: plain wheel glides about the pointer, lands exactly, holds the point under it ──
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await settle();
    const cr = await W(() => { const r = window.__wall.viewport.canvas.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.4 }; });
    await page.mouse.move(cr.x, cr.y);
    // The deltas the page receives, which are what the wall zooms by: a synthetic wheel of 100 px
    // reaches a headed macOS Chrome as 200 (measured), so the notches are counted from them.
    const z0 = await W((p) => {
        const v = window.__wall.viewport;
        window.__wheelSeen = [];
        window.addEventListener('wheel', (e) => window.__wheelSeen.push([e.deltaY, e.deltaMode]), { capture: true });
        return { zoom: v.zoom, at: v.toWorld(p.x, p.y), step: v.wheelZoom.stepFactor, perNotch: v.wheelZoom.pixelsPerNotch };
    }, cr);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
    const mid = await W(() => window.__wall.viewport.moving);
    await settle(800);
    const z1 = await W((p) => { const v = window.__wall.viewport; return { zoom: v.zoom, at: v.toWorld(p.x, p.y), moving: v.moving }; }, cr);
    const seen = await W(() => window.__wheelSeen);
    const notches = -seen.reduce((n, [dy, mode]) => n + (mode === 0 ? dy : NaN), 0) / z0.perNotch;
    const zWant = z0.zoom * z0.step ** notches;
    ok(seen.length === 3 && notches > 0 && mid && !z1.moving && Math.abs(z1.zoom / zWant - 1) < 1e-6,
        `three wheel notches glide (moving mid-way) and land exactly at ${z0.step}^${notches} for the deltas the page got (${seen.map(([dy]) => dy).join(' ')} px; zoom ${z0.zoom.toFixed(4)} → ${z1.zoom.toFixed(4)}, want ${zWant.toFixed(4)})`);
    ok(Math.hypot(z1.at.x - z0.at.x, z1.at.y - z0.at.y) * z1.zoom < 0.5, 'the world point under the pointer stays under it through the glide');

    // ── map labels ─────────────────────────────────────────────────────────
    for (let i = 0; i < 5; i++) { const r = await W(() => window.__wall.spawn()); if (r.ok) spawned.push(r.id); }
    await W((ids) => { const n = ['build', 'api server', 'tests (watch)', 'agent: root', 'agent: camera', 'logs', 'db shell', 'scratch', 'extra']; ids.forEach((id, k) => window.__wall.rename(id, n[k])); }, spawned);
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await settle();
    const zoomOut = async (f) => { await W((k) => { const v = window.__wall.viewport; v.target = null; v.camera.zoom *= k; v.camera.updateProjectionMatrix(); }, f); await settle(500); };
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
    await settle(1500);
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
    const hoverBar = async (id) => { const b = await geo(id); await page.mouse.move((b.left + b.right) / 2 - 40, (b.top + b.barTop) / 2); await settle(250); };
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
        await settle();
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
        await page.mouse.click(hb.x, hb.y); await settle(400);
        const hid = await W((i) => { const w = window.__wall; return { hidden: w.store.hidden(i), visible: w.terminal(i).visible, shown: w.shownOrder().includes(i) }; }, H);
        ok(hid.hidden && !hid.visible && !hid.shown, `a click on hide takes ${H} off the canvas (${JSON.stringify(hid)})`);

        await page.reload({ waitUntil: 'load' });
        const back = await until((ids) => window.__wall?.snapshot().connected && ids.every((i) => window.__wall.terminal(i)), spawned, 20000);
        await settle(800);
        const still = await W((i) => ({ hidden: window.__wall.store.hidden(i), visible: window.__wall.terminal(i).visible }), H);
        ok(!!back && still.hidden && !still.visible, `after a reload ${H} is re-adopted (it kept running) and still hidden`);

        await page.keyboard.press(`${CHORD}+KeyK`); await settle(200);
        await page.keyboard.type(await W((i) => window.__wall.nameOf(i), H));
        const row = await W((i) => { const el = document.querySelector(`[data-item="terminal:${i}"]`); return el ? { hidden: el.hasAttribute('data-hidden'), text: el.textContent } : null; }, H);
        ok(!!row?.hidden, `the palette finds the hidden terminal, marked hidden ("${row?.text}")`);
        await page.click(`[data-item="terminal:${H}"]`); await settle(1500);
        const shownBack = await W((i) => ({ hidden: window.__wall.store.hidden(i), visible: window.__wall.terminal(i).visible, focus: window.__wall.focusedId }), H);
        const spot2 = await pos(H);
        ok(!shownBack.hidden && shownBack.visible && shownBack.focus === H && spot2.x === spot.x && spot2.y === spot.y,
            `choosing it shows it back at its own spot, focused (${JSON.stringify(shownBack)})`);

        await page.keyboard.press(`${CHORD}+Minus`); await settle(300);
        const chordHid = await W((i) => window.__wall.store.hidden(i), H);
        const sv = await W((i) => window.__wall.run(['wall.show', i]).then((r) => r.text), H);
        ok(chordHid && sv.startsWith('OK') && !(await W((i) => window.__wall.store.hidden(i), H)), `${CHORD}+- hides the focused terminal; wall.show brings it back (${sv})`);
    }
    {
        const [K] = await park(1);
        await hoverBar(K);
        const cb = await box('[data-bar-buttons] [data-action="close"]');
        await page.mouse.move(cb.x, cb.y); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up();
        await settle(HOLD + 600);
        ok(!!(await W((i) => window.__wall.terminal(i), K)), `a short press on close (150 ms of ${HOLD}) keeps ${K}`);
        await page.mouse.move(cb.x, cb.y); await page.mouse.down(); await page.waitForTimeout(HOLD / 2);
        const filling = await W(() => document.querySelector('[data-bar-buttons] [data-action="close"]').dataset.holding === '1');
        await shot('close-hold');
        await page.waitForTimeout(HOLD / 2 + 300); await page.mouse.up();
        const gone = await until((i) => !window.__wall.terminal(i), K, 8000);
        ok(filling && !!gone && (await W((i) => window.__wall.store.position(i), K)) === null, `a press held ${HOLD} ms fills the ring and kills ${K}, forgotten`);

        const K2 = (await W(() => window.__wall.spawn())).id;
        spawned.push(K2);
        await W((i) => window.__wall.focus(i), K2); await settle(300);
        const holdChord = async (ms) => {
            for (const k of CHORD.split('+')) await page.keyboard.down(k);
            await page.keyboard.down('KeyX'); await page.waitForTimeout(ms); await page.keyboard.up('KeyX');
            for (const k of CHORD.split('+').reverse()) await page.keyboard.up(k);
        };
        await holdChord(150); await settle(HOLD + 400);
        const kept = !!(await W((i) => window.__wall.terminal(i), K2));
        await holdChord(HOLD + 300);
        const gone2 = await until((i) => !window.__wall.terminal(i), K2, 8000);
        ok(kept && !!gone2, `${CHORD}+X held closes the focused terminal; let go early, it stays`);
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
        await settle(300);
        let sel = await W(() => [...window.__wall.selection].sort());
        ok(lassoUp && JSON.stringify(sel) === JSON.stringify([...L].sort()), `a ⇧-drag lasso (drawn on screen: ${lassoUp}) selects exactly what it touches (${sel.join(', ')})`);
        const marks = await W(() => ({ outlines: document.querySelectorAll('[data-selected]').length, button: getComputedStyle(document.querySelector('[data-selection-bar]')).display !== 'none' }));
        ok(marks.outlines === 3 && marks.button, `the selection shows: ${marks.outlines} outlines and the group button`);
        await shot('selection');

        const mid = boxes[1];
        await page.keyboard.down('Shift'); await page.mouse.click((mid.left + mid.right) / 2, (mid.top + mid.bottom) / 2); await page.keyboard.up('Shift');
        await settle(200);
        const without = await W(() => [...window.__wall.selection]);
        await page.keyboard.down('Shift'); await page.mouse.click((mid.left + mid.right) / 2, (mid.top + mid.bottom) / 2); await page.keyboard.up('Shift');
        await settle(200);
        sel = await W(() => [...window.__wall.selection]);
        ok(!without.includes(L[1]) && without.length === 2 && sel.includes(L[1]) && sel.length === 3, '⇧-click takes a terminal out of the selection and puts it back');

        const gb = await box('[data-selection-bar] [data-action="group"]');
        await page.mouse.click(gb.x, gb.y); await settle(600);
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
        await W((g) => window.__wall.run(['wall.group.frame', g]), gid); await settle();
        await shot('group-tiled');

        const hd = await W((g) => { const w = window.__wall, v = w.viewport, cr = v.canvas.getBoundingClientRect(); const s = v.toScreenBox(w.groups.headerRect(g, v.zoom)); return { x: cr.left + (s.left + s.right) / 2, y: cr.top + (s.top + s.bottom) / 2, zoom: v.zoom }; }, gid);
        const before = await Promise.all(grp.members.map(pos));
        const o0 = await W((g) => window.__wall.groups.get(g).origin, gid);
        await page.mouse.move(hd.x, hd.y);
        ok((await W(() => window.__wall.viewport.canvas.style.cursor)) === 'move', 'the cursor over a group header is "move"');
        await drag(hd.x, hd.y, hd.x + 70, hd.y + 50);
        await settle(300);
        const after = await Promise.all(grp.members.map(pos));
        const o1 = await W((g) => window.__wall.groups.get(g).origin, gid);
        const ds = after.map((p, k) => ({ x: p.x - before[k].x, y: p.y - before[k].y }));
        const same = ds.every((d) => Math.abs(d.x - ds[0].x) < 1e-6 && Math.abs(d.y - ds[0].y) < 1e-6);
        ok(same && ds[0].x > 0 && ds[0].y < 0 && Math.abs(o1.x - o0.x - ds[0].x) < 1e-6 && Math.abs(o1.y - o0.y - ds[0].y) < 1e-6,
            `dragging the header moves every member and the tiling together (Δ ${ds[0].x.toFixed(2)}, ${ds[0].y.toFixed(2)})`);
        const kept2 = await W((ids) => ids.map((id) => window.__wall.store.position(id)), grp.members);
        ok(kept2.every((p, k) => p.x === after[k].x && p.y === after[k].y), 'and every member remembers its new spot');

        const fl = await W((g) => window.__wall.run(['wall.group.layout', g, 'freeform']).then((r) => r.text), gid);
        await settle(300);
        const last = grp.members[2];
        const lg = await geo(last);
        const others0 = await Promise.all(grp.members.slice(0, 2).map(pos));
        const last0 = await pos(last);
        await drag((lg.left + lg.right) / 2, (lg.top + lg.barTop) / 2, (lg.left + lg.right) / 2 + 30, (lg.top + lg.barTop) / 2 + 60);
        await settle(300);
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
        await page.keyboard.press(`${CHORD}+KeyB`); await settle(300);
        ok(!!(await W(() => document.querySelector('[data-sidebar]'))), `${CHORD}+B opens the sidebar`);
        await page.click('[data-sidebar] [data-action="left"]'); await settle(300);
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
        await page.click(`[data-sidebar] [data-row="group:${gid}"] [data-action="collapse"]`); await settle(300);
        const folded = await W(([g, ids]) => ({ collapsed: document.querySelector(`[data-row="group:${g}"]`).hasAttribute('data-collapsed'), rows: ids.filter((id) => document.querySelector(`[data-sidebar] [data-row="term:${id}"]`)).length }), [gid, pruned]);
        ok(folded.collapsed && folded.rows === 0, `a group folds in the sidebar (its ${pruned.length} member rows go)`);
        await page.reload({ waitUntil: 'load' });
        await until((ids) => window.__wall?.snapshot().connected && ids.every((i) => window.__wall.terminal(i)) && document.querySelector('[data-sidebar]'), pruned, 20000);
        await settle(800);
        const kept3 = await W((g) => { const sb = document.querySelector('[data-sidebar]'); return { side: sb?.dataset.side, collapsed: !!sb?.querySelector(`[data-row="group:${g}"][data-collapsed]`) }; }, gid);
        ok(kept3.side === 'left' && kept3.collapsed, `after a reload the sidebar is still open, docked left, the group still folded (${JSON.stringify(kept3)})`);
        await page.click(`[data-sidebar] [data-row="group:${gid}"] [data-action="collapse"]`); await settle(300);
        const rowSel = `[data-sidebar] [data-row="term:${pruned[0]}"]`;
        await page.hover(rowSel); await page.click(`${rowSel} [data-action="hide"]`); await settle(300);
        const rowHidden = await W(([s, i]) => ({ marked: document.querySelector(s).hasAttribute('data-hidden'), hidden: window.__wall.store.hidden(i) }), [rowSel, pruned[0]]);
        await page.hover(rowSel); await page.click(`${rowSel} [data-action="show"]`); await settle(300);
        const ringed = await W((s) => !!document.querySelector(`${s} [data-action="close"] svg circle`), rowSel);
        ok(rowHidden.marked && rowHidden.hidden && !(await W((i) => window.__wall.store.hidden(i), pruned[0])) && ringed,
            `a sidebar row hides its terminal (and marks it), shows it back, and carries the hold-to-close ring (${JSON.stringify(rowHidden)}, ring ${ringed})`);
        await W(() => window.__wall.fitAll()); await settle();
        await shot('sidebar-left');
        await page.keyboard.press(`${CHORD}+KeyB`); await settle(300);
        ok(!(await W(() => document.querySelector('[data-sidebar]'))), `${CHORD}+B closes it`);

        // ── the sidebar and the status window together ─────────────────────
        await W(() => window.__wall.focus(null));
        await page.keyboard.press(`${CHORD}+KeyB`);
        await page.keyboard.press(`${CHORD}+KeyS`);
        await W(() => window.__wall.run(['wall.sidebar', 'right']).then(() => window.__wall.run(['wall.status', 'right'])));
        await settle(400);
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
        await settle(300);
        await page.click(`[data-status-row="${target}"]`);
        await settle(1500);
        const revealed = await W((i) => ({ hidden: window.__wall.store.hidden(i), shown: window.__wall.terminal(i).visible, focused: window.__wall.focusedId === i }), target);
        ok(!revealed.hidden && revealed.shown && revealed.focused, `a status row's click reveals its hidden terminal: shown and focused (${JSON.stringify(revealed)})`);
        await W(() => window.__wall.run(['wall.sidebar', 'close']).then(() => window.__wall.run(['wall.status', 'close'])));
    }

    if (app.errors.length) { failures++; console.log('FAIL  page errors:', app.errors.slice(0, 3)); }
} catch (e) {
    failures++;
    console.log(`FAIL  ${e.stack || e}`);
} finally {
    if (app) {
        for (const id of spawned) await app.evalPage((i) => window.__wall.kill(i), id).catch(() => {});
        await app.page.waitForTimeout(1000).catch(() => {});
    }
    await browser?.close().catch(() => {});
    await relay.stop();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
