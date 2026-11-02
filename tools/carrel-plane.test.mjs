// carrel-plane.test.mjs — a PLANE desk (Carrel form 'plane'): a tiling window manager laid out on a
// flat wall exactly as it reads entered.
//
//   bun tools/carrel-plane.test.mjs
//
// Locks:
//   - pane rects are whole device pixels, gapped, inside the frame, never overlapping
//   - a member joining lands in the INBOX pane as its active tab — every other pane's rect is
//     unchanged (zero tolerance; place memory is the WM's promise)
//   - each seated member is scaled so its text column is the plane's (cellPx / pxPerUnit world
//     units) and its cell-grid origin sits at its pane's top-left on a whole device pixel
//   - a reflowable member takes the pane's columns × rows and hides its header; leaving the desk
//     (or the desk turning space) hands back its own wrap, frame and header — and while paned a
//     save sees its OWN frame (userData.paneOwn), never the pane's
//   - only a stack's active member shows; the rest are members, hidden
//   - the pane layout round-trips (serializePanes → applyPanes), stacks naming members not seated
//     yet hold their place until they arrive; a malformed record throws
//   - named layouts: even (rows of ≤3) and main (one wide + a stack) tile the frame

import './headless-canvas.mjs';
import * as THREE from 'three';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);

const CW = 0.725, LS = 1.359375;   // a CodeGrid's world column and row (29×54.375 atlas px × 0.025)

/** A stand-in CodeGrid: cell metrics, a pixel origin, a reflowable layout + frame, a header. */
function mockGrid(name) {
    const g = new THREE.Object3D();
    g.name = name;
    g.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS };
    g.config = { showFilename: true };
    g.filename = name;
    g._wrap = 0; g._frame = 0;
    g.getLayout = () => ({ wrapWidth: g._wrap });
    g.setLayout = (l) => { g._wrap = l.wrapWidth; return Promise.resolve(g); };
    g.getFrameRows = () => g._frame;
    g.setFrameRows = (r) => { g._frame = r; return Promise.resolve(g); };
    g.showFilename = (v) => { g.config.showFilename = v; };
    g.pixelOrigin = () => ({ x: 0, y: -0.5 * LS });
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -40, -0.5), new THREE.Vector3(60, 0, 0.5));
    return g;
}

const UNIT = { column: CW, cellPx: 8, rowRatio: LS / CW };   // 8 px columns → 15 px rows
const frame = { widthPx: 1600, heightPx: 930 };              // tileCols 200 × tileRows 62 at 8×15
const TILES = { mode: 'plane', planeArrange: 'tiles', tileCols: 200, tileRows: 62, animDur: 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function deskWith(n, { layout = 'even' } = {}) {
    const scene = new THREE.Scene();
    const desk = new Carrel({ name: 'p', ...TILES });
    scene.add(desk);
    desk.setPlaneUnit(UNIT);
    const grids = [];
    for (let i = 0; i < n; i++) {
        const g = mockGrid(`g${i}`);
        scene.add(g);
        desk.lock(`g${i}`, g, { immediate: true });
        grids.push(g);
    }
    if (layout) desk.layoutPanes(layout);
    desk.animator.update?.(10);
    return { scene, desk, grids };
}
const settle = (desk) => { for (let i = 0; i < 4; i++) desk.animator.update?.(1); };

// 1. rects: whole pixels, gapped, in frame, disjoint; even and main tile it.
for (const [layout, n] of [['even', 5], ['main', 4], ['stack', 3], ['even', 1]]) {
    const { desk } = deskWith(n, { layout });
    const panes = desk.paneRects();
    ok(panes.length === (layout === 'stack' ? 1 : n), `${layout}/${n}: ${panes.length} panes`);
    for (const p of panes) {
        const r = p.rect;
        ok([r.x, r.y, r.w, r.h].every(Number.isInteger), `${layout}: ${p.id} rect is whole pixels ${JSON.stringify(r)}`);
        ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= frame.widthPx && r.y + r.h <= frame.heightPx, `${layout}: ${p.id} inside the frame`);
    }
    for (let i = 0; i < panes.length; i++) for (let j = i + 1; j < panes.length; j++) {
        const a = panes[i].rect, b = panes[j].rect;
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        ok(disjoint, `${layout}: ${panes[i].id} and ${panes[j].id} don't overlap`);
    }
    const area = panes.reduce((s, p) => s + p.rect.w * p.rect.h, 0);
    ok(area > 0.95 * frame.widthPx * frame.heightPx * 0.97, `${layout}/${n}: panes cover the frame (${(area / (frame.widthPx * frame.heightPx) * 100).toFixed(1)}%)`);
}

