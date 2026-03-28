# Round 3: visualization convergence

## Settled

1. **One CLI class, not two.** AgentWindowManager absorbs all layout methods from AgentLayoutHelper. AgentLayoutHelper is deleted. Single `_indexMap`, single `_enqueue` command queue, single connection. All three agents agreed across all rounds -- the dual-map drift was identified as a guaranteed correctness bug under concurrent use.

2. **No auto-positioning.** AgentWindowManager creates grids at origin. The `_nextSlot`, `_spacing`, `_baseX/Y/Z` fields are removed entirely. Positioning is the caller's responsibility via `arrangeAgents()` or explicit `grid.position` commands. Unanimous across all rounds.

3. **Browser owns spatial authority.** Layout commands (`layout.agents`, `layout.focus`, `layout.correlate`) execute on the browser side in `agentLayoutCommands.js`, operating on real grid bounds via `ctx.getGrids()`. The CLI sends these as WebSocket commands through `_enqueue`. No dispute remaining.

4. **Phase layout stays CLI-only.** Phase semantics (cross-ref rounds, reviewer/target pairs, forward vs inverse order) are orchestration logic. The browser should not know about cross-ref phases. The CLI computes approximate positions (W=120, H=80 estimates) and sends `grid.position` + `grid.color` commands. A future `grid.bounds` query command could improve accuracy without pushing phase knowledge into the browser. Scene-api initially suggested browser-side layout for better bounds access; agent-hooks and visualization disagreed; scene-api did not push back in Round 2.

5. **`camera.fitall` must be implemented.** Every phase transition calls it. It belongs in `cameraCommands.js` on the browser side. Computes bounding box of all visible grids, positions camera to frame them, syncs `cameraController.pitch`/`yaw`. All three agents flagged this as a hard blocker.

6. **Camera animation cancellation is centralized.** `ctx._cancelCameraAnimation` (a function or null) is set by `camera.animate` and called by any command that moves the camera: `layout.focus`, `layout.correlate`, `camera.lookat.grid`, `camera.fitall`. Mechanical fix, no disagreement.

7. **`layout.correlate` must sync pitch/yaw.** After setting `cam.position` and `cam.lookAt`, extract Euler angles (order `'YXZ'`) and write them to `cameraController.pitch` and `cameraController.yaw`. Agent-hooks flagged this; visualization acknowledged it; scene-api provided the concrete fix pattern. No remaining tension.

8. **Shared highlight/dim state on `ctx`.** A `Map<gridIndex, {originalZ, originalScale, originalColor}>` on the context bag, with `save`/`restore`/`restoreAll` helpers. Both `highlight.grid` (scene-api) and `layout.focus` (visualization) save before modifying; both `highlight.clear` and `layout.undim` restore. First-writer-wins semantics (no overwrite if already saved). All three agents converged on this shape; the only variation was whether it is a plain Map with free functions (visualization Round 2) or a class (agent-hooks Round 2). Resolution: plain Map with exported helper functions -- simpler, no class overhead for what is essentially three functions over a Map.

9. **Identity white `{1,1,1}` is the restore color.** Not green. White is the DataTexture identity multiplier. Agent windows get semantic coloring via phase-specific tints that `layout.undim` clears back to white. This resolved the green-vs-white tension from Round 1. Scene-api proposed it; visualization accepted in Round 2; agent-hooks concurred.

10. **Shared color constants file.** Structural colors (IDENTITY, HIGHLIGHT, DIMMED, ERROR, ANNOTATION) go in a shared `agentColors.js`. Phase-specific colors (PHASE_0 through PHASE_3, dim variants) stay local to `AgentWindowManager.mjs` on the CLI side. Scene-api proposed the split in Round 2 (D2); visualization and agent-hooks aligned.

11. **`agent:` prefix naming convention is the stable contract.** No disputes in any round. Browser commands scan `ctx.getGrids()` by name prefix. No typed registry needed.

12. **`highlight.grid` stays index-only.** Does not accept label strings. The CLI resolves labels to indices via `_indexMap` and sends numeric indices. Scene-api (D3) and agent-hooks (D1) both dissented from visualization's Round 1 suggestion. Visualization did not defend it in Round 2. Settled.

