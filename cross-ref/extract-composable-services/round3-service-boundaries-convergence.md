# Round 3 Convergence: service-boundaries

Final convergence analysis for the composable services extraction in glyph3d-js.

Based on: all three Round 2 outputs, verified against actual source tree.

---

## Settled

These points have full consensus across all three agents after two rounds of cross-review. No further debate needed.

### 1. Extraction order follows dependency depth, not architectural layers

Zero-dep services first, then single-dep, then multi-dep, then orchestration. The extraction-plan's original commands-first ordering was retracted in Round 2. All three agents independently arrived at the same bottom-up order.

### 2. SceneContext is kept as a thin reference bag

SceneContext (43 lines, zero behavior) survives. The composition-pattern agent retracted their "eliminate SceneContext" position in Round 2. All agents agree: keep it, document which fields each consuming service reads via JSDoc `@param`, and move the two mutable late-bound fields (`hierarchicalManager`, `layoutManager`) out to the composition root. SceneContext becomes immutable after construction.

SceneContext does NOT live under `camera/`. It goes to `src/services/SceneContext.js` (top-level in services, not a subdirectory).

### 3. SceneRegistry extracts from websocket/

Zero WebSocket coupling, zero DOM coupling. It is the central scene-object truth store. All three agents flagged this independently. It moves to `src/services/SceneRegistry.js`.

### 4. CameraController naming resolution

The github-viewer's CameraController (597 lines, translation-first, SceneContext-based) is renamed to **`NavigationController`** when extracted. The existing `src/camera/CameraController.js` (physics-based, rotation-first, takes `(camera, inputManager, config)`) is untouched. The name "NavigationController" reflects what the class actually does: pan, zoom, focus, WASD navigation. It is not just a camera wrapper.

### 5. CameraController DOM bindings get a `bindUI()` split

The NavigationController's core logic (~450 lines of WASD, drag, scroll, focus, physics) is clean and reusable. The DOM coupling (~100 lines: 6+ `document.getElementById()` calls, `localStorage`, `window.dispatchEvent`) moves to an optional `bindUI(elements)` method and an injectable storage adapter. The composition root calls `bindUI()` after construction.

### 6. Services use callback registries, not CustomEvent

The composition-pattern agent retracted CustomEvent as the inter-service pattern. Settled pattern: services own `on(callback)`/`off(callback)` registries. The composition root bridges callbacks to DOM events when needed. SelectionManager (lines 205-213: `_listeners` Set with `on()`/`off()`) is the reference implementation. CameraController's `window.dispatchEvent(new CustomEvent('camera-focus-changed'))` becomes an `onFocusChanged(cb)` method.

### 7. THREE.js: bare import from 'three' for extracted services

The composition-pattern agent argued this correctly: Three.js is a peer dependency declared in `package.json`. Every consumer already has it via bundler or importmap. BackdropManager, NameplateManager, and spatialHelpers already use `import * as THREE from 'three'`. Services that currently receive THREE via `ctx.THREE` (CameraController, CodeColorManager) can keep accessing it through SceneContext for now. No constructor-DI threading of THREE is required. Reserve constructor DI for dependencies that actually vary.

**Exception**: `BackdropManager.js` line 23-29 has `DEPTH_COLORS` using `new THREE.Color()` at module scope. This is fine with bare import -- it executes at import time when THREE is available. No change needed.

### 8. `window.viewer = api` belongs in examples, not library code

`initCommandCenter()` at `websocket/index.js:156` sets `window.viewer = api`. When extracted, `initCommandCenter` returns `{ router, bridge, api }`. The caller assigns the global. All three agents agree.

### 9. `dispose()` is the canonical cleanup method name

BackdropManager has both `dispose()` and `destroy()`. The extracted services standardize on `dispose()`. This aligns with Three.js convention (`geometry.dispose()`, `material.dispose()`).

### 10. TUI stays in examples

TUIWindow (420 lines), TUIWindowManager (91 lines), TUIFocusManager (525 lines), TUIFormatter (95 lines) -- total 1,131 lines. These are WebSocket-terminal-specific UI constructs. No agent proposed extracting them. They stay at `examples/github-viewer/websocket/`.

### 11. CLI tooling stays in examples

