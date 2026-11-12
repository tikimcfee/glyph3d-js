/**
 * wall-e2e.mjs — the wall, end to end, in a real-GPU browser against a PRIVATE relay.
 *
 *   bun tools/wall-e2e.mjs [--url http://localhost:5180/] [--relay 8099]
 *
 * Needs the wall's Vite (`cd wall && bunx vite`). Starts its own relay on --relay if nothing is
 * listening there (./glyph3d-cli serve --relay-only, killed at the end) — never the relay a person's
 * display is on: the relay takes one display. Its terminals live on their own tmux socket
 * (`glyph-wall-e2e`), so it can neither adopt nor kill a person's terminals, and it runs without
 * gomuxai. Spawns its own terminals and kills them after.
 * On macOS the browser launches headed (headless is a software renderer there) — a window opens.
 *
 * Covers: spawn, typing, ⌘[ ⌘] cycling (reversible), border resize, title-bar drag vs body press,
 * ⌥-drag on the body, top-edge resize, names (shell title → name, palette rename, clear), wheel
 * over the focused terminal → scrollback while the camera holds, pinch → zoom, map labels (no
 * overlaps, bar names hidden, trace lines when crowded, click frames exactly like frame(), drag
 * moves the terminal). Exit 1 on any FAIL.
 */
import { spawn as spawnProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, openApp } from './itest/driver.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('--url', 'http://localhost:5180/');
const RELAY = Number(arg('--relay', 8099));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
const info = (msg) => console.log(`info  ${msg}`);
const listening = (port) => new Promise((res) => {
    const s = net.connect(port, '127.0.0.1', () => { s.end(); res(true); });
    s.on('error', () => res(false));
});

let relay = null;
if (!(await listening(RELAY))) {
    relay = spawnProcess(path.join(ROOT, 'glyph3d-cli'), ['serve', '--port', String(RELAY), '--listen', '127.0.0.1', '--relay-only', '--tmux-socket', 'glyph-wall-e2e', '--no-gomuxai', ROOT], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !(await listening(RELAY)); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await listening(RELAY))) throw new Error(`could not start a relay on :${RELAY} (is ./glyph3d-cli built?)`);
    info(`started a private relay on :${RELAY}`);
}

const browser = await launchGpuBrowser({});
const spawned = [];
const app = await openApp(browser, { url: URL, relayPort: RELAY, wait: 3000, viewport: { width: 1400, height: 900 } });
const page = app.page;
const W = (fn, a) => app.evalPage(fn, a);
const settle = (ms = 1300) => page.waitForTimeout(ms);
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

try {
    ok(app.booted && await W(() => window.__wall.snapshot().connected), `boots and connects to the relay on :${RELAY}`);
    const preexisting = await W(() => window.__wall.order.length);
    ok(preexisting === 0, `the private relay adopted no live sessions (saw ${preexisting})`);

    // ── spawn + type ───────────────────────────────────────────────────────
    for (let i = 0; i < 3; i++) { const r = await W(() => window.__wall.spawn()); if (r.ok) spawned.push(r.id); }
    ok(spawned.length === 3, `spawned 3 terminals (${spawned.join(', ')})`);
    const [A, B, C] = spawned;
    await W((i) => window.__wall.focus(i), A);
    await page.keyboard.type('echo wall-e2e-typed');
    await page.keyboard.press('Enter');
    await settle(900);
    ok((await W((i) => window.__wall.terminal(i).readText().join('\n'), A)).includes('\nwall-e2e-typed') || (await W((i) => window.__wall.terminal(i).readText().filter((l) => l.trim() === 'wall-e2e-typed').length, A)) > 0, 'typing reaches the focused shell');

    // ── cycling ────────────────────────────────────────────────────────────
    await page.keyboard.press('Meta+BracketRight'); await settle(300);
    const after = await W(() => window.__wall.focusedId);
    await page.keyboard.press('Meta+BracketLeft'); await settle(300);
    ok(after !== A && (await W(() => window.__wall.focusedId)) === A, `⌘] moves focus (${A} → ${after}) and ⌘[ returns`);

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
    await page.keyboard.press('Meta+KeyK'); await page.keyboard.type('rename'); await page.keyboard.press('Enter');
    await page.keyboard.type('e2e scratch'); await page.keyboard.press('Enter'); await settle(300);
    ok((await W((i) => window.__wall.nameOf(i), B)) === 'e2e scratch', 'the palette renames the focused terminal');
    await W(() => window.__wall.focus(null));
    await page.keyboard.press('Meta+KeyK'); await page.keyboard.type('scratch'); await page.keyboard.press('Enter'); await settle(300);
    ok((await W(() => window.__wall.focusedId)) === B, 'the palette finds it by name');
    await W((i) => window.__wall.rename(i, ''), B);
    ok((await W((i) => window.__wall.nameOf(i), B)) === '/tmp', 'an empty name falls back to the shell title');

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

    // ── map labels ─────────────────────────────────────────────────────────
    for (let i = 0; i < 5; i++) { const r = await W(() => window.__wall.spawn()); if (r.ok) spawned.push(r.id); }
    await W((ids) => { const n = ['build', 'api server', 'tests (watch)', 'agent: root', 'agent: camera', 'logs', 'db shell', 'scratch']; ids.forEach((id, k) => window.__wall.rename(id, n[k])); }, spawned);
    await W(() => { window.__wall.focus(null); window.__wall.fitAll(); }); await settle();
    const zoomOut = async (f) => { await W((k) => { const v = window.__wall.viewport; v.target = null; v.camera.zoom *= k; v.camera.updateProjectionMatrix(); }, f); await settle(500); };
    await zoomOut(0.3);
    let ls = await labels();
    ok(ls.length === spawned.length && !anyOverlap(ls), `zoomed out: ${ls.length} map labels, none overlapping`);
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
    ok(!(await labels()).some((l) => l.id === lab.id), 'framed, its name is back in the bar');

    if (app.errors.length) { failures++; console.log('FAIL  page errors:', app.errors.slice(0, 3)); }
} finally {
    for (const id of spawned) await W((i) => window.__wall.kill(i), id).catch(() => {});
    await page.waitForTimeout(1000);
    await browser.close();
    relay?.kill();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
