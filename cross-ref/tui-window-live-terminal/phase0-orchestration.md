# Phase 0 — Orchestration: Agent Windows Tracking Code in 3D Space

## The Bridge Problem

Two independent systems exist for agent windows:

- **Browser-side**: `TUIWindow` + `TUIWindowManager` — owns the actual CodeGrid, renders text in the 3D scene, manages lifecycle within the browser.
- **CLI-side**: `AgentWindow` + `AgentWindowManager` — sends commands over WebSocket to create/write/position grids in the viewer. Stateless per invocation (reconnects via `ensureWindow`).

These systems do not know about each other. The CLI creates grids via `grid.create` and refers to them by index. The browser has no concept of "this TUI window belongs to agent X which is reading file Y." The orchestration layer bridges this gap.

## Architecture: Three New Components

### 1. `orchestrationCommands.js` (browser-side, registered on CommandRouter)

New commands that the CLI can invoke:

```
window.track <window-id> <grid-index>
window.untrack <window-id>
window.track.list
```

**Implementation sketch:**

```js
// Tracking state: lives on ctx (command context bag)
// ctx.windowTracking = Map<windowId, { gridIndex, highlightId }>

router.register('window.track', (args, ctx) => {
    const [windowId, gridIdxStr] = args;
    const gridIdx = parseInt(gridIdxStr);
    const grids = ctx.getGrids();

    // Validate the target grid exists
    if (isNaN(gridIdx) || gridIdx < 0 || gridIdx >= grids.length) {
        return { text: `ERR: invalid grid index ${gridIdxStr}`, data: null };
    }

    // Find the agent window grid by name convention "agent:<windowId>"
    const agentGridIdx = grids.findIndex(g => {
        const name = g.getFilename?.() || g.name || '';
        return name === `agent:${windowId}`;
    });

    if (agentGridIdx === -1) {
        return { text: `ERR: no agent window '${windowId}'`, data: null };
    }

    // Position: attach agent window to the right of the target grid
    // Uses the same anchor math as grid.attach "right"
    const agentGrid = grids[agentGridIdx];
    const targetGrid = grids[gridIdx];
    const tgtBounds = getWorldBounds(targetGrid);

    agentGrid.position.set(
        tgtBounds.max.x + 5,       // right edge + gap
        tgtBounds.max.y,            // align tops
        tgtBounds.center.z + 2      // slight Z-forward so it overlaps cleanly
    );

    // Highlight the tracked grid
    saveGridState(ctx, gridIdx);
    const coll = targetGrid.getCollection?.() || targetGrid.collection;
    if (coll?.setGroupColor) {
        coll.setGroupColor(0, { r: 0.3, g: 0.9, b: 0.5 });  // tracking green
    }

    // Store tracking state
    ctx.windowTracking.set(windowId, { gridIndex: gridIdx, agentGridIndex: agentGridIdx });

    return {
        text: `OK: window '${windowId}' tracking grid #${gridIdx}`,
        data: { windowId, gridIndex: gridIdx, agentGridIndex: agentGridIdx }
    };
});

router.register('window.untrack', (args, ctx) => {
    const [windowId] = args;
    const tracking = ctx.windowTracking.get(windowId);
    if (!tracking) {
        return { text: `ERR: window '${windowId}' is not tracking`, data: null };
    }

    // Restore highlight
    restoreGridState(ctx, tracking.gridIndex);
    ctx.windowTracking.delete(windowId);

    return { text: `OK: window '${windowId}' untracked`, data: { windowId } };
});
```

### 2. `AgentWindowManager.trackFile(label, filePath)` (CLI-side addition)

New method on `AgentWindowManager` that:
1. Queries `grid.list` to find a grid whose filename matches `filePath`
2. Sends `window.track <label> <gridIndex>`
3. Optionally sends `camera.lookat.grid <gridIndex>` to frame both

```js
async trackFile(label, filePath) {
    const listResult = await this._enqueue('grid.list');
    const grids = listResult.data?.grids || [];

    // Match by filename (exact or suffix match for partial paths)
    const match = grids.find(g => {
        const name = g.filename || g.sourcePath || '';
        return name === filePath || name.endsWith('/' + filePath);
    });

    if (!match) return null;

    await this._enqueue(`window.track ${label} ${match.index}`);
    return match.index;
}

