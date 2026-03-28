# Round 3: agent-hooks convergence

## Settled

1. **One CLI class, not two.** AgentWindowManager absorbs all layout methods from AgentLayoutHelper. AgentLayoutHelper is deleted. All three agents agreed across all rounds. The dual-map problem is a guaranteed index-drift bug under concurrent use.

2. **Remove auto-positioning from AgentWindowManager.** The `_nextSlot`, `_spacing`, `_baseX/Y/Z` fields are removed. Windows are created at origin. The caller explicitly invokes `arrangeAgents()` or `setPhaseLayout()` afterward. Unanimous across all rounds.

3. **Single command queue via `_enqueue`.** All commands (window lifecycle AND layout) flow through AgentWindowManager's serialized `_enqueue`. No raw `conn.send()` calls. This was a correctness requirement given CliConnection's single `_pendingResolve` slot.

4. **Browser-side highlight state tracker on `ctx`.** A shared `Map<gridIndex, {originalZ, originalScale, originalColor}>` (or a thin class wrapping it) is added to the context bag. Both `highlight.grid` (scene-api) and `layout.focus` (visualization) call `save()` before modifying a grid; both `highlight.clear` and `layout.undim` call `restore()`. First-writer-wins semantics prevent clobbering. All three agents converged on this.

5. **Camera animation cancellation is centralized.** `ctx._cancelCameraAnimation` (or `ctx.highlights.cancelCameraAnimation()`) is called by any command that moves the camera: `camera.animate`, `layout.focus`, `layout.correlate`, `camera.lookat.grid`, `camera.fitall`. Mechanical fix, no disagreement.

6. **`camera.fitall` must be implemented.** Goes in `cameraCommands.js`. Computes bounding box of all visible grids, positions camera to frame them. Visualization depends on it for every phase transition. All three agents flagged this gap.

7. **`agent:` prefix naming convention is the stable contract.** No disputes. Agent windows are named `agent:<label>` at creation time. Browser-side discovery uses prefix scan on `ctx.getGrids()`.

8. **`scene.reset` clears annotations + highlights + dim state but NOT agent windows by default.** Agent windows have CLI-side state (AgentWindowManager maps, AgentWindow line buffers). Browser-side silent removal would leave the CLI holding dead references. Agent cleanup must go through `AgentWindowManager.closeAll()`. The `--windows` flag is an opt-in override.

9. **Phase layout stays CLI-only.** The browser should not know about cross-ref semantics (phases, reviewer/target pairs). The CLI computes approximate positions from estimated sizes (W=120, H=80), sends `grid.position` commands, then calls `camera.fitall`. A future `grid.bounds` query could provide real sizes without pushing orchestration logic to the browser.

10. **Annotations are NOT children of grid Object3Ds.** Visualization explicitly dissented from my Round 1 suggestion. Annotations remain top-level scene objects in `ctx.annotations`. If a grid moves, the CLI clears and re-creates annotations. This keeps both systems simple. My `label.attach` proposal is withdrawn.

11. **`highlight.grid` stays index-only.** Both scene-api and I agreed: browser-side commands work with grid indices. Label resolution is the CLI's responsibility. No label-string support in `highlight.grid`.

12. **Color palette: identity white `{1,1,1}` is the reset/restore color.** Agent windows use white as their group-color base. Phase colors and agent-specific tints are temporary overlays applied by layout commands and cleared back to white by `layout.undim`. Phase-specific colors (green, blue, gold) live in the CLI-side AgentWindowManager or agentLayoutCommands, not in a shared browser-side constants file. Structural colors (IDENTITY, HIGHLIGHT, DIMMED, ERROR) go in a shared `agentColors.js`.

13. **`ctx.getSceneObjects({ type })` is deferred.** All three agents agreed in Round 2 that this is premature abstraction. The `agent:` prefix scan and `ctx.annotations` Map are sufficient for now.

14. **`layout.correlate` must sync `cameraController.pitch/yaw` after setting camera position.** This is an implementation gap in visualization's code, not a design disagreement. The fix is mechanical: extract Euler angles from the camera rotation and write them to the controller.

## Implementation Plan

### Files to create

**`examples/github-viewer/websocket/commands/agentColors.js`** (new)
Shared semantic color constants used by both browser-side command modules.

```javascript
export const COLORS = {
    IDENTITY:    { r: 1.0, g: 1.0, b: 1.0 },
    HIGHLIGHT:   { r: 0.2, g: 1.0, b: 1.0 },
    DIMMED:      { r: 0.3, g: 0.3, b: 0.3 },
    ANNOTATION:  { r: 1.0, g: 0.85, b: 0.3 },
    ERROR:       { r: 1.0, g: 0.3, b: 0.3 },
};
```

**`examples/github-viewer/websocket/commands/HighlightManager.js`** (new)
Shared highlight/dim state tracker. Stored on `ctx.highlights`.

