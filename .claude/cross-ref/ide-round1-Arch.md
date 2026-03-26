# IDE Feature Analysis -- Architecture Specialist Round 1

Analysis of system architecture, API surface design, and integration strategy for IDE-like features in glyph3d-js. Written with knowledge of the existing WebSocket agent control system on `origin/claude/websocket-api-state-control-ARAcm`.

---

## Part 1: Existing Subsystem Inventory

### What the codebase has today (main branch)

**Rendering pipeline** (library code in `src/`):
- `GlyphAtlas` -- font texture atlas with shelf-packing
- `GlyphRenderer` (V15) -- single instanced draw call, group DataTexture (offset, color, colorBlend, scale, visibility per group)
- `GlyphCollection` -- deferred batched text rendering, group API proxy
- `CodeGrid` -- Object3D wrapping a GlyphCollection, with background plane, filename label, content loading (sync + async worker)
- Layout managers: `HierarchicalLayoutManager`, `TreemapLayoutManager`, `SpiralLayoutManager`, `GridLayoutManager`

**Application layer** (in `examples/github-viewer/`):
- `GitHubRepoViewer` -- main orchestrator, ~38KB, owns the render loop
- `SceneContext` -- shared reference bag (THREE, scene, camera, renderer, canvas, atlas, getGrids)
- `CameraController` -- translation-first navigation (drag pan, scroll zoom, WASD), persisted settings, grid focus methods
- `FileStateManager` -- reactive property store keyed by sourcePath, callback-based notification
- `CodeColorManager` -- layered color resolution (priority-ordered, first non-null wins), currently only heatmap layer
- `BackdropManager` -- depth-coded directory planes (hierarchical mode only)
- `NameplateManager` -- billboard CodeGrid labels for directories (hierarchical mode only)
- `StatePersistence` -- localStorage save/restore of camera + repo state
- UI components: Drawer, AppShell, TouchController, LogCapturePanel, DiffPanel

### What the WebSocket branch adds (not merged)

On `origin/claude/websocket-api-state-control-ARAcm`, living in `examples/github-viewer/websocket/`:

- **CommandRouter** -- flat `Map<string, handler>` of dot-separated command names to `(args[], viewer) => string` handlers. Shell-style string parsing with double-quote support. Partial-match autocomplete. This is the core pattern we should evolve.
- **WebSocketManager** -- browser-side WS client, connects to relay, dispatches incoming commands through CommandRouter, sends responses back
- **TUIWindowManager** -- lifecycle management for CodeGrid-backed text panes (create, track, auto-position, remove)
- **TUIWindow** -- resizable text pane backed by a CodeGrid, cols/rows buffer, write/append/scroll/clear
- **TUIFormatter** -- box-drawing tables, KV formatting, padding utilities
- **Command modules**: `cameraCommands.js`, `gridCommands.js`, `windowCommands.js`, `sceneCommands.js`, `systemCommands.js`
- **ws-relay.py** -- Python asyncio WebSocket relay server (display + N controllers)

---

## Part 2: Architecture Assessment

### 2.1 The command module pattern is the right foundation

The WebSocket branch's CommandRouter + command modules pattern is exactly what we need for the IDE features. The reasons:

1. **Testable without UI**: commands are pure functions `(args, viewer) => string`. They can be invoked from WebSocket, from keyboard shortcuts, from a command palette, from the file tree panel, or from automated tests.

2. **Introspectable**: `router.listCommands()` gives programmatic access to all available actions. This powers help displays, autocomplete, and agent discovery.

3. **Composable**: a "navigate to file" shortcut and a "navigate to file" command palette action both call the same `file.focus` command handler.

4. **Agent-friendly**: the string-based protocol (`"camera.move 0 50 100"`) is trivially parseable by LLM agents without requiring JSON schema knowledge.

However, the current CommandRouter has limitations that must be addressed:

