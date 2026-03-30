# Phase 0: App Boundary Classification

Agent: `app-boundary`
Scope: Every file in `examples/github-viewer/` and `examples/ide/` classified into APP, PROMOTE, EXAMPLE, or ALREADY-EXTRACTED.

## Decision Framework

The line between library (`src/`) and application (`app/`) is drawn by this question: **does the code make assumptions about what the user is doing, or does it provide a capability anyone could use?**

- `src/` = rendering engine, composable services, reusable infrastructure
- `app/` = the specific GitHub 3D viewer product that wires those services together
- `examples/` = minimal demos showing how to use `src/`

The 21 services already in `src/services/` (CommandRouter, WebSocketBridge, ViewerAPI, SelectionManager, etc.) are library-level infrastructure. The command *handlers* that register specific commands (grid.list, camera.move, window.create) are the application's command vocabulary -- they belong with the app, not the library.

---

## Classification: examples/github-viewer/

| File | Classification | Destination | Rationale |
|------|---------------|-------------|-----------|
| `GitHubRepoViewer.js` | **APP** | `app/GitHubRepoViewer.js` | Top-level application orchestrator. Wires together all services, manages scene lifecycle, creates UI. This IS the application. |
| `index.html` | **APP** | `app/index.html` | Entry point HTML for the standalone viewer (non-IDE mode). App-specific markup and importmap. |
| `styles.css` | **APP** | `app/styles.css` | Application-specific CSS for the viewer UI (header, drawer, loading overlay, toast). |
| `StatePersistence.js` | **APP** | `app/StatePersistence.js` | Hardcoded localStorage keys, viewer-specific state shape (repoUrl, branch, activeLayout, camera position). Pure app state. |
| `ws-relay.mjs` | **APP** | `app/ws-relay.mjs` | Node.js WebSocket relay server. App infrastructure for the command protocol. Not a library concern. |
| `ws-relay.py` | **APP** | `app/ws-relay.py` | Python WebSocket relay server. Same rationale as above, alternate runtime. |

### components/

| File | Classification | Destination | Rationale |
|------|---------------|-------------|-----------|
| `components/AppShell.js` | **APP** | `app/components/AppShell.js` | Creates "GitHub 3D" header with buy-me-a-coffee link, loading overlay, FPS badge, toast. Hardcoded app branding. |
| `components/Drawer.js` | **APP** | `app/components/Drawer.js` | Slide-out drawer with repo panel, files panel, settings panel, stats panel, controls panel. All panels are viewer-specific HTML templates. |
| `components/DiffPanel.js` | **APP** | `app/components/DiffPanel.js` | PR diff loading UI. Application-specific feature panel. |
| `components/LogCapturePanel.js` | **APP** | `app/components/LogCapturePanel.js` | Debug log capture drawer panel. App-level debug tooling UI. |
| `components/MinimapOverlay.js` | **PROMOTE** | `src/components/MinimapOverlay.js` | Generic 2D canvas minimap for any CodeGrid layout. Takes `{THREE, camera, getGrids}` via DI. No app-specific assumptions. Reusable by any Three.js/CodeGrid consumer. |
| `components/TouchController.js` | **PROMOTE** | `src/services/interaction/TouchController.js` | Generic touch-to-camera translation. Takes `{canvas, cameraController, THREE}` via DI. No app-specific assumptions. Same pattern as the already-promoted services. |

### websocket/ (command center bootstrap + TUI system)

| File | Classification | Destination | Rationale |
|------|---------------|-------------|-----------|
| `websocket/index.js` | **APP** | `app/commands/index.js` | `initCommandCenter()` builds the app-specific context bag from GitHubRepoViewer fields (viewer.registry, viewer.scene, viewer.hierarchicalManager, etc.). This is the app's wiring layer. |
| `websocket/TUIWindow.js` | **PROMOTE** | `src/tui/TUIWindow.js` | Generic terminal window backed by CodeGrid. Takes `{scene, atlas}` via constructor. No app-specific logic. Reusable component for any 3D TUI surface. |
| `websocket/TUIWindowManager.js` | **PROMOTE** | `src/tui/TUIWindowManager.js` | Lifecycle manager for TUIWindow instances. Generic create/track/position logic. No app-specific assumptions. |
| `websocket/TUIFormatter.js` | **PROMOTE** | `src/tui/TUIFormatter.js` | Pure text formatting utilities (box-drawing, tables, padding). Zero dependencies. Universally reusable. |
| `websocket/TUIFocusManager.js` | **PROMOTE** | `src/tui/TUIFocusManager.js` | Click-to-focus and keystroke routing for TUI windows. Takes dependencies via constructor DI `{THREE, windowManager, canvas, camera, ...}`. Generic interaction pattern. |
| `websocket/BLUETOOTH_NOTES.md` | **DROP** | (delete) | Research notes, not code. Does not belong in any directory. |

### websocket/commands/ (command handlers)

