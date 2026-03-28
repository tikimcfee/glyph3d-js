# Round 2: scene-api reviews visualization, then agent-hooks

Reviewer: **scene-api** (inverse order: visualization first, agent-hooks second)

---

## Evolved Understanding

After reading all three Round 1 reviews, my understanding has shifted in three ways:

**1. The visual state problem is worse than I initially described.** In Round 1 I proposed `ctx.visualState` as a coordination object. But agent-hooks' review (Round 1, Gaps section 3) reveals a deeper structural issue: scene-api annotations live outside `ctx.getGrids()` entirely (added via `ctx.scene.add()`), which means visualization's `findAgentGrids()` cannot discover them and no layout command can move them. My Round 1 recommendation of a shared `ctx.visualState` only solves the highlight/color tracking problem, not the discoverability problem. Agent-hooks' counter-proposal of `ctx.getSceneObjects({ type })` is the more complete fix.

**2. The CLI class merge is not optional -- it is a correctness requirement.** All three reviews independently identified the AgentWindowManager/AgentLayoutHelper duplication. But visualization's Round 1 review (Tensions section 2) makes the sharpest case: both classes maintain independent label-to-index maps over the same CliConnection, and any `grid.remove` causes them to drift. This is not a code smell; it is a guaranteed bug under concurrent use. The merge must happen before either class ships.

**3. `camera.fitall` is a hard blocker.** I missed this in my Phase 0 entirely. Both agent-hooks' review (Gaps section 2: "every phase layout transition silently fails") and visualization's review (Gaps section 2) flag that `camera.fitall` does not exist but is called by every phase layout transition. This needs to be implemented in the camera commands module, not in annotationCommands.

---

## Convergence

All three reviews now agree on these concrete decisions:

### C1: Single CLI-side class (AgentWindowManager absorbs layout methods)

All three Round 1 reviews recommend this. The merged class owns:
- Window lifecycle (create, write, append, close) -- from agent-hooks
- Label-to-index map (singular) -- shared concern
- Layout algorithms (arrangeAgents, setPhaseLayout, focusAgent) -- from visualization
- Command serialization queue -- from agent-hooks

```javascript
// Merged AgentWindowManager.mjs -- sketch of the combined API surface
export default class AgentWindowManager {
    constructor(conn, options = {}) {
        this.conn = conn;
        this._windows = new Map();    // label -> AgentWindow
        this._indexMap = new Map();    // label -> gridIndex
        this._queue = [];
        this._processing = false;
    }

    // === Window lifecycle (from agent-hooks) ===
    async createWindow(label, content, options = {}) { /* grid.create agent:<label> ... */ }
    async closeWindow(label) { /* grid.remove ... */ }
    async closeAll() { /* reverse-order removal */ }
    getWindow(label) { return this._windows.get(label); }

    // === Layout (absorbed from AgentLayoutHelper) ===
    async arrangeAgents(mode = 'row', options = {}) {
        await this._refreshIndices();
        const entries = [...this._indexMap.entries()];
        // layout computation (row/column/grid/circle)
        for (const [label, idx] of entries) {
            await this._enqueue(`grid.position ${idx} ${x} ${y} ${z}`);
        }
    }

    async focusAgent(label) {
        await this._refreshIndices();
        const focusIdx = this._indexMap.get(label);
        if (focusIdx == null) return;
        for (const [l, idx] of this._indexMap) {
            if (l === label) {
                await this._enqueue(`highlight.grid ${idx}`);
            } else {
                await this._enqueue(`grid.color ${idx} 0.3 0.3 0.3`);
            }
        }
        await this._enqueue(`camera.lookat.grid ${focusIdx}`);
    }

    async unfocusAll() {
        for (const [, idx] of this._indexMap) {
            await this._enqueue(`highlight.clear ${idx}`);
        }
    }

    async setPhaseLayout(phase) {
        // phase-specific arrangement + color coding
        await this.arrangeAgents(phase <= 1 ? 'row' : 'grid');
        await this._enqueue('camera.fitall');
    }

    // === Internal (singular index tracking) ===
    async _refreshIndices() {
        const result = await this._enqueue('grid.list');
        this._indexMap.clear();
        // parse grid.list, rebuild map for agent: prefixed grids
    }

    async _enqueue(cmd) {
        // serialized command queue (from agent-hooks)
    }
}
```

