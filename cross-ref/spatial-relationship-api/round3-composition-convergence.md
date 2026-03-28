# Round 3: Composition Convergence

## Settled

1. **Shared `spatialHelpers.js` module is required.** All three agents independently implement `resolveGrid`, world-bounds retrieval, and anchor resolution. All three reviewers call for extraction into a single shared module. No dissent.

2. **`resolveGrid(grids, arg, label?)` signature wins.** Composition's argument order (grids first, then arg, then optional label for error messages) is more ergonomic and was endorsed by navigation. Geometry's `resolveGrid(arg, grids)` yields.

3. **Use `updateWorldMatrix(true, true)` everywhere.** Geometry and navigation both flagged the inconsistency (E3 across reviews). `updateWorldMatrix(true, true)` is the modern Three.js API and handles stale parent transforms that `updateMatrixWorld(true)` can miss. All modules adopt this.

4. **Navigation's `unionBoundsFromIndices` must call `updateWorldMatrix(true, true)` before `getBounds()`.** Identified as the most dangerous bug by all three reviewers -- after composition repositions grids, the next `camera.frame` reads stale bounds. One-liner fix per grid in the loop.

5. **Navigation's `createTourAnnotation` must also call `updateWorldMatrix(true, true)` before `getBounds()`.** Same bug, different call site. Annotation placement coordinates are stale after any composition command in the same frame.

6. **Navigation's `tour.play` must call `zDistanceForFit()` instead of inlining the FOV math.** Duplicated calculation at lines 544-549 will silently diverge if the helper ever gains margin correction or min-distance clamp. All reviewers flagged this.

7. **`grid.bounds` command is registered once, merging geometry and composition schemas.** Both cannot coexist on the same router. The merged version includes geometry's `center` field and composition's anchor listings. Single registration, single source of truth.

8. **Canonical bounds shape is `{ min, max, size: { x, y, z }, center: { x, y, z } }`.** Navigation's `size: { x, y, z }` pattern matches Three.js `Box3.getSize()` output and is a proper vec3. Geometry's flat `width/height/depth` fields are dropped in favor of `size.x/y/z`. All three modules adopt this shape.

9. **Anchor computation is a single shared function: `resolveAnchor(box3OrAABB, name)`.** Geometry's `ANCHORS` map and composition's `getAnchorPoint` switch statement compute identical results for identical names. One function, imported by both command files.

10. **Navigation should fail loudly on invalid grid indices** rather than `continue`-ing in `unionBoundsFromIndices`. Geometry's approach (return error immediately) is correct. Silent partial results are a downstream debugging nightmare.

11. **Navigation's `unionBoundsFromIndices` must check `box3.isEmpty()`** before accumulating. An empty Box3 contributes `Infinity`/`-Infinity` to the union, corrupting the result.

12. **`CodeTour.build()` argument order is swapped** -- `durationMs` and `annotB64` are transposed relative to the `tour.stop` handler's expected order. Composition's review caught this; navigation's review did not dispute it.

13. **Tour annotations should use shared anchor resolution** (`resolveAnchor(bounds, 'top')` + gap offset) instead of hardcoded `+2`/`+1` offsets. This aligns with composition's `grid.attach above` semantics and handles varying grid scales correctly.

## Implementation Plan

### File 1: `examples/github-viewer/websocket/commands/spatialHelpers.js` (NEW)

Shared pure-function module. No command registration, no router dependency. All three command files import from here.