The `cli/` directory (6 files, 1,324 lines: agent-hook.mjs, AgentWindowManager.mjs, AgentWindow.mjs, CliConnection.mjs, CodeTour.mjs, glyph-cli.mjs) is Node.js-specific CLI tooling. Not candidates for browser-library extraction.

### 12. UI components stay in examples

`components/` (6 files, 1,222 lines: AppShell.js, DiffPanel.js, Drawer.js, LogCapturePanel.js, MinimapOverlay.js, TouchController.js) are DOM-heavy, app-specific UI. They remain in `examples/github-viewer/components/`.

### 13. StatePersistence is deferred

StatePersistence (243 lines) has `document.getElementById('layout-mode')`, `document.getElementById('repo-url')`, and `window.location.reload()`. The DOM coupling is too deep for a clean extraction now. It stays in `examples/github-viewer/` until the viewer refactor exposes typed state accessors.

### 14. Command modules stay in examples (for now)

The 21 command files (4,123 lines) depend on an implicit context bag shape with ~20 properties (websocket/index.js lines 29-118). Extracting them makes that bag shape a public API contract of the library. No agent proposed a viable `CommandContext` interface. Service-boundaries and composition-pattern agree: command modules stay in `examples/github-viewer/websocket/commands/` until the context interface is deliberately designed. The extraction-plan agent accepted this ordering (commands last, after context stabilizes).

---

## Implementation Plan

### Verified file inventory

**Total files in `examples/github-viewer/`**: 62 JS/MJS files

**Extraction candidates (move to `src/services/`)**: 22 files
**Stay in examples**: 40 files (GitHubRepoViewer.js, components/6, cli/6, websocket/commands/21, websocket/TUI*/4, websocket/index.js, ws-relay.mjs, StatePersistence.js)

### Target directory structure

```
src/services/
  index.js                        # barrel export for all services
  SceneContext.js                  # immutable reference bag
  SceneRegistry.js                # scene-object truth store
  platform.js                     # platform detection utilities
  state/
    FileStateManager.js           # file open/close/active state
  data/
    DiffParser.js                 # pure diff parsing functions
    RepositoryContentCache.js     # LRU content cache
    github/
      GitHubRepositorySource.js   # GitHub API client
      RepositoryAdapter.js        # high-level repo operations
      index.js                    # barrel for github data
  visual/
    BackdropManager.js            # depth backdrop planes
    NameplateManager.js           # file name labels
    TreemapLabelManager.js        # treemap area labels
    CodeColorManager.js           # syntax color themes
    HeatmapProvider.js            # file-activity heatmap
    index.js                      # barrel for visual services
  interaction/
    SelectionManager.js           # click-to-select + file-selected events
    NavigationController.js       # renamed CameraController (viewer's)
    HandGestureAdapter.js         # hand tracking integration
    ShortcutManager.js            # keyboard shortcut system
    index.js                      # barrel for interaction services
  orchestration/
    CommandRouter.js              # command dispatch
    ViewerAPI.js                  # programmatic API facade
    WebSocketBridge.js            # WS transport (DOM opt-in)
    index.js                      # barrel for orchestration
```

### Phase 0: Preparation (no file moves)

**Goal**: Establish conventions before any extraction.

1. **Rename decision**: The viewer's CameraController becomes NavigationController. Grep confirms only `GitHubRepoViewer.js:31` imports it. One rename, one import rewrite.

2. **SceneContext immutability**: Remove the two mutable fields (`this.hierarchicalManager = null`, `this.layoutManager = null` at lines 33-34). These become properties on `GitHubRepoViewer` directly, passed to services that need them via method arguments or separate construction.

3. **Event pattern**: In `SelectionManager.js`, the `_dispatchEvent()` method (line 308-316) stays but is documented as "composition root calls this, or subscribes via `on()` and dispatches externally." No code change yet.

4. **Create `src/services/` directory** and `src/services/index.js` (empty barrel, populated incrementally).

### Phase 1: Zero-dependency services (5 files)

These files have zero imports from sibling modules (only standard globals or peer deps).

