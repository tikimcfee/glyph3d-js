// dock-persist-check.mjs — deterministic round-trip of SessionStore's 3D camera-dock
// persistence (dock3d), with mocks. SessionStore is import-free, so this needs no
// browser/relay. Verifies: capture writes ordered tiles + layout (using HOME positions
// for docked windows), and restore replays dock.lock as surfaces reappear (code grids
// synchronously, terminals via the registry-change path).
//
//   bun tools/dock-persist-check.mjs
//
// Graduated from a one-off probe per the debug-into-tools practice.

import SessionStore, { positionIsDerived } from '../app/client/SessionStore.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`);

// ---- mocks ----------------------------------------------------------------
function makeRegistry(ids = new Set()) {
  return {
    _ids: ids,
    has: (id) => ids.has(id),
    get: (id) => ids.has(id) ? { id, grid: { position: { x: 0, y: 0, z: 0 }, cols: 80, rows: 24 } } : null,
    findByType: (t) => t === 'terminal'
      ? [...ids].filter((i) => i.startsWith('term-')).map((id) => ({ id, grid: { position: { x: 1, y: 2, z: 3 }, cols: 80, rows: 24 } }))
      : [],
    addChangeListener() {}, removeChangeListener() {},
  };
}
// CameraDock stub: records locks, reports membership/home/layout like the real one.
function makeCameraDock() {
  const tiles = []; // {id, slot}
  return {
    layoutMode: 'linear',
    _set: new Set(),
    has(id) { return this._set.has(id); },
    list() { return tiles.map((t, i) => ({ id: t.id, slot: i, layout: this.layoutMode })); },
    homePosition(id) { return this._set.has(id) ? { x: 100, y: 200, z: 300 } : null; },
    setLayout(m) { this.layoutMode = m; return true; },
    _lock(id) { if (!this._set.has(id)) { this._set.add(id); tiles.push({ id }); } },
  };
}
function makeCtx(registry, cameraDock) {
  return {
    registry, cameraDock,
    camera: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, fov: 70 },
    cameraController: { cameraSpeed: 100 },
    workspace: new WorkspaceModel(),  // real model — terminal geometry intent lives here now
    fileProvider: { _currentRepo: null },
    fieldSource: null,
    status: { set() {}, clear() {} },
  };
}
function makeRouter(cameraDock) {
  const calls = [];
  return {
    calls,
    execute(cmd) {
      calls.push(cmd);
      // Emulate dock.lock landing the tile (array form: ['dock.lock', id]).
      if (Array.isArray(cmd) && cmd[0] === 'dock.lock') cameraDock._lock(cmd[1]);
      return Promise.resolve({ text: 'OK' });
    },
  };
}

// ---- 1. capture: ordered dock tiles + layout; terminal geometry from the MODEL -----
{
  const reg = makeRegistry(new Set(['term-1']));
  const cd = makeCameraDock();
  cd.setLayout('radial'); cd._lock('term-1'); // term-1 is docked
  const ctx = makeCtx(reg, cd);
  // The model holds the terminal's HOME (the verb wrote it pre-dock); capture serializes THAT,
  // not a live-grid scrape — so a docked tile's saved position is its world home, not tile-local.
  ctx.workspace.setSurfaceView('term-1', 'terminal', { position: { x: 100, y: 200, z: 300 }, cols: 80, rows: 24 });
  const ss = new SessionStore({ ctx, router: makeRouter(cd), bridge: {} });
  const snap = ss.capture();
  eq(snap.dock3d, { layout: 'radial', tiles: [{ id: 'term-1', zoom: 1 }] }, 'capture: dock3d has layout + ordered tiles (id+zoom)');
  const term = snap.terminals.find((t) => t.id === 'term-1');
  eq({ x: term.x, y: term.y, z: term.z }, { x: 100, y: 200, z: 300 },
     'capture: terminal HOME comes from the model (100,200,300)');
}

