// panes-durable.test.mjs — a tiled desk's pane layout is DURABLE: the model's Panes component on
// `carrel:<name>` (app/client/carrelPanes.js), saved as the snapshot's `panes`, restored in stage 1
// before any desk stands up (SessionStore), and laid back over a desk born again — rect for rect.
//
//   bun tools/panes-durable.test.mjs
//
// Locks:
//   - every pane change writes the record (wirePanes → onPanesChanged): a split, a resize, a tab, a
//     zoom, a focus — so a save at any moment holds the layout as it stands
//   - the snapshot's `panes` (JSON) → a fresh model (restorePanes) → a desk born under the same
//     name (wirePanes) → its members arriving one by one land in their saved stacks; once all are
//     back, every pane rect, stack, active tab, focus, zoom and inbox equals the saved desk's
//   - a member that never comes back holds its place in its stack; a malformed record is refused
//     loudly and the desk lays out fresh
//   - stage 1: SessionStore restores panes after tunings and before the desks (teeth: restoring the
//     desks first loses the layout)

import './headless-canvas.mjs';
import * as THREE from 'three';
import fs from 'node:fs';
import { Carrel } from '../packages/glyph3d-core/src/services/interaction/Carrel.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';
import { wirePanes, listPanes, restorePanes } from '../app/client/carrelPanes.js';

let fails = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.error(`FAIL ${m}`); } };

const CW = 0.725, LS = 1.359375;
const UNIT = { column: CW, cellPx: 8, rowRatio: LS / CW };
function mockGrid(name) {
    const g = new THREE.Object3D();
    g.name = name;
    g.metrics = { charWidth: CW, lineSpacing: LS, charHeight: LS };
    g.pixelOrigin = () => ({ x: 0, y: -0.5 * LS });
    g.getLocalBounds = () => new THREE.Box3(new THREE.Vector3(0, -40, -0.5), new THREE.Vector3(60, 0, 0.5));
    return g;
}
function newDesk(ctx, scene) {
    const desk = new Carrel({ name: 'team', mode: 'plane', planeArrange: 'tiles', tileCols: 239, tileRows: 56, animDur: 0 });
    scene.add(desk);
    desk.setPlaneUnit(UNIT);
    wirePanes(ctx, desk);
    return desk;
}
const state = (d) => JSON.stringify({
    rects: d.paneRects().map((p) => [p.id, p.rect, p.stack, p.active]),
    focus: d.panes.tiles.focus, zoomed: d.panes.tiles.zoomed, inbox: d.panes.tiles.inbox,
});
const IDS = ['a', 'b', 'c', 'd', 'e'];

// ── 1. A desk shaped by hand; every change writes the record.
const ctxA = { workspace: new WorkspaceModel() };
const sceneA = new THREE.Scene();
const A = newDesk(ctxA, sceneA);
for (const id of IDS.slice(0, 4)) { const g = mockGrid(id); sceneA.add(g); A.lock(id, g, { immediate: true }); }
A.layoutPanes('even');
const rec = () => JSON.stringify(ctxA.workspace.getSurface('carrel:team')?.view?.panes ?? null);
let last = rec();
const changed = (what) => { const now = rec(); ok(now !== last, `${what} writes the record`); last = now; };
ok(last !== 'null', 'a named layout writes the record');
A.paneSplit('y', 'b');                         changed('a split');
A.paneResize('x', 0.12);                       changed('a resize');
const e = mockGrid('e'); sceneA.add(e); A.lock('e', e, { immediate: true });   changed('a join');
A.paneFocusOn('e');
A.paneTab('next');                             changed('a tab');
A.paneZoom(true);                              changed('a zoom');
A.paneZoom(false);                             changed('an unzoom');
const saved = state(A);

// ── 2. The snapshot round trip: JSON → fresh model → a desk born again, members arriving late.
{
    const snapPanes = JSON.parse(JSON.stringify(listPanes(ctxA)));
    ok(snapPanes.length === 1 && snapPanes[0].id === 'carrel:team', 'the snapshot lists the desk\'s panes');
    const ctxB = { workspace: new WorkspaceModel() };
    restorePanes(ctxB, snapPanes);              // stage 1: before the desk stands up
    const sceneB = new THREE.Scene();
    const B = newDesk(ctxB, sceneB);            // born: reads its record first
    const arrive = (id) => { const g = mockGrid(id); sceneB.add(g); B.lock(id, g, { immediate: true }); };
    // Members arrive in a different order than they were seated.
    for (const id of ['e', 'c', 'a', 'd', 'b']) arrive(id);
    ok(state(B) === saved, `the born-again desk equals the saved one, rect for rect\n  saved ${saved}\n  got   ${state(B)}`);
    ok(B.paneOf('e') === A.paneOf('e') && B.paneFront(B.paneOf('e')) === A.paneFront(A.paneOf('e')), 'a late member lands in its saved stack, its saved tab active');

    // A member that never comes back holds its place.
    const ctxC = { workspace: new WorkspaceModel() };
    restorePanes(ctxC, snapPanes);
    const C = newDesk(ctxC, new THREE.Scene());
    for (const id of ['a', 'c', 'd', 'e']) { const g = mockGrid(id); C.parent.add(g); C.lock(id, g, { immediate: true }); }
    ok(C.panes.tiles.stacks.get(A.paneOf('b')).ids.includes('b'), 'a member not back yet keeps its place in its stack');
    ok(JSON.stringify(C.paneRects().map((p) => p.rect)) === JSON.stringify(A.paneRects().map((p) => p.rect)), 'and every rect is as saved');
}

// ── 3. A malformed record is refused loudly; the desk lays out fresh.
{
    const ctxD = { workspace: new WorkspaceModel() };
    const warns = [];
    const warn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    restorePanes(ctxD, [{ id: 'carrel:team', panes: { tree: { leaf: 'pane:1' }, stacks: [{ id: 'pane:9', ids: [] }] } }]);
    const D = newDesk(ctxD, new THREE.Scene());
    console.warn = warn;
    ok(warns.some((w) => w.includes('refused')), `a malformed record is refused with a warning (${warns[0]?.slice(0, 80)})`);
    ok(D.panes.tiles.isEmpty(), 'and the desk stands up fresh');
}

// ── 4. Stage 1 order: tunings → panes → desks (SessionStore).
{
    const src = fs.readFileSync(new URL('../app/client/SessionStore.js', import.meta.url), 'utf8');
    const i = src.indexOf('this._restoreTunings(snap);'), j = src.indexOf('restorePanes(this.ctx, snap.panes);'), k = src.indexOf('this._restoreCarrels(snap);');
    ok(i > 0 && j > i && k > j, 'stage 1 restores tunings, then panes, then the desks');
    // Teeth: a desk standing up BEFORE its record is in the model lays out fresh (loses the layout).
    const ctxE = { workspace: new WorkspaceModel() };
    const E = newDesk(ctxE, new THREE.Scene());
    for (const id of IDS) { const g = mockGrid(id); E.parent.add(g); E.lock(id, g, { immediate: true }); }
    ok(state(E) !== saved, 'teeth: a desk born before its record does not have the saved layout');
}

console.log(`${fails ? 'FAIL' : 'ok'} panes-durable: ${checks - fails}/${checks} checks`);
process.exit(fails ? 1 : 0);
