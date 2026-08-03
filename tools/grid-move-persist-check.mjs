// grid-move-persist-check.mjs — movers' law at the move verb.
//
// THE LAW: a verb that moves a window records the destination in the WorkspaceModel. The model is
// the durable buffer — it outlives the live object, so a save landing between the move and the
// reload still carries the operator's intent. `terminal.move` obeys it (terminalCommands.js);
// `window.drop` obeys it (windowCommands.js); `grid.move` — the one verb whose entire job is
// moving — did not, so a dragged code grid's position reached the scene and nothing else. The
// drag path is the same verb: ObjectDragger's pointerup fires `moveVerbFor(type)`, which is
// `grid.move` for a code grid (surfaceInteractions.js).
//
// SCOPE: this asserts the model WRITE, which is what the verb owns. Pushing that fact back onto a
// live grid on reload needs a 'grid' entry in SURFACE_PROJECTORS and one authority for code-grid
// position (today `files[].x/y/z` is a live scrape and `file.open` ignores the x/y/z it is
// handed) — a separate slice. Read the last section for the failure that remains open.
//
//   bun tools/grid-move-persist-check.mjs

// The router's telemetry imports (ErrorTracker) self-install window handlers at
// module scope; a listener-sink window is all they need under bun.
globalThis.window ??= { addEventListener() {} };
const { default: CommandRouter } =
  await import('../packages/glyph3d-core/src/services/orchestration/CommandRouter.js');
const { default: registerGridCommands } = await import('../app/commands/handlers/gridCommands.js');
const { default: WorkspaceModel } = await import('../app/client/WorkspaceModel.js');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const J = (v) => JSON.stringify(v);
const eq = (a, b, m) => { const p = J(a) === J(b); ok(p, p ? m : `${m}\n      got  ${J(a)}\n      want ${J(b)}`); };

// A code grid is a plain Object3D-shaped stand-in: position only. It deliberately has NO
// setWorldPosition — that alias is gone, and a grid that never had it must still move.
function makeGrid(name) {
  return { name, position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } } };
}

function makeCtx() {
  const grids = new Map();
  const workspace = new WorkspaceModel();
  const saves = [];
  const registry = {
    add(id, grid, type = 'grid') { grids.set(id, { id, grid, type, role: null, meta: {} }); },
    get: (id) => grids.get(id) || null,
    has: (id) => grids.has(id),
    getIdByGrid(g) { for (const [id, e] of grids) if (e.grid === g) return id; return null; },
  };
  return {
    registry, workspace,
    getGrids: () => [...grids.values()].map((e) => e.grid),
    session: { scheduleSave() { saves.push(Date.now); } },
    _saves: saves,
  };
}

function drive() {
  const ctx = makeCtx();
  const router = new CommandRouter(ctx);
  registerGridCommands(router);
  return { ctx, router };
}

// ---- 1. grid.move writes the destination into the model (movers' law) ----
{
  const { ctx, router } = drive();
  const g = makeGrid('a.js');
  ctx.registry.add('src/a.js', g);

  router.execute(['grid.move', 'src/a.js', '12', '34', '56']);

  eq({ x: g.position.x, y: g.position.y, z: g.position.z }, { x: 12, y: 34, z: 56 },
     'grid.move moves the live grid');
  const view = ctx.workspace.getSurface('src/a.js')?.view;
  eq(view?.position, { x: 12, y: 34, z: 56 },
     'grid.move records the destination in the model (THE LAW — failed before this slice)');
  ok(ctx.workspace.getSurface('src/a.js')?.kind === 'grid',
     'the surface record carries the registry species');
}

// ---- 2. the model write is idempotent and tracks the latest move ----
{
  const { ctx, router } = drive();
  ctx.registry.add('src/b.js', makeGrid('b.js'));

  router.execute(['grid.move', 'src/b.js', '1', '2', '3']);
  router.execute(['grid.move', 'src/b.js', '1', '2', '3']);   // same place — no change to record
  router.execute(['grid.move', 'src/b.js', '9', '9', '9']);   // moved again — latest wins

  eq(ctx.workspace.getSurface('src/b.js')?.view?.position, { x: 9, y: 9, z: 9 },
     'the last move is the one the model holds');
}

// ---- 3. a move by INDEX records against the registry id, not the index ----
// The index space is a display convenience; ids are the durable spine. A model keyed by index
// would mis-restore the moment the registry reorders.
{
  const { ctx, router } = drive();
  ctx.registry.add('src/c.js', makeGrid('c.js'));

  router.execute(['grid.move', '0', '5', '5', '5']);

  eq(ctx.workspace.getSurface('src/c.js')?.view?.position, { x: 5, y: 5, z: 5 },
     'moving by index still records under the registry id');
  ok(ctx.workspace.getSurface('0') === null, 'nothing is recorded under the bare index');
}

// ---- 4. a failed move records NOTHING ----
{
  const { ctx, router } = drive();
  ctx.registry.add('src/d.js', makeGrid('d.js'));

  router.execute(['grid.move', 'src/d.js', 'x', '2', '3']);   // non-numeric → rejected
  router.execute(['grid.move', 'no-such-grid', '1', '2', '3']);

  ok(ctx.workspace.getSurface('src/d.js') === null, 'a rejected move writes no intent');
  ok(ctx.workspace.getSurface('no-such-grid') === null, 'an unresolved move writes no intent');
}

// ---- 5. the model write is what schedules the save ----
// SessionStore._armAutosave subscribes to the model's `change:surfaces`, so a verb that writes the
// model needs no scheduleSave() of its own — which is exactly why `terminal.move` has none. This
// asserts the event fires, i.e. that the save path is reachable from the verb alone.
{
  const { ctx, router } = drive();
  ctx.registry.add('src/e.js', makeGrid('e.js'));
  let changes = 0;
  ctx.workspace.on('change:surfaces', () => { changes++; });

  router.execute(['grid.move', 'src/e.js', '7', '8', '9']);
  ok(changes === 1, 'the move emits change:surfaces exactly once (the autosave trigger)');

  router.execute(['grid.move', 'src/e.js', '7', '8', '9']);
  ok(changes === 1, 're-moving to the same place emits nothing (no autosave churn)');
}

// ---- 6. OPEN, by design: the fact is written but not yet projected on reload ----
// Documented so the next slice inherits a named gap rather than a surprise: SURFACE_PROJECTORS
// has no 'grid' entry, so nothing pushes view.position back onto a code grid when it re-registers.
// Closing that is the position-authority slice, which must also decide between this model fact and
// capture's live `files[].x/y/z` scrape — and delete the loser. Two authorities, no applier.
{
  const projectorsFor = ['terminal'];   // SessionStore.SURFACE_PROJECTORS keys, as of this slice
  ok(!projectorsFor.includes('grid'),
     'KNOWN GAP: no grid projector yet — the model holds the move, reload does not replay it');
}

console.log(failures === 0
  ? '\nPASS — grid.move obeys movers\' law (model write + autosave trigger)'
  : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures ? 1 : 0);
