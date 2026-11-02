// plane-pan-reach.test.mjs — inside a plane desk, drag-pan reaches the WHOLE board, every direction,
// with the strip's band shown or collapsed.
//
//   bun tools/plane-pan-reach.test.mjs
//
// The live bug: a 4 × 4 board of agent books (a team desk nested in the hub, its world scale ~0.1)
// entered, drag-pan right STOPPED with the third column cut at the canvas edge and the fourth out of
// reach. The strip re-aimed the plane on EVERY render so the focused pin (the top-left one) never sat
// under its band — a pan that slid that pin left was pulled back the next frame, walling the board off.
// The strip now clears the focused pin when the reserve changes (the desk entered, the band's width,
// collapse / expand), once; a pin hop (`pane.focus <dir>`) clears it as it slides.
// Locks, through the real ViewerCameraController frame by frame (drag input as the mouse leaves it),
// the real carrel.enter / pane.focus, the real Strip + PlaneOverlay updated every frame as the app does,
// and three's projection of each member's own corners:
//   - entered: the focused pin clear of the band
//   - a drag moves the board 1:1 (device px)
//   - panning right brings the rightmost pin's right edge on screen; down, the bottom row's bottom;
//     back left / up, the top-left pin clear of the band and below the top
//   - let go, the view stays put frame after frame (nothing pulls it)
//   - a reserve change after a pan (collapse, expand) clears the focused pin again, once
//   - a pin hop onto a pin under the band slides it clear
// each with the band shown and collapsed.
// Teeth: STRIP=<path> (HEAD's Strip.js: the per-frame pull) fails the pan checks;
//   PANE_COMMANDS=<path> (HEAD's paneCommands.js: the hop without the band) fails the hop check.

import * as THREE from 'three';
import { ViewerCameraController } from '../packages/glyph3d-core/src/services/camera/ViewerCameraController.js';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import PlaneOverlay from '../app/client/PlaneOverlay.js';
import Deixis from '../app/client/Deixis.js';
import registerCarrelCommands from '../app/commands/handlers/carrelCommands.js';

if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); }, key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
    };
}
const { Strip } = await import(process.env.STRIP || '../app/client/Strip.js');
const { default: registerPaneCommands } = await import(process.env.PANE_COMMANDS || '../app/commands/handlers/paneCommands.js');

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const W = 1912, H = 927;   // the canvas in the report
const CW = 0.725, LS = 1.359375;
const UNIT = { column: CW, cellPx: 8, rowRatio: LS / CW };
const COLS = 100, ROWS = 52, PINS = 13;   // 13 books in 4 columns: a board ~3.4k × 2.8k device px

/** A book-like member: cols × rows cells from its top-left origin. */
function screen(name, cols = COLS) {
    const g = new THREE.Object3D();
    g.name = name;
    g.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS };
    g.pixelOrigin = () => ({ x: 0, y: 0 });
    g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(0, -ROWS * LS, -0.5), new THREE.Vector3(cols * CW, 0, 0.5));
    g.cols = cols;
    return g;
}
/** A deep hub member (a deck), so the hub's ring seats the team desk scaled down. */
function deck() {
    const g = new THREE.Object3D();
    g.getLocalBounds = (t = new THREE.Box3()) => t.set(new THREE.Vector3(-300, -380, -900), new THREE.Vector3(300, 380, 10));
    g.getSeatBounds = (t) => g.getLocalBounds(t);
    return g;
}