| Source file | Destination | Lines | Imports to rewrite |
|---|---|---|---|
| `examples/github-viewer/platform.js` | `src/services/platform.js` | 34 | None (uses `globalThis.navigator`) |
| `examples/github-viewer/DiffParser.js` | `src/services/data/DiffParser.js` | 291 | None (zero imports) |
| `examples/github-viewer/FileStateManager.js` | `src/services/state/FileStateManager.js` | 130 | None (zero imports) |
| `examples/github-viewer/RepositoryContentCache.js` | `src/services/data/RepositoryContentCache.js` | 290 | None (zero imports) |
| `examples/github-viewer/websocket/SceneRegistry.js` | `src/services/SceneRegistry.js` | 248 | None (zero imports) |

**Import rewrites needed in consumers**:
- `GitHubRepoViewer.js`: Update import of SceneRegistry from `./websocket/SceneRegistry.js` to `../../src/services/SceneRegistry.js`
- `GitHubRepoViewer.js`: Update import of FileStateManager from `./FileStateManager.js` to `../../src/services/state/FileStateManager.js`
- `CameraController.js`: Update import of platform from `./platform.js` to `../../src/services/platform.js`
- `ShortcutManager.js`: Update import of platform from `./platform.js` to `../../src/services/platform.js`
- `IDEShell.js` (examples/ide): Update import of platform from `../github-viewer/platform.js` to `../../src/services/platform.js`
- `RepositoryAdapter.js`: Update import of RepositoryContentCache from `./RepositoryContentCache.js` to `../../src/services/data/RepositoryContentCache.js`
- `DiffController.js`: Update import of DiffParser from `./DiffParser.js` to `../../src/services/data/DiffParser.js`

**Barrel update**: Add all 5 to `src/services/index.js`.

### Phase 2: SceneContext + visual services (6 files)

SceneContext must move before the services that depend on it.

| Source file | Destination | Lines | Imports to rewrite |
|---|---|---|---|
| `examples/github-viewer/SceneContext.js` | `src/services/SceneContext.js` | 43 | None (zero imports) |
| `examples/github-viewer/BackdropManager.js` | `src/services/visual/BackdropManager.js` | 210 | `import * as THREE from 'three'` -- no change needed (bare specifier works) |
| `examples/github-viewer/NameplateManager.js` | `src/services/visual/NameplateManager.js` | 196 | `import { CodeGrid } from '../../src/index.js'` becomes `import { CodeGrid } from '../../index.js'` (relative to new location) or `from 'glyph3d-js'` |
| `examples/github-viewer/TreemapLabelManager.js` | `src/services/visual/TreemapLabelManager.js` | 261 | `import { GlyphCollection } from '../../src/index.js'` becomes `import { GlyphCollection } from '../../index.js'` |
| `examples/github-viewer/CodeColorManager.js` | `src/services/visual/CodeColorManager.js` | 190 | None (zero imports, receives deps via SceneContext) |
| `examples/github-viewer/providers/HeatmapProvider.js` | `src/services/visual/HeatmapProvider.js` | 149 | None (zero imports, receives deps via constructor) |

**Refactoring needed**:
- SceneContext: Remove `this.hierarchicalManager = null` and `this.layoutManager = null` (lines 33-34). In `GitHubRepoViewer.js`, store these as `this.hierarchicalManager` and `this.layoutManager` directly, and pass to services that need them as method arguments.
- BackdropManager: Verify `dispose()` is the only cleanup method. If `destroy()` also exists, remove it and alias or redirect.
- NameplateManager, TreemapLabelManager: Rewrite `../../src/index.js` imports to use relative paths from new location within `src/`.

**Import rewrites in consumers**:
- `GitHubRepoViewer.js`: Update 6 imports (SceneContext, BackdropManager, NameplateManager, TreemapLabelManager, CodeColorManager, HeatmapProvider) to point into `../../src/services/`.

### Phase 3: Interaction services (4 files)