- **Return type**: all handlers return `string`. IDE features need structured data (search results, selection state, file metadata). The router should support both string responses (for TUI/agent display) and structured responses (for programmatic consumers).
- **No async**: handlers are synchronous. Search across files should be async (especially with future worker offloading). The router should accept async handlers.
- **Tightly coupled to viewer**: handlers receive `viewer` (the GitHubRepoViewer instance). IDE features need access to subsystems (SelectionManager, SearchManager, NavigationHistory) that do not exist on the viewer yet. The router should receive a context/registry object rather than the raw viewer.

### 2.2 The FileStateManager + CodeColorManager pipeline is sound but needs widening

The current pipeline: `FileStateManager.setProperty() --> _notify() --> CodeColorManager._handlePropertyChanged() --> setGroupColor()`.

**Problem**: `_handlePropertyChanged` on line 127 of `CodeColorManager.js` hardcodes `if (propName !== 'heatMetric') return;`. This means selection state, search match counts, and any future property writes are silently ignored.

**Fix**: change to a `watchProperties` pattern where each layer declares which properties trigger re-resolution:

```javascript
registerLayer(name, { priority, colorFn, watchProperties = [] })
```

The `_handlePropertyChanged` checks if any enabled layer watches the changed property. If so, it re-resolves the color for that file. This is the minimal change needed to unlock selection highlighting, search highlighting, and future layers.

### 2.3 SceneContext needs expansion

`SceneContext` currently holds: THREE, scene, camera, renderer, canvas, atlas, getGrids, hierarchicalManager, layoutManager.

For IDE features, subsystems need access to each other (SearchManager needs NavigationHistory; ShortcutManager needs SelectionManager). Two approaches:

**Option A: Expand SceneContext into a service registry.** Add subsystems as properties:
```javascript
ctx.selectionManager = ...
ctx.navigationHistory = ...
ctx.searchManager = ...
```
Pro: simple, follows existing pattern. Con: SceneContext becomes a god-object that every subsystem depends on.

**Option B: Dependency injection at construction.** Each subsystem receives only what it needs:
```javascript
new SearchManager(fileStateManager, codeColorManager, navigationHistory)
```
Pro: explicit dependencies, no god-object. Con: wiring code in GitHubRepoViewer becomes complex.

**Recommendation: Option B for subsystem construction, Option A for the CommandRouter context.** Subsystems are constructed with explicit dependencies (clean, testable). Command handlers receive a context bag that provides access to all subsystems (necessary because commands need broad access and adding a dependency per command is impractical).

### 2.4 The TUIWindow/TUIWindowManager pattern is reusable

TUIWindow wraps a CodeGrid with a cols/rows text buffer. This is exactly the right abstraction for:
- Search results panel (a TUIWindow showing match results)
- Status/info panels (a TUIWindow showing file metadata)
- Debug output (already its use case on the WebSocket branch)

The window manager's auto-positioning is naive (stack vertically, wrap to next column), but the create/get/remove/list lifecycle is clean. For IDE features, we would want to position windows relative to the camera or relative to specific grids, not at fixed world coordinates. This is a straightforward extension.

---

## Part 3: API Surface Design

### 3.1 Evolved CommandRouter

The new router should handle three invocation modes:

1. **String commands** (agent/WebSocket/command palette): `"search query sometext"` --> returns formatted string
2. **Programmatic calls** (shortcut handlers, internal code): `router.execute('search.query', ['sometext'])` --> returns structured result
3. **Batch operations** (scripts): `router.executeBatch(['select src/foo.js', 'camera.focus src/foo.js'])`

```javascript
class CommandRouter {
    constructor(context) {
        this.context = context;  // service registry, not raw viewer
        this.commands = new Map();
    }

    register(name, handler, { description, usage, returns }) {
        // handler signature: (args[], context) => { text: string, data: any }
        // 'text' is the human-readable response
        // 'data' is the structured response
    }

    async execute(input) {
        // input can be a string ("search.query sometext")
        // or pre-parsed [name, ...args]
        // Returns { text, data }
    }
}
```

The dual-return pattern (`text` + `data`) means TUI/agent consumers get formatted strings while programmatic consumers get structured data, from the same handler.

