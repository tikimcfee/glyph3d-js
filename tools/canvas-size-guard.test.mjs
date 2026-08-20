// canvas-size-guard.test.mjs — headless behavior lock for the canvas sizing invariant
// (the 2026-08-17 HiDPI break).
//
//   bun tools/canvas-size-guard.test.mjs
//
// The bug: GlyphCanvas pre-bakes the DEVICE size into canvas.width/height, three's
// WebGPURenderer constructor adopts those as its LOGICAL size with pixelRatio still 1,
// then r3f calls setPixelRatio(dpr) — which recomputes canvas.width = logical × dpr,
// squaring the ratio (3840 → 7680) while CanvasTarget's depth texture stays at 3840.
// The only symptom was an opaque WebGPU "Attachments have differing sizes" error at
// first render, and only at dpr > 1 — invisible on every dpr-1 machine.
//
// Three parties write this invariant, so it gets one assert at each landing point.
// No browser here: a fake renderer reports whatever sizes the case needs.

import { assertCanvasSizing } from '../packages/glyph3d-r3f/src/canvasSizeGuard.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

// The guard reads window.devicePixelRatio for drift detection.
globalThis.window = { devicePixelRatio: 2 };

// getSize MUST write through target.set(), exactly as three's Renderer does:
//
//     getSize( target ) { return target.set( this._width, this._height ); }
//
// A fake that assigns v.x / v.y directly is more permissive than the real thing and
// silently accepts a target with no .set — which is precisely how a bare {x,y}
// literal shipped and threw "target.set is not a function" in the browser while this
// suite stayed green. The stub honors the contract so the guard has to as well.
const makeRenderer = ({ backingW, backingH, logicalW, logicalY, pr }) => ({
    domElement: { width: backingW, height: backingH },
    getSize: (target) => target.set(logicalW, logicalY),
    getPixelRatio: () => pr,
});

// Capture console output so we can assert on WHAT it says, not just that it fired.
const errs = [], warns = [];
console.error = (m) => errs.push(String(m));
console.warn  = (m) => warns.push(String(m));

// --- 1. Healthy HiDPI: backing == logical × pr. Silent. -----------------------
{
    const r = makeRenderer({ backingW: 3840, backingH: 925, logicalW: 1920, logicalY: 462.7, pr: 2 });
    ok(assertCanvasSizing(r, 'test-healthy', 2) === true, 'healthy dpr-2 canvas passes');
    ok(errs.length === 0, 'healthy canvas logs no error');
    ok(warns.length === 0, 'healthy canvas logs no drift warning');
}

// --- 2. THE REGRESSION: pixel ratio applied twice. ----------------------------
{
    errs.length = 0;
    const r = makeRenderer({ backingW: 7680, backingH: 1850, logicalW: 1920, logicalY: 462.7, pr: 2 });
    ok(assertCanvasSizing(r, 'test-squared', 2) === false, 'squared pixel ratio is caught');
    ok(errs.length === 1, 'squared ratio logs exactly one error');
    ok(/BROKEN/.test(errs[0]), 'error names the invariant as broken');
    ok(/7680x1850/.test(errs[0]) && /3840x925/.test(errs[0]),
       'error reports both the actual backing and the expected size');
    ok(/Attachments have differing sizes/.test(errs[0]),
       'error names the downstream WebGPU symptom, so a search for it lands here');
}

// --- 3. Dedup: a resize drag must not storm. ----------------------------------
{
    errs.length = 0;
    const r = makeRenderer({ backingW: 7680, backingH: 1850, logicalW: 1920, logicalY: 462.7, pr: 2 });
    for (let i = 0; i < 100; i++) assertCanvasSizing(r, 'test-squared', 2);
    ok(errs.length === 0, 'an already-reported signature never logs again (storm brake)');
}

// --- 4. A DIFFERENT mismatch still gets through the dedup. --------------------
{
    errs.length = 0;
    const r = makeRenderer({ backingW: 300, backingH: 150, logicalW: 1920, logicalY: 462.7, pr: 2 });
    assertCanvasSizing(r, 'test-unbaked', 2);
    ok(errs.length === 1, 'a distinct mismatch signature is not swallowed by the dedup');
}

// --- 5. dpr drift: window dragged to a display of different density. ----------
{
    warns.length = 0;
    const r = makeRenderer({ backingW: 3840, backingH: 925, logicalW: 1920, logicalY: 462.7, pr: 2 });
    globalThis.window.devicePixelRatio = 1;           // moved to a non-HiDPI monitor
    ok(assertCanvasSizing(r, 'test-drift', 2) === true, 'drift alone does not fail the size invariant');
    ok(warns.length === 1, 'drift warns exactly once');
    ok(/drifted 2 -> 1/.test(warns[0]), 'drift warning names both ratios');
    for (let i = 0; i < 50; i++) assertCanvasSizing(r, 'test-drift', 2);
    ok(warns.length === 1, 'drift warning is deduped too');
}

// --- 6. Fractional logical size floors the same way three does. ---------------
{
    errs.length = 0;
    globalThis.window.devicePixelRatio = 2;
    // 462.7 × 2 = 925.4 → floor 925. An implementation using round() would expect 925
    // here but 926 elsewhere — the 1px drift that a785542 already fought once.
    const r = makeRenderer({ backingW: 3840, backingH: 925, logicalW: 1920, logicalY: 462.7, pr: 2 });
    ok(assertCanvasSizing(r, 'test-fractional', 2) === true, 'fractional CSS height floors, not rounds');
    ok(errs.length === 0, 'fractional size produces no false positive');
}

// --- 7. No canvas yet (pre-mount) is not a failure. ---------------------------
{
    ok(assertCanvasSizing({ domElement: null }, 'test-nocanvas', 2) === true,
       'a renderer with no canvas passes rather than throwing');
}

// --- 8. The module's scratch vector satisfies three's write-through contract. ---
// Case 1-7 all route through makeRenderer; this one pins the shape of the object the
// guard actually hands to three, so the .set regression cannot come back via a
// refactor that swaps the fake out.
{
    let handed = null;
    const r = {
        domElement: { width: 3840, height: 925 },
        getSize: (target) => { handed = target; return target.set(1920, 462.7); },
        getPixelRatio: () => 2,
    };
    ok(assertCanvasSizing(r, 'test-contract', 2) === true, 'guard passes with a contract-honoring getSize');
    ok(handed !== null && typeof handed.set === 'function',
       'the guard hands three a target with a real .set method');
    ok(handed.x === 1920 && handed.y === 462.7,
       'set() writes through to x/y, so the guard reads the size three reported');
    ok(handed.set(7, 9) === handed, 'set() returns the target, as three expects');
}

// --- 9. The guard is never load-bearing. -------------------------------------
// It runs inside r3f's gl factory, so a throw rejects the factory and the canvas
// never mounts — a diagnostic taking down the app it diagnoses.
{
    warns.length = 0; errs.length = 0;
    const exploding = {
        domElement: { width: 3840, height: 925 },
        getSize: () => { throw new TypeError('target.set is not a function'); },
        getPixelRatio: () => 2,
    };
    let threw = false;
    let res;
    try { res = assertCanvasSizing(exploding, 'test-explode', 2); } catch { threw = true; }
    ok(!threw, 'a broken guard swallows its own throw instead of killing the canvas');
    ok(res === true, 'a guard that could not run reports no fault (it knows nothing)');
    ok(warns.length === 1, 'the guard reports its own failure exactly once');
    ok(/the guard's own bug/.test(warns[0]), 'the message distinguishes guard bug from sizing fault');
}

console.log(`\ncanvas-size-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