/** @param {{collapsed: boolean, wideCols?: number}} o wideCols: the first pin that many columns wide (else COLS) */
function world({ collapsed, wideCols = COLS }) {
    const scene = new THREE.Scene();
    const hub = new Carrel({ name: 'gomux', mode: 'ring', seat: 'uniform', radius: 900, ringMaxRows: 2, boxH: 110, gapFrac: 1.6, animDur: 0 });
    scene.add(hub);
    const team = new Carrel({ name: 'gomux/root', mode: 'plane', animDur: 0 });
    scene.add(team);
    team.setPlaneUnit(UNIT);
    team.shelfCols = 4 * COLS + 8;   // four books to a shelf
    const members = [];
    for (let i = 0; i < PINS; i++) { const s = screen(`b${i}`, i === 0 ? wideCols : COLS); scene.add(s); team.lock(`b${i}`, s, { immediate: true }); members.push(s); }
    for (let i = 0; i < 3; i++) { const d = deck(); scene.add(d); hub.lock(`book${i}`, d, { immediate: true }); }
    hub.lock('gomux/root', team, { immediate: true });
    for (let i = 0; i < 12; i++) { hub.update(0.05); team.update(0.05); }
    scene.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(70, W / H, 1, 50000);
    const canvas = { parentElement: { clientWidth: W, clientHeight: H }, width: W, height: H, style: {} };
    const cc = new ViewerCameraController({ camera, THREE, canvas, getGrids: () => [] });
    cc.settings.softBounds = false;
    cc._onDeviceBox({ devicePixelContentBoxSize: [{ inlineSize: W, blockSize: H }] });
    camera.position.set(140, 60, 420);
    cc._applyRotation();
    camera.updateMatrixWorld(true);

    const verbs = new Map();
    const router = { register: (name, fn) => verbs.set(name, fn) };
    registerCarrelCommands(router);
    registerPaneCommands(router);
    const ctx = {
        scene, camera, cameraController: cc,
        carrels: new Map([['gomux', hub], ['gomux/root', team]]),
        registry: { get: () => null, has: () => false },
        attentionManager: { set() {}, get: () => null },
        getGrids: () => [], enteredCarrel: null, activeCarrel: null, carrelBack: null,
        gomuxHub: { snapshot: { agents: [] } }, agentBooks: { lanes: new Map(), agents: () => [] },
        holding: { holderOf: () => null, resolve: (a) => ({ id: a }) },
    };
    ctx.deixis = new Deixis(ctx);
    const exec = (line) => { const [v, ...a] = String(line).split(/\s+/); return verbs.get(v)(a, ctx); };
    const overlay = new PlaneOverlay({ width: W, height: H, dpr: 1 });
    const strip = new Strip(ctx, overlay, { exec, enabled: true });
    strip.setCollapsed(collapsed, { persist: false });
    ctx.strip = strip;
    strip.update();
    return { scene, team, members, cc, camera, ctx, strip, exec };
}

/** One app frame: the camera drains its input, then the strip renders (CommandProvider's order). */
function frame(w) { w.cc.applyCamera(1 / 60); w.camera.updateMatrixWorld(true); w.strip.update(); }
function land(w) { let n = 0; while (w.cc.planeState()?.tweening && n++ < 400) frame(w); frame(w); }
/** A pin's screen rect (device px, +y down) from its member's own corners. */
function rectOf(w, m) {
    m.updateWorldMatrix(true, false);
    const p = (x, y) => { const v = new THREE.Vector3(x, y, 0).applyMatrix4(m.matrixWorld).project(w.camera); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H }; };
    const a = p(0, 0), b = p(m.cols * CW, -ROWS * LS);
    return { l: a.x, t: a.y, r: b.x, b: b.y };
}
const rects = (w) => w.members.map((m) => rectOf(w, m));
/** Drag `n` frames of (dx, dy) CSS px each (dpr 1), then let go. */
function drag(w, dx, dy, n) {
    const d = w.cc.input.drag;
    for (let i = 0; i < n; i++) { d.active = true; d.mode = 'pan'; d.dx = dx; d.dy = dy; frame(w); }
    d.active = false; frame(w);
}
/** Drag in `step` px frames until `done()` (or the travel runs out); returns whether it got there. */
function dragUntil(w, dx, dy, done, maxFrames = 600) {
    const d = w.cc.input.drag;
    for (let i = 0; i < maxFrames && !done(); i++) { d.active = true; d.mode = 'pan'; d.dx = dx; d.dy = dy; frame(w); }
    d.active = false; frame(w);
    return done();
}
const r1 = (v) => v.toFixed(1);

