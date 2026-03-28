# Round 1: Visualization Reviews Scene-API and Agent-Hooks

Reviewer: **visualization**
Reviewing: **scene-api**, **agent-hooks**

---

## Alignment

The three designs converge well on foundational conventions:

1. **`agent:` grid naming.** All three documents agree that agent windows are CodeGrids named `agent:<label>`. Scene-api's `annotationCommands.js` explicitly avoids polluting `ctx.getGrids()` with annotations (line 77: annotations go into `ctx.annotations`, not the grid list). My `findAgentGrids()` (phase0-visualization lines 61-76) scans `ctx.getGrids()` for names starting with `agent:`. Agent-hooks' `AgentWindowManager._refreshIndices()` uses the same `name.startsWith('agent:')` check. This means annotations and agent windows live in separate namespaces by default -- annotations won't show up in `layout.agents` output, which is correct.

2. **Grid index tracking.** Both agent-hooks (`AgentWindowManager._indexMap`) and my visualization (`AgentLayoutHelper.agentGridMap`) maintain label-to-index maps and rebuild them after removals via `grid.list`. The regex parsing pattern is identical: `result.text.match(/grid #(\d+)/)`.

3. **Command-level composability.** Scene-api's `highlight.grid` and my `layout.focus` both use `setGroupColor(0, ...)` on the collection to tint grids. Both use Z-offset to pull focused content forward. Both are reversible (scene-api saves `originalScale`/`originalZ` in `ctx.highlights`; I use `layout.undim` to reset).

4. **Camera sync.** Scene-api's `camera.lookat.grid` (lines 343-349) and `camera.animate` (lines 253-316) both sync `CameraController.pitch`/`yaw` after moves. My `layout.focus` delegates to `ctx.cameraController.focusOnGrid()` which presumably does the same thing. No conflict here.

---

## Gaps

### 1. No shared highlight state between scene-api and visualization

Scene-api tracks highlights in `ctx.highlights` (Map of grid index to `{originalScale, originalZ}`). My `layout.focus` and `layout.correlate` commands modify `grid.position.z` and `setGroupColor` directly without going through `ctx.highlights`. This means:

- If a user runs `highlight.grid 3` (scene-api) and then `layout.focus protocol` (visualization) on the same grid, the Z-position and color are overwritten without saving original state.
- Running `highlight.clear` afterward would restore stale `originalZ` values that `layout.focus` already changed.
- Running `layout.undim` would reset colors but not restore the scale/Z that `highlight.grid` saved.

**Fix needed:** Either (a) my layout commands should write to `ctx.highlights` before modifying grids, or (b) we need a shared highlight/dim state tracker that both command modules use.

### 2. `camera.fitall` does not exist yet

My `AgentLayoutHelper` calls `camera.fitall` at the end of every phase layout transition (lines 738, 779, etc.). Neither scene-api nor the existing command set implements this command. Scene-api adds `camera.animate` and `camera.lookat.grid`, but not a "fit all visible grids" command.

**Fix needed:** Either scene-api should add `camera.fitall`, or I should compute a bounding box across all agent grids and emit a `camera.animate` call to the computed position.

### 3. No `grid.visibility` command

My Phase 0 doc lists `grid.visibility` as an existing command I depend on (line 8). But scene-api does not implement it, and I could not confirm it exists in the current codebase. The group DataTexture system supports visibility via `gColor.a` (per MEMORY.md), but there is no WebSocket command to toggle it.

### 4. Agent-hooks' `ensureWindow` creates duplicate grids under race conditions

Agent-hooks acknowledges this (error handling section, line 974): two concurrent `agent-hook.mjs` invocations for the same label can both pass the `grid.list` check and both call `grid.create`. My `findAgentGrids()` would then find two grids with the same `agent:` prefix and include both in layout calculations, producing overlapping windows.

---

## Tensions

### 1. AgentWindowManager auto-positioning vs. layout.agents command

This is the central tension between agent-hooks and visualization.

Agent-hooks' `AgentWindowManager.createWindow()` (lines 288-294) auto-positions new windows in a horizontal row with 100-unit spacing:

```javascript
const pos = options.position || {
    x: this._baseX + (this._nextSlot * this._spacing),
    y: this._baseY,
    z: this._baseZ,
};
this._nextSlot++;
await window.setPosition(pos.x, pos.y, pos.z);
```

My `layout.agents row` command (lines 97-107 of `agentLayoutCommands.js`) also arranges agents in a row but uses actual grid bounds for spacing (15-unit gap, not 100-unit). When the cross-ref orchestrator creates 3 windows via `AgentWindowManager`, they land at x=0, 100, 200. Then when it calls `layout.agents row`, they jump to x=0, ~55, ~110 (based on actual content width). This double-positioning is wasteful and produces a visible jump.

**Resolution:** AgentWindowManager should NOT auto-position. It should create grids at (0,0,0) and let the layout system handle arrangement. The `_nextSlot` auto-positioning is a convenience that conflicts with any intentional layout.