// 2. a join lands in the inbox; no other pane moves.
{
    const { desk, scene } = deskWith(3);
    const before = new Map(desk.paneRects().map((p) => [p.id, JSON.stringify(p.rect)]));
    const inbox = desk.panes.inbox;
    const g = mockGrid('late');
    scene.add(g);
    desk.lock('late', g, { immediate: true });
    const after = desk.paneRects();
    ok(after.length === before.size, 'a join opens no pane');
    for (const p of after) ok(before.get(p.id) === JSON.stringify(p.rect), `a join leaves ${p.id}'s rect exactly as it was`);
    const ib = after.find((p) => p.id === inbox);
    ok(ib.active === 'late' && ib.stack.includes('late'), 'the joiner is the inbox pane’s active tab');
    const hidden = after.find((p) => p.id === inbox).stack.filter((id) => id !== 'late');
    ok(hidden.every((id) => desk.entries.get(id).grid.visible === false), 'the inbox pane’s other tab is hidden');
    ok(g.visible !== false, 'the active tab shows');
}

// 3. members at the plane column; cell origin on a whole pixel at the pane's top-left.
{
    const { desk, grids } = deskWith(3);
    await flush(); desk._relayout(); settle(desk);
    const f = { cellPx: UNIT.cellPx, pxPerUnit: desk.planeK };
    const tl = desk._boardTopLeft();
    for (const p of desk.paneRects()) {
        const g = desk.entries.get(p.active).grid;
        near(g.scale.x * CW, f.cellPx / f.pxPerUnit, 1e-9, `${p.active}: its column is the plane's`);
        // The cell origin in desk-local → device px from the board's top-left.
        const o = g.pixelOrigin();
        const lx = g.position.x + o.x * g.scale.x, ly = g.position.y + o.y * g.scale.y;
        const px = (lx - tl.x) * f.pxPerUnit, py = (tl.y - ly) * f.pxPerUnit;
        near(px, p.rect.x, 1e-6, `${p.active}: cell origin x at its pane's left`);
        near(py, p.rect.y, 1e-6, `${p.active}: cell origin y at its pane's top`);
        ok(Math.abs(px - Math.round(px)) < 1e-6 && Math.abs(py - Math.round(py)) < 1e-6, `${p.active}: on a whole device pixel`);
    }
    // reflowed to the pane, header hidden, own view kept for saves
    const p0 = desk.paneRects()[0];
    const g0 = desk.entries.get(p0.active).grid;
    ok(g0._wrap === Math.floor(p0.rect.w / f.cellPx), `reflow: wrap = pane cols (${g0._wrap})`);
    ok(g0._frame === Math.floor(p0.rect.h / (f.cellPx * LS / CW)), `reflow: frame = pane rows (${g0._frame})`);
    ok(g0.config.showFilename === false, 'paned: its header steps aside');
    ok(g0.userData.paneOwn?.frameRows === 0, 'a save sees its own frame (0), not the pane’s');
    // leaving hands it all back
    desk.release(p0.active);
    await flush();
    ok(g0._wrap === 0 && g0._frame === 0 && g0.config.showFilename === true && !g0.userData.paneOwn, 'leaving hands back wrap, frame, header');
    ok(!desk.paneRects().some((p) => p.stack.includes(p0.active)), 'leaving takes it out of its stack');
    // turning ring hands everyone back
    desk.setMode('ring');
    await flush();
    ok(grids.filter((g) => g !== g0).every((g) => g._wrap === 0 && g.config.showFilename === true && g.visible !== false), 'turning ring hands every member back');
}

