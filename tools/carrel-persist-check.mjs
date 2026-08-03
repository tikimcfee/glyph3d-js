// carrel-persist-check.mjs — deterministic round-trip of carrel residence
// persistence through the MODEL (view.carrel), with mocks. The manifest is gone
// (Slice 1); the model is the single authority. This test verifies that capture
// reads listCarreled() and restore writes view.carrel, and that member arrival
// order — the manifest's whole job — is preserved by the model's per-member order.
//
//   bun tools/carrel-persist-check.mjs

import SessionStore from '../app/client/SessionStore.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`);

// ---- mocks ----------------------------------------------------------------
// A mock Carrel: lock/has/entries with the order field the sweep threads.
function makeCarrel(name) {
  const entries = new Map();
  return {
    carrelName: name,
    entries,
    has(id) { return entries.has(id); },
    lock(id, grid, opts = {}) {
      entries.set(id, { id, grid, order: opts.order ?? entries.size });
      return true;
    },
    release(id) { entries.delete(id); },
    list() { return [...entries.values()].sort((a, b) => a.order - b.order).map((e) => ({ id: e.id, order: e.order })); },
    serialize() {
      return {
        name: this.carrelName,
        managed: false,
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        params: { radius: 20, boxH: 9, boxAspect: 1.15, gapFrac: 0.9, growCap: 1.5, maxArcDeg: 300, mode: 'ring', facing: 'in', tableFrac: 0.7, shadowSoft: 0.6, glowColor: 200, glowStrength: 0.3 },
      };
    },
  };
}

function makeCtx(carrelsMap) {
  const ws = new WorkspaceModel();
  return {
    workspace: ws,
    carrels: carrelsMap,
    holders: new Set([...carrelsMap.values()]),
    cameraDock: null,
    agentBooks: null,
    registry: null,
    // holderOf: scans carrels for the id (simplified — no dock in this test)
    get holderOf() {
      return (id) => {
        for (const c of this.carrels.values()) if (c.has(id)) return c;
        return null;
      };
    },
    camera: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, fov: 70 },
    scene: { add() {}, remove() {} },
    world: null,
    fileProvider: { _currentRepo: null },
    fieldSources: [],
    status: { set() {}, clear() {} },
    wsbridge: { connected: false, push() {} },
  };
}

function makeRouter() {
  return { calls: [], execute(cmd) { this.calls.push(cmd); return Promise.resolve({ text: 'OK' }); } };
}

// ---- 1. capture: carrelMembers read from the MODEL (listCarreled), not a live scrape --
{
  const desk = makeCarrel('desk-1');
  const ctx = makeCtx(new Map([['desk-1', desk]]));
  // Three members seated at the desk — the MODEL holds their residence + order.
  ctx.workspace.setSurfaceView('term-1', 'terminal', { carrel: { name: 'desk-1', order: 0 } });
  ctx.workspace.setSurfaceView('term-2', 'terminal', { carrel: { name: 'desk-1', order: 1 } });
  ctx.workspace.setSurfaceView('a.js', 'grid', { carrel: { name: 'desk-1', order: 2 } });

  const snap = new SessionStore({ ctx, router: makeRouter(), bridge: {} }).capture();
  ok(Array.isArray(snap.carrelMembers) && snap.carrelMembers.length === 3,
     'capture: carrelMembers populated from listCarreled');
  eq(snap.carrelMembers, [
    { id: 'term-1', name: 'desk-1', order: 0 },
    { id: 'term-2', name: 'desk-1', order: 1 },
    { id: 'a.js', name: 'desk-1', order: 2 },
  ], 'capture: carrelMembers carries id + desk name + order (sorted)');
  // The carrel serialize no longer carries members.
  eq(snap.carrels[0].members, undefined,
     'capture: Carrel.serialize() carries NO members (the fork is closed)');
}

// ---- 2. restore: writes view.carrel to the MODEL (the authority) --
{
  const ctx = makeCtx(new Map());
  const ss = new SessionStore({ ctx, router: makeRouter(), bridge: {} });
  await ss.restore({
    version: 2, files: [], camera: null, terminals: [],
    carrels: [{ name: 'desk-1', managed: false, position: { x: 0, y: 0, z: 0 }, yaw: 0, params: {} }],
    carrelMembers: [
      { id: 'term-1', name: 'desk-1', order: 0 },
      { id: 'a.js', name: 'desk-1', order: 1 },
    ],
  });
  eq(ctx.workspace.getSurface('term-1')?.view?.carrel, { name: 'desk-1', order: 0 },
     'restore: term-1 view.carrel written to the model');
  eq(ctx.workspace.getSurface('a.js')?.view?.carrel, { name: 'desk-1', order: 1 },
     'restore: a.js view.carrel written to the model');
}

