// pane-layout.test.mjs — PaneLayout (services/interaction/PaneLayout.js), the ONE tiling layout the
// CameraDock's frame and a tiled plane desk share (docs/planes/DESIGN.md §3.11).
//
//   bun tools/pane-layout.test.mjs
//
// Locks:
//   - THE PLACE-MEMORY LAW: a join, an open, an attach land in the inbox as its active tab and change
//     NO pane's rect — zero tolerance, on the bare layout and on a real tiled Carrel. Teeth: the same
//     checks against a split-the-focused-pane join policy must FAIL.
//   - rects are whole device px, inside the frame, gutters exact (neighbors a whole gutter apart, the
//     frame edge half), and they cover the frame
//   - leave keeps a desk's pane; drop (the dock) closes a pane its member left; a merge-close hands its
//     tabs to the pane that takes its place, and the last pane only closes without merging
//   - swap trades contents with every rect in place (member-named panes trade leaves); zoom takes the
//     whole frame and unzoom restores every rect exactly; tab cycles; place tabs or splits
//   - serialize → apply round-trips rects, stacks, inbox, focus, zoom; a malformed record throws
//   - member-named panes (the dock): every pane id IS its member

import './headless-canvas.mjs';
import * as THREE from 'three';
import PaneLayout from '../packages/glyph3d-core/src/services/interaction/PaneLayout.js';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const FRAME = { widthPx: 1912, heightPx: 840, gapPx: 8 };
const rectsOf = (L) => new Map(L.rects(FRAME).map((p) => [p.id, JSON.stringify(p.rect)]));
/** Every pane present before still has exactly its rect (zero tolerance). */
const unmoved = (before, after) => [...before].every(([id, r]) => after.get(id) === r);

/** The policy the law forbids: a joiner splits the focused pane. */
class SplitOnJoin extends PaneLayout {
    join(memberId) {
        if (this.isEmpty() || this.paneOf(memberId)) return super.join(memberId);
        return this.split('x', memberId);
    }
}

// ── 1. The law on the bare layout: join (a member), open (a file), attach (an agent's screen).
function joinRun(L) {
    L.layout('even', ['a', 'b', 'c', 'd']);
    const before = rectsOf(L);
    const results = [];
    for (const who of ['open:x.js', 'attach:gx-relay', 'join:book']) {
        const prev = rectsOf(L);
        const pane = L.join(who);
        results.push({ who, pane, held: unmoved(prev, rectsOf(L)) && rectsOf(L).size === prev.size });
    }
    return { before, results, after: rectsOf(L) };
}
{
    const L = new PaneLayout();
    const { before, results, after } = joinRun(L);
    for (const r of results) ok(r.held, `${r.who}: no pane's rect changed (zero tolerance)`);
    ok(unmoved(before, after), 'after all three, every rect is as it was');
    ok(results.every((r) => r.pane === L.inbox), 'every arrival landed in the inbox');
    const st = L.stacks.get(L.inbox);
    ok(st.active === 'join:book' && st.ids.slice(-3).join() === 'open:x.js,attach:gx-relay,join:book', `the inbox stacks them, the newest active (${st.ids})`);
    ok(L.join('a') === L.paneOf('a') && rectsOf(L).size === before.size, 'a member already placed stays where it is');

    // Teeth: split-the-focused-pane fails the same checks.
    const T = joinRun(new SplitOnJoin());
    ok(T.results.some((r) => !r.held), `teeth: a split-on-join policy moves a pane (${T.results.map((r) => `${r.who}:${r.held}`).join(' ')})`);
}

