// occlusion-resolve-guard.test.mjs — headless behavior lock for the OcclusionCuller
// fault guard (the 2026-08-04 mapAsync storm fix).
//
//   bun tools/occlusion-resolve-guard.test.mjs
//
// three's WebGPUBackend.finishRender calls resolveOccludedAsync() un-awaited, and its
// mapAsync has no catch — a dead GPU device/instance turns that into an unhandled
// rejection EVERY FRAME forever. The culler wraps the backend method once: a
// rejection logs once, disables the culler (stops arming query sets — the storm's
// fuel), and never reaches the unhandled-rejection handlers. dispose() must restore
// the backend's original method. No WebGPU here — a fake backend rejects on cue.

import * as THREE from 'three';
import OcclusionCuller from '../packages/glyph3d-core/src/services/visual/OcclusionCuller.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

// Any escaped rejection fails the run — the storm's signature.
let escaped = 0;
process.on('unhandledRejection', () => escaped++);

const ABORT = Object.assign(new Error("Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists."), { name: 'AbortError' });

// Fake renderer: backend.resolveOccludedAsync rejects like a dead device.
const makeRenderer = () => ({
    backend: {
        calls: 0,
        async resolveOccludedAsync() { this.calls++; throw ABORT; },
    },
    isOccluded: () => false,
});

// A live candidate with real bounds so update()'s proxy refit runs the honest path.
const makeTarget = () => ({
    visible: true,
    getBounds: (box) => box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── fault disables the culler, warns once, swallows the rejection ──
{
    const renderer = makeRenderer();
    const culler = new OcclusionCuller({ renderer, scene: new THREE.Scene() });
    culler.track('term-1', makeTarget());
    culler.setEnabled(true);

    let warns = 0;
    const origWarn = console.warn;
    console.warn = (...a) => { warns++; origWarn(...a); };

    ok(renderer.backend.calls === 0, 'guard installs without calling the backend');

    // Three calls it un-awaited — exactly how finishRender does.
    renderer.backend.resolveOccludedAsync({});
    renderer.backend.resolveOccludedAsync({});
    renderer.backend.resolveOccludedAsync({});
    await tick();

    console.warn = origWarn;
    ok(renderer.backend.calls === 3, `all 3 calls reached the original (got ${renderer.backend.calls})`);
    ok(culler.enabled === false, 'culler disabled itself after the fault');
    ok(culler.group.visible === false, 'proxy group hidden — no new query sets armed');
    ok(warns === 1, `exactly one warning (got ${warns})`);
    ok(escaped === 0, `no unhandled rejections escaped (got ${escaped})`);

    // Late rejections stay quiet — the guard is idempotent.
    renderer.backend.resolveOccludedAsync({});
    await tick();
    ok(warns === 1, `still one warning after a repeat fault (got ${warns})`);
    ok(escaped === 0, `repeat fault swallowed too (escaped=${escaped})`);

    // dispose restores the backend's own method (own property removed).
    culler.dispose();
    ok(!Object.prototype.hasOwnProperty.call(renderer.backend, 'resolveOccludedAsync'),
        'dispose unpatches the backend (prototype method restored)');
    ok(!Object.prototype.hasOwnProperty.call(renderer.backend, '__occlGuarded'),
        'dispose clears the guard marker');
}

// ── a SYNCHRONOUSLY-throwing backend is contained too ──
{
    const renderer = {
        backend: {
            resolveOccludedAsync() { throw ABORT; },   // sync throw, not a rejection
        },
        isOccluded: () => false,
    };
    const culler = new OcclusionCuller({ renderer, scene: new THREE.Scene() });
    let threw = false;
    try { renderer.backend.resolveOccludedAsync({}); } catch { threw = true; }
    ok(!threw, 'sync throw contained by the guard');
    ok(culler.enabled === false, 'sync throw also disables the culler');
    culler.dispose();
}

// ── a HEALTHY backend passes results through untouched ──
{
    let resolved = 0;
    const renderer = {
        backend: {
            async resolveOccludedAsync() { resolved++; return 'fine'; },
        },
        isOccluded: () => false,
    };
    const culler = new OcclusionCuller({ renderer, scene: new THREE.Scene() });
    renderer.backend.resolveOccludedAsync({});
    await tick();
    ok(resolved === 1, 'healthy resolve runs');
    ok(culler.enabled === false || culler.enabled === true, 'no fault state touched');
    ok(culler._resolveFaulted === false, 'no fault latched on the healthy path');
    culler.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
