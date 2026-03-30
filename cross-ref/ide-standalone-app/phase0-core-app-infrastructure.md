# IDE Standalone App — Phase 0: Core App Infrastructure

## Architecture Overview

The glyph3d IDE is evolving from a monolithic VSCode-like wrapper (IDEShell.js wrapping GitHubRepoViewer.js) into a **lean, modular workbench** inspired by VSCode's architecture but adapted for our lightweight, ES6-class approach.

### Conceptual Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKBENCH SHELL                          │
│  (Container, layout, lifecycle, command dispatch)           │
├─────────┬──────────────┬──────────────┬────────────┬────────┤
│ Activity│   Sidebar    │  Editor Area │   Bottom   │ Status │
│  Bar    │  (Views)     │   (3D View)  │   Panel    │  Bar   │
├─────────┴──────────────┴──────────────┴────────────┴────────┤
│                 EDITOR (3D Canvas)                          │
│     (Scene, Camera, Renderer, Registry)                     │
├──────────────────────────────────────────────────────────────┤
│                  SERVICES LAYER                             │
│  Camera | Selection | State | Registry | Color | Layout ... │
├──────────────────────────────────────────────────────────────┤
│                 COMMAND & EVENT SYSTEM                       │
│    CommandRouter | ViewerAPI | WebSocket Bridge             │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. Pattern Definitions

### Workbench Pattern
The **Workbench** is the top-level application container:
- Owns the layout (splits, resize handles, CSS layout)
- Manages panel visibility and serialization
- Dispatches commands and broadcasts events
- No business logic; purely layout & orchestration

**Key Property**: Workbench is **UI-agnostic** — panels are pluggable via a simple interface.

### View/ViewController Pattern
Each sidebar panel (Explorer, Search, Settings, Diff) is a **view**:
- **ViewController**: Controls a panel, handles UI interactions, owns data fetching
- **View (DOM)**: Created on demand; destroyed when panel is closed
- **Communication**: Views listen to events (e.g., file-selected), invoke commands via the CommandRouter
- **State**: Minimal; most state lives in services (SelectionManager, FileStateManager, etc.)

### Editor Pattern
The **3D canvas area** is treated as a special "editor":
- **EditorController**: Wraps GitHubRepoViewer, manages scene lifecycle
- **Lifecycle**: init → start → dispose
- **Event Hub**: Emits `file-selected`, `camera-focus-changed`, etc.
- **Resize Handling**: ResizeObserver notifies canvas size changes

### Service Layer (Already Extracted)
Located in `/src/services/`, these are reusable subsystems:
- **SceneContext**: Three.js scene, camera, renderer wrappers
- **SceneRegistry**: Single source of truth for grids (replaces `viewer.grids` array)
- **SelectionManager**: Multi-select file state
- **CameraController**: Keyboard/mouse camera movement and focus
- **FileStateManager**: Per-file state (expanded/collapsed, custom colors)
- **CodeColorManager**: Syntax-aware coloring
- **LayoutManager** (hierarchical, spiral, treemap, grid): Scene composition

### CommandRouter Pattern
Shell-style command dispatch for:
- **Keyboard shortcuts** → command names (e.g., "cmd+p" → "palette.open")
- **WebSocket CLI** → structured commands
- **UI buttons** → programmatic invocation
- **Middleware**: Logging, undo/redo, validation (pluggable)

**Key Property**: Commands are **namespace-separated** (e.g., `camera.move`, `grid.list`) and **async-capable**.

### Extension/Plugin Pattern (Future)
Sidebar panels could become **pluggable extensions**:
```javascript
workbench.registerPanel({
  id: 'explorer',
  label: 'Explorer',
  createViewController: (workbench) => new ExplorerViewController(workbench),
  icon: '📁'
});
```

---

## 2. Component Architecture

### WorkbenchController (NEW)
**Responsibility**: Application shell lifecycle and layout.

```javascript
class WorkbenchController {
  constructor(container) {
    this.container = container;
    this.layout = new LayoutManager(container);
    this.commandRouter = null;  // Injected by app
    this.panels = new Map();    // id → ViewController
    this.editor = null;         // EditorController
  }

  registerPanel(panelDef) {
    // panelDef = { id, label, createViewController }
    const vc = panelDef.createViewController(this);
    this.panels.set(panelDef.id, vc);
  }

  focusPanel(panelId) {
    // Show sidebar, switch active panel
  }

  executeCommand(name, args) {
    return this.commandRouter.execute(name, args);
  }

  broadcast(eventName, detail) {
    // Emit custom event to all panels
  }
}
```