// 4. round-trip; pending claims hold their place; malformed refused.
{
    const { desk } = deskWith(4, { layout: 'main' });
    const rec = desk.serializePanes();
    const rects = JSON.stringify(desk.paneRects().map((p) => [p.id, p.rect, p.stack]));
    const fresh = new Carrel({ name: 'p2', ...TILES });
    fresh.setPlaneUnit(UNIT);
    fresh.applyPanes(JSON.parse(JSON.stringify(rec)));
    ok(JSON.stringify(fresh.paneRects().map((p) => [p.id, p.rect, p.stack])) === rects, 'serialize → apply reproduces panes, rects and stacks exactly');
    // members arriving later go back to THEIR panes, not the inbox
    for (let i = 3; i >= 0; i--) fresh.lock(`g${i}`, mockGrid(`g${i}`), { immediate: true });
    ok(JSON.stringify(fresh.paneRects().map((p) => [p.id, p.rect, p.stack])) === rects, 'members seated late (reverse order) land in their saved panes');
    let threw = false;
    try { fresh.applyPanes({ tree: { leaf: 'pane:1' }, stacks: [{ id: 'pane:9', ids: [] }] }); } catch { threw = true; }
    ok(threw, 'a stack naming no pane of the tree throws');
}

// 5. pane operations: focus by direction, split, close merges tabs, swap, tab, zoom, place.
{
    const { desk } = deskWith(3);                       // even: three side by side
    const [pa, pb, pc] = desk.paneRects().map((p) => p.id);
    desk.paneFocusOn(pa);
    ok(desk.paneFocus('right') === pb && desk.paneFocus('right') === pc, 'focus walks right across the row');
    ok(desk.paneFocus('right') === null && desk.focusedPane() === pc, 'no pane past the edge: focus stays');
    // split the focused pane (pc) down, moving g0 out of pa into the new pane
    const np = desk.paneSplit('y', 'g0');
    ok(np && desk.focusedPane() === np && desk.paneFront(np) === 'g0', 'split: the new pane holds the member and has focus');
    ok(!desk.panes.stacks.get(pa).ids.includes('g0'), 'split: the member left its old stack');
    const rc = desk.paneRects().find((p) => p.id === pc).rect, rn = desk.paneRects().find((p) => p.id === np).rect;
    ok(rc.x === rn.x && rc.w === rn.w && rc.y < rn.y, 'split y: the new pane sits under the old one, same columns');
    // close the new pane: its tab joins pc
    const into = desk.paneClose(np);
    ok(into === pc && desk.panes.stacks.get(pc).ids.includes('g0') && !desk.panes.stacks.has(np), 'close: the tabs join the pane that takes its place');
    // tab cycles within pc (g2 and g0)
    desk.paneFocusOn(pc);
    const t1 = desk.paneFront(pc), t2 = desk.paneTab('next');
    ok(t2 !== t1 && desk.paneTab('next') === t1, 'tab: next cycles the stack');
    ok(desk.entries.get(t1).grid.visible !== false && desk.entries.get(t2).grid.visible === false, 'tab: only the front tab shows');
    // swap pa and pb contents; rects unchanged
    const before = JSON.stringify(desk.paneRects().map((p) => [p.id, p.rect]));
    const fa = desk.paneFront(pa), fb = desk.paneFront(pb);
    desk.paneSwap(pa, pb);
    ok(desk.paneFront(pa) === fb && desk.paneFront(pb) === fa && JSON.stringify(desk.paneRects().map((p) => [p.id, p.rect])) === before, 'swap: contents trade, rects stay');
    // zoom: the focused pane takes the frame, others hide; unzoom restores the rects
    desk.paneFocusOn(pb);
    desk.paneZoom(true);
    const zr = desk.paneRects();
    ok(zr.length === 1 && zr[0].id === pb && zr[0].rect.w > 1500, 'zoom: one pane, the whole frame');
    ok(desk.entries.get(desk.paneFront(pa)).grid.visible === false, 'zoom: the other panes’ members hide');
    desk.paneZoom(false);
    ok(JSON.stringify(desk.paneRects().map((p) => [p.id, p.rect])) === before, 'unzoom: every rect as it was');
    // place: a member as a tab of another pane, then split off a side
    ok(desk.panePlace('g1', pa, 'tab') === pa && desk.paneFront(pa) === 'g1', 'place tab: the member fronts the target pane');
    const side = desk.panePlace('g1', pa, 'left');
    const rs = desk.paneRects().find((p) => p.id === side).rect, ra = desk.paneRects().find((p) => p.id === pa).rect;
    ok(side && rs.x < ra.x && rs.y === ra.y, 'place left: a new pane split off its left side');
    // focus + zoom ride the record
    desk.paneZoom(true);
    const rec = desk.serializePanes();
    const fresh = new Carrel({ name: 'p3', ...TILES });
    fresh.setPlaneUnit(UNIT);
    fresh.applyPanes(JSON.parse(JSON.stringify(rec)));
    ok(fresh.focusedPane() === desk.focusedPane() && fresh.panes.zoomed === desk.panes.zoomed, 'focus and zoom round-trip');
}

