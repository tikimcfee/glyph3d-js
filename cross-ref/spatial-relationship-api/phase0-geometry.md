# Phase 0: Geometry Primitives for Spatial Relationship API

## How CodeGrid Reports Bounds

Two paths exist, and the distinction matters for correct spatial queries:

### Path 1: `GlyphCollection.getBounds()` (local space)

Returns a plain object (NOT a `THREE.Box3`):

```js
{
    min: { x, y, z },
    max: { x, y, z },
    width: maxX - minX,    // = max.x - min.x
    height: maxY - minY,   // = max.y - min.y
    depth: maxZ - minZ     // = max.z - min.z (for Z-wrapped text)
}
```

This is computed by iterating all committed text objects in the renderer, taking their individual bounds, and computing the union. The result is cached (`_boundsCache`) and invalidated via `_boundsDirty`. Returns `null` if no text is committed.

Source: `src/collections/GlyphCollection.js`, lines 746-804.

### Path 2: `CodeGrid.getBounds()` (world space)

Returns a `THREE.Box3`. It:
1. Gets `_collection.getBounds()` (local space, plain object)
2. Applies `backgroundPadding` to min/max (x,y only)
3. Transforms via `box.applyMatrix4(this.matrixWorld)` for world coordinates

Source: `src/collections/CodeGrid.js`, lines 248-271.

### Why This Matters for the Spatial API

`CodeGrid.getBounds()` returns a `THREE.Box3` with `.min` and `.max` as `THREE.Vector3` instances. The spatial commands can use `.min.x`, `.max.y`, etc. directly. The `width`/`height` must be recomputed from the Box3 since `THREE.Box3` doesn't store them as properties -- use `box.getSize(target)` and `box.getCenter(target)`.

The `Object3D.position` property gives the grid's local position within its parent, but `matrixWorld` accounts for any parent transforms. `getBounds()` already handles this via `applyMatrix4(this.matrixWorld)`, but we must call `grid.updateMatrixWorld(true)` first to ensure the matrix is current (it may be stale if the position was just changed).

---

## Implementation: `spatialCommands.js`

