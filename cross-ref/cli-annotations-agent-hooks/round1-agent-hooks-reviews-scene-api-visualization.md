# Round 1: agent-hooks reviews scene-api and visualization

## Alignment

Both scene-api and agent-hooks agree that **CodeGrids are the universal display primitive**. Scene-api's `label.create` and `scene.annotate` create CodeGrids. Agent-hooks' `AgentWindow` wraps a CodeGrid via `grid.create`. Visualization's `findAgentGrids()` discovers them by naming convention. All three perspectives route mutations through the same WebSocket CommandRouter, and none requires new Three.js rendering code. This is a strong architectural consensus.

The `agent:` prefix naming convention is shared between agent-hooks (`AgentWindowManager.createWindow` names grids `agent:${label}`, line 267 of phase0-agent-hooks.md) and visualization (`findAgentGrids` checks `name.startsWith('agent:')`, line 71 of phase0-visualization.md). This is a clean contract.

Scene-api and agent-hooks both track their objects in separate registries: scene-api uses `ctx.annotations` (a Map keyed by generated ID), agent-hooks uses `AgentWindowManager._windows` (a Map keyed by label). Both intentionally avoid contaminating `ctx.getGrids()` for their metadata objects -- though agent-hooks' grids DO appear in `ctx.getGrids()` (they are full CodeGrids created via `grid.create`), while scene-api's annotations are added via `ctx.scene.add()` and tracked in `ctx.annotations` separately.

## Gaps

### 1. Labels/annotations are NOT agent windows, but should be composable with them

Scene-api creates annotations as standalone CodeGrids added directly to `ctx.scene` and tracked in `ctx.annotations`. Agent-hooks creates windows as CodeGrids via `grid.create` tracked in `ctx.getGrids()`. These are two parallel object systems with no cross-references.

A concrete scenario that fails: an agent hook wants to attach a label to its window (e.g., "PHASE 1: REVIEWING" floating above the agent panel). The agent would need to call `label.create` via scene-api, manually compute coordinates relative to its grid's position, and track the label ID for later cleanup. There is no `label.attach <annotation-id> <grid-index>` command, and `scene.clear_annotations` would nuke agent labels without notifying `AgentWindowManager`.

### 2. No `camera.fitall` command exists

Visualization's `AgentLayoutHelper._layoutPhase0` (line 738 of phase0-visualization.md) calls `this.conn.send('camera.fitall')` at the end of every phase transition. Scene-api defines `camera.animate` and `camera.lookat.grid` but never defines `camera.fitall`. Neither does the existing command set (I checked the codebase). This is a hard dependency gap -- every phase layout call will fail with an unknown command error.

### 3. Scene-api annotations invisible to visualization's agent discovery

`findAgentGrids()` in visualization scans `ctx.getGrids()` for grids with `agent:` prefix names. But scene-api's annotations are added via `ctx.scene.add(grid)` and stored in `ctx.annotations`, NOT in the array returned by `ctx.getGrids()`. This means visualization cannot discover or lay out annotations. If an agent creates annotations via scene-api commands alongside its agent window, those annotations will not move when `layout.agents` is called. They will float in stale positions.

### 4. Command queue serialization: two independent implementations

Agent-hooks builds `AgentWindowManager._queue` (line 386) to serialize commands through `CliConnection._pendingResolve`. Visualization builds `AgentLayoutHelper` which calls `this.conn.send()` directly with no queue. If both are used simultaneously (which the visualization doc explicitly proposes in section 4, line 933: "The AgentWindowManager should use AgentLayoutHelper as its layout backend"), the layout helper's direct `conn.send()` calls will collide with the window manager's queued sends on the same `CliConnection`.

Resolution: `AgentLayoutHelper` must either accept a `sendCommand` function (like `AgentWindow` does) instead of a raw `CliConnection`, or `AgentWindowManager` must wrap its `_enqueue` as the send function passed to `AgentLayoutHelper`.

## Tensions

### 1. Grid index tracking: two competing strategies

Agent-hooks tracks indices in `AgentWindowManager._indexMap` and refreshes via `_refreshIndices()` which calls `grid.list` (line 417). Visualization's `AgentLayoutHelper` independently maintains `agentGridMap` and refreshes via `_rebuildGridMap()` (line 904 of phase0-visualization.md). If both are active, they will issue redundant `grid.list` queries and may hold stale indices that contradict each other.

