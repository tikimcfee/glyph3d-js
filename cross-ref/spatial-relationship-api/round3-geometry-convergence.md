# Round 3: Geometry Convergence

## Settled

All three agents agree on every substantive point. No tensions remain after Round 1.

1. **Shared `spatialHelpers.js` module must exist before any command file is written.** All three reviews independently called for it. It contains `resolveGrid`, `getWorldAABB`, `computeAnchor`, `unionBounds`, and `fmtVec`. All command files import from it instead of defining their own copies.

2. **`resolveGrid` signature: `resolveGrid(grids, arg, label?)`** -- composition's signature wins. Grids array first (consistent with collection-oriented APIs), optional label for better error messages. Geometry's `resolveGrid(arg, grids)` is retired.

3. **Matrix update method: `updateWorldMatrix(true, true)`** everywhere. Composition's choice is more correct (updates ancestors then descendants). Geometry's `updateMatrixWorld(true)` works but is the older API and wasteful on leaf nodes. Navigation's omission of any matrix update is a bug. All three modules use the same call.

4. **Navigation must call `updateWorldMatrix(true, true)` before every `getBounds()`.** Both `unionBoundsFromIndices` and `createTourAnnotation` are buggy without it. This is the highest-priority fix -- it causes stale bounds after any composition command in the same frame.

5. **Navigation must fail on invalid grid indices**, not silently skip them. Match geometry's error-returning behavior.

6. **Navigation must check `isEmpty()` on each Box3** before accumulating into the union. Empty boxes inject Infinity values.

7. **Single `grid.bounds` registration.** Merge geometry's richer data payload (center, width/height/depth as top-level fields) with composition's anchor listings in the TUI output. One command, one registration point.

8. **Canonical bounds shape: `{ min, max, size: { x, y, z }, center: { x, y, z } }`** with size as a vec3 (matches `THREE.Box3.getSize()` output). Navigation already uses `size: { x, y, z }`. Geometry's `width`/`height`/`depth` top-level fields are dropped from the shared type, though the TUI display can still show them as labels.

9. **Single anchor implementation.** Geometry's function-map `ANCHORS` and composition's switch-statement `getAnchorPoint` compute identical results for all 9 anchor names. Merge into one `computeAnchor(box3, name)` function in `spatialHelpers.js`. Both command files import it.

10. **Navigation's `tour.play` must call `zDistanceForFit()` helper** instead of re-deriving the math inline. Eliminates drift risk.

11. **Navigation's `createTourAnnotation` should use anchor-based placement** (equivalent to `computeAnchor(bounds, 'top')` + gap offset) instead of hardcoded `bounds.min.x` / `bounds.max.y + 2` / `bounds.max.z + 1`. Aligns with composition's `grid.attach above` semantics.

12. **`CodeTour.build()` has swapped arguments** -- `durationMs` and `annotB64` are in wrong order vs the `tour.stop` handler. Fix the argument order.

13. **`camera.frame.bounds` should accept Z coordinates** rather than hardcoding `z: 0`. Geometry always includes Z in bounds (for Z-wrapped content), and dropping it silently is wrong.

---

## Implementation Plan

### File 1: `examples/github-viewer/websocket/commands/spatialHelpers.js` (NEW)

Shared pure-function module. No command registration, no router dependency. All three command files import from it.