```js
/**
 * Spatial geometry commands: grid.bounds, grid.bounds.union, grid.anchor,
 * grid.distance, grid.overlap
 *
 * Pure geometry primitives for querying spatial relationships between grids.
 * All coordinates are in world space.
 */

import * as THREE from 'three';
import { box as tuiBox, kvLines } from '../TUIFormatter.js';

// ============ Helpers ============

/**
 * Resolve a grid index from args and validate it.
 * @param {string} arg - raw string from command args
 * @param {Array} grids - array of CodeGrid instances
 * @returns {{ grid: Object, idx: number } | { error: string }}
 */
function resolveGrid(arg, grids) {
    const idx = parseInt(arg);
    if (isNaN(idx) || idx < 0 || idx >= grids.length) {
        return { error: `ERR: invalid grid index ${arg} (0-${grids.length - 1})` };
    }
    return { grid: grids[idx], idx };
}

/**
 * Get world-space AABB for a grid as a plain serializable object.
 * Ensures matrixWorld is current before querying bounds.
 * @param {Object} grid - CodeGrid instance
 * @returns {Object|null} { min:{x,y,z}, max:{x,y,z}, width, height, depth, center:{x,y,z} }
 */
function getWorldAABB(grid) {
    // Ensure world matrix is up to date (handles just-moved grids)
    grid.updateMatrixWorld(true);

    const box3 = grid.getBounds(); // returns THREE.Box3 in world space
    if (box3.isEmpty()) return null;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box3.getSize(size);
    box3.getCenter(center);

    return {
        min: { x: box3.min.x, y: box3.min.y, z: box3.min.z },
        max: { x: box3.max.x, y: box3.max.y, z: box3.max.z },
        width: size.x,
        height: size.y,
        depth: size.z,
        center: { x: center.x, y: center.y, z: center.z }
    };
}

/**
 * Format a vec3 for TUI display.
 * @param {{ x: number, y: number, z: number }} v
 * @param {number} [decimals=2]
 * @returns {string}
 */
function fmtVec(v, decimals = 2) {
    return `${v.x.toFixed(decimals)}, ${v.y.toFixed(decimals)}, ${v.z.toFixed(decimals)}`;
}

// ============ Anchor Resolution ============

/** Valid anchor names and their computation from an AABB */
const ANCHORS = {
    'top-left':     (b) => ({ x: b.min.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'top-right':    (b) => ({ x: b.max.x, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom-left':  (b) => ({ x: b.min.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom-right': (b) => ({ x: b.max.x, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'center':       (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'top':          (b) => ({ x: (b.min.x + b.max.x) / 2, y: b.max.y, z: (b.min.z + b.max.z) / 2 }),
    'bottom':       (b) => ({ x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 }),
    'leading':      (b) => ({ x: b.min.x, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
    'trailing':     (b) => ({ x: b.max.x, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }),
};

// ============ Command Registration ============

/**
 * @param {import('../CommandRouter.js').default} router
 */
export default function registerSpatialCommands(router) {

    // ---- grid.bounds <index> ----
    router.register('grid.bounds', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 1) return { text: 'ERR: usage: grid.bounds <index>', data: null };

        const resolved = resolveGrid(args[0], grids);
        if (resolved.error) return { text: resolved.error, data: null };

        const aabb = getWorldAABB(resolved.grid);
        if (!aabb) {
            return { text: `ERR: grid ${resolved.idx} has no content bounds`, data: null };
        }

        const kv = {
            'min':    fmtVec(aabb.min),
            'max':    fmtVec(aabb.max),
            'width':  aabb.width.toFixed(2),
            'height': aabb.height.toFixed(2),
            'depth':  aabb.depth.toFixed(2),
            'center': fmtVec(aabb.center),
        };

        return {
            text: tuiBox(`BOUNDS #${resolved.idx}`, kvLines(kv), 50) + '\nOK: grid bounds',
            data: { index: resolved.idx, bounds: aabb }
        };
    }, {
        description: 'Get world-space AABB of a grid',
        usage: '<index>',
        returns: '{ index, bounds: { min, max, width, height, depth, center } }'
    });

    // ---- grid.bounds.union <index1> <index2> [index3...] ----
    router.register('grid.bounds.union', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) {
            return { text: 'ERR: usage: grid.bounds.union <index1> <index2> [index3...]', data: null };
        }

        const indices = [];
        const unionBox = new THREE.Box3();

        for (const arg of args) {
            const resolved = resolveGrid(arg, grids);
            if (resolved.error) return { text: resolved.error, data: null };

            resolved.grid.updateMatrixWorld(true);
            const box3 = resolved.grid.getBounds();
            if (box3.isEmpty()) {
                return { text: `ERR: grid ${resolved.idx} has no content bounds`, data: null };
            }

            unionBox.union(box3);
            indices.push(resolved.idx);
        }

        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        unionBox.getSize(size);
        unionBox.getCenter(center);

        const aabb = {
            min: { x: unionBox.min.x, y: unionBox.min.y, z: unionBox.min.z },
            max: { x: unionBox.max.x, y: unionBox.max.y, z: unionBox.max.z },
            width: size.x,
            height: size.y,
            depth: size.z,
            center: { x: center.x, y: center.y, z: center.z }
        };

        const kv = {
            'grids':  indices.join(', '),
            'min':    fmtVec(aabb.min),
            'max':    fmtVec(aabb.max),
            'width':  aabb.width.toFixed(2),
            'height': aabb.height.toFixed(2),
            'depth':  aabb.depth.toFixed(2),
            'center': fmtVec(aabb.center),
        };

        return {
            text: tuiBox(`UNION BOUNDS`, kvLines(kv), 50) + `\nOK: union of ${indices.length} grids`,
            data: { indices, bounds: aabb }
        };
    }, {
        description: 'Compute AABB enclosing multiple grids',
        usage: '<index1> <index2> [index3...]',
        returns: '{ indices, bounds: { min, max, width, height, depth, center } }'
    });

    // ---- grid.anchor <index> <anchor-name> ----
    router.register('grid.anchor', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) {
            const names = Object.keys(ANCHORS).join(', ');
            return { text: `ERR: usage: grid.anchor <index> <name>\n  anchors: ${names}`, data: null };
        }

        const resolved = resolveGrid(args[0], grids);
        if (resolved.error) return { text: resolved.error, data: null };

        const anchorName = args[1].toLowerCase();
        const anchorFn = ANCHORS[anchorName];
        if (!anchorFn) {
            const names = Object.keys(ANCHORS).join(', ');
            return { text: `ERR: unknown anchor '${anchorName}'. Valid: ${names}`, data: null };
        }

        const aabb = getWorldAABB(resolved.grid);
        if (!aabb) {
            return { text: `ERR: grid ${resolved.idx} has no content bounds`, data: null };
        }

        const point = anchorFn(aabb);

        return {
            text: `OK: grid #${resolved.idx} ${anchorName} = (${fmtVec(point)})`,
            data: { index: resolved.idx, anchor: anchorName, position: point }
        };
    }, {
        description: 'Get named anchor point on grid bounding box',
        usage: '<index> <anchor-name>',
        returns: '{ index, anchor, position: {x,y,z} }'
    });

    // ---- grid.distance <index1> <index2> ----
    router.register('grid.distance', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) return { text: 'ERR: usage: grid.distance <index1> <index2>', data: null };

        const r1 = resolveGrid(args[0], grids);
        if (r1.error) return { text: r1.error, data: null };
        const r2 = resolveGrid(args[1], grids);
        if (r2.error) return { text: r2.error, data: null };

        const aabb1 = getWorldAABB(r1.grid);
        const aabb2 = getWorldAABB(r2.grid);
        if (!aabb1) return { text: `ERR: grid ${r1.idx} has no content bounds`, data: null };
        if (!aabb2) return { text: `ERR: grid ${r2.idx} has no content bounds`, data: null };

        const dx = aabb2.center.x - aabb1.center.x;
        const dy = aabb2.center.y - aabb1.center.y;
        const dz = aabb2.center.z - aabb1.center.z;
        const euclidean = Math.sqrt(dx * dx + dy * dy + dz * dz);

        return {
            text: `OK: distance(#${r1.idx}, #${r2.idx}) = ${euclidean.toFixed(2)}  delta=(${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)})`,
            data: {
                from: r1.idx,
                to: r2.idx,
                distance: euclidean,
                delta: { x: dx, y: dy, z: dz },
                fromCenter: aabb1.center,
                toCenter: aabb2.center
            }
        };
    }, {
        description: 'Euclidean distance between two grid centers',
        usage: '<index1> <index2>',
        returns: '{ from, to, distance, delta: {x,y,z}, fromCenter, toCenter }'
    });

    // ---- grid.overlap <index1> <index2> ----
    router.register('grid.overlap', (args, ctx) => {
        const grids = ctx.getGrids();
        if (args.length < 2) return { text: 'ERR: usage: grid.overlap <index1> <index2>', data: null };

        const r1 = resolveGrid(args[0], grids);
        if (r1.error) return { text: r1.error, data: null };
        const r2 = resolveGrid(args[1], grids);
        if (r2.error) return { text: r2.error, data: null };

        r1.grid.updateMatrixWorld(true);
        r2.grid.updateMatrixWorld(true);

        const box1 = r1.grid.getBounds();
        const box2 = r2.grid.getBounds();
        if (box1.isEmpty()) return { text: `ERR: grid ${r1.idx} has no content bounds`, data: null };
        if (box2.isEmpty()) return { text: `ERR: grid ${r2.idx} has no content bounds`, data: null };

        const overlaps = box1.intersectsBox(box2);

        if (!overlaps) {
            // Compute gap: minimum distance between the two boxes
            // THREE.Box3.distanceToPoint gives distance from box surface to a point;
            // for box-to-box, we clamp each axis independently
            const gapX = Math.max(0, box2.min.x - box1.max.x, box1.min.x - box2.max.x);
            const gapY = Math.max(0, box2.min.y - box1.max.y, box1.min.y - box2.max.y);
            const gapZ = Math.max(0, box2.min.z - box1.max.z, box1.min.z - box2.max.z);
            const gap = Math.sqrt(gapX * gapX + gapY * gapY + gapZ * gapZ);

            return {
                text: `OK: grids #${r1.idx} and #${r2.idx} do NOT overlap (gap=${gap.toFixed(2)})`,
                data: {
                    a: r1.idx,
                    b: r2.idx,
                    overlaps: false,
                    gap,
                    gapAxis: { x: gapX, y: gapY, z: gapZ },
                    region: null
                }
            };
        }

        // Compute intersection region
        const iMin = {
            x: Math.max(box1.min.x, box2.min.x),
            y: Math.max(box1.min.y, box2.min.y),
            z: Math.max(box1.min.z, box2.min.z)
        };
        const iMax = {
            x: Math.min(box1.max.x, box2.max.x),
            y: Math.min(box1.max.y, box2.max.y),
            z: Math.min(box1.max.z, box2.max.z)
        };
        const region = {
            min: iMin,
            max: iMax,
            width: iMax.x - iMin.x,
            height: iMax.y - iMin.y,
            depth: iMax.z - iMin.z,
        };

        const kv = {
            'overlaps': 'true',
            'region min': fmtVec(region.min),
            'region max': fmtVec(region.max),
            'region size': `${region.width.toFixed(2)} x ${region.height.toFixed(2)} x ${region.depth.toFixed(2)}`,
        };

        return {
            text: tuiBox(`OVERLAP #${r1.idx}/#${r2.idx}`, kvLines(kv), 50) + '\nOK: grids overlap',
            data: {
                a: r1.idx,
                b: r2.idx,
                overlaps: true,
                gap: 0,
                gapAxis: { x: 0, y: 0, z: 0 },
                region
            }
        };
    }, {
        description: 'Check if two grids overlap and return intersection',
        usage: '<index1> <index2>',
        returns: '{ a, b, overlaps, gap, region: { min, max, width, height, depth } | null }'
    });
}
```

---

## Registration in `commands/index.js`

Add one import and one call to the existing `registerAllCommands` function:

```js
// In examples/github-viewer/websocket/commands/index.js