### 3.2 Command Namespace Design

Extending the WebSocket branch's existing namespaces and adding new ones for IDE features:

```
EXISTING (from WebSocket branch):
  help                           List all commands
  status                         Show scene status
  camera.move <x> <y> <z>       Set camera position
  camera.lookat <x> <y> <z>     Point camera at position
  camera.focus <index|name>      Focus camera on grid/window
  camera.reset                   Reset camera to default
  camera.speed <value>           Set camera movement speed
  camera.info                    Show camera details
  grid.list                      List all loaded grids
  grid.info <index>              Show grid details
  grid.color <idx> <r> <g> <b>  Set grid text color
  grid.visibility <idx> <bool>   Show/hide a grid
  scene.info                     Show scene details
  scene.clear_windows            Remove all TUI windows
  window.create <id> [cols] [rows]
  window.write <id> <text>
  window.append <id> <line>
  window.resize <id> <cols> <rows>
  window.move <id> <x> <y> <z>
  window.close <id>
  window.list
  window.clear <id>
  window.title <id> <title>
  window.info <id>

NEW (IDE features):
  select <path>                  Select file by sourcePath
  select.add <path>              Add file to selection
  select.clear                   Clear selection
  select.list                    List selected files
  select.info                    Show selection state (primary + set)

  nav.focus <path>               Navigate camera to file (pushes history)
  nav.focus.dir <dirPath>        Navigate to directory
  nav.focus.all                  Fit all content in view
  nav.back                       Navigate back in history
  nav.forward                    Navigate forward in history
  nav.history                    Show navigation history

  search <query>                 Search across all files
  search.next                    Go to next match
  search.prev                    Go to previous match
  search.clear                   Clear search
  search.results                 Show current match list

  layout.switch <name>           Switch layout mode
  layout.info                    Show current layout details

  color.layers                   List color layers and status
  color.toggle <layer>           Toggle a color layer on/off
  color.set <path> <r> <g> <b>  Override color for a file

  file.info <path>               Show file metadata
  file.content <path> [line]     Show file content (or specific line)
  file.list [pattern]            List files matching glob pattern
```

### 3.3 Command Registration Pattern

Following the WebSocket branch pattern exactly, but with the evolved handler signature:

```javascript
// selectCommands.js
export default function registerSelectCommands(router) {
    router.register('select', (args, ctx) => {
        if (args.length < 1) return { text: 'ERR: usage: select <path>', data: null };
        const path = args[0];
        const result = ctx.selectionManager.select(path);
        if (!result) return { text: `ERR: file not found: ${path}`, data: null };
        return {
            text: `OK: selected ${path}`,
            data: { primary: path, selected: [...ctx.selectionManager.getSelected()] }
        };
    }, {
        description: 'Select file by path',
        usage: '<sourcePath>',
        returns: '{ primary, selected[] }'
    });

    router.register('select.add', (args, ctx) => { ... }, { ... });
    router.register('select.clear', (args, ctx) => { ... }, { ... });
    router.register('select.list', (args, ctx) => { ... }, { ... });
}
```

### 3.4 ViewerAPI Facade

The ViewerAPI is a typed, promise-based JavaScript API that wraps the CommandRouter for programmatic use. It is the public contract for code that imports the viewer directly (not going through string commands).

```javascript
class ViewerAPI {
    constructor(router) {
        this._router = router;
    }

    // Selection
    async select(path, opts) { return (await this._router.execute(`select ${path}`)).data; }
    async selectAdd(path) { return (await this._router.execute(`select.add ${path}`)).data; }
    async clearSelection() { return (await this._router.execute('select.clear')).data; }
    async getSelection() { return (await this._router.execute('select.list')).data; }

    // Navigation
    async focusOn(path) { return (await this._router.execute(`nav.focus ${path}`)).data; }
    async back() { return (await this._router.execute('nav.back')).data; }
    async forward() { return (await this._router.execute('nav.forward')).data; }

    // Search
    async search(query) { return (await this._router.execute(`search ${query}`)).data; }
    async nextMatch() { return (await this._router.execute('search.next')).data; }
    async prevMatch() { return (await this._router.execute('search.prev')).data; }
    async clearSearch() { return (await this._router.execute('search.clear')).data; }

    // Introspection
    async getFiles(pattern) { ... }
    async getFileInfo(path) { ... }

    // Raw command access
    async execute(commandString) { return this._router.execute(commandString); }
}
```