Key design choice: `_enqueue` is the single send path. All layout methods go through it. No raw `conn.send()` calls anywhere in the class.

### C2: Browser-side highlight state tracker

All three reviews agree that `highlight.grid` (scene-api) and `layout.focus`/`layout.undim` (visualization) must share state. The concrete implementation:

```javascript
// In websocket/index.js buildContext(), add:
ctx.highlightManager = {
    _saved: new Map(),  // gridIndex -> { originalScale, originalZ, originalColor }

    save(gridIndex, grid) {
        if (this._saved.has(gridIndex)) return;  // don't overwrite first save
        this._saved.set(gridIndex, {
            originalScale: grid.scale.clone(),
            originalZ: grid.position.z,
            // originalColor: null means identity white
        });
    },

    restore(gridIndex, grid) {
        const saved = this._saved.get(gridIndex);
        if (!saved) return false;
        grid.scale.copy(saved.originalScale);
        grid.position.z = saved.originalZ;
        const collection = grid.getCollection();
        if (collection?.setGroupColor) {
            collection.setGroupColor(0, AGENT_DEFAULT_COLOR);
        }
        this._saved.delete(gridIndex);
        return true;
    },

    restoreAll(grids) {
        for (const idx of [...this._saved.keys()]) {
            if (grids[idx]) this.restore(idx, grids[idx]);
        }
    },

    isHighlighted(gridIndex) {
        return this._saved.has(gridIndex);
    }
};
```

Both `annotationCommands.js` and `agentLayoutCommands.js` call `ctx.highlightManager.save()` before modifying a grid, and `ctx.highlightManager.restore()` to undo. The private `_clearHighlight` helper in scene-api becomes a thin wrapper around this.

### C3: Remove auto-positioning from AgentWindowManager

All three reviews flag the 100-unit auto-spacing as conflicting with layout commands. Consensus: create windows at origin, caller explicitly invokes layout afterward.

### C4: `camera.fitall` must be implemented

Agent-hooks and visualization both depend on it. It belongs in `cameraCommands.js` alongside existing camera commands, not in annotationCommands.

---

## Remaining Tensions

### T1: Default color for agent windows -- green vs white

Scene-api uses `{r:1, g:1, b:1}` (white/identity) as the reset color. Visualization uses `{r:0, g:1, b:0}` (green) as the normal agent color. These are semantically different:
- White = "no tint applied" (identity multiplier in the group DataTexture)
- Green = "this is an agent window" (semantic color coding)

The tension is real because they serve different purposes. My proposed resolution: use a two-tier system.

```javascript
// examples/github-viewer/websocket/commands/colorConstants.js
export const COLORS = {
    // Identity (no visual modification)
    IDENTITY:       { r: 1.0, g: 1.0, b: 1.0 },

    // Agent windows -- semantic defaults
    AGENT_DEFAULT:  { r: 0.3, g: 1.0, b: 0.5 },
    AGENT_DIMMED:   { r: 0.15, g: 0.4, b: 0.2 },

    // Highlight / focus (temporary emphasis)
    HIGHLIGHT:      { r: 0.2, g: 1.0, b: 1.0 },  // cyan

    // Phase colors
    PHASE_EXPLORE:  { r: 0.3, g: 1.0, b: 0.5 },  // green
    PHASE_CROSS:    { r: 0.4, g: 0.8, b: 1.0 },  // blue
    PHASE_CONVERGE: { r: 1.0, g: 0.85, b: 0.3 },  // gold

    // Annotations
    LABEL:          { r: 1.0, g: 1.0, b: 1.0 },   // white
    ANNOTATION:     { r: 1.0, g: 0.9, b: 0.5 },   // amber

    // Status
    ERROR:          { r: 1.0, g: 0.3, b: 0.3 },   // red
};
```

The `highlightManager.restore()` method needs to know what color to restore TO. For content grids, that is `IDENTITY`. For agent windows, that is `AGENT_DEFAULT`. This means the `save()` call should also capture the "base color" -- or the manager should accept a `defaultColor` parameter per grid type.

Updated `save()`:

```javascript
save(gridIndex, grid, baseColor = COLORS.IDENTITY) {
    if (this._saved.has(gridIndex)) return;
    this._saved.set(gridIndex, {
        originalScale: grid.scale.clone(),
        originalZ: grid.position.z,
        baseColor,  // what to restore to
    });
},

restore(gridIndex, grid) {
    const saved = this._saved.get(gridIndex);
    if (!saved) return false;
    grid.scale.copy(saved.originalScale);
    grid.position.z = saved.originalZ;
    const collection = grid.getCollection();
    if (collection?.setGroupColor) {
        collection.setGroupColor(0, saved.baseColor);
    }
    this._saved.delete(gridIndex);
    return true;
}
```

This way scene-api's `highlight.grid` on a content grid saves with `IDENTITY`, visualization's `layout.focus` on an agent grid saves with `AGENT_DEFAULT`, and both restore correctly.

### T2: Cleanup command consolidation -- how many "clear" commands?

Current state across all three proposals:
- `scene.clear_annotations` -- removes labels + annotations + highlights (scene-api)
- `scene.clear_windows` -- removes agent windows via windowManager (existing)
- `layout.undim` -- resets agent colors/Z (visualization)
- `highlight.clear` -- restores one or all highlights (scene-api)
- `AgentWindowManager.closeAll()` -- CLI-side removal of agent windows (agent-hooks)

Agent-hooks proposes `scene.clear_all`. I proposed `scene.reset` in Round 1. These are the same idea with different names.

Concrete proposal -- keep all the granular commands but add one umbrella:

```javascript
router.register('scene.reset', (args, ctx) => {
    // 1. Clear all annotations (labels + scene.annotate objects)
    for (const [id, entry] of ctx.annotations) {
        entry.grid.dispose();
        ctx.scene.remove(entry.grid);
    }
    ctx.annotations.clear();

    // 2. Restore all highlights via shared manager
    const grids = ctx.getGrids();
    ctx.highlightManager.restoreAll(grids);

    // 3. Cancel any in-flight camera animation
    ctx._cancelCameraAnimation?.();

    // 4. Optionally remove agent windows (controlled by flag)
    const removeWindows = args.includes('--windows');
    let windowCount = 0;
    if (removeWindows && ctx.windowManager) {
        windowCount = ctx.windowManager.clearAll();
    }

    return {
        text: `OK: reset scene (annotations cleared, highlights restored${removeWindows ? `, ${windowCount} windows removed` : ''})`,
        data: { annotationsCleared: ctx.annotations.size, highlightsRestored: true, windowsRemoved: windowCount }
    };
});
```

By default `scene.reset` does NOT remove agent windows (they are long-lived and owned by the agent process). Pass `--windows` to also remove them. This respects the lifecycle difference agent-hooks' review identified.

### T3: Camera animation conflict between scene-api and visualization

Scene-api's `camera.animate` uses rAF with cancellation tracking. Visualization's `layout.focus` calls `ctx.cameraController.focusOnGrid()`. Visualization's `layout.correlate` directly sets `cam.position` and `cam.lookAt` without syncing pitch/yaw.

All three reviews agree on the fix: centralized cancellation. But the implementation detail matters. Here is the concrete proposal:

```javascript
// Add to ctx in buildContext():
ctx._cancelCameraAnimation = null;  // function or null

// In camera.animate, after starting rAF:
ctx._cancelCameraAnimation = () => {
    if (ctx._cameraAnimationId != null) {
        cancelAnimationFrame(ctx._cameraAnimationId);
        ctx._cameraAnimationId = null;
    }
};

// In layout.focus (agentLayoutCommands.js):
ctx._cancelCameraAnimation?.();
ctx.cameraController.focusOnGrid(target.index);

// In layout.correlate -- MUST sync pitch/yaw after lookAt:
ctx._cancelCameraAnimation?.();
cam.position.set(centerX, centerY, pullback);
cam.lookAt(centerX, centerY, 0);
if (ctx.cameraController) {
    const euler = cam.rotation.clone();
    euler.order = 'YXZ';
    ctx.cameraController.pitch = euler.x;
    ctx.cameraController.yaw = euler.y;
}
```

This is not a tension anymore -- the fix is mechanical and all three reviews agree on it.

---

