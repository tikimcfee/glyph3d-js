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

const frame = { widthPx: 1600, heightPx: 942, pxPerUnit: 8 / CW, cellPx: 8 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function deskWith(n, { layout = 'even' } = {}) {
    const scene = new THREE.Scene();
    const desk = new Carrel({ name: 'p', form: 'plane', animDur: 0 });
    scene.add(desk);
    desk.setPlaneFrame(frame);
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
    const f = desk.planeFrame;
    const W = f.widthPx / f.pxPerUnit, H = f.heightPx / f.pxPerUnit;
    for (const p of desk.paneRects()) {
        const g = desk.entries.get(p.active).grid;
        near(g.scale.x * CW, f.cellPx / f.pxPerUnit, 1e-9, `${p.active}: its column is the plane's`);
        // The cell origin in desk-local → device px from the plane's top-left.
        const o = g.pixelOrigin();
        const lx = g.position.x + o.x * g.scale.x, ly = g.position.y + o.y * g.scale.y;
        const px = (lx + W / 2) * f.pxPerUnit, py = (H - ly) * f.pxPerUnit;
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
    // turning space hands everyone back
    desk.setForm('space');
    await flush();
    ok(grids.filter((g) => g !== g0).every((g) => g._wrap === 0 && g.config.showFilename === true && g.visible !== false), 'turning space hands every member back');
}

// 4. round-trip; pending claims hold their place; malformed refused.
{
    const { desk } = deskWith(4, { layout: 'main' });
    const rec = desk.serializePanes();
    const rects = JSON.stringify(desk.paneRects().map((p) => [p.id, p.rect, p.stack]));
    const fresh = new Carrel({ name: 'p2', form: 'plane', animDur: 0 });
    fresh.setPlaneFrame(frame);
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
    const fresh = new Carrel({ name: 'p3', form: 'plane', animDur: 0 });
    fresh.setPlaneFrame(frame);
    fresh.applyPanes(JSON.parse(JSON.stringify(rec)));
    ok(fresh.focusedPane() === desk.focusedPane() && fresh.panes.zoomed === desk.panes.zoomed, 'focus and zoom round-trip');
}

console.log(`${fails ? 'FAIL' : 'ok'} carrel-plane: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