```js
/**
 * Shared spatial math helpers for geometry, composition, and navigation commands.
 * Pure functions -- no command router, no DOM, no side effects.
 */

import * as THREE from 'three';

// ---- Grid Resolution ----

/**
 * Validate a grid index from a raw string argument.
 * @param {Array} grids - array of CodeGrid instances
 * @param {string} arg - raw string index from command args
 * @param {string} [label='grid'] - label for error messages (e.g. 'source', 'target')
 * @returns {{ grid: Object, idx: number } | { error: string }}
 */
export function resolveGrid(grids, arg, label = 'grid') {
    const idx = parseInt(arg);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { error: `ERR: invalid ${label} index ${arg} (valid: 0-${grids.length - 1})` };
    }
    return { grid: grids[idx], idx };
}

// ---- World-Space Bounds ----

const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Get world-space AABB for a grid as a serializable object.
 * Forces matrix update before reading bounds.
 * @param {Object} grid - CodeGrid instance
 * @returns {{ min: {x,y,z}, max: {x,y,z}, size: {x,y,z}, center: {x,y,z} } | null}
 */
export function getWorldAABB(grid) {
    grid.updateWorldMatrix(true, true);
    const box3 = grid.getBounds();
    if (!box3 || box3.isEmpty()) return null;

    box3.getSize(_size);
    box3.getCenter(_center);

    return {
        min: { x: box3.min.x, y: box3.min.y, z: box3.min.z },
        max: { x: box3.max.x, y: box3.max.y, z: box3.max.z },
        size: { x: _size.x, y: _size.y, z: _size.z },
        center: { x: _center.x, y: _center.y, z: _center.z },
    };
}

/**
 * Get world-space THREE.Box3 for a grid (for callers that need the raw Box3).
 * Forces matrix update before reading bounds.
 * @param {Object} grid - CodeGrid instance
 * @returns {THREE.Box3 | null}
 */
export function getWorldBox3(grid) {
    grid.updateWorldMatrix(true, true);
    const box3 = grid.getBounds();
    if (!box3 || box3.isEmpty()) return null;
    return box3;
}

/**
 * Compute the union AABB of multiple grids by index.
 * Fails on invalid indices (does not skip them).
 * @param {Array} grids
 * @param {number[]} indices
 * @returns {{ bounds: { min, max, size, center }, resolvedIndices: number[] } | { error: string }}
 */
export function unionBounds(grids, indices) {
    const unionBox = new THREE.Box3();
    const resolvedIndices = [];

    for (const idx of indices) {
        if (idx < 0 || idx >= grids.length) {
            return { error: `ERR: invalid grid index ${idx} (valid: 0-${grids.length - 1})` };
        }
        const box3 = getWorldBox3(grids[idx]);
        if (!box3) {
            return { error: `ERR: grid ${idx} has no content bounds` };
        }
        unionBox.union(box3);
        resolvedIndices.push(idx);
    }

    if (resolvedIndices.length === 0) {
        return { error: 'ERR: no valid grids' };
    }

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    unionBox.getSize(size);
    unionBox.getCenter(center);

    return {
        resolvedIndices,
        bounds: {
            min: { x: unionBox.min.x, y: unionBox.min.y, z: unionBox.min.z },
            max: { x: unionBox.max.x, y: unionBox.max.y, z: unionBox.max.z },
            size: { x: size.x, y: size.y, z: size.z },
            center: { x: center.x, y: center.y, z: center.z },
        }
    };
}

// ---- Anchor Resolution ----

/**
 * Compute a named anchor point on a bounding box.
 * Accepts either a THREE.Box3 or a plain { min, max } object.
 * @param {Object} bounds - { min: {x,y,z}, max: {x,y,z} }
 * @param {string} name - anchor name
 * @returns {{ x, y, z } | null} null if name is invalid
 */
export function computeAnchor(bounds, name) {
    const minX = bounds.min.x, maxX = bounds.max.x;
    const minY = bounds.min.y, maxY = bounds.max.y;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;

    switch (name) {
        case 'top-left':     return { x: minX, y: maxY, z: cz };
        case 'top':          return { x: cx,   y: maxY, z: cz };
        case 'top-right':    return { x: maxX, y: maxY, z: cz };
        case 'leading':      return { x: minX, y: cy,   z: cz };
        case 'center':       return { x: cx,   y: cy,   z: cz };
        case 'trailing':     return { x: maxX, y: cy,   z: cz };
        case 'bottom-left':  return { x: minX, y: minY, z: cz };
        case 'bottom':       return { x: cx,   y: minY, z: cz };
        case 'bottom-right': return { x: maxX, y: minY, z: cz };
        default:             return null;
    }
}

/** All valid anchor names */
export const ANCHOR_NAMES = [
    'top-left', 'top', 'top-right',
    'leading', 'center', 'trailing',
    'bottom-left', 'bottom', 'bottom-right',
];

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

### File 2: `spatialCommands.js` (geometry commands)

Remove local `resolveGrid`, `getWorldAABB`, `fmtVec`, and `ANCHORS`. Import from `spatialHelpers.js`:

```js
import { resolveGrid, getWorldAABB, unionBounds, computeAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';
```

- `grid.bounds` -- uses `getWorldAABB()`, returns canonical shape. TUI displays `size.x` as "width", `size.y` as "height", `size.z` as "depth" for readability. Also lists all 9 anchor points in TUI output (merged from composition's version).
- `grid.bounds.union` -- delegates to `unionBounds()`.
- `grid.anchor` -- uses `computeAnchor()`.
- `grid.distance` and `grid.overlap` -- use `getWorldBox3()` / `getWorldAABB()` from helpers.

### File 3: `spatialCommands.js` (composition commands)

Remove local `ANCHOR_NAMES`, `getAnchorPoint`, `resolveGrid`, `getGridBounds`, `anchorXCategory`, `anchorYCategory`. Import shared helpers:

```js
import { resolveGrid, getWorldBox3, computeAnchor, ANCHOR_NAMES, fmtVec } from './spatialHelpers.js';
```

- `grid.align` -- replace `getAnchorPoint(bounds, name)` with `computeAnchor(bounds, name)`.
- `grid.attach` -- same replacement.
- `grid.stack` -- same.
- `getGapDirection` stays local to composition (only composition needs it).
- Delete `grid.bounds` registration from composition (geometry owns it now, with merged TUI output).

### File 4: `navigationCommands.js`

Remove local `unionBoundsFromIndices`. Import shared helpers:

```js
import { resolveGrid, getWorldAABB, unionBounds, computeAnchor, fmtVec } from './spatialHelpers.js';
```

Changes:
- `camera.frame` -- replace `unionBoundsFromIndices(indices, grids)` with `unionBounds(grids, indices)`. Handle the `{ error }` return instead of silently skipping.
- `camera.frame.bounds` -- accept optional `z` / `zMax` parameters instead of hardcoding `z: 0`.
- `createTourAnnotation` -- replace hardcoded positioning with `computeAnchor(bounds, 'top')` + gap offset: `{ x: anchor.x, y: anchor.y + gap, z: anchor.z }`.
- `tour.play` inline Z-distance math -- delete and call `zDistanceForFit()` helper directly.
- `CodeTour.build()` -- swap `${stop.durationMs}` and `${annotB64}` to match `tour.stop` handler's expected argument order.

---

## Implementer Vote

**composition** should implement the shared `spatialHelpers.js` module and the integration across all three command files.

Rationale: Composition is the only agent whose commands both read and write grid positions, so it has the strongest intuition for which helpers need to work bidirectionally (read bounds, compute anchor, mutate position, re-read bounds). Composition's Phase 0 code already had the most defensive pattern (`getGridBounds` returning error results, `updateWorldMatrix(true, true)`), which is closest to the final shared API shape. The extraction is primarily a refactoring task -- pulling existing code into a shared module and updating imports -- which suits composition's focus on structural relationships between components.