// ── PIN BOARD (the default plane arrangement) ─────────────────────────────────────────────────
/** A terminal-like member: cols × rows cells, bounds from its origin (top-left) down/right. */
function screen(name, cols, rows) {
    const g = mockGrid(name);
    g.setLayout = undefined; g.setFrameRows = undefined;   // foreign: keeps its size
    g._cols = cols; g._rows = rows;
    g.pixelOrigin = () => ({ x: 0, y: 0 });
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -g._rows * LS, -0.5), new THREE.Vector3(g._cols * CW, 0, 0.5));
    return g;
}
function board(members, opts = {}) {
    const scene = new THREE.Scene();
    const desk = new Carrel({ name: 'b', mode: 'plane', animDur: 0, ...opts });
    scene.add(desk);
    desk.setPlaneUnit(UNIT);
    for (const [id, g] of members) { scene.add(g); desk.lock(id, g, { immediate: true }); }
    return { scene, desk };
}
const pinMap = (desk) => new Map(desk.pinRects().map((p) => [p.id, JSON.stringify(p.rect)]));

// 6. pins: natural size, whole px, shelves wrap at shelfCols, column scale, cell origin on whole px
{
    const { desk } = board([['a', screen('a', 239, 56)], ['b', screen('b', 239, 56)], ['c', screen('c', 120, 40)]]);
    const pins = desk.pinRects();
    ok(pins.length === 3 && pins.every((p) => [p.rect.x, p.rect.y, p.rect.w, p.rect.h].every(Number.isInteger)), 'pins: whole device pixels');
    const [pa, pb, pc] = pins;
    ok(pa.rect.w === 239 * 8 && pa.rect.h === 56 * 15, `a 239×56 screen pins at its own size: ${pa.rect.w}×${pa.rect.h} (every column, every row)`);
    ok(pb.rect.y === pa.rect.y && pb.rect.x === pa.rect.x + pa.rect.w + 8, 'two 239-col screens share the first 480-col shelf, a gutter apart');
    ok(pc.rect.x === 0 && pc.rect.y === pa.rect.y + pa.rect.h + 8, 'the third wraps to the next shelf');
    const k = desk.planeK, tl = desk._boardTopLeft();
    for (const id of ['a', 'b', 'c']) {
        const g = desk.entries.get(id).grid;
        near(g.scale.x * CW, UNIT.cellPx / k, 1e-9, `${id}: its column is the plane's`);
        const px = (g.position.x - tl.x) * k, py = (tl.y - g.position.y) * k;   // pixelOrigin is (0,0)
        ok(Math.abs(px - Math.round(px)) < 1e-6 && Math.abs(py - Math.round(py)) < 1e-6, `${id}: cell origin on a whole device pixel (${px.toFixed(4)}, ${py.toFixed(4)})`);
    }
    ok(desk.focusedPin() === 'a', 'the first pin has focus by default');
}

// 7. a join appends — no earlier pin moves; a leave leaves a ghost; settle repacks
{
    const { desk, scene } = board([['a', screen('a', 239, 56)], ['b', screen('b', 100, 20)]]);
    const before = pinMap(desk);
    const g = screen('n', 80, 24); scene.add(g);
    desk.lock('n', g, { immediate: true });
    const after = pinMap(desk);
    ok([...before].every(([id, r]) => after.get(id) === r), 'a join moves no earlier pin (zero tolerance)');
    ok(after.has('n'), 'the newcomer has a pin');
    desk.release('a');
    const left = desk.pinRects();
    ok(left.find((p) => p.id === 'a')?.ghost === true, 'a leaver leaves a ghost');
    ok(left.filter((p) => p.id !== 'a').every((p) => after.get(p.id) === JSON.stringify(p.rect)), 'a leave moves no pin');
    desk.settle();
    const packed = desk.pinRects();
    ok(!packed.some((p) => p.id === 'a') && packed[0].rect.x === 0 && packed[0].id === 'b', 'settle drops the ghost and repacks');
    // a late member seated with an earlier ORDER (a screen beside its book) appends — then settle puts it in seat order
    const s2 = screen('s2', 40, 10); scene.add(s2);
    desk.lock('s2', s2, { immediate: true, order: desk.entries.get('b').order + 0.5 });
    ok(desk.pinRects().at(-1).id === 's2', 'a joiner appends even with an earlier seat order (nothing moves)');
    desk.settle();
    ok(desk.pinRects().map((p) => p.id).join() === 'b,s2,n', `settle takes seat order (${desk.pinRects().map((p) => p.id).join()})`);
}