These are the most nuanced decisions. The command handlers form the app's **vocabulary** -- they define what the viewer can do when controlled via WebSocket or CLI. While they operate on generic primitives (CodeGrid, TUIWindow, camera), they collectively define the application's command surface. They are tightly coupled to the context bag built in `websocket/index.js`.

**Decision**: All command handlers move to `app/commands/`. They are the app's behavior layer, not library infrastructure. The infrastructure they depend on (CommandRouter, WebSocketBridge, ViewerAPI) is already in `src/services/orchestration/`.

| File | Classification | Destination | Rationale |
|------|---------------|-------------|-----------|
| `commands/index.js` | **APP** | `app/commands/handlers/index.js` | Registry of all command handlers. App-specific aggregation. |
| `commands/systemCommands.js` | **APP** | `app/commands/handlers/systemCommands.js` | help/status -- reads app-specific context shape. |
| `commands/cameraCommands.js` | **APP** | `app/commands/handlers/cameraCommands.js` | camera.move/lookat/focus/reset -- uses app context's camera + grids. |
| `commands/gridCommands.js` | **APP** | `app/commands/handlers/gridCommands.js` | grid.list/info/color/create/update/remove -- uses app context's registry. |
| `commands/sceneCommands.js` | **APP** | `app/commands/handlers/sceneCommands.js` | scene.* -- app-level scene manipulation. |
| `commands/selectCommands.js` | **APP** | `app/commands/handlers/selectCommands.js` | select.* -- uses app's SelectionManager + grids. |
| `commands/layoutCommands.js` | **APP** | `app/commands/handlers/layoutCommands.js` | layout.* -- uses app's layout managers. |
| `commands/searchCommands.js` | **APP** | `app/commands/handlers/searchCommands.js` | search.* -- searches app's loaded grids. |
| `commands/agentLayoutCommands.js` | **APP** | `app/commands/handlers/agentLayoutCommands.js` | Agent layout orchestration -- app-specific multi-agent coordination. |
| `commands/annotationCommands.js` | **APP** | `app/commands/handlers/annotationCommands.js` | annotation.* -- uses app context's annotations map + scene. |
| `commands/compositionCommands.js` | **APP** | `app/commands/handlers/compositionCommands.js` | composition.* -- app-level grid composition. |
| `commands/navigationCommands.js` | **APP** | `app/commands/handlers/navigationCommands.js` | camera.frame/tour.* -- app-level camera navigation with tour system. |
| `commands/orchestrationCommands.js` | **APP** | `app/commands/handlers/orchestrationCommands.js` | window.track/untrack -- bridges TUI windows to code grids in app context. |
| `commands/registryCommands.js` | **APP** | `app/commands/handlers/registryCommands.js` | registry.* -- exposes app's SceneRegistry via commands. |
| `commands/windowCommands.js` | **APP** | `app/commands/handlers/windowCommands.js` | window.create/write/close -- TUI window lifecycle via app context. |
| `commands/terminalCommands.js` | **APP** | `app/commands/handlers/terminalCommands.js` | terminal.create/frame/close -- TerminalGrid lifecycle via app context. |
| `commands/spatialCommands.js` | **APP** | `app/commands/handlers/spatialCommands.js` | spatial.* -- 3D positioning via app context. |
| `commands/colorConstants.js` | **APP** | `app/commands/colorConstants.js` | Semantic color palette for annotations/highlights. App-level design tokens. |
| `commands/encoding.js` | **PROMOTE** | `src/utils/encoding.js` | UTF-8-safe base64 encode/decode. Zero dependencies, pure utility. Used across commands AND CLI clients. Library-worthy. |
| `commands/spatialHelpers.js` | **PROMOTE** | `src/utils/spatialHelpers.js` | Pure spatial math (grid resolution, AABB computation, camera framing). Takes Three.js objects, returns geometry. No app-specific assumptions. |
| `commands/gridVisualState.js` | **APP** | `app/commands/gridVisualState.js` | Save/restore visual state tied to app's gridVisualState Map on context. App-level state management. |

### cli/ (Node.js CLI clients)

| File | Classification | Destination | Rationale |
|------|---------------|-------------|-----------|
| `cli/CliConnection.mjs` | **APP** | `app/cli/CliConnection.mjs` | Node.js WebSocket client. Imports `ws` (Node-only). Implements the app's relay protocol. |
| `cli/glyph-cli.mjs` | **APP** | `app/cli/glyph-cli.mjs` | CLI REPL/one-shot controller. App-level developer tool. |
| `cli/glyph-cli.py` | **APP** | `app/cli/glyph-cli.py` | Python CLI controller. Same as above. |
| `cli/cli_connection.py` | **APP** | `app/cli/cli_connection.py` | Python WebSocket client. Same as CliConnection.mjs. |
| `cli/AgentWindowManager.mjs` | **APP** | `app/cli/AgentWindowManager.mjs` | Multi-agent window orchestration. App-specific (phase colors, layout semantics). |
| `cli/AgentWindow.mjs` | **APP** | `app/cli/AgentWindow.mjs` | Single agent panel wrapper. Tied to app's command protocol. |
| `cli/CodeTour.mjs` | **APP** | `app/cli/CodeTour.mjs` | Fluent camera tour builder. Uses app's command protocol (tour.create/tour.add-stop). |
| `cli/agent-hook.mjs` | **APP** | `app/cli/agent-hook.mjs` | CLI hook for pushing agent output. App-level integration tool. |
| `cli/__pycache__/` | **DROP** | (delete) | Python bytecode cache. Should be gitignored. |

