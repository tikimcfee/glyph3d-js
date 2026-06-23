// framed-scale.test.mjs — headless, GPU-free behavior lock for FramedGlyphField's scale surface.
//
//   bun tools/framed-scale.test.mjs
//
// FramedGlyphField (BoundedObject3D → FramedGlyphField → CodeGrid/TerminalGrid/FrameGrid) lifts the
// scale surface the three grids used to triplicate verbatim: _initScale(placement) builds the
// ScaleModel and writes the initial this.scale; setScale/setZoom/zoom drive ScaleModel.resolve (the
// SOLE writer of this.scale, scale = placement · user). This pins that the lifted methods reproduce
// the old per-grid inline behavior exactly, including the subclass stash-then-super override pattern.

import * as THREE from 'three';
import FramedGlyphField from '../packages/glyph3d-core/src/collections/FramedGlyphField.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };
const EPS = 1e-9;
const scaleEq = (o, x, y, z, m) => ok(
  Math.abs(o.scale.x - x) < EPS && Math.abs(o.scale.y - y) < EPS && Math.abs(o.scale.z - z) < EPS,
  `${m}\n      got scale=(${o.scale.x}, ${o.scale.y}, ${o.scale.z}) want (${x}, ${y}, ${z})`);

// Independent oracle — the old inline formula every grid wrote by hand: scale = placement · user.
const oracleScale = (placement, user) => [placement * user.x, placement * user.y, placement * user.z];

// ── 1. _initScale writes the initial transform (placement · default-zoom-1) ──────────────
{
  const f = new FramedGlyphField();
  f._initScale(2.5);
  scaleEq(f, 2.5, 2.5, 2.5, '_initScale(p): this.scale == (p,p,p) with default zoom 1');
  ok(f.zoom === 1, '_initScale: zoom defaults to 1');
}

// ── 2. setScale changes placement, preserves the active zoom ─────────────────────────────
{
  const f = new FramedGlyphField();
  f._initScale(1);
  f.setZoom(3);                                   // user = 3
  f.setScale(2);                                  // placement = 2, zoom must survive
  const [x, y, z] = oracleScale(2, { x: 3, y: 3, z: 3 });
  scaleEq(f, x, y, z, 'setScale: scale == placement·user (zoom preserved across a placement change)');
  ok(f.zoom === 3, 'setScale: a placement change leaves zoom untouched');
}

// ── 3. setZoom (uniform scalar) composes onto placement ──────────────────────────────────
{
  const f = new FramedGlyphField();
  f._initScale(4);
  f.setZoom(0.5);
  scaleEq(f, 2, 2, 2, 'setZoom(scalar): scale == placement·zoom');
  ok(f.zoom === 0.5, 'setZoom(scalar): zoom getter reflects it');
}

// ── 4. setZoom (per-axis stretch) ────────────────────────────────────────────────────────
{
  const f = new FramedGlyphField();
  f._initScale(2);
  f.setZoom({ x: 1, y: 2, z: 3 });
  scaleEq(f, 2, 4, 6, 'setZoom({x,y,z}): per-axis stretch composes onto placement');
  ok(f.zoom === 1, 'setZoom({x,y,z}): zoom getter is the x component');
}

// ── 5. subclass override pattern (CodeGrid/TerminalGrid stash a home field, then super) ──
{
  class StashingField extends FramedGlyphField {
    constructor() { super(); this.home = null; this._initScale(1); }
    setScale(factor) { this.home = factor; super.setScale(factor); }   // mirrors CodeGrid/TerminalGrid
  }
  const f = new StashingField();
  f.setScale(5);
  ok(f.home === 5, 'override: subclass stashes its own home-scale field');
  scaleEq(f, 5, 5, 5, 'override: super.setScale still drives this.scale (placement·user)');
}

// ── 6. zoom getter reads the LIVE ScaleModel (last write wins, not a stale copy) ──────────
{
  const f = new FramedGlyphField();
  f._initScale(1);
  f.setZoom(2);
  f.setZoom(7);
  ok(f.zoom === 7, 'zoom getter reads the live ScaleModel (last write wins)');
}

console.log(`framed-scale: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