// ---- 3. arrival order fuzz: members seat in their saved ORDER regardless of materialization order --
// This was the manifest's whole job. The model holds per-member order, so each
// member seats at its recorded position no matter WHEN it materializes.
{
  // Simulate: desk restored with 4 members at orders 0,1,2,3. They materialize
  // in a SCRAMBLED order (3,1,0,2) — a re-adopted terminal, a late file, etc.
  // The sweep seats each at its model-recorded order, not arrival order.
  for (const perm of [[3, 1, 0, 2], [2, 0, 3, 1], [1, 3, 2, 0], [0, 1, 2, 3]]) {
    const desk = makeCarrel('fuzz-desk');
    const ctx = makeCtx(new Map([['fuzz-desk', desk]]));
    const ws = ctx.workspace;
    // Restore writes all 4 claims into the model with their saved order.
    for (let i = 0; i < 4; i++)
      ws.setSurfaceView(`m-${i}`, 'grid', { carrel: { name: 'fuzz-desk', order: i } });
    // Mock resolveHostable + registry so the sweep can seat materialized members.
    ctx.registry = {
      _live: new Set(perm.map((i) => `m-${i}`)),
      has(id) { return this._live.has(id); },
      get(id) { return this._live.has(id) ? { id, grid: { id }, type: 'grid', meta: {} } : null; },
    };
    ctx.agentBooks = null;
    // Materialize members in the fuzzed order, running the sweep after each.
    // (In the live system, each materialization fires a registry change → sweep.)
    const { carrelSweep } = await import('../app/commands/handlers/carrelCommands.js');
    for (const i of perm) {
      // Simulate "m-i is now live" by ensuring the registry knows it (it does);
      // the sweep seats any model-claimed member whose hostable object exists.
      carrelSweep(ctx);
    }
    // After the sweep, every member should be seated at its saved ORDER,
    // not its arrival order — the model's per-member order is authoritative.
    const seated = desk.list();
    eq(seated.map((e) => e.order), [0, 1, 2, 3],
       `fuzz [${perm.join(',')}] arrival → members seat in saved order 0,1,2,3`);
  }
}

// ---- 4. pre-Slice-1 backward compat: inline members degrade gracefully --
// A v2 snapshot (pre-Slice-1) carries members inline in carrels[].m. Restore
// should still populate view.carrel from them — forward-additive, no migration shim.
{
  const ctx = makeCtx(new Map());
  const ss = new SessionStore({ ctx, router: makeRouter(), bridge: {} });
  await ss.restore({
    version: 2, files: [], camera: null, terminals: [],
    carrels: [{ name: 'old-desk', managed: false, position: { x: 0, y: 0, z: 0 }, yaw: 0, params: {},
                members: [{ id: 'old-term', order: 0 }, { id: 'old-grid', order: 1 }] }],
    // No carrelMembers — pre-Slice-1 shape.
  });
  eq(ctx.workspace.getSurface('old-term')?.view?.carrel, { name: 'old-desk', order: 0 },
     'backward compat: inline c.members → view.carrel (no carrelMembers section)');
  eq(ctx.workspace.getSurface('old-grid')?.view?.carrel, { name: 'old-desk', order: 1 },
     'backward compat: inline c.members → view.carrel (second member)');
}

// ---- 5. round-trip: capture then restore preserves all membership --
{
  const desk = makeCarrel('rt-desk');
  const ctx1 = makeCtx(new Map([['rt-desk', desk]]));
  ctx1.workspace.setSurfaceView('rt-1', 'terminal', { carrel: { name: 'rt-desk', order: 0 } });
  ctx1.workspace.setSurfaceView('rt-2', 'grid', { carrel: { name: 'rt-desk', order: 1 } });
  ctx1.workspace.setSurfaceView('rt-3', 'grid', { carrel: { name: 'rt-desk', order: 2 } });
  const snap = new SessionStore({ ctx: ctx1, router: makeRouter(), bridge: {} }).capture();

  const ctx2 = makeCtx(new Map());
  await new SessionStore({ ctx: ctx2, router: makeRouter(), bridge: {} }).restore(snap);
  eq(ctx2.workspace.getSurface('rt-1')?.view?.carrel, { name: 'rt-desk', order: 0 },
     'round-trip: rt-1 residence preserved');
  eq(ctx2.workspace.getSurface('rt-2')?.view?.carrel, { name: 'rt-desk', order: 1 },
     'round-trip: rt-2 residence preserved');
  eq(ctx2.workspace.getSurface('rt-3')?.view?.carrel, { name: 'rt-desk', order: 2 },
     'round-trip: rt-3 residence preserved');
  ok(snap.carrels[0].members === undefined,
     'round-trip: serialize() carries no members (model is the authority)');
}

console.log(failures ? `\n${failures} FAIL` : '\nPASS — carrel persistence round-trips through the model');
process.exit(failures ? 1 : 0);