| Source file | Destination | Lines | Imports to rewrite |
|---|---|---|---|
| `examples/github-viewer/SelectionManager.js` | `src/services/interaction/SelectionManager.js` | 319 | None (zero imports) |
| `examples/github-viewer/ShortcutManager.js` | `src/services/interaction/ShortcutManager.js` | 153 | `import { isMac } from './platform.js'` becomes `import { isMac } from '../platform.js'` |
| `examples/github-viewer/CameraController.js` | `src/services/interaction/NavigationController.js` | 597 | `import { primaryMod, secondaryMod } from './platform.js'` becomes `import { primaryMod, secondaryMod } from '../platform.js'` |
| `examples/github-viewer/HandGestureAdapter.js` | `src/services/interaction/HandGestureAdapter.js` | 382 | `import HandRenderer from '../../src/hand/HandRenderer.js'` becomes `import HandRenderer from '../../hand/HandRenderer.js'`; same for GestureDetector, MockHandSource, HandData |

**Refactoring needed**:
- **NavigationController rename**: File renamed from CameraController.js to NavigationController.js. Class renamed from `CameraController` to `NavigationController`. All `export { CameraController }` become `export { NavigationController }`.
- **NavigationController DOM split**: Extract the following into a `bindUI(elements)` method:
  - `document.getElementById('reset-camera')` (line ~198)
  - `document.getElementById('fit-all')` (line ~206)
  - `_bindSlider()` calls with `document.getElementById(sliderId)` (line ~259, 3 occurrences)
  - `document.getElementById(labelId)`
  - `localStorage.getItem/setItem` -- accept an optional `storage` adapter in constructor (defaults to `null` = no persistence)
  - `window.dispatchEvent(new CustomEvent('camera-focus-changed'))` (line ~435) -- convert to `this._onFocusChanged` callback, exposed via `onFocusChanged(cb)` method
  - `canvas.dispatchEvent(new CustomEvent('canvas-click'))` (line ~118) -- convert to `this._onCanvasClick` callback
- **HandGestureAdapter**: Replace `canvas.dispatchEvent(new CustomEvent('canvas-click'))` (line ~358) with an injectable callback `onCanvasClick`.
- **SelectionManager**: The `_dispatchEvent()` (line 308) remains functional but is explicitly documented as optional -- consumers subscribe via `on()` instead. No breaking change.