13. **`scene.reset` does NOT remove agent windows by default.** Agent windows have CLI-side state (`_windows`, `_indexMap`, `AgentWindow._lines`). Browser-side removal would leave the CLI holding dead references. Agent window cleanup must go through `AgentWindowManager.closeAll()`. `scene.reset` clears annotations + highlights + dim state + cancels camera animation. Agent-hooks made the strongest case (D2 in Round 2); scene-api accepted with a `--windows` flag escape hatch; visualization did not object.

14. **`ctx.getSceneObjects({ type })` is deferred.** All three agents agreed in Round 2 that this is premature abstraction. The `agent:` prefix scan and `ctx.annotations` Map cover current needs. Agent-hooks withdrew their own proposal (D3 in Round 2).

15. **Annotations remain top-level scene objects.** Not parented to grid Object3Ds. Visualization dissented from agent-hooks' parenting proposal in Round 2. Scene-api's `ctx.annotations` Map stays flat. If grids move, the CLI clears and re-creates annotations. Agent-hooks proposed `label.attach` as a compromise but did not insist; this can be added later if needed.

16. **All commands flow through `_enqueue`.** No raw `conn.send()` anywhere in AgentWindowManager. The single-pending-resolve constraint on CliConnection means true parallelism is impossible; the queue remains single FIFO. This is acceptable for sub-second layout passes.

---

## Implementation Plan

### Files to create

**1. `examples/github-viewer/websocket/commands/agentColors.js`** (new)

Shared structural color constants. Imported by both browser-side command files and available to any command module.

```javascript
/** Semantic color palette -- structural colors only. */
export const COLORS = {
    IDENTITY:    { r: 1.0, g: 1.0, b: 1.0 },
    HIGHLIGHT:   { r: 0.2, g: 1.0, b: 1.0 },
    DIMMED:      { r: 0.3, g: 0.3, b: 0.3 },
    ANNOTATION:  { r: 1.0, g: 0.85, b: 0.3 },
    ERROR:       { r: 1.0, g: 0.3, b: 0.3 },
};
```

**2. `examples/github-viewer/websocket/commands/agentLayoutCommands.js`** (new)

From visualization Phase 0 with these modifications:
- Import `COLORS` from `agentColors.js` instead of hardcoded green values
- `layout.agents`: restore color is `COLORS.IDENTITY` (white), not `{0,1,0}` (green)
- `layout.focus`: call `ctx._cancelCameraAnimation?.()` before moving camera; use `saveGridState(ctx, index)` before modifying Z/scale/color; sync pitch/yaw after `cam.lookAt`
- `layout.correlate`: call `ctx._cancelCameraAnimation?.()` first; sync pitch/yaw via Euler extraction after `cam.lookAt`
- Add `layout.undim`: calls `restoreAllGridStates(ctx)` to undo all focus/dim modifications
- `findAgentGrids()`, `gridSize()`, layout algorithms (`layoutRow`, `layoutColumn`, `layoutGrid`, `layoutRadial`) carry over from Phase 0 unchanged

**3. `examples/github-viewer/websocket/commands/gridVisualState.js`** (new)

Shared save/restore helpers for highlight and dim state:

```javascript
/**
 * Save grid's visual state before modification. First-writer-wins.
 * @param {Object} ctx - command context with gridVisualState Map
 * @param {number} gridIndex
 */
export function saveGridState(ctx, gridIndex) {
    if (ctx.gridVisualState.has(gridIndex)) return;
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return;
    ctx.gridVisualState.set(gridIndex, {
        originalZ: grid.position.z,
        originalScale: grid.scale.x,
        originalColor: { r: 1, g: 1, b: 1 },  // identity
    });
}

/**
 * Restore grid to saved visual state.
 */
export function restoreGridState(ctx, gridIndex) {
    const saved = ctx.gridVisualState.get(gridIndex);
    if (!saved) return false;
    const grids = ctx.getGrids();
    const grid = grids[gridIndex];
    if (!grid) return false;
    grid.position.z = saved.originalZ;
    grid.scale.setScalar(saved.originalScale);
    const coll = grid.collection || grid.glyphCollection || grid.getCollection?.();
    if (coll?.setGroupColor) coll.setGroupColor(0, saved.originalColor);
    ctx.gridVisualState.delete(gridIndex);
    return true;
}

/**
 * Restore all modified grids.
 */
export function restoreAllGridStates(ctx) {
    for (const idx of [...ctx.gridVisualState.keys()]) {
        restoreGridState(ctx, idx);
    }
}
```

