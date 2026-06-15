// term-geom-persist-check.mjs — Slice 1 of the state-consolidation migration, on the direct-state
// load path. Terminal geometry (cols/rows + position) is INTENT that lives in the WorkspaceModel
// surface table (appState.surfaces). Verbs write it; SessionStore.capture serializes it; restore
// loads it; _projectSurfaces() pushes it onto each terminal grid as the PTY re-adopts — by calling
// the grid's own applyView(view) DIRECTLY (no terminal.resize/move verb replay), idempotently, in
// ANY order. The relay PTY is re-synced over the wsbridge by the projector (the grid can't reach
// it). This dissolved the "terminal re-adopts at 80×24 mid-restore and the size is lost" race class.
// SessionStore/WorkspaceModel are import-free, so this needs no browser/relay.
//
//   bun tools/term-geom-persist-check.mjs

import SessionStore from '../app/client/SessionStore.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// ---- mocks: a STATEFUL registry (grids persist + mutate via applyView, so idempotency is real) ----
// Mock grid mirrors TerminalGrid.applyView: sets LOCAL geometry, returns what changed.
function makeGrid(cols, rows, pos = { x: 0, y: 0, z: 0 }) {
  return {
    cols, rows, position: { ...pos }, _views: [],
    applyView(view, opts = {}) {
      this._views.push({ view, opts });
      const v = view || {}; let moved = false; let resized = null;
      const p = v.position;
      if (!opts.skipPosition && p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
          && (this.position.x !== p.x || this.position.y !== p.y || this.position.z !== p.z)) {
        this.position = { x: p.x, y: p.y, z: p.z }; moved = true;
      }
      if (Number.isInteger(v.cols) && Number.isInteger(v.rows) && (this.cols !== v.cols || this.rows !== v.rows)) {
        this.cols = v.cols; this.rows = v.rows; resized = { cols: v.cols, rows: v.rows };
      }
      return { moved, resized };
    },
  };
}
function makeRegistry() {
  const grids = new Map();
  return {
    grids,
    add(id, grid) { grids.set(id, grid); },
    has: (id) => grids.has(id),
    get: (id) => (grids.has(id) ? { id, grid: grids.get(id), meta: { owner: `owner-${id}` } } : null),
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
    // The projector pushes a PTY resize over this whenever applyView resizes a terminal.
    wsbridge: { connected: true, _pushes: [], push(owner, msg) { this._pushes.push({ owner, msg }); } },
  };
}
function makeStore(ctx, calls) {
  // Router just RECORDS commands now — the projector no longer replays terminal.resize/move; it
  // drives grid.applyView directly (the live grid mutates itself) and pushes the PTY resize.
  const router = { execute(cmd) { calls.push(cmd); return Promise.resolve({ text: 'OK' }); } };
  return new SessionStore({ ctx, router, bridge: { rpcRequest: async () => ({}) } });
}
const ptyResizes = (ctx, id) => ctx.wsbridge._pushes.filter((p) => p.msg?.event === 'terminal.resize' && p.msg?.data?.terminalId === id);
const noGeomVerb = (calls, id) => !calls.some((c) => String(c).startsWith(`terminal.resize ${id}`) || String(c).startsWith(`terminal.move ${id}`));

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

// ---- 2. normal reload: restore loads the model; applyView sizes the terminal when it re-adopts ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  const ctx = makeCtx(reg, wm);
  const calls = [];
  const ss = makeStore(ctx, calls);
  await ss.restore({ version: 2, files: [], camera: null,
    terminals: [{ id: 'term-2', x: 1, y: 2, z: 3, cols: 121, rows: 122 }] });
  ok(ptyResizes(ctx, 'term-2').length === 0, 'restore: NO PTY resize before re-adopt (terminal absent from the registry)');
  ok(wm.getSurface('term-2')?.view.cols === 121, 'restore: intent held in the model, awaiting the live grid');
  // the adapter re-adopts the shell at its startup default 80×24
  reg.add('term-2', makeGrid(80, 24));
  ss._projectSurfaces(); // what the registry-change listener fires
  ok(reg.get('term-2').grid.cols === 121, 're-adopt: applyView sized the live grid (80×24 → 121×122)');
  ok(reg.get('term-2').grid.position.x === 1, 're-adopt: applyView moved it to the saved home');
  ok(ptyResizes(ctx, 'term-2').some((p) => p.msg.data.cols === 121 && p.msg.data.rows === 122), 're-adopt: PTY re-synced over the bridge');
  ok(noGeomVerb(calls, 'term-2'), 're-adopt: NO terminal.resize/move verb replay (direct state only)');
}

// ---- 3. ORDER-FUZZ: terminal already present (re-adopted DURING restore) — still converges ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  reg.add('term-3', makeGrid(80, 24)); // present before restore even loads the intent
  const ctx = makeCtx(reg, wm);
  const calls = [];
  const ss = makeStore(ctx, calls);
  await ss.restore({ version: 2, files: [], camera: null,
    terminals: [{ id: 'term-3', x: 0, y: 0, z: 0, cols: 100, rows: 50 }] });
  // end-of-restore _projectSurfaces sees term-3 already live → sizes it in the same pass
  ok(reg.get('term-3').grid.cols === 100, 'mid-restore re-adopt: applyView sized it (order-independent)');
  ok(ptyResizes(ctx, 'term-3').some((p) => p.msg.data.cols === 100), 'mid-restore re-adopt: PTY re-synced by the end-of-restore project');
}

// ---- 4. applyView is idempotent and the model is NOT consumed ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  reg.add('term-4', makeGrid(80, 24));
  const ctx = makeCtx(reg, wm);
  const calls = [];
  const ss = makeStore(ctx, calls);
  wm.setSurfaceView('term-4', 'terminal', { cols: 90, rows: 30, position: { x: 0, y: 0, z: 0 } });
  ss._projectSurfaces();                           // converges the grid to 90×30
  ss._projectSurfaces();                           // already converged → applyView returns resized:null
  ok(ptyResizes(ctx, 'term-4').length === 1, 'idempotent: ONE PTY resize, none once converged');
  ok(reg.get('term-4').grid.cols === 90, 'grid converged to intent');
  ok(wm.getSurface('term-4')?.view.cols === 90, 'model retained (not consumed) after apply');
}

// ---- 5. a docked terminal is NOT re-moved by applyView (dock owns its transform) ----
{
  const wm = new WorkspaceModel();
  const reg = makeRegistry();
  reg.add('term-5', makeGrid(80, 24, { x: 0, y: 0, z: 0 })); // tile-local position while docked
  const ctx = makeCtx(reg, wm);
  ctx.cameraDock.has = (id) => id === 'term-5'; // term-5 is docked
  const calls = [];
  const ss = makeStore(ctx, calls);
  wm.setSurfaceView('term-5', 'terminal', { cols: 110, rows: 44, position: { x: 99, y: 99, z: 99 } });
  ss._projectSurfaces();
  ok(reg.get('term-5').grid.position.x === 0, 'docked: applyView did NOT move the tile (skipPosition — dock owns position)');
  ok(reg.get('term-5').grid.cols === 110, 'docked: applyView STILL sized it (resize is dock-independent)');
  ok(ptyResizes(ctx, 'term-5').some((p) => p.msg.data.cols === 110), 'docked: PTY re-synced');
}

console.log(failures === 0 ? '\nPASS — terminal geometry round-trips via the model + applyView()' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
