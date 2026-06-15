// camera-focus-docked-check.mjs — guards the launch-restore camera clobber.
//
// A DOCKED tile is camera-locked chrome (it rides the camera, always in view). `camera.focus` on
// one must NOT fly the world camera — on session restore a programmatic tab-activation fired
// `camera.focus <docked terminal>`, whose flyTo({pitch:0,yaw:0}) zeroed the just-restored pose
// (position looked kept because the tile sits where you are; only the angle visibly flattened).
// This asserts: docked target → no world flight (focusOnObject NOT called); loose target → it is.
//
//   bun tools/camera-focus-docked-check.mjs
//
// Graduated from a relay-trace investigation per the debug-into-tools practice.

import registerCameraCommands from '../app/commands/handlers/cameraCommands.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Capture the registered handlers (the router just collects name → fn).
const handlers = {};
registerCameraCommands({ register: (name, fn) => { handlers[name] = fn; } });

function makeCtx({ docked }) {
  const flights = [];
  const grid = { getBounds: () => ({ isEmpty: () => false }) };
  return {
    flights,
    getGrids: () => [],                                  // term-19 is a terminal, not in getGrids('grid')
    registry: { get: (id) => (id === 'term-19' ? { id, grid } : null), getIdByGrid: () => null },
    cameraDock: { has: (id) => docked && id === 'term-19' },
    cameraController: {
      focusOnObject: (g) => { flights.push(['focusOnObject', g]); return true; },
      focusOnGrid: (i) => { flights.push(['focusOnGrid', i]); },
    },
    spatialNav: null,
  };
}

// ---- 1. docked terminal → camera.focus does NOT fly the world camera ----
{
  const ctx = makeCtx({ docked: true });
  const res = handlers['camera.focus'](['term-19'], ctx);
  ok(res?.data?.docked === true, 'docked: returns { docked: true } (the dock frames it)');
  ok(ctx.flights.length === 0, 'docked: NO world flight — focusOnObject/focusOnGrid never called');
}

// ---- 2. loose terminal → camera.focus DOES frame it (regression guard for the normal path) ----
{
  const ctx = makeCtx({ docked: false });
  const res = handlers['camera.focus'](['term-19'], ctx);
  ok(!res?.data?.docked, 'loose: not flagged docked');
  ok(ctx.flights.some(([m]) => m === 'focusOnObject'), 'loose: world frame still fires (focusOnObject called)');
}

console.log(failures === 0 ? '\nPASS — docked tiles never steal the world camera' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
