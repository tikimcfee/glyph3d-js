# Phase 0: Dependency Graph Analysis
## IDE Shell Separation from GitHub Viewer

**Date**: 2026-03-30  
**Scope**: examples/github-viewer/  
**Goal**: Map all dependencies to enable clean separation of IDE infrastructure from standalone viewer code.

---

## 1. Entry Points & Layer Structure

| File | Purpose | Layer | Used By |
|------|---------|-------|---------|
| **ide.html** (line 180-183) | IDE shell entry | IDE | Browser |
| **index.html** (line 22) | Viewer-only entry | Viewer | Browser |
| **IDEShell.js** | IDE orchestrator | IDE | ide.html (line 182) |
| **GitHubRepoViewer.js** | Core viewer | Shared | Both: ide.html (line 180), index.html (line 22) |

**Critical Observation**: Both HTML files import `GitHubRepoViewer`, but **only ide.html imports IDEShell**.
The viewer runs standalone via index.html with zero IDE dependencies.

---

## 2. Categorization Table

### IDE-Only Files (used exclusively by IDEShell or ide.html)

| File | Imports From | Purpose |
|------|--------------|---------|
| **IDEShell.js** | ./components/Drawer, ./components/LogCapturePanel, ./components/DiffPanel, ./platform | IDE grid layout, sidebar/bottom-panel management |
| **components/CommandBar.js** | ./platform, ./websocket/commands/encoding | IDE unified command input surface, mounted in #editor-column |

### Viewer-Only Files (viewer-specific, not used by IDE)

| File | Imports From | Purpose |
|------|--------------|---------|
| **GitHubRepositorySource.js** | (no viewer-only deps) | GitHub API wrapper for repo data |
| **RepositoryAdapter.js** | (no viewer-only deps) | Maps GitHub API to internal model |
| **RepositoryContentCache.js** | (no viewer-only deps) | File content caching |
| **providers/HeatmapProvider.js** | (no viewer-only deps) | File complexity metrics |

### Shared Files (used by both IDE and Viewer via GitHubRepoViewer)