Exposed as `window.viewer` for agent/devtools access.

---

## Part 4: Integration Architecture

### 4.1 Subsystem dependency graph

```
                 GitHubRepoViewer (owner)
                         |
         +-----------+---+---+-----------+
         |           |       |           |
    SceneContext  FileState  CodeColor  CameraCtrl
         |        Manager    Manager       |
         |           |       |    |        |
         |           +---+---+    |        |
         |               |       |        |
         |        SelectionManager        |
         |               |                |
         |        NavigationHistory-------+
         |               |
         |        SearchManager
         |               |
         +-------+-------+
                 |
           CommandRouter
                 |
        +--------+--------+
        |        |        |
   ViewerAPI  WebSocket  Shortcuts
              Manager    Manager
```

Arrows show "depends on". Construction order (bottom-up of dependencies):

1. SceneContext (already exists)
2. FileStateManager (already exists)
3. CodeColorManager (already exists, needs watchProperties extension)
4. CameraController (already exists)
5. SelectionManager (new -- depends on FileStateManager)
6. NavigationHistory (new -- depends on CameraController, SelectionManager)
7. SearchManager (new -- depends on FileStateManager, CodeColorManager, NavigationHistory, SceneContext)
8. CommandRouter (new -- receives context bag with refs to all above)
9. Register command modules (select, nav, search, camera, grid, scene, window, system)
10. ViewerAPI (new -- wraps CommandRouter)
11. ShortcutManager (new -- invokes commands through CommandRouter)
12. WebSocketManager (existing on branch -- invokes commands through CommandRouter)

### 4.2 Command context object

Rather than passing the raw viewer to handlers (as the WebSocket branch does), pass a typed context:

```javascript
const commandContext = {
    // Core Three.js
    scene: this.scene,
    camera: this.camera,
    renderer: this.renderer,
    atlas: this.atlas,

    // Data
    getGrids: () => this.grids,
    fileStateManager: this.fileStateManager,

    // Subsystems
    cameraController: this.cameraController,
    selectionManager: this.selectionManager,
    navigationHistory: this.navigationHistory,
    searchManager: this.searchManager,
    codeColorManager: this.codeColorManager,

    // Layout
    getActiveLayout: () => this._activeLayout,
    layoutManagers: {
        hierarchical: this.hierarchicalManager,
        spiral: this.spiralManager,
        treemap: this.treemapManager,
    },

    // Window system
    windowManager: this.windowManager,
};
```

This makes command handlers testable: construct a mock context with only the subsystems the command needs.

### 4.3 Event system

The codebase currently mixes three event patterns:
1. `window.dispatchEvent(new CustomEvent(...))` -- used for `camera-focus-changed`
2. `FileStateManager` callback-based -- `onPropertyChanged(cb)`
3. Direct method calls between subsystems

For IDE features, standardize on **callback-based** (pattern 2) for data flow and **CustomEvent** (pattern 1) for UI coordination only. Rationale: callback-based is testable without a DOM; CustomEvent requires `window` but is the right tool for cross-component UI sync.

New events (callback-based):
- `SelectionManager.onSelectionChanged(cb)` -- `cb(selectionState)`
- `NavigationHistory.onNavigate(cb)` -- `cb(entry)`
- `SearchManager.onSearchResults(cb)` -- `cb(results)`
- `SearchManager.onMatchChanged(cb)` -- `cb(matchIndex, match)`

New events (CustomEvent, for UI sync):
- `selection-changed` -- triggers tree panel highlight update
- `search-activated` / `search-deactivated` -- triggers ShortcutManager context switch
- `layout-changed` -- triggers minimap recalculation