// ── 2. Rects: whole px, in frame, exact gutters, covering.
{
    const L = new PaneLayout();
    L.layout('even', ['a', 'b', 'c', 'd', 'e']);
    const ps = L.rects(FRAME);
    ok(ps.every((p) => Object.values(p.rect).every(Number.isInteger)), 'every rect is whole device px');
    ok(ps.every((p) => p.rect.x >= 0 && p.rect.y >= 0 && p.rect.x + p.rect.w <= FRAME.widthPx && p.rect.y + p.rect.h <= FRAME.heightPx), 'every rect is inside the frame');
    const row0 = ps.filter((p) => p.rect.y === ps[0].rect.y).sort((a, b) => a.rect.x - b.rect.x);
    const gaps = row0.slice(1).map((p, i) => p.rect.x - (row0[i].rect.x + row0[i].rect.w));
    ok(gaps.length === 2 && gaps.every((g) => g === FRAME.gapPx), `neighbors sit one whole gutter apart (${gaps})`);
    ok(row0[0].rect.x === FRAME.gapPx / 2 && ps[0].rect.y === FRAME.gapPx / 2, 'the frame edge keeps half a gutter');
    const area = ps.reduce((s, p) => s + (p.rect.w + FRAME.gapPx) * (p.rect.h + FRAME.gapPx), 0);
    ok(Math.abs(area / (FRAME.widthPx * FRAME.heightPx) - 1) < 0.01, `the panes and their gutters cover the frame (${(area / (FRAME.widthPx * FRAME.heightPx) * 100).toFixed(2)}%)`);
    const M = new PaneLayout();
    M.layout('main', ['a', 'b', 'c']);
    const mp = M.rects({ widthPx: 1000, heightPx: 600 });
    ok(mp.length === 3 && mp[0].rect.w === 600 && mp[1].rect.x === 600, `main: the first pane takes 60% (${JSON.stringify(mp.map((p) => p.rect))})`);
    const S = new PaneLayout();
    S.layout('stack', ['a', 'b', 'c']);
    ok(S.count() === 1 && S.stacks.get(S.inbox).ids.join() === 'a,b,c', 'stack: one pane, every member a tab');
    ok(!new PaneLayout().layout('nope', ['a']), 'an unknown layout name is refused');
}

// ── 3. leave / drop / close.
{
    const L = new PaneLayout();
    L.layout('even', ['a', 'b', 'c']);
    const before = rectsOf(L);
    const pb = L.paneOf('b');
    L.leave('b');
    ok(L.has(pb) && unmoved(before, rectsOf(L)), 'leave: the pane stays (a desk keeps its tiles), nothing moves');
    const next = L.close(L.paneOf('a'));
    ok(next && L.stacks.get(next).ids.includes('a') && L.count() === 2, 'merge-close: its tabs join the pane that takes its place');
    ok(L.focus === next, 'focus moves to that pane');
    L.close(L.panes()[0]);
    ok(L.close(L.panes()[0]) === null && L.count() === 1, 'the last pane does not merge-close');
    ok(L.close(L.panes()[0], { merge: false }) === null && L.isEmpty(), 'without merging it does: the layout empties');
    const D = new PaneLayout({ paneIds: 'member' });
    D.layout('stack', ['w1']);
    D.split('x', 'w2');
    ok(D.drop('w2') && D.count() === 1 && D.has('w1'), 'drop: a pane its member left closes (the dock)');
}

// ── 4. swap / zoom / tab / place.
{
    const L = new PaneLayout();
    L.layout('even', ['a', 'b', 'c']);
    const [pa, pb] = L.panes();
    const before = rectsOf(L);
    L.swap(pa, pb);
    ok(L.front(pa) === 'b' && L.front(pb) === 'a' && unmoved(before, rectsOf(L)), 'swap: contents trade, every rect in place');
    L.focusOn(pb);
    L.zoom(true);
    const z = L.rects(FRAME);
    ok(z.length === 1 && z[0].id === pb && z[0].rect.w === FRAME.widthPx - FRAME.gapPx, 'zoom: one pane, the whole frame');
    L.zoom(false);
    ok(unmoved(before, rectsOf(L)), 'unzoom: every rect exactly as before');
    L.place('c', pb, 'tab');
    ok(L.front(pb) === 'c' && L.tab('next') === 'a' && L.tab('next') === 'c', 'place tab + tab cycles the stack');
    const np = L.place('a', pb, 'left');
    ok(np && L.paneOf('a') === np && L.focus === np, 'place left: a new pane split off that side, focused');
    ok(L.focusDir('right') === pb, 'focusDir: the geometric neighbor');
    const D = new PaneLayout({ paneIds: 'member' });
    D.layout('stack', ['w1']);
    D.split('x', 'w2');
    D.swap('w1', 'w2');
    ok(D.panes().join() === 'w2,w1', 'member-named swap trades the leaves');
}

