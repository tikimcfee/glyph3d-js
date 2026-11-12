/**
 * wall-e2e.mjs — the wall, end to end, in a real-GPU browser against a PRIVATE relay.
 *
 *   bun tools/wall-e2e.mjs [--url http://localhost:5180/] [--relay 8099] [--reuse-relay]
 *
 * Needs the wall's Vite (`cd wall && bunx vite`) and a built ./glyph3d-cli. Starts its own relay on
 * --relay (tools/lib/wall-relay.mjs: `serve --relay-only` on the tmux socket `glyph-wall-e2e`, no
 * gomuxai), so it can neither adopt nor kill a person's terminals, and refuses a port something
 * already listens on — the relay takes one display, and a person's may be on it — unless
 * --reuse-relay names one you started (then it says so, and skips the relay-restart steps). Spawns
 * its own terminals and types only into those; on exit (SIGINT included) it kills the relay it
 * started and that socket's tmux server.
 * On macOS the browser launches headed (headless is a software renderer there) — a window opens.
 *
 * Covers: spawn, typing, the platform's chord (⌘ on macOS, Ctrl+Alt elsewhere) cycling (reversible),
 * border resize, title-bar drag vs body press, ⌥-drag on the body, top-edge resize, names (shell
 * title → name, palette rename, clear, a long name whole in its bar or handed to its map label, never
 * cut), a second display refused with the reason on its chip, a page reload (names, spots and shell
 * titles come back; a remembered terminal the relay no longer has is pruned), a kill forgetting its
 * name at once, a relay restart (the re-adopted terminal takes typing again with no reload; the next
 * spawn mints a fresh id), wheel over the focused terminal → scrollback while the camera holds, pinch
 * → zoom, a plain wheel elsewhere → an eased zoom that lands exactly and holds the point under the
 * pointer, map labels (no overlaps, bar names hidden, trace lines when crowded, click frames exactly
 * like frame(), drag moves the terminal), the shared scene systems serving frames, and the core
 * terminal verbs run against the wall (terminal.move, terminal.focus). Exit 1 on any FAIL.
 */
import { launchGpuBrowser, openApp } from './itest/driver.mjs';
import { privateRelay } from './lib/wall-relay.mjs';
import { dialRelay } from './lib/relay.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
const info = (msg) => console.log(`info  ${msg}`);

const relay = await privateRelay({ port: RELAY, socket: 'glyph-wall-e2e', reuse: process.argv.includes('--reuse-relay') });
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
    await page.keyboard.type('echo wall-e2e-typed');
    await page.keyboard.press('Enter');
    await settle(900);
    ok(await screenHas(A, 'wall-e2e-typed'), 'typing reaches the focused shell');

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
    await page.keyboard.type('e2e scratch'); await page.keyboard.press('Enter'); await settle(300);
    ok((await W((i) => window.__wall.nameOf(i), B)) === 'e2e scratch', 'the palette renames the focused terminal');
    await W(() => window.__wall.focus(null));
    await page.keyboard.press(`${CHORD}+KeyK`); await page.keyboard.type('scratch'); await page.keyboard.press('Enter'); await settle(300);
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
        ok(names[1] === '/tmp', `the shell's title comes back with its grid (${B}: "${names[1]}") — tmux only sends it on a change`);
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
    const z0 = await W((p) => { const v = window.__wall.viewport; return { zoom: v.zoom, at: v.toWorld(p.x, p.y), step: v.wheelZoom.stepFactor }; }, cr);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
    const mid = await W(() => window.__wall.viewport.moving);
    await settle(800);
    const z1 = await W((p) => { const v = window.__wall.viewport; return { zoom: v.zoom, at: v.toWorld(p.x, p.y), moving: v.moving }; }, cr);
    const zWant = z0.zoom * z0.step ** 3;
    ok(mid && !z1.moving && Math.abs(z1.zoom / zWant - 1) < 1e-6,
        `three wheel notches glide (moving mid-way) and land exactly at ${z0.step}^3 (zoom ${z0.zoom.toFixed(4)} → ${z1.zoom.toFixed(4)}, want ${zWant.toFixed(4)})`);
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