### 4.4 Keyboard shortcut integration

ShortcutManager registers on `document` in the capture phase (before CameraController's bubbling-phase `keydown`). When a shortcut matches, it calls `e.stopPropagation()` + `e.preventDefault()` to prevent CameraController from seeing it.

Shortcuts invoke commands through the CommandRouter:

```javascript
shortcuts.register('ctrl+f', {
    context: 'default',
    action: () => router.execute('search.open'),
    description: 'Search files'
});

shortcuts.register('escape', {
    context: 'search-active',
    action: () => router.execute('search.clear'),
    priority: 10
});

shortcuts.register('n', {
    context: 'search-active',
    action: () => router.execute('search.next'),
});
```

This means every keyboard action is also available as a command, which means agents can do anything the keyboard can.

### 4.5 WebSocket integration path

The existing WebSocket branch code (CommandRouter, WebSocketManager, command modules) can be reused almost verbatim:

1. **CommandRouter**: replace with the evolved version. The handler signature changes from `(args, viewer) => string` to `(args, context) => { text, data }`. Existing handlers need a small migration: wrap their return string in `{ text: returnValue, data: null }`.

2. **WebSocketManager**: mostly unchanged. The `_handleMessage` method calls `router.execute(envelope.cmd)` and sends back `response.text` (the string form). The structured `response.data` can optionally be sent as JSON for controller clients that want it.

3. **Command modules**: migrate to the new context pattern. Instead of `args, viewer`, receive `args, ctx`. Replace `viewer.grids` with `ctx.getGrids()`, `viewer.camera` with `ctx.camera`, `viewer.windowManager` with `ctx.windowManager`, etc. This is a straightforward find-and-replace.

4. **New command modules**: selectCommands, navCommands, searchCommands, colorCommands, fileCommands are new. They follow the identical registration pattern.

5. **TUIWindowManager + TUIWindow**: reuse as-is. They are already cleanly separated.

6. **TUIFormatter**: reuse as-is. The box/table/kvLines utilities are useful for all text command output.

### 4.6 Reuse summary

| WebSocket branch component | Reuse strategy |
|---|---|
| CommandRouter | Replace with evolved version (async, dual-return, context bag) |
| WebSocketManager | Reuse with minimal changes (use `.text` from response) |
| TUIWindowManager | Reuse as-is |
| TUIWindow | Reuse as-is |
| TUIFormatter | Reuse as-is |
| cameraCommands.js | Migrate `viewer` -> `ctx`, wrap returns |
| gridCommands.js | Migrate `viewer` -> `ctx`, wrap returns |
| windowCommands.js | Migrate `viewer` -> `ctx`, wrap returns |
| sceneCommands.js | Migrate `viewer` -> `ctx`, wrap returns |
| systemCommands.js | Migrate `viewer` -> `ctx`, wrap returns |
| ws-relay.py | Reuse as-is |

---

## Part 5: Critical Modifications to Existing Code

### 5.1 CodeColorManager.js -- watchProperties extension

Current line 127:
```javascript
if (propName !== 'heatMetric') return;
```

Replace with:
```javascript
const anyLayerWatches = this._layers.some(
    l => l.enabled && (l.watchProperties || []).includes(propName)
);
if (!anyLayerWatches) return;
```

And extend `registerLayer`:
```javascript
registerLayer(name, { priority, colorFn, watchProperties = [] }) {
    this._layers = this._layers.filter(l => l.name !== name);
    this._layers.push({ name, priority, colorFn, enabled: true, watchProperties });
    this._layers.sort((a, b) => b.priority - a.priority);
}
```

Layer registrations:
- Heatmap: `watchProperties: ['heatMetric']`
- Selection: `watchProperties: ['selected']`
- Search: `watchProperties: ['searchMatchCount']`

This is a ~10-line change that unlocks all future color-reactive features.

### 5.2 CameraController.js -- click disambiguation

The drag-vs-click problem: mousedown starts a drag, but a click (mousedown+mouseup with <5px displacement) should trigger selection.

Add to mouseup handler:
```javascript
const dx = event.clientX - this._dragStartX;
const dy = event.clientY - this._dragStartY;
const displacement = Math.sqrt(dx * dx + dy * dy);
if (displacement < 5) {
    window.dispatchEvent(new CustomEvent('canvas-click', {
        detail: { clientX: event.clientX, clientY: event.clientY }
    }));
}
```

Store `_dragStartX/Y` in the mousedown handler. This is ~8 lines of change.

### 5.3 GitHubRepoViewer.js -- subsystem wiring

In `init()`, after existing subsystem creation, add:
```javascript
this.selectionManager = new SelectionManager(this.fileStateManager);
this.navigationHistory = new NavigationHistory(this.cameraController, this.selectionManager);
this.searchManager = new SearchManager(this.fileStateManager, this.codeColorManager, this.navigationHistory, this.sceneContext);

this.router = new CommandRouter(commandContext);
registerAllCommands(this.router);

this.api = new ViewerAPI(this.router);
window.viewer = this.api;

this.shortcutManager = new ShortcutManager();
registerShortcuts(this.shortcutManager, this.router);
```

---

## Part 6: File Organization

### New files (all in `examples/github-viewer/`)

```
examples/github-viewer/
  commands/
    CommandRouter.js           Evolved from websocket branch
    index.js                   Register all commands
    cameraCommands.js          Migrated from websocket branch
    gridCommands.js            Migrated from websocket branch
    windowCommands.js          Migrated from websocket branch
    sceneCommands.js           Migrated from websocket branch
    systemCommands.js          Migrated from websocket branch
    selectCommands.js          NEW
    navCommands.js             NEW
    searchCommands.js          NEW
    colorCommands.js           NEW
    fileCommands.js            NEW

  SelectionManager.js          NEW -- selection state, raycast, multi-select
  NavigationHistory.js         NEW -- back/forward history wrapping CameraController
  SearchManager.js             NEW -- query execution, match tracking, result navigation
  ShortcutManager.js           NEW -- keyboard shortcut registry
  ViewerAPI.js                 NEW -- public API facade

  websocket/
    WebSocketManager.js        Moved from websocket branch, adapted
    TUIWindowManager.js        Moved from websocket branch, as-is
    TUIWindow.js               Moved from websocket branch, as-is
    TUIFormatter.js            Moved from websocket branch, as-is

  components/
    MinimapOverlay.js          NEW -- 2D canvas minimap
    CommandPalette.js          NEW -- Cmd+P file search
    SearchOverlay.js           NEW -- Cmd+F search UI
```

### Why commands/ moves out of websocket/

The WebSocket branch puts commands inside `websocket/commands/`. But commands are transport-agnostic -- they should work from keyboard, command palette, programmatic API, AND WebSocket. Moving them to a top-level `commands/` directory makes this clear. The `websocket/` directory retains only transport-specific code (WebSocketManager, relay protocol).

---

## Part 7: Implementation Sequence

### Phase 0: Foundation (enables everything else)
1. CodeColorManager `watchProperties` extension (10 lines)
2. CameraController click disambiguation (8 lines)
3. Evolve CommandRouter from WebSocket branch (new file, ~150 lines)
4. Migrate existing command modules to new context pattern (~30 min)

### Phase 1: Selection
5. SelectionManager (new, ~120 lines)
6. selectCommands (new, ~60 lines)
7. Selection color layer registration in CodeColorManager
8. Canvas-click -> raycast -> select wiring in GitHubRepoViewer
9. Tree panel bidirectional sync

### Phase 2: Navigation
10. NavigationHistory (new, ~100 lines)
11. navCommands (new, ~50 lines)
12. Back/forward keyboard shortcuts

### Phase 3: Search
13. SearchManager (new, ~200 lines)
14. searchCommands (new, ~80 lines)
15. SearchOverlay component (new, ~150 lines)
16. Search color layer registration

### Phase 4: Keyboard + API
17. ShortcutManager (new, ~120 lines)
18. ViewerAPI facade (new, ~80 lines)
19. Register all shortcuts
20. Expose `window.viewer`

### Phase 5: Extras
21. CommandPalette (new, ~200 lines)
22. MinimapOverlay (new, ~150 lines)
23. TreemapLabelManager (new, ~180 lines)
24. WebSocket integration (migrate from branch)

Each phase is independently testable in the browser by loading `http://localhost:8000/examples/github-viewer/` and using devtools.

---

## Part 8: Risk Assessment

### Low risk
- CodeColorManager watchProperties extension: tiny change, backward compatible
- CommandRouter evolution: new file, does not touch existing code
- SelectionManager: new file, integrates via existing FileStateManager
- ViewerAPI facade: thin wrapper, no logic of its own

### Medium risk
- CameraController click disambiguation: modifies hot input path, could break drag behavior if threshold is wrong. Mitigate: make threshold configurable.
- ShortcutManager capture-phase registration: could eat events meant for other things. Mitigate: always check `_paused` flag when input is focused; never register single-letter shortcuts in `default` context.
- SearchManager iterating all grid content: could be slow for repos with 500+ large files. Mitigate: debounce input, show results incrementally, consider worker offloading.

### High risk
- GitHubRepoViewer.js is 38KB and growing. Every new subsystem adds constructor calls, event wiring, and animation loop updates. This file is the bottleneck. Mitigate: keep subsystem APIs minimal; consider extracting a `ViewerBootstrap.js` that handles construction/wiring.
- The group DataTexture is limited to 16,000 groups. Each CodeGrid uses group 0 within its own renderer, so this is not a practical limit today. But if the shared-renderer architecture is implemented (many grids in one renderer), each grid needs its own groupId. 16,000 is plenty for files but watch for combinatorial explosion with per-line groups.

---

## Part 9: Key Architectural Observations

**The CommandRouter is the unifying abstraction.** Every user action (keyboard shortcut, canvas click, tree panel click, WebSocket command, programmatic API call) should ultimately flow through the CommandRouter. This gives us: a single place to log all actions, a single place to add undo/redo, a single place to add command batching, and a single surface for agents to control the viewer.

**FileStateManager is the single source of truth for per-file state.** Selection, search results, heatmap metrics, and any future file-level metadata all live here. CodeColorManager reads it reactively. This means adding a new visual feature is: (1) write a property to FileStateManager, (2) register a color layer in CodeColorManager that reads it. No new rendering code needed.

**The group DataTexture is the GPU-side workhorse.** All five IDE features (selection highlight, search highlight, hover, file-level color, visibility) use `setGroupColor` or `setGroupVisibility`. These are O(1) DataTexture texel writes. No instance buffers are touched, no geometry is rebuilt, no shader changes are needed. The system is designed for exactly these kinds of interactive state changes.

**The TUI pattern (CodeGrid as text pane) is powerful.** TUIWindow proves that CodeGrid can be used not just for source files but for any text UI element in 3D space: search results, debug panels, status displays, info tooltips. The rendering cost is the same as any other CodeGrid -- one draw call per window. For a handful of UI panels, this is negligible.

---

## Critical Files for Implementation

- `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/CodeColorManager.js` -- needs watchProperties
- `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/CameraController.js` -- needs click disambiguation
- `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/FileStateManager.js` -- used as-is, central to all features
- `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/GitHubRepoViewer.js` -- wiring point for all new subsystems
- `/Users/lugo/localdev/viz-web/glyph3d-js/examples/github-viewer/SceneContext.js` -- may need expansion
- `/Users/lugo/localdev/viz-web/glyph3d-js/src/collections/GlyphCollection.js` -- group API surface (used, not modified)
- `/Users/lugo/localdev/viz-web/glyph3d-js/src/GlyphRenderer.js` -- group DataTexture API (used, not modified)
- Branch `origin/claude/websocket-api-state-control-ARAcm` -- source for CommandRouter, TUI*, command modules
