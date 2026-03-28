# Round 3: Navigation Convergence

## Settled

1. **Shared `spatialHelpers.js` module is required.** All three agents independently concluded that `resolveGrid`, `getWorldAABB`, anchor resolution, `unionBounds`, and `fmtVec` must live in a single shared module. No dissent.

2. **`updateMatrixWorld(true)` before every `getBounds()` call.** Navigation's omission is the highest-priority bug. Geometry and composition both flagged it. The method choice is `updateMatrixWorld(true)` (force=true guarantees freshness regardless of dirty-flag state, safer than `updateWorldMatrix(true, true)` which relies on flag propagation). All agents agree one method must be picked; geometry's `updateMatrixWorld(true)` is the conservative choice.

3. **Single `grid.bounds` registration.** Geometry and composition both define `grid.bounds` -- the second silently overwrites the first on the router. Merge into one command that returns the union of both payloads: `{ min, max, width, height, depth, center }` (from geometry) plus anchor point listings in the TUI text (from composition). Registered once, in `spatialCommands.js`.

4. **Canonical bounds shape: `{ min, max, width, height, depth, center }`.** Navigation's `size: { x, y, z }` and composition's nested `size: { width, height, depth }` both lose to geometry's flat shape. `width`/`height`/`depth` are more readable than `size.x`/`size.y`/`size.z` for a code-visualization domain where those axes have semantic meaning. `center` is always included (composition omitted it -- fixed).

5. **Unified `resolveGrid(grids, arg, label?)` signature.** Composition's argument order wins (grids first, then arg, then optional label for error messages). Geometry's `resolveGrid(arg, grids)` is less ergonomic. All three agents agree on unification.

6. **Anchor computation is a single shared function.** Geometry's `ANCHORS` map-of-functions and composition's `getAnchorPoint` switch statement compute identical results for all 9 anchors. One implementation in `spatialHelpers.js`. Both geometry commands and composition commands import it.

7. **Navigation's `tour.play` must call `zDistanceForFit()` instead of inlining the math.** Duplicated FOV/aspect calculation at lines 544-549 is a maintenance hazard. All agents flagged it.

8. **`unionBoundsFromIndices` must fail on invalid indices, not silently skip.** Geometry's `resolveGrid` returns errors. Navigation silently continues. Silent partial results are dangerous for camera framing (the user thinks they framed 3 grids but only 2 were valid).

9. **`unionBoundsFromIndices` must check `isEmpty()` on each box.** An empty Box3 contributes Infinity/-Infinity to the union, corrupting the result.

10. **`CodeTour.build()` has swapped argument order** for `tour.stop` -- sends `${stop.durationMs} ${annotB64}` but the handler expects `[base64-annotation] [duration-ms]`. The `play()` method gets it right. This is a confirmed bug.

11. **Tour annotations should use anchor-based placement** instead of hardcoded `+2`/`+1` offsets. `resolveAnchor(bounds, 'top')` plus a configurable gap aligns annotation positioning with composition's `grid.attach above` behavior and handles varying grid scales and Z-wrapped content.

12. **Navigation should call the shared `unionBounds` from `spatialHelpers.js`** rather than maintaining a private `unionBoundsFromIndices`. One union implementation, one place to fix bugs.

13. **`camera.frame.bounds` should accept optional Z parameters.** Currently hardcodes `z: 0`, silently dropping Z information from geometry's bounds. Add optional `minZ`/`maxZ` args (defaulting to 0) so callers can pass Z-wrapped bounds through.

## Implementation Plan

### File 1: `examples/github-viewer/websocket/commands/spatialHelpers.js` (NEW)

Shared pure-function module. No command registration, no router dependency.