// 8. growth: only the pins after it on its shelf move; a pin never shrinks until settle
{
    const gb = screen('b', 100, 20);
    const { desk } = board([['a', screen('a', 100, 20)], ['b', gb], ['c', screen('c', 100, 20)], ['d', screen('d', 300, 20)]]);
    const before = pinMap(desk);
    gb._cols = 140; desk.reflow('b');
    const after = pinMap(desk);
    ok(after.get('a') === before.get('a'), 'growth: an earlier pin stays');
    ok(JSON.parse(after.get('b')).w === 140 * 8 && JSON.parse(after.get('c')).x > JSON.parse(before.get('c')).x, 'growth: it grows and the next pin on its shelf moves along');
    gb._cols = 60; desk.reflow('b');
    ok(JSON.parse(pinMap(desk).get('b')).w === 140 * 8, 'a shrink keeps the pin (grow-only until settle)');
    desk.settle();
    ok(JSON.parse(pinMap(desk).get('b')).w === 60 * 8, 'settle re-measures it');
}

// 9. a book (no cell metrics) pins bookCols wide
{
    const book = new THREE.Object3D();
    book.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(-200, -150, -5), new THREE.Vector3(200, 150, 5));
    const { desk } = board([['book', book]], { bookCols: 120 });
    const p = desk.pinRects()[0];
    ok(Math.abs(p.rect.w - 120 * 8) <= 1, `a book pins bookCols (120) columns wide: ${p.rect.w}px`);
}

// 9b. a frame (a desktop, an image) pins at one texel per device pixel, nearest-filtered
{
    const f = new THREE.Object3D();
    let one = false;
    f.naturalPx = () => ({ w: 1280, h: 720 });
    f.width = 40; f.texelSize = () => ({ x: 40 / 1280, y: 40 / 1280 });
    f.pixelOrigin = () => ({ x: -20, y: 11.25 });
    f.setOneToOne = (b) => { one = b; };
    f.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(-20, -11.25, -0.1), new THREE.Vector3(20, 11.25, 0.1));
    const { desk } = board([['desk1', f]]);
    const p = desk.pinRects()[0];
    ok(p.rect.w === 1280 && p.rect.h === 720, `a 1280×720 frame pins at 1280×720 device px (${p.rect.w}×${p.rect.h})`);
    near(f.scale.x * (40 / 1280) * desk.planeK, 1, 1e-9, 'one texel = one device px');
    ok(one, 'it is switched to nearest filtering');
}

// 10. the pin record round-trips; members arriving late (any order) take their saved pins
{
    const { desk } = board([['a', screen('a', 239, 56)], ['b', screen('b', 100, 20)], ['c', screen('c', 80, 24)]]);
    const rec = JSON.parse(JSON.stringify(desk.serializePanes()));
    const want = JSON.stringify([...pinMap(desk)]);
    const scene = new THREE.Scene();
    const fresh = new Carrel({ name: 'b2', mode: 'plane', animDur: 0 });
    scene.add(fresh);
    fresh.setPlaneUnit(UNIT);
    fresh.applyPanes(rec);
    for (const [id, c, r] of [['c', 80, 24], ['a', 239, 56], ['b', 100, 20]]) { const g = screen(id, c, r); scene.add(g); fresh.lock(id, g, { immediate: true }); }
    ok(JSON.stringify([...pinMap(fresh)]) === want, 'serialize → apply → members in reverse order: identical pins');
}

console.log(`${fails ? 'FAIL' : 'ok'} carrel-plane: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