// ── 5. Round trip.
{
    const L = new PaneLayout();
    L.layout('main', ['a', 'b', 'c', 'd']);
    L.join('e');
    L.focusOn(L.paneOf('c'));
    L.zoom(true);
    L.zoom(false);
    L.resize('y', 0.1);
    const rec = JSON.parse(JSON.stringify(L.serialize()));
    const R = new PaneLayout();
    R.apply(rec);
    ok(JSON.stringify([...rectsOf(R)]) === JSON.stringify([...rectsOf(L)]), 'serialize → apply: every rect');
    ok(R.inbox === L.inbox && R.focus === L.focus && R.zoomed === L.zoomed && R.seq === L.seq, 'inbox, focus, zoom, seq');
    ok(JSON.stringify([...R.stacks]) === JSON.stringify([...L.stacks]), 'every stack');
    ok(R.join('f') === L.inbox, 'a restored layout takes joiners in the same inbox');
    ok(R.split('x', 'g') === `pane:${L.seq + 1}`, 'and keeps counting pane ids past the saved ones');
    for (const bad of [null, {}, { tree: { leaf: 'p:1' }, stacks: [{ id: 'nope', ids: [] }] }]) {
        let threw = false;
        try { new PaneLayout().apply(bad); } catch { threw = true; }
        ok(threw, `a malformed record throws (${JSON.stringify(bad)})`);
    }
    ok(new PaneLayout().serialize() === null, 'an empty layout serializes to null');
}

// ── 6. Member-named panes (the dock's frame).
{
    const D = new PaneLayout({ paneIds: 'member' });
    D.layout('stack', ['t1']);
    D.split('x', 't2');
    D.split('y', 't3');
    ok(D.panes().every((p) => D.front(p) === p), `every pane id IS its member (${D.panes()})`);
    ok(D.split('x', 't2') === null, 'a member already framed cannot be split in again');
    ok(D.focused() === 't3', 'a split focuses the new pane');
}

// ── 7. The law on a real tiled desk: a join, an animated open, an attach of a member the saved
//       stacks held a place for — no pane's rect moves. Teeth: the same desk on split-on-join fails.
const CW = 0.725, LS = 1.359375;
function mockGrid(name) {
    const g = new THREE.Object3D();
    g.name = name;
    g.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS };
    g.pixelOrigin = () => ({ x: 0, y: -0.5 * LS });
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -40, -0.5), new THREE.Vector3(60, 0, 0.5));
    return g;
}
function deskRun(Layout) {
    const scene = new THREE.Scene();
    const desk = new Carrel({ name: 'p', mode: 'plane', planeArrange: 'tiles', tileCols: 239, tileRows: 56, animDur: 0 });
    desk.panes.tiles = new Layout();
    scene.add(desk);
    desk.setPlaneUnit({ column: CW, cellPx: 8, rowRatio: LS / CW });
    for (let i = 0; i < 3; i++) { const g = mockGrid(`g${i}`); scene.add(g); desk.lock(`g${i}`, g, { immediate: true }); }
    desk.layoutPanes('even');
    // A saved stack already names `gx-later` (an agent screen not attached yet).
    desk.panes.tiles.stacks.get(desk.panes.tiles.panes()[1]).ids.push('gx-later');
    const snap = () => new Map(desk.paneRects().map((p) => [p.id, JSON.stringify(p.rect)]));
    const steps = [];
    const arrive = (id, opts) => { const g = mockGrid(id); scene.add(g); const prev = snap(); desk.lock(id, g, opts); steps.push({ id, held: unmoved(prev, snap()) && snap().size === prev.size }); };
    arrive('join:g3', { immediate: true });
    arrive('open:/w/x.js', {});
    arrive('gx-later', { immediate: true });
    return { desk, steps };
}
{
    const { desk, steps } = deskRun(PaneLayout);
    for (const s of steps) ok(s.held, `desk: ${s.id} changes no pane's rect (zero tolerance)`);
    ok(desk.paneOf('gx-later') === desk.panes.tiles.panes()[1], 'an attach the saved stack held a place for lands in that place');
    ok(desk.paneOf('join:g3') === desk.panes.tiles.inbox && desk.paneOf('open:/w/x.js') === desk.panes.tiles.inbox, 'a join and an open land in the inbox');
    const T = deskRun(SplitOnJoin);
    ok(T.steps.some((s) => !s.held), `teeth: the desk on split-on-join moves panes (${T.steps.map((s) => `${s.id}:${s.held}`).join(' ')})`);
}

console.log(`${fails ? 'FAIL' : 'ok'} pane-layout: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
