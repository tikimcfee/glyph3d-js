# Round 3: scene-api convergence

## Settled

1. **One CLI class: AgentWindowManager absorbs AgentLayoutHelper.** All three agents across all rounds agree. AgentLayoutHelper is dissolved entirely. AgentWindowManager owns: window lifecycle, label-to-index map (singular), command queue serialization, and layout methods (arrangeAgents, focusAgent, correlateAgents, setPhaseLayout, undimAll, fitAll). The dual-map bug is eliminated by construction.

2. **No auto-positioning in AgentWindowManager.** Remove `_nextSlot`, `_spacing`, `_baseX/Y/Z`. Windows are created at origin. The caller explicitly calls `arrangeAgents()` or `setPhaseLayout()` afterward. Unanimous across all rounds.

3. **Shared highlight state on `ctx` (browser side).** Both `highlight.grid` (scene-api) and `layout.focus` (visualization) save/restore through one shared state object. The implementation is a `Map<gridIndex, {originalZ, originalScale, baseColor}>` on `ctx`, with `save()`/`restore()`/`restoreAll()` helpers. First writer wins (no overwrite of already-saved state). The `baseColor` field resolves the white-vs-green tension: agent windows save with `AGENT_DEFAULT`, content grids save with `IDENTITY`, and restore goes back to the correct color.

4. **`camera.fitall` must be implemented in `cameraCommands.js`.** All three agents flagged this gap. It computes a bounding box of all visible grids, positions the camera to frame them with ~20% margin, and syncs `cameraController.pitch`/`yaw` to zero (front-facing). Called by every phase transition.

5. **Camera animation cancellation is centralized.** `ctx._cancelCameraAnimation` is a function (or null) set by `camera.animate`. Any command that moves the camera (`layout.focus`, `layout.correlate`, `camera.lookat.grid`, `camera.fitall`) calls `ctx._cancelCameraAnimation?.()` first. No disagreement remains.

6. **`layout.correlate` must sync `cameraController.pitch`/`yaw`.** Visualization acknowledged the gap; scene-api and agent-hooks both flagged it. The fix is mechanical: after `cam.lookAt()`, extract Euler angles with `order = 'YXZ'` and write to `cameraController.pitch`/`cameraController.yaw`. Same pattern as `camera.lookat.grid`.

7. **`agent:` prefix naming convention is the stable contract.** No disputes in any round. Agent windows are named `agent:<label>`, discoverable via `ctx.getGrids()` with prefix filtering. No need for `ctx.getSceneObjects({ type })` -- all three agents agree this is premature abstraction.

