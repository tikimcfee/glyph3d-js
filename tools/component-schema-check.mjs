// component-schema-check.mjs — verifies Slice A: named components behind `view`.
// The `view` flat store is unchanged (byte-identical capture); component accessors
// return named slices. Every view key belongs to a declared component.
//
//   bun tools/component-schema-check.mjs

import WorkspaceModel, { COMPONENT_SCHEMA } from '../app/client/WorkspaceModel.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`);

// ---- 1. schema declares the durable components with their keys --
ok(COMPONENT_SCHEMA.Residence?.table === 'durable', 'schema: Residence is durable');
ok(COMPONENT_SCHEMA.Residence.keys.includes('docked'), 'schema: Residence owns docked');
ok(COMPONENT_SCHEMA.Residence.keys.includes('dockOrder'), 'schema: Residence owns dockOrder');
ok(COMPONENT_SCHEMA.Residence.keys.includes('carrel'), 'schema: Residence owns carrel');
ok(COMPONENT_SCHEMA.Position?.table === 'durable', 'schema: Position is durable');
ok(COMPONENT_SCHEMA.Position.keys.includes('position'), 'schema: Position owns position');
ok(COMPONENT_SCHEMA.Zoom?.table === 'durable', 'schema: Zoom is durable');
ok(COMPONENT_SCHEMA.Zoom.keys.includes('zoom'), 'schema: Zoom owns zoom');
ok(COMPONENT_SCHEMA.TerminalGeometry?.table === 'durable', 'schema: TerminalGeometry is durable');
ok(COMPONENT_SCHEMA.TerminalGeometry.keys.includes('cols'), 'schema: TerminalGeometry owns cols');
ok(COMPONENT_SCHEMA.TerminalGeometry.keys.includes('rows'), 'schema: TerminalGeometry owns rows');

// ---- 2. getComponent returns the slice; hasComponent detects presence --
{
  const ws = new WorkspaceModel();
  ws.setSurfaceView('term-1', 'terminal', {
    docked: true, dockOrder: 2, carrel: null,
    position: { x: 10, y: 20, z: 30 },
    zoom: 1.5, cols: 80, rows: 24,
  });
  eq(ws.getComponent('term-1', 'Residence'), { docked: true, dockOrder: 2 },
     'getComponent: Residence slice (carrel null → omitted)');
  eq(ws.getComponent('term-1', 'Position'), { position: { x: 10, y: 20, z: 30 } },
     'getComponent: Position slice');
  eq(ws.getComponent('term-1', 'Zoom'), { zoom: 1.5 },
     'getComponent: Zoom slice');
  eq(ws.getComponent('term-1', 'TerminalGeometry'), { cols: 80, rows: 24 },
     'getComponent: TerminalGeometry slice');
  ok(ws.hasComponent('term-1', 'Residence'), 'hasComponent: Residence present');
  ok(ws.hasComponent('term-1', 'Position'), 'hasComponent: Position present');
  ok(!ws.hasComponent('term-1', 'NonExistent'), 'hasComponent: unknown component → false');
}

// ---- 3. a surface with only some components --
{
  const ws = new WorkspaceModel();
  ws.setSurfaceView('a.js', 'grid', { position: { x: 0, y: 0, z: 0 } });
  eq(ws.getComponent('a.js', 'Position'), { position: { x: 0, y: 0, z: 0 } },
     'getComponent: Position present on a grid');
  eq(ws.getComponent('a.js', 'Residence'), null,
     'getComponent: Residence absent (no docked/carrel set)');
  ok(!ws.hasComponent('a.js', 'Residence'), 'hasComponent: Residence absent on a loose grid');
  ok(ws.hasComponent('a.js', 'Position'), 'hasComponent: Position present');
}

// ---- 4. byte-identical capture: view stays flat, unchanged --
// The whole point of Slice A — naming components changes NOTHING about the on-disk shape.
{
  const ws = new WorkspaceModel();
  ws.setSurfaceView('t', 'terminal', { docked: true, dockOrder: 0, zoom: 2.0, position: { x: 1, y: 2, z: 3 }, cols: 120, rows: 40 });
  const s = ws.getSurface('t');
  // view is still the flat store — no components key, no restructuring.
  ok(!('components' in s), 'byte-identical: no `components` key on the surface record');
  eq(s.view, { docked: true, dockOrder: 0, zoom: 2.0, position: { x: 1, y: 2, z: 3 }, cols: 120, rows: 40 },
     'byte-identical: view is the flat store, unchanged');
}

console.log(failures ? `\n${failures} FAIL` : '\nPASS — component schema names view keys behind a flat store');
process.exit(failures ? 1 : 0);
