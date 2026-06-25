// scene-bounds.test.mjs — headless contract lock for the shared world-extent helper.
//   bun tools/scene-bounds.test.mjs
//
// worldBounds(objects, target, opts) unions the world AABBs of every bounds-bearing object
// into a reused target box — the one computation the minimap frames, the arena will draw,
// and soft camera bounds will clamp against.

import * as THREE from 'three';
import { worldBounds } from '../packages/glyph3d-core/src/services/spatial/sceneBounds.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  ✗ ${m}`); } };

// A bounds-bearing object: just the getBounds() the helper reads.
const surf = (cx, cy, cz, h = 10) => {
  const box = new THREE.Box3(new THREE.Vector3(cx - h, cy - h, cz - h), new THREE.Vector3(cx + h, cy + h, cz + h));
  return { getBounds: () => box };
};
const T = () => new THREE.Box3();

// ── 1. unions every box ──────────────────────────────────────────────────────────────
{
  const b = worldBounds([surf(0, 0, 0), surf(100, 0, 0)], T());
  ok(b.min.x === -10 && b.max.x === 110 && b.min.y === -10 && b.max.y === 10, 'unions all boxes into one extent');
}

// ── 2. empty input → empty box ───────────────────────────────────────────────────────
ok(worldBounds([], T()).isEmpty(), 'no objects → empty box');

// ── 3. skips null / no-getBounds / empty-bounds entries ──────────────────────────────
{
  const empty = { getBounds: () => new THREE.Box3() };   // makeEmpty by default
  const b = worldBounds([surf(0, 0, 0, 5), empty, {}, null, undefined], T());
  ok(b.min.x === -5 && b.max.x === 5, 'skips null / missing getBounds / empty bounds');
}

// ── 4. target is RESET each call — no stale accumulation across calls ─────────────────
{
  const t = T();
  worldBounds([surf(0, 0, 0, 5)], t);
  worldBounds([surf(50, 0, 0, 5)], t);                   // must NOT still include the first
  ok(t.min.x === 45 && t.max.x === 55, 'target is emptied each call (no stale union)');
}

// ── 5. expandToInclude stretches the box to cover a point (e.g. the camera eye) ──────
{
  const b = worldBounds([surf(0, 0, 0, 5)], T(), { expandToInclude: new THREE.Vector3(100, 0, 0) });
  ok(b.max.x === 100 && b.min.x === -5, 'expandToInclude stretches to the point');
}

// ── 6. without expandToInclude the box is just the content (constraint use-case) ─────
ok(worldBounds([surf(0, 0, 0, 5)], T()).max.x === 5, 'no expandToInclude → content-only extent');

// ── 7. returns the same target instance it was given ─────────────────────────────────
{
  const t = T();
  ok(worldBounds([surf(0, 0, 0)], t) === t, 'returns the passed-in target');
}

// ── 8. opts.skip excludes objects by identity (e.g. camera-locked dock chrome) ───────
{
  const tile = surf(500, 0, 0, 5);                       // a far box we want left out of the union
  const content = surf(0, 0, 0, 5);
  const b = worldBounds([content, tile], T(), { skip: new Set([tile]) });
  ok(b.min.x === -5 && b.max.x === 5, 'opts.skip drops skipped objects (the dock tile never widens the extent)');
}

// ── 9. a null/absent skip set excludes nothing ───────────────────────────────────────
{
  const b = worldBounds([surf(0, 0, 0, 5), surf(500, 0, 0, 5)], T(), { skip: null });
  ok(b.max.x === 505, 'skip:null → nothing excluded (unions everything)');
}

console.log(`\nscene-bounds: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