8. **Annotations remain top-level scene objects in `ctx.annotations`.** They do not appear in `ctx.getGrids()`. They are not repositioned by layout commands. If a grid moves, the CLI is responsible for clearing and re-creating associated annotations (option b from visualization's analysis). Agent-hooks' `label.attach` parenting proposal is deferred -- it adds complexity for a scenario that does not yet exist in practice.

9. **`scene.reset` clears annotations + highlights + camera animation, but NOT agent windows.** Agent-hooks made the decisive argument: agent windows have CLI-side state (`_windows`, `_indexMap`, `AgentWindow._lines`). Browser-side removal would leave dead references on the CLI. Agent window cleanup must flow through `AgentWindowManager.closeAll()` on the CLI side. The browser command `scene.reset` takes an optional `--windows` flag only for emergency cleanup.

10. **Shared color constants file.** Structural colors (IDENTITY, HIGHLIGHT, DIMMED, AGENT_DEFAULT, ERROR, LABEL, ANNOTATION) live in a shared `colorConstants.js`. Phase-specific colors (PHASE_0, PHASE_1, PHASE_2, PHASE_3 and their dim variants) are local constants in `AgentWindowManager.mjs` or `agentLayoutCommands.js` -- they encode cross-ref semantics that the annotation layer should not know about.

11. **`highlight.grid` remains index-only (no label string resolution).** The CLI resolves labels to indices via `AgentWindowManager.getIndex(label)`. Browser commands stay generic and index-based, consistent with every other `grid.*` command.

12. **Phase layout computation stays CLI-side.** The browser remains a dumb spatial renderer. Cross-ref phase semantics (reviewer/target pairs, forward/inverse order) are orchestration logic belonging to the CLI. If actual grid dimensions are needed, a future `grid.bounds` query command can be added, but estimated sizes (W=120, H=80) are sufficient for initial implementation.

13. **Command queue is single FIFO.** CliConnection has one `_pendingResolve` slot. All commands -- lifecycle, layout, content updates -- flow through AgentWindowManager's `_enqueue`. True parallelism would require CliConnection pipelining, which is out of scope. Sequential execution is correct and latency is acceptable (sub-second for a full layout pass).

## Implementation Plan

### Files to create

**1. `examples/github-viewer/websocket/commands/annotationCommands.js`**
- Source: scene-api Phase 0 code (nearly complete, needs two modifications)
- Modification A: Replace `ctx.highlights` usage with shared helper functions (`saveGridState`, `restoreGridState`, `restoreAllGridStates`) that accept a `baseColor` parameter
- Modification B: Add `scene.reset` command alongside existing `scene.clear_annotations`

```javascript
// scene.reset handler sketch
router.register('scene.reset', (args, ctx) => {
    // 1. Clear all annotations
    for (const [id, entry] of ctx.annotations) {
        entry.grid.dispose();
        ctx.scene.remove(entry.grid);
    }
    ctx.annotations.clear();
    // 2. Restore all highlights
    restoreAllGridStates(ctx);
    // 3. Cancel camera animation
    ctx._cancelCameraAnimation?.();
    // 4. Optionally remove agent windows
    const removeWindows = args.includes('--windows');
    // ... (only if flag passed, and only as emergency fallback)
    return { text: 'OK: scene reset', data: { ... } };
});
```

**2. `examples/github-viewer/websocket/commands/colorConstants.js`**
- Shared structural colors only

```javascript
export const COLORS = {
    IDENTITY:       { r: 1.0, g: 1.0, b: 1.0 },
    AGENT_DEFAULT:  { r: 0.3, g: 1.0, b: 0.5 },
    HIGHLIGHT:      { r: 0.2, g: 1.0, b: 1.0 },
    DIMMED:         { r: 0.3, g: 0.3, b: 0.3 },
    LABEL:          { r: 1.0, g: 1.0, b: 1.0 },
    ANNOTATION:     { r: 1.0, g: 0.9, b: 0.5 },
    ERROR:          { r: 1.0, g: 0.3, b: 0.3 },
};
```

**3. `examples/github-viewer/websocket/commands/agentLayoutCommands.js`**
- Source: visualization Phase 0 code
- Commands: `layout.agents`, `layout.focus`, `layout.undim`, `layout.correlate`
- Must use shared `saveGridState`/`restoreGridState` helpers
- Must call `ctx._cancelCameraAnimation?.()` before any camera movement
- Must sync `cameraController.pitch`/`yaw` after `cam.lookAt()` in `layout.correlate`
- Phase-specific colors as local constants (not imported from colorConstants.js)

### Files to modify

**4. `examples/github-viewer/websocket/commands/cameraCommands.js`**
- Add `camera.fitall` command
- Implementation: compute bounding box of all visible grids, position camera at `center + dist` along Z, sync pitch/yaw to zero

```javascript
router.register('camera.fitall', (args, ctx) => {
    ctx._cancelCameraAnimation?.();
    const grids = ctx.getGrids();
    if (grids.length === 0) return { text: 'WARN: no grids to fit' };
    // Compute bounding box, camera distance from FOV, position, sync controller
    // (visualization's Round 2 sketch is the reference implementation)
    return { text: `OK: camera fit ${grids.length} grids` };
});
```

**5. `examples/github-viewer/websocket/index.js`**
- Add to `buildContext()`:
  - `annotations: new Map()` -- annotation registry
  - `gridVisualState: new Map()` -- shared highlight/dim state (replaces per-module tracking)
  - `_cancelCameraAnimation: null` -- centralized animation cancellation function
- Add shared helper functions (exported or attached to ctx):

```javascript
// Shared visual state helpers (can be a module or inline)
export function saveGridState(ctx, gridIndex, baseColor = COLORS.IDENTITY) {
    if (ctx.gridVisualState.has(gridIndex)) return;
    const grid = ctx.getGrids()[gridIndex];
    if (!grid) return;
    ctx.gridVisualState.set(gridIndex, {
        originalZ: grid.position.z,
        originalScale: grid.scale.x,
        baseColor: { ...baseColor },
    });
}

export function restoreGridState(ctx, gridIndex) {
    const saved = ctx.gridVisualState.get(gridIndex);
    if (!saved) return false;
    const grid = ctx.getGrids()[gridIndex];
    if (!grid) return false;
    grid.position.z = saved.originalZ;
    grid.scale.setScalar(saved.originalScale);
    const coll = grid.collection || grid.glyphCollection;
    if (coll?.setGroupColor) coll.setGroupColor(0, saved.baseColor);
    ctx.gridVisualState.delete(gridIndex);
    return true;
}

export function restoreAllGridStates(ctx) {
    for (const idx of [...ctx.gridVisualState.keys()]) {
        restoreGridState(ctx, idx);
    }
}
```

**6. `examples/github-viewer/websocket/commands/index.js`**
- Import and register `annotationCommands` and `agentLayoutCommands`

**7. `examples/github-viewer/cli/AgentWindowManager.mjs`**
- Remove auto-positioning fields (`_nextSlot`, `_spacing`, `_baseX`, `_baseY`, `_baseZ`)
- Add layout methods: `arrangeAgents(style)`, `focusAgent(label)`, `correlateAgents(pairs)`, `setPhaseLayout(phase, labels, options)`, `undimAll()`, `fitAll()`
- Layout methods are thin wrappers: `return this._enqueue('layout.agents ' + style)`
- Phase layout methods (`_layoutPhase0` through `_layoutPhase3`) compute positions CLI-side using estimated dimensions and send `grid.position`/`grid.color` commands
- Phase colors as local constants: `PHASE_0`, `PHASE_1`, `PHASE_1_DIM`, `PHASE_2`, `PHASE_2_DIM`, `PHASE_3`
- Add `getIndex(label)` public method for external code needing index-based access

**8. `examples/github-viewer/cli/glyph-cli.mjs`**
- Extend `encodeContentArgs()` to handle `label.create` and `scene.annotate` base64 encoding (first arg is text, rest are coordinates)

### Files to delete

**9. `examples/github-viewer/cli/AgentLayoutHelper.mjs`** (if it exists)
- All functionality absorbed into AgentWindowManager

### Layer diagram (final)

```
CLI side                          Browser side
--------                          ------------
agent-hook.mjs                    annotationCommands.js
    |                                 (labels, annotations, highlights,
    v                                  camera.animate, camera.lookat.grid,
AgentWindowManager.mjs                 scene.reset)
    (lifecycle + layout +         agentLayoutCommands.js
     phase mgmt + queue)              (layout.agents, layout.focus,
    |                                  layout.undim, layout.correlate)
    v                             cameraCommands.js
CliConnection.mjs                     (camera.fitall + existing cmds)
    |                                     |
    | WebSocket                   All share: ctx.gridVisualState,
    +------------------------>         ctx.annotations,
                                       ctx._cancelCameraAnimation,
                                       colorConstants.js
```

## Implementer Vote

**scene-api** should implement.

Rationale: Scene-api's Phase 0 contains the largest block of implementation-ready code (annotationCommands.js is ~450 lines, nearly shippable). The converged plan's browser-side work -- annotationCommands.js, context bag modifications, cameraCommands.js additions, colorConstants.js, and the shared visual state helpers -- is predominantly scene-api's code with targeted modifications from the other two agents' feedback. The agentLayoutCommands.js file draws from visualization's Phase 0 but the implementation pattern (command registration, ctx usage, grid iteration) is identical to what scene-api already wrote. The AgentWindowManager merge draws from agent-hooks' Phase 0 but the layout methods being absorbed are thin `_enqueue` wrappers that follow scene-api's command-queue pattern.

Starting from scene-api's Phase 0 requires the fewest modifications to reach the converged design, making it the most efficient implementation path.
