# Phase 0: Composition Extraction — IDE Standalone App

## Executive Summary

The GitHub viewer and IDE shell are currently entangled. To make the IDE a **standalone app with a proper composition root**, we must:

1. Move UI components (Drawer, AppShell, LogCapture, etc.) that are app-level, not example-only
2. Move the websocket command modules (21 files) into the app — they implement the viewer's operational interface
3. Create a **compose-app.js** that wires services (from src/), UI (local), and commands into a functional whole
4. Fix all import paths for the moved files

## File Movement Table

| File | Current Location | Destination | Reason | Import Changes |
|------|-----------------|-------------|--------|-----------------|
| **Core App Components** |
| GitHubRepoViewer.js | examples/github-viewer/ | app/lib/GitHubRepoViewer.js | Instance of the app; not reusable | Update imports: `../../src/` → `../../src/`, `./components/` → `./components/` |
| StatePersistence.js | examples/github-viewer/ | app/lib/StatePersistence.js | App-level state; localStorage is app-scoped | Update imports: relative unchanged |
| **UI Components (App-Level)** |
| Drawer.js | examples/github-viewer/components/ | app/components/Drawer.js | Provides DrawerController; used by Viewer | No changes needed |
| AppShell.js | examples/github-viewer/components/ | app/components/AppShell.js | Creates header, loading, FPS badge, toast | No changes needed |
| LogCapturePanel.js | examples/github-viewer/components/ | app/components/LogCapturePanel.js | Log capture wired into IDE | No changes needed |
| DiffPanel.js | examples/github-viewer/components/ | app/components/DiffPanel.js | Diff UI; part of app layout | No changes needed |
| MinimapOverlay.js | examples/github-viewer/components/ | app/components/MinimapOverlay.js | Overlay on 3D canvas; app-specific | No changes needed |
| TouchController.js | examples/github-viewer/components/ | app/components/TouchController.js | Mobile touch; app feature | No changes needed |
| **IDE Shell (Already App)** |
| IDEShell.js | examples/ide/ | app/lib/IDEShell.js | IDE orchestrator; is the app UI | Update imports: `../github-viewer/` → `./` |
| ide.html | examples/ide/ | app/index.html | App entry point | Update script imports |
| **WebSocket Command Modules (21 Files → Core to App)** |
| commands/index.js | examples/github-viewer/websocket/ | app/commands/index.js | Command registry |  Update imports: `../` → `../` |
| commands/systemCommands.js | examples/github-viewer/websocket/ | app/commands/systemCommands.js | help, status | Update imports: relative |
| commands/cameraCommands.js | examples/github-viewer/websocket/ | app/commands/cameraCommands.js | Camera control | Update imports: relative |
| commands/gridCommands.js | examples/github-viewer/websocket/ | app/commands/gridCommands.js | Grid CRUD | Update imports: relative |
| commands/sceneCommands.js | examples/github-viewer/websocket/ | app/commands/sceneCommands.js | Scene queries | Update imports: relative |
| commands/selectCommands.js | examples/github-viewer/websocket/ | app/commands/selectCommands.js | Selection | Update imports: relative |
| commands/layoutCommands.js | examples/github-viewer/websocket/ | app/commands/layoutCommands.js | Layout ops | Update imports: relative |
| commands/searchCommands.js | examples/github-viewer/websocket/ | app/commands/searchCommands.js | Search | Update imports: relative |
| commands/agentLayoutCommands.js | examples/github-viewer/websocket/ | app/commands/agentLayoutCommands.js | Agent layout | Update imports: relative |
| commands/annotationCommands.js | examples/github-viewer/websocket/ | app/commands/annotationCommands.js | Annotations | Update imports: relative |
| commands/spatialCommands.js | examples/github-viewer/websocket/ | app/commands/spatialCommands.js | Spatial queries | Update imports: relative |
| commands/spatialHelpers.js | examples/github-viewer/websocket/ | app/commands/spatialHelpers.js | Helpers | No changes |
| commands/compositionCommands.js | examples/github-viewer/websocket/ | app/commands/compositionCommands.js | Composition ops | Update imports: relative |
| commands/navigationCommands.js | examples/github-viewer/websocket/ | app/commands/navigationCommands.js | Navigation | Update imports: relative |
| commands/windowCommands.js | examples/github-viewer/websocket/ | app/commands/windowCommands.js | Window/TUI | Update imports: relative |
| commands/orchestrationCommands.js | examples/github-viewer/websocket/ | app/commands/orchestrationCommands.js | High-level ops | Update imports: relative |
| commands/registryCommands.js | examples/github-viewer/websocket/ | app/commands/registryCommands.js | Registry introspection | Update imports: relative |
| commands/terminalCommands.js | examples/github-viewer/websocket/ | app/commands/terminalCommands.js | Terminal grid ops | Update imports: relative |
| commands/colorConstants.js | examples/github-viewer/websocket/ | app/commands/colorConstants.js | Shared constants | No changes |
| commands/encoding.js | examples/github-viewer/websocket/ | app/commands/encoding.js | Encoding utils | No changes |
| commands/gridVisualState.js | examples/github-viewer/websocket/ | app/commands/gridVisualState.js | Visual state | No changes |
| **WebSocket Infrastructure** |
| websocket/index.js | examples/github-viewer/ | app/lib/initCommandCenter.js | initCommandCenter(), buildContext() | Update imports: relative → `../../src/` |
| websocket/CommandRouter.js | examples/github-viewer/ | app/lib/CommandRouter.js | (or leave in src/orchestration/) | — (stays in src/ if already extracted) |
| websocket/WebSocketBridge.js | examples/github-viewer/ | app/lib/WebSocketBridge.js | (or leave in src/orchestration/) | — |
| websocket/ViewerAPI.js | examples/github-viewer/ | app/lib/ViewerAPI.js | (or leave in src/orchestration/) | — |
| **TUI (WebSocket Terminal)** |
| websocket/TUIFormatter.js | examples/github-viewer/ | app/lib/TUIFormatter.js | Text formatting for CLI | No changes |
| websocket/TUIWindow.js | examples/github-viewer/ | app/lib/TUIWindow.js | Live terminal window | No changes |
| websocket/TUIWindowManager.js | examples/github-viewer/ | app/lib/TUIWindowManager.js | Window management | No changes |
| websocket/TUIFocusManager.js | examples/github-viewer/ | app/lib/TUIFocusManager.js | Focus tracking | No changes |

