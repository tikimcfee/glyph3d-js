// term-geom-persist-check.mjs — Slice 1 of the state-consolidation migration.
// Terminal geometry (cols/rows + position) is INTENT that lives in the WorkspaceModel surface
// table (appState.surfaces). Verbs write it; SessionStore.capture serializes it; restore loads it;
// apply() (SessionStore._applyTerminalViews / _reconcileSurfaces) pushes it onto each terminal grid
// as the PTY re-adopts — idempotently, in ANY order. This replaced pendingTerminals + the live-grid
// scrape, dissolving the "terminal re-adopts at 80×24 mid-restore and the size is lost" race class.
// SessionStore/WorkspaceModel are import-free, so this needs no browser/relay.
//
//   bun tools/term-geom-persist-check.mjs

import SessionStore from '../app/client/SessionStore.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// ---- mocks: a STATEFUL registry (grids persist + mutate, so idempotency is real) ----
function makeGrid(cols, rows, pos = { x: 0, y: 0, z: 0 }) { return { cols, rows, position: { ...pos } }; }
function makeRegistry() {
  const grids = new Map();
  return {
    grids,
    add(id, grid) { grids.set(id, grid); },
    has: (id) => grids.has(id),
    get: (id) => (grids.has(id) ? { id, grid: grids.get(id) } : null),
    findByType: () => [], addChangeListener() {}, removeChangeListener() {},
  };
}
function makeCtx(registry, workspace) {
  return {
    registry, workspace,
    camera: null, cameraController: null,
    cameraDock: { has: () => false, list: () => [], layoutMode: 'linear' },
    status: { set() {}, clear() {} },
    fileProvider: { _currentRepo: null, stat: async () => { throw new Error('absent'); } },
  };
}
function makeStore(ctx, calls) {
  // Router records commands AND emulates the real terminal.resize/move handlers mutating the live
  // grid — so guards (grid.cols !== view.cols) and idempotency behave as in the app.
  const router = {
    execute(cmd) {
      calls.push(cmd);
      if (typeof cmd === 'string') {
        const [verb, id, a, b, c] = cmd.split(' ');
        const g = ctx.registry.get(id)?.grid;
        if (g && verb === 'terminal.resize') { g.cols = +a; g.rows = +b; }
        if (g && verb === 'terminal.move') { g.position = { x: +a, y: +b, z: +c }; }
      }
      return Promise.resolve({ text: 'OK' });
    },
  };
  return new SessionStore({ ctx, router, bridge: { rpcRequest: async () => ({}) } });
}
const resizeCalls = (calls, id) => calls.filter((c) => String(c).startsWith(`terminal.resize ${id} `));

// ---- 1. capture serializes the model's terminal view-intent (not a live-grid scrape) ----
{
  const wm = new WorkspaceModel();
  wm.setSurfaceView('term-1', 'terminal', { cols: 100, rows: 40, position: { x: 5, y: 6, z: 7 } });
  const ss = makeStore(makeCtx(makeRegistry(), wm), []);
  const snap = ss.capture();
  const t = snap.terminals.find((x) => x.id === 'term-1');
  ok(t && t.cols === 100 && t.rows === 40, 'capture: terminal cols/rows from the model');
  ok(t && t.x === 5 && t.y === 6 && t.z === 7, 'capture: terminal position from the model');
}

// ---- 2. normal reload: restore loads the model; apply sizes the terminal when it re-adopts ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  const calls = [];
  const ss = makeStore(makeCtx(reg, wm), calls);
  await ss.restore({ version: 2, files: [], camera: null,
    terminals: [{ id: 'term-2', x: 1, y: 2, z: 3, cols: 121, rows: 122 }] });
  ok(resizeCalls(calls, 'term-2').length === 0, 'restore: NO resize before re-adopt (terminal absent from the registry)');
  ok(wm.getSurface('term-2')?.view.cols === 121, 'restore: intent held in the model, awaiting the live grid');
  // the adapter re-adopts the shell at its startup default 80×24
  reg.add('term-2', makeGrid(80, 24));
  ss._reconcileSurfaces(); // what the registry-change listener fires
  ok(calls.includes('terminal.resize term-2 121 122'), 're-adopt: sized to intent (80×24 → 121×122)');
  ok(calls.includes('terminal.move term-2 1 2 3'), 're-adopt: moved to the saved home');
  ok(reg.get('term-2').grid.cols === 121, 're-adopt: the live grid now matches intent');
}

// ---- 3. ORDER-FUZZ: terminal already present (re-adopted DURING restore) — still converges ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  reg.add('term-3', makeGrid(80, 24)); // present before restore even loads the intent
  const calls = [];
  const ss = makeStore(makeCtx(reg, wm), calls);
  await ss.restore({ version: 2, files: [], camera: null,
    terminals: [{ id: 'term-3', x: 0, y: 0, z: 0, cols: 100, rows: 50 }] });
  // end-of-restore _reconcileSurfaces sees term-3 already live → sizes it in the same pass
  ok(calls.includes('terminal.resize term-3 100 50'), 'mid-restore re-adopt: sized by the end-of-restore reconcile');
  ok(reg.get('term-3').grid.cols === 100, 'mid-restore re-adopt: the live grid matches intent (order-independent)');
}

// ---- 4. apply is idempotent and the model is NOT consumed ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  reg.add('term-4', makeGrid(80, 24));
  const calls = [];
  const ss = makeStore(makeCtx(reg, wm), calls);
  wm.setSurfaceView('term-4', 'terminal', { cols: 90, rows: 30, position: { x: 0, y: 0, z: 0 } });
  ss._reconcileSurfaces();                         // converges the grid to 90×30
  ss._reconcileSurfaces();                         // already converged → must be a no-op
  ok(resizeCalls(calls, 'term-4').length === 1, 'apply is idempotent: one resize, none once converged');
  ok(wm.getSurface('term-4')?.view.cols === 90, 'model retained (not consumed) after apply');
}

// ---- 5. a docked terminal is NOT re-moved by apply (dock owns its transform) ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  reg.add('term-5', makeGrid(80, 24, { x: 0, y: 0, z: 0 })); // tile-local position while docked
  const ctx = makeCtx(reg, wm);
  ctx.cameraDock.has = (id) => id === 'term-5'; // term-5 is docked
  const calls = [];
  const ss = makeStore(ctx, calls);
  wm.setSurfaceView('term-5', 'terminal', { cols: 110, rows: 44, position: { x: 99, y: 99, z: 99 } });
  ss._reconcileSurfaces();
  ok(!calls.some((c) => String(c).startsWith('terminal.move term-5')), 'docked: apply does NOT move the tile (dock owns position)');
  ok(calls.includes('terminal.resize term-5 110 44'), 'docked: apply STILL sizes it (resize is dock-independent)');
}

console.log(failures === 0 ? '\nPASS — terminal geometry round-trips via the model + apply()' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
