// bounds-measurable.test.mjs — headless, GPU-free behavior lock for MeasurableObject3D.
//
//   bun tools/bounds-measurable.test.mjs
//
// MeasurableObject3D is the on-demand bounds base: getBounds() recomputes the WORLD
// AABB fresh on every call (local content box × current matrixWorld) — no validity
// cache, no dirty flag, no transform observation. This test pins exactly that contract:
// every transform / content change is reflected on the NEXT getBounds() with zero
// staleness, and the world box always equals the reference formula
// getLocalBounds().clone().applyMatrix4(matrixWorld). Pure three — no WebGPU.

import * as THREE from 'three';
import MeasurableObject3D from '../packages/glyph3d-core/src/collections/MeasurableObject3D.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${msg}`); } };

// Box3 equality with a from-scratch tolerance (transforms accumulate float error).
const EPS = 1e-9;
const boxEq = (a, b, msg) => ok(
  Math.abs(a.min.x - b.min.x) < EPS && Math.abs(a.min.y - b.min.y) < EPS && Math.abs(a.min.z - b.min.z) < EPS &&
  Math.abs(a.max.x - b.max.x) < EPS && Math.abs(a.max.y - b.max.y) < EPS && Math.abs(a.max.z - b.max.z) < EPS,
  `${msg}\n      got  min=${JSON.stringify(a.min)} max=${JSON.stringify(a.max)}\n      want min=${JSON.stringify(b.min)} max=${JSON.stringify(b.max)}`,
);

// Independent oracle — NOT the implementation. The reference formula a consumer would
// write by hand: take the object's current local box and apply its current matrixWorld.
// We recompute matrixWorld from scratch here so we don't trust the object's own update.
const oracle = (obj, local) => {
  obj.updateWorldMatrix(true, false);
  return local.clone().applyMatrix4(obj.matrixWorld);
};

// A minimal Measurable subclass whose local content box is MUTABLE — the knob that lets
// us prove a content change (not just a transform) lands immediately.
class MutableMeasurable extends MeasurableObject3D {
  constructor(min = [-1, -1, -1], max = [1, 1, 1]) {
    super();
    this._local = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  }
  setLocal(min, max) {
    this._local.min.set(...min);
    this._local.max.set(...max);
  }
  // Returns a reused box (mirrors CodeGrid.getLocalBounds reuse semantics).
  getLocalBounds() { return this._local; }
}

// ── 1. position change reflected on the NEXT call (no staleness) ──────────────────────
{
  const m = new MutableMeasurable([-2, -2, -2], [2, 2, 2]);
  const before = m.getBounds().clone();                      // box at origin
  m.position.set(10, 0, 0);                                  // move — no invalidation call
  const after = m.getBounds().clone();
  ok(Math.abs(before.min.x - (-2)) < EPS, 'position: initial world box at origin');
  ok(Math.abs(after.min.x - 8) < EPS && Math.abs(after.max.x - 12) < EPS,
     'position: next getBounds() reflects the move immediately (no cache)');
  boxEq(after, oracle(m, m.getLocalBounds()), 'position: world box == oracle after move');
}

// ── 2. scale change reflected immediately ─────────────────────────────────────────────
{
  const m = new MutableMeasurable([-1, -1, -1], [1, 1, 1]);
  m.getBounds();                                             // prime (would seed a cache if one existed)
  m.scale.set(3, 1, 1);
  const after = m.getBounds().clone();
  ok(Math.abs(after.min.x - (-3)) < EPS && Math.abs(after.max.x - 3) < EPS,
     'scale: next getBounds() reflects the scale immediately');
  boxEq(after, oracle(m, m.getLocalBounds()), 'scale: world box == oracle after scale');
}

// ── 3. content (getLocalBounds) change reflected immediately ──────────────────────────
{
  const m = new MutableMeasurable([-1, -1, -1], [1, 1, 1]);
  m.position.set(5, 0, 0);
  m.getBounds();                                             // prime
  m.setLocal([-4, -1, -1], [4, 1, 1]);                      // content grew along x
  const after = m.getBounds().clone();
  ok(Math.abs(after.min.x - 1) < EPS && Math.abs(after.max.x - 9) < EPS,
     'content: next getBounds() reflects the local-box change immediately');
  boxEq(after, oracle(m, m.getLocalBounds()), 'content: world box == oracle after content change');
}

// ── 4. getBounds() == getLocalBounds().clone().applyMatrix4(matrixWorld) — full TRS ──
{
  const m = new MutableMeasurable([-2, -1, -0.5], [3, 2, 0.5]);
  m.position.set(7, -3, 2);
  m.rotation.set(0.3, -0.6, 1.1);
  m.scale.set(2, 0.5, 4);
  const got = m.getBounds().clone();
  boxEq(got, oracle(m, m.getLocalBounds()), 'reference formula: world box == local × matrixWorld under full TRS');
}

