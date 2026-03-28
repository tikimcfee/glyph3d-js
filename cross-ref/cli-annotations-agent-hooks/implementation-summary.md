# Implementation Summary: Converged Annotation/Agent-Hooks System

## Date: 2026-03-27

## What was implemented

The converged plan from all three Round 3 documents (scene-api, agent-hooks, visualization) has been fully implemented across 9 files (4 new, 5 modified).

---

## New Files

### 1. `examples/github-viewer/websocket/commands/colorConstants.js`
Shared semantic color constants: IDENTITY (white), HIGHLIGHT (cyan), DIMMED (gray), ANNOTATION (amber), ERROR (red). Phase-specific colors remain local to their respective modules.

### 2. `examples/github-viewer/websocket/commands/gridVisualState.js`
Three exported helper functions for shared highlight/dim state management:
- `saveGridState(ctx, gridIndex)` -- first-writer-wins save of position.z, scale, color
- `restoreGridState(ctx, gridIndex)` -- restore and delete saved state
- `restoreAllGridStates(ctx)` -- restore all modified grids

Used by both `annotationCommands.js` and `agentLayoutCommands.js` to avoid conflicting modifications.

### 3. `examples/github-viewer/websocket/commands/annotationCommands.js`
Browser-side commands (11 commands total):
- `label.create <base64-text> <x> <y> <z> [r g b]` -- CodeGrid with showBackground:false
- `label.remove <id>` -- remove by annotation ID
- `label.list` -- list all labels/annotations with TUI table
- `highlight.grid <index> [r g b]` -- save state, color tint + Z-pop + 5% scale
- `highlight.clear [index]` -- restore saved states
- `camera.animate <x> <y> <z> <duration>` -- smooth ease-in-out cubic, stores cancel function on ctx
- `camera.lookat.grid <index>` -- look at grid center, sync pitch/yaw
- `scene.annotate <base64-text> <x> <y> <z> [r g b]` -- CodeGrid with showBackground:true, amber default
- `scene.clear_annotations` -- remove all annotations + restore all highlights
- `scene.reset [--windows]` -- clear annotations + highlights + cancel animation; skip agent windows unless `--windows` flag

### 4. `examples/github-viewer/websocket/commands/agentLayoutCommands.js` (rewritten)
Complete rewrite of existing file to use shared state:
- `layout.agents <row|column|grid|radial>` -- restores all states before rearranging, resets colors to IDENTITY (white, not green)
- `layout.focus <label>` -- cancels camera animation, saves state via shared helpers, dims with COLORS.DIMMED
- `layout.correlate <a> <b>` -- cancels camera animation, saves state, syncs cameraController.pitch/yaw after lookAt
- `layout.undim` -- calls `restoreAllGridStates(ctx)`
- `layout.agents.list` -- list agent windows

---

## Modified Files

### 5. `examples/github-viewer/websocket/index.js`
Added to `buildContext()`:
- `annotations: new Map()` -- tracks label/annotation CodeGrids
- `gridVisualState: new Map()` -- shared highlight/dim save/restore
- `_cancelCameraAnimation: null` -- centralized camera animation cancellation

### 6. `examples/github-viewer/websocket/commands/index.js`
Added import and registration of `registerAnnotationCommands`.

### 7. `examples/github-viewer/websocket/commands/cameraCommands.js`
Added `ctx._cancelCameraAnimation?.()` call at start of `camera.fitall` handler.

### 8. `examples/github-viewer/cli/AgentWindowManager.mjs` (major rewrite)
- Removed auto-positioning fields: `_nextSlot`, `_spacing`, `_baseX`, `_baseY`, `_baseZ`
- Windows now created at origin (no auto-position in `createWindow()`)
- Added public `getIndex(label)` method
- Absorbed layout methods from AgentLayoutHelper:
  - `arrangeAgents(style)` -- sends `layout.agents <style>`
  - `focusAgent(label)` -- sends `layout.focus <label>`
  - `correlateAgents(a, b)` -- sends `layout.correlate <a> <b>`
  - `undimAll()` -- sends `layout.undim`
  - `fitAll()` -- sends `camera.fitall`
  - `setPhaseLayout(phase, labels, options)` -- CLI-side phase layout computation
- Phase layout methods: `_layoutPhase0` through `_layoutPhase3` with local PHASE_COLORS
- Internal helpers: `_positionByLabel()`, `_colorByLabel()`
- Pairing logic: `_computeForwardPairs()`, `_computeInversePairs()`

### 9. `examples/github-viewer/cli/glyph-cli.mjs`
Extended `encodeContentArgs()` to auto-encode base64 for `label.create` and `scene.annotate` commands. Handles both quoted and unquoted text arguments.

---

## Not Modified (already correct)

- `examples/github-viewer/cli/AgentWindow.mjs` -- Phase 0 code is correct as-is
- `examples/github-viewer/cli/agent-hook.mjs` -- Phase 0 code is correct as-is
- `examples/github-viewer/cli/AgentLayoutHelper.mjs` -- **should be deleted** (all functionality absorbed into AgentWindowManager), but left in place to avoid breaking any external references. It is now dead code.

---

## Key Design Decisions Implemented

1. **Shared `gridVisualState` Map** on ctx with first-writer-wins semantics prevents conflicting modifications from highlight and layout commands.

2. **Camera animation cancellation** via `ctx._cancelCameraAnimation` function pointer, called by every command that moves the camera.

3. **`scene.reset` skips agent windows** by default since they have CLI-side state. The `--windows` flag provides emergency cleanup.

4. **Identity white `{1,1,1}` is the restore color**, not green. Phase colors are temporary overlays cleared back to white.

5. **Phase layout stays CLI-side** with estimated dimensions (W=120, H=80). Browser remains a dumb spatial renderer.

6. **All commands flow through `_enqueue`** for serialized sending through CliConnection's single pending resolve slot.

7. **`agent:` prefix naming convention** is the stable contract for agent window discovery via grid name prefix scan.