### EditorController (NEW)
**Responsibility**: Wraps GitHubRepoViewer as a special editor.

```javascript
class EditorController {
  constructor(canvas, THREE) {
    this.viewer = new GitHubRepoViewer(canvas, THREE);
    this.eventBus = new EventTarget(); // Standard DOM event dispatch
  }

  async init() {
    await this.viewer.init();
    this.viewer.addEventListener('file-selected', (e) => {
      this.eventBus.dispatchEvent(new CustomEvent('file-selected', { detail: e.detail }));
    });
  }

  notifyResize(rect) {
    // Forward ResizeObserver rect to viewer.renderer
  }

  getRegistry() {
    return this.viewer.registry;
  }
}
```

### SidebarViewController (Base Class Pattern)
Each sidebar panel (Explorer, Search, Diff) extends this:

```javascript
class SidebarViewController extends EventTarget {
  constructor(panelElement) {
    super();
    this.element = panelElement;
    this.model = {};  // Panel-specific state
  }

  // Template methods — override in subclasses
  async onShow() {}    // Panel became visible
  async onHide() {}    // Panel hidden
  onDestroy() {}       // Cleanup

  // Notify parent (Workbench) of intent to execute command
  executeCommand(name, args) {
    this.dispatchEvent(new CustomEvent('command', { detail: { name, args } }));
  }
}
```

### PanelViewController (Bottom Panel)
Similar to SidebarViewController but for bottom panels (Output, Console, Diff Results).

### StatusBarController
Updates status indicators (FPS, camera pos, file path, branch).
Listens to editor events and service state changes.

---

## 3. Event & Command Flow

### Events (pub/sub via CustomEvent)
Panels broadcast selection changes, editor emits scene updates:

```javascript
// Editor emits
editor.eventBus.dispatchEvent(new CustomEvent('file-selected', {
  detail: { selected: ['src/main.js'], primary: 'src/main.js' }
}));

// Sidebar panel listens
panel.element.addEventListener('file-selected', (e) => {
  panel.updateActiveFile(e.detail.primary);
});
```

### Commands (explicit call/response via CommandRouter)
Panels invoke commands when user clicks buttons:

```javascript
// User clicks "Focus Camera" button in Explorer
panel.executeCommand('camera.focusOnGrid', [gridIndex]);

// CommandRouter dispatches to handler (from websocket/commands/*.js)
// Handler returns { text, data }
const result = await router.execute('camera.focusOnGrid', [gridIndex]);
```

### Middleware Chain
```javascript
router.use((name, args, ctx) => {
  console.log(`[cmd] ${name}`, args);
});

router.use((name, args, ctx) => {
  // Track undo/redo
  undoStack.push({ name, args, beforeState: ctx.getGrids() });
});
```

---

## 4. Service Injection (Explicit, No DI Container)

Services are wired explicitly in the app bootstrap:

```javascript
// Phase 0 Bootstrap (main.js or init.js)

// 1. Create core Three.js scene & editor
const canvas = document.getElementById('canvas');
const editor = new EditorController(canvas, THREE);
await editor.init();

// 2. Create workbench
const workbench = new WorkbenchController(document.getElementById('ide-shell'));

// 3. Extract registry & services from viewer
const registry = editor.getRegistry();
const cameraCtrl = editor.viewer.cameraController;
const selectionMgr = editor.viewer.selectionManager;

// 4. Build command context (from websocket/index.js pattern)
const cmdContext = {
  scene: editor.viewer.scene,
  camera: editor.viewer.camera,
  registry,
  cameraController: cameraCtrl,
  selectionManager: selectionMgr,
  // ... other services
};

// 5. Create command router & register handlers
const router = new CommandRouter(cmdContext);
registerAllCommands(router);
workbench.commandRouter = router;

// 6. Register sidebar panels
workbench.registerPanel({
  id: 'explorer',
  label: 'Explorer',
  createViewController: (wb) => new ExplorerViewController(wb, editor, selectionMgr)
});

// 7. Publish globally for REPL/WebSocket CLI
window.viewer = new ViewerAPI(router, cmdContext);
```