---

## Classification: examples/ide/

| File | Classification | Destination | Rationale |
|------|---------------|-------------|-----------|
| `ide.html` | **APP** | `app/ide.html` | IDE shell HTML layout (activity bar, sidebar, tab bar, bottom panel, status bar). This is the primary production UI -- app-level chrome. |
| `ide.css` | **APP** | `app/ide.css` | IDE shell CSS. 100% app-specific styling. |
| `index.html` | **APP** | `app/ide-redirect.html` (or drop) | Simple redirect to ide.html. Convenience artifact. |
| `IDEShell.js` | **APP** | `app/IDEShell.js` | VS Code-like shell orchestrator. Manages activity bar, sidebar, tab bar, bottom panel, status bar. Wraps GitHubRepoViewer. Deeply app-specific -- references Drawer panel HTML, viewer internals, file-selected events. |
| `components/CommandBar.js` | **APP** | `app/components/CommandBar.js` | Unified input bar for IDE shell. Uses CommandRouter for `:CMD` mode and terminal input routing. App-level UI component. |

---

## Summary Counts

| Classification | Count | Notes |
|---------------|-------|-------|
| **APP** | 38 | Move to `app/` |
| **PROMOTE** | 6 | Move to `src/` (MinimapOverlay, TouchController, TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager, encoding.js, spatialHelpers.js) |
| **DROP** | 2 | BLUETOOTH_NOTES.md, __pycache__/ |
| **EXAMPLE** | 0 | Nothing stays in examples/ as a "demo" |
| **ALREADY-EXTRACTED** | 0 | No duplicates found between examples/ and src/services/ |

**Correction on count**: PROMOTE is 8 files (MinimapOverlay, TouchController, TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager, encoding.js, spatialHelpers.js).

---

## Key Architectural Decisions

### 1. Command handlers are APP, not library

The 15+ command handler files define the application's command vocabulary. They are registered on a CommandRouter (which IS library), but the handlers themselves encode app-specific behaviors. A different application using glyph3d-js would register different commands.

### 2. TUI system is PROMOTE-worthy

TUIWindow, TUIWindowManager, TUIFormatter, and TUIFocusManager are genuinely reusable. They have clean constructor DI, no app-specific logic, and represent a coherent subsystem (3D terminal emulation). They should live in `src/tui/`.

### 3. MinimapOverlay and TouchController are PROMOTE-worthy

Both follow the same DI pattern as already-promoted services. MinimapOverlay takes `{THREE, camera, getGrids}` and TouchController takes `{canvas, cameraController, THREE}`. Neither knows about GitHub, repos, or the viewer's UI.

### 4. encoding.js and spatialHelpers.js are pure utilities

`encoding.js` is a zero-dependency UTF-8 base64 wrapper. `spatialHelpers.js` is pure spatial math over Three.js primitives. Both are imported by multiple consumers and belong in `src/utils/`.

### 5. Nothing remains as an "example"

The current `examples/github-viewer/` is not an example -- it is the entire application. After extraction, a genuine example could be created (e.g., a 50-line hello-world showing how to render text with CodeGrid), but that would be new code, not a subset of what exists.

### 6. The IDE shell IS the app's primary UI

`examples/ide/` wraps `examples/github-viewer/` and provides the VS Code-like chrome. It imports directly from `../github-viewer/components/`. After extraction, both IDEShell and GitHubRepoViewer live in `app/` and import from `src/`.

---

## Post-Extraction Import Graph

```
app/
  GitHubRepoViewer.js  -->  src/ (GlyphAtlas, CodeGrid, layouts, services)
  IDEShell.js          -->  app/components/ (Drawer, DiffPanel, LogCapturePanel)
                       -->  src/services/utils/platform.js
  commands/index.js    -->  src/services/orchestration/ (CommandRouter, WebSocketBridge, ViewerAPI)
  commands/handlers/*  -->  src/tui/ (TUIWindow, TUIWindowManager)
                       -->  src/utils/ (encoding, spatialHelpers)
                       -->  src/collections/ (CodeGrid, TerminalGrid)
  cli/*                -->  (Node.js only, ws package, app's relay protocol)

src/
  tui/                 <--  NEW: TUIWindow, TUIWindowManager, TUIFormatter, TUIFocusManager
  components/          <--  NEW: MinimapOverlay
  services/interaction/<--  TouchController added here
  utils/               <--  encoding.js, spatialHelpers.js added here

examples/
  word-wall/           (unchanged, genuine demo)
  (github-viewer/ and ide/ removed -- they moved to app/)
```
