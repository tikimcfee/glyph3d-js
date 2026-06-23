// framed-glyphfield.test.mjs — headless, GPU-free behavior lock for the FramedGlyphField base.
//
//   bun tools/framed-glyphfield.test.mjs
//
// FramedGlyphField (BoundedObject3D → FramedGlyphField → CodeGrid/TerminalGrid/FrameGrid) lifts the
// surface the three grids used to triplicate verbatim. This pins that the lifted members reproduce
// the old per-grid inline behavior exactly. Slices, in the order they were added:
//   1. ScaleModel — _initScale(placement) + setScale/setZoom/get-zoom (scale = placement · user),
//      including the subclass stash-then-super setScale override.
//   2. renderer slot + getRenderer(), and setPickingSystem() (the glyph+grid channels, plus the
//      TerminalGrid-style override that adds a 'handle' channel after super()).

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

// ── renderer + picking slice (UNIT-008) ──────────────────────────────────────────────────
const mockPicking = () => { const calls = []; return { calls, register: (channel, token, owner) => calls.push({ channel, token, owner }) }; };

// ── 7. base ctor declares the slots: renderer + picking default to null ───────────────────
{
  const f = new FramedGlyphField();
  ok(f.getRenderer() === null, 'base ctor: _renderer defaults to null (via getRenderer)');
  ok(f._pickingSystem === null, 'base ctor: _pickingSystem defaults to null');
}

// ── 8. getRenderer returns whatever the subclass set ──────────────────────────────────────
{
  const f = new FramedGlyphField();
  const sentinel = { id: 'renderer' };
  f._renderer = sentinel;
  ok(f.getRenderer() === sentinel, 'getRenderer: returns the subclass-set renderer instance');
}

// ── 9. setPickingSystem registers glyph (renderer) + grid (background) + stores the system ─
{
  const f = new FramedGlyphField();
  const R = { id: 'R' }, B = { id: 'B' }, ps = mockPicking();
  f._renderer = R; f._background = B;
  f.setPickingSystem(ps);
  ok(f._pickingSystem === ps, 'setPickingSystem: stores the system');
  ok(ps.calls.length === 2, 'setPickingSystem: registers exactly two channels (glyph + grid)');
  ok(ps.calls.some(c => c.channel === 'glyph' && c.token === R && c.owner === R), 'setPickingSystem: glyph channel = (renderer, renderer)');
  ok(ps.calls.some(c => c.channel === 'grid' && c.token === B && c.owner === f), 'setPickingSystem: grid channel = (background, this)');
}

// ── 10. setPickingSystem(null) stores null and registers nothing ──────────────────────────
{
  const f = new FramedGlyphField();
  f._renderer = { id: 'R' }; f._background = { id: 'B' };
  f.setPickingSystem(null);
  ok(f._pickingSystem === null, 'setPickingSystem(null): stores null (and the early-return registers nothing)');
}

// ── 11. guards: a missing renderer or background skips its channel ─────────────────────────
{
  const f = new FramedGlyphField();
  const B = { id: 'B' }, ps = mockPicking();
  f._renderer = null; f._background = B;          // lazy CodeGrid before _ensureRenderer: no renderer yet
  f.setPickingSystem(ps);
  ok(ps.calls.length === 1 && ps.calls[0].channel === 'grid', 'guard: no renderer → only the grid channel registers');
}

// ── 12. TerminalGrid-style override: super registers glyph+grid, subclass adds 'handle' ───
{
  class WithHandle extends FramedGlyphField {
    setPickingSystem(ps) { super.setPickingSystem(ps); if (ps) ps.register('handle', this._handle, this); }
  }
  const f = new WithHandle();
  const R = { id: 'R' }, B = { id: 'B' }, H = { id: 'H' }, ps = mockPicking();
  f._renderer = R; f._background = B; f._handle = H;
  f.setPickingSystem(ps);
  ok(ps.calls.length === 3, 'override: super (glyph+grid) + subclass handle = 3 channels');
  ok(ps.calls.some(c => c.channel === 'handle' && c.token === H && c.owner === f), 'override: handle channel registered after super()');
}

console.log(`framed-glyphfield: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