// ---- 2. restore: lock present surfaces now, defer absent ones ------------------
{
  const reg = makeRegistry(new Set(['a.js']));        // code grid back; term-1 not yet
  const cd = makeCameraDock();
  const router = makeRouter(cd);
  const ss = new SessionStore({ ctx: makeCtx(reg, cd), router, bridge: {} });
  await ss.restore({ version: 2, files: [], camera: null, terminals: [],
                     dock3d: { layout: 'radial', tiles: ['a.js', 'term-1'] } });
  ok(router.calls.some((c) => Array.isArray(c) && c[0] === 'dock.lock' && c[1] === 'a.js'),
     'restore: locked the present code grid a.js');
  ok(!router.calls.some((c) => Array.isArray(c) && c[1] === 'term-1'),
     'restore: did NOT lock the absent terminal yet');
  eq(cd.layoutMode, 'radial', 'restore: applied saved layout mode');
  // term-1 is index 1 in the saved array → carries order:1 so it locks into its saved slot when it
  // re-adopts (even if it comes back before/after other deferred tiles).
  eq(ss._pendingDock3d, { layout: 'radial', tiles: [{ id: 'term-1', zoom: 1, order: 1 }] }, 'restore: term-1 deferred in _pendingDock3d (with saved order)');

  // ---- 3. terminal re-adopts → registry-change replays its lock ----------------
  reg._ids.add('term-1');
  ss._applyDock3d(); // what _onRegistryChange → _projectSurfaces calls
  ok(router.calls.some((c) => Array.isArray(c) && c[1] === 'term-1'),
     're-adopt: locked term-1 once it reappeared');
  eq(ss._pendingDock3d, null, 're-adopt: pending cleared when all tiles landed');
}

// ---- 4. terminal geometry reconciles from the MODEL when it re-adopts mid-restore ----
// The bug this guards (now fixed structurally): a terminal that re-created mid-restore stuck at
// the adapter's spawn 80×24 because restore reconciled dock+zoom but not size. Now restore loads
// the geometry into the model and end-of-restore apply() pushes it; the model is the durable
// buffer (NOT consumed). See tools/term-geom-persist-check.mjs for the full order-fuzzed coverage.
{
  const reg = makeRegistry(new Set(['term-9'])); // term-9 re-adopted mid-restore, at 80×24
  const cd = makeCameraDock();
  const router = makeRouter(cd);
  const ctx = makeCtx(reg, cd);
  const ss = new SessionStore({ ctx, router, bridge: {} });
  await ss.restore({
    version: 2, files: [], camera: null, dock3d: null,
    terminals: [{ id: 'term-9', x: 10, y: 20, z: 30, cols: 121, rows: 122 }],
  });
  ok(router.calls.includes('terminal.resize term-9 121 122'),
     'restore: resized a terminal that re-adopted mid-restore (80×24 → 121×122)');
  ok(router.calls.includes('terminal.move term-9 10 20 30'),
     'restore: moved that terminal to its saved home');
  eq(ctx.workspace.getSurface('term-9')?.view.cols, 121, 'restore: model retains the terminal intent (not consumed)');
}

// ---- 5. positionIsDerived discriminator: a tree-laid grid's position is derived (never
// stored/projected); terminals + loose grids + captures are stored intent. The one subtle helper
// Slice 3's code-grid projector hangs on, tested in isolation here. ----
{
  const treeCtx = { contentTree: { has: (id) => id === 'src/a.js' } };
  ok(positionIsDerived(treeCtx, 'src/a.js') === true, 'positionIsDerived: tree leaf → derived (omit)');
  ok(positionIsDerived(treeCtx, 'term-1') === false, 'positionIsDerived: terminal → stored intent');
  ok(positionIsDerived(treeCtx, 'screen-1') === false, 'positionIsDerived: capture → stored intent');
  ok(positionIsDerived({}, 'x') === false, 'positionIsDerived: no tree → stored');
}

console.log(failures === 0 ? '\nPASS — dock persistence round-trips' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