This is not just inefficiency -- it is a correctness hazard. After `AgentWindowManager.closeAll()` removes grids in reverse-index order (line 333), it calls `_refreshIndices()`. But `AgentLayoutHelper.agentGridMap` is not notified and retains the old indices. A subsequent `layout.agents` call from `AgentLayoutHelper` would send `grid.position` commands with wrong indices, moving the wrong grids.

### 2. Auto-positioning conflict

Agent-hooks auto-positions new windows in a horizontal row at `spacing=100` units apart (line 229, 288-293). Visualization's `layout.agents row` computes positions based on actual grid bounds with `spacing.horizontal=15` (line 46-47). If an agent-hook creates three windows at x=0, 100, 200, and then `layout.agents row` is called, it will reposition them to x=0, ~70, ~140 (based on content width + 15px gap). The agent-hooks' slot counter (`_nextSlot`) is now out of sync with the actual positions.

This is a design tension: should the CLI side or the browser side own positioning authority? Currently both claim it.

### 3. `scene.clear_annotations` vs `AgentWindowManager.closeAll()`

Scene-api's `scene.clear_annotations` (line 422) removes everything from `ctx.annotations` and clears all highlights. Agent-hooks' `closeAll()` removes grids via `grid.remove`. These are completely independent cleanup paths. Running `scene.clear_annotations` does not touch agent windows. Running `closeAll()` does not touch annotations. There is no unified "clean slate" command, so a user must call both to fully reset.

More subtly: if someone calls `scene.clear_annotations` thinking it clears "all CLI-created objects," agent windows survive. If someone calls `closeAll()` thinking it removes all non-content grids, annotations survive.

### 4. `agent:` naming collides with annotation ID namespace

Scene-api generates annotation IDs as `label-${Date.now()}-...` and `annot-${Date.now()}-...` (lines 60, 390). These won't collide with agent-hooks' `agent:${label}` prefix. However, nothing prevents a user from calling `label.create` with the text "agent:protocol" which would NOT create a grid named `agent:protocol` -- the annotation's name is the generated ID, not the text content. So the naming convention is safe. But the two systems have no awareness of each other's existence -- `label.list` won't show agent windows, and `layout.agents.list` won't show annotations.

## Recommendations

1. **Unify the send path.** `AgentLayoutHelper` should accept an `enqueue` function rather than a raw `CliConnection`. The integration point in visualization section 4 should be: `this.layout = new AgentLayoutHelper(cmd => this._enqueue(cmd))` rather than `new AgentLayoutHelper(conn)`. This eliminates the command serialization collision.

2. **Add `camera.fitall` to scene-api.** Without it, every phase layout transition silently fails on the final command. Scene-api should define this alongside `camera.animate` and `camera.lookat.grid`. Implementation: compute bounding box of all visible grids, position camera to encompass them.

3. **Single index registry.** Either `AgentWindowManager` owns the label-to-index map and `AgentLayoutHelper` queries it, or they share a reference. The simplest fix: `AgentLayoutHelper` drops its own `agentGridMap` and accepts a `getIndex(label)` callback from the manager.

4. **Let browser side own positioning.** Agent-hooks' auto-positioning (100-unit spacing) should be a one-time initial placement. Once `layout.agents` is called, the browser side becomes the positioning authority. Agent-hooks should not track `_nextSlot` positions after layout commands have run. Alternatively, the initial placement should delegate to `layout.agents row` immediately after window creation.

5. **Add a `scene.clear_all` command** that calls both `scene.clear_annotations` and removes all `agent:*` grids. This gives users a single "reset everything non-content" command.

## Key Insight

The three perspectives have independently converged on CodeGrid-as-universal-primitive but built three separate management layers on top: `ctx.annotations` (scene-api), `AgentWindowManager._windows` (agent-hooks), and `findAgentGrids` scan (visualization). The actual browser-side truth is split between `ctx.getGrids()` (which includes agent windows but not annotations) and `ctx.annotations` (which includes annotations but not agent windows). This split means no single query returns "all non-content objects in the scene," making cleanup, layout, and discovery fragile.

The fix is not to merge these into one registry -- their lifecycles are genuinely different (annotations are fire-and-forget, agent windows are long-lived, layout is ephemeral). But there should be a unified discovery API on the browser side, something like `ctx.getSceneObjects({ type: 'agent' | 'annotation' | 'content' | 'all' })`, so that commands like `layout.agents`, `scene.clear_annotations`, and any future "select all non-content" operation have a single source of truth rather than scanning by naming convention.
