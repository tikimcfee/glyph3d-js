// session-schema-tolerance-check.mjs — Slice 0 of the state-consolidation migration.
// Asserts SessionStore.restore is FORWARD-ADDITIVE (a current OR future-version blob is NOT
// wiped — only the v1 cliff is) and that WorkspaceModel.clear() empties sheets + resets fields.
// SessionStore/WorkspaceModel are import-free, so this needs no browser/relay.
//
//   bun tools/session-schema-tolerance-check.mjs

import SessionStore from '../app/client/SessionStore.js';
import WorkspaceModel from '../app/client/WorkspaceModel.js';
// terminal geometry intent now lands in the WorkspaceModel surface table (Slice 1), not a queue.

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// ---- mocks (minimal — restore touches only these) ----
function makeCtx() {
  return {
    registry: { has: () => false, get: () => null, findByType: () => [], addChangeListener() {}, removeChangeListener() {} },
    camera: null, cameraController: null, cameraDock: null, workspace: new WorkspaceModel(),
    status: { set() {}, clear() {} },
    fileProvider: { stat: async () => { throw new Error('absent'); } },
  };
}
function makeStore(writes) {
  const ctx = makeCtx();
  const router = { execute: async () => ({ text: 'OK' }) };
  const bridge = { rpcRequest: async (m, p) => { if (m === 'fs/writeFile') writes.push(JSON.parse(p.content)); return {}; } };
  return new SessionStore({ ctx, router, bridge });
}

// ---- 1. a FUTURE-version blob with an unknown key is NOT wiped; known intent restores ----
{
  const writes = [];
  const ss = makeStore(writes);
  await ss.restore({
    version: 99, futureKnob: 'ignored', files: [], camera: null,
    terminals: [{ id: 'term-x', x: 1, y: 2, z: 3, cols: 120, rows: 40 }],
  });
  ok(writes.length === 0, 'future-version blob is NOT wiped (no _clear write)');
  const surf = ss.ctx.workspace.getSurface('term-x');
  ok(surf?.view.cols === 120 && surf?.view.rows === 40,
     'future-version blob: known terminal intent still restored into the model (unknown key ignored)');
}

// ---- 1b. legacy single-`field` key restores as one field source (data tolerance) ----
{
  const calls = [];
  const ctx = makeCtx();
  const router = { execute: async (cmd) => { calls.push(cmd); return { text: 'OK' }; } };
  const bridge = { rpcRequest: async () => ({}) };
  const ss = new SessionStore({ ctx, router, bridge });
  await ss.restore({ version: 2, files: [], field: { type: 'local', dir: 'src' } });
  ok(calls.some((c) => Array.isArray(c) && c[0] === 'file.openDir' && c[1] === 'src'),
     'legacy `field` key: replayed as a field source (openDir called)');

  const calls2 = [];
  const router2 = { execute: async (cmd) => { calls2.push(cmd); return { text: 'OK' }; } };
  const ss2 = new SessionStore({ ctx: makeCtx(), router: router2, bridge });
  await ss2.restore({
    version: 2, files: [],
    fieldSources: [{ type: 'local', dir: '/a/proj' }, { type: 'local', dir: '/b/other' }],
  });
  const dirs = calls2.filter((c) => Array.isArray(c) && c[0] === 'file.openDir').map((c) => c[1]);
  ok(dirs.length === 2 && dirs[0] === '/a/proj' && dirs[1] === '/b/other',
     'fieldSources list: every root replays, in order');
}

// ---- 2. a v1 blob (the real cliff) IS wiped to an empty v2 snapshot ----
{
  const writes = [];
  const ss = makeStore(writes);
  await ss.restore({ version: 1, files: [{ path: 'whole/field/dumped/here.js' }] });
  ok(writes.length === 1 && writes[0].version === 2, 'v1 blob is wiped to an empty v2 snapshot');
}

// ---- 3. WorkspaceModel.clear() empties sheets + resets fields, and emits once ----
{
  const wm = new WorkspaceModel();
  wm.openSheet({ kind: 'file', source: { path: 'a.js' } });
  wm.openSheet({ kind: 'file', source: { path: 'b.js' } });
  ok(wm.sheets.size === 2 && wm.getActiveField().sheetIds.length === 2, 'precondition: 2 sheets open in the active field');
  let sheetsEvt = 0; wm.on('change:sheets', () => sheetsEvt++);
  wm.clear();
  ok(wm.sheets.size === 0, 'clear(): sheets emptied');
  ok(wm.getActiveField().sheetIds.length === 0 && wm.getActiveField().activeSheetId === null, 'clear(): active field reset');
  ok(sheetsEvt === 1, 'clear(): emitted change:sheets exactly once');
  // idempotent: a second clear on an empty model emits nothing
  let again = 0; wm.on('change:sheets', () => again++);
  wm.clear();
  ok(again === 0, 'clear(): no-op on an already-empty model (no spurious emit)');
}

console.log(failures === 0 ? '\nPASS — schema tolerance + WorkspaceModel.clear()' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