for (const collapsed of [false, true]) {
    const tag = collapsed ? 'collapsed' : 'band shown';
    const w = world({ collapsed });
    const res = w.exec('carrel.enter gomux/root');
    ok(/^OK: entered/.test(res.text), `${tag}: carrel.enter (${res.text})`);
    land(w);
    const band = w.strip.stripRightPx();
    ok(collapsed ? band === 0 : band > 100, `${tag}: the band reserves ${band} px`);
    const scale = w.team.getPlaneRect().scale;
    ok(scale < 0.5, `${tag}: the team desk stands nested and scaled (${scale.toFixed(3)})`);
    const board = w.team._boardPx();
    ok(board.w > W + 1000 && board.h > 2 * H, `${tag}: the board is wider and taller than the canvas (${board.w} × ${board.h} px)`);
    const cols = new Set(w.team.pinRects().map((p) => p.rect.x)).size;
    ok(cols === 4, `${tag}: four columns of pins (${cols})`);
    const first = w.members[0];
    ok(rectOf(w, first).l >= band - 0.5, `${tag}: entered, the focused pin clear of the band (${r1(rectOf(w, first).l)} ≥ ${band})`);

    // 1:1
    const a0 = rectOf(w, first);
    drag(w, -37, 23, 1);
    const a1 = rectOf(w, first);
    ok(Math.abs(a1.l - a0.l + 37) < 1e-3 && Math.abs(a1.t - a0.t - 23) < 1e-3, `${tag}: a drag moves the board 1:1 (${r1(a1.l - a0.l)}, ${r1(a1.t - a0.t)})`);

    // right, as far as it goes
    const maxR = () => Math.max(...rects(w).map((r) => r.r));
    const reachedR = dragUntil(w, -40, 0, () => maxR() <= W - 16);
    ok(reachedR, `${tag}: panning right brings the rightmost pin's right edge on screen (${r1(maxR())} of ${W})`);
    // let go: nothing pulls the view back
    const still = rects(w).map((r) => r.l);
    for (let i = 0; i < 30; i++) frame(w);
    ok(rects(w).every((r, i) => r.l === still[i]), `${tag}: let go, the view stays put (moved ${r1(rects(w)[0].l - still[0])} px in 30 frames)`);
    // down
    const maxB = () => Math.max(...rects(w).map((r) => r.b));
    ok(dragUntil(w, 0, -40, () => maxB() <= H - 16), `${tag}: panning down brings the bottom row on screen (${r1(maxB())} of ${H})`);
    // back left and up: the top-left pin clear of the band, below the top
    ok(dragUntil(w, 40, 0, () => rectOf(w, first).l >= band + 16), `${tag}: panning back left brings the first column clear of the band (${r1(rectOf(w, first).l)} ≥ ${band})`);
    ok(dragUntil(w, 0, 40, () => rectOf(w, first).t >= 16), `${tag}: panning back up brings the top row on screen (${r1(rectOf(w, first).t)})`);
    // past the band: a pan that slides the focused pin under it stays, 1:1
    const before = rectOf(w, first).l;
    drag(w, -40, 0, 20);
    const under = rectOf(w, first).l;
    for (let i = 0; i < 10; i++) frame(w);
    ok(Math.abs(under - (before - 800)) < 1e-3 && rectOf(w, first).l === under, `${tag}: a pan that slides the focused pin left 800 px goes 800 px and stays (${r1(before)} → ${r1(under)} → ${r1(rectOf(w, first).l)})`);

    if (!collapsed) {
        ok(under < band - 100, `${tag}: …that pin well under the band (${r1(under)} < ${band})`);
        // a reserve change clears it again, once
        w.strip.setCollapsed(true, { persist: false }); frame(w);
        w.strip.setCollapsed(false, { persist: false }); frame(w);
        ok(rectOf(w, first).l >= band - 0.5, `${tag}: collapse then expand clears the focused pin again (${r1(rectOf(w, first).l)} ≥ ${band})`);
    }
}

// A hop onto a pin as wide as the canvas (a 236-column screen: a pin that fits is centered, clear of
// the band on its own) slides it clear of the band.
{
    const w = world({ collapsed: false, wideCols: 236 });
    w.exec('carrel.enter gomux/root');
    land(w);
    const band = w.strip.stripRightPx(), first = w.members[0];
    ok(/^OK: focus → 'b1'/.test(w.exec('pane.focus right').text), 'wide pin: pane.focus right to b1');
    frame(w);
    const hop = w.exec('pane.focus left'); frame(w);
    const l = rectOf(w, first).l;
    ok(/^OK: focus → 'b0'/.test(hop.text) && l >= band - 0.5 && l <= band + 0.5, `wide pin: pane.focus left onto it lands its left edge on the band's (${hop.text}; ${r1(l)} vs ${band})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} — plane-pan-reach: ${checks - fails}/${checks}`);
process.exit(fails ? 1 : 0);