## Composition Root: compose-app.js

The **compose-app.js** (or **main.js**) lives at `app/compose-app.js` and does:

```javascript
// 1. Import rendering core from src/
import { GlyphAtlas, CodeGrid, GridLayoutManager, ... } from '../../src/index.js';
import { ... all 21 composable services ... } from '../../src/services/index.js';

// 2. Import app-local infrastructure
import { GitHubRepoViewer } from './lib/GitHubRepoViewer.js';
import { initCommandCenter, buildContext } from './lib/initCommandCenter.js';
import { IDEShell } from './lib/IDEShell.js';
import { StatePersistence } from './lib/StatePersistence.js';

// 3. Import component factories
import { createHeader, createLoadingOverlay, createFPSBadge, createToast } from './components/AppShell.js';
import { DrawerController, ... } from './components/Drawer.js';

// 4. Services in dependency order:
//    a. Create rendering (scene, camera, renderer, atlas)
//    b. Create layout managers
//    c. Create data providers (GitHub, etc.)
//    d. Create state managers (selection, color, etc.)
//    e. Create UI orchestrators (IDEShell wraps viewer)
//    f. Wire command center (router → commands → context)
//    g. Wire WebSocket bridge (commands → CLI control)
//    h. Start render loop

// 5. Set up DOM structure
//    a. Create IDE shell layout (titlebar, sidebar, editor-area, status-bar)
//    b. Inject panel HTML into shells
//    c. Create viewer (renders into editor-area)
//    d. Wire IDEShell to viewer (status updates, panel sync)
//    e. Attach command bar

// 6. Start render loop (viewer.animate())

export async function composeApp() {
    // Implementation follows structure in IDEShell + GitHubRepoViewer init
}
```

## Wiring Diagram: Dependency Flow

```
DOM/index.html
    ↓
compose-app.js
    ├─→ Scene + Renderer + Camera (Three.js)
    ├─→ GlyphAtlas + LayoutManagers (src/)
    ├─→ Services: SelectionManager, CodeColorManager, etc. (src/services/)
    │
    ├─→ GitHubRepoViewer (app/lib/)
    │   ├─→ CameraController
    │   ├─→ FileStateManager
    │   ├─→ RepositoryAdapter → GitHubRepositorySource
    │   ├─→ DiffController
    │   ├─→ BackdropManager, NameplateManager
    │   ├─→ MinimapOverlay
    │   ├─→ HandGestureAdapter
    │   └─→ Drawer (app/components/)
    │
    ├─→ IDEShell (app/lib/)
    │   ├─→ Activity bar panel switching
    │   ├─→ Sidebar collapse/resize
    │   ├─→ Tab bar + breadcrumb
    │   ├─→ Bottom panel + status bar
    │   └─→ Command palette + search wiring
    │
    ├─→ CommandRouter + registerAllCommands (app/commands/)
    │   ├─→ 21 command modules (*.js)
    │   └─→ Context bag: scene, camera, registry, services
    │
    ├─→ WebSocketBridge (src/orchestration/)
    │   └─→ CLI control via ws://localhost:8765
    │
    └─→ StatePersistence
        └─→ localStorage auto-save/restore
```