```js
/**
 * Shared spatial math helpers for geometry, composition, and navigation commands.
 * Pure functions -- no router, no DOM, no side effects.
 */

import * as THREE from 'three';

// ---- Grid Resolution ----

/**
 * Resolve and validate a grid index from a raw arg string.
 * @param {Array} grids
 * @param {string} arg - raw string to parse as integer index
 * @param {string} [label='grid'] - label for error messages
 * @returns {{ grid: Object, idx: number } | { error: string }}
 */
export function resolveGrid(grids, arg, label = 'grid') {
    const idx = parseInt(arg);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { error: `ERR: invalid ${label} index ${arg} (0-${grids.length - 1})` };
    }
    return { grid: grids[idx], idx };
}

// ---- World Bounds ----

/**
 * Get a grid's world-space AABB as a canonical plain object.
 * Forces matrix update to handle just-repositioned grids.
 * @param {Object} grid - CodeGrid instance
 * @returns {{ min: {x,y,z}, max: {x,y,z}, size: {x,y,z}, center: {x,y,z} } | null}
 */
export function getWorldBounds(grid) {
    grid.updateWorldMatrix(true, true);
    const box3 = grid.getBounds();
    if (box3.isEmpty()) return null;
    return box3ToAABB(box3);
}

/**
 * Convert a THREE.Box3 to the canonical AABB plain object.
 * @param {THREE.Box3} box3
 * @returns {{ min: {x,y,z}, max: {x,y,z}, size: {x,y,z}, center: {x,y,z} }}
 */
export function box3ToAABB(box3) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box3.getSize(size);
    box3.getCenter(center);
    return {
        min: { x: box3.min.x, y: box3.min.y, z: box3.min.z },
        max: { x: box3.max.x, y: box3.max.y, z: box3.max.z },
        size: { x: size.x, y: size.y, z: size.z },
        center: { x: center.x, y: center.y, z: center.z },
    };
}

/**
 * Compute the union AABB of multiple grids by index.
 * Fails on invalid indices and empty grids.
 * @param {Array} grids
 * @param {number[]} indices
 * @returns {{ bounds: {min,max,size,center}, indices: number[] } | { error: string }}
 */
export function unionBounds(grids, indices) {
    const unionBox = new THREE.Box3();
    const validIndices = [];

    for (const idx of indices) {
        if (idx < 0 || idx >= grids.length) {
            return { error: `ERR: invalid grid index ${idx} (0-${grids.length - 1})` };
        }
        grids[idx].updateWorldMatrix(true, true);
        const box3 = grids[idx].getBounds();
        if (box3.isEmpty()) {
            return { error: `ERR: grid ${idx} has no content bounds` };
        }
        unionBox.union(box3);
        validIndices.push(idx);
    }

    if (validIndices.length === 0) {
        return { error: 'ERR: no valid grids provided' };
    }

    return { bounds: box3ToAABB(unionBox), indices: validIndices };
}

// ---- Anchors ----

/** @type {Record<string, (aabb: {min:{x,y,z}, max:{x,y,z}}) => {x:number,y:number,z:number}>} */
const ANCHORS = {
    'top-left':     (b) => ({ x: b.min.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'top':          (b) => ({ x: (b.min.x + b.max.x) / 2, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'top-right':    (b) => ({ x: b.max.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'leading':      (b) => ({ x: b.min.x, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'center':       (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'trailing':     (b) => ({ x: b.max.x, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'bottom-left':  (b) => ({ x: b.min.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom':       (b) => ({ x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom-right': (b) => ({ x: b.max.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
};

/** All valid anchor names. */
export const ANCHOR_NAMES = Object.keys(ANCHORS);

/**
 * Resolve a named anchor point on an AABB.
 * Accepts either canonical AABB ({min, max}) or THREE.Box3.
 * @param {Object} bounds - { min: {x,y,z}, max: {x,y,z} }
 * @param {string} name - anchor name
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function resolveAnchor(bounds, name) {
    const fn = ANCHORS[name.toLowerCase()];
    return fn ? fn(bounds) : null;
}

// ---- Formatting ----

/**
 * Format a vec3 for TUI display.
 * @param {{ x: number, y: number, z: number }} v
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function fmtVec(v, decimals = 2) {
    return `${v.x.toFixed(decimals)}, ${v.y.toFixed(decimals)}, ${v.z.toFixed(decimals)}`;
}
```

### File 2: `examples/github-viewer/websocket/commands/spatialCommands.js` (geometry)