| File | Imports From | Purpose | Used By |
|------|--------------|---------|---------|
| **components/Drawer.js** | (none) | Panel HTML + DrawerController class | GitHubRepoViewer.js (lines 38-44), IDEShell.js (lines 21-26) |
| **components/AppShell.js** | (none) | Header, loading overlay, FPS badge, toast creators | GitHubRepoViewer.js (line 36) |
| **components/LogCapturePanel.js** | ../../src/utils/LogCapture.js | Log capture panel HTML + init | GitHubRepoViewer.js (line 46), IDEShell.js (line 27) |
| **components/DiffPanel.js** | (none) | Diff panel HTML + init | GitHubRepoViewer.js (line 47), IDEShell.js (line 28) |
| **components/MinimapOverlay.js** | (none) | 2D minimap overlay | GitHubRepoViewer.js (line 24) |
| **components/TouchController.js** | (none) | Touch input (mobile/tablet) | GitHubRepoViewer.js (line 45) |
| **SelectionManager.js** | (none) | File selection via raycast | GitHubRepoViewer.js (line 21) |
| **ShortcutManager.js** | ./platform | Keyboard shortcut registry | GitHubRepoViewer.js (line 22) |
| **CameraController.js** | ./platform | Camera pan/zoom/WASD | GitHubRepoViewer.js (line 31) |
| **FileStateManager.js** | (none) | Per-file state (selected, hovered) | GitHubRepoViewer.js (line 32) |
| **CodeColorManager.js** | (none) | Per-file color mapping | GitHubRepoViewer.js (line 33) |
| **BackdropManager.js** | (none) | Grid background mesh management | GitHubRepoViewer.js (line 28) |
| **NameplateManager.js** | ../../src/index.js (CodeGrid) | 3D nameplate mesh creation | GitHubRepoViewer.js (line 29) |
| **TreemapLabelManager.js** | ../../src/index.js (GlyphCollection) | Treemap mode label rendering | GitHubRepoViewer.js (line 23) |
| **DiffController.js** | ../../src/index.js, ./DiffParser | PR diff grid creation | GitHubRepoViewer.js (line 27) |
| **DiffParser.js** | (none) | Unified diff parsing | DiffController.js (line 13) |
| **SceneContext.js** | (none) | Shared THREE refs container | GitHubRepoViewer.js (line 30) |
| **HandGestureAdapter.js** | ../../src/hand/* | Hand tracking gesture → camera/selection | GitHubRepoViewer.js (line 49) |
| **StatePersistence.js** | (none) | localStorage state save/restore | GitHubRepoViewer.js (line 48) |
| **platform.js** | (none) | Platform detection, modifier keys | IDEShell.js (line 29), ShortcutManager (line 23), CameraController (line 14), CommandBar (line 16) |
| **websocket/index.js** | ./CommandRouter, ./WebSocketBridge, ./ViewerAPI, ./commands/index | Command center bootstrap | GitHubRepoViewer.js (line 50) |
| **websocket/SceneRegistry.js** | (none) | Scene object registry | GitHubRepoViewer.js (line 51) |
| **websocket/CommandRouter.js** | (none) | Command dispatch shell | websocket/index.js (line 10) |
| **websocket/WebSocketBridge.js** | (none) | WebSocket I/O handler | websocket/index.js (line 11) |
| **websocket/ViewerAPI.js** | (none) | High-level viewer command interface | websocket/index.js (line 12) |
| **websocket/commands/** | (various) | Command handler modules | websocket/commands/index.js |
| **websocket/TUIWindow.js** | ../../src/collections/CodeGrid | Terminal UI window abstraction | websocket/commands/* |
| **websocket/TUIFocusManager.js** | ../../src/core/constants | Terminal focus management | websocket/* |
| **websocket/TUIWindowManager.js** | (none) | Terminal window lifecycle | websocket/* |

---

## 3. Import Chains: src/ Boundary Crossings

### Files importing from `../../src/` (core library)

**GitHubRepoViewer.js** (line 19):
```
GlyphAtlas, CodeGrid, GridLayoutManager, HierarchicalLayoutManager,
SpiralLayoutManager, TreemapLayoutManager, StackLayoutManager
```

**NameplateManager.js** (line 12):
```
CodeGrid
```

**TreemapLabelManager.js** (line 27):
```
GlyphCollection
```

**DiffController.js** (line 12):
```
CodeGrid, GridLayoutManager
```

**HandGestureAdapter.js** (lines 37-40):
```
HandRenderer, GestureDetector, MockHandSource, Joint, landmarkDistance
```

**websocket/TUIWindow.js**:
```
CodeGrid (from ../../src/collections/CodeGrid.js)
```

**websocket/TUIFocusManager.js**:
```
CHAR_DIMENSIONS (from ../../src/core/constants.js)
```

**components/LogCapturePanel.js** (line 8):
```
logCapture (from ../../src/utils/LogCapture.js)
```

**Summary**: Core imports are localized to 8 files. No IDE-specific code imports src/.

---

## 4. Cross-Boundary Dependencies (IDE ↔ Viewer)

### Imports flowing INTO IDE-only code (should be minimal)

**IDEShell.js** imports from:
- `./components/Drawer.js` (shared) ✓
- `./components/LogCapturePanel.js` (shared) ✓
- `./components/DiffPanel.js` (shared) ✓
- `./platform.js` (shared utility) ✓

**Status**: ✓ CLEAN — IDEShell only depends on shared layer.

### Imports flowing INTO Viewer code (via GitHubRepoViewer)

**GitHubRepoViewer.js** imports:
- 24 internal modules (mix of shared + viewer-specific)
- src/ modules (core library)

**Status**: Viewer has natural boundary — only imports what it needs.

### Imports from viewer INTO IDE

**NONE DETECTED** — IDE does not depend on viewer internals.

---

## 5. Shared Component Coupling

### Drawer.js: The Dual-Use Hub

| User | Usage | Mode |
|------|-------|------|
| **GitHubRepoViewer.js** (lines 38-44) | Creates DrawerController in init() | Viewer mode |
| **IDEShell.js** (lines 21-26) | Extracts panel HTML functions only | IDE mode |

**Key Line**: ide.html (lines 211-216) replaces viewer's DrawerController with IDE shim.

```javascript
// ide.html line 208-216
viewer.init = async function() {
    await origInit();
    // Replace the drawer that init() created with the IDE shell shim
    viewer.drawer = ide.asDrawer();
};
```

This pattern means both can coexist: viewer still calls drawer methods, IDE delegates to shell.

---

## 6. WebSocket Module Ownership

All websocket/ code is **shared** (imported only by GitHubRepoViewer via initCommandCenter).

| Module | Layer | Purpose |
|--------|-------|---------|
| websocket/index.js | Shared | Bootstrap entry, registers commands |
| websocket/CommandRouter.js | Shared | Command dispatch (works in console, shortcuts, WebSocket) |
| websocket/WebSocketBridge.js | Shared | WS I/O (optional — works offline) |
| websocket/ViewerAPI.js | Shared | High-level command API |
| websocket/SceneRegistry.js | Shared | Scene object registry |
| websocket/commands/* | Shared | Command implementations (21 files) |
| websocket/TUI* | Shared | Terminal UI abstractions |

**Status**: ✓ No IDE-specific commands; all are viewer operations.

---

## 7. Platform Module

**platform.js** exports platform detection used by multiple subsystems:

| Consumer | Uses |
|----------|------|
| IDEShell.js (line 29) | primaryMod |
| ShortcutManager.js (line 23) | isMac |
| CameraController.js (line 14) | primaryMod, secondaryMod |
| CommandBar.js (line 16) | primaryMod |

**Status**: ✓ SHARED UTILITY — safe to keep in examples/github-viewer/.

---

## 8. Separation Strategy: IDE-Only vs. Shared

### Files eligible for IDE-only extraction:

1. **IDEShell.js** — IDE orchestrator, 0 viewer dependencies
2. **components/CommandBar.js** — IDE command input, ~shared via CommandRouter

### Files must remain in shared location (or duplicate if separated):

1. **components/Drawer.js** — Used by both viewer (DrawerController) and IDE (HTML extractors)
2. **components/LogCapturePanel.js** — Used by both (HTML + init functions)
3. **components/DiffPanel.js** — Used by both (HTML + init functions)
4. **components/AppShell.js** — Used by viewer for basic UI (header, loading, FPS, toast)
5. **platform.js** — Used by viewer camera/shortcuts + IDE shell
6. All other 40+ files — Viewer core or viewer-required shared utilities

### Files with no IDE coupling:

- **websocket/** (21+ files) — Pure viewer command system
- **Hand gesture** integration — Viewer input
- **GitHub** integration — Viewer data source
- **Layout managers** — Viewer rendering

---

## 9. Import Chain Summary Table

| Direction | Count | Status | Risk |
|-----------|-------|--------|------|
| IDE → shared | 4 imports | ✓ Expected | Low |
| IDE → viewer | 0 imports | ✓ Clean | None |
| Viewer → IDE | 0 imports | ✓ Clean | None |
| Viewer → shared | 24+ imports | ✓ Expected | Low |
| Shared → src/ | 8 files | ✓ Scoped | Low |
| IDE-only → src/ | 0 imports | ✓ None | None |

---

## 10. Recommendations

### Phase 1: Document and Test
- [ ] Verify ide.html and index.html run independently
- [ ] Confirm IDE shell does not break viewer functionality
- [ ] Document Drawer abstraction layer (DrawerController interface)

### Phase 2: Extract IDE if Desired
If IDE shell moves to separate package:
1. Keep Drawer.js, LogCapturePanel.js, DiffPanel.js in shared
2. Move IDEShell.js + ide.html to IDE package
3. Copy CommandBar.js to IDE package (only 1 consumer: ide.html)
4. Share platform.js (lightweight, multi-consumer)

### Phase 3: Clarify DrawerController Shim
Document the interface that ide.html/IDEShell expects from viewer.drawer:
- `.openToTab(tabName)` → route to sidebar panel
- `.openPanel()` / `.closePanel()` → show/hide panels
- `.registerPanel()` — register new tabs

---

## References

- **ide.html**: Entry point, lines 180-183 (imports), lines 185-327 (init logic with drawer shim)
- **index.html**: Entry point, lines 22-27 (simple viewer init)
- **IDEShell.js**: IDE shell, lines 20-29 (imports)
- **GitHubRepoViewer.js**: Viewer core, lines 11-51 (imports)

