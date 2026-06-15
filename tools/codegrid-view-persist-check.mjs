// codegrid-view-persist-check.mjs — code-grid viewport loads as DIRECT state.
//
// A windowed/framed/scrolled code grid's viewport (window size + firstLine, frameRows, scrollOffset)
// used to restore by REPLAYING grid.window → grid.frame → grid.scroll verbs after file.open. Now the
// grid owns CodeGrid.applyView(view), and restore calls it directly — same shape as terminal/camera/
// scheme. file.open still creates the grid + sheet (materialises the surface from its source); the
// viewport rides on top via applyView. A window SIZE change moves the footprint → restore batches ONE
// tree relayout after all tabs land. SessionStore/WorkspaceModel are import-free; no browser/relay.
//
//   bun tools/codegrid-view-persist-check.mjs

import SessionStore from '../app/client/SessionStore.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}`);

// Mock code grid: records applyView calls; reports `windowed` like the real one (window size change).
function makeCodeGrid() {
  return {
    cols: 80, rows: 24, _views: [],
    async applyView(view) { this._views.push(view); return { windowed: !!view.window }; },
  };
}
function makeRegistry() {
  const grids = new Map();
  return {
    grids,
    add(id, g) { grids.set(id, g); },
    has: (id) => grids.has(id),
    get: (id) => (grids.has(id) ? { id, grid: grids.get(id) } : null),
    findByType: () => [], addChangeListener() {}, removeChangeListener() {},
  };
}
function makeCtx(reg, relayout) {
  return {
    registry: reg, workspace: new WorkspaceModel(),
    camera: null, cameraController: null,
    cameraDock: { has: () => false, list: () => [], layoutMode: 'linear' },
    contentTree: { relayoutAndRest: relayout },
    status: { set() {}, clear() {} },
    fileProvider: { _currentRepo: null, stat: async () => ({}) }, // _fileExists → true
  };
}
function makeStore(ctx, calls, reg) {
  // Router records commands; file.open materialises the grid into the registry (as the real one does).
  const router = {
    execute(cmd) {
      calls.push(cmd);
      if (typeof cmd === 'string' && cmd.startsWith('file.open ')) {
        const path = cmd.split(' ')[1];
        if (!reg.has(path)) reg.add(path, makeCodeGrid());
      }
      return Promise.resolve({ text: 'OK' });
    },
  };
  return new SessionStore({ ctx, router, bridge: {} });
}
const noViewportVerb = (calls) => !calls.some((c) => /^grid\.(window|frame|scroll)\b/.test(String(c)));

// ---- 1. windowed + framed + scrolled → applyView gets the viewport; NO verb replay; ONE relayout ----
{
  const reg = makeRegistry();
  let relayouts = 0;
  const calls = [];
  const ss = makeStore(makeCtx(reg, () => { relayouts++; }), calls, reg);
  await ss.restore({ version: 2, files: [
    { path: 'a.js', x: 1, y: 2, z: 3, window: { cols: 100, rows: 40, firstLine: 5 }, frameRows: 20, scrollOffset: 7 },
  ] });
  const grid = reg.get('a.js').grid;
  ok(grid._views.length === 1, 'restore: applyView called once on the code grid');
  eq(grid._views[0], { window: { cols: 100, rows: 40, firstLine: 5 }, frameRows: 20, scrollOffset: 7 },
     'restore: applyView got the saved viewport');
  ok(calls.some((c) => String(c).startsWith('file.open a.js')), 'restore: file.open created the grid');
  ok(noViewportVerb(calls), 'restore: NO grid.window/frame/scroll verb replay (direct state only)');
  ok(relayouts === 1, 'restore: ONE batched tree relayout for the footprint change');
}

// ---- 2. a file with NO viewport → applyView NOT called (nothing to apply), no relayout ----
{
  const reg = makeRegistry();
  let relayouts = 0;
  const calls = [];
  const ss = makeStore(makeCtx(reg, () => { relayouts++; }), calls, reg);
  await ss.restore({ version: 2, files: [{ path: 'b.js', x: 0, y: 0, z: 0 }] });
  ok(reg.get('b.js').grid._views.length === 0, 'restore: no viewport → applyView not called');
  ok(relayouts === 0, 'restore: no window change → no relayout');
}

// ---- 3. scroll-only (no window) → applyView called, but NOT a footprint change → no relayout ----
{
  const reg = makeRegistry();
  let relayouts = 0;
  const calls = [];
  const ss = makeStore(makeCtx(reg, () => { relayouts++; }), calls, reg);
  await ss.restore({ version: 2, files: [{ path: 'c.js', x: 0, y: 0, z: 0, scrollOffset: 12 }] });
  const grid = reg.get('c.js').grid;
  ok(grid._views.length === 1, 'restore: scroll-only still applies via applyView');
  eq(grid._views[0].scrollOffset, 12, 'restore: scrollOffset passed through');
  ok(relayouts === 0, 'restore: scroll-only (no window) → no tree relayout');
}

console.log(failures === 0 ? '\nPASS — code-grid viewport loads via applyView (no verb replay)' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