**Import rewrites in consumers**:
- `GitHubRepoViewer.js`: Update imports of CameraController (now NavigationController), SelectionManager, ShortcutManager, HandGestureAdapter. The CameraController import `import { CameraController } from './CameraController.js'` becomes `import { NavigationController } from '../../src/services/interaction/NavigationController.js'`. All references to `CameraController` in GitHubRepoViewer.js become `NavigationController`.
- `websocket/index.js` line 90: `cameraController: viewer.cameraController` -- the property name on the viewer object can stay as `cameraController` (it is the viewer's field name, not the class name). But if renamed for clarity, update `buildContext()` accordingly.

### Phase 4: Data services (2 files)

| Source file | Destination | Lines | Imports to rewrite |
|---|---|---|---|
| `examples/github-viewer/GitHubRepositorySource.js` | `src/services/data/github/GitHubRepositorySource.js` | 669 | None (zero imports) |
| `examples/github-viewer/RepositoryAdapter.js` | `src/services/data/github/RepositoryAdapter.js` | 481 | `import GitHubRepositorySource` from `./GitHubRepositorySource.js` becomes `./GitHubRepositorySource.js` (same dir); `import RepositoryContentCache` from `./RepositoryContentCache.js` becomes `../RepositoryContentCache.js` |

**Import rewrites in consumers**:
- `GitHubRepoViewer.js`: Update imports of GitHubRepositorySource and RepositoryAdapter to point to `../../src/services/data/github/`.

**Sub-export**: These go behind `glyph3d-js/services/data` so they are optional and tree-shakeable.

### Phase 5: Multi-dep services (1 file)

| Source file | Destination | Lines | Imports to rewrite |
|---|---|---|---|
| `examples/github-viewer/DiffController.js` | `src/services/visual/DiffController.js` | 334 | `import { CodeGrid, GridLayoutManager } from '../../src/index.js'` becomes `from '../../index.js'`; `import { buildAlignedDiff, ... } from './DiffParser.js'` becomes `from '../data/DiffParser.js'` |

**Note**: DiffController depends on CodeGrid (from core lib), DiffParser (extracted in Phase 1), and receives scene/atlas via constructor. It is a visual service that creates diff views.

### Phase 6: Orchestration services (3 files)

| Source file | Destination | Lines | Imports to rewrite |
|---|---|---|---|
| `examples/github-viewer/websocket/CommandRouter.js` | `src/services/orchestration/CommandRouter.js` | 225 | None (zero imports) |
| `examples/github-viewer/websocket/ViewerAPI.js` | `src/services/orchestration/ViewerAPI.js` | 241 | None (zero imports) |
| `examples/github-viewer/websocket/WebSocketBridge.js` | `src/services/orchestration/WebSocketBridge.js` | 391 | None (zero imports) |

**Refactoring needed**:
- **WebSocketBridge**: The `_createStatusBar()` method creates DOM elements. Make `showStatus` default to `false` (currently defaults to `true` via `options.showStatus !== false` in websocket/index.js). Add an optional `onStatusChange(status, message)` callback constructor parameter. The DOM status bar creation moves to the example's composition root.
- **CommandRouter and ViewerAPI**: These are already clean. CommandRouter is a pure dispatch map. ViewerAPI is a facade over the router.

**Import rewrites in consumers**:
- `websocket/index.js` (stays in examples): Update imports from `./CommandRouter.js` to `../../../src/services/orchestration/CommandRouter.js`, etc.

### Phase 7: Composition root + wiring

**`websocket/index.js`** stays in examples but gets rewritten:
- `buildContext(viewer)` remains in examples -- it is the implicit composition root and depends on the viewer's internal shape. It is not library code.
- `initCommandCenter(viewer, options)` remains in examples. It returns `{ router, bridge, api }`. The `window.viewer = api` line (156) is removed from the function; the caller assigns it.
- Imports are rewritten to pull CommandRouter, WebSocketBridge, ViewerAPI from `src/services/orchestration/`.

### Phase 8: Package.json exports + barrel files

**`package.json` exports additions**:

```json
{
  "exports": {
    ".": "./src/index.js",
    "./collections": "./src/collections/index.js",
    "./workers": "./src/workers/WorkerBridge.js",
    "./utils": "./src/utils/index.js",
    "./hand": "./src/hand/index.js",
    "./services": "./src/services/index.js",
    "./services/visual": "./src/services/visual/index.js",
    "./services/interaction": "./src/services/interaction/index.js",
    "./services/orchestration": "./src/services/orchestration/index.js",
    "./services/data": "./src/services/data/github/index.js"
  }
}
```

**`src/services/index.js`** barrel:

```javascript
// Context
export { SceneContext } from './SceneContext.js';
export { default as SceneRegistry } from './SceneRegistry.js';
export * from './platform.js';

// State
export { FileStateManager } from './state/FileStateManager.js';

// Data
export { default as DiffParser, buildAlignedDiff, parsePatchAligned, getDiffColor } from './data/DiffParser.js';
export { default as RepositoryContentCache } from './data/RepositoryContentCache.js';

// Visual
export { BackdropManager } from './visual/BackdropManager.js';
export { NameplateManager } from './visual/NameplateManager.js';
export { TreemapLabelManager } from './visual/TreemapLabelManager.js';
export { CodeColorManager } from './visual/CodeColorManager.js';
export { HeatmapProvider } from './visual/HeatmapProvider.js';
export { DiffController } from './visual/DiffController.js';

// Interaction
export { SelectionManager } from './interaction/SelectionManager.js';
export { NavigationController } from './interaction/NavigationController.js';
export { HandGestureAdapter } from './interaction/HandGestureAdapter.js';
export { ShortcutManager } from './interaction/ShortcutManager.js';

// Orchestration
export { default as CommandRouter } from './orchestration/CommandRouter.js';
export { default as ViewerAPI } from './orchestration/ViewerAPI.js';
export { default as WebSocketBridge } from './orchestration/WebSocketBridge.js';
```

### Phase 9: Example rewrites

**`examples/github-viewer/GitHubRepoViewer.js`**:

Currently imports 14 services from sibling files. After extraction, all 14 become imports from `../../src/services/`. The file keeps its orchestration role -- it is the application composition root. The git diff will show ~14 changed import lines, no logic changes.

Before:
```javascript
import { SelectionManager } from './SelectionManager.js';
import { CameraController } from './CameraController.js';
// ... etc
```

After:
```javascript
import { SelectionManager, NavigationController, /* ... */ } from '../../src/services/index.js';
// or individual imports for clarity:
import { SelectionManager } from '../../src/services/interaction/SelectionManager.js';
import { NavigationController } from '../../src/services/interaction/NavigationController.js';
// ... etc
```

Internal references to `CameraController` become `NavigationController` (class name, constructor calls, property names on the viewer instance if desired).

**`examples/ide/IDEShell.js`**:

Currently imports `primaryMod` from `../github-viewer/platform.js` (line 29). After extraction:
```javascript
import { primaryMod } from '../../src/services/platform.js';
```

No other IDE shell changes needed -- it does not directly import the extracted services. It wraps around GitHubRepoViewer which handles its own wiring.

**`examples/github-viewer/websocket/index.js`**:

Import rewrites for CommandRouter, WebSocketBridge, ViewerAPI. Remove `window.viewer = api` from `initCommandCenter()`, return it for the caller to assign.

**`examples/github-viewer/websocket/commands/spatialHelpers.js`**:

Already uses `import * as THREE from 'three'` (line 12). No change needed. This file stays in examples.

### Summary: file disposition (62 github-viewer JS/MJS files)

| Disposition | Count | Files |
|---|---|---|
| **Extract to `src/services/`** | 22 | platform.js, SceneContext.js, SceneRegistry.js, FileStateManager.js, DiffParser.js, RepositoryContentCache.js, GitHubRepositorySource.js, RepositoryAdapter.js, BackdropManager.js, NameplateManager.js, TreemapLabelManager.js, CodeColorManager.js, HeatmapProvider.js, SelectionManager.js, CameraController.js (as NavigationController), HandGestureAdapter.js, ShortcutManager.js, DiffController.js, CommandRouter.js, ViewerAPI.js, WebSocketBridge.js, + barrel index files |
| **Stay in examples (app shell)** | 2 | GitHubRepoViewer.js, ws-relay.mjs |
| **Stay in examples (UI components)** | 6 | components/AppShell.js, DiffPanel.js, Drawer.js, LogCapturePanel.js, MinimapOverlay.js, TouchController.js |
| **Stay in examples (CLI)** | 6 | cli/agent-hook.mjs, AgentWindowManager.mjs, AgentWindow.mjs, CliConnection.mjs, CodeTour.mjs, glyph-cli.mjs |
| **Stay in examples (commands)** | 21 | websocket/commands/* (all 21 files) |
| **Stay in examples (TUI)** | 4 | websocket/TUIFocusManager.js, TUIFormatter.js, TUIWindow.js, TUIWindowManager.js |
| **Stay in examples (websocket wiring)** | 1 | websocket/index.js (composition root, rewritten) |
| **Stay in examples (deferred)** | 1 | StatePersistence.js |

**Total**: 22 extracted + 41 staying = 63 dispositions (62 source files + barrel index files created in services)

---

## Implementer Vote

**IMPLEMENT.**

The plan is ready. Three rounds of cross-review have resolved every blocking question:

- **Extraction order**: settled (zero-dep -> visual -> interaction -> data -> multi-dep -> orchestration)
- **CameraController name**: settled (NavigationController)
- **SceneContext fate**: settled (kept, made immutable, placed at `src/services/SceneContext.js`)
- **THREE.js injection**: settled (bare import, no constructor DI)
- **Event pattern**: settled (callback registries in services, DOM bridging in composition root)
- **Command modules**: settled (stay in examples until context interface stabilizes)
- **StatePersistence**: settled (deferred)
- **TUI**: settled (stays in examples)
- **`window.viewer`**: settled (caller's responsibility)

The 22-file extraction across 8 phases can be executed incrementally. Each phase produces a working codebase (examples still function after each phase). No phase depends on a future phase. The only refactoring that goes beyond file moves is Phase 3's NavigationController DOM split (estimated ~100 lines of method extraction) and Phase 6's WebSocketBridge `showStatus` default flip.

Estimated effort: 2-3 focused sessions. Phase 1 (zero-dep) and Phase 2 (visual) could be completed in a single session. Phase 3 (interaction, with the NavigationController refactor) is the densest single phase.