### Files to modify

**4. `examples/github-viewer/websocket/index.js`**

In `buildContext()`, add:
- `ctx.gridVisualState = new Map();` -- shared visual state tracker
- `ctx._cancelCameraAnimation = null;` -- camera animation cancellation hook
- `ctx.annotations = new Map();` -- annotation registry (if not already present)
- Import and register `agentLayoutCommands.js` in the router setup alongside existing command modules

**5. `examples/github-viewer/websocket/commands/annotationCommands.js`** (scene-api's file)

Modify `highlight.grid` handler to call `saveGridState(ctx, gridIndex)` before modifying Z/scale/color. Modify `highlight.clear` to call `restoreGridState(ctx, gridIndex)`. Import helpers from `gridVisualState.js`.

**6. `examples/github-viewer/websocket/commands/cameraCommands.js`**

Add `camera.fitall`:
- Cancel in-flight animation via `ctx._cancelCameraAnimation?.()`
- Compute `THREE.Box3` bounding box of all visible grids
- Position camera at `center + dist * Z` where `dist = (maxDim / 2) / tan(fov / 2) * 1.2`
- Sync `cameraController.pitch = 0`, `cameraController.yaw = 0`

Modify `camera.animate` to set `ctx._cancelCameraAnimation` to a function that calls `cancelAnimationFrame(ctx._cameraAnimationId)`.

Add `scene.reset`:
- Clear `ctx.annotations` (dispose + remove from scene)
- Call `restoreAllGridStates(ctx)`
- Call `ctx._cancelCameraAnimation?.()`
- Do NOT touch agent windows

**7. `examples/github-viewer/cli/AgentWindowManager.mjs`** (agent-hooks' file)

Absorb layout methods from AgentLayoutHelper:
- Add `arrangeAgents(style)` -- sends `layout.agents ${style}` via `_enqueue`
- Add `focusAgent(label)` -- sends `layout.focus ${label}` via `_enqueue`
- Add `correlateAgents(label1, label2)` -- sends `layout.correlate ${label1} ${label2}` via `_enqueue`
- Add `undimAll()` -- sends `layout.undim` via `_enqueue`
- Add `fitAll()` -- sends `camera.fitall` via `_enqueue`
- Add `setPhaseLayout(phase, agentLabels, options)` with `_layoutPhase0` through `_layoutPhase3` methods (from visualization Round 2 synthesis code). Phase colors defined as local constants in this file, not in `agentColors.js`.
- Add `_positionByLabel(label, x, y, z)` and `_colorByLabel(label, {r,g,b})` internal helpers
- Remove `_nextSlot`, `_spacing`, `_baseX`, `_baseY`, `_baseZ` auto-positioning fields
- Remove any auto-position logic from `createWindow`

### Files to delete

**8. `examples/github-viewer/cli/AgentLayoutHelper.mjs`**

Entire file. All functionality absorbed into AgentWindowManager.

---

## Implementer Vote

**visualization** should implement.

Rationale: The converged plan is closest to visualization's Phase 0 code. The browser-side `agentLayoutCommands.js` (the largest new file) is directly from visualization's Phase 0 with targeted modifications. The `gridVisualState.js` helpers match visualization's Round 2 synthesis almost exactly. The merged `AgentWindowManager` layout methods use the same code sketched in visualization's Round 2. Scene-api's contributions (annotation commands, camera commands, highlight.grid) are pre-existing files that need surgical edits (adding `saveGridState`/`restoreGridState` calls), not full rewrites. Agent-hooks' AgentWindowManager needs method additions that visualization already sketched. Starting from visualization's codebase minimizes delta from converged plan to implementation.
