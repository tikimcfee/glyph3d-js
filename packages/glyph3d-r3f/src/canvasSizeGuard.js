/**
 * canvasSizeGuard — the canvas sizing invariant, in one place.
 *
 * Lives apart from GlyphCanvas.jsx so it is reachable headlessly (see
 * tools/canvas-size-guard.test.mjs); it touches no React, no JSX, no three.
 */

/**
 * Assert the canvas sizing invariant: the backing store MUST equal the renderer's
 * logical size times its pixel ratio.
 *
 * This is the substrate seam that produced the 2026-08-17 HiDPI break — a depth
 * attachment born at one size while the color attachment tracked another, surfacing
 * only as an opaque "Attachments have differing sizes" validation error at first
 * render, and only on dpr > 1. Three parties write to this invariant (our pre-bake,
 * three's setPixelRatio, r3f's setSize), so it is worth one integer comparison at
 * each point one of them lands.
 *
 * Also watches for pixel-ratio DRIFT: `resolvedDpr` is pinned at mount, but
 * window.devicePixelRatio changes live when the window is dragged between displays
 * of different density (or the OS zoom changes). The pin then no longer matches
 * reality — the multi-monitor form of the same bug.
 *
 * Deduped by signature, in the house storm-brake style: a resize drag would
 * otherwise emit this every frame. Returns true when the invariant holds.
 */
const _sizeGuardSeen = new Set();
// three's getSize(target) WRITES THROUGH target.set(x, y) — a bare {x,y} literal
// throws "target.set is not a function". Duck-typing the one method three calls keeps
// this module free of the three import (the whole point of it living apart from
// GlyphCanvas.jsx) without lying about the contract.
const _sizeVec = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };

export function assertCanvasSizing(renderer, where, pinnedDpr) {
  // NEVER load-bearing. This runs inside the r3f `gl` factory: a throw here rejects
  // the factory, the canvas never mounts, and a pure diagnostic has taken the whole
  // app down — which is exactly what a bare {x,y} scratch vector did on 2026-08-17,
  // turning a sizing WARNING into a blank page. A guard that can break the thing it
  // guards is worse than no guard, so it reports its own failure and gets out.
  try {
    return _check(renderer, where, pinnedDpr);
  } catch (e) {
    const sig = `guard-threw:${e?.message ?? e}`;
    if (!_sizeGuardSeen.has(sig)) {
      _sizeGuardSeen.add(sig);
      console.warn(`[glyph3d] canvas size guard failed to run at ${where} (the guard's own bug, `
        + `not a sizing fault): ${e?.message ?? e}`);
    }
    return true;
  }
}

/** @private The actual invariant check. */
function _check(renderer, where, pinnedDpr) {
  const canvas = renderer.domElement;
  if (!canvas) return true;
  const size = renderer.getSize(_sizeVec);
  const pr = renderer.getPixelRatio();
  const expectW = Math.floor(size.x * pr);
  const expectH = Math.floor(size.y * pr);
  let ok = true;

  if (canvas.width !== expectW || canvas.height !== expectH) {
    ok = false;
    const sig = `mismatch:${where}:${canvas.width}x${canvas.height}:${expectW}x${expectH}`;
    if (!_sizeGuardSeen.has(sig)) {
      _sizeGuardSeen.add(sig);
      console.error(
        `[glyph3d] canvas sizing invariant BROKEN at ${where}: backing `
        + `${canvas.width}x${canvas.height} but logical ${size.x}x${size.y} x pr ${pr} `
        + `= ${expectW}x${expectH}. The depth/MSAA attachments and the color attachment `
        + `will disagree — expect "Attachments have differing sizes" at the next render. `
        + `Someone wrote canvas.width/height without going through setSize/setPixelRatio.`);
    }
  }

  const livePr = typeof window !== 'undefined'
    ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1;
  if (pinnedDpr !== undefined && livePr !== pinnedDpr) {
    const sig = `drift:${pinnedDpr}->${livePr}`;
    if (!_sizeGuardSeen.has(sig)) {
      _sizeGuardSeen.add(sig);
      console.warn(
        `[glyph3d] devicePixelRatio drifted ${pinnedDpr} -> ${livePr} (window moved to a `
        + `display of different density, or OS zoom changed). The canvas dpr is pinned at `
        + `mount, so the scene is now rendering at the wrong density for this display. `
        + `Reload to re-pin.`);
    }
  }
  return ok;
}
