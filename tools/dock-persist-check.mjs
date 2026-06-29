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
// Mock terminal grid: mirrors TerminalGrid.applyView (local geometry only; records calls + returns
// what changed) so the projector's direct-state contract is exercised without a real GPU grid.
function makeTermGrid() {
  return {
    position: { x: 0, y: 0, z: 0 }, cols: 80, rows: 24, _views: [],
    applyView(view, opts = {}) {
      this._views.push({ view, opts });
      const v = view || {}; let moved = false, resized = null;
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
function makeRegistry(ids = new Set()) {
  const grids = new Map();                                       // stable grid per id (mutations persist)
  const gridFor = (id) => { if (!grids.has(id)) grids.set(id, makeTermGrid()); return grids.get(id); };
  return {
    _ids: ids, _grids: grids,
    has: (id) => ids.has(id),
    get: (id) => ids.has(id) ? { id, grid: gridFor(id), meta: { owner: `owner-${id}` } } : null,
    findByType: (t) => t === 'terminal'
      ? [...ids].filter((i) => i.startsWith('term-')).map((id) => ({ id, grid: gridFor(id) }))
      : [],
    addChangeListener() {}, removeChangeListener() {},
  };
}
// CameraDock stub: the PROJECTION. lock(id,grid,{order}) is the real method the reconcile calls
// DIRECTLY (no dock.lock verb); records each lock so tests can assert membership + order.
function makeCameraDock() {
  const entries = new Map(); // id -> { id, order }
  return {
    layoutMode: 'linear',
    _locks: [],
    has(id) { return entries.has(id); },
    lock(id, grid, opts = {}) { entries.set(id, { id, order: opts.order ?? 0 }); this._locks.push({ id, order: opts.order, grid }); return true; },
    release(id) { entries.delete(id); },
    releaseAll() { entries.clear(); },
    reflowTile() {},
    list() { return [...entries.values()].sort((a, b) => a.order - b.order).map((e, i) => ({ id: e.id, slot: i })); },
    homePosition() { return null; },
    setLayout(m) { this.layoutMode = m; return true; },
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
    // wsbridge: the projector pushes a PTY resize over this when applyView resizes a terminal.
    wsbridge: { connected: true, _pushes: [], push(owner, msg) { this._pushes.push({ owner, msg }); } },
  };
}
function makeRouter() {
  const calls = [];
  return { calls, execute(cmd) { calls.push(cmd); return Promise.resolve({ text: 'OK' }); } };
}

// ---- 1. capture: dock3d read from the MODEL (membership/order/zoom), layout + frame occupant from the live dock --
{
  const reg = makeRegistry(new Set(['term-1']));
  const cd = makeCameraDock();
  cd.setLayout('radial');
  const ctx = makeCtx(reg, cd);
  // The MODEL owns dock membership + the terminal's geometry. capture serializes THAT (not a
  // live-dock scrape) — so a docked tile round-trips even while its grid is mid-re-adopt.
  ctx.workspace.setSurfaceView('term-1', 'terminal',
    { docked: true, dockOrder: 0, zoom: 1.5, position: { x: 100, y: 200, z: 300 }, cols: 80, rows: 24 });
  const snap = new SessionStore({ ctx, router: makeRouter(), bridge: {} }).capture();
  eq(snap.dock3d, { layout: 'radial', tiles: [{ id: 'term-1', zoom: 1.5 }], focused: null },
     'capture: dock3d from model.listDocked (zoom from the model, layout + frame occupant from the live dock)');
  const term = snap.terminals.find((t) => t.id === 'term-1');
  eq({ x: term.x, y: term.y, z: term.z }, { x: 100, y: 200, z: 300 },
     'capture: terminal HOME comes from the model (100,200,300)');
}

// ---- 2. restore: dock intent → the MODEL; reconcile locks LIVE tiles directly, defers absent ones --
{
  const reg = makeRegistry(new Set(['a.js']));        // code grid back; term-1 not yet
  const cd = makeCameraDock();
  const router = makeRouter();
  const ctx = makeCtx(reg, cd);
  const ss = new SessionStore({ ctx, router, bridge: {} });
  await ss.restore({ version: 2, files: [], camera: null, terminals: [],
                     dock3d: { layout: 'radial', tiles: [{ id: 'a.js', zoom: 1 }, { id: 'term-1', zoom: 1 }] } });
  ok(ctx.workspace.getSurface('a.js')?.view.docked === true, 'restore: a.js docked in the MODEL');
  ok(ctx.workspace.getSurface('term-1')?.view.docked === true, 'restore: term-1 docked in the MODEL (durable buffer, grid absent)');
  eq(ctx.workspace.getSurface('term-1')?.view.dockOrder, 1, 'restore: term-1 keeps its saved slot order (index 1)');
  ok(cd.has('a.js'), 'reconcile: locked the present grid a.js DIRECTLY');
  ok(!cd.has('term-1'), 'reconcile: did NOT lock the absent terminal yet');
  ok(!router.calls.some((c) => (Array.isArray(c) ? c[0] : String(c)).startsWith?.('dock.lock') || (Array.isArray(c) && c[0] === 'dock.lock')),
     'restore: NO dock.lock verb replay (direct cd.lock only)');
  eq(cd.layoutMode, 'radial', 'restore: applied saved layout directly onto the dock');

  // ---- 3. terminal re-adopts → registry-change reconcile locks it from the MODEL ----------------
  reg._ids.add('term-1');
  ss._projectSurfaces(); // what _onRegistryChange fires
  ok(cd.has('term-1'), 're-adopt: reconcile locked term-1 once it reappeared (model-driven)');
  eq(cd._locks.find((l) => l.id === 'term-1')?.order, 1, 're-adopt: term-1 locked into its saved slot order');
}

// ---- 4. terminal geometry projects DIRECTLY via grid.applyView when it re-adopts mid-restore ----
// The bug this guards: a terminal re-created mid-restore stuck at the adapter's spawn 80×24 because
// restore reconciled dock+zoom but not size. Now restore loads the geometry into the model and
// end-of-restore _projectSurfaces() pushes it onto the grid via applyView — DIRECT state, NOT a
// terminal.resize/move verb replay — then re-syncs the external PTY over the bridge. The model is
// the durable buffer (NOT consumed). See tools/term-geom-persist-check.mjs for order-fuzzed coverage.
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
  const grid = reg.get('term-9').grid;
  eq({ cols: grid.cols, rows: grid.rows }, { cols: 121, rows: 122 }, 'restore: applyView resized the grid (80×24 → 121×122)');
  eq(grid.position, { x: 10, y: 20, z: 30 }, 'restore: applyView moved the grid to its saved home');
  ok(!router.calls.some((c) => typeof c === 'string' && (c.startsWith('terminal.resize') || c.startsWith('terminal.move'))),
     'restore: NO terminal.resize/move verb replay (direct state only)');
  ok(ctx.wsbridge._pushes.some((p) => p.msg?.data?.terminalId === 'term-9' && p.msg.data.cols === 121 && p.msg.data.rows === 122),
     'restore: PTY re-synced over the bridge (SIGWINCH match)');
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

// ---- 6. field layout scheme round-trips as DIRECT STATE: capture reads the tree's layout state
// synchronously (NOT an async bus round-trip — that was the bug that silently saved no scheme);
// restore SETS it straight back onto the tree via applyLayoutState. No verb replay. ----
{
  // Stub mirroring ContentTree.getLayoutState/applyLayoutState (sync data in / sync data out).
  const makeTree = (init = null) => {
    let state = init;
    return { getLayoutState: () => state, applyLayoutState: (s) => { state = s; return true; }, _state: () => state };
  };
  const capCtx = makeCtx(makeRegistry(), makeCameraDock());
  capCtx.contentTree = makeTree({ scheme: 'jellyfish', opts: { hang: 5, fileGap: 2 } });
  const snap = new SessionStore({ ctx: capCtx, router: makeRouter(makeCameraDock()), bridge: {} }).capture();
  eq(snap.layout, { scheme: 'jellyfish', opts: { hang: 5, fileGap: 2 } }, 'capture: field layout read DIRECTLY from the tree (sync)');

  const resCtx = makeCtx(makeRegistry(), makeCameraDock());
  resCtx.contentTree = makeTree(null);
  await new SessionStore({ ctx: resCtx, router: makeRouter(makeCameraDock()), bridge: {} })
    .restore({ version: 2, files: [], field: null, layout: { scheme: 'jellyfish', opts: { hang: 5, fileGap: 2 } } });
  eq(resCtx.contentTree._state(), { scheme: 'jellyfish', opts: { hang: 5, fileGap: 2 } },
     'restore: applied layout state DIRECTLY onto the tree (no verb)');
}

// ---- 7. camera round-trips as DIRECT STATE: capture reads the controller's getState() (pose +
// speed, no forward/target reconstruction); restore SETS it back via applyState() — NO camera.move/
// camera.aim verb replay (that fired async and fought the field-restore fly). Plus the save trigger:
// arming autosave hangs onMoved on the controller, disposing clears it. ----
{
  // Stub mirroring ViewerCameraController.getState/applyState (the persisted slice = pose + speed).
  const makeCamCtl = (init = null) => {
    let state = init;
    return {
      onMoved: null,
      getState: () => state,
      applyState: (s) => { state = s ? { pos: { ...s.pos }, pitch: s.pitch, yaw: s.yaw, speed: s.speed } : state; },
      _state: () => state,
    };
  };

  const pose = { pos: { x: 12, y: 34, z: 56 }, pitch: 0.5, yaw: -1.25, speed: 80 };

  const capCtx = makeCtx(makeRegistry(), makeCameraDock());
  capCtx.cameraController = makeCamCtl(pose);
  const snap = new SessionStore({ ctx: capCtx, router: makeRouter(makeCameraDock()), bridge: {} }).capture();
  eq(snap.camera, { pos: { x: 12, y: 34, z: 56 }, pitch: 0.5, yaw: -1.25, speed: 80 },
     'capture: camera read DIRECTLY from the controller (pose + speed, no target)');

  const resCtx = makeCtx(makeRegistry(), makeCameraDock());
  resCtx.cameraController = makeCamCtl(null);
  const router = makeRouter(makeCameraDock());
  const ss = new SessionStore({ ctx: resCtx, router, bridge: {} });
  await ss.restore({ version: 2, files: [], camera: pose });
  eq(resCtx.cameraController._state(), { pos: { x: 12, y: 34, z: 56 }, pitch: 0.5, yaw: -1.25, speed: 80 },
     'restore: applied camera state DIRECTLY onto the controller');
  ok(!router.calls.some((c) => typeof c === 'string' && c.startsWith('camera.')),
     'restore: NO camera.move/aim verb replayed (direct state only)');

  // Save trigger: arming wires onMoved → a pose change schedules a save; disposing clears it.
  resCtx.bridge = {};
  ss.bridge = { rpcRequest: () => Promise.resolve() };
  ss._armAutosave();
  ok(typeof resCtx.cameraController.onMoved === 'function', 'arm: onMoved hung on the controller (camera moves trigger save)');
  ss.dispose();
  ok(resCtx.cameraController.onMoved === null, 'dispose: onMoved cleared');
}

// ---- 8. focus round-trips as DIRECT state: capture reads attention.{primary,key} ids; restore
// SETS them straight onto the AttentionManager (its own writer, no verb). Hover is never persisted;
// a stale id self-heals via pruning (not modeled here — that's the registry's job). ----
{
  // Minimal AttentionManager stub: set()/get() over the three slots, resolving entity via registry.
  const makeAttention = () => {
    const state = { primary: null, key: null, hover: null };
    return {
      state,
      set(slot, id, opts) { state[slot] = id ? { id, entity: opts?.registry?.get?.(id) ?? null } : null; },
      get(slot) { return state[slot]; },
    };
  };

  // capture: serialize the live primary + key ids (not hover)
  const capCtx = makeCtx(makeRegistry(new Set(['a.js'])), makeCameraDock());
  capCtx.attentionManager = makeAttention();
  capCtx.attentionManager.set('primary', 'a.js', { registry: capCtx.registry });
  capCtx.attentionManager.set('key', 'term-1', {});
  capCtx.attentionManager.set('hover', 'b.js', {});               // transient — must NOT persist
  const snap = new SessionStore({ ctx: capCtx, router: makeRouter(makeCameraDock()), bridge: {} }).capture();
  eq(snap.focus, { primary: 'a.js', key: 'term-1' }, 'capture: focus = primary + key ids (no hover)');

  // restore: set them straight back onto the AttentionManager (no verb)
  const resCtx = makeCtx(makeRegistry(new Set(['a.js'])), makeCameraDock());
  resCtx.attentionManager = makeAttention();
  const router = makeRouter(makeCameraDock());
  await new SessionStore({ ctx: resCtx, router, bridge: {} })
    .restore({ version: 2, files: [], focus: { primary: 'a.js', key: 'term-1' } });
  ok(resCtx.attentionManager.get('primary')?.id === 'a.js', 'restore: primary set directly on the AttentionManager');
  ok(resCtx.attentionManager.get('key')?.id === 'term-1', 'restore: key set directly');
  ok(!router.calls.some((c) => String(c).startsWith('attention.')), 'restore: NO attention.* verb replay (direct state only)');
}

// ---- 9. field source = ONE decider (ctx.fieldSource), NOT the provider's _currentRepo cache ----
{
  const cap = (mutate) => {
    const ctx = makeCtx(makeRegistry(), makeCameraDock());
    mutate(ctx);
    return new SessionStore({ ctx, router: makeRouter(makeCameraDock()), bridge: {} }).capture();
  };
  const repo = cap((ctx) => {
    ctx.fieldSource = { type: 'repo', ref: 'owner/repo/main' };
    ctx.fileProvider._currentRepo = { owner: 'STALE', repo: 'x', branch: 'y' }; // must be IGNORED
  });
  eq(repo.field, { type: 'repo', ref: 'owner/repo/main' }, 'capture: repo field from ctx.fieldSource (ignores provider _currentRepo)');
  const local = cap((ctx) => { ctx.fieldSource = { type: 'local', dir: 'src' }; });
  eq(local.field, { type: 'local', dir: 'src' }, 'capture: local field from ctx.fieldSource');
  const none = cap((ctx) => {
    ctx.fieldSource = null;
    ctx.fileProvider._currentRepo = { owner: 'lingering', repo: 'r', branch: 'b' }; // cache, not the decider
  });
  ok(none.field === null, 'capture: no fieldSource → field null (the provider cache is NOT the decider)');
}

console.log(failures === 0 ? '\nPASS — dock persistence round-trips' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
