# Spatial Window Manager -- Implementation Summary

## Overview

Implemented the full Spatial Window Manager feature: group-based window management for CodeGrids and AgentGrids in 3D space. The system enables grouping, layout modes (stack/splay/free), drag-to-group, group hiding/showing, color tinting, and persistence.

## Files Created (6)

| File | Purpose | Lines |
|------|---------|-------|
| `src/services/spatial/spatialMath.js` | Shared `screenToWorldDelta()` -- quaternion-aware pixel-to-world conversion. Uses `getCanvasViewportSize()`, never `window.innerHeight`. | ~35 |
| `src/services/spatial/SpatialAnimator.js` | Frame-driven property animation engine. Keyed by `${uuid}:${property}`, supports position/scale/opacity. Uses `easeInOutCubic` from spatialHelpers. | ~170 |
| `src/services/spatial/WindowGroup.js` | Group data structure + pure layout functions (stack, splay, free). `memberIds: string[]` (ordered registry IDs). Box3 min/max for bounds. Pre-allocated `_boundsBox`. | ~250 |
| `src/services/interaction/HitDispatcher.js` | Capture-phase mousedown on canvas. Raycasts `findByType('grid')` + `findByType('agent')` backgrounds. Group-aware drag. 5px click/drag disambiguation. Drop-to-group at 30% Box3 overlap. | ~270 |
| `src/services/spatial/SpatialWindowManager.js` | Group orchestrator. Single mutation path for membership (WindowGroup + _gridToGroup + userData._windowGroup + FileStateManager). Registry reconciliation. Selection Z-pop propagation. CodeColorManager group-tint layer at priority 5. | ~340 |
| `app/commands/handlers/groupCommands.js` | 12 group.* commands: create, add, remove, dissolve, stack, splay, free, hide, show, list, info, move. | ~230 |

## Files Modified (9)

| File | Change |
|------|--------|
| `src/services/camera/ViewerCameraController.js` | Fixed pre-existing bug: `window.innerHeight` -> `getCanvasViewportSize(this.ctx.canvas).height` at line 244 |
| `app/commands/handlers/spatialHelpers.js` | Exported `easeInOutCubic` (added `export` keyword) |
| `src/collections/AgentGrid.js` | Added proxy getters: `get _background()` and `getBounds()` |
| `src/services/SceneRegistry.js` | Replaced `_onChange` single callback with `_changeListeners: Set<Function>`, added `addChangeListener()`/`removeChangeListener()` |
| `src/collections/GridVirtualizer.js` | Added `_userHidden` and `_dragPinned` guards in `update()` loop |
| `src/services/interaction/SelectionManager.js` | Exported `Z_POP_AMOUNT`, added `userData._windowGroup` guard in `_applyZPop()` |
| `app/GitHubRepoViewer.js` | Import + instantiate SpatialAnimator, SpatialWindowManager, HitDispatcher. Animator tick in animate loop. Cleanup in clearGrids(). |
| `app/commands/index.js` | Added `spatialManager` to `buildContext()` |
| `app/commands/handlers/index.js` | Imported + registered groupCommands |
| `app/StatePersistence.js` | Added `groups` to DEFAULTS, serialize on camera save, deserialize on camera restore |

## Key Design Decisions

1. **`screenToWorldDelta` in `src/services/spatial/spatialMath.js`** -- lives in src/ so HitDispatcher can import without crossing the src/app boundary. The convergence plans had two suggestions (spatialHelpers vs spatialMath); spatialMath was chosen per the task spec and Event Pipeline's recommendation.

2. **HitDispatcher in `src/services/interaction/`** -- alongside SelectionManager and ShortcutManager, since it's a DOM event concern.

3. **SceneRegistry listener names: `addChangeListener`/`removeChangeListener`** -- per Integration Surface convergence, avoids naming collision with the removed `_onChange` property.

4. **WindowGroup.memberIds as `string[]`** -- ordered (needed for stack/splay index), not Set (loses order), not Object3D refs (fragile across disposal).

5. **Single mutation path** -- `addToGroup` and `removeFromGroup` always update all four stores atomically: WindowGroup.memberIds, _gridToGroup Map, userData._windowGroup, FileStateManager.groupId.

6. **Group-tint color layer at priority 5** -- below heatmap (10) and selection (15), providing a subtle persistent color for grouped windows.

## Constraints Satisfied

- `screenToWorldDelta` uses `getCanvasViewportSize(canvas).height`, never `window.innerHeight`
- HitDispatcher raycasts via `findByType('grid')` + `findByType('agent')`, not `registry.list()`
- Box3 area: `(box.max.x - box.min.x) * (box.max.y - box.min.y)`, never `.width`/`.height`
- WindowGroup.memberIds is `string[]`, not Object3D refs, not a Set
- SpatialAnimator keyed by `${object.uuid}:${property}` -- new animation cancels in-flight
