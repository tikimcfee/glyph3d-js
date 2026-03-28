# Spatial Relationship API -- Implementation Summary

Implemented by: geometry agent
Date: 2026-03-27

## Files Created

### `examples/github-viewer/websocket/commands/spatialHelpers.js` (NEW, ~170 lines)
Shared pure-function module. No command registration, no DOM, no side effects. All three command files import from here.

Exports:
- `resolveGrid(grids, arg, label?)` -- validate grid index, unified signature (grids first)
- `getWorldBounds(grid)` -- canonical AABB `{ min, max, size, center }`, calls `updateWorldMatrix(true, true)`
- `getWorldBox3(grid)` -- raw THREE.Box3, calls `updateWorldMatrix(true, true)`
- `box3ToAABB(box3)` -- Box3 to plain object conversion
- `unionBounds(grids, indices)` -- union AABB of multiple grids, fails loud on invalid indices
- `resolveAnchor(bounds, name)` -- 9 named anchor points on an AABB
- `ANCHOR_NAMES` -- array of all valid anchor names
- `zDistanceForFit(camera, width, height, fillFraction?)` -- camera Z distance math
- `fmtVec(v, decimals?)` -- vec3 formatting for TUI

### `examples/github-viewer/websocket/commands/compositionCommands.js` (NEW, ~300 lines)
Position mutation commands:
- `grid.align <src> <tgt> <src-anchor> <tgt-anchor> [gap]` -- anchor-to-anchor alignment
- `grid.attach <src> <tgt> <position> [gap]` -- simplified attach (above/below/left/right + corners)
- `grid.stack <idx1> <idx2> [idx3...] <direction> [gap]` -- arrange in line (horizontal/vertical/depth)

## Files Modified

### `examples/github-viewer/websocket/commands/spatialCommands.js` (REWRITTEN)
Refactored to import all helpers from `spatialHelpers.js`. Deleted local `resolveGrid`, `getWorldAABB`, `fmtVec`, `ANCHORS`.

Changes:
- `resolveGrid` signature flipped to `(grids, arg)` for consistency
- All `updateMatrixWorld(true)` replaced by helpers using `updateWorldMatrix(true, true)`
- `grid.bounds` data now uses `size: { x, y, z }` instead of flat `width/height/depth`
- `grid.bounds` TUI output now includes all 9 anchor point positions (merged from composition's design)
- `grid.bounds.union` delegates to shared `unionBounds()` instead of inline loop
- `grid.anchor` uses `resolveAnchor()` instead of local `ANCHORS` map
- `grid.overlap` uses `getWorldBox3()` from helpers

### `examples/github-viewer/websocket/commands/navigationCommands.js` (REWRITTEN)
Refactored to import from `spatialHelpers.js`. Fixed multiple bugs identified in cross-review.

Bug fixes:
1. **Missing `updateWorldMatrix` before `getBounds()`** -- `createTourAnnotation` now uses `getWorldBounds()` (was bare `grid.getBounds()` with stale matrix)
2. **Silent skip on invalid indices** -- `camera.frame` now uses `resolveGrid()` for validation and `unionBounds()` which fails loud
3. **Missing `isEmpty()` check** -- `unionBounds()` handles this automatically
4. **Inline FOV math in `tour.play`** -- replaced with `zDistanceForFit()` call
5. **Hardcoded annotation offsets** -- `createTourAnnotation` now uses `resolveAnchor(bounds, 'top')` + gap
6. **`camera.frame.bounds` ignoring Z** -- now accepts optional `minZ maxZ` parameters

### `examples/github-viewer/websocket/commands/index.js` (EDITED)
Added `import registerCompositionCommands` and `registerCompositionCommands(router)` call.

## Files NOT Modified (no change needed)

### `examples/github-viewer/cli/CodeTour.mjs`
The `build()` argument order bug mentioned in convergence docs was already fixed in the current code. Both `play()` and `build()` use the correct order: `${annotB64} ${stop.durationMs}`.

### `examples/github-viewer/websocket/index.js`
Tours are stored in a module-level Map inside `navigationCommands.js`, not on the context bag. No change needed.

## Canonical Data Shapes

### AABB (bounds)
```js
{
    min: { x, y, z },
    max: { x, y, z },
    size: { x, y, z },    // matches THREE.Box3.getSize() output
    center: { x, y, z },
}
```

### resolveGrid return
```js
{ grid: Object, idx: number }  // success
{ error: string }               // failure, error starts with "ERR:"
```

### unionBounds return
```js
{ bounds: AABB, indices: number[] }  // success
{ error: string }                     // failure
```

## Dependency Graph

```
spatialHelpers.js          (pure math, 0 command deps)
    ^       ^       ^
    |       |       |
spatialCommands.js  compositionCommands.js  navigationCommands.js
(geometry queries)  (position mutations)    (camera + tours)
```

## Command Summary

| Command | Type | Module |
|---------|------|--------|
| `grid.bounds <idx>` | read | spatialCommands |
| `grid.bounds.union <idx1> <idx2> ...` | read | spatialCommands |
| `grid.anchor <idx> <name>` | read | spatialCommands |
| `grid.distance <idx1> <idx2>` | read | spatialCommands |
| `grid.overlap <idx1> <idx2>` | read | spatialCommands |
| `grid.align <src> <tgt> <sa> <ta> [gap]` | write | compositionCommands |
| `grid.attach <src> <tgt> <pos> [gap]` | write | compositionCommands |
| `grid.stack <idx...> <dir> [gap]` | write | compositionCommands |
| `camera.frame <idx...> [--padding N]` | camera | navigationCommands |
| `camera.frame.bounds <x1 y1 x2 y2> [z1 z2] [--padding N]` | camera | navigationCommands |
| `tour.create <b64-name>` | tour | navigationCommands |
| `tour.stop <b64-name> <idx> [b64-annot] [ms]` | tour | navigationCommands |
| `tour.play <b64-name>` | tour | navigationCommands |
| `tour.list` | tour | navigationCommands |
| `tour.clear` | tour | navigationCommands |