Refactor to import from `spatialHelpers.js`. Delete local `resolveGrid`, `getWorldAABB`, `ANCHORS`, `fmtVec`. Replace `getWorldAABB` calls with `getWorldBounds`. Replace `ANCHORS[name]` with `resolveAnchor(aabb, name)`. Replace `updateMatrixWorld(true)` with the helper (which uses `updateWorldMatrix(true, true)` internally). Update `grid.bounds` response data to use `size: { x, y, z }` instead of flat `width/height/depth`. Add `center` to data payload. Remove duplicate `grid.bounds.union` implementation -- call `unionBounds()` from helpers.

Key changes:
- `import { resolveGrid, getWorldBounds, unionBounds, resolveAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';`
- `grid.bounds` data shape: `{ index, bounds: { min, max, size, center } }`
- `grid.bounds` TUI includes anchor listing (from composition's design)
- `grid.bounds.union` delegates to `unionBounds(grids, indices)`
- `grid.anchor` uses `resolveAnchor(aabb, name)` instead of local `ANCHORS` map

### File 3: `examples/github-viewer/websocket/commands/compositionCommands.js` (composition)

Refactor to import from `spatialHelpers.js`. Delete local `ANCHOR_NAMES`, `getAnchorPoint`, `getGapDirection` helper's anchor category functions (these stay since they are composition-specific gap logic), and `resolveGrid`. Replace `getAnchorPoint(bounds, name)` with `resolveAnchor(bounds, name)`. Replace `grid.updateWorldMatrix(true, true)` calls with `getWorldBounds(grid)` where full AABB is needed. Remove the local `grid.bounds` registration entirely -- geometry owns it with the merged schema.

Key changes:
- `import { resolveGrid, getWorldBounds, resolveAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';`
- Delete local `grid.bounds` registration (geometry's merged version handles it)
- `grid.align`, `grid.attach`, `grid.stack` use `resolveAnchor()` from helpers
- Gap direction logic remains local (it is composition-specific, not shared)

### File 4: `examples/github-viewer/websocket/commands/navigationCommands.js` (navigation)

Refactor to import from `spatialHelpers.js`. Delete local `unionBoundsFromIndices`. Replace with `unionBounds()` from helpers. Fix `createTourAnnotation` to use `getWorldBounds(grid)` (which calls `updateWorldMatrix`) instead of bare `grid.getBounds()`. Replace hardcoded annotation offsets with `resolveAnchor(bounds, 'top')` plus gap. Fix `tour.play` to call `zDistanceForFit()` instead of inlining FOV math. Fix `CodeTour.build()` argument order (swap `durationMs` and `annotB64`).

Key changes:
- `import { resolveGrid, getWorldBounds, unionBounds, resolveAnchor, fmtVec } from './spatialHelpers.js';`
- `camera.frame` calls `unionBounds(grids, indices)` -- gets matrix updates and empty-box checks for free
- `createTourAnnotation`: `const bounds = getWorldBounds(grid);` then `const anchor = resolveAnchor(bounds, 'top'); const pos = { x: anchor.x, y: anchor.y + gap, z: anchor.z };`
- `tour.play` line ~547: replace inline math with `const z = zDistanceForFit(ctx.camera, w, h);`
- `CodeTour.build()`: swap `${stop.durationMs} ${annotB64}` to `${annotB64} ${stop.durationMs}`

## Implementer Vote

**geometry** (the geometry agent) should implement this.

Rationale: The largest deliverable is `spatialHelpers.js`, which is fundamentally a geometry-math module. Geometry authored the most complete and bug-free versions of `resolveGrid`, `getWorldAABB`, and the anchor map in Phase 0. The refactoring of all three command files is mechanical once the helpers exist. Geometry is best positioned to get the math right on the first pass and to validate that the canonical AABB shape works correctly with Three.js `Box3` edge cases (empty boxes, non-identity transforms, Z-wrapped content).
