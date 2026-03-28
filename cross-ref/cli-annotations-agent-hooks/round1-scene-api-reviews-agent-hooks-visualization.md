# Round 1: scene-api reviews agent-hooks and visualization

## Alignment

All three proposals converge on the same foundational decision: agent windows are CodeGrids managed through the existing WebSocket command protocol. No new Three.js rendering code is needed. This is the right call and all three documents agree on it.

Both agent-hooks and visualization use the `agent:<label>` naming convention for grid identification (agent-hooks: `AgentWindowManager.createWindow()` line 267 constructs `agent:${label}`; visualization: `findAgentGrids()` at line 71 checks `name.startsWith('agent:')`). This means the browser-side layout commands from visualization can discover windows created by agent-hooks without any coupling between the two modules.

Scene-api and visualization both use `setGroupColor(0, ...)` as the mechanism for color tinting grids. This is consistent with how the group DataTexture system works.

All three proposals use the existing `CommandRouter.register()` pattern and the `ctx` context bag, so registration and execution are uniform.

## Gaps

### 1. Context bag divergence: scene-api adds state that visualization silently depends on

Scene-api proposes adding `ctx.annotations` (Map), `ctx.highlights` (Map), and `ctx._cameraAnimationId` to the context bag in `websocket/index.js` `buildContext()`. Visualization adds no context bag properties -- it is stateless on the browser side (positions are computed on the fly from grid bounds). Agent-hooks adds no browser-side state either (all state lives in `AgentWindowManager.mjs` on the CLI side).

The gap: visualization's `layout.focus` command (phase0-visualization.md line 295-314) modifies `grid.position.z` and calls `setGroupColor()` to dim/highlight agent windows, but does not track what it changed. There is no undo mechanism. Meanwhile, scene-api's `highlight.grid` carefully saves `originalScale` and `originalZ` in `ctx.highlights` for reversible restoration. If both systems touch the same grid, the saved state in `ctx.highlights` becomes stale -- visualization overwrote position.z without scene-api knowing.

### 2. No `camera.fitall` referenced in scene-api

Visualization's `AgentLayoutHelper` calls `camera.fitall` (lines 738, 779, 814, 841) which already exists in `cameraCommands.js` line 105. Scene-api proposes `camera.animate` and `camera.lookat.grid` but never mentions `camera.fitall`. This is fine for independence, but the CLI encoding support in scene-api (`glyph-cli.mjs` section 4) does not add encoding rules for `camera.fitall` arguments. Not a collision, but a gap in cross-agent awareness.

### 3. Agent-hooks has no browser-side component

Agent-hooks creates 3 CLI-side files (`AgentWindow.mjs`, `AgentWindowManager.mjs`, `agent-hook.mjs`) but zero browser-side files. It relies entirely on existing commands (`grid.create`, `grid.text`, `grid.position`, `grid.color`, `grid.scale`, `grid.remove`). This means agent-hooks cannot create annotations or labels -- only content grids. If an agent hook wants to annotate a code review finding (e.g., "Bug on line 42"), it would need scene-api's `label.create` or `scene.annotate` commands. But `agent-hook.mjs` has no way to invoke those -- it only wraps `grid.*` commands through `AgentWindow` methods.

### 4. Visualization's `AgentLayoutHelper` duplicates `AgentWindowManager`

Both `AgentWindowManager.mjs` (agent-hooks) and `AgentLayoutHelper.mjs` (visualization) are CLI-side Node.js classes that wrap `CliConnection`, maintain a `label -> gridIndex` map, and provide `createAgentWindow()`/`removeAgentWindow()` methods. They even have identical `_rebuildGridMap()` / `_refreshIndices()` methods that parse `grid.list` responses for `agent:` prefixes.

Specific duplications:
- `AgentWindowManager._refreshIndices()` (agent-hooks line 416-432) vs `AgentLayoutHelper._rebuildGridMap()` (visualization line 900-916): both call `grid.list`, iterate results, match `agent:` prefix, rebuild a Map.
- `AgentWindowManager.createWindow()` (agent-hooks line 260-302) vs `AgentLayoutHelper.createAgentWindow()` (visualization line 541-554): both call `grid.create` with base64 content and `agent:<label>` name, parse the grid index from the response.
- Both maintain `Map<string, number>` for label-to-index tracking (`_indexMap` vs `agentGridMap`).

Visualization section 4 (line 927-977) acknowledges this and proposes that `AgentWindowManager` should use `AgentLayoutHelper` as a delegate. But this creates a dependency inversion: the higher-level manager (agent-hooks) would depend on the layout helper (visualization). The cleaner path is the opposite -- `AgentLayoutHelper` should accept an `AgentWindowManager` instance and call its methods.

## Tensions

### 1. `scene.clear_annotations` vs `scene.clear_windows` vs `layout.undim` -- three overlapping cleanup commands

The existing codebase has `scene.clear_windows` in `sceneCommands.js` line 44 which calls `ctx.windowManager.clearAll()`. Scene-api adds `scene.clear_annotations` which clears `ctx.annotations` and `ctx.highlights`. Visualization adds `layout.undim` which resets all agent window colors and Z positions.

A user who wants to "reset everything" must call all three. Worse, `scene.clear_annotations` also clears highlights (line 432-436 of scene-api), but `layout.undim` doesn't know about highlights -- it just resets color to `{r:0, g:1, b:0}` (green) and `z=0`, which is not the same as restoring original state. The highlight system saves `originalScale` and `originalZ`; `layout.undim` would clobber those saved values by setting Z to 0 regardless.