## Key Design Decisions

### 1. Commands Stay in App (Not src/services/)
**Reason:** The 21 command modules are app-specific operations that depend on:
- Viewer instance state (registry, scene)
- UI orchestration (IDEShell, drawer state)
- CLI interface expectations

They should live in `app/commands/` as part of the app composition, not as reusable services. Each command registers itself on the router and accesses the context bag (scene, services, viewer state).

### 2. Components: UI Layer Separation
- **Reusable components** (MinimapOverlay, SelectionManager, CodeColorManager) → `src/services/`
- **App UI components** (Drawer, AppShell, LogCapturePanel, DiffPanel, TouchController) → `app/components/`

The distinction: reusable components have no app-specific knowledge; app components reference the IDE shell, viewer, or localStorage.

### 3. WebSocket Infrastructure Placement
- **CommandRouter, WebSocketBridge, ViewerAPI**: Already in `src/orchestration/` (check barrel export)
- **initCommandCenter, buildContext**: Move to `app/lib/initCommandCenter.js` (app-specific wiring)
- **TUI classes** (TUIFormatter, TUIWindow, TUIWindowManager, TUIFocusManager): Move to `app/lib/` (app feature)

### 4. IDEShell as Composition Root Wrapper
IDEShell does NOT become the composition root; rather, **compose-app.js** is the root, and IDEShell is a **UI orchestrator** that:
- Manages layout (sidebar, bottom panel, status bar)
- Wraps the viewer instance
- Updates status bar each frame
- Hides old Drawer UI elements
- Provides drawer-compatible API shim

## Import Rewrite Rules

When moving files, apply these rewrites:

### Rule 1: src/ imports
```javascript
// OLD
import { ... } from '../../../src/index.js';

// NEW (adjust ../ depth as needed)
import { ... } from '../../src/index.js';  // from app/lib/
import { ... } from '../../../src/index.js';  // from app/commands/
```

### Rule 2: Internal app imports
```javascript
// OLD (in examples/github-viewer/components/)
import { DrawerController } from '../components/Drawer.js';

// NEW (in app/components/)
// Internal component imports are fine as-is

// NEW (in app/lib/ referencing components/)
import { Drawer... } from '../components/Drawer.js';

// NEW (in app/commands/ referencing lib/)
import { TUIFormatter } from '../lib/TUIFormatter.js';
```

### Rule 3: Service imports
```javascript
// OLD (examples/github-viewer/)
import { SceneRegistry } from '../services/SceneRegistry.js';  // NOT FOUND

// NEW (app/lib/)
import { SceneRegistry } from '../../src/services/index.js';
```

## What Gets Deleted (Dead Code After Extraction)

1. **examples/github-viewer/GitHubRepoViewer.js** — moved to app
2. **examples/github-viewer/StatePersistence.js** — moved to app
3. **examples/github-viewer/components/*.js** — all moved to app
4. **examples/github-viewer/websocket/commands/*.js** — all moved to app
5. **examples/github-viewer/websocket/index.js** — moved to app
6. **examples/github-viewer/websocket/TUI*.js** — moved to app
7. **examples/ide/IDEShell.js** — moved to app
8. **examples/ide/ide.html** — moved to app (becomes app/index.html)
9. **examples/ide/ide.css** — moved to app
10. **examples/ide/** — directory becomes empty, can be deleted

**Keep in examples/github-viewer:**
- Other unrelated example code (if any)
- Documentation

## Next Steps (Phase 1)

1. Create `app/` directory structure
2. Copy files with corrected imports
3. Create `compose-app.js` entry point
4. Update `app/index.html` to import compose-app
5. Test IDE loads and renders
6. Verify WebSocket commands work
7. Fix broken imports iteratively

## Dependencies Checklist

- [ ] All 21 command modules correctly import from `../` (peer) or `../../src/`
- [ ] IDEShell imports from `./components/` (local)
- [ ] GitHubRepoViewer imports from `../../src/` (core) and `./components/` (app)
- [ ] compose-app.js wires all services in correct order
- [ ] WebSocket bridge auto-connects and exposes window.viewer
- [ ] StatePersistence restores UI state on load
- [ ] IDEShell.start() initializes log capture and search wiring