```js
import * as THREE from 'three';

/**
 * Resolve a grid index from a raw string argument.
 * @param {Array} grids
 * @param {string} arg - raw string to parse as integer
 * @param {string} [label='grid'] - label for error messages
 * @returns {{ grid: Object, idx: number } | { error: string }}
 */
export function resolveGrid(grids, arg, label = 'grid') {
    const idx = parseInt(arg);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { error: `ERR: invalid ${label} index ${arg} (valid: 0-${grids.length - 1})` };
    }
    return { grid: grids[idx], idx };
}

/**
 * Get world-space AABB for a grid as a plain serializable object.
 * Forces matrixWorld update before querying.
 * @param {Object} grid - CodeGrid instance
 * @returns {{ min, max, width, height, depth, center } | null}
 */
export function getWorldAABB(grid) {
    grid.updateMatrixWorld(true);
    const box3 = grid.getBounds();
    if (!box3 || box3.isEmpty()) return null;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box3.getSize(size);
    box3.getCenter(center);

    return {
        min: { x: box3.min.x, y: box3.min.y, z: box3.min.z },
        max: { x: box3.max.x, y: box3.max.y, z: box3.max.z },
        width: size.x, height: size.y, depth: size.z,
        center: { x: center.x, y: center.y, z: center.z }
    };
}

/**
 * Get raw THREE.Box3 for a grid in world space.
 * Forces matrixWorld update. Returns null if empty.
 * @param {Object} grid - CodeGrid instance
 * @returns {THREE.Box3 | null}
 */
export function getWorldBox3(grid) {
    grid.updateMatrixWorld(true);
    const box3 = grid.getBounds();
    if (!box3 || box3.isEmpty()) return null;
    return box3;
}

/** Anchor name -> function from plain AABB -> {x,y,z} */
export const ANCHORS = {
    'top-left':     (b) => ({ x: b.min.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'top-right':    (b) => ({ x: b.max.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom-left':  (b) => ({ x: b.min.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom-right': (b) => ({ x: b.max.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'center':       (b) => ({ x: (b.min.x+b.max.x)/2, y: (b.min.y+b.max.y)/2, z: (b.min.z+b.max.z)/2 }),
    'top':          (b) => ({ x: (b.min.x+b.max.x)/2, y: b.max.y, z: (b.min.z+b.max.z)/2 }),
    'bottom':       (b) => ({ x: (b.min.x+b.max.x)/2, y: b.min.y, z: (b.min.z+b.max.z)/2 }),
    'leading':      (b) => ({ x: b.min.x, y: (b.min.y+b.max.y)/2, z: (b.min.z+b.max.z)/2 }),
    'trailing':     (b) => ({ x: b.max.x, y: (b.min.y+b.max.y)/2, z: (b.min.z+b.max.z)/2 }),
};

/** All valid anchor names. */
export const ANCHOR_NAMES = Object.keys(ANCHORS);

/**
 * Resolve a named anchor point on an AABB.
 * @param {{ min, max }} aabb - plain object with min/max {x,y,z}
 * @param {string} name - anchor name
 * @returns {{ x, y, z } | null}
 */
export function resolveAnchor(aabb, name) {
    const fn = ANCHORS[name];
    return fn ? fn(aabb) : null;
}

/**
 * Compute union AABB of multiple grids by index.
 * Fails on invalid indices or empty bounds.
 * @param {number[]} indices
 * @param {Array} grids
 * @returns {{ bounds: { min, max, width, height, depth, center }, indices: number[] } | { error: string }}
 */
export function unionBounds(indices, grids) {
    const unionBox = new THREE.Box3();
    const validIndices = [];

    for (const idx of indices) {
        if (idx < 0 || idx >= grids.length) {
            return { error: `ERR: invalid grid index ${idx} (valid: 0-${grids.length - 1})` };
        }
        const box3 = getWorldBox3(grids[idx]);
        if (!box3) {
            return { error: `ERR: grid ${idx} has no content (empty bounds)` };
        }
        unionBox.union(box3);
        validIndices.push(idx);
    }

    if (validIndices.length === 0) {
        return { error: 'ERR: no valid grids' };
    }

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    unionBox.getSize(size);
    unionBox.getCenter(center);

    return {
        indices: validIndices,
        bounds: {
            min: { x: unionBox.min.x, y: unionBox.min.y, z: unionBox.min.z },
            max: { x: unionBox.max.x, y: unionBox.max.y, z: unionBox.max.z },
            width: size.x, height: size.y, depth: size.z,
            center: { x: center.x, y: center.y, z: center.z }
        }
    };
}

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

### File 2: `examples/github-viewer/websocket/commands/spatialCommands.js` (REWRITE)

Geometry commands (`grid.bounds`, `grid.bounds.union`, `grid.anchor`, `grid.distance`, `grid.overlap`) plus the merged `grid.bounds` that includes anchor listings in TUI output. All helpers imported from `spatialHelpers.js`.

Key changes from Phase 0 geometry proposal:
- Import `resolveGrid`, `getWorldAABB`, `getWorldBox3`, `resolveAnchor`, `unionBounds`, `fmtVec`, `ANCHOR_NAMES` from `./spatialHelpers.js`
- Delete local copies of those functions
- `grid.bounds` TUI output includes anchor point list (merged from composition's version)
- `grid.bounds` data payload includes `center` (was missing in composition's version)
- `grid.bounds.union` delegates to shared `unionBounds()`

### File 3: `examples/github-viewer/websocket/commands/compositionCommands.js` (REWRITE)

Composition commands (`grid.align`, `grid.attach`, `grid.stack`). All helpers imported from `spatialHelpers.js`.

Key changes from Phase 0 composition proposal:
- Delete local `ANCHOR_NAMES`, `getAnchorPoint`, `resolveGrid`, `getGridBounds`
- Import `resolveGrid`, `getWorldBox3`, `resolveAnchor`, `ANCHOR_NAMES`, `fmtVec` from `./spatialHelpers.js`
- Use `updateMatrixWorld(true)` (via `getWorldBox3`) instead of `updateWorldMatrix(true, true)`
- Remove the `grid.bounds` registration (now in `spatialCommands.js`)
- Anchor computation calls `resolveAnchor()` on the plain AABB from `getWorldAABB()`, or use `getWorldBox3()` for raw Box3 math in align/attach/stack where needed

### File 4: `examples/github-viewer/websocket/commands/navigationCommands.js` (REWRITE)

Navigation commands (`camera.frame`, `camera.frame.bounds`, `tour.*`).

Key changes from Phase 0 navigation proposal:
- Delete local `unionBoundsFromIndices` -- import `unionBounds` from `./spatialHelpers.js`
- `camera.frame` calls `unionBounds(indices, grids)` and checks for `.error`
- `camera.frame` fails loudly on invalid indices (from shared `unionBounds`)
- `tour.play` lines 544-549: replace inline FOV math with `zDistanceForFit(ctx.camera, w, h, 0.85)`
- `createTourAnnotation`: call `getWorldAABB(grid)` (handles `updateMatrixWorld`) then `resolveAnchor(aabb, 'top')` for placement, offset by gap (default 2 world units)
- `camera.frame.bounds`: add optional 5th/6th args `minZ`/`maxZ` defaulting to 0
- Adapt bounds shape from `{ size: { x, y, z } }` to `{ width, height, depth }` throughout -- `frameBounds` reads `bounds.width` and `bounds.height` instead of `bounds.size.x` / `bounds.size.y`

### File 5: `examples/github-viewer/cli/CodeTour.mjs` (FIX)

Fix the `build()` method argument order bug.

```js
// Line 797 currently (WRONG):
const cmd = `tour.stop ${nameB64} ${stop.gridIndex} ${stop.durationMs} ${annotB64}`;

