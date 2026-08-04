// device-loss-recovery.test.mjs — headless behavior lock for the GPU-device-lost
// quiet path in GlyphLayoutCompute (the 2026-08-04 "munged layout" storm).
//
//   bun tools/device-loss-recovery.test.mjs
//
// On a lost device every layout flush re-throws createBuffer failures per field,
// forever — glyph fields render unlaid and the log storms. The engine short-circuits:
// one warning, then dispatches suspend until a NEW renderer registers (the app's
// device-lost handler queues a page reload, which re-registers via setComputeRenderer).

import { setComputeRenderer, syncGpuLayout, isGpuLayoutEnabled } from '../packages/glyph3d-core/src/compute/GlyphLayoutCompute.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

const field = { gpuLayout: true };   // engine-owned; no mesh needed — the gate comes first

// ── lost device: one warn, then silent suspension ──
{
    setComputeRenderer({ _isDeviceLost: true });
    ok(isGpuLayoutEnabled(), 'renderer registered → engine enabled');

    let warns = 0;
    const origWarn = console.warn;
    console.warn = (...a) => { warns++; };

    const r1 = syncGpuLayout(field, {}, [], {});
    const r2 = syncGpuLayout(field, {}, [], {});
    const r3 = syncGpuLayout(field, {}, [], {});
    console.warn = origWarn;

    ok(r1.dispatched === 0 && r1.bounds === null, 'flush 1: no dispatch on a dead device');
    ok(r2.dispatched === 0 && r3.dispatched === 0, 'flushes 2-3: still suspended');
    ok(warns === 1, `exactly one suspension warning across 3 flushes (got ${warns})`);
}

// ── a fresh renderer (the post-reload registration) resets the suspension ──
{
    setComputeRenderer({ _isDeviceLost: false });
    let warns = 0;
    const origWarn = console.warn;
    console.warn = (...a) => { warns++; };
    // No instanceMesh on the fake field → falls through to the attr gate (NONE),
    // but NOT via the device-lost path: no new warning may fire.
    const r = syncGpuLayout(field, {}, [], {});
    console.warn = origWarn;
    ok(r.dispatched === 0, 'healthy renderer: fake field reaches the normal gates');
    ok(warns === 0, `no suspension warning on a healthy renderer (got ${warns})`);
}

// ── unregister: engine off, nothing dispatched, nothing logged ──
{
    setComputeRenderer(null);
    ok(!isGpuLayoutEnabled(), 'null unregisters');
    const r = syncGpuLayout(field, {}, [], {});
    ok(r.dispatched === 0, 'no renderer → no dispatch');
}

setComputeRenderer(null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