### 2. Color semantics conflict: identity white vs agent green

Scene-api uses `{r:1, g:1, b:1}` (white) as the identity/reset color for `setGroupColor(0, ...)` in `_clearHighlight()` (line 460). Visualization uses `{r:0, g:1, b:0}` (green) as the "normal" color in `layout.agents` (line 244), `layout.focus` (line 300), and `layout.undim` (line 446). These are incompatible defaults. If scene-api clears a highlight on an agent window, it resets to white. If visualization then runs `layout.undim`, it resets to green. The grid's color now depends on which command ran last, not on any consistent baseline.

The root cause: there is no agreed-upon "default color" for agent windows. Content grids default to white (identity multiplier). Agent windows apparently default to green per visualization. This needs to be a shared constant or a per-grid property.

### 3. `camera.animate` (scene-api) fights `cameraController.focusOnGrid()` (visualization)

Scene-api's `camera.animate` (line 252-316) uses `requestAnimationFrame` with eased interpolation and cancellation tracking via `ctx._cameraAnimationId`. Visualization's `layout.focus` (line 317-319) calls `ctx.cameraController.focusOnGrid(target.index)` directly, which presumably also animates the camera. If `layout.focus` fires while `camera.animate` is in flight, the two animations fight -- `camera.animate` keeps calling `camera.position.set()` on each frame while `focusOnGrid` may also be updating position.

Scene-api handles this for its own animations (cancels via `cancelAnimationFrame`), but has no way to cancel `focusOnGrid`, and `layout.focus` has no way to cancel `camera.animate`.

### 4. Visualization's `layout.correlate` directly sets camera position (line 389-391)

Visualization's `layout.correlate` command directly sets `cam.position.set(centerX, centerY, ...)` and `cam.lookAt(...)` without going through `camera.animate` or syncing `cameraController.pitch/yaw`. Scene-api's `camera.lookat.grid` (line 343-350) carefully extracts Euler angles and writes them back to `cameraController.pitch` and `cameraController.yaw` to prevent the physics controller from overriding the lookAt. Visualization's `layout.correlate` skips this step, meaning the camera controller will likely fight the new orientation on the next frame.

## Recommendations

### R1: Merge AgentWindowManager and AgentLayoutHelper into one class

`AgentWindowManager` should be the single CLI-side class for managing agent windows. It should absorb the layout methods from `AgentLayoutHelper` (`arrangeAgents`, `focusAgent`, `correlateAgents`, `setPhaseLayout`). These layout methods simply call `this.conn.send('layout.agents ...')` etc., which can live on the manager just as easily. Delete `AgentLayoutHelper` as a separate file. This eliminates the duplicate grid-index tracking, duplicate `grid.list` parsing, and the awkward dependency question.

### R2: Establish a shared annotation/visual-state tracker on the context bag

Add a single `ctx.visualState` object to the context bag that both scene-api and visualization write to:

```javascript
ctx.visualState = {
    annotations: new Map(),   // scene-api labels/annotations
    highlights: new Map(),    // scene-api reversible highlights
    agentDimState: new Map(), // visualization dim/focus state
    cameraAnimationId: null,  // scene-api camera animation
};
```

Both command modules read/write this shared state. When `layout.undim` runs, it checks `ctx.visualState.highlights` and calls `_clearHighlight()` from scene-api's helper function (exported, not file-private). When `scene.clear_annotations` runs, it also calls `layout.undim`'s reset logic for agent windows. One state, one cleanup path.

### R3: Agree on a default color constant

Define `AGENT_DEFAULT_COLOR = { r: 0, g: 1, b: 0 }` (or whatever the agreed value is) in a shared location -- either `src/core/constants.js` or a new `examples/github-viewer/websocket/commands/sharedConstants.js`. Both scene-api's `_clearHighlight` and visualization's `layout.undim` / `layout.agents` use this constant instead of hardcoded values.

### R4: Centralize camera animation cancellation

`camera.animate` should register its cancellation function on the context bag (e.g., `ctx._cancelCameraAnimation = () => cancelAnimationFrame(id)`). Any command that moves the camera -- `layout.focus`, `layout.correlate`, `camera.lookat.grid` -- should call `ctx._cancelCameraAnimation?.()` first. Similarly, `layout.correlate` must sync `cameraController.pitch/yaw` after calling `cam.lookAt()`, matching the pattern scene-api established in `camera.lookat.grid`.

### R5: Expose annotation commands to agent-hook.mjs

Add `--annotate` and `--label` flags to `agent-hook.mjs` that send `scene.annotate` and `label.create` commands through the WebSocket. This lets agent hooks place spatial annotations near code grids, not just update window content. The encoding (base64 for text, numeric for coordinates) is already handled by the annotation commands.

### R6: Add a single `scene.reset` command that orchestrates all cleanup

Register `scene.reset` that calls `scene.clear_annotations` + `layout.undim` + optionally `scene.clear_windows`. This gives users one command to return to a clean state regardless of which system dirtied the scene.

## Key Insight

The three proposals build a layered system -- scene-api provides primitive annotation/camera commands, agent-hooks provides CLI-side window lifecycle management, and visualization provides layout algorithms -- but they share no state contract. The browser-side context bag (`ctx`) is the natural coordination point, yet each proposal either adds to it independently (scene-api) or ignores it entirely (visualization, agent-hooks). The critical implementation task is not writing more commands; it is defining a `ctx.visualState` schema that all three layers read and write, so that cleanup, undo, and color-reset operations compose correctly instead of silently corrupting each other's assumptions.