// ── 5. idempotent: two calls with no change return EQUAL boxes ────────────────────────
{
  const m = new MutableMeasurable([-1.5, -2.5, -3.5], [1.5, 2.5, 3.5]);
  m.position.set(2, 4, 6);
  m.rotation.set(0.2, 0.4, 0.6);
  const a = m.getBounds().clone();
  const b = m.getBounds().clone();
  boxEq(a, b, 'idempotent: getBounds() twice with no change returns equal boxes');
}

// ── 6. empty local box stays empty in world (guard path) ──────────────────────────────
{
  const m = new MutableMeasurable();
  m._local.makeEmpty();
  m.position.set(100, 0, 0);
  ok(m.getBounds().isEmpty(), 'empty: empty local box yields empty world box (no spurious transform)');
}

// ── 7. abstract contract: a subclass that forgets getLocalBounds() throws clearly ─────
{
  class Bad extends MeasurableObject3D {}
  let threw = false;
  try { new Bad().getBounds(); } catch (e) { threw = /getLocalBounds/.test(e.message); }
  ok(threw, 'contract: missing getLocalBounds() throws a Measurable-contract error');
}

// ── 8. TerminalGrid swap: inherited getBounds() == TG's old hand-rolled formula ───────
// TG used to cache a _worldBounds and do updateWorldMatrix → _worldBounds.copy(local) →
// applyMatrix4. UNIT-005 dropped that; the base owns it now. This stand-in replicates TG's
// panel local box (cached, dirtied on resize, never empty) and proves the inherited world
// box is identical under full TRS, and that a resize lands with zero staleness.
{
  class TerminalLike extends MeasurableObject3D {
    constructor(cols, rows) { super(); this.cols = cols; this.rows = rows; this._local = null; this._dirty = true; }
    getLocalBounds() {
      if (!this._local || this._dirty) {
        const strideX = 1.2, strideY = 1.5, pad = 0.3;        // arbitrary metrics (shape, not values, is the point)
        const width = this.cols * strideX + pad * 2, height = this.rows * strideY + pad * 2;
        const cx = (this.cols * strideX) / 2 - strideX / 2, cy = -(this.rows * strideY) / 2 + strideY / 2;
        this._local = new THREE.Box3(
          new THREE.Vector3(cx - width / 2, cy - height / 2, -1),
          new THREE.Vector3(cx + width / 2, cy + height / 2,  1),
        );
        this._dirty = false;
      }
      return this._local;                                     // cached + reused (mirrors TG)
    }
  }
  const t = new TerminalLike(80, 24);
  t.position.set(4, -2, 1); t.rotation.set(0.2, 0.5, -0.3); t.scale.set(2, 2, 1);
  boxEq(t.getBounds(), oracle(t, t.getLocalBounds()), 'TerminalGrid swap: inherited world box == old hand-rolled formula (full TRS)');
  t.cols = 120; t._dirty = true;                              // resize → local-cache dirty
  boxEq(t.getBounds(), oracle(t, t.getLocalBounds()), 'TerminalGrid swap: resize reflected on next getBounds() (no staleness)');
}

// ── 9. FrameGrid swap: inherited getBounds() == FG's old formula; shared scratch is safe ─
// FG used to return a FRESH box every call (getLocalBounds().applyMatrix4). The base returns
// a per-instance REUSED scratch. The one real risk is object identity: TreemapLayoutManager
// reads two getBounds() of the SAME frame in one expression (getBounds().max.y -
// getBounds().min.y). Prove the world VALUE matches the old formula AND that the double-call
// height is correct despite both reads hitting the same scratch object.
{
  class FrameLike extends MeasurableObject3D {
    constructor(width, aspect) { super(); this.width = width; this.aspect = aspect; }
    getLocalBounds() {
      const totalH = this.width / this.aspect, hw = this.width / 2, hh = totalH / 2;
      return new THREE.Box3(new THREE.Vector3(-hw, -hh, -0.5), new THREE.Vector3(hw, hh, 0.5)); // fresh each call (mirrors FG)
    }
  }
  const f = new FrameLike(6, 1.5);
  f.position.set(-3, 5, 0); f.rotation.set(0, 0.7, 0); f.scale.set(1.5, 1.5, 1);
  boxEq(f.getBounds(), oracle(f, f.getLocalBounds()), 'FrameGrid swap: inherited world box == old fresh-box formula (full TRS)');
  const height = f.getBounds().max.y - f.getBounds().min.y;   // two getBounds() on one instance → shared scratch
  const ref = oracle(f, f.getLocalBounds());
  ok(Math.abs(height - (ref.max.y - ref.min.y)) < EPS,
     'FrameGrid swap: double getBounds() in one expression yields correct height (shared scratch is deterministic)');
}

console.log(`bounds-measurable: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
