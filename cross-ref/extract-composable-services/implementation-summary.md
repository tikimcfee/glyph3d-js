# Implementation Summary: Composable Services Extraction

**Date:** 2026-03-30
**Branch:** experiment/ide-shell
**Status:** All file moves and internal import rewrites complete. Changes staged, not committed.

---

## What was done

21 files moved from `examples/github-viewer/` into `src/services/` via `git mv`, preserving git history. 8 barrel `index.js` files created for sub-path exports. `package.json` updated with `./services` and sub-path export entries.

### Directory structure created

```
src/services/
  index.js                          # Main barrel export (all services)
  SceneContext.js                    # Immutable reference bag
  SceneRegistry.js                  # Scene-object truth store (from websocket/)
  utils/
    index.js                        # Barrel
    platform.js                     # Platform detection & modifier keys
  state/
    index.js                        # Barrel
    DiffParser.js                   # Pure diff parsing functions
    FileStateManager.js             # Per-file metadata registry
  visual/
    index.js                        # Barrel
    BackdropManager.js              # Depth backdrop planes
    NameplateManager.js             # Directory name labels
    TreemapLabelManager.js          # Treemap area labels
  interaction/
    index.js                        # Barrel
    SelectionManager.js             # Click-to-select + raycasting
    CodeColorManager.js             # Data-to-color mapping
    ShortcutManager.js              # Keyboard shortcut registry
  camera/
    index.js                        # Barrel
    ViewerCameraController.js       # Renamed from CameraController
  data/
    index.js                        # Barrel
    GitHubRepositorySource.js       # GitHub API client
    RepositoryAdapter.js            # High-level repo operations
    RepositoryContentCache.js       # LRU content cache
    HeatmapProvider.js              # File-activity heatmap (from providers/)
  orchestration/
    index.js                        # Barrel
    DiffController.js               # PR diff pipeline
    HandGestureAdapter.js           # Hand tracking bridge
    CommandRouter.js                # Command dispatch (from websocket/)
    ViewerAPI.js                    # Programmatic API facade (from websocket/)
    WebSocketBridge.js              # WS transport (from websocket/)
```

### Phases executed

| Phase | Description | Files moved |
|-------|-------------|-------------|
| 1 | Zero-dep utilities | platform.js |
| 2 | Zero-dep state | DiffParser.js, FileStateManager.js |
| 3 | Zero-dep infrastructure | SceneContext.js, SceneRegistry.js |
| 4 | Visual services | BackdropManager.js, NameplateManager.js, TreemapLabelManager.js |
| 5 | Interaction services | SelectionManager.js, CodeColorManager.js, ShortcutManager.js |
| 6 | Camera (with rename) | CameraController.js -> ViewerCameraController.js |
| 7 | Data services | GitHubRepositorySource.js, RepositoryAdapter.js, RepositoryContentCache.js, HeatmapProvider.js |
| 8 | Orchestration | DiffController.js, HandGestureAdapter.js, CommandRouter.js, ViewerAPI.js, WebSocketBridge.js |

### Import rewrites within moved files

| File | Old import | New import |
|------|-----------|------------|
| ViewerCameraController.js | `'./platform.js'` | `'../utils/platform.js'` |
| ShortcutManager.js | `'./platform.js'` | `'../utils/platform.js'` |
| NameplateManager.js | `'../../src/index.js'` | `'../../index.js'` |
| TreemapLabelManager.js | `'../../src/index.js'` | `'../../index.js'` |
| DiffController.js | `'../../src/index.js'` | `'../../index.js'` |
| DiffController.js | `'./DiffParser.js'` | `'../state/DiffParser.js'` |
| HandGestureAdapter.js | `'../../src/hand/HandRenderer.js'` | `'../../hand/HandRenderer.js'` |
| HandGestureAdapter.js | `'../../src/hand/GestureDetector.js'` | `'../../hand/GestureDetector.js'` |
| HandGestureAdapter.js | `'../../src/hand/MockHandSource.js'` | `'../../hand/MockHandSource.js'` |
| HandGestureAdapter.js | `'../../src/hand/HandData.js'` | `'../../hand/HandData.js'` |
| HandGestureAdapter.js | `'../../src/hand/WebSocketHandSource.js'` (dynamic) | `'../../hand/WebSocketHandSource.js'` |