async untrackFile(label) {
    return this._enqueue(`window.untrack ${label}`);
}
```

### 3. Focus hook integration in `agent-hook.mjs`

New flag: `--track <filepath>` that triggers the focus-follow behavior.

```
node agent-hook.mjs --agent protocol --append "Reading src/GlyphAtlas.js" \
    --track src/GlyphAtlas.js
```

This calls `mgr.trackFile('protocol', 'src/GlyphAtlas.js')` after writing content. The hook already supports `ensureWindow`, so the flow is:

1. `ensureWindow` finds/creates the agent grid
2. `append` streams the agent's output
3. `trackFile` finds the code grid, sends `window.track`, highlights it
4. On next invocation with a different `--track`, the prior tracking is cleared first

## Focus Flow: End-to-End Sequence

```
CLI (agent-hook)                WebSocket Relay              Browser (CommandRouter)
     |                               |                              |
     |-- grid.create (agent:proto) ->|----------------------------->| creates CodeGrid
     |<- grid #7 -------------------|<-----------------------------|
     |                               |                              |
     |-- grid.text 7 <base64> ----->|----------------------------->| writes content
     |<- OK ------------------------|<-----------------------------|
     |                               |                              |
     |-- grid.list ----------------->|----------------------------->| returns all grids
     |<- [{index:3, filename:"src/GlyphAtlas.js"}, ...] ----------|
     |                               |                              |
     |-- window.track proto 3 ----->|----------------------------->| positions grid #7
     |                               |                              | next to grid #3,
     |                               |                              | highlights #3
     |<- OK: tracking grid #3 ------|<-----------------------------|
```

## Multi-Agent Spatial Layout

When multiple agents track different files simultaneously, their windows cluster near the code they're reading. Overlap prevention reuses the existing `layout.agents` algorithm but constrained:

- Each tracked window is anchored to its target grid (position is relative, not absolute)
- Untracked windows fall back to auto-layout (row/column)
- `window.track.list` returns all active tracking pairs so the CLI can reason about spatial conflicts

The `setPhaseLayout` method on `AgentWindowManager` already handles phase-specific arrangements. For cross-ref integration:

- **Phase 0**: Each agent gets a TUI window. `setPhaseLayout(0, labels)` arranges them in a row. No tracking yet — agents are doing initial analysis.
- **Phase 1 (forward review)**: Reviewer windows track their review target's output window. `trackFile` is not used here — instead `window.track reviewer-label target-agent-grid-index` pairs agent windows directly. The reviewer window slides next to the target window.
- **Phase 2 (inverse review)**: Same as Phase 1 but reversed pairings. Old tracking is cleared, new pairs established.
- **Phase 3 (convergence)**: All tracking cleared. `setPhaseLayout(3, labels)` pulls windows into a radial cluster.

## Command Summary

| Command | Side | Purpose |
|---------|------|---------|
| `window.track <id> <grid#>` | browser | Attach agent window near a code grid, highlight it |
| `window.untrack <id>` | browser | Detach, remove highlight |
| `window.track.list` | browser | List active tracking pairs |
| `mgr.trackFile(label, path)` | CLI | Find grid by filename, send window.track |
| `mgr.untrackFile(label)` | CLI | Send window.untrack |
| `agent-hook --track <path>` | CLI | Shorthand: append + track in one invocation |

## Key Design Decisions

1. **One-shot positioning, not live constraints.** `window.track` moves the agent window once. If the target grid moves later, the agent window does not follow. The CLI can re-issue `window.track` to re-snap. This matches `grid.attach` semantics.

2. **Tracking state lives on `ctx.windowTracking` (browser-side).** The CLI is stateless across invocations. The browser is the source of truth for what is tracked. The CLI queries via `window.track.list` if needed.

3. **Agent grids are identified by name convention `agent:<label>`.** Both `AgentWindowManager.ensureWindow` and `findAgentGrids` in `agentLayoutCommands.js` already use this convention. The orchestration layer reuses it.

4. **Highlight uses existing `gridVisualState` save/restore.** No new highlight system. `window.track` calls `saveGridState` + `setGroupColor`. `window.untrack` calls `restoreGridState`. This means tracking highlights compose correctly with `layout.focus` and `highlight.grid`.

5. **Camera framing is opt-in.** `window.track` does not move the camera. The CLI can follow up with `camera.lookat.grid` or `camera.fitall` if desired. The `--track` flag on `agent-hook` could add `--camera` as a sub-option.