// Corrected (matches handler expectation and play() method):
const cmd = `tour.stop ${nameB64} ${stop.gridIndex} ${annotB64} ${stop.durationMs}`;
```

### File 6: `examples/github-viewer/websocket/commands/index.js` (EDIT)

Add imports for the three new command files:

```js
import registerSpatialCommands from './spatialCommands.js';
import registerCompositionCommands from './compositionCommands.js';
import registerNavigationCommands from './navigationCommands.js';

// In registerAllCommands():
registerSpatialCommands(router);
registerCompositionCommands(router);
registerNavigationCommands(router);
```

### Dependency graph

```
spatialHelpers.js          (0 command deps, pure math)
    ^       ^       ^
    |       |       |
spatialCommands.js  compositionCommands.js  navigationCommands.js
(geometry queries)  (position mutations)    (camera + tours)
```

## Implementer Vote

**geometry** -- The shared helpers module is the foundation, and geometry's Phase 0 proposal already contains the most correct versions of `resolveGrid`, `getWorldAABB`, `fmtVec`, `ANCHORS`, and the bounds union logic. Extracting those into `spatialHelpers.js` is a natural refactor of geometry's existing code. The geometry agent demonstrated the strongest understanding of the matrixWorld update requirements and Box3 edge cases (empty bounds, isEmpty checks) that the helpers must handle correctly.