```javascript
export default class HighlightManager {
    constructor() {
        this._saved = new Map();  // gridIndex -> { originalZ, originalScale, originalColor }
        this.cameraAnimationId = null;
    }

    save(gridIndex, state) {
        if (this._saved.has(gridIndex)) return;  // first-writer-wins
        this._saved.set(gridIndex, { ...state });
    }

    restore(gridIndex) {
        const saved = this._saved.get(gridIndex);
        if (!saved) return null;
        this._saved.delete(gridIndex);
        return saved;
    }

    restoreAll() {
        const all = new Map(this._saved);
        this._saved.clear();
        return all;
    }

    has(gridIndex) { return this._saved.has(gridIndex); }

    cancelCameraAnimation() {
        if (this.cameraAnimationId != null) {
            cancelAnimationFrame(this.cameraAnimationId);
            this.cameraAnimationId = null;
        }
    }
}
```

**`examples/github-viewer/websocket/commands/annotationCommands.js`** (new, from scene-api Phase 0)
Browser-side commands: `label.create`, `scene.annotate`, `highlight.grid`, `highlight.clear`, `scene.reset`. Uses `ctx.highlights` (HighlightManager) and `ctx.annotations` (Map). No changes from scene-api's design except: `highlight.grid`/`highlight.clear` delegate save/restore to HighlightManager instead of private helpers.

**`examples/github-viewer/websocket/commands/agentLayoutCommands.js`** (new, from visualization Phase 0)
Browser-side commands: `layout.agents`, `layout.focus`, `layout.undim`, `layout.correlate`. Uses `ctx.highlights` for save/restore. Restores to `COLORS.IDENTITY` (white), not green. `layout.correlate` must sync `cameraController.pitch/yaw` after lookAt.

### Files to modify

**`examples/github-viewer/websocket/index.js`** (modify)
Add to `buildContext()`:
- `ctx.annotations = new Map()`
- `ctx.highlights = new HighlightManager()`
- Register annotationCommands and agentLayoutCommands with the router

**`examples/github-viewer/websocket/commands/cameraCommands.js`** (modify)
Add `camera.fitall` command. Implementation: compute bounding box of all visible grids, position camera at `center + (maxDim / 2) / tan(fov/2) * 1.2` on Z axis, sync pitch/yaw to 0.

**`examples/github-viewer/cli/AgentWindowManager.mjs`** (modify -- major)
Remove: `_nextSlot`, `_spacing`, `_baseX`, `_baseY`, `_baseZ`, auto-positioning in `createWindow()`.
Add layout methods absorbed from AgentLayoutHelper:
- `arrangeAgents(style)` -- sends `layout.agents <style>`
- `focusAgent(label)` -- sends `layout.focus <label>`
- `correlateAgents(pairs)` -- sends `layout.correlate <pairs>`
- `undimAll()` -- sends `layout.undim`
- `setPhaseLayout(phase, agentLabels, options)` -- computes positions CLI-side, sends `grid.position` + `grid.color` for each agent, then `camera.fitall`
- `fitAll()` -- sends `camera.fitall`
Phase color constants (PHASE_0 green, PHASE_1 bright green, PHASE_2 blue, PHASE_3 gold) are local to this file.

**`examples/github-viewer/cli/AgentWindow.mjs`** (no changes needed)
The Phase 0 code is correct as-is.

**`examples/github-viewer/cli/agent-hook.mjs`** (no changes needed)
The Phase 0 code is correct as-is. The stateless reconnection via `ensureWindow()` is the right pattern.

### Files to delete

**`examples/github-viewer/cli/AgentLayoutHelper.mjs`** (delete)
All functionality absorbed into AgentWindowManager.

### Integration sequence

1. Create `agentColors.js` and `HighlightManager.js` (no dependencies)
2. Create `annotationCommands.js` (depends on agentColors, HighlightManager)
3. Create `agentLayoutCommands.js` (depends on agentColors, HighlightManager)
4. Add `camera.fitall` to `cameraCommands.js`
5. Wire everything into `websocket/index.js` buildContext
6. Modify `AgentWindowManager.mjs` (remove auto-positioning, add layout methods)
7. Delete `AgentLayoutHelper.mjs`
8. Test via browser example: create 3 agent windows, call `arrangeAgents('row')`, `focusAgent('protocol')`, `undimAll()`, `setPhaseLayout(0, [...])` through phase 3

## Implementer Vote

**agent-hooks** should implement.

Rationale: The converged plan's center of gravity is AgentWindowManager. My Phase 0 code for AgentWindow.mjs, AgentWindowManager.mjs, and agent-hook.mjs is the closest to the final design -- it needs surgical modifications (remove auto-positioning, add layout method wrappers) rather than a rewrite. The browser-side files (annotationCommands, agentLayoutCommands, HighlightManager) are new creations that draw from all three Phase 0s equally, but they are smaller in scope and can be built by referencing the converged specs above. The CLI-side merge (absorbing AgentLayoutHelper into AgentWindowManager) is the highest-risk change due to the index-tracking correctness requirements, and agent-hooks has the deepest context on the queue serialization and `_refreshIndices` mechanics.