### 2. AgentLayoutHelper vs. AgentWindowManager -- two classes doing overlapping work

My `AgentLayoutHelper.mjs` and agent-hooks' `AgentWindowManager.mjs` both:
- Wrap `CliConnection`
- Track label-to-grid-index maps (`agentGridMap` vs `_indexMap`)
- Create grids via `grid.create` with `agent:` prefix
- Set position/color/scale via `grid.position`/`grid.color`/`grid.scale`
- Rebuild maps after removal via `grid.list`

The difference: AgentWindowManager adds content management (`write`, `append`, `setTitle`, line buffering with `_maxLines`) while AgentLayoutHelper adds layout algorithms (`setPhaseLayout`, `arrangeAgents`, `focusAgent`).

**These should be one class**, or AgentWindowManager should compose AgentLayoutHelper (as my Phase 0 Section 4 sketches). Having two independent classes that both maintain a label-to-index map over the same CliConnection is a bug waiting to happen -- they would drift out of sync after any `grid.remove`.

### 3. Scene-api's highlight uses grid indices; visualization uses agent labels

Scene-api's `highlight.grid` takes a numeric grid index. My `layout.focus` takes an agent label string. If a CLI user wants to highlight an agent window using scene-api commands, they need to know the grid index. If they want to focus using visualization commands, they use the label. There is no bridge: `highlight.grid` cannot accept a label, and `layout.focus` does not update `ctx.highlights`.

### 4. Color semantics collision

Scene-api's `highlight.grid` defaults to cyan `{r: 0.2, g: 1.0, b: 1.0}` (line 169). My `layout.focus` uses green `{r: 0, g: 1, b: 0}` for focused and dim green `{r: 0, g: 0.3, b: 0}` for dimmed (lines 300-310). Scene-api's `scene.annotate` defaults to amber `{r: 1.0, g: 0.9, b: 0.5}`. My phase 3 convergence also uses amber/gold `{r: 1.0, g: 0.85, b: 0.3}`.

There is no color palette coordination. An annotation's amber could be confused with a phase-3 convergence cluster. A highlighted grid's cyan could appear alongside focused agents in green, creating visual noise with no semantic coherence.

---

## Recommendations

1. **Merge AgentLayoutHelper into AgentWindowManager.** AgentWindowManager should own both content management (write/append) and layout (arrangeAgents/setPhaseLayout). The label-to-index map must be singular. AgentLayoutHelper's layout algorithms become methods on AgentWindowManager. The browser-side `agentLayoutCommands.js` remains separate (it operates on raw grids, not the CLI abstraction).

2. **Add a `highlightManager` to ctx** that both `annotationCommands.js` and `agentLayoutCommands.js` use. It should track original state (position, scale, color) and provide `save(gridIndex)`, `restore(gridIndex)`, and `restoreAll()` methods. Both `highlight.grid` and `layout.focus` call `save()` before modifying grids.

3. **Remove auto-positioning from AgentWindowManager.createWindow().** Grids should be created at origin. The caller explicitly calls `arrangeAgents()` or `setPhaseLayout()` after creating all windows. This eliminates the double-positioning jump and gives the layout system full authority.

4. **Implement `camera.fitall`** in scene-api's `annotationCommands.js` or as a new camera command. It should compute the bounding box of all visible grids and animate the camera to frame them. Alternatively, my AgentLayoutHelper should compute the bounding box client-side and call `camera.animate`.

5. **Define a shared color palette constant.** Something like:
   - Highlight/focus: `{r: 0.2, g: 1.0, b: 1.0}` (cyan)
   - Dimmed: `{r: 0.3, g: 0.3, b: 0.3}` (gray)
   - Phase 0/1: `{r: 0.3, g: 1.0, b: 0.5}` (green)
   - Phase 2: `{r: 0.4, g: 0.8, b: 1.0}` (blue)
   - Phase 3/annotations: `{r: 1.0, g: 0.85, b: 0.3}` (gold)
   - Error/critical: `{r: 1.0, g: 0.3, b: 0.3}` (red)

   Both browser-side commands and CLI-side helpers should import from one shared constants file.

6. **Add label-based grid lookup to scene-api.** `highlight.grid` should accept either an index or an `agent:<label>` string. This bridges the index-vs-label gap without requiring users to cross-reference `grid.list` output.

---

## Key Insight

The three proposals accidentally created two parallel management layers for the same grids. On the CLI side, AgentWindowManager (agent-hooks) and AgentLayoutHelper (visualization) both wrap CliConnection with independent label-to-index maps. On the browser side, `ctx.highlights` (scene-api) and `layout.focus`/`layout.undim` (visualization) both modify grid color and Z-position without awareness of each other. The fix is structural: one class on each side. CLI gets a single `AgentWindowManager` that merges layout methods from AgentLayoutHelper. Browser gets a shared highlight/dim state object in `ctx` that both annotation and layout commands use. Without this consolidation, any interleaved use of annotation + layout commands will produce corrupted visual state (stale saved positions, double-applied color tints, phantom highlights that `highlight.clear` cannot undo).
