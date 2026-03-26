# IDE Feature Implementation — Renderer Specialist Round 2 Synthesis

## Convergence Across All Three Agents

All three Round 1 analyses converged on the same Phase 1 scope without coordination:

1. **SelectionManager** keyed by `sourcePath` (not grid index) — stable across layout switches.
2. **CameraController click disambiguation** — mousedown/mouseup displacement threshold of 5px.
3. **CodeColorManager extension** — the `_handlePropertyChanged` filter on `heatMetric` must be broadened to support arbitrary watched properties per layer.
4. **GitHubRepoViewer wiring** — instantiate SelectionManager, wire canvas-click, sync tree panel.

The Arch agent (ide-round1-Arch.md) proposed the most complete data model: primary + Set, `_syncToFileState()` writing a `selected` boolean, and a `watchProperties` extension to `registerLayer()`. The UX agent (ide-round1-UX.md) defined the interaction details: 5px threshold, Z-pop of 2-3 units, no camera yank on canvas click. The Renderer agent (ide-round1-Renderer.md, my own) confirmed the GPU mechanism: group color tint via DataTexture + group Z-offset, both O(1), no shader changes, existing API.

## Tensions and Resolutions

**Tension 1: Selection layer priority**
- Arch agent: priority 15 (above heatmap at 10, below future search at 20+)
- UX agent: priority 20
- Resolution: Use **priority 15** as specified in the task brief. This places selection above heatmap but below search-highlight (priority 30 per UX agent). The priority gap between 15 and 30 is intentional — future layers can slot in between.

**Tension 2: Z-pop mechanism — Object3D.position vs. group offset**
- Renderer agent: use `setGroupOffset(groupId, {x:0,y:0,z:5})` — O(1), DataTexture write
- UX agent: "grid.position.z increases by 2-3 units" — Object3D property
- Resolution: Use **Object3D position.z** on the grid directly (not group offset). Reason: group offset operates on glyph positions INSIDE the grid's collection. Moving the whole CodeGrid (including background plane) requires moving the Object3D. The Z-pop should lift the entire grid (glyphs + background), not just the glyphs. Group offset only affects glyphs in that group's collection, not the background mesh which is a separate child.

**Tension 3: watchProperties API design**
- Arch agent: explicit `watchProperties` array on each layer, checked in `_handlePropertyChanged`
- Current code: hardcoded `if (propName !== 'heatMetric') return;`
- Resolution: Implement the Arch agent's design. Each `registerLayer()` call can pass optional `watchProperties`. The `_handlePropertyChanged` checks if any enabled layer watches the changed property before re-resolving. The heatmap layer gets `watchProperties: ['heatMetric']` implicitly (by keeping the existing default behavior when no `watchProperties` is passed, or by explicit declaration).

**Tension 4: Tree panel sync direction**
- UX agent: bidirectional — canvas click updates tree, tree click sets selection
- Arch agent: single source of truth in SelectionManager
- Resolution: SelectionManager is the single source of truth. Canvas clicks go through SelectionManager.select(), which notifies listeners. GitHubRepoViewer listens and syncs tree `.selected` class. Tree panel clicks continue to call `focusOnGrid()` AND now additionally call `selectionManager.select()`. The existing `camera-focus-changed` event continues to work for tree sync of camera-focus; selection sync is separate.

## Implementation Plan

### Files created
- `examples/github-viewer/SelectionManager.js` — new

### Files modified
- `examples/github-viewer/CameraController.js` — add click disambiguation, emit `canvas-click`
- `examples/github-viewer/CodeColorManager.js` — extend `registerLayer` with `watchProperties`, update `_handlePropertyChanged`
- `examples/github-viewer/GitHubRepoViewer.js` — instantiate SelectionManager, wire events, update tree sync

### What SelectionManager does
- Holds `_primary` (string|null) and `_selected` (Set<string>)
- `select(sourcePath, {additive})` — adds to selection, updates FileStateManager `selected` property
- `deselect(sourcePath)` / `clear()` — removes, updates FileStateManager
- `handleClick(raycaster, grids)` — performs raycast against background meshes, resolves to grid, calls select/deselect
- Fires `file-selected` CustomEvent on window for external sync
- On selection: applies Z-pop (+3) to selected grid(s), restores previous
- Color tinting delegated to CodeColorManager's selection layer (reads `selected` from FileStateManager)

### What CodeColorManager change does
- `registerLayer(name, { priority, colorFn, watchProperties = [] })` — adds `watchProperties`
- `_handlePropertyChanged` checks if ANY enabled layer watches `propName` before bailing early
- Heatmap registration in GitHubRepoViewer updated to include `watchProperties: ['heatMetric']`

### What CameraController change does
- Track `_mouseDownX`, `_mouseDownY` on mousedown
- On mouseup: compute displacement, if < 5px dispatch `CustomEvent('canvas-click', { detail: { clientX, clientY } })` on the canvas element
- Drag behavior unchanged

### What GitHubRepoViewer change does
- Instantiates `SelectionManager` with `fileStateManager` reference
- Registers selection color layer on `codeColorManager` (priority 15, watches `selected`)
- Listens for `canvas-click` on canvas, forwards to `selectionManager.handleClick()`
- Listens for `file-selected`, syncs `.selected` class on tree items by `dataset.path`
- Wires Escape key to `selectionManager.clear()`
- Tree file clicks now also call `selectionManager.select(sourcePath)`
- On `clearGrids()`, calls `selectionManager.clear()`

### GPU cost
- Selection: 1 DataTexture write per file (color tint via CodeColorManager) + Object3D position.z change
- Deselection: same, reversing
- Zero additional draw calls, no shader changes, no buffer rebuilds