import registerSpatialCommands from './spatialCommands.js';   // ADD

export function registerAllCommands(router) {
    registerSystemCommands(router);
    registerCameraCommands(router);
    registerGridCommands(router);
    registerSceneCommands(router);
    registerSelectCommands(router);
    registerLayoutCommands(router);
    registerSearchCommands(router);
    registerAgentLayoutCommands(router);
    registerAnnotationCommands(router);
    registerSpatialCommands(router);   // ADD
}
```

---

## Wire Protocol Examples

All commands follow the existing pattern: command name + space-separated args, returning `{ text: string, data: object }`.

### `grid.bounds 0`

Request:
```
grid.bounds 0
```

Response text:
```
+-- BOUNDS #0 -------------------------+
| min:          -1.00, -24.50, 0.00    |
| max:          18.60, 1.00, 0.00      |
| width:        19.60                  |
| height:       25.50                  |
| depth:        0.00                   |
| center:       8.80, -11.75, 0.00    |
+--------------------------------------+
OK: grid bounds
```

Response data:
```json
{
  "index": 0,
  "bounds": {
    "min": { "x": -1.0, "y": -24.5, "z": 0.0 },
    "max": { "x": 18.6, "y": 1.0, "z": 0.0 },
    "width": 19.6,
    "height": 25.5,
    "depth": 0.0,
    "center": { "x": 8.8, "y": -11.75, "z": 0.0 }
  }
}
```

### `grid.bounds.union 0 1 2`

Request:
```
grid.bounds.union 0 1 2
```

Response data:
```json
{
  "indices": [0, 1, 2],
  "bounds": {
    "min": { "x": -1.0, "y": -50.0, "z": 0.0 },
    "max": { "x": 80.0, "y": 1.0, "z": 0.0 },
    "width": 81.0,
    "height": 51.0,
    "depth": 0.0,
    "center": { "x": 39.5, "y": -24.5, "z": 0.0 }
  }
}
```

### `grid.anchor 0 top-left`

Request:
```
grid.anchor 0 top-left
```

Response text:
```
OK: grid #0 top-left = (-1.00, 1.00, 0.00)
```

Response data:
```json
{
  "index": 0,
  "anchor": "top-left",
  "position": { "x": -1.0, "y": 1.0, "z": 0.0 }
}
```

Valid anchor names: `top-left`, `top-right`, `bottom-left`, `bottom-right`, `center`, `top`, `bottom`, `leading`, `trailing`.

### `grid.distance 0 1`

Request:
```
grid.distance 0 1
```

Response text:
```
OK: distance(#0, #1) = 45.23  delta=(30.00, -33.50, 0.00)
```

Response data:
```json
{
  "from": 0,
  "to": 1,
  "distance": 45.23,
  "delta": { "x": 30.0, "y": -33.5, "z": 0.0 },
  "fromCenter": { "x": 8.8, "y": -11.75, "z": 0.0 },
  "toCenter": { "x": 38.8, "y": -45.25, "z": 0.0 }
}
```

### `grid.overlap 0 1` (no overlap)

Request:
```
grid.overlap 0 1
```

Response text:
```
OK: grids #0 and #1 do NOT overlap (gap=12.40)
```

Response data:
```json
{
  "a": 0,
  "b": 1,
  "overlaps": false,
  "gap": 12.4,
  "gapAxis": { "x": 10.0, "y": 7.5, "z": 0.0 },
  "region": null
}
```

### `grid.overlap 0 1` (with overlap)

Response data:
```json
{
  "a": 0,
  "b": 1,
  "overlaps": true,
  "gap": 0,
  "gapAxis": { "x": 0, "y": 0, "z": 0 },
  "region": {
    "min": { "x": 5.0, "y": -10.0, "z": 0.0 },
    "max": { "x": 12.0, "y": -3.0, "z": 0.0 },
    "width": 7.0,
    "height": 7.0,
    "depth": 0.0
  }
}
```

---

## Design Notes

### Why `updateMatrixWorld(true)` before `getBounds()`

`CodeGrid.getBounds()` calls `box.applyMatrix4(this.matrixWorld)`. If a command like `grid.position` just set `.position` but the scene hasn't rendered yet, `matrixWorld` is stale. Calling `updateMatrixWorld(true)` forces a synchronous recompute of the full transform chain. The `true` argument forces the update even if the `matrixWorldNeedsUpdate` flag isn't set.

### Why recompute width/height from Box3 instead of using collection bounds

`CodeGrid.getBounds()` applies `backgroundPadding` and then transforms to world space. If the grid has non-identity scale or rotation, the local-space width/height from `GlyphCollection.getBounds()` would be wrong. Using `THREE.Box3.getSize()` on the world-space box gives the correct axis-aligned dimensions.

### Gap computation in `grid.overlap`

When boxes don't overlap, the gap is computed per-axis as `max(0, separation_on_axis)` then combined as Euclidean distance. This gives the shortest straight-line distance between the two box surfaces. The per-axis gaps (`gapAxis`) are also returned so callers can decide if grids are "close enough" on specific axes (e.g., horizontally aligned but vertically separated).

### Anchor Z coordinate

All anchors compute Z as the midpoint of the box's Z range. For typical CodeGrids with no Z-wrapping, depth is 0 and Z equals the grid's Z position. For Z-wrapped grids (long lines), the anchor sits at the midpoint of the depth extent.