### Class rename

- `CameraController` class renamed to `ViewerCameraController` in `src/services/camera/ViewerCameraController.js`
- Both `export class` and `export default` statements updated
- JSDoc header updated

### package.json exports added

```json
"./services": "./src/services/index.js",
"./services/utils": "./src/services/utils/index.js",
"./services/state": "./src/services/state/index.js",
"./services/visual": "./src/services/visual/index.js",
"./services/interaction": "./src/services/interaction/index.js",
"./services/camera": "./src/services/camera/index.js",
"./services/data": "./src/services/data/index.js",
"./services/orchestration": "./src/services/orchestration/index.js"
```

### Cleanup

- `examples/github-viewer/providers/` directory removed (empty after HeatmapProvider move)

---

## What was NOT done (by design)

1. **Example import rewrites** -- `examples/github-viewer/GitHubRepoViewer.js`, `examples/github-viewer/websocket/index.js`, `examples/ide/IDEShell.js`, and `examples/ide/components/CommandBar.js` still reference the old file locations. These need updating in a follow-up pass.

2. **CameraController DOM split** (`bindUI()` method extraction) -- deferred to a follow-up. The file was moved and renamed but the internal DOM coupling (6+ `document.getElementById()` calls) was not refactored.

3. **SceneContext immutability** -- the two mutable fields (`hierarchicalManager`, `layoutManager`) were not removed. Deferred to the composition root follow-up.

4. **Event pattern refactoring** -- `window.dispatchEvent(new CustomEvent(...))` calls in ViewerCameraController and SelectionManager's `_dispatchEvent()` were not converted to callback registries. Deferred to the composition root follow-up.

5. **WebSocketBridge DOM refactoring** -- `_createStatusBar()` DOM creation not extracted. Deferred.

6. **Command modules** -- all 21 files in `websocket/commands/` remain in examples.

7. **TUI, StatePersistence, CLI, UI components** -- all remain in examples as planned.

---

## Deviations from the three convergence plans

The user's 8-phase instructions were followed as the primary authority. Key differences from the plans:

1. **Directory naming**: The user specified `utils/`, `state/`, `interaction/`, `orchestration/` subdirectories which differ slightly from the plans' `context/`, `command/`, and flat placement of some files. The user's structure was followed exactly.

2. **CameraController naming**: The user explicitly specified `ViewerCameraController` (not `NavigationController`), matching the extraction-plan convergence document's settled decision.

3. **HandGestureAdapter placement**: The user placed it in `orchestration/` rather than `camera/` as some plans suggested.

4. **DiffController placement**: The user placed it in `orchestration/` rather than `visual/` or flat in `services/`.

5. **HeatmapProvider placement**: The user placed it in `data/` rather than `visual/`.

6. **SceneContext placement**: The user placed it flat at `src/services/SceneContext.js` rather than in a `context/` subdirectory.

---

## Follow-up tasks

1. Update imports in `examples/github-viewer/GitHubRepoViewer.js` (14+ imports)
2. Update imports in `examples/github-viewer/websocket/index.js` (3 imports)
3. Update imports in `examples/ide/IDEShell.js` and `examples/ide/components/CommandBar.js`
4. CameraController -> ViewerCameraController reference updates in GitHubRepoViewer.js
5. `bindUI()` split in ViewerCameraController
6. SceneContext immutability refactor
7. Event pattern refactoring (callback registries replacing CustomEvent dispatch)
8. Composition root creation (`compose-viewer.js`)