## Synthesis

The three proposals form a clean layered architecture once the identified merges are applied:

```
Layer 4: Agent orchestration (agent-hook.mjs)
    |  Calls AgentWindowManager methods
    v
Layer 3: CLI-side window + layout manager (AgentWindowManager.mjs -- merged)
    |  Sends serialized WebSocket commands
    v
Layer 2: Browser-side command handlers
    |  annotationCommands.js  -- labels, annotations, highlights
    |  agentLayoutCommands.js -- layout.agents, layout.focus, layout.undim
    |  cameraCommands.js      -- camera.animate, camera.lookat.grid, camera.fitall
    |  All share: ctx.highlightManager, ctx.annotations, COLORS constants
    v
Layer 1: CodeGrid + GlyphRenderer + Group DataTexture
```

Files to create/modify:

| File | Action | Owner |
|------|--------|-------|
| `commands/annotationCommands.js` | Create (from scene-api Phase 0) | scene-api |
| `commands/agentLayoutCommands.js` | Create (from visualization Phase 0) | visualization |
| `commands/colorConstants.js` | Create (shared color palette) | all |
| `commands/cameraCommands.js` | Add `camera.fitall` | scene-api |
| `websocket/index.js` | Add `ctx.highlightManager`, `ctx.annotations`, `ctx._cancelCameraAnimation` | scene-api |
| `AgentWindowManager.mjs` | Absorb layout methods from AgentLayoutHelper, remove auto-positioning | agent-hooks |
| `AgentLayoutHelper.mjs` | Delete (merged into AgentWindowManager) | visualization |

The browser-side commands (Layer 2) are independent modules that share state through `ctx`. The CLI-side manager (Layer 3) is a single class. The orchestrator (Layer 4) calls the manager. No circular dependencies.

---

## Dissent

### D1: I disagree with agent-hooks' proposal of `ctx.getSceneObjects({ type })` as a browser-side discovery API

Agent-hooks' Round 1 Key Insight proposes a unified discovery API: `ctx.getSceneObjects({ type: 'agent' | 'annotation' | 'content' | 'all' })`. This is architecturally clean but overengineered for the current need. The existing separation works:
- `ctx.getGrids()` returns content + agent grids (they ARE content grids, created via `grid.create`)
- `ctx.annotations` returns labels/annotations (they are NOT content grids, created via `ctx.scene.add()`)

The `agent:` prefix naming convention is sufficient for filtering agent grids out of `ctx.getGrids()`. Adding a typed registry means every grid creation path must call a registration function, which adds coupling for no immediate benefit. If a future feature needs this, it can be added then. For now, the naming convention plus the separate `ctx.annotations` map covers all use cases.

### D2: I partially disagree with visualization's color palette proposal

Visualization proposes `HIGHLIGHT: cyan`, `PHASE_EXPLORE: green`, `PHASE_CROSS: blue`, `PHASE_CONVERGE: gold`. I agree with having a shared constants file, but the phase-specific colors belong in `AgentWindowManager` or `agentLayoutCommands.js`, not in a shared constants file. Only the structural colors (IDENTITY, HIGHLIGHT, DIMMED, AGENT_DEFAULT, ERROR) need to be shared. Phase colors are visualization-specific implementation details that scene-api and agent-hooks should not need to know about.

Proposed split:
- `colorConstants.js`: IDENTITY, HIGHLIGHT, DIMMED, AGENT_DEFAULT, ERROR, LABEL, ANNOTATION
- `agentLayoutCommands.js` (or AgentWindowManager): PHASE_EXPLORE, PHASE_CROSS, PHASE_CONVERGE (local constants)

### D3: `highlight.grid` should NOT accept label strings

Visualization's Round 1 Recommendation 6 suggests `highlight.grid` should accept either an index or an `agent:<label>` string. I disagree. WebSocket commands on the browser side work with grid indices because that is what `ctx.getGrids()` returns. Adding label-based lookup to `highlight.grid` means the browser command must scan all grids by name, which conflates the command layer with the discovery layer. The CLI side already knows indices (via `AgentWindowManager._indexMap`). The CLI should resolve labels to indices and send `highlight.grid <index>`. This keeps browser commands simple and index-based, matching every other `grid.*` command.