**Why no DI?**
- Our app is monolithic (single page, single window)
- Services have few dependencies (mostly explicit params)
- Explicit wiring makes control flow obvious to read

---

## 5. File Organization (Phase 0)

```
src/
  services/                      # Already extracted, reusable subsystems
    (camera, state, visual, interaction, orchestration, etc.)

examples/ide/
  components/
    WorkbenchController.js       # Layout + command dispatch
    EditorController.js          # Wraps GitHubRepoViewer
    SidebarViewController.js      # Base class for sidebar panels
    PanelViewController.js        # Base class for bottom panels
    StatusBarController.js        # Status bar updates
    
  views/
    ExplorerViewController.js     # Files & repo browser
    SearchViewController.js       # File search
    SettingsViewController.js     # Settings panel
    DiffViewController.js         # Source control / diff
    
  IDEShell.js                    # (EXISTING) Transition layer
  IDEApp.js                      # (NEW) Orchestrator, replaces IDEShell.js
  main.js                        # (NEW) Bootstrap

examples/github-viewer/
  GitHubRepoViewer.js            # (EXISTING) 3D viewer core
  websocket/
    CommandRouter.js             # (EXISTING) Command dispatch
    ViewerAPI.js                 # (EXISTING) Public API facade
    commands/                    # (EXISTING) All command modules
```

---

## 6. Lifecycle Flow (Phase 0)

1. **Page Load**
   ```javascript
   // main.js
   const editor = new EditorController(canvas, THREE);
   const workbench = new WorkbenchController(shell);
   await editor.init();       // Three.js + GitHubRepoViewer.init()
   workbench.setupPanels();   // Register explorer, settings, etc.
   editor.start();            // Begin render loop
   workbench.start();         // Status bar updates, event loop
   ```

2. **User Interaction**
   - User clicks Explorer file → ExplorerViewController.onFileClick()
   - ViewController calls `this.executeCommand('camera.focusOnGrid', [idx])`
   - CommandRouter dispatches to handler in `websocket/commands/cameraCommands.js`
   - Command mutates scene via services (SelectionManager, CameraController)
   - Services emit events; Editor broadcasts `file-selected`
   - Sidebar panels listen & update their UI

3. **Serialization (State Persistence)**
   - Workbench.getState() → panel visibility, sidebar width, active files
   - JSON.stringify → localStorage
   - On reload: Workbench.restoreState() → re-open panels, scroll positions

---

## 7. Key Principles for Phase 0

1. **No Frameworks**: ES6 classes, standard DOM APIs only
2. **Explicit Wiring**: Constructor injection; no DI containers
3. **Single Responsibility**: Each ViewController owns one panel
4. **Clear Ownership**:
   - Workbench owns layout
   - Editor owns 3D scene
   - ViewControllers own their UI
   - Services own their domain (selection, camera, state)
5. **Event Boundaries**: Custom events for UI-to-UI; commands for UI-to-scene
6. **Testability**: Mock services via constructor params, not globals

---

## 8. Transition Strategy (IDEShell → IDEApp)

**Phase 0.1**: Keep IDEShell.js; wrap it in WorkbenchController
```javascript
// IDEApp.js wraps the existing IDEShell
const workbench = new WorkbenchController(shell);
const ideShell = new IDEShell();  // Still manages panels
workbench.shell = ideShell;       // Use as ref
```

**Phase 0.2**: Migrate each sidebar panel to SidebarViewController
- Start with Explorer (smallest, least complex)
- Move event wiring out of IDEShell into ExplorerViewController
- Remove IDEShell.js methods one-by-one

**Phase 1**: Retire IDEShell.js entirely; WorkbenchController is the sole layout manager

---

## Next Steps

1. Create `/examples/ide/components/{WorkbenchController,EditorController,SidebarViewController}.js`
2. Refactor IDEShell as a thin compatibility layer
3. Implement ExplorerViewController as the first standalone sidebar panel
4. Wire ExplorerViewController to use commands instead of direct API calls
5. Document the "panel plugin" interface so future panels follow the pattern
