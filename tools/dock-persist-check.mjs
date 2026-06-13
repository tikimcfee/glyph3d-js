// dock-persist-check.mjs — deterministic round-trip of SessionStore's 3D camera-dock
// persistence (dock3d), with mocks. SessionStore is import-free, so this needs no
// browser/relay. Verifies: capture writes ordered tiles + layout (using HOME positions
// for docked windows), and restore replays dock.lock as surfaces reappear (code grids
// synchronously, terminals via the registry-change path).
//
//   bun tools/dock-persist-check.mjs
//
// Graduated from a one-off probe per the debug-into-tools practice.

import SessionStore from '../app/client/SessionStore.js';

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
    workspace: { listActiveSheets: () => [] },
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

// ---- 1. capture: ordered tiles + layout, HOME position for docked terminal -----
{
  const reg = makeRegistry(new Set(['term-1']));
  const cd = makeCameraDock();
  cd.setLayout('radial'); cd._lock('term-1'); // term-1 is docked
  const ss = new SessionStore({ ctx: makeCtx(reg, cd), router: makeRouter(cd), bridge: {} });
  const snap = ss.capture();
  eq(snap.dock3d, { layout: 'radial', tiles: ['term-1'] }, 'capture: dock3d has layout + ordered tiles');
  const term = snap.terminals.find((t) => t.id === 'term-1');
  eq({ x: term.x, y: term.y, z: term.z }, { x: 100, y: 200, z: 300 },
     'capture: docked terminal persists HOME (100,200,300), not tile-local (1,2,3)');
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
  eq(ss._pendingDock3d, { layout: 'radial', tiles: ['term-1'] }, 'restore: term-1 deferred in _pendingDock3d');

  // ---- 3. terminal re-adopts → registry-change replays its lock ----------------
  reg._ids.add('term-1');
  ss._applyDock3d(); // what _onRegistryChange calls
  ok(router.calls.some((c) => Array.isArray(c) && c[1] === 'term-1'),
     're-adopt: locked term-1 once it reappeared');
  eq(ss._pendingDock3d, null, 're-adopt: pending cleared when all tiles landed');
}

console.log(failures === 0 ? '\nPASS — dock persistence round-trips' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
